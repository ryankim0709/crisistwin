/**
 * Direct attack by dispatched engines: can the engines the agent sends to a fire put it out?
 * The same rough containment race as the Studio's initial attack (studio/initialAttack.ts,
 * docs/adr/0020-studio-firefighting.md), but per fire and with each engine starting work when
 * it actually arrives on the road network. Line is built at the engine rate (grass-equivalent,
 * so heavier fuel needs more work) while the fire's edge keeps growing; the edge is an
 * ellipse with the fire's modelled area and its ignition-point length-to-breadth ratio. The fire
 * is out once the line built covers it. Direct attack is only possible where engines can hold
 * the head: a wildland fire whose ignition-point head flame is within the Hauling-chart limit
 * and that is not crowning, or a structure fire (engines fight buildings directly; the chart is
 * for wildland fuel). Every fire can still be flanked or attacked indirectly (fireTactics.ts).
 * Pure: no React, network or LLM. See docs/adr/0022-dispatch-fire-attack.md and
 * docs/adr/0025-dispatch-fire-tactics.md.
 */

import type { ScheduledFireRun } from "../fire/scheduledTypes";
import { GROUND_APPARATUS, grassRateMetersPerHour } from "../studio/apparatus";
import { productionFactor } from "../studio/firefighting";
import { ellipsePerimeter } from "../studio/initialAttack";
import type { LonLat } from "./area";
import { DEVELOPED_FUEL_CODE } from "../fire/spread";

/**
 * The dispatch agent's engines are CAL FIRE Type 3 engines, the data's default state engine
 * (docs/suppression-data.md, "How the simulator should use it").
 */
export const DISPATCH_ENGINE_KIND = "engine_t3" as const;
/**
 * Line one engine builds per minute in grass, metres: PMS 465 p.164 Table 4, three-person
 * engine crew in fuel model 1 (24 chains/h = 483 m/h). It was an assumed 600 m/h before
 * docs/adr/0048-suppression-engine.md.
 */
export const ENGINE_LINE_METERS_PER_MINUTE = grassRateMetersPerHour(DISPATCH_ENGINE_KIND) / 60;
/** Longest flame an engine crew can hold, feet (Hauling chart, PMS 465 p.12). */
export const ENGINE_HOLDS_FLAME_FEET = GROUND_APPARATUS[DISPATCH_ENGINE_KIND].holdsFlameLengthFeet;
/** Attack options listed per fire: the nearest 1..N engines. */
export const MAX_ATTACK_OPTIONS = 4;

export interface FireTarget {
  /** Run source id. Index in `fires` equals the source's index in the run input. */
  id: string;
  name: string;
  location: LonLat;
  /** Minute this fire starts; null when another fire reached its point first. */
  ignitedMinute: number | null;
  /** Head flame at the ignition point, feet; Infinity when it crowns there. */
  headFlameFeet: number;
  lengthToBreadth: number;
  /** Grass-equivalent line work per metre of this fire's edge. */
  workPerMeter: number;
  /** Why engines cannot attack it at all (another fire got there first), or null. */
  notAttackable: string | null;
  /** Why engines cannot attack its head directly, or null when they can. */
  directBlocked: string | null;
  /** Started on developed ground (a structure fire). */
  structureFire: boolean;
}

/** Burned area per fire (index as in `FireTarget[]`) at one frame minute, m². */
export interface FireAreaFrame {
  minute: number;
  areaBySource: number[];
}

export function fireTargets(run: ScheduledFireRun, names: Record<string, string>): FireTarget[] {
  return run.ignitions.map((ignition, index) => {
    const source = run.input.sources[index];
    const { conditions, outcome } = ignition;
    const crowning = conditions.crown !== null && conditions.crown.type !== "surface";
    const headFlameFeet = crowning ? Infinity : conditions.spread.flameLengthFeet;
    const factor = productionFactor(conditions.fuelCode, DISPATCH_ENGINE_KIND);
    const ignitedMinute = outcome.status === "ignited" ? outcome.ignitedMinute : null;
    const structureFire = conditions.fuelCode === DEVELOPED_FUEL_CODE;
    return {
      id: source.id,
      name: names[source.id] || source.id,
      location: [source.location.longitude, source.location.latitude],
      ignitedMinute,
      headFlameFeet,
      lengthToBreadth: Math.max(1, conditions.spread.lengthToBreadth),
      workPerMeter: Number.isFinite(factor) ? 1 / factor : 0,
      notAttackable: ignitedMinute === null ? "another fire reached this point first" : null,
      structureFire,
      directBlocked:
        ignitedMinute === null
          ? "another fire reached this point first"
          : crowning
            ? "it is crowning; no crew can hold a crown fire's head"
            : !structureFire && headFlameFeet > ENGINE_HOLDS_FLAME_FEET
              ? `its ${headFlameFeet.toFixed(1)} ft head flame is longer than the ${ENGINE_HOLDS_FLAME_FEET} ft engines can hold at the head (Hauling chart); its flanks can still be worked`
              : null,
    };
  });
}

export function fireAreaFrames(run: ScheduledFireRun): FireAreaFrame[] {
  const ids = run.input.sources.map((source) => source.id);
  return run.frames.map((frame) => ({
    minute: frame.elapsedMinutes,
    areaBySource: ids.map((id) => frame.reachedAreaBySourceSquareMeters[id] ?? 0),
  }));
}

/** Burned area of fire `fire` at `minute`, interpolated linearly between frames, m². */
export function fireAreaAt(frames: readonly FireAreaFrame[], fire: number, minute: number): number {
  if (frames.length === 0) return 0;
  let after = frames.findIndex((frame) => frame.minute >= minute);
  if (after < 0) after = frames.length - 1;
  const b = frames[after];
  if (after === 0 || b.minute <= minute) return b.areaBySource[fire] ?? 0;
  const a = frames[after - 1];
  const t = (minute - a.minute) / (b.minute - a.minute);
  const from = a.areaBySource[fire] ?? 0;
  return from + ((b.areaBySource[fire] ?? 0) - from) * t;
}

/** Grass-equivalent metres of line needed to ring the fire at `minute`. */
export function lineNeededMeters(
  target: FireTarget,
  frames: readonly FireAreaFrame[],
  fire: number,
  minute: number,
): number {
  const perimeter = ellipsePerimeter(fireAreaAt(frames, fire, minute), target.lengthToBreadth);
  return perimeter * target.workPerMeter;
}

/**
 * Simulator estimate of the minute the fire is out: `builtMeters` already built, plus one
 * engine starting at each minute in `arrivals` (clamped to `now`). Null when the fire cannot be
 * attacked, nobody works it, or the line does not catch the edge by the horizon.
 */
export function projectOutMinute(
  target: FireTarget,
  frames: readonly FireAreaFrame[],
  fire: number,
  now: number,
  builtMeters: number,
  arrivals: readonly number[],
  horizonMinutes: number,
): number | null {
  if (target.directBlocked || target.ignitedMinute === null || arrivals.length === 0) return null;
  for (let minute = Math.max(now, target.ignitedMinute); minute <= horizonMinutes; minute += 1) {
    let built = builtMeters;
    for (const arrival of arrivals) {
      // Work starts the whole minute after arrival, as the engine steps it.
      built +=
        ENGINE_LINE_METERS_PER_MINUTE * Math.max(0, minute - Math.ceil(Math.max(arrival, now)));
    }
    if (built > 0 && built >= lineNeededMeters(target, frames, fire, minute)) return minute;
  }
  return null;
}
