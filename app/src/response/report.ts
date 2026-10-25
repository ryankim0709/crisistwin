/**
 * Time from ignition to dispatch, as a function of how remote the fire's origin is: someone
 * notices it and calls 911 (or an AI camera or a satellite flags it), the 911 centre answers,
 * transfers a wildland call to the fire dispatch centre (CAL FIRE ECC), and processes it.
 * Turnout follows (response/fleet.ts). Pure; seeded per fire. See docs/response-model.md,
 * "From ignition to dispatch".
 *
 * Remoteness d (metres) = min(distance to the nearest occupied home, x LOS_BLOCKED_FACTOR when
 * terrain hides the fire from it; distance to the nearest road). The median time to the first
 * 911 call rises smoothly with d (log-linear in 1 + d/D0):
 *
 *   day(d)   = DAY_AT_HOMES_MIN x (1 + d/D0)^DAY_EXPONENT
 *   night(d) = day(d) + NIGHT_OFFSET_AT_HOMES_MIN x (1 + d/D0)^NIGHT_EXPONENT
 *
 * anchored on four points:
 * - d = 0, day: 3 min (ASSUMPTION: many people about; no retrieved absolute figure);
 * - d = 0, night: + 18.5 min, NIST TN 2174 (Gilbert et al., 2021, NFIRS) Table 2, residential
 *   fires at night with smoke alarms;
 * - d ~ 1 km, day: 10 min, the Camp Fire 2018 (Butte County DA, Camp Fire Public Report 2020,
 *   p.7): line interruption 06:15, fire seen about 06:20 from Highway 70, 911 received by the
 *   CAL FIRE ECC at 06:25:19 (ASSUMPTION: about 1 km from the highway and Pulga);
 * - d ~ 1 km, night: 45 min, near the Grass Valley case of 11 Sept 2023 (ALERTCalifornia camera
 *   alert 05:19, first 911 call 06:01, "near a residential area"; the distance is ASSUMED).
 * Beyond the anchors the curve is extrapolated (labelled): about 29 min by day at 5 km, 80 min
 * at 20 km. Remote fires are then mostly found by cameras or satellites (below).
 *
 * Other channels, whichever comes first:
 * - AI camera (ALERTCalifornia-style), wildland only, day or night: ASSUMPTION median 15 min +
 *   2 min ECC confirmation. Check: ALERTCalifornia flagged 636 of 1,668 detected fires (38%)
 *   before any 911 call (Bay Area News Group, 2025).
 * - Satellite (GOES ABI fire detection), wildland only: median 55 min, the Camp Fire (first
 *   GOES-16 hotspot about 07:10 PST, about 55 min after 06:15; secondary source), with a wide
 *   spread (log-SD 0.8, ASSUMPTION) because GOES-17 flagged the wind-driven Kincade Fire (2019)
 *   5 min after ignition (Lindley et al. 2020, J. Operational Meteorology) and small fires are
 *   below its detection limit; + 5 min to act on it (ASSUMPTION).
 * Call handling: NFPA 1225 (2022) 15.4.1 answer within 15 s for 90% (secondary source; another
 * gives 10 s); 15.4.2 transfer within 30 s for 90% (secondary, unverified); NFPA 1710 4.1.2.3.3
 * processing within 64 s for 90%.
 */

import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { DEVELOPED_FUEL_CODE, cellAt } from "../fire/spread";
import type { LonLat } from "../live/types";
import { sunTimesUtc } from "../studio/daylight";
import { lognormalFactor, uniform, type RngStream } from "./rng";

/** NFPA 1720 Table 4.3.2 demand-zone classes (people per square mile), kept as labels only. */
export type DemandZone = "urban" | "suburban" | "rural";
export const URBAN_MIN_PEOPLE_PER_SQ_MI = 1000;
export const SUBURBAN_MIN_PEOPLE_PER_SQ_MI = 500;
/** 1 square mile = 2,589,988.110336 m² (exact). */
export const SQ_M_PER_SQ_MI = 2_589_988.110336;
/** ASSUMPTION: people per household, about the US and Butte County average (ACS). */
export const PERSONS_PER_HOUSEHOLD = 2.5;
export function demandZone(peoplePerSqMi: number): DemandZone {
  if (peoplePerSqMi > URBAN_MIN_PEOPLE_PER_SQ_MI) return "urban";
  if (peoplePerSqMi >= SUBURBAN_MIN_PEOPLE_PER_SQ_MI) return "suburban";
  return "rural";
}

