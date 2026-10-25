/**
 * Aircraft in the Studio's suppression model: helicopters (Type 1/2/3) and airtankers (VLAT,
 * large, S-2T, SEAT) flown from the nearest CAL FIRE helitack and air attack bases, with air
 * attack overhead. Each drop becomes control line on the fire's edge, enforced by the same
 * solver mechanism as ground line (ControlLines in fire/spread.ts). Pure and deterministic.
 * See docs/adr/0048-suppression-engine.md; data and sources in docs/suppression-data.md.
 *
 * Sourced (via suppressionData.generated.ts): capacities (PMS 200 typing minimums; IASG 2017
 * Table 3 airtanker gallons and cruise speeds), line length per load by gallons and coverage
 * level (IASG Table 8) and coverage level by fuel model (IASG Table 7), airtanker reaction
 * time 15 min (PMS 508 p.44), air attack call to takeoff 5 min, flame-length limit 8 ft for
 * retardant or water (PMS 465 pp.171, 174), wind (evaluate at 15 kt, generally not effective
 * at 25 kt or more; IASG p.100), daylight windows (IASG pp.37, 42; PMS 508 p.46).
 *
 * ASSUMPTIONS (each a named constant or a flagged data leaf):
 * - Helicopter and air attack cruise speeds, helicopter call to takeoff, airtanker reload
 *   ground time, the helicopter turnaround formula, the hard flight-stop wind (data leaves).
 * - WIND_EFFECT: between 15 and 25 kt the line a load makes falls linearly to zero.
 * - The 20-ft open wind (the run's weather series at the drop minute, else its single wind)
 *   stands in for the wind at drop height (understates it).
 * - Dip site: the nearest LANDFIRE open-water cell (FBFM40 98) on the board, depth unknown;
 *   with none, the dip is at the 8 km effective limit (data assumption).
 * - Water is treated like retardant: from the drop on it holds flames up to 8 ft, and does
 *   not evaporate. That overstates water; real bucket drops cool an edge for minutes.
 * - Loads below the table's 800 gal row scale linearly from it; a load above 3,000 gal is
 *   dropped as 3,000 gal segments.
 * - Drops go on the attacked fire's own edge at the drop minute (one cell outside it), only
 *   where the flame facing that edge is within 8 ft, from the head when the head is within it,
 *   else from the heel (flanks), and extend alternately along both flanks. Each aircraft flies
 *   for one incident and is released when that fire is out; pilot duty limits are below. No
 *   smoke, visibility, density altitude or fuel cycles; a released aircraft is not re-sent.
 */

import type { LonLat } from "../dispatch/area";
import { groundMeters } from "../dispatch/area";
import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";
import type { ScheduledFireInput, ScheduledFireRun } from "../fire/scheduledTypes";
import type { GeoPoint } from "../fire/spread";
import {
  AIR_KINDS,
  AIR_LABELS,
  KMH_PER_KNOT,
  METERS_PER_FOOT,
  MPH_PER_KNOT,
  andersonModel,
  dataValue,
  type AirKind,
  type ApparatusCounts,
} from "./apparatus";
import { flightWindows, inWindow, nextInWindow, type Window } from "./daylight";
import { outerRing } from "./firefighting";
import { WEATHER_STEP_MINUTES, seriesActive, weatherAtMinute } from "../fire/weatherSeries";

/** A CAL FIRE helitack base (HB) or air attack base (AAB), from tools/ca_fire_bases.json. */
export interface AirBase {
  id: string;
  name: string;
  type: "HB" | "AAB";
  lon: number;
  lat: number;
}

export interface AircraftSpec {
  role: "helicopter" | "airtanker" | "air_attack";
  /** Load per sortie, US gallons; 0 for air attack. */
  gallons: number;
  cruiseKnots: number;
  /** Minutes from the call to takeoff. */
  callToTakeoffMinutes: number;
  base: "HB" | "AAB";
  /** Where the number came from, short. */
  basis: string;
}

const airtankers = dataValue<{ model: string; max_gal: number | number[]; cruise_kt: number }[]>(
  "airtankers.aircraft",
);
function airtanker(model: string) {
  const row = airtankers.find((a) => a.model === model);
  if (!row) throw new Error(`no airtanker ${model} in the data`);
  return { gallons: Array.isArray(row.max_gal) ? row.max_gal[0] : row.max_gal, cruiseKnots: row.cruise_kt };
}
const HELI_CRUISE_KT = dataValue<number>("helicopters.cruise_speed_typical_kt"); // ASSUMPTION
const HELI_TAKEOFF_MIN = dataValue<number>("response_times.helicopter_call_to_takeoff_min"); // ASSUMPTION
const AIRTANKER_REACTION_MIN = dataValue<number>("airtankers.reaction_time_min"); // PMS 508 p.44
const AIR_ATTACK_TAKEOFF_MIN = dataValue<number>("response_times.air_attack_call_to_takeoff_min");
const AIR_ATTACK_CRUISE_KT = dataValue<number>("air_attack.cruise_speed_typical_kt"); // ASSUMPTION
const heliGallons = (t: 1 | 2 | 3) =>
  dataValue<number>(`helicopters.typing.type${t}.water_or_retardant_gal_min`);

