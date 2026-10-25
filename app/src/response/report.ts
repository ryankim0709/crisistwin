/**
 * Time from ignition to dispatch: someone notices the fire and calls 911 (or an AI camera
 * flags it), the 911 centre answers, transfers a wildland call to the fire dispatch centre
 * (CAL FIRE ECC), and processes it. Turnout follows (response/fleet.ts). Pure; seeded per fire.
 * See docs/response-model.md, "From ignition to dispatch".
 *
 * Evidence:
 * - Residential night offset: NIST TN 2174 (Gilbert et al., 2021, NFIRS data), Table 2: a fire
 *   at night (23:00-06:00) is reported 18.5 min later than by day with smoke alarms present
 *   (20.9 min without). Used for urban and suburban ignitions.
 * - Rural anchor: Camp Fire 2018 (Butte County DA, Camp Fire Public Report, 2020, p.7): line
 *   interruption 06:15, fire seen about 06:20 by a passing PG&E employee, 911 call received by
 *   the CAL FIRE ECC at 06:25:19, about 10 min in a remote canyon at dawn.
 * - Night rural anchor: ALERTCalifornia Wolf Mountain camera, Grass Valley, 11 Sept 2023:
 *   AI alert 05:19, first 911 call 06:01 (42 min), near homes before dawn (UC San Diego /
 *   CAL FIRE release, as reported).
 * - Cameras: ALERTCalifornia AI flagged 636 of 1,668 detected fires before any 911 call (about
 *   38%; Bay Area News Group, 2025, as reported; "over 30%" in the first season, 2023). Used
 *   as a check on the camera model below, not as an input.
 * - Heavy tail: Alberta 2015-2020 ignition-to-report delays have a coefficient of variation
 *   above 1 (Huang & Wichmann 2024, PLoS ONE 19(11):e0313200; means of 10-12 h there, boreal
 *   and lightning holdovers, so not used for values).
 * - 911 answer: NFPA 1225 (2022) 15.4.1, 90% within 15 s (secondary source; another reports
 *   10 s). Transfer to a secondary PSAP: NFPA 1225 15.4.2, 90% within 30 s (secondary source,
 *   unverified). Alarm processing: 90% within 64 s (NFPA 1710 4.1.2.3.3, as NFPA 1221).
 *
 * Every median below that is not one of those numbers is an ASSUMPTION, labelled.
 */

import type { LonLat } from "../live/types";
import { sunTimesUtc } from "../studio/daylight";
import { lognormalFactor, type RngStream } from "./rng";

/** NFPA 1720 Table 4.3.2 demand zones by population density, people per square mile. */
export type DemandZone = "urban" | "suburban" | "rural";
export const URBAN_MIN_PEOPLE_PER_SQ_MI = 1000;
export const SUBURBAN_MIN_PEOPLE_PER_SQ_MI = 500;
/** 1 square mile = 2,589,988.110336 m² (exact). */
export const SQ_M_PER_SQ_MI = 2_589_988.110336;
/** ASSUMPTION: people per household, about the US and Butte County average (ACS), to turn households into density. */
export const PERSONS_PER_HOUSEHOLD = 2.5;

export function demandZone(peoplePerSqMi: number): DemandZone {
  if (peoplePerSqMi > URBAN_MIN_PEOPLE_PER_SQ_MI) return "urban";
  if (peoplePerSqMi >= SUBURBAN_MIN_PEOPLE_PER_SQ_MI) return "suburban";
  return "rural";
}

/** NIST TN 2174 Table 2: night (23:00-06:00) adds 18.5 min to residential reporting, smoke alarms present. */
export const RESIDENTIAL_NIGHT_OFFSET_MIN = 18.5;
/** NIST TN 2174's night window, local hours. */
export const NIGHT_FROM_HOUR = 23;
export const NIGHT_TO_HOUR = 6;

/**
 * Median minutes from ignition to the first 911 call, by demand zone, day and night.
 * - urban day 3, suburban day 5: ASSUMPTION (many people about; no retrieved absolute figure,
 *   TN 2174 gives only offsets);
 * - urban and suburban night: the day value + RESIDENTIAL_NIGHT_OFFSET_MIN (TN 2174);
 * - rural day 10: the Camp Fire 2018 interval (06:15 to 06:25, a passer-by in a canyon);
 * - rural night 45: ASSUMPTION near the Grass Valley 2023 case (42 min between the camera alert
 *   and the first call; the ignition was earlier still).
 */
export const CALL_MEDIAN_MIN: Record<DemandZone, { day: number; night: number }> = {
  urban: { day: 3, night: 3 + RESIDENTIAL_NIGHT_OFFSET_MIN },
  suburban: { day: 5, night: 5 + RESIDENTIAL_NIGHT_OFFSET_MIN },
  rural: { day: 10, night: 45 },
};
/** ASSUMPTION: log-SD of the ignition-to-call time (right-skewed; Alberta data show CV above 1). */
export const CALL_LOG_SD = 0.7;

/**
 * ASSUMPTION: an ALERTCalifornia-style AI camera flags a wildland fire after this median, day
 * or night (the cameras see in near-infrared), with this log-SD; the ECC confirms the alert
 * and dispatches CAMERA_CONFIRM_MIN later. Not applied on developed ground (cameras watch
 * wildland). Checked against the 38% "before any 911 call" share (docs/response-model.md).
 */
