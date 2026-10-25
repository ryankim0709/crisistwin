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
 * - The scenario's 20-ft open wind stands in for the wind at drop height (understates it).
 * - Dip site: the nearest LANDFIRE open-water cell (FBFM40 98) on the board, depth unknown;
 *   with none, the dip is at the 8 km effective limit (data assumption).
 * - Water is treated like retardant: from the drop on it holds flames up to 8 ft, and does
 *   not evaporate. That overstates water; real bucket drops cool an edge for minutes.
 * - Loads below the table's 800 gal row scale linearly from it; a load above 3,000 gal is
 *   dropped as 3,000 gal segments.
 * - Drops go on the unsuppressed fire's edge at the drop minute (one cell outside it), from
 *   the head when the ignition's head flame is within 8 ft, else from the heel (flanks), and
 *   extend alternately along both flanks. No smoke, visibility, density altitude, duty
 *   limits, fuel cycles or competing fires.
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

// ---- plan -------------------------------------------------------------------------------

export interface Drop {
  aircraft: number;
  minute: number;
  gallons: number;
  /** Ground metres of line this load made (after the wind effect). */
  lineMeters: number;
  /** "retardant" for airtankers, "water" for helicopters. */
  agent: "retardant" | "water";
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
  drops: number;
  gallons: number;
  lineMeters: number;
  /** Why it made no or fewer drops (night, wind, no base data), or null. */
  limitedBy: string | null;
}

export interface AircraftPlan {
  aircraft: AircraftSorties[];
  drops: Drop[];
  /** Line cells with the minute each is laid, and the aircraft that laid it. */
  cells: Int32Array;
  holdFromMinute: Float32Array;
  aircraftIndex: Int16Array;
  windKnots: number;
  windEffect: number;
  /** Dip distance used, km, and whether it was measured on the board. */
  dipKm: number;
  dipMeasured: boolean;
  notes: string[];
}

export interface AircraftInputs {
  grid: LandscapeGrid;
  input: ScheduledFireInput;
  baseline: ScheduledFireRun;
  counts: ApparatusCounts;
  bases: readonly AirBase[] | null;
  /** Minute the fire is reported (the first fire reported). */
  reportMinute: number;
  /** The fire reported first, where the aircraft fly; absent = the first ignition. */
  fire?: GeoPoint;
  /** T+0 as UTC epoch ms (from the scenario clock). */
  startMs: number;
  nightHelicopters: boolean;
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
function ringSides(grid: LandscapeGrid, ring: Uint8Array, anchorDegrees: number) {
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
    let d = Math.atan2((c % width) - cx, -(Math.floor(c / width) - cy)) - anchor;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    if (d >= 0) sides[0].push([d, c]);
    else sides[1].push([-d, c]);
  }
  for (const side of sides) side.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return sides;
}

