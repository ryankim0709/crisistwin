/**
 * How dispatched engines fight a fire: the tactic, and for line tactics the control line they
 * build. Pure: no React, network or LLM. See docs/adr/0025-dispatch-fire-tactics.md.
 *
 * Tactics (after the NWCG fireline handbook; the Hauling chart limits are for the HEAD of a
 * wildland fire, not a reason to leave it):
 * - direct: engines work the whole edge and put the fire out when the line rings it
 *   (fireAttack.ts). Only where they can hold the head: within the flame limit and not
 *   crowning, or a structure fire.
 * - flank: anchor at the heel (upwind end) and build line up both flanks toward the head
 *   ("anchor and flank"). The flanks burn far less intensely than the head, so line holds there
 *   even when the head runs; the line closes on the head last.
 * - indirect: build line ahead of the fire, around where it will be later, starting across the
 *   head.
 * Line tactics use the Studio's control-line planner (studio/firefighting.ts) on the fire's own
 * unchecked footprint and the solver's time-dependent lines (ControlLines in fire/spread.ts),
 * so whether each stretch holds or burns over is the fire model's answer, not a rule here.
 */

import type { ScheduledFireRun } from "../fire/scheduledTypes";
import type { ControlLines } from "../fire/spread";
import type { LandscapeGrid } from "../fire/landscape";
import { GROUND_APPARATUS } from "../studio/apparatus";
import { planLine, type LinePlan } from "../studio/firefighting";
import { DISPATCH_ENGINE_KIND } from "./fireAttack";
import type { FireTarget } from "./fireAttack";

export type FireTactic = "direct" | "flank" | "indirect";
export type LineTactic = Exclude<FireTactic, "direct">;
export const FIRE_TACTICS: readonly FireTactic[] = ["direct", "flank", "indirect"];

/**
 * ASSUMED: the planned line follows the unchecked fire's outline this many minutes after the
 * first engine arrives. Flank lines hug the edge; indirect lines are well ahead of it.
 */
export const LINE_LEAD_MINUTES: Record<LineTactic, number> = { flank: 20, indirect: 60 };
/** A fire whose area has not grown for this long before the horizon counts as held. */
export const HELD_QUIET_MINUTES = 15;

/** Why a tactic cannot be used on a fire now, or null when it can. */
export function tacticBlocked(target: FireTarget, tactic: FireTactic): string | null {
  if (target.notAttackable) return target.notAttackable;
  if (tactic === "direct") return target.directBlocked;
  return null;
}

/** The fire's own unchecked footprint: arrival where this fire burned first, else never. */
export function fireArrival(run: ScheduledFireRun, fire: number): Float32Array {
  const { arrivalMinutes, sourceIndexByCell } = run;
  return Float32Array.from(arrivalMinutes, (minute, cell) =>
    sourceIndexByCell[cell] === fire ? minute : Number.POSITIVE_INFINITY,
  );
}

/**
 * Plan a flank or indirect line around one fire for engines starting at `crewMinutes`, or null
 * when there is nothing to build around (the fire has no footprint by then).
 */
export function planTacticLine(
  grid: LandscapeGrid,
  unchecked: Float32Array,
  tactic: LineTactic,
  crewMinutes: readonly number[],
  windFromDegrees: number,
  horizonMinutes: number,
): LinePlan | null {
  if (crewMinutes.length === 0) return null;
  const first = Math.min(...crewMinutes);
  const isochrone = Math.min(horizonMinutes, first + LINE_LEAD_MINUTES[tactic]);
  const anchor = tactic === "flank" ? windFromDegrees : (windFromDegrees + 180) % 360;
  return planLine(
    grid,
    unchecked,
    isochrone,
    anchor,
    crewMinutes.map((minute) => ({ kind: DISPATCH_ENGINE_KIND, minute })),
  );
}

/** The part of a plan already built by `minute` (kept when a line is re-planned or abandoned). */
export function builtPart(plan: LinePlan, minute: number): LinePlan {
  const keep: number[] = [];
  plan.holdFromMinute.forEach((built, k) => {
    if (built <= minute) keep.push(k);
  });
  return {
    cells: Int32Array.from(keep, (k) => plan.cells[k]),
    holdFromMinute: Float32Array.from(keep, (k) => plan.holdFromMinute[k]),
    kind: Uint8Array.from(keep, (k) => plan.kind[k]),
    plannedMeters:
      plan.cells.length > 0 ? (plan.plannedMeters * keep.length) / plan.cells.length : 0,
  };
}

export function joinPlans(a: LinePlan | null, b: LinePlan | null): LinePlan | null {
  if (!a) return b;
  if (!b) return a;
  return {
    cells: Int32Array.from([...a.cells, ...b.cells]),
    holdFromMinute: Float32Array.from([...a.holdFromMinute, ...b.holdFromMinute]),
    kind: Uint8Array.from([...a.kind, ...b.kind]),
    plannedMeters: a.plannedMeters + b.plannedMeters,
  };
}

/** Every fire's line as one solver input (earliest build wins on shared cells), or null. */
export function combineLines(
  grid: LandscapeGrid,
  plans: readonly (LinePlan | null)[],
): ControlLines | null {
  if (!plans.some((plan) => plan && plan.cells.length > 0)) return null;
  const count = grid.width * grid.height;
  const holdFromMinute = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
  const holdsFlameLengthFeet = new Float32Array(count);
  const holds = GROUND_APPARATUS[DISPATCH_ENGINE_KIND].holdsFlameLengthFeet;
  for (const plan of plans) {
    if (!plan) continue;
    plan.cells.forEach((cell, k) => {
      if (plan.holdFromMinute[k] < holdFromMinute[cell]) {
        holdFromMinute[cell] = plan.holdFromMinute[k];
        holdsFlameLengthFeet[cell] = holds;
      }
    });
  }
  return { holdFromMinute, holdsFlameLengthFeet };
}

/**
 * Minute a fire stopped growing in a run's per-fire areas (the last minute its area rose),
 * when that is at least HELD_QUIET_MINUTES before the horizon; else null.
 */
export function heldMinute(
  frames: readonly { minute: number; areaBySource: number[] }[],
  fire: number,
  horizonMinutes: number,
): number | null {
  let last: number | null = null;
  let previous = -1;
  for (const frame of frames) {
    const area = frame.areaBySource[fire] ?? 0;
    if (area > previous + 1e-6) last = frame.minute;
    previous = area;
  }
  if (last === null || previous <= 0) return null;
  return last <= horizonMinutes - HELD_QUIET_MINUTES ? last : null;
}

/** Ground metres of a plan built by `minute`. */
export function builtMeters(plan: LinePlan | null, minute: number): number {
  if (!plan || plan.cells.length === 0) return 0;
  let built = 0;
  for (const t of plan.holdFromMinute) if (t <= minute) built += 1;
  return (plan.plannedMeters * built) / plan.cells.length;
}
