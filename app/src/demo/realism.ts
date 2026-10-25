/**
 * Physical inputs of the /demo board (docs/command-demo-realism.md): the LANDFIRE ground and the
 * hourly wind the fire solver runs on (demo/fireField.ts), sourced apparatus and line
 * production, and evacuation behaviour from tools/people_behavior.json. Pure: no React, network
 * or LLM. The page fetches the inputs (wind series, landscape, bases, carless counts) and hands
 * them to the model as a `DemoEnvironment`; every input says where it came from, and a missing
 * input falls back to a named, labelled ASSUMPTION constant below.
 *
 * Units: metric (m/s, m/min, metres) except flame length, which stays in feet because the
 * holding limits it is compared with (PMS 465 Hauling chart) are published in feet. Names carry
 * the unit.
 */

import { MOISTURE_PRESETS, type FuelMoisture } from "../fire/spread";
import type { LonLat } from "../live/types";
import {
  GROUND_APPARATUS,
  dataValue,
  lineRateMetersPerHour,
  type GroundKind,
} from "../studio/apparatus";

// ---- unit conversions (exact) ----

/** 1 mph = 0.44704 m/s (exact, international mile). The solver takes its wind in mph. */
export const METERS_PER_SECOND_PER_MPH = 0.44704;

// ---- fuel moisture ----

/** Moisture scenario id from fire/spread.ts MOISTURE_PRESETS (Scott & Burgan 2005, Table 1). */
export type MoistureId = "critical" | "dry" | "moderate" | "wet";