// ---- the remoteness curve ----

/** ASSUMPTION: median minutes to the first call by day at a home's doorstep. */
export const DAY_AT_HOMES_MIN = 3;
/** NIST TN 2174 Table 2: night adds 18.5 min to residential reporting (smoke alarms present). */
export const NIGHT_OFFSET_AT_HOMES_MIN = 18.5;
/** ASSUMPTION: the distance scale of the curve, metres. */
export const D0_M = 250;
/** Camp 2018 anchor distance (ASSUMED ~1 km) and its 10 min; the exponent follows: ln(10/3) / ln(1 + 1000/250). */
export const ANCHOR_DISTANCE_M = 1000;
export const CAMP_DAY_MIN = 10;
export const DAY_EXPONENT = Math.log(CAMP_DAY_MIN / DAY_AT_HOMES_MIN) / Math.log(1 + ANCHOR_DISTANCE_M / D0_M);
/** Grass Valley 2023 night anchor, 45 min at ~1 km (distance ASSUMED); the night exponent follows. */
export const GRASS_VALLEY_NIGHT_MIN = 45;
export const NIGHT_EXPONENT =
  Math.log((GRASS_VALLEY_NIGHT_MIN - CAMP_DAY_MIN) / NIGHT_OFFSET_AT_HOMES_MIN) / Math.log(1 + ANCHOR_DISTANCE_M / D0_M);
/** ASSUMPTION: terrain hiding the fire from the nearest home counts as this much farther. */
export const LOS_BLOCKED_FACTOR = 2;
/** ASSUMPTION: remoteness when nothing is known about homes or roads, metres. */
export const UNKNOWN_REMOTENESS_M = 5000;
/** ASSUMPTION: log-SD of the time to the first call (right-skewed; Alberta delays have CV above 1, Huang & Wichmann 2024). */
export const CALL_LOG_SD = 0.7;

/** Median minutes to the first 911 call at remoteness `d` metres, by day or night. */
export function callMedianMinutes(d: number, night: boolean): number {
  const x = 1 + Math.max(0, d) / D0_M;
  const day = DAY_AT_HOMES_MIN * Math.pow(x, DAY_EXPONENT);
  return night ? day + NIGHT_OFFSET_AT_HOMES_MIN * Math.pow(x, NIGHT_EXPONENT) : day;
}

// ---- other channels ----

/**
 * ASSUMPTION: share of wildland ignitions in view of an AI camera (drawn per fire). The network
 * has over 1,000 cameras, but range, terrain and smoke direction leave gaps; no coverage share
 * was retrieved.
 */
export const CAMERA_COVERAGE = 0.6;
export const CAMERA_MEDIAN_MIN = 15;
export const CAMERA_LOG_SD = 0.6;
export const CAMERA_CONFIRM_MIN = 2;
export const SATELLITE_MEDIAN_MIN = 55;
export const SATELLITE_LOG_SD = 0.8;
export const SATELLITE_CONFIRM_MIN = 5;

interface Benchmark {
  medianSeconds: number;
  p90Seconds: number;
}
/** NFPA 1225 (2022) 15.4.1: answered within 15 s for 90% (median 8 s ASSUMED). */
export const ANSWER: Benchmark = { medianSeconds: 8, p90Seconds: 15 };
/** NFPA 1225 (2022) 15.4.2: transfer to the secondary PSAP (CAL FIRE ECC) within 30 s for 90% (median 20 s ASSUMED). */
export const TRANSFER: Benchmark = { medianSeconds: 20, p90Seconds: 30 };
/** NFPA 1710 4.1.2.3.3: alarm processing within 64 s for 90% (median 40 s ASSUMED). */
export const PROCESSING: Benchmark = { medianSeconds: 40, p90Seconds: 64 };
const Z90 = 1.2815515655446004;

function benchmarkMinutes(rng: RngStream | null, b: Benchmark): number {
  const logSd = Math.log(b.p90Seconds / b.medianSeconds) / Z90;
  return ((rng ? lognormalFactor(rng, logSd) : 1) * b.medianSeconds) / 60;
}

// ---- inputs from the landscape ----

/** NIST TN 2174's sleeping hours (local) and the darkness rule (below). */
export const NIGHT_FROM_HOUR = 23;
export const NIGHT_TO_HOUR = 6;

