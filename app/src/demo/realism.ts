/**
 * Physical inputs of the /demo board (docs/command-demo-realism.md): Rothermel spread from
 * fuel, slope and wind; sourced apparatus and line production; evacuation behaviour from
 * tools/people_behavior.json. Pure: no React, network or LLM. The page fetches the inputs
 * (wind series, Camp terrain, bases, carless counts) and hands them to the model as a
 * `DemoEnvironment`; every input says where it came from, and a missing input falls back to
 * a named, labelled ASSUMPTION constant below.
 *
 * Units. rothermel.ts is Imperial (ft/min, Btu/ft/s, feet); everything leaving this module is
 * metric (m/min, metres), except flame length, which stays in feet because the holding limits
 * it is compared with (PMS 465 Hauling chart) are published in feet. Names carry the unit.
 */

import { FUEL_MODELS, isBurnable, type FuelModel } from "../fire/fuelModels";
import { windAdjustmentFactor } from "../fire/crownFire";
import { prepareFuelBed, spreadFromBed, directionalRate, type FuelBed } from "../fire/rothermel";
import { MOISTURE_PRESETS, type FuelMoisture } from "../fire/spread";
import type { LonLat } from "../live/types";
import {
  GROUND_APPARATUS,
  dataValue,
  lineRateMetersPerHour,
  type GroundKind,
} from "../studio/apparatus";

// ---- unit conversions (exact) ----

export const METERS_PER_FOOT = 0.3048;
/** 1 mph = 0.44704 m/s (exact, international mile). */
export const METERS_PER_SECOND_PER_MPH = 0.44704;
/** 1 mph = 88 ft/min (exact). */
export const FEET_PER_MINUTE_PER_MPH = 88;

export function metersPerSecondToFeetPerMinute(speedMetersPerSecond: number): number {
  return (speedMetersPerSecond / METERS_PER_SECOND_PER_MPH) * FEET_PER_MINUTE_PER_MPH;
}

// ---- fuel ----

/**
 * ASSUMPTION (fallback fuel): Scott & Burgan (2005) SH5, high-load dry-climate shrub (FBFM40
 * code 145), on every cell. It is the fuel sim/fire.py (`DEFAULT_FUEL_MODEL`) uses for the
 * Camp replay for the same reason: no LANDFIRE landscape covers the drill area, and SH5 stands
 * for the chaparral and manzanita of the Feather River canyon and the brushy understory of
 * the Paradise ridge. Used only when no prebuilt landscape (GET /api/landscapes) covers it.
 */
export const FALLBACK_FUEL_CODE = 145;

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

// ---- terrain and fuel per point ----

/** Camp 3DEP slope grid from GET /api/demo/environment (sim/terrain.py resampling). */
export interface TerrainGrid {
  originLon: number;
  originLat: number;
  cellMeters: number;
  ncols: number;
  nrows: number;
  metersPerDegLon: number;
  metersPerDegLat: number;
  /** Rise over run, row 0 = south. */
  slopeTangent: Float32Array;
  /** Compass bearing of the upslope direction, degrees true. */
  upslopeDegrees: Float32Array;
  label: string;
}

/** What the board knows about the ground: fuel per point and slope per point. */
export interface Ground {
  fuelLabel: string;
  fuelEvidence: "landfire" | "assumption";
  terrainLabel: string;
  terrainEvidence: "observed" | "assumption";
  /** FBFM40 fuel code at a point. */
  fuelCodeAt(p: LonLat): number;
  /** Slope at a point; `cell` is a stable key for caching (-1 off the grid). */
  slopeAt(p: LonLat): { slopeTangent: number; upslopeDegrees: number; cell: number };
}