export const AIRCRAFT: Record<AirKind, AircraftSpec> = {
  air_attack: {
    role: "air_attack",
    gallons: 0,
    cruiseKnots: AIR_ATTACK_CRUISE_KT,
    callToTakeoffMinutes: AIR_ATTACK_TAKEOFF_MIN,
    base: "AAB",
    basis: "cruise assumed; 5 min call to takeoff",
  },
  airtanker_vlat: {
    role: "airtanker",
    ...airtanker("DC-10"),
    callToTakeoffMinutes: AIRTANKER_REACTION_MIN,
    base: "AAB",
    basis: "IASG Table 3 (DC-10)",
  },
  airtanker_lat: {
    role: "airtanker",
    ...airtanker("C-130"),
    callToTakeoffMinutes: AIRTANKER_REACTION_MIN,
    base: "AAB",
    basis: "IASG Table 3 (C-130)",
  },
  airtanker_s2t: {
    role: "airtanker",
    ...airtanker("S-2 Turbine Tracker (S-2T)"),
    callToTakeoffMinutes: AIRTANKER_REACTION_MIN,
    base: "AAB",
    basis: "IASG Table 3 (S-2T)",
  },
  airtanker_seat: {
    role: "airtanker",
    ...airtanker("Air Tractor AT-802F (SEAT)"),
    callToTakeoffMinutes: AIRTANKER_REACTION_MIN,
    base: "AAB",
    basis: "IASG Table 3 (AT-802F)",
  },
  helicopter_t1: {
    role: "helicopter",
    gallons: heliGallons(1),
    cruiseKnots: HELI_CRUISE_KT,
    callToTakeoffMinutes: HELI_TAKEOFF_MIN,
    base: "HB",
    basis: "PMS 200 Type 1 minimum load; cruise assumed",
  },
  helicopter_t2: {
    role: "helicopter",
    gallons: heliGallons(2),
    cruiseKnots: HELI_CRUISE_KT,
    callToTakeoffMinutes: HELI_TAKEOFF_MIN,
    base: "HB",
    basis: "PMS 200 Type 2 minimum load; cruise assumed",
  },
  helicopter_t3: {
    role: "helicopter",
    gallons: heliGallons(3),
    cruiseKnots: HELI_CRUISE_KT,
    callToTakeoffMinutes: HELI_TAKEOFF_MIN,
    base: "HB",
    basis: "PMS 200 Type 3 minimum load; cruise assumed",
  },
};

// ---- turnaround -------------------------------------------------------------------------

/**
 * ASSUMPTION (data leaf helicopters.dip_turnaround_model): turnaround_min = 2 x (distance to
 * dip / cruise) + 1.5 min hover fill + 0.5 min drop.
 */
export const HELI_HOVER_FILL_MINUTES = 1.5;
export const HELI_DROP_MINUTES = 0.5;
export function helicopterTurnaroundMinutes(dipKm: number, cruiseKnots: number): number {
  const cruiseKmh = cruiseKnots * KMH_PER_KNOT;
  return 2 * ((dipKm / cruiseKmh) * 60) + HELI_HOVER_FILL_MINUTES + HELI_DROP_MINUTES;
}

/** ASSUMPTION (data): airtanker ground time to reload at the base. */
export const AIRTANKER_RELOAD_MINUTES = dataValue<number>("airtankers.reload_ground_time_min");
/** Fly to the reload base, reload, fly back; minutes. */
export function airtankerCycleMinutes(reloadKm: number, cruiseKnots: number): number {
  return 2 * ((reloadKm / (cruiseKnots * KMH_PER_KNOT)) * 60) + AIRTANKER_RELOAD_MINUTES;
}

/** ASSUMPTION (data leaf aviation_constraints.dip_or_reload_distance): dip distance when no water is on the board. */
export const ASSUMED_DIP_KM = dataValue<{ helicopter_dip_max_km_effective: number }>(
  "aviation_constraints.dip_or_reload_distance",
).helicopter_dip_max_km_effective;
/** LANDFIRE FBFM40 NB8: open water. */
export const OPEN_WATER_FUEL_CODE = 98;

