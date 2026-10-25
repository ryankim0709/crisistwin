/**
 * "Random scenario" for Simulation Studio: everything below is a pure function of one seed (plus
 * the region board and its roads, and the weather service's answer). Same seed, same region,
 * same date, ignitions and weather choice. All of it is a simulated planning draw, not a forecast.
 *
 * Choices, labelled as assumptions in the UI:
 * - Ignition placement. Default "Away from roads": burnable ground at least 1 km from any road
 *   node (else the farthest burnable ground on the board), so a fire has room and time to spread
 *   and the simulation can be checked against it. "Anywhere" is uniform over burnable ground.
 *   "Near homes" favours burnable ground within ~200 m of developed fuel (a wildland-urban-edge
 *   start; assumed 20x weight, not a fitted model). Real human-caused ignitions cluster near
 *   roads (Syphard et al. 2007; Syphard & Keeley 2015), which is why "away" is a deliberate
 *   test choice, not a claim about typical starts.
 * - Date: the region's typical peak-season date (from /api/conditions/presets) plus or minus three
 *   weeks.
 */

import type { DispatchArea } from "../dispatch/area";
import { carriesFire } from "../demo/fireField";
import type { LandscapeGrid } from "../fire/landscape";
import { CALIFORNIA_REGIONS, type LandscapeRegion } from "../fire/regions";
import { DEVELOPED_FUEL_CODE, type GeoPoint } from "../fire/spread";
import type { FireWeatherSeries } from "../fire/weatherSeries";
import {
  fetchConditionPresets,
  fetchConditions,
  weatherSeriesFromConditions,
  type Conditions,
  type RegionConditionsPresets,
} from "../world/conditions";
import type { WorldWeather } from "../world/contracts";
import { MAX_WIND_SPEED_MPH, type StudioScenario } from "./contracts";
import { createIgnition } from "./scenario";

const MERCATOR_HALF = 20037508.342789244;
const HISTORICAL_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Small seeded generator (mulberry32); uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The region a seed picks from the catalogue. The first draw of the seed's sequence. */
export function randomRegionId(seed: number): string {
  const rand = seededRandom(seed);
  return CALIFORNIA_REGIONS[Math.floor(rand() * CALIFORNIA_REGIONS.length)].id;
}

function lonLatOfCell(grid: LandscapeGrid, cell: number): GeoPoint {
  const col = cell % grid.width;
  const row = (cell - col) / grid.width;
  const x = grid.originX + col * grid.cellSizeX;
  const y = grid.originY + row * grid.cellSizeY;
  return {
    longitude: (x / MERCATOR_HALF) * 180,
    latitude: (Math.atan(Math.exp((y / MERCATOR_HALF) * Math.PI)) * 360) / Math.PI - 90,
  };
}

export type IgnitionPlacement = "away" | "anywhere" | "homes";
export const PLACEMENT_LABELS: Record<IgnitionPlacement, string> = {
  away: "Away from roads",
  anywhere: "Anywhere",
  homes: "Near homes",
};
const AWAY_METERS = 1000;

interface Candidate {
  cell: number;
  point: GeoPoint;
  edge: boolean;
  nearRoadMeters: number | null;
}

