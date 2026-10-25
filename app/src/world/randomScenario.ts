/**
 * "Random scenario", page-agnostic: one seed (plus the region catalogue, a landscape grid, the
 * board's road nodes and the weather service's answer) picks the region, date, weather source
 * and 1–3 ignitions (RANDOM_FIRE_COUNT_WEIGHTS: 65% one, 25% two, 10% three; users can still place up to 5 by hand). Same seed, same board: same draw. Used by Simulation Studio and /dispatch
 * (studio/randomScenario.ts), /fire and the /live board, through RandomScenarioButton. All of
 * it is a simulated planning draw, not a forecast.
 *
 * Choices, labelled as assumptions in the UI:
 * - Ignition placement, drawn uniformly over every eligible cell of the board (not a sample), so
 *   the seed moves the fire across the whole board: burnable, not developed, inside the edge
 *   margin, and with enough burnable ground around it to spread (MIN_BURNABLE_SHARE).
 *   Default "Away from roads": ground at least 1 km from any road node (when that is under a
 *   quarter of the ground, the farthest quarter instead, said so in the summary: AWAY_MIN_SHARE),
 *   so a fire has room and time to spread and the simulation can be checked against it.
 *   "Anywhere" is uniform over that ground. The seed is hashed first (mixSeed).
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
import { DEVELOPED_FUEL_CODE, cellAt, type GeoPoint } from "../fire/spread";
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

/**
 * The seed hashed (murmur3's 32-bit finaliser, a bijection) before it seeds the scenario stream,
 * so neighbouring seeds (1, 2, 3 ...) start unrelated streams. Seeds drawn before this mixing
 * was added give different scenarios now.
 */
export function mixSeed(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The random stream of one scenario seed. */
function scenarioRandom(seed: number): () => number {
  return seededRandom(mixSeed(seed));
}

/** The region a seed picks from the catalogue. The first draw of the seed's sequence. */
export function randomRegionId(seed: number): string {
  const rand = scenarioRandom(seed);
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

/** Ground within this distance of developed fuel counts as "near homes". */
const NEAR_HOMES_METERS = 200;
/** "Near homes" weight of other burnable ground against 1 for ground near homes (the 20x above). */
const AWAY_FROM_HOMES_WEIGHT = 0.05;
/**
 * ASSUMPTION (a demo-quality filter, not a fitted value): an ignition cell needs at least this
 * share of fire-carrying cells within SPREAD_WINDOW_METERS (a square window), so a draw does not
 * land on a burnable speck in a lake, a quarry or a paved block where the fire dies at once.
 * Dropped when no ground on the board passes it.
 */
const SPREAD_WINDOW_METERS = 150;
const MIN_BURNABLE_SHARE = 0.6;

/**
 * Ground metres from every cell to the nearest seed cell (Infinity on a board without seeds):
 * nearest-seed vector propagation in two 8-neighbour sweeps (8SSEDT; Danielsson 1980), within a
 * fraction of a cell of the exact Euclidean distance.
 */
function distanceToSeeds(grid: LandscapeGrid, seeds: Uint8Array): Float32Array {
  const { width: w, height: h } = grid;
  const n = w * h;
  const sx = new Int32Array(n).fill(-1);
  const sy = new Int32Array(n);
  const d2 = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    if (!seeds[i]) continue;
    sx[i] = i % w;
    sy[i] = (i - sx[i]) / w;
    d2[i] = 0;
  }
  const relax = (col: number, row: number, nc: number, nr: number) => {
    if (nc < 0 || nr < 0 || nc >= w || nr >= h) return;
    const from = nr * w + nc;
    if (sx[from] < 0) return;
    const dx = sx[from] - col;
    const dy = sy[from] - row;
    const cand = dx * dx + dy * dy;
    const at = row * w + col;
    if (cand < d2[at]) {
      d2[at] = cand;
      sx[at] = sx[from];
      sy[at] = sy[from];
    }
  };
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      relax(col, row, col - 1, row);
      relax(col, row, col - 1, row - 1);
      relax(col, row, col, row - 1);
      relax(col, row, col + 1, row - 1);
    }
    for (let col = w - 1; col >= 0; col--) relax(col, row, col + 1, row);
  }
  for (let row = h - 1; row >= 0; row--) {
    for (let col = w - 1; col >= 0; col--) {
      relax(col, row, col + 1, row);
      relax(col, row, col + 1, row + 1);
      relax(col, row, col, row + 1);
      relax(col, row, col - 1, row + 1);
    }
    for (let col = 0; col < w; col++) relax(col, row, col - 1, row);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(d2[i]) * grid.groundCellSizeMeters;
  return out;
}