export function groundFrom(terrain: TerrainGrid | null): Ground {
  return {
    fuelLabel: "SH5 high-load dry-climate shrub on every cell (assumed: no LANDFIRE landscape covers the drill area)",
    fuelEvidence: "assumption",
    terrainLabel: terrain ? terrain.label : "Flat ground (assumed: Camp terrain grid unavailable)",
    terrainEvidence: terrain ? "observed" : "assumption",
    fuelCodeAt: () => FALLBACK_FUEL_CODE,
    slopeAt: (p) => {
      if (!terrain) return { slopeTangent: 0, upslopeDegrees: 0, cell: -1 };
      const col = Math.floor(((p[0] - terrain.originLon) * terrain.metersPerDegLon) / terrain.cellMeters);
      const row = Math.floor(((p[1] - terrain.originLat) * terrain.metersPerDegLat) / terrain.cellMeters);
      if (col < 0 || row < 0 || col >= terrain.ncols || row >= terrain.nrows) {
        return { slopeTangent: 0, upslopeDegrees: 0, cell: -1 };
      }
      const cell = row * terrain.ncols + col;
      return { slopeTangent: terrain.slopeTangent[cell], upslopeDegrees: terrain.upslopeDegrees[cell], cell };
    },
  };
}

// ---- spread ----

export interface SpreadRates {
  /** Head, back and flank (semi-minor growth) rates, m/min. */
  headMetersPerMinute: number;
  backMetersPerMinute: number;
  flankMetersPerMinute: number;
  /** Anderson (1983) length-to-breadth, capped at 8 (rothermel.ts MAX_LENGTH_TO_BREADTH). */
  lengthToBreadth: number;
  /** Compass bearing of maximum spread (wind and slope combined as vectors), degrees true. */
  headingDegrees: number;
  /** Byram flame length at the head, feet. */
  headFlameFeet: number;
  firelineIntensityBtuPerFootPerSecond: number;
  fuelCode: number;
  slopePercent: number;
  midflameWindMetersPerSecond: number;
}

const NO_SPREAD = (fuelCode: number, slopePercent: number): SpreadRates => ({
  headMetersPerMinute: 0,
  backMetersPerMinute: 0,
  flankMetersPerMinute: 0,
  lengthToBreadth: 1,
  headingDegrees: 0,
  headFlameFeet: 0,
  firelineIntensityBtuPerFootPerSecond: 0,
  fuelCode,
  slopePercent,
  midflameWindMetersPerSecond: 0,
});

/** Treeless cell for the Albini & Baughman unsheltered factor (no canopy data on the board). */
const OPEN_CANOPY = { baseHeightMeters: 0, bulkDensityKgPerM3: 0, coverFraction: 0, heightMeters: 0 };

const bedCache = new Map<string, FuelBed>();
function bedFor(fuel: FuelModel, moistureId: MoistureId): FuelBed {
  const key = `${fuel.code}|${moistureId}`;
  let bed = bedCache.get(key);
  if (!bed) {
    bed = prepareFuelBed(fuel, moistureOf(moistureId));
    bedCache.set(key, bed);
  }
  return bed;
}

/**
 * Rothermel (1972) surface spread at one fuel, slope and wind (fire/rothermel.ts, Andrews
 * RMRS-GTR-371 2018 formulation), as an ellipse:
 * - midflame wind = open wind x the Albini & Baughman (1979) unsheltered wind adjustment
 *   factor for the fuel bed depth (fire/crownFire.ts windAdjustmentFactor; no canopy data);
 * - length-to-breadth from the effective wind, Anderson (1983), as FARSITE uses
 *   (rothermel.ts lengthToBreadthRatio, capped at 8);
 * - backing rate = the rear-focus ellipse rate at 180 degrees from the head (Alexander 1985,
 *   rothermel.ts directionalRate), floored at the no-wind no-slope rate as BehavePlus does
 *   (fire/spread.ts SPREAD_MODEL.backingRate);
 * - flank (semi-minor) growth = (head + back) / (2 x L:B), the ellipse with that length.
 * Surface fire only: no crown fire (no canopy rasters for the area).
 */
