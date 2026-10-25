/**
 * Whether a fuel carries fire at a fuel moisture, and from which Studio weather step it does, as
 * the solver decides it on a weather-series run (fire/spread.ts: a cell whose fuel bed's no-wind
 * rate is at most EXTINCT_RATE_FEET_PER_MINUTE does not spread at that step; Rothermel 1972
 * moisture damping is 0 at or above the moisture of extinction, fire/rothermel.ts dampingOf).
 *
 * The /live board solves at one wind and moisture (the current Studio step) and re-solves at each
 * 10-minute step (demo/fireField.ts), so it cannot see a later, drier step inside one solve. This
 * module lets the board apply the solver's own rules across the series:
 *  - an ignition whose fuel is too wet at its step waits for the first later step that lets it
 *    spread (spread.ts, the settle step: "the delayed arrival goes back on the heap"; a source cell
 *    with no such step within the horizon ignites and spreads nothing);
 *  - a fire whose burned fuel is too wet now is stalled, not out, while a later step of the run
 *    lets that fuel spread (the board's next re-solve at that step resumes it, spread.ts ResumeFrom).
 * Pure: no React, worker or network. Moisture fractions (0.06 = 6 %), minutes on the Studio clock.
 */

import { FUEL_MODELS, fuelLabel } from "../fire/fuelModels";
import { prepareFuelBed } from "../fire/rothermel";
import { DEVELOPED_FUEL_CODE, EXTINCT_RATE_FEET_PER_MINUTE, type FuelMoisture } from "../fire/spread";
import { WEATHER_STEP_MINUTES, weatherAtStep, weatherStepAt, type FireWeatherSeries } from "../fire/weatherSeries";
import { carriesFire } from "./fireField";

/** True when fuel `code` spreads fire at `moisture` (the solver's weather-series gate). */
export function fuelCarriesFireAt(code: number, moisture: FuelMoisture): boolean {
  // Developed ground spreads by the structure model, which does not read fuel moisture.
  if (code === DEVELOPED_FUEL_CODE) return carriesFire(code);
  const fuel = FUEL_MODELS.get(code);
  if (!fuel) return false;
  return prepareFuelBed(fuel, moisture).noWindRateFeetPerMinute > EXTINCT_RATE_FEET_PER_MINUTE;
}

/** The Studio run's weather as the board reads it: its series (or null) and constant moisture, to `horizonMinutes`. */
export interface RunMoisture {
  series: FireWeatherSeries | null;
  moisture: FuelMoisture;
  horizonMinutes: number;
}

/** Fuel moisture of Studio weather step `k` (the series' at the step start, else the run's constant). */
export function stepMoisture(run: RunMoisture, k: number): FuelMoisture {
  return run.series ? (weatherAtStep(run.series, k).moisture ?? run.moisture) : run.moisture;
}

/**
 * First Studio minute at or after `fromMinute` (a step start, or `fromMinute` itself when its own
 * step carries) at which fuel `code` spreads, or null when no step within the run's horizon does.
 * Steps as spread.ts reads the series: weatherStepAt / weatherAtStep, WEATHER_STEP_MINUTES apart.
 */
export function firstCarryingMinute(run: RunMoisture, code: number, fromMinute: number): number | null {
  const first = weatherStepAt(Math.max(0, fromMinute));
  if (!run.series) return fuelCarriesFireAt(code, run.moisture) ? fromMinute : null;
  const last = weatherStepAt(run.horizonMinutes);
  for (let k = first; k <= last; k++) {
    if (fuelCarriesFireAt(code, stepMoisture(run, k))) return k === first ? fromMinute : k * WEATHER_STEP_MINUTES;
  }
  return null;
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/**
 * Why fuel `code` does not carry fire at `moisture`, in the model's numbers: "dead 1-h fuel moisture
 * 60% against GS3's 40% moisture of extinction". The solver compares the bed's weighted dead
 * moisture (1-h, 10-h, 100-h and cured herb) with that threshold; the 1-h class is the one shown.
 */
export function tooWetText(code: number, moisture: FuelMoisture): string {
  const fuel = FUEL_MODELS.get(code);
  const name = fuelLabel(code).split(" ")[0];
  if (!fuel) return `${name} carries no fire`;
  return `fuel too damp to carry fire: dead 1-h fuel moisture ${pct(moisture.dead1h)} against ${name}'s ${pct(fuel.deadMoistureOfExtinction)} moisture of extinction (Rothermel 1972: no spread)`;
}
