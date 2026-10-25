/**
 * Off-road reach: what a ground unit can do from where its road ends (the end of its
 * accessible road leg, from POST /api/demo/crew_routes) to the fire's edge. Pure. See
 * docs/response-model.md, "Off-road reach".
 *
 * - Engines attack directly only within hose reach of where they park. NWCG PMS 200 Engine
 *   Typing Standard minimum hose: Type 3 1,000 ft of 1½-inch (plus 500 ft of 1-inch), Types 1-2
 *   500 ft of 1½-inch. ASSUMPTION: the 1½-inch trunk sets the reach (laterals branch off it; no
 *   extra hose from a tender). Line within reach is built at the PMS 465 p.164 engine rate.
 * - Beyond hose reach, the engine crew may hike in and build hand line: personnel (PMS 200
 *   minimum: Type 3 three, Type 1 four) x the PMS 465 p.39 Table 1 initial-attack hand-line rate
 *   per person for the fuel model. Beyond ENGINE_CREW_MAX_HIKE_M it stays with the engine and
 *   builds no line.
 * - Hand crews hike in from where their road ends, however far that is, at Tobler's speed, and
 *   build line at Broyles (2011) rates if the hike takes at most HAND_CREW_MAX_HIKE_MINUTES.
 * - Dozers walk off the lowboy at DOZER_WALK_KMH where the slope on the way is within the
 *   PMS 465 p.140 table (55%), for at most DOZER_MAX_WALK_MINUTES; steeper, they cannot reach
 *   the edge.
 * - A line builder that cannot reach the edge in time holds its road as indirect line
 *   ("indirect"): the road it parked on is a barrier to hold or burn out from (PMS 465
 *   indirect attack). It builds no line on the fire edge in the solver (labelled in the UI).
 * - Walking speed: Tobler's hiking function (Tobler 1993, NCGIA Technical Report 93-1):
 *   6 exp(-3.5 |S + 0.05|) km/h on a path, x 3/5 off path, S the signed gradient (rise/run).
 */

import { GROUND_APPARATUS, METERS_PER_CHAIN, andersonModel, dataValue } from "../studio/apparatus";
import type { GroundResponseKind } from "./fleet";

const FT_TO_M = 0.3048;
/** PMS 200 minimum 1½-inch hose, feet: Type 3 1,000, Types 1-2 500 (NWCG Engine Typing Standard). */
export const HOSE_1_5_INCH_FEET: Partial<Record<GroundResponseKind, number>> = { engine_t3: 1000, engine_t1: 500 };
export function hoseReachMeters(kind: GroundResponseKind): number {
  return (HOSE_1_5_INCH_FEET[kind] ?? 0) * FT_TO_M;
}

/** ASSUMPTION: an engine crew hikes in to build hand line only this far from its engine (it keeps the engine and its water within reach). */
export const ENGINE_CREW_MAX_HIKE_M = 800;
/**
 * ASSUMPTION (labelled; no retrieved NWCG limit on hike-in distance): a hand crew hikes in to
 * attack directly when the hike takes at most this long; longer, it holds its road as indirect
 * line instead (or the crew is flown in: helitack). Crews routinely hike several km; 3 h at
 * Tobler's off-path flat speed (3.0 km/h) is about 9 km. Cross-check, recalled and not
 * re-fetched (nwcg.gov refused the fetch): the NWCG Work Capacity Test arduous standard
 * (PMS 307) is 3 mi with a 45-lb pack in 45 min (6.4 km/h on the flat), so Tobler's off-path
 * pace is well within what a qualified crew sustains.
 */
export const HAND_CREW_MAX_HIKE_MINUTES = 180;
/** ASSUMPTION: a dozer walking cross-country off its lowboy, km/h (no retrieved figure). */
export const DOZER_WALK_KMH = 3;
/** ASSUMPTION: a dozer walks (cutting its own access) at most this long; longer, it holds its road. */
export const DOZER_MAX_WALK_MINUTES = 180;
/** PMS 465 p.140 (data leaf dozers.max_slope_in_table_pct): dozers work up to 55% slope. */
export const DOZER_MAX_SLOPE_PCT = dataValue<number>("dozers.max_slope_in_table_pct");