/** Exact ground metres from a point to the nearest road node (equirectangular, as before). */
function nearestRoadMeters(point: GeoPoint, roadNodes: readonly (readonly [number, number])[]): number {
  const mPerLon = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
  let best = Infinity;
  for (const [lon, lat] of roadNodes) {
    const dx = (lon - point.longitude) * mPerLon;
    const dy = (lat - point.latitude) * 110_540;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * Every cell an ignition may start on, with what the placement modes need. Every eligible cell
 * of the board is in `cells` (not a sample), so a draw is uniform over the whole valid ground.
 */
interface IgnitionGround {
  cells: Int32Array;
  /** Per board cell: ground metres to the nearest road node; NaN where roads are not known. */
  roadMeters: Float32Array | null;
  /** Per board cell: ground metres to developed fuel. */
  homesMeters: Float32Array;
}

function ignitionGround(
  grid: LandscapeGrid,
  roadNodes: readonly (readonly [number, number])[] | null,
): IgnitionGround {
  const { width: w, height: h } = grid;
  const n = w * h;
  const carries = new Uint8Array(n);
  const developed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const code = grid.fuelCodes[i];
    carries[i] = carriesFire(code) ? 1 : 0;
    developed[i] = code === DEVELOPED_FUEL_CODE ? 1 : 0;
  }
  const homesMeters = distanceToSeeds(grid, developed);

  // Road distance is known only inside the extent the road data covers (plus AWAY_METERS): a cell
  // beyond it may sit next to a road that was not loaded, so its distance stays unknown (NaN)
  // rather than "far" (the Studio once passed one road tile of a 2 x 2 board and called a fire
  // 246 m from a road "12 km away"). Nodes off the board are left out of the field: they are
  // farther than EDGE_MARGIN_METERS from any inset cell, and the picked cell's distance in the
  // summary is measured to every node.
  let roadMeters: Float32Array | null = null;
  if (roadNodes && roadNodes.length > 0) {
    let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
    const seeds = new Uint8Array(n);
    for (const [lon, lat] of roadNodes) {
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
      const cell = cellAt(grid, { longitude: lon, latitude: lat });
      if (cell >= 0) seeds[cell] = 1;
    }
    const padLat = AWAY_METERS / 110_540;
    const padLon = AWAY_METERS / (111_320 * Math.cos((((south + north) / 2) * Math.PI) / 180));
    roadMeters = distanceToSeeds(grid, seeds);
    for (let i = 0; i < n; i++) {
      const p = lonLatOfCell(grid, i);
      const inExtent =
        p.longitude >= west - padLon && p.longitude <= east + padLon &&
        p.latitude >= south - padLat && p.latitude <= north + padLat;
      if (!inExtent) roadMeters[i] = NaN;
    }
  }

  // Share of fire-carrying cells in a square window (summed-area table).
  const k = Math.max(1, Math.round(SPREAD_WINDOW_METERS / grid.groundCellSizeMeters));
  const sum = new Int32Array((w + 1) * (h + 1));
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      sum[(row + 1) * (w + 1) + col + 1] =
        carries[row * w + col] + sum[row * (w + 1) + col + 1] + sum[(row + 1) * (w + 1) + col] - sum[row * (w + 1) + col];
    }
  }
  const share = (col: number, row: number) => {
    const c0 = Math.max(0, col - k), r0 = Math.max(0, row - k);
    const c1 = Math.min(w, col + k + 1), r1 = Math.min(h, row + k + 1);
    const total = sum[r1 * (w + 1) + c1] - sum[r0 * (w + 1) + c1] - sum[r1 * (w + 1) + c0] + sum[r0 * (w + 1) + c0];
    return total / ((c1 - c0) * (r1 - r0));
  };

  const margin = Math.ceil(EDGE_MARGIN_METERS / grid.groundCellSizeMeters);
  // A board too small to have ground inside the margin keeps the whole board.
  const inset = 2 * margin < Math.min(w, h) ? margin : 0;
  const burnable: number[] = [];
  const spreadable: number[] = [];
  for (let row = inset; row < h - inset; row++) {
    for (let col = inset; col < w - inset; col++) {
      const cell = row * w + col;
      if (!carries[cell] || developed[cell]) continue;
      burnable.push(cell);
      if (share(col, row) >= MIN_BURNABLE_SHARE) spreadable.push(cell);
    }
  }
  return { cells: Int32Array.from(spreadable.length > 0 ? spreadable : burnable), roadMeters, homesMeters };
}

/**
 * ASSUMPTION (a test-scenario knob, not a fitted value): "Away from roads" draws from the ground
 * at least AWAY_METERS from a road, unless that is under this share of the ground; then from the
 * farthest share instead. Mapped roads, service roads and tracks are dense in the Bay Area hills:
 * on the Berkeley Hills boards 0.0-0.03% of the burnable ground is 1 km from a road vertex and
 * the farthest quarter starts at about 150 m, so a strict 1 km rule put every seed's fire on the
 * same few cells.
 */