export function pacificHour(epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(epochMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

/** Whether the sun is down at `location` (NOAA sunrise/sunset, studio/daylight.ts). */
export function dark(epochMs: number, location: LonLat): boolean {
  const day = Math.floor(epochMs / 86_400_000) * 86_400_000;
  for (const d of [day - 86_400_000, day, day + 86_400_000]) {
    const sun = sunTimesUtc(d, location[1], location[0]);
    if (sun.sunriseMs !== null && sun.sunsetMs !== null && epochMs >= sun.sunriseMs && epochMs <= sun.sunsetMs) return false;
  }
  return true;
}

/**
 * Night for reporting: TN 2174's sleeping hours anywhere, or darkness away from homes (smoke is
 * not seen in the dark). ASSUMPTION: "away" = remoteness of ANCHOR_DISTANCE_M or more.
 */
export function isNight(epochMs: number, location: LonLat, remotenessM: number): boolean {
  const h = pacificHour(epochMs);
  return h >= NIGHT_FROM_HOUR || h < NIGHT_TO_HOUR || (remotenessM >= ANCHOR_DISTANCE_M && dark(epochMs, location));
}

/** ASSUMPTION: heights of the smoke seen and of an observer's eye above ground, metres, for the line-of-sight test. */
export const SMOKE_HEIGHT_M = 30;
export const EYE_HEIGHT_M = 2;

function cellLonLat(grid: LandscapeGrid, cell: number): { x: number; y: number } {
  const c = cell % grid.width;
  const r = (cell - c) / grid.width;
  return { x: c, y: r };
}

/**
 * Whether terrain hides `from` (smoke SMOKE_HEIGHT_M up) from `to` (eye height): 12 samples of
 * the landscape elevation along the straight line.
 */
export function lineOfSight(grid: LandscapeGrid, from: LonLat, to: LonLat): boolean {
  const a = cellAt(grid, { longitude: from[0], latitude: from[1] });
  const b = cellAt(grid, { longitude: to[0], latitude: to[1] });
  if (a < 0 || b < 0) return true;
  const za = grid.elevationMeters[a] + SMOKE_HEIGHT_M;
  const zb = grid.elevationMeters[b] + EYE_HEIGHT_M;
  for (let i = 1; i < 12; i += 1) {
    const u = i / 12;
    const c = cellAt(grid, { longitude: from[0] + (to[0] - from[0]) * u, latitude: from[1] + (to[1] - from[1]) * u });
    if (c >= 0 && grid.elevationMeters[c] > za + (zb - za) * u) return false;
  }
  return true;
}

/**
 * The nearest developed cell (FBFM40 91, taken as occupied homes) to `p` within `maxM`, by
 * expanding square rings on the grid; null when there is none. Metres and the cell's point.
 */
export function nearestDeveloped(grid: LandscapeGrid, p: LonLat, maxM = 20_000): { meters: number; at: LonLat } | null {
  const c0 = cellAt(grid, { longitude: p[0], latitude: p[1] });
  if (c0 < 0) return null;
  const { x: x0, y: y0 } = cellLonLat(grid, c0);
  const maxR = Math.ceil(maxM / grid.groundCellSizeMeters);
  let best: { d2: number; cell: number } | null = null;
  for (let r = 0; r <= maxR; r += 1) {
    if (best && (r - 1) ** 2 > best.d2) break;
    for (let y = y0 - r; y <= y0 + r; y += 1) {
      if (y < 0 || y >= grid.height) continue;
      const edge = y === y0 - r || y === y0 + r;
      for (let x = x0 - r; x <= x0 + r; x += edge ? 1 : 2 * r || 1) {
        if (x < 0 || x >= grid.width) continue;
        const cell = y * grid.width + x;
        if (grid.fuelCodes[cell] !== DEVELOPED_FUEL_CODE) continue;
        const d2 = (x - x0) ** 2 + (y - y0) ** 2;
        if (!best || d2 < best.d2) best = { d2, cell };
      }
    }
  }
  if (!best) return null;
  const cx = best.cell % grid.width;
  const cy = (best.cell - cx) / grid.width;
  const at = mercatorToLonLat(grid.originX + cx * grid.cellSizeX, grid.originY + cy * grid.cellSizeY);
  return { meters: Math.sqrt(best.d2) * grid.groundCellSizeMeters, at };
}

// ---- the delay ----

export interface ReportContext {
  /** UTC epoch ms of the ignition. */
  ignitionEpochMs: number;
  location: LonLat;
  /** Metres to the nearest occupied home (developed cell or a zone with households); null = unknown. */
  nearestHomeM: number | null;
  /** Whether that home has a line of sight to the fire's smoke (terrain). */
  homeInSight: boolean;
  /** Metres to the nearest known road; null = unknown. */
  nearestRoadM: number | null;
  /** Households within VIEW_RADIUS_M in sight (reported, not used in the curve). */
  householdsInView?: number;
  /** The ignition is on developed ground (a structure or yard fire). */
  developed: boolean;
  /** Wildland: the call goes on to the CAL FIRE ECC. */
  wildland: boolean;
  /** Came in as a field report (the report is the call): no discovery delay. */
  alreadyReported: boolean;
  /** AI cameras watch the area (ASSUMPTION default: yes). */
  cameras?: boolean;
}

export interface ReportDelay {
  totalMinutes: number;
  by: "911" | "camera" | "satellite" | "field_report";
  /** Remoteness used, metres, and its NFPA 1720-style label. */
  remotenessM: number;
  night: boolean;
  callMinutes: number;
  answerMinutes: number;
  transferMinutes: number;
  processingMinutes: number;
  /** Plain language: "4 km from the nearest home, at night". */
  reason: string;
}

function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m / 50) * 50} m`;
}

/** The remoteness of an origin, metres, from its nearest home (hidden homes count farther) and road. */
export function remotenessOf(ctx: Pick<ReportContext, "nearestHomeM" | "homeInSight" | "nearestRoadM">): number {
  const home = ctx.nearestHomeM === null ? Infinity : ctx.nearestHomeM * (ctx.homeInSight ? 1 : LOS_BLOCKED_FACTOR);
  const road = ctx.nearestRoadM ?? Infinity;
  const d = Math.min(home, road);
  return Number.isFinite(d) ? d : UNKNOWN_REMOTENESS_M;
}

/** The delay from ignition to dispatch; `rng` null gives the medians (deterministic planning). */
export function reportDelay(rng: RngStream | null, ctx: ReportContext): ReportDelay {
  const remotenessM = ctx.developed ? 0 : remotenessOf(ctx);
  const night = isNight(ctx.ignitionEpochMs, ctx.location, remotenessM);
  const draw = (sd: number) => (rng ? lognormalFactor(rng, sd) : 1);
  let callMinutes = ctx.alreadyReported ? 0 : callMedianMinutes(remotenessM, night) * draw(CALL_LOG_SD);
  let by: ReportDelay["by"] = ctx.alreadyReported ? "field_report" : "911";
  if (!ctx.alreadyReported && !ctx.developed) {
    const inView = ctx.cameras !== false && (rng ? uniform(rng) < CAMERA_COVERAGE : CAMERA_COVERAGE >= 0.5);
    const camera = inView ? CAMERA_MEDIAN_MIN * draw(CAMERA_LOG_SD) + CAMERA_CONFIRM_MIN : Infinity;
    const satellite = SATELLITE_MEDIAN_MIN * draw(SATELLITE_LOG_SD) + SATELLITE_CONFIRM_MIN;
    if (camera < callMinutes && camera <= satellite) {
      callMinutes = camera;
      by = "camera";
    } else if (satellite < callMinutes) {
      callMinutes = satellite;
      by = "satellite";
    }
  }
  const answerMinutes = by === "911" ? benchmarkMinutes(rng, ANSWER) : 0;
  const transferMinutes = by === "911" && ctx.wildland ? benchmarkMinutes(rng, TRANSFER) : 0;
  const processingMinutes = benchmarkMinutes(rng, PROCESSING);
  const where =
    ctx.developed
      ? "among homes"
      : ctx.nearestHomeM === null && ctx.nearestRoadM === null
        ? "far from known homes and roads"
        : ctx.nearestRoadM !== null && (ctx.nearestHomeM === null || ctx.nearestRoadM < ctx.nearestHomeM * (ctx.homeInSight ? 1 : LOS_BLOCKED_FACTOR))
          ? `${distanceText(ctx.nearestRoadM)} from the nearest road`
          : `${distanceText(ctx.nearestHomeM ?? 0)} from the nearest home${ctx.homeInSight ? "" : ", hidden by terrain"}`;
  const how = by === "camera" ? ", found by an AI camera" : by === "satellite" ? ", found by satellite" : by === "field_report" ? ", field report" : "";
  return {
    totalMinutes: callMinutes + answerMinutes + transferMinutes + processingMinutes,
    by,
    remotenessM,
    night,
    callMinutes,
    answerMinutes,
    transferMinutes,
    processingMinutes,
    reason: `${where}${night ? ", at night" : ""}${how}`,
  };
}
