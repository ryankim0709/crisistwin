/**
 * "Random scenario", page-agnostic: one seed (plus the region catalogue, a landscape grid, the
 * board's road nodes and the weather service's answer) picks the region, date, weather source
 * and 1–3 ignitions (RANDOM_FIRE_COUNT_WEIGHTS: 65% one, 25% two, 10% three; users can still place up to 5 by hand). Same seed, same board: same draw. Used by Simulation Studio and /dispatch
 * (studio/randomScenario.ts), /fire and the /live board, through RandomScenarioButton. All of
 * it is a simulated planning draw, not a forecast.
 *
 * Choices, labelled as assumptions in the UI:
 * - Ignition placement. Default "Away from roads": burnable ground at least 1 km from any road
 *   node (else the farthest sampled burnable ground, said so in the summary), so a fire has room and time to spread
 *   and the simulation can be checked against it. "Anywhere" is uniform over burnable ground.
 *   "Near homes" favours burnable ground within ~200 m of developed fuel (a wildland-urban-edge
 *   start; assumed 20x weight, not a fitted model). Real human-caused ignitions cluster near
 *   roads (Syphard et al. 2007; Syphard & Keeley 2015), which is why "away" is a deliberate
 *   test choice, not a claim about typical starts.
 *   No ignition lies within EDGE_MARGIN_METERS of the board edge (roads beyond the edge are not
 *   loaded, so "away" cannot be checked there either).
 *   Road nodes are whatever the caller passes (the Studio passes every vertex of every street
 *   edge, which can include service roads and tracks kept for apparatus access; the edges carry a
 *   roadClass but the node list does not), so "a road" here means any mapped street vertex.
 *   Extra fires lie within the run's fire-spacing limit (studio/bounds.ts) of the earlier ones.
 * - Weather: observed hours when the service has them. A series with hour 0 missing, or a gap
 *   longer than MAX_OBSERVED_GAP_HOURS, is not used as "observed": the next years are tried, then
 *   the climatology analog. A shorter gap is filled by interpolation and the summary says so.
 * - Date: the region's typical peak-season date (from /api/conditions/presets) plus or minus three
 *   weeks.
 */

import { carriesFire } from "../demo/fireField";
import type { LandscapeGrid } from "../fire/landscape";
import { CALIFORNIA_REGIONS } from "../fire/regions";
import { DEVELOPED_FUEL_CODE, type GeoPoint } from "../fire/spread";
import { HOLD_DIRECTION_GAP_MINUTES, weatherAtMinute, type FireWeatherSeries } from "../fire/weatherSeries";
import { MAX_WEATHER_HOURS } from "../fire/horizon";
import { MAX_IGNITION_EXTENT_METERS, pointsExtentMeters } from "../studio/bounds";
import { MAX_WIND_SPEED_MPH } from "../studio/contracts";
import {
  fetchConditionPresets,
  fetchConditions,
  weatherSeriesFromConditions,
  type Conditions,
  type RegionConditionsPresets,
} from "./conditions";
import type { WorldWeather, WorldWriter } from "./contracts";

const MERCATOR_HALF = 20037508.342789244;
const HISTORICAL_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const MAX_SEED = 2_147_483_647;

/**
 * Fires a random scenario starts: [count, share] pairs, never more than 3 (Studio still lets
 * users place up to MAX_ENABLED_IGNITIONS = 5 by hand). ASSUMPTION (no source; a test-scenario
 * knob, not a fire statistic): most wildfires start from a single ignition; 2-3 simultaneous
 * fires occur in wind-event power-line clusters (e.g. the 2017 North Bay fires); many fires at
 * once is a lightning-siege case, left for users to build by hand. Shares sum to 1.
 */
const RANDOM_FIRE_COUNT_WEIGHTS: readonly (readonly [number, number])[] = [[1, 0.65], [2, 0.25], [3, 0.10]];