export function moistureOf(id: MoistureId): FuelMoisture {
  const preset = MOISTURE_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no moisture preset ${id}`);
  return preset.moisture;
}

// ---- wind ----

export interface WindSample {
  /** 20-ft (RAWS) or 10 m (ASOS) open wind; see `WindSeries.heightNote`. */
  speedMetersPerSecond: number | null;
  /** Meteorological: the bearing the wind blows FROM, degrees true. */
  fromDegrees: number | null;
}

export interface WindSeries {
  evidence: "observed" | "derived" | "assumption";
  /** Short provenance for the UI: station, distance, date. */
  label: string;
  station: { id: string; name: string; distanceKm: number } | null;
  /** UTC time of sample 0 (the board's T+0), or null for the constant fallback. */
  startUtc: string | null;
  /** Hourly samples; the board loops the series (hour h uses sample h mod length). */
  samples: WindSample[];
  heightNote: string;
}

/**
 * ASSUMPTION (wind fallback, only when GET /api/demo/wind fails): a constant wind. Speed is the
 * Jarbo Gap RAWS mean over 14Z-00Z on 2018-11-08 (docs/scenario-weather.md, observed);
 * direction is the board's earlier northeast assumption (docs/adr/0047-command-demo.md).
 */
export const FALLBACK_WIND_SPEED_M_PER_S = 5.9;
export const FALLBACK_WIND_FROM_DEG = 45;

export const FALLBACK_WIND: WindSeries = {
  evidence: "assumption",
  label: `Constant ${FALLBACK_WIND_SPEED_M_PER_S} m/s from ${FALLBACK_WIND_FROM_DEG}° (assumed; wind service unavailable)`,
  station: null,
  startUtc: null,
  samples: [{ speedMetersPerSecond: FALLBACK_WIND_SPEED_M_PER_S, fromDegrees: FALLBACK_WIND_FROM_DEG }],
  heightNote: "assumed open wind",
};

export interface WindNow {
  speedMetersPerSecond: number;
  fromDegrees: number;
  /** Index of the hourly sample in use (after looping). */
  hourIndex: number;
  /** True when the hour had no report and the previous reported hour is held (ASSUMPTION). */
  held: boolean;
}

/**
 * Wind at a board minute: the hourly sample, held for its hour, looping over the series.
 * ASSUMPTION: a missing hour holds the last reported hour before it (sim/weather.py leaves
 * gaps as null and never interpolates; the board needs a value every minute). A series with
 * no reported hour at all uses the fallback constant.
 */
export function windAt(series: WindSeries, minute: number): WindNow {
  const n = series.samples.length;
  const hourIndex = n > 0 ? ((Math.floor(Math.max(0, minute) / 60) % n) + n) % n : 0;
  for (let back = 0; back < n; back += 1) {
    const s = series.samples[(hourIndex - back + n) % n];
    if (s.speedMetersPerSecond != null && s.fromDegrees != null) {
      return { speedMetersPerSecond: s.speedMetersPerSecond, fromDegrees: s.fromDegrees, hourIndex, held: back > 0 };
    }
    if (s.speedMetersPerSecond === 0) {
      // Calm hour: direction is not reported for calm (sim/weather.py), so any bearing works.
      return { speedMetersPerSecond: 0, fromDegrees: 0, hourIndex, held: back > 0 };
    }
  }
  return { speedMetersPerSecond: FALLBACK_WIND_SPEED_M_PER_S, fromDegrees: FALLBACK_WIND_FROM_DEG, hourIndex, held: true };
}

// ---- ground ----

/** What the board knows about the ground (from the landscape the solver runs on). */
export interface Ground {
  fuelLabel: string;
  fuelEvidence: "landfire";
  terrainLabel: string;
  terrainEvidence: "observed";
  /** FBFM40 fuel code at a point (0 off the landscape). */
  fuelCodeAt(p: LonLat): number;
  /** Slope at a point; `cell` is the landscape cell (-1 off the grid). */
  slopeAt(p: LonLat): { slopeTangent: number; upslopeDegrees: number; cell: number };
}

/** The fire solver's inputs besides the landscape grid itself: fuel and slope lookups, and the hourly wind. */
export interface SpreadInputs {
  readonly ground: Ground;
  readonly wind: WindSeries;
}

// ---- apparatus ----

export type DemoApparatusKind = Extract<GroundKind, "engine_t3" | "engine_t1" | "hand_crew_t1" | "dozer_t2">;

/** Id prefix per kind on the board: E = engine, C = hand crew, D = dozer. */
export const KIND_PREFIX: Record<DemoApparatusKind, string> = {
  engine_t3: "E",
  engine_t1: "E",
  hand_crew_t1: "C",
  dozer_t2: "D",
};

/**
 * Line one unit builds per minute on this fuel and slope, metres: studio/apparatus.ts
 * lineRateMetersPerHour (hand crews Broyles 2011 Table 2; engines PMS 465 p.164 Table 4 by
 * crew size; dozers PMS 465 p.140 Table 2 by slope class, uphill column, none above 55%).
 */
export function lineMetersPerMinute(kind: DemoApparatusKind, fuelCode: number, slopePercent: number): number {
  const builder = GROUND_APPARATUS[kind].line;
  if (!builder) return 0;
  const perHour = lineRateMetersPerHour(builder, fuelCode, slopePercent, true);
  return Number.isFinite(perHour) ? perHour / 60 : 0;
}

/** Longest head flame, feet, the unit's line holds (PMS 465 p.12, Hauling chart). */
export function holdsFlameFeet(kind: DemoApparatusKind): number {
  return GROUND_APPARATUS[kind].holdsFlameLengthFeet;
}

/** Minutes from dispatch to rolling (turnout, or mobilisation for crews and dozers). */
export function turnoutMinutes(kind: DemoApparatusKind): number {
  return GROUND_APPARATUS[kind].turnoutMinutes;
}

export function kindLabel(kind: DemoApparatusKind): string {
  return GROUND_APPARATUS[kind].label;
}
export function kindShort(kind: DemoApparatusKind): string {
  return GROUND_APPARATUS[kind].short;
}

/**
 * ASSUMPTION (travel fallback, used only until or unless POST /api/demo/crew_routes answers):
 * straight line x OFFBOARD_CIRCUITY at the heavy-apparatus secondary-road cap, the same
 * off-board rule as studio/crewDispatch.ts (OFFBOARD_CIRCUITY 1.3; speed from
 * road_access.heavy_apparatus_speed_kmh_by_highway.secondary).
 */
export const FALLBACK_CIRCUITY = 1.3;
export const FALLBACK_SPEED_KMH = dataValue<Record<string, number>>("road_access.heavy_apparatus_speed_kmh_by_highway")
  .secondary;

// ---- evacuation behaviour (tools/people_behavior.json) ----

/**
 * Sourced: Camp Fire mean awareness-to-departure gap, 09:33 - 08:00 = 93 min (Grajdura 2022,
 * pp. 51-52; people_behavior.json camp_awareness_departure_timing, derived from two means).
 */
export const DEPARTURE_MEAN_MINUTES = 93;
/**
 * ASSUMPTION (shape): departure delays are exponential with that mean, so the cumulative share
 * gone t minutes after the cue is 1 - exp(-t / 93). Right-skewed, as the published mean
 * departure (09:33) after the median (09:00) suggests; no distribution was published.
 */
export function departedShare(minutesSinceCue: number): number {
  return minutesSinceCue <= 0 ? 0 : 1 - Math.exp(-minutesSinceCue / DEPARTURE_MEAN_MINUTES);
}
/**
 * ASSUMPTION inside a sourced range: 92% of ordered households with a vehicle leave
 * (people_behavior.json order_compliance suggested value; sourced range 0.87-0.968, Wong
 * et al. 2020 Table 11). The rest stay (wait and see, stay and defend).
 */
export const ORDER_COMPLIANCE = 0.92;
/**
 * ASSUMPTION inside a sourced range: 30% of households in a zone with no order leave on the
 * fire cue (people_behavior.json shadow_evacuation_share suggested value; sourced range
 * 0.291-0.75, Wong et al. 2020 Table 11). The cue is fire touching the zone.
 */
export const SHADOW_SHARE = 0.3;