/** Plan every aircraft's sorties and the line its drops make. Deterministic. */
export function planAircraft(inputs: AircraftInputs): AircraftPlan {
  const { grid, input, baseline, counts, bases, reportMinute, startMs, nightHelicopters } = inputs;
  const horizon = input.settings.horizonMinutes;
  const target = inputs.fire ?? [...input.sources].sort((a, b) => a.startMinute - b.startMinute)[0].location;
  const fire: LonLat = [target.longitude, target.latitude];
  const windKnots = input.settings.windSpeedMph / MPH_PER_KNOT;
  const effect = windEffect(windKnots);
  const notes: string[] = [];
  const waterKm = nearestWaterKm(grid, fire);
  const dipKm = waterKm ?? ASSUMED_DIP_KM;
  const windows = aviationWindows(startMs, horizon, fire);
  const toMinute = (ms: number) => (ms - startMs) / 60_000;
  const toMs = (minute: number) => startMs + minute * 60_000;

  const kinds: AirKind[] = [];
  for (const kind of AIR_KINDS) {
    for (let i = 0; i < Math.max(0, Math.floor(counts[kind] ?? 0)); i += 1) kinds.push(kind);
  }
  const empty = (): AircraftPlan => ({
    aircraft: [],
    drops: [],
    cells: new Int32Array(0),
    holdFromMinute: new Float32Array(0),
    aircraftIndex: new Int16Array(0),
    windKnots,
    windEffect: effect,
    dipKm,
    dipMeasured: waterKm !== null,
    notes,
  });
  if (kinds.length === 0) return empty();

  // Air attack on scene from the earliest air-attack arrival; it widens the fixed-wing window.
  const sortiesOut: AircraftSorties[] = [];
  const drops: Drop[] = [];
  let supervisedFrom = Infinity;
  const ordinal: Partial<Record<AirKind, number>> = {};
  const specs = kinds.map((kind) => {
    ordinal[kind] = (ordinal[kind] ?? 0) + 1;
    const spec = AIRCRAFT[kind];
    const found = bases ? nearestBase(bases, spec.base, fire) : null;
    return { kind, spec, found, label: `${AIR_LABELS[kind]} ${ordinal[kind]}` };
  });
  for (const { spec, found } of specs) {
    if (spec.role !== "air_attack" || !found) continue;
    const over =
      reportMinute + spec.callToTakeoffMinutes + (found.km / (spec.cruiseKnots * KMH_PER_KNOT)) * 60;
    supervisedFrom = Math.min(supervisedFrom, over);
  }

  specs.forEach(({ kind, spec, found, label }, index) => {
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
    };
    sortiesOut.push(row);
    if (!found) {
      row.limitedBy = bases
        ? `no ${spec.base === "HB" ? "helitack" : "air attack"} base in range`
        : "no base data (tools/ca_fire_bases.json is local-only)";
      return;
    }
    if (windKnots >= HARD_FLIGHT_WIND_KT) {
      row.limitedBy = `wind ${windKnots.toFixed(0)} kt at or above the ${HARD_FLIGHT_WIND_KT} kt flight limit (assumed)`;
      return;
    }
    const cruiseKmh = spec.cruiseKnots * KMH_PER_KNOT;
    const flightMinutes = (found.km / cruiseKmh) * 60;
    const helicopter = spec.role === "helicopter";
    // Takeoff waits for the flight window; over the fire after the flight.
    const windowsFor = (minute: number) =>
      helicopter
        ? nightHelicopters
          ? null
          : windows.helicopter
        : minute >= supervisedFrom
          ? windows.supervised
          : windows.unsupervised;
    const takeoffMinute = reportMinute + spec.callToTakeoffMinutes;
    const takeoffWindows = windowsFor(takeoffMinute);
    const takeoffMs = takeoffWindows ? nextInWindow(takeoffWindows, toMs(takeoffMinute)) : toMs(takeoffMinute);
    if (takeoffMs === null || toMinute(takeoffMs) > horizon) {
      row.limitedBy = "night: outside the flight window for the whole run";
      return;
    }
    row.overFireMinute = toMinute(takeoffMs) + flightMinutes;
    if (spec.role === "air_attack") return;
    if (effect <= 0) {
      row.limitedBy = `wind ${windKnots.toFixed(0)} kt: drops generally not effective at ${WIND_INEFFECTIVE_KT} kt or more`;
      return;
    }
    // Helicopters fill at the dip before the first drop; airtankers arrive loaded.
    const cycle = helicopter
      ? helicopterTurnaroundMinutes(dipKm, spec.cruiseKnots)
      : airtankerCycleMinutes(found.km, spec.cruiseKnots);
    row.cycleMinutes = Math.round(cycle * 10) / 10;
    let minute = row.overFireMinute + (helicopter ? cycle : 0);
    let stoppedByNight = false;
    while (minute <= horizon) {
      const w = windowsFor(minute);
      if (w && !inWindow(w, toMs(minute))) {
        // Grounded until the next window; the next load leaves then (cycle again).
        const next = nextInWindow(w, toMs(minute));
        stoppedByNight = true;
        if (next === null) break;
        minute = toMinute(next) + cycle;
        continue;
      }
      drops.push({
        aircraft: index,
        minute,
        gallons: spec.gallons,
        lineMeters: 0,
        agent: helicopter ? "water" : "retardant",
      });
      minute += cycle;
    }
    if (stoppedByNight) row.limitedBy = "night: grounded outside the flight window";
  });

  // Lay the line: drops in time order, alternating flanks from the anchor.
  drops.sort((a, b) => a.minute - b.minute || a.aircraft - b.aircraft);
  const ignition = baseline.ignitions.find((i) => i.outcome.status === "ignited") ?? baseline.ignitions[0];
  const crowning = ignition?.conditions.crown != null && ignition.conditions.crown.type !== "surface";
  const headFlame = ignition ? ignition.conditions.spread.flameLengthFeet : Infinity;
  const fromHead = !crowning && headFlame <= DROP_HOLDS_FLAME_FEET;
  const windFrom = input.settings.windFromDegrees;
  const anchor = fromHead ? (windFrom + 180) % 360 : windFrom;
  notes.push(
    fromHead
      ? "Drops start at the head (head flame within 8 ft) and extend along both flanks."
      : `Drops work the flanks from the heel: head flame ${Number.isFinite(headFlame) ? `${headFlame.toFixed(0)} ft` : "crowning"} is beyond the 8 ft retardant limit.`,
  );
  const cellSize = grid.groundCellSizeMeters;
  const covered = [0, 0];
  const rings = new Map<number, [number, number][][]>();
  const cells: number[] = [];
  const holds: number[] = [];
  const owners: number[] = [];
  const taken = new Set<number>();
  drops.forEach((drop, k) => {
    const ringMinute = Math.floor(drop.minute);
    let sides = rings.get(ringMinute);
    if (!sides) {
      sides = ringSides(grid, outerRing(grid, baseline.arrivalMinutes, ringMinute), anchor);
      rings.set(ringMinute, sides);
    }
    const side = k % 2;
    const list = sides[side];
    let start = list.findIndex(([angle, c]) => angle >= covered[side] && !taken.has(c));
    if (start < 0) start = list.findIndex(([, c]) => !taken.has(c));
    if (start < 0) return;
    const model = andersonModel(grid.fuelCodes[list[start][1]]) ?? 1;
    const target = lineFeetPerLoad(drop.gallons, coverageLevel(model)) * METERS_PER_FOOT * effect;
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
              Math.hypot((c % grid.width) - (previous % grid.width), Math.floor(c / grid.width) - Math.floor(previous / grid.width)) * cellSize,
            );
      laid += step;
      previous = c;
      taken.add(c);
      cells.push(c);
      holds.push(drop.minute);
      owners.push(drop.aircraft);
      covered[side] = list[j][0];
    }
    drop.lineMeters = laid;
    const row = sortiesOut[drop.aircraft];
    row.drops += 1;
    row.gallons += drop.gallons;
    row.lineMeters += laid;
  });
  if (waterKm === null && specs.some((s) => s.spec.role === "helicopter")) {
    notes.push(`No open water on the board; helicopter dip assumed ${ASSUMED_DIP_KM} km away.`);
  }
  return {
    aircraft: sortiesOut,
    drops,
    cells: Int32Array.from(cells),
    holdFromMinute: Float32Array.from(holds),
    aircraftIndex: Int16Array.from(owners),
    windKnots,
    windEffect: effect,
    dipKm,
    dipMeasured: waterKm !== null,
    notes,
  };
}
