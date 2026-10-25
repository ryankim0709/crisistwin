/**
 * Burn-probability ensembles over the seeded stochastic solver (stochastic.ts, spread.ts).
 * Pure: no React, worker or network. Run it in a worker; cost is members x one solve.
 *
 * Every member is the same scheduled input with `settings.stochastic` enabled and its own
 * seed, `memberSeed(baseSeed, k)`, so an ensemble is reproduced exactly by its base seed and
 * member count. The output is SIMULATED: a fraction of model runs, not an observed or
 * calibrated probability of burning.
 */

import type { LandscapeGrid } from "./landscape";
import type { ScheduledFireInput } from "./scheduledTypes";
import { simulateScheduledFireSpread, type ControlLines } from "./spread";
import { memberSeed, type StochasticSpreadOptions } from "./stochastic";

/** Bound on members per call, so a caller cannot queue minutes of solver work by accident. */
export const MAX_ENSEMBLE_MEMBERS = 200;

export interface BurnProbabilityOptions {
  /** Number of runs, 1 to `MAX_ENSEMBLE_MEMBERS`. */
  members: number;
  /** Base seed; member k runs with `memberSeed(baseSeed, k)`. */
  baseSeed: number;
  /**
   * Stochastic options shared by every member (seed and `enabled` are overridden). Defaults
   * to `input.settings.stochastic`, else every mechanism at its default.
   */
  stochastic?: Omit<StochasticSpreadOptions, "enabled" | "seed">;
}

export interface BurnProbabilityRaster {
  evidence: "simulated";
  members: number;
  baseSeed: number;
  /** Seed each member actually ran with, in order. */
  memberSeeds: number[];
  /** Minutes from T+0 by which a cell must have burned to count (the input's horizon). */
  horizonMinutes: number;
  /**
   * Fraction of members in which each cell burned by the horizon, 0 to 1, row-major like
   * `LandscapeGrid.fuelCodes`.
   */
  burnProbability: Float32Array;
  /** Burned area of each member at the horizon, square metres. */
  memberBurnedAreaSquareMeters: number[];
  computeMilliseconds: number;
}

/** Runs `members` seeded solves of `input` and returns the per-cell fraction burned by the horizon. */
export function burnProbabilityEnsemble(
  landscape: LandscapeGrid,
  input: ScheduledFireInput,
  options: BurnProbabilityOptions,
  controlLines: ControlLines | null = null,
  outFromMinuteBySource: readonly number[] | null = null,
): BurnProbabilityRaster {
  const started = performance.now();
  const members = Math.floor(options.members);
  if (!(members >= 1 && members <= MAX_ENSEMBLE_MEMBERS)) {
    throw new Error(`An ensemble needs 1 to ${MAX_ENSEMBLE_MEMBERS} members, not ${options.members}.`);
  }
  const horizon = input.settings.horizonMinutes;
  const shared = options.stochastic ?? input.settings.stochastic ?? {};
  const counts = new Uint16Array(landscape.width * landscape.height);
  const memberSeeds: number[] = [];
  const memberBurnedAreaSquareMeters: number[] = [];
  const cellArea = landscape.groundCellSizeMeters * landscape.groundCellSizeMeters;
  for (let k = 0; k < members; k++) {
    const seed = memberSeed(options.baseSeed, k);
    memberSeeds.push(seed);
    const run = simulateScheduledFireSpread(
      landscape,
      {
        ...input,
        settings: { ...input.settings, stochastic: { ...shared, enabled: true, seed } },
        // The raster reads the arrival field; contouring frames would only cost time.
        frameMinutes: [],
      },
      controlLines,
      outFromMinuteBySource,
    );
    let burned = 0;
    const arrival = run.arrivalMinutes;
    for (let i = 0; i < arrival.length; i++) {
      if (arrival[i] <= horizon) {
        counts[i]++;
        burned++;
      }
    }
    memberBurnedAreaSquareMeters.push(burned * cellArea);
  }
  const burnProbability = new Float32Array(counts.length);
  for (let i = 0; i < counts.length; i++) burnProbability[i] = counts[i] / members;
  return {
    evidence: "simulated",
    members,
    baseSeed: options.baseSeed,
    memberSeeds,
    horizonMinutes: horizon,
    burnProbability,
    memberBurnedAreaSquareMeters,
    computeMilliseconds: performance.now() - started,
  };
}
