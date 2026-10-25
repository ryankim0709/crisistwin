/**
 * Containment: tactic choice by flame length, line production per tactic, the line a tactic
 * needs, and the seeded line-holding test. Pure. See docs/response-model.md, "Containment".
 *
 * The race is Fried & Fried (1996, Forest Science 42(3):267-281): resources build line along the
 * perimeter while it grows; the fire is contained when the line built covers the perimeter it
 * must enclose. The board uses the solver's own perimeter (demo/fireField.ts perimeterAt), not
 * an ellipse; for a fire whose perimeter grows linearly, P(t) = k t, with line rate R from
 * arrival t_a, the race gives Fried & Fried's linear-growth containment time
 * t* = R t_a / (R - k) (containmentMinuteLinear below), and no containment when R <= k.
 *
 * Tactic by head flame length, PMS 465 p.12 Figure 2 (the Hauling chart), with the resources'
 * holding limits (studio/apparatus.ts: hand tools 4 ft, engines and dozers 8 ft; retardant 8 ft,
 * PMS 465 pp.171, 174):
 * - direct: head flame within the strongest limit on the fire. Line = current perimeter.
 * - parallel: head flame above that limit but at most HEAD_ATTACK_INEFFECTIVE_FT (11 ft; above it
 *   "control efforts at the head are ineffective"). ASSUMPTION: the 8-11 ft band is held only by
 *   line set back PARALLEL_OFFSET_M with burnout, which removes the fuel the head would meet.
 *   Line = perimeter + 2 pi x offset (Steiner's formula for the offset of a convex outline).
 * - indirect: as parallel, but when the parallel line cannot be finished before the fire
 *   outgrows it: line placed on the perimeter the fire will have INDIRECT lead minutes later
 *   (the solver's lookahead), finished before the fire arrives (as studio/firefighting.ts
 *   isochrone lines). The fire burns to the line; it is contained when it gets there.
 * - structure: the head is on developed ground (FBFM40 91, the solver's structure spread).
 *   ASSUMPTION, as dispatch/fireAttack.ts: no Hauling-chart limit (structure fire is fought by
 *   engines with water, not by fireline); line counted at the engine's grass rate (Anderson
 *   model 1, studio/apparatus.ts andersonModel).
 * - flank (point protection at the head): head flame above 11 ft or crowning. No line holds the
 *   head; resources build flank line (anchor and flank) until the head lays down, and engines
 *   protect what the head threatens (the protection itself is not modelled).
 */

import { GROUND_APPARATUS, andersonModel, broylesColumn, dataValue } from "../studio/apparatus";
import type { GroundResponseKind } from "./fleet";
import { lognormalFactor, type RngStream } from "./rng";

export type Tactic = "direct" | "parallel" | "indirect" | "structure" | "flank";

export const TACTIC_LABEL: Record<Tactic, string> = {
  direct: "Direct attack",
  parallel: "Parallel attack with burnout",
  indirect: "Indirect line ahead of the fire",
  structure: "Structure fire attack",
  flank: "Flank and protect (head not attackable)",
};

const LIMITS = dataValue<{ hand_tools_direct_attack_head_max: number; serious_control_problems: [number, number]; head_attack_ineffective_above: number }>(
  "hand_crews.flame_length_limits_ft",
);
/** PMS 465 p.12: control efforts at the head are ineffective above this flame length, feet. */
export const HEAD_ATTACK_INEFFECTIVE_FT = LIMITS.head_attack_ineffective_above;
/** ASSUMPTION: a parallel line is set back about one chain (66 ft) from the edge, metres. */
export const PARALLEL_OFFSET_M = 20;
/** ASSUMPTION: indirect line lead times tried, minutes (a subset of studio/firefighting.ts ISOCHRONE_OFFSETS_MINUTES). */
export const INDIRECT_LEAD_MINUTES = [30, 60, 90, 120] as const;
/**
 * ASSUMPTION: the modelled head flame is uncertain. At a holding test the flame the line meets
 * is the model's head flame times a lognormal factor with log-SD 0.3. Fire-behaviour model
 * evaluations score predictions against a +/-35% band (Cruz & Alexander 2013, Environmental
 * Modelling & Software 47:16-28); the spread chosen here is of that order, not fitted.
 */
export const FLAME_LOG_SD = 0.3;
/** ASSUMPTION: a breached line loses this share of the line built (slopover and re-anchoring). */
export const BREACH_LINE_LOSS_SHARE = 0.25;
/** ASSUMPTION: after a breach the next holding test waits this long, minutes. */
export const BREACH_RETRY_MINUTES = 10;