const AWAY_MIN_SHARE = 0.25;

interface Pick {
  cell: number;
  /**
   * "Away from roads" fell back to the farthest AWAY_MIN_SHARE of the ground: "none" when no
   * ground is AWAY_METERS from a road, "little" when some is but under that share.
   */
  fallback: "none" | "little" | null;
}

function choose(
  ground: IgnitionGround,
  pool: ArrayLike<number>,
  placement: IgnitionPlacement,
  rand: () => number,
  cellMeters: number,
): Pick {
  const uniform = (cells: ArrayLike<number>) => cells[Math.min(cells.length - 1, Math.floor(rand() * cells.length))];
  const roads = ground.roadMeters;
  if (placement === "away" && roads) {
    const known: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < pool.length; i++) {
      const d = roads[pool[i]];
      if (Number.isNaN(d)) continue;
      known.push(pool[i]);
      // One cell of slack: the field is quantised to cells, the summary's distance is exact.
      if (d >= AWAY_METERS + cellMeters) far.push(pool[i]);
    }
    const share = Math.max(1, Math.ceil(known.length * AWAY_MIN_SHARE));
    if (far.length > 0 && far.length >= share) return { cell: uniform(far), fallback: null };
    if (known.length > 0) {
      // Too little ground 1 km from a road: one of the farthest quarter (the summary says so),
      // drawn uniformly so the seed still moves the fire across the board.
      known.sort((a, b) => roads[b] - roads[a] || a - b);
      return { cell: uniform(known.slice(0, share)), fallback: far.length > 0 ? "little" : "none" };
    }
  } else if (placement === "homes") {
    const weight = (cell: number) => (ground.homesMeters[cell] <= NEAR_HOMES_METERS ? 1 : AWAY_FROM_HOMES_WEIGHT);
    let total = 0;
    for (let i = 0; i < pool.length; i++) total += weight(pool[i]);
    let x = rand() * total;
    for (let i = 0; i < pool.length; i++) {
      x -= weight(pool[i]);
      if (x <= 0) return { cell: pool[i], fallback: null };
    }
    return { cell: pool[pool.length - 1], fallback: null };
  }
  return { cell: uniform(pool), fallback: null };
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
  const rand = scenarioRandom(seed);
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
  const ground = ignitionGround(grid, roadNodes);
  if (ground.cells.length === 0) return null;
  const count = fireCountFor(rand());
  const ignitions: RandomIgnition[] = [];
  const picked: (Pick & { point: GeoPoint })[] = [];
  const spacing = MAX_IGNITION_EXTENT_METERS - SPACING_SLACK_METERS;
  const reachCells = Math.ceil(spacing / grid.groundCellSizeMeters) + 1;
  for (let i = 0; i < count; i++) {
    let pool: ArrayLike<number> = ground.cells;
    if (picked.length > 0) {
      // Within the spacing of the fires so far: a cheap row/column box first, then the exact test.
      const cols = picked.map((p) => p.cell % grid.width);
      const rows = picked.map((p) => Math.floor(p.cell / grid.width));
      const [c0, c1] = [Math.max(...cols) - reachCells, Math.min(...cols) + reachCells];
      const [r0, r1] = [Math.max(...rows) - reachCells, Math.min(...rows) + reachCells];
      const near: number[] = [];
      for (const cell of ground.cells) {
        const col = cell % grid.width;
        const row = (cell - col) / grid.width;
        if (col < c0 || col > c1 || row < r0 || row > r1 || picked.some((p) => p.cell === cell)) continue;
        if (pointsExtentMeters([...picked.map((p) => p.point), lonLatOfCell(grid, cell)]) <= spacing) near.push(cell);
      }
      pool = near;
    }
    if (pool.length === 0) break;
    const choice = choose(ground, pool, placement, rand, grid.groundCellSizeMeters);
    const point = lonLatOfCell(grid, choice.cell);
    picked.push({ ...choice, point });
    const later = i > 0 && rand() < 0.5;
    ignitions.push({ at: point, startMinute: later ? 20 + Math.floor(rand() * 70) : 0 });
  }
  // Named F1, F2... in this order by the pages: order by start time, not by draw (stable, so the
  // first fire at T+0 stays first).
  ignitions.sort((a, b) => a.startMinute - b.startMinute);

  const roadKnown = roadNodes !== null && ground.roadMeters !== null && !Number.isNaN(ground.roadMeters[picked[0].cell]);
  const km = roadKnown ? (nearestRoadMeters(picked[0].point, roadNodes!) / 1000).toFixed(1) : null;
  const whereText =
    placement === "away"
      ? km === null
        ? ", placed anywhere (roads unavailable)"
        : picked[0].fallback
          ? `, ${picked[0].fallback === "none" ? "no" : "little"} ground ${AWAY_METERS / 1000} km from a road; in the farthest quarter (${km} km)`
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
