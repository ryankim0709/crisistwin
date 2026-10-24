/**
 * The fire-fighting side of a dispatch session: re-planning the control lines engines build,
 * and the what-if options the agent chooses from. Every number comes from re-running the fire
 * model with the lines and put-out minutes in question (a `TacticSolver.solve` call); nothing
 * here is decided by the LLM. See docs/adr/0025-dispatch-fire-tactics.md.
 */

import type { LandscapeGrid } from "../fire/landscape";
import type { ScheduledFireRun } from "../fire/scheduledTypes";
import type { ControlLines } from "../fire/spread";
import { lineStatus, LineStatus, type LinePlan } from "../studio/firefighting";
import type { DispatchEngine } from "./engine";
import { projectOutMinute, type FireAreaFrame } from "./fireAttack";
import type { FireExposure } from "./fireExposure";
import type { FrameSummary } from "./observation";
import {
  FIRE_TACTICS,
  builtPart,
  combineLines,
  heldMinute,
  joinPlans,
  planTacticLine,
  tacticBlocked,
  type FireTactic,
  type LineTactic,
} from "./fireTactics";

/** A fire solved with some fires put out and some lines built. */
export interface SolvedFire {
  run: ScheduledFireRun;
  exposure: FireExposure;
  /** Frame summaries for the observation's burned-area figures. */
  frames: readonly FrameSummary[];
  fireFrames: readonly FireAreaFrame[];
  /** Area burned by the horizon (all fires), hectares. */
  burnedHectares: number;
  /** Synthetic homes the fire reaches by the horizon. */
  homesReached: number;
}

export interface TacticSolver {
  grid: LandscapeGrid;
  /** Each fire's own unchecked footprint (fireTactics.fireArrival), index as in engine.fires. */
  unchecked: readonly Float32Array[];
  windFromDegrees: number;
  horizonMinutes: number;
  solve(outFromMinuteBySource: number[], lines: ControlLines | null): SolvedFire;
}

/** Engines per what-if option: the nearest 2, then the nearest 4. */
export const OPTION_CREW_SIZES = [2, 4] as const;
/** Fire solves spent on options per decision, so a decision stays about a second or two. */
export const MAX_OPTION_SOLVES = 12;

export interface TacticOption {
  tactic: FireTactic;
  /** Engines sent (the nearest not already on the fire); crews already on it stay and switch. */
  unitIds: string[];
  /** Minute the fire is out (direct) or held by its line, or null if not by the horizon. */
  containedMinute: number | null;
  burnedHectares: number;
  homesReached: number;
  /** Line planned and line that held, km (line tactics only). */
  lineKm: number | null;
  lineHeldKm: number | null;
}

function outFrom(engine: DispatchEngine): number[] {
  return engine.fires.map((fire) => fire.outMinute ?? Number.POSITIVE_INFINITY);
}

/** Line for one fire if `tactic` were used with crews starting at `crewMinutes`. */
function lineFor(
  engine: DispatchEngine,
  solver: TacticSolver,
  index: number,
  tactic: FireTactic | null,
  crewMinutes: readonly number[],
): LinePlan | null {
  const fire = engine.fires[index];
  const built = fire.line ? builtPart(fire.line, engine.minute) : null;
  if (tactic === null || tactic === "direct" || crewMinutes.length === 0) return built;
  const plan = planTacticLine(
    solver.grid,
    solver.unchecked[index],
    tactic as LineTactic,
    crewMinutes,
    solver.windFromDegrees,
    solver.horizonMinutes,
  );
  return joinPlans(built, plan);
}

/**
 * Re-plan every fire's line for the crews on it now (keeping line already built) when the
 * engine says lines changed, re-solve the fire with lines and put-out fires, and install both.
 * Returns the solve so the page can show the new fire.
 */
export function refreshFire(engine: DispatchEngine, solver: TacticSolver): SolvedFire {
  const lines = engine.linesDirty
    ? engine.fires.map((fire, index) =>
        lineFor(engine, solver, index, fire.tactic, engine.crewMinutes(index)),
      )
    : engine.fires.map((fire) => fire.line);
  const solved = solver.solve(outFrom(engine), combineLines(solver.grid, lines));
  engine.setFireLines(lines);
  engine.setExposure(
    solved.exposure,
    solved.fireFrames,
    engine.fires.map((fire, index) =>
      fire.tactic !== null && fire.tactic !== "direct"
        ? heldMinute(solved.fireFrames, index, solver.horizonMinutes)
        : null,
    ),
  );
  return solved;
}

/**
 * What-if options per burning fire: each usable tactic with the nearest 2 and 4 engines not on
 * it, each solved. Largest fires first, at most MAX_OPTION_SOLVES solves in all.
 */
export function evaluateTacticOptions(
  engine: DispatchEngine,
  solver: TacticSolver,
): Map<number, TacticOption[]> {
  const options = new Map<number, TacticOption[]>();
  let budget = MAX_OPTION_SOLVES;
  const burning = engine.fires
    .map((_, index) => index)
    .filter((index) => engine.fireBurning(index))
    .sort((a, b) => engine.fireAreaSquareMeters(b) - engine.fireAreaSquareMeters(a));
  const currentLines = engine.fires.map((fire) => fire.line);
  for (const index of burning) {
    const fire = engine.fires[index];
    const candidates = engine.nearestUnits(index, Math.max(...OPTION_CREW_SIZES));
    const sizes = [...new Set(OPTION_CREW_SIZES.map((k) => Math.min(k, candidates.length)))].filter(
      (k) => k > 0,
    );
    const list: TacticOption[] = [];
    for (const tactic of FIRE_TACTICS) {
      if (tacticBlocked(fire.target, tactic)) continue;
      for (const k of sizes) {
        if (budget <= 0) break;
        budget -= 1;
        const chosen = candidates.slice(0, k);
        const crewMinutes = [...engine.crewMinutes(index), ...chosen.map((c) => c.minute)];
        const out = outFrom(engine);
        const lines = [...currentLines];
        let containedMinute: number | null = null;
        if (tactic === "direct") {
          containedMinute = projectOutMinute(
            fire.target,
            engine.fireFramesNow(),
            index,
            engine.minute,
            fire.tactic === "direct" ? fire.lineMeters : 0,
            crewMinutes,
            solver.horizonMinutes,
          );
          out[index] = containedMinute ?? Number.POSITIVE_INFINITY;
          lines[index] = fire.line ? builtPart(fire.line, engine.minute) : null;
        } else {
          lines[index] = lineFor(engine, solver, index, tactic, crewMinutes);
        }
        const solved = solver.solve(out, combineLines(solver.grid, lines));
        if (tactic !== "direct") {
          containedMinute = heldMinute(solved.fireFrames, index, solver.horizonMinutes);
        }
        const line = tactic === "direct" ? null : lines[index];
        let held: number | null = null;
        if (line && line.cells.length > 0) {
          const status = lineStatus(line, solved.run.arrivalMinutes, solver.horizonMinutes);
          const perCell = line.plannedMeters / line.cells.length;
          held = 0;
          for (const s of status) if (s === LineStatus.held) held += perCell;
        }
        list.push({
          tactic,
          unitIds: chosen.map((c) => c.unitId),
          containedMinute,
          burnedHectares: solved.burnedHectares,
          homesReached: solved.homesReached,
          lineKm: line ? line.plannedMeters / 1000 : null,
          lineHeldKm: held === null ? null : held / 1000,
        });
      }
    }
    options.set(index, list);
  }
  return options;
}