/** Tobler (1993): walking speed, km/h, on a gradient (rise over run), off path x 3/5. */
export function toblerKmh(gradient: number, offPath = true): number {
  return 6 * Math.exp(-3.5 * Math.abs(gradient + 0.05)) * (offPath ? 3 / 5 : 1);
}

/** Minutes to walk `distanceM` (horizontal) climbing `riseM` (negative = downhill), off path. */
export function hikeMinutes(distanceM: number, riseM: number): number {
  if (distanceM <= 0) return 0;
  return (distanceM / 1000 / toblerKmh(riseM / distanceM)) * 60;
}

const IA_PER_PERSON = dataValue<{ rows: [number, number][] }>("hand_crews.production_initial_attack_1996").rows;
const PERSONS: Partial<Record<GroundResponseKind, number>> = {
  engine_t3: dataValue<number>("engines.typing.3.personnel_min"),
  engine_t1: dataValue<number>("engines.typing.1.personnel_min"),
};

/** An engine crew on foot: persons x PMS 465 p.39 chains/h/person for the fuel's Anderson model, m/min. */
export function engineCrewHandLineMPerMin(kind: GroundResponseKind, fuelCode: number): number {
  const model = andersonModel(fuelCode) ?? 1;
  const perPerson = IA_PER_PERSON.find((r) => r[0] === model)?.[1] ?? 0;
  return ((PERSONS[kind] ?? 0) * perPerson * METERS_PER_CHAIN) / 60;
}

export type WorkMode = "hose" | "hand_line" | "dozer" | "indirect" | "out_of_reach";

export interface WorkPlan {
  mode: WorkMode;
  /** Minutes after arriving before it builds line (the hike or walk in). */
  startDelayMinutes: number;
  /** Radius around the parking point within which it can build line, metres. */
  reachMeters: number;
}

/**
 * What a unit parked `distanceM` from the fire edge can do. `riseM` is the climb from the
 * parking point to the edge; `maxSlopePct` the steepest slope sampled on the way. A line
 * builder that cannot reach the edge holds its road as indirect line (reach 0: it builds no
 * line on the fire edge).
 */
export function planWork(kind: GroundResponseKind, distanceM: number, riseM: number, maxSlopePct: number): WorkPlan {
  const family = GROUND_APPARATUS[kind].line?.kind;
  const indirect: WorkPlan = { mode: "indirect", startDelayMinutes: 0, reachMeters: 0 };
  if (family === "engine") {
    const hose = hoseReachMeters(kind);
    if (distanceM <= hose) return { mode: "hose", startDelayMinutes: 0, reachMeters: hose };
    if (distanceM <= ENGINE_CREW_MAX_HIKE_M) return { mode: "hand_line", startDelayMinutes: hikeMinutes(distanceM, riseM), reachMeters: ENGINE_CREW_MAX_HIKE_M };
    return indirect;
  }
  if (family === "hand_crew") {
    const hike = hikeMinutes(distanceM, riseM);
    if (hike <= HAND_CREW_MAX_HIKE_MINUTES) {
      return { mode: "hand_line", startDelayMinutes: hike, reachMeters: Math.max(distanceM, ENGINE_CREW_MAX_HIKE_M) };
    }
    return indirect;
  }
  if (family === "dozer") {
    const walk = dozerWalkMinutes(distanceM);
    if (maxSlopePct <= DOZER_MAX_SLOPE_PCT && walk <= DOZER_MAX_WALK_MINUTES) {
      return { mode: "dozer", startDelayMinutes: walk, reachMeters: Math.max(distanceM, ENGINE_CREW_MAX_HIKE_M) };
    }
    return indirect;
  }
  return { mode: "out_of_reach", startDelayMinutes: 0, reachMeters: 0 };
}

/** Minutes for a dozer to walk `distanceM` off its lowboy at DOZER_WALK_KMH. */
export function dozerWalkMinutes(distanceM: number): number {
  return (distanceM / 1000 / DOZER_WALK_KMH) * 60;
}

/** "1 h 20 min" / "25 min". */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
