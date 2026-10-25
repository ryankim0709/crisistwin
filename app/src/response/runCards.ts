/**
 * Response plans: the dispatch level a new fire gets (scaled by fire danger), the run card for
 * that level, the initial-attack failure tests, and the extended-attack orders that follow.
 * Pure. See docs/response-model.md, "Initial attack" and "Escalation".
 *
 * Sourced: the aircraft package (air attack, two airtankers, one helicopter; data leaf
 * deployment.calfire_initial_aircraft_response, California Fire Pilots Association, secondary),
 * CAL FIRE's initial-attack goal (contain 95% of fires at 10 acres or less; calfire_house_2019
 * p.4), the immediate-need order caps and one-time rule (Cal OES Operations Bulletin #1, April
 * 2022, p.2), and the Red Flag thresholds' role. Everything else (ground counts per level, the
 * danger breakpoints, escalation sizes and stage thresholds) is a named ASSUMPTION: no CAL FIRE
 * unit's dispatch matrix or Fire Danger Operating Plan table was retrieved (docs/suppression-data.md, Gaps).
 */

import { dataValue } from "../studio/apparatus";
import type { AirResponseKind, GroundResponseKind } from "./fleet";

export type DispatchLevel = "low" | "medium" | "high";
/** What a run card or an order asks for, by resource family. */
export interface ResourceCounts {
  engines: number;
  hand_crews: number;
  dozers: number;
  air_attack: number;
  airtankers: number;
  helicopters: number;
}

export const EMPTY_COUNTS: ResourceCounts = { engines: 0, hand_crews: 0, dozers: 0, air_attack: 0, airtankers: 0, helicopters: 0 };

const AIR = dataValue<{ air_attack: number; airtankers: number; helicopters: number }>("deployment.calfire_initial_aircraft_response");
const GROUND = dataValue<{ engines: number; dozers: number; hand_crews: number; chief_officers: number }>(
  "deployment.initial_attack_ground_first_alarm_sra_high",
);

/**
 * Run cards per dispatch level for a wildland fire.
 * - medium: the data's first alarm (ground ASSUMPTION in the data: 3 engines, 1 dozer, 1 crew;
 *   chief officers are not on the board) plus the sourced aircraft package.
 * - low: ASSUMPTION, a reduced card: 2 engines, 1 crew, 1 helicopter, no airtankers.
 * - high: ASSUMPTION, an augmented card ("may be augmented by fire weather", the aircraft
 *   source): 5 engines (a strike team's worth), 2 dozers, 2 crews, the aircraft package with a
 *   second helicopter.
 */
export const WILDLAND_RUN_CARDS: Record<DispatchLevel, ResourceCounts> = {
  low: { engines: 2, hand_crews: 1, dozers: 0, air_attack: 0, airtankers: 0, helicopters: 1 },
  medium: {
    engines: GROUND.engines,
    hand_crews: GROUND.hand_crews,
    dozers: GROUND.dozers,
    air_attack: AIR.air_attack,
    airtankers: AIR.airtankers,
    helicopters: AIR.helicopters,
  },
  high: { engines: 5, hand_crews: 2, dozers: 2, air_attack: AIR.air_attack, airtankers: AIR.airtankers, helicopters: 2 },
};

/**
 * ASSUMPTION: a fire that starts on developed ground (FBFM40 91) gets a structure first alarm of
 * 4 engines and no aircraft. NFPA 1710 5.2.4.2 sizes the initial full alarm for a 2,000 ft2
 * single-family house at 14 to 15 members (as cited, not re-fetched), about four engine
 * companies of four (NFPA 1710 minimum company staffing); the closest engines of either type fill it.
 */
export const STRUCTURE_RUN_CARD: ResourceCounts = { ...EMPTY_COUNTS, engines: 4 };

// ---- fire danger ----

/** 1 mph = 0.44704 m/s (exact). */
const MPS_PER_MPH = 0.44704;
/**
 * ASSUMPTION (breakpoint): Red Flag-like wind, 20-ft wind at or above 25 mph. NWS Red Flag
 * criteria pair sustained wind of about this order with low humidity; the exact pair varies by
 * forecast office and was not retrieved. The board has no humidity, so the moisture scenario
 * stands in for it.
 */
export const RED_FLAG_WIND_MPH = 25;
/** ASSUMPTION (breakpoint): wind at or above this, mph, raises a moderate day to medium. */
export const ELEVATED_WIND_MPH = 15;

/**
 * Dispatch level from fire danger. CAL FIRE units set dispatch levels from NFDRS Burning Index
 * breakpoints in their Fire Danger Operating Plans; the board has no NFDRS inputs, so this uses
 * the fuel moisture scenario (Scott & Burgan 2005 Table 1, chosen by the activity level) and
 * the hourly wind (ASSUMPTION, the mapping):
 * - high: critical moisture, or dry moisture with Red Flag-like wind;
 * - medium: dry moisture, or moderate moisture with elevated wind;
 * - low: otherwise.
 */
