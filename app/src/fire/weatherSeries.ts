/**
 * Time-varying weather inside one solve of the landscape fire solver (spread.ts). Pure: no
 * React, network or wall clock.
 *
 * A run normally takes ONE open wind and one fuel moisture (`FireScenario.windSpeedMph`,
 * `windFromDegrees`, `moisture`). With `FireScenario.weatherSeries` it takes a series of
 * samples instead, and a cell spreads out at the weather of the 10-minute weather step it
 * ignites in, exactly as the stochastic wind wander already does (stochastic.ts; the step
 * length and the "a cell's outgoing behaviour is fixed when it ignites" rule are shared, see
 * `WIND_STEP_MINUTES`). Wind wander, when on, is applied on top of the series' wind.
 *
 * Why it matters: in the Eaton Fire (January 2025) the fire first spread east, and around
 * 03:00 on 8 January the wind strengthened and changed direction, driving it west into
 * Altadena (LA County after-action review, "Eaton Fire Synopsis of Findings and Timeline",
 * https://file.lacounty.gov/SDSInter/lac/1192777_AAR_EatonFireSynopsisofFindingsandTimeline.pdf).
 * One wind per run cannot represent that.
 *
 * Interpolation between samples (each sample is read as the instantaneous value at its minute):
 *   - speed and every moisture fraction: linear in time;
 *   - direction: along the shorter arc of the circle (350 deg to 10 deg passes through north,
 *     not through south); an exact 180-degree reversal turns clockwise. ASSUMPTION: speed and
 *     direction are interpolated separately, so a reversal keeps its speed through the turn
 *     instead of passing through calm as vector-component interpolation would.
 *   - before the first sample the first is held, after the last the last is held.
 * The step's weather is the series read at the step's START minute, so step 0 is the sample
 * at minute 0 exactly and a constant series reproduces a constant-weather run.
 *
 * Units are in the names: open 20-ft wind in mph and the bearing it blows FROM in degrees true
 * (the `FireScenario` contract), moisture as fractions of oven-dry weight, minutes on the
 * simulation clock from T+0.
 */

import type { FuelMoisture } from "./rothermel";
import { WIND_STEP_MINUTES } from "./stochastic";

/** One weather sample at a simulation minute. */
export interface FireWeatherSample {
  /** Simulation-clock minute from T+0 the sample describes. May be negative (before T+0). */
  minute: number;
  /** Open 20-ft wind, mph. */
  windSpeedMph: number;
  /** Bearing the wind blows FROM, degrees clockwise from true north. */
  windFromDegrees: number;
  /** Fuel moisture at this minute. Absent: the scenario's `moisture`. */
  moisture?: FuelMoisture;
  /** Air temperature, degrees F (firebrand ignition, Byram's convective number). Absent: the run default. */
  airTemperatureF?: number;
}

/**
 * Hourly (or sub-hourly) weather for one run, carried on `FireScenario.weatherSeries`.
 * Absent or `enabled: false`: the run takes the scenario's single wind and moisture, output
 * unchanged bit for bit.
 */
export interface FireWeatherSeries {
  enabled: boolean;
  /** At least one sample, strictly ascending `minute`. */
  samples: FireWeatherSample[];
  /** Where the samples came from, for the run record (e.g. "historical_replay KBUR"). */
  source?: string;
  /** Evidence class of the weather (the wind source's), kept with the run. */
  evidence?: "observed" | "forecast" | "derived" | "modelled" | "assumed";
}

/** Weather step length, simulation minutes: the stochastic wind step (stochastic.ts). */
export const WEATHER_STEP_MINUTES = WIND_STEP_MINUTES;
/** Bound on samples a series may carry (validation), one per 10 minutes over 72 hours. */
export const MAX_WEATHER_SAMPLES = 433;
/** Upper bound on a sample's wind, mph: twice the pages' 60 mph slider (validation only). */
export const MAX_SERIES_WIND_MPH = 120;

/** The weather of one step after interpolation. */
export interface StepWeather {
  windSpeedMph: number;
  windFromDegrees: number;
  /** Null when the series carries no moisture there: the scenario's moisture applies. */
  moisture: FuelMoisture | null;
  airTemperatureF: number | null;
}

/** The series is usable by the solver: enabled, at least one sample. */
export function seriesActive(series: FireWeatherSeries | null | undefined): series is FireWeatherSeries {
  return !!series && series.enabled === true && Array.isArray(series.samples) && series.samples.length > 0;
}

/** Signed smallest rotation from `fromDegrees` to `toDegrees`, in (-180, 180]. */
export function shortestArcDegrees(fromDegrees: number, toDegrees: number): number {
  let d = (((toDegrees - fromDegrees) % 360) + 360) % 360; // [0, 360)
  if (d > 180) d -= 360;
  return d; // exactly 180 stays +180: a reversal turns clockwise
}

/** Bearing interpolated along the shorter arc, degrees in [0, 360). */
export function interpolateBearingDegrees(fromDegrees: number, toDegrees: number, fraction: number): number {
  const b = fromDegrees + fraction * shortestArcDegrees(fromDegrees, toDegrees);
  return ((b % 360) + 360) % 360;
}

const MOISTURE_KEYS = ["dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"] as const;