/** Hauling chart band of a head flame (PMS 465 p.12). */
export function haulingBand(flameFeet: number): "hand_tools" | "machines" | "indirect_only" | "no_head_control" {
  if (flameFeet <= LIMITS.hand_tools_direct_attack_head_max) return "hand_tools";
  if (flameFeet <= LIMITS.serious_control_problems[0]) return "machines";
  if (flameFeet <= HEAD_ATTACK_INEFFECTIVE_FT) return "indirect_only";
  return "no_head_control";
}

export interface TacticInput {
  structure: boolean;
  crowning: boolean;
  headFlameFeet: number;
  /** Longest flame the resources on (or assigned to) the fire hold in direct attack, feet (0 = none). */
  directHoldsFeet: number;
  /** Whether a parallel line can be finished before the fire outgrows it (caller's forecast). */
  parallelFeasible: boolean;
}

/** The tactic for the fire now. */
export function chooseTactic(t: TacticInput): Tactic {
  if (t.structure) return "structure";
  if (t.crowning || t.headFlameFeet > HEAD_ATTACK_INEFFECTIVE_FT) return "flank";
  if (t.directHoldsFeet > 0 && t.headFlameFeet <= t.directHoldsFeet) return "direct";
  return t.parallelFeasible ? "parallel" : "indirect";
}

/** Longest head flame a tactic's finished line is taken to hold, feet (Infinity: no flame test). */
export function tacticHoldsFeet(tactic: Tactic, directHoldsFeet: number): number {
  if (tactic === "structure") return Number.POSITIVE_INFINITY;
  if (tactic === "direct") return directHoldsFeet;
  if (tactic === "flank") return 0;
  return HEAD_ATTACK_INEFFECTIVE_FT;
}

const INDIRECT = dataValue<{ type1: { chains_per_hour: number[] } }>("hand_crews.production_sustained_2011_indirect").type1.chains_per_hour;
const DIRECT = dataValue<{ type1: { chains_per_hour: number[] } }>("hand_crews.production_sustained_2011_direct").type1.chains_per_hour;

/**
 * Production on a tactic relative to direct attack. Hand crews: Broyles (2011) Table 2, Type 1
 * crew, indirect over direct sustained rate in the fuel's column (grass 9.5/17, chaparral 5/6.6,
 * brush 4.9/16.5, timber 6.9/10.5). Engines and dozers: 1 (ASSUMPTION: a dozer's single pass
 * is the same line wherever it is cut; engines support the burnout at their initial-attack rate).
 */
export function tacticRateFactor(kind: GroundResponseKind, fuelCode: number, tactic: Tactic): number {
  if (tactic !== "parallel" && tactic !== "indirect") return 1;
  if (kind !== "hand_crew_t1") return 1;
  const model = andersonModel(fuelCode);
  if (model === null) return 1;
  const col = broylesColumn(model);
  return DIRECT[col] > 0 ? INDIRECT[col] / DIRECT[col] : 1;
}

/** Whether a kind's line counts on this tactic (a structure attack is engine work; ASSUMPTION). */
export function buildsOn(kind: GroundResponseKind, tactic: Tactic): boolean {
  if (tactic === "structure") return kind === "engine_t3" || kind === "engine_t1";
  return GROUND_APPARATUS[kind].line !== null;
}

/** Line the tactic needs, metres: current perimeter (+ offset ring), or the planned target perimeter. */
export function lineNeededMeters(tactic: Tactic, perimeterNowM: number, targetPerimeterM: number | null): number {
  if (tactic === "parallel") return perimeterNowM + 2 * Math.PI * PARALLEL_OFFSET_M;
  if (tactic === "indirect") return targetPerimeterM ?? perimeterNowM;
  return perimeterNowM;
}

/**
 * The seeded holding test when the line is complete: the flame the line meets (head flame x
 * lognormal) against what the tactic holds. Returns the drawn flame and whether it held.
 */
export function holdingTest(rng: RngStream, headFlameFeet: number, holdsFeet: number): { flameFeet: number; held: boolean } {
  if (!Number.isFinite(holdsFeet)) return { flameFeet: headFlameFeet, held: true };
  const flameFeet = headFlameFeet * lognormalFactor(rng, FLAME_LOG_SD);
  return { flameFeet, held: flameFeet <= holdsFeet };
}

/**
 * Fried & Fried (1996) containment time for a perimeter growing linearly from the ignition
 * (P = k t, k in m/min) and line built at R m/min from arrival minute t_a: t* = R t_a / (R - k),
 * or null when R <= k (the fire outruns the line). Used to check the board's race (docs).
 */
export function containmentMinuteLinear(lineRateMPerMin: number, perimeterGrowthMPerMin: number, arrivalMinute: number): number | null {
  if (lineRateMPerMin <= perimeterGrowthMPerMin) return null;
  return (lineRateMPerMin * arrivalMinute) / (lineRateMPerMin - perimeterGrowthMPerMin);
}