export const CAMERA_MEDIAN_MIN = 15;
export const CAMERA_LOG_SD = 0.6;
export const CAMERA_CONFIRM_MIN = 2;

/** A seconds benchmark as a lognormal: the 90th percentile from the standard, the median ASSUMED. */
interface Benchmark {
  medianSeconds: number;
  p90Seconds: number;
}
/** NFPA 1225 (2022) 15.4.1: answered within 15 s for 90% (median 8 s ASSUMED). */
export const ANSWER: Benchmark = { medianSeconds: 8, p90Seconds: 15 };
/** NFPA 1225 (2022) 15.4.2: transfer to the secondary PSAP (the CAL FIRE ECC) within 30 s for 90% (median 20 s ASSUMED). */
export const TRANSFER: Benchmark = { medianSeconds: 20, p90Seconds: 30 };
/** NFPA 1710 4.1.2.3.3: alarm processing within 64 s for 90% (median 40 s ASSUMED). */
export const PROCESSING: Benchmark = { medianSeconds: 40, p90Seconds: 64 };
/** z of the 90th percentile of a standard normal. */
const Z90 = 1.2815515655446004;

function benchmarkMinutes(rng: RngStream | null, b: Benchmark): number {
  const logSd = Math.log(b.p90Seconds / b.medianSeconds) / Z90;
  return ((rng ? lognormalFactor(rng, logSd) : 1) * b.medianSeconds) / 60;
}

export interface ReportContext {
  /** UTC epoch ms of the ignition. */
  ignitionEpochMs: number;
  location: LonLat;
  /** People per square mile around the ignition. */
  peoplePerSqMi: number;
  /** The ignition is on developed ground (FBFM40 91): a structure or yard fire. */
  developed: boolean;
  /** Wildland (not a structure fire): the call goes on to the CAL FIRE ECC. */
  wildland: boolean;
  /** The fire came in as a field report (the report is the call): no discovery delay. */
  alreadyReported: boolean;
  /** Whether AI cameras watch the area (ASSUMPTION default: yes, ALERTCalifornia covers most of the state). */
  cameras?: boolean;
}

export interface ReportDelay {
  /** Minutes from ignition to dispatch (turnout not included). */
  totalMinutes: number;
  /** How the fire first reached the dispatch centre. */
  by: "911" | "camera" | "field_report";
  zone: DemandZone;
  night: boolean;
  /** Parts, minutes: until the first call (or camera alert), answering, transfer, processing. */
  callMinutes: number;
  answerMinutes: number;
  transferMinutes: number;
  processingMinutes: number;
}

/** Local hour (0-24) in California for an epoch, by the Pacific time zone. */
export function pacificHour(epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(epochMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

/** Whether the sun is down at `location` (official sunrise/sunset, NOAA equations in studio/daylight.ts). */
export function dark(epochMs: number, location: LonLat): boolean {
  const day = Math.floor(epochMs / 86_400_000) * 86_400_000;
  for (const d of [day - 86_400_000, day, day + 86_400_000]) {
    const sun = sunTimesUtc(d, location[1], location[0]);
    if (sun.sunriseMs !== null && sun.sunsetMs !== null && epochMs >= sun.sunriseMs && epochMs <= sun.sunsetMs) return false;
  }
  return true;
}

/**
 * The delay from ignition to dispatch. `rng` null gives the medians (deterministic planning,
 * Studio). Night: urban and suburban use NIST TN 2174's sleeping hours (23:00-06:00 Pacific);
 * rural uses darkness (smoke is not seen in the dark).
 */
export function reportDelay(rng: RngStream | null, ctx: ReportContext): ReportDelay {
  const zone = ctx.developed && ctx.peoplePerSqMi < SUBURBAN_MIN_PEOPLE_PER_SQ_MI ? "suburban" : demandZone(ctx.peoplePerSqMi);
  const hour = pacificHour(ctx.ignitionEpochMs);
  const night = zone === "rural" ? dark(ctx.ignitionEpochMs, ctx.location) : hour >= NIGHT_FROM_HOUR || hour < NIGHT_TO_HOUR;
  const median = CALL_MEDIAN_MIN[zone][night ? "night" : "day"];
  const draw = (sd: number) => (rng ? lognormalFactor(rng, sd) : 1);
  let callMinutes = ctx.alreadyReported ? 0 : median * draw(CALL_LOG_SD);
  let by: ReportDelay["by"] = ctx.alreadyReported ? "field_report" : "911";
  // An AI camera may see a wildland fire first; the ECC then dispatches without a 911 call.
  const cameraMinutes =
    !ctx.alreadyReported && !ctx.developed && ctx.cameras !== false ? CAMERA_MEDIAN_MIN * draw(CAMERA_LOG_SD) + CAMERA_CONFIRM_MIN : Infinity;
  if (cameraMinutes < callMinutes) {
    callMinutes = cameraMinutes;
    by = "camera";
  }
  const answerMinutes = by === "camera" ? 0 : benchmarkMinutes(rng, ANSWER);
  const transferMinutes = by === "911" && ctx.wildland ? benchmarkMinutes(rng, TRANSFER) : 0;
  const processingMinutes = benchmarkMinutes(rng, PROCESSING);
  return {
    totalMinutes: callMinutes + answerMinutes + transferMinutes + processingMinutes,
    by,
    zone,
    night,
    callMinutes,
    answerMinutes,
    transferMinutes,
    processingMinutes,
  };
}