export function dispatchLevel(moisture: string, windMetersPerSecond: number): DispatchLevel {
  const mph = windMetersPerSecond / MPS_PER_MPH;
  if (moisture === "critical" || (moisture === "dry" && mph >= RED_FLAG_WIND_MPH)) return "high";
  // As documented: elevated wind raises only a moderate day (wet fuel stays low; it may not
  // carry fire at all).
  if (moisture === "dry" || (moisture === "moderate" && mph >= ELEVATED_WIND_MPH)) return "medium";
  return "low";
}

export function runCard(level: DispatchLevel, structure: boolean): ResourceCounts {
  return structure ? STRUCTURE_RUN_CARD : WILDLAND_RUN_CARDS[level];
}

// ---- initial attack failure and escalation ----

/** 1 acre = 0.40468564224 ha (exact). */
export const HECTARES_PER_ACRE = 0.40468564224;
/** CAL FIRE goal: contain 95% of fires at 10 acres or less (calfire_house_2019 p.4). Used as the initial-attack success size. */
export const IA_SUCCESS_MAX_ACRES = 10;
export const IA_SUCCESS_MAX_HA = IA_SUCCESS_MAX_ACRES * HECTARES_PER_ACRE;

/**
 * ASSUMPTION: escalation stages by fire size, acres. Stage 1 at the IA goal (sourced size, our
 * use of it as a trigger); stages 2 and 3 are an order of magnitude apart each.
 */
export const ESCALATION_STAGE_ACRES = [IA_SUCCESS_MAX_ACRES, 100, 1000] as const;

/**
 * Extended-attack orders per stage (ASSUMPTION sizes), in strike teams or single aircraft:
 * stage 1 (IA failed) 2 engine strike teams, 1 crew strike team, 1 dozer strike team, 2 more
 * airtankers and 1 helicopter; stages 2 and 3 repeat the ground part.
 */
export interface ExtendedOrder {
  engine_strike_teams: number;
  crew_strike_teams: number;
  dozer_strike_teams: number;
  airtankers: number;
  helicopters: number;
}
export const ESCALATION_ORDERS: ExtendedOrder[] = [
  { engine_strike_teams: 2, crew_strike_teams: 1, dozer_strike_teams: 1, airtankers: 2, helicopters: 1 },
  { engine_strike_teams: 2, crew_strike_teams: 2, dozer_strike_teams: 1, airtankers: 0, helicopters: 1 },
  { engine_strike_teams: 3, crew_strike_teams: 2, dozer_strike_teams: 1, airtankers: 0, helicopters: 0 },
];

/** ASSUMPTION (data leaf deployment.strike_team_composition, the common ICS definition): 5 engines per engine strike team. */
export const ENGINES_PER_STRIKE_TEAM = dataValue<{ engines: number }>("deployment.strike_team_composition").engines;
/** ASSUMPTION (ICS definition, not re-fetched): 2 hand crews per crew strike team, 2 dozers per dozer strike team. */
export const CREWS_PER_STRIKE_TEAM = 2;
export const DOZERS_PER_STRIKE_TEAM = 2;

/**
 * Cal OES Operations Bulletin #1 (April 2022) p.2: immediate-need caps from one adjacent
 * operational area, used one time per incident: five engine strike teams per engine type, five
 * crew strike teams, two dozer strike teams, two helicopters. Later orders go through the
 * normal ordering system (here: the state tier).
 */
export const IMMEDIATE_NEED_CAPS = {
  engine_strike_teams: 5,
  crew_strike_teams: 5,
  dozer_strike_teams: 2,
  helicopters: 2,
} as const;

/** Ground kinds of a strike team type. */
export const STRIKE_TEAM_KIND: Record<"engine" | "crew" | "dozer", GroundResponseKind> = {
  engine: "engine_t3",
  crew: "hand_crew_t1",
  dozer: "dozer_t2",
};

/** Resource families the AI commander's order_resources tool may name. */
export const ORDERABLE = ["engine_strike_team", "crew_strike_team", "dozer_strike_team", "airtanker", "helicopter"] as const;
export type Orderable = (typeof ORDERABLE)[number];
/** Most of one family one order_resources call may ask for (the immediate-need cap). */
export const MAX_ORDER_COUNT: Record<Orderable, number> = {
  engine_strike_team: IMMEDIATE_NEED_CAPS.engine_strike_teams,
  crew_strike_team: IMMEDIATE_NEED_CAPS.crew_strike_teams,
  dozer_strike_team: IMMEDIATE_NEED_CAPS.dozer_strike_teams,
  airtanker: 4,
  helicopter: IMMEDIATE_NEED_CAPS.helicopters,
};

export function airKindFor(family: "air_attack" | "airtankers" | "helicopters"): AirResponseKind {
  return family === "air_attack" ? "air_attack" : family === "airtankers" ? "airtanker_s2t" : "helicopter_t2";
}

export function groundFamilyOf(kind: GroundResponseKind): "engines" | "hand_crews" | "dozers" {
  return kind === "hand_crew_t1" ? "hand_crews" : kind === "dozer_t2" ? "dozers" : "engines";
}