/** Weather at `minute`, interpolated as described in the module comment. */
export function weatherAtMinute(series: FireWeatherSeries, minute: number): StepWeather {
  const samples = series.samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const of = (s: FireWeatherSample): StepWeather => ({
    windSpeedMph: s.windSpeedMph,
    windFromDegrees: ((s.windFromDegrees % 360) + 360) % 360,
    moisture: s.moisture ?? null,
    airTemperatureF: s.airTemperatureF ?? null,
  });
  if (minute <= first.minute) return of(first);
  if (minute >= last.minute) return of(last);
  // Binary search for the bracketing pair a.minute <= minute < b.minute.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].minute <= minute) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const f = (minute - a.minute) / (b.minute - a.minute);
  if (f === 0) return of(a);
  let moisture: FuelMoisture | null = null;
  if (a.moisture && b.moisture) {
    const m = {} as FuelMoisture;
    for (const key of MOISTURE_KEYS) m[key] = a.moisture[key] + f * (b.moisture[key] - a.moisture[key]);
    moisture = m;
  } else {
    // Only one side carries moisture: hold the nearer sample's (or none), never invent one.
    moisture = (f < 0.5 ? a.moisture : b.moisture) ?? null;
  }
  const ta = a.airTemperatureF;
  const tb = b.airTemperatureF;
  return {
    windSpeedMph: a.windSpeedMph + f * (b.windSpeedMph - a.windSpeedMph),
    windFromDegrees: interpolateBearingDegrees(a.windFromDegrees, b.windFromDegrees, f),
    moisture,
    airTemperatureF:
      ta !== undefined && tb !== undefined ? ta + f * (tb - ta) : (f < 0.5 ? ta : tb) ?? null,
  };
}

/** Step index of a simulation minute (step k covers [k * 10, (k + 1) * 10) minutes); never negative. */
export function weatherStepAt(minute: number): number {
  const k = Math.floor(minute / WEATHER_STEP_MINUTES);
  return k < 0 ? 0 : k;
}

/** Weather of step k: the series at the step's start minute. */
export function weatherAtStep(series: FireWeatherSeries, step: number): StepWeather {
  return weatherAtMinute(series, step * WEATHER_STEP_MINUTES);
}

/** What a run did with its weather series, for the run record. The weather is input, not simulated. */
export interface WeatherSeriesSummary {
  stepMinutes: number;
  samples: number;
  firstSampleMinute: number;
  lastSampleMinute: number;
  /** Range of the interpolated step winds over the horizon, mph (before wind wander). */
  windSpeedRangeMph: [number, number];
  /** True when at least one sample carried fuel moisture. */
  moistureVaries: boolean;
  source: string | null;
  evidence: FireWeatherSeries["evidence"] | null;
  /** Weather the precompute (ignition conditions, cells never reached) used: the first source's start step. */
  baseMinute: number;
  /**
   * Arrivals moved to a later step because the cell's fuel could not spread at its step's
   * moisture (above the moisture of extinction), and arrivals refused because no later step
   * within the horizon let it spread.
   */
  delayedArrivals: number;
  droppedArrivals: number;
}

/** The run record of a series over a horizon (pure; the solver's summary). */
export function weatherSeriesSummary(
  series: FireWeatherSeries,
  horizonMinutes: number,
  baseMinute: number,
  delayedArrivals: number,
  droppedArrivals: number,
): WeatherSeriesSummary {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  const lastStep = weatherStepAt(horizonMinutes);
  for (let k = weatherStepAt(Number.isFinite(baseMinute) ? baseMinute : 0); k <= lastStep; k++) {
    const speed = weatherAtStep(series, k).windSpeedMph;
    if (speed < lo) lo = speed;
    if (speed > hi) hi = speed;
  }
  return {
    stepMinutes: WEATHER_STEP_MINUTES,
    samples: series.samples.length,
    firstSampleMinute: series.samples[0].minute,
    lastSampleMinute: series.samples[series.samples.length - 1].minute,
    windSpeedRangeMph: [Number.isFinite(lo) ? lo : 0, hi],
    moistureVaries: series.samples.some((s) => s.moisture !== undefined),
    source: series.source ?? null,
    evidence: series.evidence ?? null,
    baseMinute: Number.isFinite(baseMinute) ? baseMinute : 0,
    delayedArrivals,
    droppedArrivals,
  };
}

/**
 * Problems with a series, or [] when the solver can take it. Shared by the solver (which
 * throws on the first) and by scenario import (which reports them).
 */
export function weatherSeriesProblems(series: FireWeatherSeries): string[] {
  const problems: string[] = [];
  if (!Array.isArray(series.samples) || series.samples.length === 0) {
    return ["A weather series needs at least one sample."];
  }
  if (series.samples.length > MAX_WEATHER_SAMPLES) {
    problems.push(`A weather series may carry at most ${MAX_WEATHER_SAMPLES} samples.`);
  }
  series.samples.forEach((s, i) => {
    if (!Number.isFinite(s.minute)) problems.push(`Weather sample ${i} has no valid minute.`);
    if (i > 0 && !(s.minute > series.samples[i - 1].minute)) {
      problems.push(`Weather sample minutes must be strictly ascending (sample ${i}).`);
    }
    if (!Number.isFinite(s.windSpeedMph) || s.windSpeedMph < 0 || s.windSpeedMph > MAX_SERIES_WIND_MPH) {
      problems.push(`Weather sample ${i} wind must be 0 to ${MAX_SERIES_WIND_MPH} mph.`);
    }
    if (!Number.isFinite(s.windFromDegrees)) problems.push(`Weather sample ${i} has no valid wind direction.`);
    if (s.moisture) {
      for (const key of MOISTURE_KEYS) {
        const v = s.moisture[key];
        if (!Number.isFinite(v) || v < 0 || v > 4) {
          problems.push(`Weather sample ${i} moisture.${key} must be a fraction from 0 to 4.`);
        }
      }
    }
    if (s.airTemperatureF !== undefined && !Number.isFinite(s.airTemperatureF)) {
      problems.push(`Weather sample ${i} air temperature is not a number.`);
    }
  });
  return problems;
}

/** Celsius to Fahrenheit. */
export function fahrenheitOfCelsius(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}
