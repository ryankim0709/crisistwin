/**
 * Unit and aircraft management rules: work/rest, water, availability, move-up and cover,
 * release at containment, and aircraft cycles gated by daylight and wind. Pure. See
 * docs/response-model.md, "Resource management".
 *
 * Unit states (demo/model.ts TeamStatus): available, en_route, on_scene, refilling (engine off
 * the line for water), returning (driving home after release), moving_up (relocating to cover
 * an empty station), resting (work/rest), out_of_service (seeded unavailability).
 */

import type { LonLat } from "../live/types";
import { dataValue, andersonModel, METERS_PER_FOOT, KMH_PER_KNOT } from "../studio/apparatus";
import {
  AIRCRAFT,
  ASSUMED_DIP_KM,
  HARD_FLIGHT_WIND_KT,
  airtankerCycleMinutes,
  aviationWindows,
  coverageLevel,
  helicopterTurnaroundMinutes,
  lineFeetPerLoad,
  windEffect,
} from "../studio/aircraft";
import { inWindow } from "../studio/daylight";
import type { AirResponseKind, GroundResponseKind } from "./fleet";

// ---- work and rest ----

/**
 * Work/rest (Interagency Standards for Fire and Fire Aviation Operations, NFES 2724, Chapter 7;
 * NWCG work/rest guidelines): a minimum 2:1 work to rest ratio (one hour of rest for every two
 * hours of work or travel), and shifts over 16 hours are the exception. A unit that has worked
 * (travelled to, worked on or refilled at fires) MAX_SHIFT_MINUTES without rest is relieved
 * and rests worked/2 minutes.
 */
export const MAX_SHIFT_MINUTES = 16 * 60;
export const WORK_TO_REST_RATIO = 2;
export function restMinutesAfter(workedMinutes: number): number {
  return workedMinutes / WORK_TO_REST_RATIO;
}

// ---- water ----

/** NWCG PMS 200 minimum tank, US gallons: Type 3 500, Type 1 300 (data leaves engines.typing.N.tank_min_gal). */
export const TANK_GALLONS: Partial<Record<GroundResponseKind, number>> = {
  engine_t3: dataValue<number>("engines.typing.3.tank_min_gal"),
  engine_t1: dataValue<number>("engines.typing.1.tank_min_gal"),
};
/**
 * ASSUMPTION: an engine working a line (mobile attack or hose lay) uses 20 gal/min on average:
 * one 1-inch line with a forestry nozzle, flowing part of the time. Not from a retrieved source.
 */
export const ENGINE_WATER_USE_GPM = 20;
/**
 * ASSUMPTION: an empty engine is off the line this long to refill (from a water tender or a
 * hydrant). PMS 200 gives a support water tender's own maximum refill time as 15-30 min (data
 * leaf response_times.water_tender_refill_min); 20 min is taken inside that range as a proxy
 * for the engine's trip, not a sourced engine figure.
 */
export const ENGINE_REFILL_MINUTES = 20;

// ---- availability ----

/** ASSUMPTION: share of units out of service (maintenance, training, committed elsewhere) at any time; drawn per unit per 8 h. */
export const OUT_OF_SERVICE_PROBABILITY = 0.08;
/** ASSUMPTION: how long an out-of-service unit stays out, minutes (uniform). */
export const OUT_OF_SERVICE_MINUTES: [number, number] = [60, 480];
/** How often availability is redrawn for idle units, minutes (ASSUMPTION). */
export const AVAILABILITY_DRAW_EVERY_MINUTES = 480;

// ---- move-up and cover ----

/**
 * ASSUMPTION (data leaf deployment.move_up_and_cover, no CAL FIRE threshold retrieved): when a
 * station's units have all been committed for this long, a free engine from a station that
 * still has two or more relocates to cover it.
 */
export const MOVE_UP_EMPTY_MINUTES = 30;
/** How often the board checks coverage, minutes. */
export const MOVE_UP_CHECK_EVERY_MINUTES = 5;

// ---- release ----

/** ASSUMPTION: at containment the closest engine and hand crew stay for mop-up; the others are released. */
export const MOPUP_KEEP: Partial<Record<"engines" | "hand_crews" | "dozers", number>> = { engines: 1, hand_crews: 1 };

// ---- aircraft ----

/** 1 m/s = 1.943844 kt (exact via 1 kt = 1.852 km/h). */
export const KNOTS_PER_METER_PER_SECOND = 3.6 / KMH_PER_KNOT;

export interface AircraftRole {
  role: "helicopter" | "airtanker" | "air_attack";
  gallons: number;
  cruiseKnots: number;
  callToTakeoffMinutes: number;
}
export function aircraftSpec(kind: AirResponseKind): AircraftRole {
  return AIRCRAFT[kind];
}

/** Minutes from dispatch to over the fire: call to takeoff + straight flight at cruise. */
export function firstOverFireMinutes(kind: AirResponseKind, distanceKm: number): number {
  const spec = AIRCRAFT[kind];
  return spec.callToTakeoffMinutes + (distanceKm / (spec.cruiseKnots * KMH_PER_KNOT)) * 60;
}

/**
 * Minutes between drops: an airtanker flies back to its base, reloads and returns
 * (studio/aircraft.ts airtankerCycleMinutes; reload ground time an assumption in the data); a
 * helicopter dips at the nearest open water or the assumed dip distance
 * (helicopterTurnaroundMinutes). Air attack does not drop (null).
 */
export function dropCycleMinutes(kind: AirResponseKind, baseKm: number, dipKm: number | null): number | null {
  const spec = AIRCRAFT[kind];
  if (spec.role === "air_attack") return null;
  if (spec.role === "helicopter") return helicopterTurnaroundMinutes(dipKm ?? ASSUMED_DIP_KM, spec.cruiseKnots);
  return airtankerCycleMinutes(baseKm, spec.cruiseKnots);
}

/**
 * Line one load makes on this fuel, metres: IASG 2017 Table 8 by gallons and the Table 7
 * coverage level for the fuel (studio/aircraft.ts), times the wind effect (1 below 15 kt, 0 at
 * 25 kt, linear between; ASSUMPTION shape on the IASG p.100 thresholds).
 */
export function dropLineMeters(kind: AirResponseKind, fuelCode: number, windKnots: number): number {
  const spec = AIRCRAFT[kind];
  if (spec.gallons <= 0) return 0;
  const model = andersonModel(fuelCode) ?? 1;
  return lineFeetPerLoad(spec.gallons, coverageLevel(model)) * METERS_PER_FOOT * windEffect(windKnots);
}

/** Whether the aircraft may fly now: daylight window by role (IASG pp.37, 42) and the hard wind stop (ASSUMPTION 35 kt). */
export function mayFly(kind: AirResponseKind, epochMs: number, at: LonLat, windKnots: number, supervised: boolean): boolean {
  if (windKnots >= HARD_FLIGHT_WIND_KT) return false;
  const w = aviationWindows(epochMs - 86_400_000, 2 * 24 * 60, at);
  const role = AIRCRAFT[kind].role;
  const windows = role === "helicopter" ? w.helicopter : role === "air_attack" || supervised ? w.supervised : w.unsupervised;
  return inWindow(windows, epochMs);
}
