/**
 * "Random scenario" for Simulation Studio and /dispatch: the page-agnostic draw
 * (world/randomScenario.ts) turned into a StudioScenario. Same seed, same region: same date,
 * ignitions and weather choice. A simulated planning draw, not a forecast.
 */

import type { DispatchArea } from "../dispatch/area";
import type { LandscapeGrid } from "../fire/landscape";
import type { LandscapeRegion } from "../fire/regions";
import { pacificIso } from "../fire/runClock";
import { drawRandomScenario, type IgnitionPlacement } from "../world/randomScenario";
import type { WorldWeather } from "../world/contracts";
import type { StudioScenario } from "./contracts";
import { DEFAULT_FIREFIGHTING } from "./firefighting";
import { createIgnition } from "./scenario";

export {
  seededRandom,
  randomRegionId,
  PLACEMENT_LABELS,
  type IgnitionPlacement,
} from "../world/randomScenario";

export interface RandomScenarioInput {
  seed: number;
  region: LandscapeRegion;
  grid: LandscapeGrid;
  area: DispatchArea | null;
  base: StudioScenario;
  placement: IgnitionPlacement;
  /**
   * Road vertices over the whole board (every streets tile), for "Away from roads". `area` is
   * only the centre tile on a large board; absent: `area.nodes`.
   */
  roadNodes?: readonly (readonly [number, number])[] | null;
}

export interface RandomScenarioResult {
  scenario: StudioScenario;
  summary: string;
  /** The date and weather source it picked, as the shared world states them (docs/shared-world.md). */
  conditions: { startUtc: string; weather: WorldWeather };
}

/** Builds the scenario, or null when the board has no ground that can burn. */
export async function buildRandomScenario(input: RandomScenarioInput): Promise<RandomScenarioResult | null> {
  const { seed, region, grid, area, base, placement } = input;
  const roadNodes = input.roadNodes && input.roadNodes.length > 0 ? input.roadNodes : (area?.nodes ?? null);
  const draw = await drawRandomScenario({
    seed,
    regionId: region.id,
    regionName: region.name,
    grid,
    roadNodes,
    placement,
    horizonMinutes: base.settings.horizonMinutes,
  });
  if (!draw) return null;
  let ignitions: StudioScenario["ignitions"] = [];
  for (const ignition of draw.ignitions) {
    ignitions = [...ignitions, createIgnition(ignitions, ignition.at, ignition.startMinute)];
  }
  let settings: StudioScenario["settings"] = {
    ...base.settings,
    windSpeedMph: draw.windSpeedMph,
    windFromDegrees: draw.windFromDegrees,
    stochastic: { enabled: true, seed },
  };
  if (draw.series) {
    settings = {
      ...settings,
      weatherSeries: draw.series,
      moisture: { ...settings.moisture, ...draw.series.samples[0].moisture },
    };
  }
  // Observed weather has a real clock: T+0 (playback clock, day and night, aircraft daylight)
  // is the weather's first hour. A climatology analog's date is statistical, so it keeps the default.
  const observedStart = draw.observed ? pacificIso(draw.startUtc) : null;
  // The clock lives on the firefighting settings, so an observed start is stored there even when
  // firefighting is off (the Studio strips it: the playback clock reads startMsOf(firefighting ??
  // DEFAULT_FIREFIGHTING) and would otherwise fall back to the August default).
  const firefighting = observedStart
    ? { ...(base.firefighting ?? DEFAULT_FIREFIGHTING), startLocalIso: observedStart }
    : base.firefighting;
  return {
    scenario: {
      ...base,
      ...(firefighting ? { firefighting } : {}),
      name: `Random scenario, seed ${seed}`,
      ignitions,
      settings,
    },
    summary: draw.summary,
    conditions: { startUtc: draw.startUtc, weather: draw.weather },
  };
}