function ignitionCandidates(
  grid: LandscapeGrid,
  area: DispatchArea | null,
  rand: () => number,
): Candidate[] {
  const out: Candidate[] = [];
  const cells = grid.width * grid.height;
  const reach = Math.max(1, Math.round(200 / grid.groundCellSizeMeters));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (let tries = 0; tries < 4000 && out.length < 400; tries++) {
    const cell = Math.floor(rand() * cells);
    const code = grid.fuelCodes[cell];
    if (!carriesFire(code) || code === DEVELOPED_FUEL_CODE) continue;
    const col = cell % grid.width;
    const row = (cell - col) / grid.width;
    let edge = false;
    for (const [dx, dy] of dirs) {
      for (const k of [Math.ceil(reach / 2), reach]) {
        const c = col + dx * k;
        const r = row + dy * k;
        if (c >= 0 && r >= 0 && c < grid.width && r < grid.height && grid.fuelCodes[r * grid.width + c] === DEVELOPED_FUEL_CODE) edge = true;
      }
    }
    const point = lonLatOfCell(grid, cell);
    let nearRoadMeters: number | null = null;
    if (area && area.nodes.length > 0) {
      const mPerLon = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
      let best = Infinity;
      for (const [lon, lat] of area.nodes) {
        const dx = (lon - point.longitude) * mPerLon;
        const dy = (lat - point.latitude) * 110_540;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      nearRoadMeters = Math.sqrt(best);
    }
    out.push({ cell, point, edge, nearRoadMeters });
  }
  return out;
}

function choose(items: Candidate[], placement: IgnitionPlacement, rand: () => number): Candidate {
  let pool = items;
  if (placement === "away" && items.some((c) => c.nearRoadMeters !== null)) {
    const far = items.filter((c) => (c.nearRoadMeters ?? 0) >= AWAY_METERS);
    if (far.length > 0) pool = far;
    else {
      // No ground 1 km from a road on this board: the farthest quarter.
      const sorted = [...items].sort((x, y) => (y.nearRoadMeters ?? 0) - (x.nearRoadMeters ?? 0));
      pool = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4)));
    }
  } else if (placement === "homes") {
    const total = items.reduce((sum, c) => sum + (c.edge ? 1 : 0.05), 0);
    let x = rand() * total;
    for (const c of items) {
      x -= c.edge ? 1 : 0.05;
      if (x <= 0) return c;
    }
    return items[items.length - 1];
  }
  return pool[Math.floor(rand() * pool.length)];
}

const pad = (n: number) => String(n).padStart(2, "0");

function peakOf(series: FireWeatherSeries): { speed: number; from: number } {
  let best = series.samples[0];
  for (const sample of series.samples) if (sample.windSpeedMph > best.windSpeedMph) best = sample;
  return { speed: best.windSpeedMph, from: best.windFromDegrees };
}

function windWords(speed: number): string {
  return speed >= 30 ? "strong" : speed >= 18 ? "moderate" : "light";
}

export interface RandomScenarioInput {
  seed: number;
  region: LandscapeRegion;
  grid: LandscapeGrid;
  area: DispatchArea | null;
  base: StudioScenario;
  placement: IgnitionPlacement;
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
  const rand = seededRandom(seed);
  rand(); // the region draw (randomRegionId)