export function spreadRates(
  fuelCode: number,
  slopeTangent: number,
  upslopeDegrees: number,
  wind: { speedMetersPerSecond: number; fromDegrees: number },
  moistureId: MoistureId,
): SpreadRates {
  const slopePercent = slopeTangent * 100;
  const fuel = FUEL_MODELS.get(fuelCode);
  if (!fuel || !isBurnable(fuelCode)) return NO_SPREAD(fuelCode, slopePercent);
  const bed = bedFor(fuel, moistureId);
  const waf = windAdjustmentFactor(OPEN_CANOPY, fuel.depthFeet);
  const midflameFeetPerMinute = metersPerSecondToFeetPerMinute(wind.speedMetersPerSecond) * waf;
  const towardDegrees = (wind.fromDegrees + 180) % 360;
  const r = spreadFromBed(bed, midflameFeetPerMinute, towardDegrees, slopeTangent, upslopeDegrees);
  const headMetersPerMinute = r.headRateFeetPerMinute * METERS_PER_FOOT;
  if (headMetersPerMinute <= 0) return NO_SPREAD(fuelCode, slopePercent);
  const backMetersPerMinute = Math.max(
    directionalRate(r.headRateFeetPerMinute, r.lengthToBreadth, Math.PI),
    r.noWindRateFeetPerMinute,
  ) * METERS_PER_FOOT;
  return {
    headMetersPerMinute,
    backMetersPerMinute,
    flankMetersPerMinute: (headMetersPerMinute + backMetersPerMinute) / (2 * r.lengthToBreadth),
    lengthToBreadth: r.lengthToBreadth,
    headingDegrees: r.headingDegrees,
    headFlameFeet: r.flameLengthFeet,
    firelineIntensityBtuPerFootPerSecond: r.firelineIntensityBtuPerFootPerSecond,
    fuelCode,
    slopePercent,
    midflameWindMetersPerSecond: (midflameFeetPerMinute / FEET_PER_MINUTE_PER_MPH) * METERS_PER_SECOND_PER_MPH,
  };
}

/** Spread rates cached per (fuel, slope cell, wind hour, moisture): the board's hot path. */
export class SpreadCache {
  private cache = new Map<string, SpreadRates>();
  constructor(
    readonly ground: Ground,
    readonly wind: WindSeries,
  ) {}

  at(p: LonLat, minute: number, moistureId: MoistureId): SpreadRates {
    const fuelCode = this.ground.fuelCodeAt(p);
    const slope = this.ground.slopeAt(p);
    const w = windAt(this.wind, minute);
    const key = `${fuelCode}|${slope.cell}|${w.hourIndex}|${moistureId}`;
    let hit = this.cache.get(key);
    if (!hit) {
      if (this.cache.size > 50_000) this.cache.clear();
      hit = spreadRates(fuelCode, slope.slopeTangent, slope.upslopeDegrees, w, moistureId);
      this.cache.set(key, hit);
    }
    return hit;
  }
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
 * ASSUMPTION (roster): the units on the board and the bases they start from. Counts are a
 * scenario choice: the CAL FIRE layer has no apparatus per base (docs/suppression-data.md,
 * Gaps). One unit of a kind per base, as studio/crewDispatch.ts UNITS_PER_KIND_PER_STATION.
 * - Type 3 engines (the default CAL FIRE state engine, docs/suppression-data.md item 1) at the
 *   nearest CAL FIRE state-owned stations;
 * - Type 1 structure engines at the nearest local-government stations under a Schedule A
 *   agreement (Paradise Fire Department);
 * - Type 1 hand crews from the nearest conservation camp or crew fire centre;
 * - a Type 2 dozer from the nearest CAL FIRE station (dozer bases as studio/crewDispatch.ts).
 */
export const ROSTER: { kind: DemoApparatusKind; count: number; base: "calfire_station" | "local_station" | "crew_camp" }[] = [
  { kind: "engine_t3", count: 6, base: "calfire_station" },
  { kind: "engine_t1", count: 3, base: "local_station" },
  { kind: "hand_crew_t1", count: 2, base: "crew_camp" },
  { kind: "dozer_t2", count: 1, base: "calfire_station" },
];

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