/** Fire count for one uniform draw u in [0, 1): walks the cumulative weights. */
function fireCountFor(u: number): number {
  let acc = 0;
  for (const [count, share] of RANDOM_FIRE_COUNT_WEIGHTS) {
    acc += share;
    if (u < acc) return count;
  }
  return RANDOM_FIRE_COUNT_WEIGHTS[RANDOM_FIRE_COUNT_WEIGHTS.length - 1][0];
}

/**
 * ASSUMPTION (no source; a test-scenario knob): the longest stretch of unobserved weather a
 * random draw still calls "observed" (interpolated across). Hourly data with a longer hole, or
 * without the T+0 hour, is rejected for another year or the climatology analog.
 */
const MAX_OBSERVED_GAP_HOURS = 2;

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

/** The typed seed when it is a whole number 1–2^31−1, else a new one. */
export function resolveSeed(text: string): number {
  const typed = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(typed) && typed > 0 && typed <= MAX_SEED
    ? typed
    : Math.floor(Math.random() * (MAX_SEED - 1)) + 1;
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
/**
 * ASSUMPTION: no ignition within this distance of the board edge. The wind is not known when the
 * ignition is drawn (the weather is fetched at the drawn site), so one fixed margin covers all
 * directions: a fire 120 m from the edge hit it within 80 min and truncated its 24 h area
 * (seed 1356197356). 3 km leaves room for a few hours of spread in any direction; a
 * test-scenario choice, not a fitted value. Dropped (all candidates kept)
 * on boards too small to leave any ground inside it.
 */
const EDGE_MARGIN_METERS = 3000;
/**
 * Fires drawn together stay within the spacing one Studio run can cover (`spanProblem` refuses
 * more), less this slack for the box's snapping and latitude scaling; the generator must never
 * draw a scenario the page rejects. A loaded region board is not exempt: validation is
 * board-independent, so the limit applies there too.
 */
const SPACING_SLACK_METERS = 300;

interface Candidate {
  cell: number;
  point: GeoPoint;
  edge: boolean;
  nearRoadMeters: number | null;
}

function ignitionCandidates(
  grid: LandscapeGrid,
  roadNodes: readonly (readonly [number, number])[] | null,
  rand: () => number,
): Candidate[] {
  const out: Candidate[] = [];
  const cells = grid.width * grid.height;
  const reach = Math.max(1, Math.round(200 / grid.groundCellSizeMeters));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  // Road distance is known only inside the extent the road data covers (plus AWAY_METERS): a cell
  // beyond it may sit next to a road that was not loaded, so its distance stays unknown (null)
  // rather than "far" (the Studio once passed one road tile of a 2 x 2 board and called a fire
  // 246 m from a road "12 km away").
  let ext: [number, number, number, number] | null = null;
  if (roadNodes && roadNodes.length > 0) {
    ext = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lon, lat] of roadNodes) {
      ext = [Math.min(ext[0], lon), Math.min(ext[1], lat), Math.max(ext[2], lon), Math.max(ext[3], lat)];
    }
  }
  const margin = Math.ceil(EDGE_MARGIN_METERS / grid.groundCellSizeMeters);
  // A board too small to have ground inside the margin keeps the whole board.
  const inset = 2 * margin < Math.min(grid.width, grid.height) ? margin : 0;
  for (let tries = 0; tries < 4000 && out.length < 400; tries++) {
    const cell = Math.floor(rand() * cells);
    const code = grid.fuelCodes[cell];
    if (!carriesFire(code) || code === DEVELOPED_FUEL_CODE) continue;
    const col = cell % grid.width;
    const row = (cell - col) / grid.width;
    if (col < inset || row < inset || col >= grid.width - inset || row >= grid.height - inset) continue;
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
    const padLat = AWAY_METERS / 110_540;
    const padLon = AWAY_METERS / (111_320 * Math.cos((point.latitude * Math.PI) / 180));
    const inExtent =
      ext !== null &&
      point.longitude >= ext[0] - padLon && point.longitude <= ext[2] + padLon &&
      point.latitude >= ext[1] - padLat && point.latitude <= ext[3] + padLat;
    if (roadNodes && roadNodes.length > 0 && inExtent) {
      const mPerLon = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
      let best = Infinity;
      for (const [lon, lat] of roadNodes) {
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

function choose(items: Candidate[], placement: IgnitionPlacement, rand: () => number, first: boolean): Candidate {
  let pool = items;
  if (placement === "away" && items.some((c) => c.nearRoadMeters !== null)) {
    const far = items.filter((c) => (c.nearRoadMeters ?? 0) >= AWAY_METERS);
    if (far.length > 0) pool = far;
    else if (first) {
      // No sampled ground 1 km from a road: the farthest one (lowest cell on a tie), no draw.
      // The summary says so (whereText).
      return items.reduce((best, c) => {
        const d = c.nearRoadMeters ?? -1;
        const b = best.nearRoadMeters ?? -1;
        return d > b || (d === b && c.cell < best.cell) ? c : best;
      });
    } else {
      // Extra fires of the same draw: one of the farthest quarter, so they do not stack.
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

/**
 * Beaufort force names by wind speed in mph (US National Weather Service Beaufort Wind Scale:
 * 1-3 light air, 4-7 light breeze, 8-12 gentle breeze, 13-18 moderate breeze, 19-24 fresh breeze,
 * 25-31 strong breeze, 32-38 near gale, 39-46 gale, 47-54 strong gale, 55-63 storm, 64-72 violent
 * storm, 73+ hurricane force). Lower bounds, mph.
 */
const BEAUFORT_MPH: readonly (readonly [number, string])[] = [
  [73, "hurricane force"], [64, "violent storm"], [55, "storm"], [47, "strong gale"], [39, "gale"],
  [32, "near gale"], [25, "strong breeze"], [19, "fresh breeze"], [13, "moderate breeze"],
  [8, "gentle breeze"], [4, "light breeze"], [1, "light air"],
];
function windWords(speed: number): string {
  return BEAUFORT_MPH.find(([from]) => Math.round(speed) >= from)?.[1] ?? "calm";
}

function windPhrase(speed: number, from: number): string {
  return `${COMPASS[Math.round(from / 45) % 8]} ${Math.round(speed)} mph (${windWords(speed)})`;
}

export interface RandomDrawInput {
  seed: number;
  /** Catalogue region id for the season date (null: 15 Sep), and the name the summary uses. */
  regionId: string | null;
  regionName: string;
  grid: LandscapeGrid;
  /** WGS84 road nodes on the board, for "Away from roads"; null or empty: placed anywhere. */
  roadNodes: readonly (readonly [number, number])[] | null;
  placement: IgnitionPlacement;
  /** Run length, minutes: how many weather hours to fetch. */
  horizonMinutes: number;
  /** False: skip the weather service (the /live board picks its own preset). Default true. */
  fetchWeather?: boolean;
}

export interface RandomIgnition {
  at: GeoPoint;
  /** Minutes after the start (0 for the first fire). */
  startMinute: number;
}

export interface RandomDraw {
  seed: number;
  regionName: string;
  /** Minute 0 of the scenario, UTC ISO-8601: the observed hour's start, else the drawn date. */
  startUtc: string;
  /** The weather source, as the shared world states it (docs/shared-world.md). */
  weather: WorldWeather;
  /** The hour-by-hour series when the weather service answered; null for an assumed wind. */
  series: FireWeatherSeries | null;
  /** Peak-hour wind (or the assumed wind), mph and degrees from. */
  windSpeedMph: number;
  windFromDegrees: number;
  /** True when the series is observed weather (it then has a real clock). */
  observed: boolean;
  ignitions: RandomIgnition[];
  /** "12 Oct" / "12 Oct 2021" etc., as the summary states it. */
  dateText: string;
  /** ", away from roads (1.4 km)" etc. */
  whereText: string;
  /** Plain one-line summary (without "(simulated)"). */
  summary: string;
}

/** Draws the scenario, or null when the board has no ground that can burn. */
export async function drawRandomScenario(input: RandomDrawInput): Promise<RandomDraw | null> {
  const { seed, regionId, regionName, grid, roadNodes, placement, horizonMinutes } = input;
  const rand = seededRandom(seed);
  rand(); // the region draw (randomRegionId)

  // Date: typical peak-season date plus or minus three weeks, a seeded year and afternoon hour.
  let presets: RegionConditionsPresets | null = null;
  if (regionId) {
    try {
      presets = await fetchConditionPresets(regionId);
    } catch {
      presets = null;
    }
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

  // Ignitions: placed by the chosen mode. How many is random too: one weighted draw,
  // 1 fire 65%, 2 fires 25%, 3 fires 10%, never more (RANDOM_FIRE_COUNT_WEIGHTS, an ASSUMPTION).
  // Every fire after the first starts later half the time (20-90 min), like a second ignition.
  const candidates = ignitionCandidates(grid, roadNodes, rand);
  if (candidates.length === 0) return null;
  const count = fireCountFor(rand());
  const ignitions: RandomIgnition[] = [];
  const picked: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const pool = picked.length
      ? candidates.filter(
          (c) =>
            !picked.some((p) => p.cell === c.cell) &&
            pointsExtentMeters([...picked.map((p) => p.point), c.point]) <=
              MAX_IGNITION_EXTENT_METERS - SPACING_SLACK_METERS,
        )
      : candidates;
    if (pool.length === 0) break;
    const choice = choose(pool, placement, rand, picked.length === 0);
    picked.push(choice);
    const later = i > 0 && rand() < 0.5;
    ignitions.push({ at: choice.point, startMinute: later ? 20 + Math.floor(rand() * 70) : 0 });
  }
  // Named F1, F2... in this order by the pages: order by start time, not by draw (stable, so the
  // first fire at T+0 stays first).
  ignitions.sort((a, b) => a.startMinute - b.startMinute);

  const km = picked[0].nearRoadMeters === null ? null : (picked[0].nearRoadMeters / 1000).toFixed(1);
  const whereText =
    placement === "away"
      ? km === null
        ? ", placed anywhere (roads unavailable)"
        : picked[0].nearRoadMeters! < AWAY_METERS
          ? `, no ground ${AWAY_METERS / 1000} km from a road; farthest found ${km} km`
          : `, away from roads (${km} km)`
      : placement === "homes"
        ? ", near homes"
        : ", placed anywhere";
  const fires = `${ignitions.length} fire${ignitions.length > 1 ? "s" : ""}`;

  // Weather: observed hours for that date when the service has them, else the region's
  // climatology analog (derived); else an assumed wind.
  const hours = Math.min(MAX_WEATHER_HOURS, Math.ceil(horizonMinutes / 60) + 1);
  const first = ignitions[0].at;
  const site = { lon: first.longitude, lat: first.latitude, hours };
  const presetQuery = presets?.presets[0]?.query;
  let conditions: Conditions | null = null;
  let t0 = "";
  let pickedWeather: WorldWeather | null = null;
  let usedYear = year;
  let converted: ReturnType<typeof weatherSeriesFromConditions> = null;
  // Attempts: the drawn year, the next two years if its hours have holes, then the climatology
  // analog (derived, and labelled so). Observed data with hour 0 missing or a gap over
  // MAX_OBSERVED_GAP_HOURS is skipped, not passed off as observed.
  const attempts: { kind: "historical" | "climatology"; year: number }[] = [];
  if (input.fetchWeather !== false) {
    const at = HISTORICAL_YEARS.indexOf(year);
    for (let k = 0; k < 3; k++) {
      attempts.push({ kind: "historical", year: HISTORICAL_YEARS[(at + k) % HISTORICAL_YEARS.length] });
    }
    attempts.push({ kind: "climatology", year: 2025 });
  }
  for (const attempt of attempts) {
    try {
      t0 = startOf(attempt.year);
      conditions =
        attempt.kind === "historical"
          ? await fetchConditions({ ...site, mode: "historical_replay", startUtc: t0 })
          : await fetchConditions({
              ...site,
              mode: "climatology_percentile",
              startUtc: t0,
              percentile,
              ...(presetQuery?.sectorFromDeg ? { sectorFromDeg: presetQuery.sectorFromDeg } : {}),
            });
    } catch {
      conditions = null;
    }
    converted = conditions ? weatherSeriesFromConditions(conditions, t0, { maxWindMph: MAX_WIND_SPEED_MPH }) : null;
    const holes = converted?.series.missing;
    const usable =
      converted !== null &&
      (attempt.kind === "climatology" ||
        (holes !== undefined && !holes.startMissing && holes.longestGapHours <= MAX_OBSERVED_GAP_HOURS));
    if (converted && usable) {
      usedYear = attempt.year;
      pickedWeather =
        attempt.kind === "historical"
          ? { mode: "historical_replay" }
          : { mode: "climatology_percentile", percentile };
      break;
    }
    conditions = null;
    converted = null;
  }

  if (!converted || !pickedWeather) {
    const dateText = `${dateLabel} (assumed date)`;
    const weatherWords = `assumed wind ${windPhrase(fallbackSpeed, fallbackFrom)} (weather unavailable)`;
    return {
      seed,
      regionName,
      startUtc: startOf(year),
      weather: { mode: "assumed", windSpeedMph: fallbackSpeed, windFromDegrees: fallbackFrom },
      series: null,
      windSpeedMph: fallbackSpeed,
      windFromDegrees: fallbackFrom,
      observed: false,
      ignitions,
      dateText,
      whereText,
      summary: `${regionName}, ${dateText}, ${fires}${whereText}, ${weatherWords}, seed ${seed}`,
    };
  }
  const peak = peakOf(converted.series);
  const observed = conditions!.evidence.weather === "observed";
  const start = weatherAtMinute(converted.series, 0);
  const startPhrase = windPhrase(start.windSpeedMph, start.windFromDegrees);
  const peakPhrase = windPhrase(peak.speed, peak.from);
  const gap = converted.series.missing;
  const gapNote =
    gap && gap.hours > 0
      ? `; weather missing for ${gap.hours} h, longest gap ${gap.longestGapHours} h, filled by interpolation (wind direction held across gaps over ${HOLD_DIRECTION_GAP_MINUTES / 60} h)`
      : "";
  const weatherWords =
    `wind ${startPhrase} at T+0, peak ${startPhrase === peakPhrase ? "the same" : peakPhrase} ` +
    `(${observed ? "observed" : "climatology analog"}${gapNote})`;
  const dateText = observed ? `${dateLabel} ${usedYear}` : `${dateLabel} (typical season)`;
  return {
    seed,
    regionName,
    startUtc: t0,
    weather: pickedWeather,
    series: converted.series,
    windSpeedMph: Math.round(peak.speed * 10) / 10,
    windFromDegrees: peak.from,
    observed,
    ignitions,
    dateText,
    whereText,
    summary: `${regionName}, ${dateText}, ${fires}${whereText}, ${weatherWords}, seed ${seed}`,
  };
}

// ---- "Random scenario from Studio · seed N" on the other tabs' sync line ----
// The world itself has no field for it (docs/shared-world.md); the tab that drew a scenario notes
// it in localStorage, which other tabs of the same browser hear through the `storage` event.

export interface RandomNote {
  by: WorldWriter;
  seed: number;
}
const NOTE_KEY = "crisistwin.world.random";

export function announceRandom(by: WorldWriter, seed: number): void {
  try {
    window.localStorage.setItem(NOTE_KEY, JSON.stringify({ by, seed } satisfies RandomNote));
  } catch {
    // Storage blocked: the other tabs just show the usual sync line.
  }
}

export function readRandomNote(): RandomNote | null {
  try {
    const raw = window.localStorage.getItem(NOTE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<RandomNote>) : null;
    return parsed && typeof parsed.by === "string" && typeof parsed.seed === "number"
      ? (parsed as RandomNote)
      : null;
  } catch {
    return null;
  }
}

export const RANDOM_NOTE_KEY = NOTE_KEY;