  // Date: typical peak-season date plus or minus three weeks, a seeded year and afternoon hour.
  let presets: RegionConditionsPresets | null = null;
  try {
    presets = await fetchConditionPresets(region.id);
  } catch {
    presets = null;
  }
  const [mm, dd] = (presets?.typicalSeasonDate ?? "09-15").split("-").map(Number);
  const dayOffset = Math.floor(rand() * 43) - 21;
  const year = HISTORICAL_YEARS[Math.floor(rand() * HISTORICAL_YEARS.length)];
  const hourUtc = 20 + Math.floor(rand() * 4);
  const percentile = [90, 95, 97][Math.floor(rand() * 3)];
  const fallbackSpeed = 10 + Math.round(rand() * 25);
  const fallbackFrom = Math.floor(rand() * 8) * 45;
  const day = new Date(Date.UTC(year, mm - 1, dd + dayOffset));
  const dateLabel = `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  const startOf = (y: number) => `${y}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${pad(hourUtc)}:00:00Z`;

  // Ignitions: placed by the chosen mode, one or two, the second sometimes later.
  const candidates = ignitionCandidates(grid, area, rand);
  if (candidates.length === 0) return null;
  const count = rand() < 0.35 ? 2 : 1;
  const laterSecond = rand() < 0.5;
  const laterMinute = 20 + Math.floor(rand() * 70);
  let ignitions: StudioScenario["ignitions"] = [];
  const picked: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const pool = picked.length ? candidates.filter((c) => !picked.some((p) => p.cell === c.cell)) : candidates;
    const choice = choose(pool, placement, rand);
    picked.push(choice);
    ignitions = [...ignitions, createIgnition(ignitions, choice.point, i === 1 && laterSecond ? laterMinute : 0)];
  }

  // Weather: observed hours for that date when the service has them, else the region's
  // climatology analog (derived); else an assumed wind.
  const hours = Math.ceil(base.settings.horizonMinutes / 60) + 1;
  const first = ignitions[0].location;
  const site = { lon: first.longitude, lat: first.latitude, hours };
  const presetQuery = presets?.presets[0]?.query;
  let conditions: Conditions | null = null;
  let t0 = "";
  let pickedWeather: WorldWeather | null = null;
  for (const attempt of ["historical", "climatology"] as const) {
    try {
      if (attempt === "historical") {
        t0 = startOf(year);
        conditions = await fetchConditions({ ...site, mode: "historical_replay", startUtc: t0 });
      } else {
        t0 = startOf(2025);
        conditions = await fetchConditions({
          ...site,
          mode: "climatology_percentile",
          startUtc: t0,
          percentile,
          ...(presetQuery?.sectorFromDeg ? { sectorFromDeg: presetQuery.sectorFromDeg } : {}),
        });
      }
    } catch {
      conditions = null;
    }
    if (conditions && weatherSeriesFromConditions(conditions, t0, { maxWindMph: MAX_WIND_SPEED_MPH })) {
      pickedWeather =
        attempt === "historical"
          ? { mode: "historical_replay" }
          : { mode: "climatology_percentile", percentile };
      break;
    }
    conditions = null;
  }
  const converted = conditions ? weatherSeriesFromConditions(conditions, t0, { maxWindMph: MAX_WIND_SPEED_MPH }) : null;

  let settings: StudioScenario["settings"] = {
    ...base.settings,
    windSpeedMph: fallbackSpeed,
    windFromDegrees: fallbackFrom,
    stochastic: { enabled: true, seed },
  };
  let weatherWords = `assumed ${windWords(fallbackSpeed)} ${COMPASS[Math.round(fallbackFrom / 45) % 8]} wind (weather unavailable)`;
  let dateText = `${dateLabel} (assumed date)`;
  if (converted) {
    const peak = peakOf(converted.series);
    const evidence = conditions!.evidence.weather;
    settings = {
      ...settings,
      weatherSeries: converted.series,
      windSpeedMph: Math.round(peak.speed * 10) / 10,
      windFromDegrees: peak.from,
      moisture: { ...settings.moisture, ...converted.series.samples[0].moisture },
    };
    weatherWords = `${windWords(peak.speed)} ${COMPASS[Math.round(peak.from / 45) % 8]} wind, ${Math.round(peak.speed)} mph (${evidence === "observed" ? "observed" : "climatology analog"})`;
    dateText = evidence === "observed" ? `${dateLabel} ${year}` : `${dateLabel} (typical season)`;
  }

  const km = picked[0].nearRoadMeters === null ? null : (picked[0].nearRoadMeters / 1000).toFixed(1);
  const where =
    placement === "away"
      ? km === null ? ", placed anywhere (roads unavailable)" : `, away from roads (${km} km)`
      : placement === "homes"
        ? ", near homes"
        : ", placed anywhere";
  const summary = `${region.name}, ${dateText}, ${ignitions.length} fire${ignitions.length > 1 ? "s" : ""}${where}, ${weatherWords}, seed ${seed}`;
  return {
    scenario: { ...base, name: `Random scenario, seed ${seed}`, ignitions, settings },
    summary,
    conditions:
      converted && pickedWeather
        ? { startUtc: t0, weather: pickedWeather }
        : {
            startUtc: startOf(year),
            weather: { mode: "assumed", windSpeedMph: fallbackSpeed, windFromDegrees: fallbackFrom },
          },
  };
}