/** Nearest open-water cell to `point` on the board, ground km, or null when there is none. */
export function nearestWaterKm(grid: LandscapeGrid, point: LonLat): number | null {
  const [x, y] = lonLatToMercator(point[0], point[1]);
  const cx = (x - grid.originX) / grid.cellSizeX;
  const cy = (y - grid.originY) / grid.cellSizeY;
  let best = Infinity;
  for (let i = 0; i < grid.fuelCodes.length; i += 1) {
    if (grid.fuelCodes[i] !== OPEN_WATER_FUEL_CODE) continue;
    const c = i % grid.width;
    const r = (i - c) / grid.width;
    const d = Math.hypot(c - cx, r - cy);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? (best * grid.groundCellSizeMeters) / 1000 : null;
}

// ---- drop line --------------------------------------------------------------------------

const LINE_TABLE = dataValue<{ columns_coverage_level: number[]; rows: Record<string, number[]> }>(
  "airtankers.line_length_ft_by_gallons_and_coverage",
);
const TABLE_GALLONS = Object.keys(LINE_TABLE.rows)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * IASG 2017 Table 7 coverage level (gal/100 ft2) by Anderson fuel model: 1 for FM1-2, 2 for
 * FM8-9, 3 for FM3, 5, 11, 4 for FM10 (and southern rough, FM7), 6 for FM6 and California
 * chaparral (FM4), >6 (taken as 8, the table's last column) for FM12-13.
 */
export function coverageLevel(andersonFuelModel: number): number {
  switch (andersonFuelModel) {
    case 1:
    case 2:
      return 1;
    case 8:
    case 9:
      return 2;
    case 3:
    case 5:
    case 11:
      return 3;
    case 7:
    case 10:
      return 4;
    case 4:
    case 6:
      return 6;
    default:
      return 8;
  }
}

/**
 * Feet of line one load makes (IASG 2017 Table 8, heavy airtanker), interpolated linearly
 * between gallon rows. Below 800 gal: the 800 gal row scaled by gallons / 800 (ASSUMPTION);
 * above 3,000 gal: whole 3,000 gal segments plus the remainder (ASSUMPTION).
 */
export function lineFeetPerLoad(gallons: number, coverage: number): number {
  const col = LINE_TABLE.columns_coverage_level.indexOf(coverage);
  if (col < 0 || gallons <= 0) return 0;
  const at = (g: number) => LINE_TABLE.rows[String(g)][col];
  const min = TABLE_GALLONS[0];
  const max = TABLE_GALLONS[TABLE_GALLONS.length - 1];
  if (gallons < min) return (at(min) * gallons) / min;
  if (gallons > max) {
    const whole = Math.floor(gallons / max);
    const rest = gallons - whole * max;
    return whole * at(max) + (rest > 0 ? lineFeetPerLoad(rest, coverage) : 0);
  }
  for (let i = 1; i < TABLE_GALLONS.length; i += 1) {
    const g0 = TABLE_GALLONS[i - 1];
    const g1 = TABLE_GALLONS[i];
    if (gallons <= g1) return at(g0) + ((at(g1) - at(g0)) * (gallons - g0)) / (g1 - g0);
  }
  return at(max);
}

// ---- gating -----------------------------------------------------------------------------

const WIND = dataValue<{ evaluate_at: number; generally_not_effective_at_or_above: number }>(
  "aviation_constraints.wind_drop_effectiveness_kt",
);
/** IASG 2017 p.100: evaluate drops at this wind, knots. */
export const WIND_EVALUATE_KT = WIND.evaluate_at;
/** IASG 2017 p.100: drops generally not effective at or above this wind, knots. */
export const WIND_INEFFECTIVE_KT = WIND.generally_not_effective_at_or_above;
/** ASSUMPTION (data): no flights at all at or above this wind, knots. */
export const HARD_FLIGHT_WIND_KT = dataValue<number>("aviation_constraints.hard_flight_wind_limit_kt");
/** PMS 465 pp.171, 174: retardant or water does not hold above this flame length, feet. */
export const DROP_HOLDS_FLAME_FEET = dataValue<number>("aviation_constraints.flame_length_limit_ft");

/**
 * Share of a load's table line that holds at this wind: 1 below 15 kt, 0 at 25 kt or more,
 * linear between (ASSUMPTION: the sources give the two thresholds, not the shape).
 */
export function windEffect(windKnots: number): number {
  if (windKnots < WIND_EVALUATE_KT) return 1;
  if (windKnots >= WIND_INEFFECTIVE_KT) return 0;
  return 1 - (windKnots - WIND_EVALUATE_KT) / (WIND_INEFFECTIVE_KT - WIND_EVALUATE_KT);
}

const FIXED_WING = dataValue<{ before_sunrise: number; after_sunset: number }>(
  "aviation_constraints.daylight_flight_limit_single_engine_fixed_wing_min",
);
const HELI_DAYLIGHT = dataValue<{ before_sunrise: number; after_sunset: number }>(
  "aviation_constraints.helicopter_daylight_limit_min",
);

/**
 * Flight windows by role. Fixed wing with air attack on scene and helicopters: 30 min before
 * sunrise to 30 min after sunset (IASG p.42; PMS 508 p.46). Airtankers with no aerial
 * supervision on scene: not before 30 min after sunrise, not after 30 min before sunset (IASG
 * p.37). Night helicopters only when flagged (S-70i-capable base; the data cannot place one).
 */
export function aviationWindows(
  startMs: number,
  horizonMinutes: number,
  point: LonLat,
): { supervised: Window[]; unsupervised: Window[]; helicopter: Window[] } {
  const end = startMs + horizonMinutes * 60_000;
  const [lon, lat] = point;
  return {
    supervised: flightWindows(startMs, end, lat, lon, -FIXED_WING.before_sunrise, FIXED_WING.after_sunset),
    unsupervised: flightWindows(startMs, end, lat, lon, FIXED_WING.before_sunrise, -FIXED_WING.after_sunset),
    helicopter: flightWindows(startMs, end, lat, lon, -HELI_DAYLIGHT.before_sunrise, HELI_DAYLIGHT.after_sunset),
  };
}

// ---- duty limits ------------------------------------------------------------------------

/**
 * Pilot flight and duty limits, Interagency Standards for Fire and Fire Aviation Operations
 * (NFES 2724, "Red Book") ch. 16, aviation pilot flight and duty limitations, which the
 * Interagency Helicopter Operations Guide (NWCG PMS 510) and the airtanker contracts follow: at
 * most 8 h of flight time and a 14 h duty day, then at least 10 h of rest. As recalled, not
 * re-fetched (edition not confirmed). One pilot crew per aircraft (ASSUMPTION: no relief crew).
 */
export const PILOT_MAX_FLIGHT_MINUTES_PER_DAY = 8 * 60;
export const PILOT_MAX_DUTY_DAY_MINUTES = 14 * 60;
export const PILOT_MIN_REST_MINUTES = 10 * 60;
/**
 * ASSUMPTION: drop line with no ground line tied in on that fire by this long after the drop does
 * not count as held line. Water from a bucket cools an edge for minutes; long-term retardant keeps
 * working after it dries but is laid to be tied into by ground forces (IASG 2017 ch. 7 tactics:
 * aerial retardant "slows" the fire for ground forces). The solver's control line cannot expire,
 * so an untied drop is dropped from the line instead (docs/response-model.md, "Aircraft").
 */
export const WATER_TIE_IN_MINUTES = 30;
export const RETARDANT_TIE_IN_MINUTES = 120;

// ---- plan -------------------------------------------------------------------------------

export interface Drop {
  aircraft: number;
  minute: number;
  gallons: number;
  /** Ground metres of line this load made (after the wind effect at the drop minute). */
  lineMeters: number;
  /** "retardant" for airtankers, "water" for helicopters. */
  agent: "retardant" | "water";
  /** Run source id of the incident (fire) it was dropped on. */
  sourceId?: string;
  /** Open wind at the drop minute (weather series when the run has one), knots, and its effect. */
  windKnots?: number;
  windEffect?: number;
  /**
   * True when ground units work this fire's edge within WATER_/RETARDANT_TIE_IN_MINUTES of the
   * drop: only then does its line count as held line in the solver.
   */
  tiedIn?: boolean;
}

export interface AircraftSorties {
  kind: AirKind;
  label: string;
  baseName: string | null;
  /** Straight-line distance base to fire, km. */
  baseKm: number | null;
  /** Minute over the fire, or null when it never gets there. */
  overFireMinute: number | null;
  /** Minutes per load cycle (turnaround or reload round trip). */
  cycleMinutes: number | null;
  /** Counted from `AircraftPlan.drops` (one source of truth). */
  drops: number;
  gallons: number;
  lineMeters: number;
  /** Why it made no or fewer drops (night, wind, duty, released, no base data), or null. */
  limitedBy: string | null;
  /** Incident it flew for, and the minute it was released (fire out), when it was. */
  sourceId?: string;
  releasedMinute?: number | null;
  /** Flight minutes flown over the run (duty limit bookkeeping). */
  flightMinutes?: number;
}

export interface AircraftPlan {
  aircraft: AircraftSorties[];
  drops: Drop[];
  /** Held line cells (tied-in drops only) with the minute each is laid, and the aircraft that laid it. */
  cells: Int32Array;
  holdFromMinute: Float32Array;
  aircraftIndex: Int16Array;
  /** Base open wind (the run's `windSpeedMph`), knots, and its effect; per-drop values are on `drops`. */
  windKnots: number;
  windEffect: number;
  /** Dip distance used, km, and whether it was measured on the board (first incident). */
  dipKm: number;
  dipMeasured: boolean;
  notes: string[];
}

/** One incident's air order (studio/incidents.ts). */
export interface AirIncident {
  sourceId: string;
  location: LonLat;
  reportMinute: number;
  aircraft: { kind: string; baseId: string; baseName: string; location: LonLat }[];
}

/** What the ground initial attack did on each fire (studio/initialAttack.ts), by source id. */
export interface AirGroundState {
  /** Minute the fire is out (aircraft released), or null. */
  outMinute: number | null;
  /** First minute a ground unit built line on its edge, or null. */
  groundLineFromMinute: number | null;
  /**
   * False when the ground units cannot catch this fire even with its drops holding
   * (studio/firefighting.ts, air-supported initial attack): no ground line ties in, so none of
   * its drops count as held line. Absent: true.
   */
  holdsDrops?: boolean;
}

export interface AircraftInputs {
  grid: LandscapeGrid;
  input: ScheduledFireInput;
  baseline: ScheduledFireRun;
  counts: ApparatusCounts;
  bases: readonly AirBase[] | null;
  /** Minute the first fire is reported (`fire`, else the first ignition); used when `incidents` is absent. */
  reportMinute: number;
  /** The fire reported first, where the aircraft fly; absent = the first ignition. */
  fire?: GeoPoint;
  /** T+0 as UTC epoch ms (from the scenario clock). */
  startMs: number;
  nightHelicopters: boolean;
  /** One incident per ignition with its own aircraft; absent: the first fire gets `counts`. */
  incidents?: readonly AirIncident[] | null;
  /** Ground initial attack per source id; absent: aircraft fly to the horizon, drops all held. */
  ground?: Readonly<Record<string, AirGroundState>> | null;
}

function nearestBase(bases: readonly AirBase[], type: "HB" | "AAB", point: LonLat) {
  let best: { base: AirBase; km: number } | null = null;
  for (const base of bases) {
    if (base.type !== type) continue;
    const km = groundMeters([base.lon, base.lat], point) / 1000;
    if (!best || km < best.km || (km === best.km && base.id < best.base.id)) best = { base, km };
  }
  return best;
}

/** Ring cells on each side of the anchor bearing, ordered by angle away from it. */
function ringSides(grid: LandscapeGrid, ring: Uint8Array, anchorDegrees: number, allowed: (cell: number) => boolean) {
  const { width } = grid;
  const cells: number[] = [];
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    if (!ring[i]) continue;
    cells.push(i);
    sx += i % width;
    sy += Math.floor(i / width);
  }
  const cx = sx / Math.max(1, cells.length);
  const cy = sy / Math.max(1, cells.length);
  const anchor = (anchorDegrees * Math.PI) / 180;
  const sides: [number, number][][] = [[], []];
  for (const c of cells) {
    if (!allowed(c)) continue;
    let d = Math.atan2((c % width) - cx, -(Math.floor(c / width) - cy)) - anchor;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    if (d >= 0) sides[0].push([d, c]);
    else sides[1].push([-d, c]);
  }
  for (const side of sides) side.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return sides;
}

/**
 * Plan every aircraft's sorties and the line its drops make, per incident. Deterministic.
 *
 * - Each aircraft flies for the incident it was sent to, from its own base, after that fire's
 *   report; it is released when the ground initial attack puts that fire out (no more sorties).
 * - Pilot duty: at most PILOT_MAX_FLIGHT_MINUTES_PER_DAY of flight and PILOT_MAX_DUTY_DAY_MINUTES
 *   on duty, then PILOT_MIN_REST_MINUTES of rest before it flies again. Helicopter turnaround and
 *   the airtanker's round trip count as flight; the reload ground time does not. Fuel cycles are
 *   not modelled (no sourced endurance in the data).
 * - Wind at each drop is the run's weather series at that minute (fire/weatherSeries.ts), else the
 *   run's single wind: no flight at or above HARD_FLIGHT_WIND_KT, and the line per load scaled
 *   by `windEffect`.
 * - Line goes on the attacked fire's own edge at the drop minute (one cell outside it), only next
 *   to burning cells whose head flame (the solver's per-cell value, when the baseline carries
 *   `cellBehaviour`) is within DROP_HOLDS_FLAME_FEET and that do not crown: retardant is not laid
 *   where it cannot hold. From the head when the head is within that limit, else from the heel.
 */
export function planAircraft(inputs: AircraftInputs): AircraftPlan {
  const { grid, input, baseline, counts, bases, startMs, nightHelicopters } = inputs;
  const horizon = input.settings.horizonMinutes;
  const series = seriesActive(input.settings.weatherSeries) ? input.settings.weatherSeries : null;
  const windKnotsAt = (minute: number) =>
    (series ? weatherAtMinute(series, minute).windSpeedMph : input.settings.windSpeedMph) / MPH_PER_KNOT;
  const windFromAt = (minute: number) =>
    series ? weatherAtMinute(series, minute).windFromDegrees : input.settings.windFromDegrees;
  const baseKnots = input.settings.windSpeedMph / MPH_PER_KNOT;
  const notes: string[] = [];
  const toMinute = (ms: number) => (ms - startMs) / 60_000;
  const toMs = (minute: number) => startMs + minute * 60_000;
  const sourceIndex = new Map(input.sources.map((s, i) => [s.id, i]));

  // Incidents: as given, or the first fire with the run's counts (older callers).
  const earliest = [...input.sources].sort((a, b) => a.startMinute - b.startMinute)[0];
  const target = inputs.fire;
  const first = target
    ? (input.sources.find(
        (s) => s.location.latitude === target.latitude && s.location.longitude === target.longitude,
      ) ?? earliest)
    : earliest;
  const incidents: AirIncident[] = inputs.incidents
    ? [...inputs.incidents]
    : first
      ? [
          {
            sourceId: first.id,
            location: [first.location.longitude, first.location.latitude],
            reportMinute: inputs.reportMinute,
            aircraft: AIR_KINDS.flatMap((kind) =>
              Array.from({ length: Math.max(0, Math.floor(counts[kind] ?? 0)) }, () => ({
                kind,
                baseId: "",
                baseName: "",
                location: [Number.NaN, Number.NaN] as LonLat,
              })),
            ),
          },
        ]
      : [];
  const firstFire: LonLat = incidents[0]?.location ?? [0, 0];
  const firstWater = nearestWaterKm(grid, firstFire);
  const empty = (): AircraftPlan => ({
    aircraft: [],
    drops: [],
    cells: new Int32Array(0),
    holdFromMinute: new Float32Array(0),
    aircraftIndex: new Int16Array(0),
    windKnots: baseKnots,
    windEffect: windEffect(baseKnots),
    dipKm: firstWater ?? ASSUMED_DIP_KM,
    dipMeasured: firstWater !== null,
    notes,
  });
  if (incidents.every((i) => i.aircraft.length === 0)) return empty();

  const sortiesOut: AircraftSorties[] = [];
  const drops: Drop[] = [];
  const ordinal: Partial<Record<AirKind, number>> = {};
  const behaviour = baseline.cellBehaviour ?? null;
  const flameOf = (cell: number) =>
    behaviour ? (behaviour.crownType[cell] !== 0 ? Number.POSITIVE_INFINITY : behaviour.headFlameFeet[cell]) : Number.NaN;
  let anyHelicopterNoWater = false;

  for (const incident of incidents) {
    const s = sourceIndex.get(incident.sourceId);
    const outcome = s !== undefined ? baseline.ignitions[s].outcome : null;
    const fire = incident.location;
    const ground = inputs.ground?.[incident.sourceId] ?? null;
    const release = ground?.outMinute ?? Number.POSITIVE_INFINITY;
    const waterKm = nearestWaterKm(grid, fire);
    const dipKm = waterKm ?? ASSUMED_DIP_KM;
    const windows = aviationWindows(startMs, horizon, fire);
    const specs = incident.aircraft
      .filter((a): a is typeof a & { kind: AirKind } => (AIR_KINDS as readonly string[]).includes(a.kind))
      .map((a) => {
        const kind = a.kind;
        ordinal[kind] = (ordinal[kind] ?? 0) + 1;
        const spec = AIRCRAFT[kind];
        const given = Number.isFinite(a.location[0]) && Number.isFinite(a.location[1]);
        const found = given
          ? {
              base: { id: a.baseId, name: a.baseName, type: spec.base, lon: a.location[0], lat: a.location[1] } as AirBase,
              km: groundMeters(a.location, fire) / 1000,
            }
          : bases
            ? nearestBase(bases, spec.base, fire)
            : null;
        return { kind, spec, found, label: `${AIR_LABELS[kind]} ${ordinal[kind]}`, missingData: !given && !bases };
      });
    // Air attack over this fire from its earliest air-attack arrival widens the fixed-wing window.
    let supervisedFrom = Infinity;
    for (const { spec, found } of specs) {
      if (spec.role !== "air_attack" || !found) continue;
      const over = incident.reportMinute + spec.callToTakeoffMinutes + (found.km / (spec.cruiseKnots * KMH_PER_KNOT)) * 60;
      supervisedFrom = Math.min(supervisedFrom, over);
    }

    for (const { kind, spec, found, label, missingData } of specs) {
      const index = sortiesOut.length;
      const row: AircraftSorties = {
        kind,
        label,
        baseName: found?.base.name ?? null,
        baseKm: found ? Math.round(found.km * 10) / 10 : null,
        overFireMinute: null,
        cycleMinutes: null,
        drops: 0,
        gallons: 0,
        lineMeters: 0,
        limitedBy: null,
        sourceId: incident.sourceId,
        releasedMinute: null,
        flightMinutes: 0,
      };
      sortiesOut.push(row);
      if (!found) {
        row.limitedBy = missingData
          ? "no base data (tools/ca_fire_bases.json is local-only)"
          : `no ${spec.base === "HB" ? "helitack" : "air attack"} base in range`;
        continue;
      }
      if (outcome && outcome.status !== "ignited") {
        row.limitedBy = "its fire was reached by another fire before it started";
        continue;
      }
      const cruiseKmh = spec.cruiseKnots * KMH_PER_KNOT;
      const flightMinutes = (found.km / cruiseKmh) * 60;
      const helicopter = spec.role === "helicopter";
      const windowsFor = (minute: number) =>
        helicopter
          ? nightHelicopters
            ? null
            : windows.helicopter
          : minute >= supervisedFrom
            ? windows.supervised
            : windows.unsupervised;
      // Helicopters fill at the dip before the first drop; airtankers arrive loaded.
      const cycle = helicopter
        ? helicopterTurnaroundMinutes(dipKm, spec.cruiseKnots)
        : airtankerCycleMinutes(found.km, spec.cruiseKnots);
      const cycleFlight = helicopter ? cycle : cycle - AIRTANKER_RELOAD_MINUTES;
      if (spec.role !== "air_attack") row.cycleMinutes = Math.round(cycle * 10) / 10;
      if (helicopter && waterKm === null) anyHelicopterNoWater = true;

      /** Takeoff at or after `minute` inside a flight window and below the hard wind limit; null if none. */
      const takeoffFrom = (minute: number): number | null => {
        let m = minute;
        for (let guard = 0; guard < 1000 && m <= horizon; guard += 1) {
          const w = windowsFor(m);
          const ms = w ? nextInWindow(w, toMs(m)) : toMs(m);
          if (ms === null) return null;
          m = toMinute(ms);
          if (m > horizon) return null;
          if (windKnotsAt(m) < HARD_FLIGHT_WIND_KT) return m;
          m += WEATHER_STEP_MINUTES;
        }
        return null;
      };
      let limited: string[] = [];
      const limit = (why: string) => {
        if (!limited.includes(why)) limited.push(why);
      };
      let takeoff = takeoffFrom(incident.reportMinute + spec.callToTakeoffMinutes);
      if (takeoff === null) {
        row.limitedBy =
          windKnotsAt(incident.reportMinute) >= HARD_FLIGHT_WIND_KT
            ? `wind at or above the ${HARD_FLIGHT_WIND_KT} kt flight limit (assumed)`
            : "night: outside the flight window for the whole run";
        continue;
      }
      if (takeoff >= release) {
        row.limitedBy = "released: the fire was out before it took off";
        row.releasedMinute = release;
        continue;
      }
      row.overFireMinute = takeoff + flightMinutes;
      if (spec.role === "air_attack") continue;

      let dutyStart = takeoff;
      let flown = flightMinutes;
      let minute = row.overFireMinute + (helicopter ? cycle : 0);
      while (minute <= horizon) {
        if (minute > release) {
          row.releasedMinute = release;
          limit("released when its fire was out");
          break;
        }
        const w = windowsFor(minute);
        if (w && !inWindow(w, toMs(minute))) {
          // Grounded at the base until the next window; the night counts as rest.
          limit("night: grounded outside the flight window");
          const next = takeoffFrom(minute);
          if (next === null) break;
          if (next - minute >= PILOT_MIN_REST_MINUTES) {
            dutyStart = next;
            flown = 0;
          }
          flown += flightMinutes;
          minute = next + flightMinutes + (helicopter ? cycle : 0);
          continue;
        }
        const knots = windKnotsAt(minute);
        const effect = windEffect(knots);
        if (knots >= HARD_FLIGHT_WIND_KT || effect <= 0) {
          limit(
            knots >= HARD_FLIGHT_WIND_KT
              ? `wind at or above the ${HARD_FLIGHT_WIND_KT} kt flight limit (assumed)`
              : `wind: drops generally not effective at ${WIND_INEFFECTIVE_KT} kt or more`,
          );
          minute += WEATHER_STEP_MINUTES;
          continue;
        }
        // Duty: this load and the flight home must fit the day's flight time and duty day.
        if (flown + cycleFlight + flightMinutes > PILOT_MAX_FLIGHT_MINUTES_PER_DAY || minute + flightMinutes - dutyStart > PILOT_MAX_DUTY_DAY_MINUTES) {
          limit("pilot duty limit (8 h flight, 14 h duty day; then 10 h rest)");
          const back = takeoffFrom(Math.max(minute + flightMinutes, dutyStart) + PILOT_MIN_REST_MINUTES);
          if (back === null) break;
          dutyStart = back;
          flown = flightMinutes;
          minute = back + flightMinutes + (helicopter ? cycle : 0);
          continue;
        }
        drops.push({
          aircraft: index,
          minute,
          gallons: spec.gallons,
          lineMeters: 0,
          agent: helicopter ? "water" : "retardant",
          sourceId: incident.sourceId,
          windKnots: Math.round(knots * 10) / 10,
          windEffect: effect,
          tiedIn: false,
        });
        flown += cycleFlight;
        minute += cycle;
      }
      row.flightMinutes = Math.round(flown);
      row.limitedBy = limited.length > 0 ? limited.join("; ") : null;
      limited = [];
    }
  }

  // Lay the line, incident by incident: drops in time order on that fire's own edge.
  drops.sort((a, b) => a.minute - b.minute || a.aircraft - b.aircraft);
  const cellSize = grid.groundCellSizeMeters;
  const cells: number[] = [];
  const holds: number[] = [];
  const owners: number[] = [];
  const taken = new Set<number>();
  const { width, height } = grid;
  for (const incident of incidents) {
    const s = sourceIndex.get(incident.sourceId);
    if (s === undefined) continue;
    const mine = drops.filter((d) => d.sourceId === incident.sourceId);
    if (mine.length === 0) continue;
    // This fire's cells only: another fire's edge is not this incident's line.
    const own = new Float32Array(baseline.arrivalMinutes.length).fill(Number.POSITIVE_INFINITY);
    for (let i = 0; i < own.length; i += 1) if (baseline.sourceIndexByCell[i] === s) own[i] = baseline.arrivalMinutes[i];
    const ground = inputs.ground?.[incident.sourceId] ?? null;
    const ignition = baseline.ignitions[s];
    const crowning = ignition.conditions.crown != null && ignition.conditions.crown.type !== "surface";
    const ignitionFlame = crowning ? Infinity : ignition.conditions.spread.flameLengthFeet;
    /** Longest flame facing ring cell `c` from this fire's burning neighbours at `minute`. */
    const facing = (c: number, minute: number) => {
      if (!behaviour) return ignitionFlame;
      const x0 = c % width;
      const y0 = (c - x0) / width;
      let max = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = x0 + dx;
          const y = y0 + dy;
          if ((dx === 0 && dy === 0) || x < 0 || y < 0 || x >= width || y >= height) continue;
          const n = y * width + x;
          if (own[n] <= minute) max = Math.max(max, flameOf(n));
        }
      }
      return max;
    };
    const rings = new Map<number, [number, number][][]>();
    const covered = [0, 0];
    let heldNote = false;
    mine.forEach((drop, k) => {
      const ringMinute = Math.floor(drop.minute);
      let sides = rings.get(ringMinute);
      if (!sides) {
        const ring = outerRing(grid, own, ringMinute);
        // Head flame now: the longest flame facing any ring cell.
        let head = 0;
        for (let i = 0; i < ring.length; i += 1) if (ring[i]) head = Math.max(head, facing(i, ringMinute));
        const fromHead = head <= DROP_HOLDS_FLAME_FEET;
        const windFrom = windFromAt(ringMinute);
        const anchor = fromHead ? (windFrom + 180) % 360 : windFrom;
        sides = ringSides(grid, ring, anchor, (c) => facing(c, ringMinute) <= DROP_HOLDS_FLAME_FEET);
        rings.set(ringMinute, sides);
        if (!heldNote && !fromHead) {
          heldNote = true;
          notes.push(
            `${incident.sourceId}: head flame ${Number.isFinite(head) ? `${head.toFixed(0)} ft` : "crowning"} at T+${ringMinute} is beyond the ${DROP_HOLDS_FLAME_FEET} ft retardant limit; drops go only where the flame facing the edge is within it.`,
          );
        }
      }
      const side = k % 2;
      const list = sides[side];
      let start = list.findIndex(([angle, c]) => angle >= covered[side] && !taken.has(c));
      if (start < 0) start = list.findIndex(([, c]) => !taken.has(c));
      if (start < 0) return;
      const model = andersonModel(grid.fuelCodes[list[start][1]]) ?? 1;
      const target = lineFeetPerLoad(drop.gallons, coverageLevel(model)) * METERS_PER_FOOT * (drop.windEffect ?? 1);
      const tieIn = drop.agent === "water" ? WATER_TIE_IN_MINUTES : RETARDANT_TIE_IN_MINUTES;
      drop.tiedIn = inputs.ground
        ? ground !== null &&
          ground.holdsDrops !== false &&
          ground.groundLineFromMinute !== null &&
          ground.groundLineFromMinute <= drop.minute + tieIn
        : true;
      let laid = 0;
      let previous: number | null = null;
      for (let j = start; j < list.length && laid < target; j += 1) {
        const c = list[j][1];
        if (taken.has(c)) continue;
        const step =
          previous === null
            ? cellSize
            : Math.min(
                Math.SQRT2 * cellSize,
                Math.hypot((c % width) - (previous % width), Math.floor(c / width) - Math.floor(previous / width)) * cellSize,
              );
        laid += step;
        previous = c;
        taken.add(c);
        if (drop.tiedIn) {
          cells.push(c);
          holds.push(drop.minute);
          owners.push(drop.aircraft);
        }
        covered[side] = list[j][0];
      }
      drop.lineMeters = laid;
    });
  }
  // One source of truth: each aircraft's row is counted from the drops it made.
  for (const drop of drops) {
    const row = sortiesOut[drop.aircraft];
    row.drops += 1;
    row.gallons += drop.gallons;
    row.lineMeters += drop.lineMeters;
  }
  const untied = drops.filter((d) => d.tiedIn === false && d.lineMeters > 0).length;
  if (untied > 0) {
    notes.push(
      `${untied} of ${drops.length} drops had no ground line tied in within ${WATER_TIE_IN_MINUTES} min (water) or ${RETARDANT_TIE_IN_MINUTES} min (retardant): flown, not counted as held line (assumption).`,
    );
  }
  const unlaid = drops.filter((d) => d.lineMeters <= 0).length;
  if (unlaid > 0) {
    notes.push(
      `${unlaid} of ${drops.length} drops found no edge cell left within the ${DROP_HOLDS_FLAME_FEET} ft limit on their fire's ring: flown, no line laid.`,
    );
  }
  if (anyHelicopterNoWater) {
    notes.push(`No open water on the board; helicopter dip assumed ${ASSUMED_DIP_KM} km away.`);
  }
  return {
    aircraft: sortiesOut,
    drops,
    cells: Int32Array.from(cells),
    holdFromMinute: Float32Array.from(holds),
    aircraftIndex: Int16Array.from(owners),
    windKnots: baseKnots,
    windEffect: windEffect(baseKnots),
    dipKm: firstWater ?? ASSUMED_DIP_KM,
    dipMeasured: firstWater !== null,
    notes,
  };
}
