/**
 * The /demo board's fire spread: Simulation Studio's and /fire's cell solver
 * (fire/spread.ts simulateScheduledFireSpread, Rothermel 1972 surface spread with crown fire,
 * ember spotting and structure-to-structure spread at their defaults) on the drill's LANDFIRE
 * landscape, and what the board reads back from its arrival field. Pure: no React, worker or
 * network. The worker (fireSolver.worker.ts) runs `solveFireField`; the board (model.ts)
 * builds the request and applies the result. See docs/command-demo-realism.md.
 *
 * Time. Solver minutes are board minutes (the board's T+0 is the solver's T+0), so the
 * arrival field reads directly against `board.minute`.
 *
 * Wind. The solver takes one wind per run; the board's wind is an hourly series. Each solve
 * uses the wind of the hour it starts in, for its whole lookahead. When the hourly sample (or
 * the fuel moisture) changes, the board re-solves from that minute, continuing from the burned
 * state with the solver's progress-preserving resume (spread.ts ResumeFrom): cells already
 * burned keep their times, steps in progress finish at the new rate. New fires and containment
 * re-solve the same way, which with unchanged weather reproduces an uninterrupted run exactly.
 * So the burned footprint follows the hourly wind; forecasts (zone ETAs, containment
 * estimates) assume the current hour's wind persists.
 *
 * Units: minutes are board minutes; distances ground metres; areas square metres here
 * (hectares on the board); wind mph at the solver boundary (FireSettings), m/s on the board;
 * flame lengths feet.
 */

import { isBurnable } from "../fire/fuelModels";
import type { LandscapeGrid } from "../fire/landscape";
import {
  DEFAULT_MIDFLAME_ADJUSTMENT,
  DEFAULT_SPOTTING,
  DEFAULT_STRUCTURE_SPREAD,
  DEVELOPED_FUEL_CODE,
  FIRE_STEP_MINUTES,
  NonBurnableIgnitionError,
  cellAt,
  simulateScheduledFireSpread,
  type CellBehaviour,
} from "../fire/spread";
import type { IgnitionSource } from "../fire/scheduledTypes";
import type { StochasticRunSummary, StochasticSpreadOptions } from "../fire/stochastic";
import type { LonLat } from "../live/types";
import { METERS_PER_SECOND_PER_MPH, moistureOf, type MoistureId } from "./realism";

/**
 * How far past the solve minute each solve looks, minutes. Six hours: three times the board's
 * FORECAST_MINUTES window, so a solve stays valid for 4 h of board time with no events (the
 * hourly wind re-solves sooner in practice). Measured cost on Berkeley Hills & Tilden (507 x 507
 * cells): 0.1-0.3 s per solve with six fires at 11-25 mph.
 */
export const LOOKAHEAD_MINUTES = 360;
/** `ScheduledFireRun.sourceIndexByCell` is an Int8Array, so a run carries at most 127 sources. */
export const MAX_SOLVER_SOURCES = 120;
/**
 * Lattice-to-smooth perimeter factor: a curve drawn as cell edges (a staircase) is longer than
 * the curve by |cos θ| + |sin θ| at local orientation θ, which averages 4/π over uniformly
 * distributed orientations (Cauchy-Crofton). So the edge count times the cell size times π/4
 * estimates the smooth perimeter. A mathematical identity, not a fitted value; for an elongated
 * fire aligned with the grid it underestimates by up to 21%, diagonal to it it overestimates
 * by up to 11%.
 */
export const LATTICE_PERIMETER_TO_SMOOTH = Math.PI / 4;

/** One board fire as a solver source. */
export interface SolveSource {
  fireId: string;
  location: LonLat;
  /** Integer board minute the solver lets it spread from (ceil of its ignition minute). */
  startMinute: number;
  /** Board minute it was contained or closed, after which it spreads no further; null = burning. */
  stopMinute: number | null;
}

export interface FireSolveRequest {
  /** Weather and fire set this solve answers (model.ts solveKey). */
  key: string;
  /** Resume minute (the board minute of the request), or null for a fresh field. */
  fromMinute: number | null;
  horizonMinutes: number;
  /** Open 20-ft wind, m/s, and the bearing it blows FROM, degrees true. */
  windSpeedMetersPerSecond: number;
  windFromDegrees: number;
  moisture: MoistureId;
  sources: SolveSource[];
  /** The earlier field, remapped to `sources` (-1 = burned by a fire no longer listed). */
  resume: {
    arrivalMinutes: Float32Array;
    sourceIndexByCell: Int8Array;
    earlierBehaviour: CellBehaviour;
    earlierWindSpeedMph: number;
  } | null;
  /**
   * Seeded stochastic spread (fire/stochastic.ts), off when absent. Keep the seed fixed for a
   * board: draws are keyed on cells and simulation minutes, so resumed solves with one seed
   * continue one realisation. Include it in `key` when a caller sets it.
   */
  stochastic?: StochasticSpreadOptions | null;
}

export interface FireSolveResult {
  key: string;
  fromMinute: number | null;
  horizonMinutes: number;
  windSpeedMetersPerSecond: number;
  windFromDegrees: number;
  windSpeedMph: number;
  moisture: MoistureId;
  sources: SolveSource[];
  /** Arrival per cell, board minutes; Infinity where no fire arrives within the horizon. */
  arrivalMinutes: Float32Array;
  /** Index into `sources` of the fire that reached each cell first, -1 where none (or burned ground of a fire no longer listed). */
  sourceIndexByCell: Int8Array;
  /** The solver's per-cell behaviour at this solve's wind and moisture. */
  behaviour: CellBehaviour;
  /** Per source: its cells in arrival order, and their arrivals (board minutes). */
  cellsBySource: Int32Array[];
  arrivalBySource: Float32Array[];
  /** Board minute of `perimeterBySource[s][0]`; one sample per whole minute to the horizon. */
  perimeterStartMinute: number;
  /** Per source, metres of fire edge facing ground that can still burn, at each whole minute. */
  perimeterBySource: Float32Array[];
  /** Present when the solve was stochastic: seed, applied options and what they did (simulated). */
  stochastic?: StochasticRunSummary;
  computeMilliseconds: number;
}

/** Ground that carries fire in the solver at its defaults: vegetated fuel, or developed ground (structure spread on). */
export function carriesFire(fuelCode: number): boolean {
  return isBurnable(fuelCode) || (fuelCode === DEVELOPED_FUEL_CODE && DEFAULT_STRUCTURE_SPREAD.enabled);
}

/**
 * Why a fire at `p` cannot spread in the solver, or null when it can: off the modelled area, on
 * ground that carries no fire (the solver's own message), or on ground already burned by `minute`.
 */
export function noSpreadReason(grid: LandscapeGrid, arrival: Float32Array | null, p: LonLat, minute: number): string | null {
  const cell = cellAt(grid, { longitude: p[0], latitude: p[1] });
  if (cell < 0) return "outside the modelled area, so it cannot spread";
  const code = grid.fuelCodes[cell];
  if (!carriesFire(code)) return new NonBurnableIgnitionError(code).message.replace(" Place it on vegetated ground.", "");
  if (arrival && arrival[cell] <= minute) return "on ground that has already burned";
  return null;
}

/** One solve on `grid`. Throws on a contract violation (the board validates sources first). */
export function solveFireField(grid: LandscapeGrid, request: FireSolveRequest): FireSolveResult {
  const started = performance.now();
  const windSpeedMph = request.windSpeedMetersPerSecond / METERS_PER_SECOND_PER_MPH;
  const sources: IgnitionSource[] = request.sources.map((s) => ({
    id: s.fireId,
    location: { longitude: s.location[0], latitude: s.location[1] },
    startMinute: s.startMinute,
  }));
  const run = simulateScheduledFireSpread(
    grid,
    {
      settings: {
        windSpeedMph,
        windFromDegrees: request.windFromDegrees,
        moisture: moistureOf(request.moisture),
        midflameAdjustment: DEFAULT_MIDFLAME_ADJUSTMENT,
        stepMinutes: FIRE_STEP_MINUTES,
        horizonMinutes: request.horizonMinutes,
        spotting: DEFAULT_SPOTTING,
        structureSpread: DEFAULT_STRUCTURE_SPREAD,
        ...(request.stochastic ? { stochastic: request.stochastic } : {}),
      },
      sources,
      // No frames: the board reads the arrival field, and the map contours per fire.
      frameMinutes: [],
    },
    null,
    request.sources.map((s) => s.stopMinute ?? Number.POSITIVE_INFINITY),
    {
      reportCellBehaviour: true,
      resume:
        request.resume && request.fromMinute !== null
          ? { fromMinute: request.fromMinute, ...request.resume }
          : null,
    },
  );
  const arrival = run.arrivalMinutes;
  const owner = run.sourceIndexByCell;
  const behaviour = run.cellBehaviour!;

  // Burned cells in arrival order (all sources), then split per source.
  const burned: number[] = [];
  for (let i = 0; i < arrival.length; i++) if (arrival[i] <= request.horizonMinutes) burned.push(i);
  const order = Int32Array.from(burned).sort((a, b) => arrival[a] - arrival[b] || a - b);
  const counts = new Int32Array(sources.length);
  for (const c of order) if (owner[c] >= 0) counts[owner[c]]++;
  const cellsBySource = Array.from(counts, (n) => new Int32Array(n));
  const arrivalBySource = Array.from(counts, (n) => new Float32Array(n));
  const fill = new Int32Array(sources.length);
  for (const c of order) {
    const s = owner[c];
    if (s < 0) continue;
    cellsBySource[s][fill[s]] = c;
    arrivalBySource[s][fill[s]++] = arrival[c];
  }

  // Perimeter per source over time: cell edges between a fire's burned cells and ground that
  // can still burn (the solver's own passability: a positive head rate), counted incrementally
  // in arrival order. An edge closes when the neighbour burns, by this fire or another; edges
  // facing ground that carries no fire never count. Off-grid neighbours count as open.
  const { width, height } = grid;
  const passable = behaviour.headRateMetersPerMinute;
  const done = new Uint8Array(arrival.length);
  const edges = new Int32Array(sources.length);
  const perimeterStartMinute = Math.floor(request.fromMinute ?? 0);
  const samples = request.horizonMinutes - perimeterStartMinute + 1;
  const perimeterBySource = sources.map(() => new Float32Array(samples));
  const metersPerEdge = grid.groundCellSizeMeters * LATTICE_PERIMETER_TO_SMOOTH;
  let next = 0;
  const advanceTo = (minute: number) => {
    while (next < order.length && arrival[order[next]] <= minute) {
      const c = order[next++];
      const s = owner[c];
      const x = c % width;
      const y = (c - x) / width;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          if (s >= 0) edges[s]++;
          continue;
        }
        const n = ny * width + nx;
        if (done[n]) {
          const t = owner[n];
          if (t >= 0) edges[t]--;
        } else if (passable[n] > 0 && s >= 0) edges[s]++;
      }
      done[c] = 1;
    }
  };
  for (let k = 0; k < samples; k++) {
    advanceTo(perimeterStartMinute + k);
    for (let s = 0; s < sources.length; s++) perimeterBySource[s][k] = edges[s] * metersPerEdge;
  }

  return {
    key: request.key,
    fromMinute: request.fromMinute,
    horizonMinutes: request.horizonMinutes,
    windSpeedMetersPerSecond: request.windSpeedMetersPerSecond,
    windFromDegrees: request.windFromDegrees,
    windSpeedMph,
    moisture: request.moisture,
    sources: request.sources,
    arrivalMinutes: arrival,
    sourceIndexByCell: owner,
    behaviour,
    cellsBySource,
    arrivalBySource,
    perimeterStartMinute,
    perimeterBySource,
    ...(run.stochastic ? { stochastic: run.stochastic } : {}),
    computeMilliseconds: performance.now() - started,
  };
}

/** Typed arrays a result can hand over without copying (worker postMessage transfer list). */
export function transferables(result: FireSolveResult): ArrayBuffer[] {
  const b = result.behaviour;
  return [
    result.arrivalMinutes,
    result.sourceIndexByCell,
    b.headRateMetersPerMinute,
    b.headingRadians,
    b.eccentricity,
    b.minDirectionalRateMetersPerMinute,
    b.headFlameFeet,
    b.crownType,
    ...result.cellsBySource,
    ...result.arrivalBySource,
    ...result.perimeterBySource,
  ].map((a) => a.buffer as ArrayBuffer);
}

// ---- reading a field (main thread) ----

/** Number of entries of the ascending `sorted` that are <= `value`. */
export function countAtMost(sorted: Float32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A source's burned area at `minute`, square metres. */
export function areaAt(field: FireSolveResult, grid: LandscapeGrid, source: number, minute: number): number {
  return countAtMost(field.arrivalBySource[source], minute) * grid.groundCellSizeMeters ** 2;
}

/** A source's open perimeter at `minute` (linear between whole minutes, held past the horizon), metres. */
export function perimeterAt(field: FireSolveResult, source: number, minute: number): number {
  const series = field.perimeterBySource[source];
  const u = Math.max(0, minute - field.perimeterStartMinute);
  const k = Math.min(series.length - 1, Math.floor(u));
  const f = Math.min(1, u - k);
  return k + 1 < series.length ? series[k] * (1 - f) + series[k + 1] * f : series[k];
}

/** The fire's front at a minute: Rothermel at its leading cell, as the solver propagated it. */
export interface FrontBehaviour {
  /** Grid cell of the leading front cell, -1 when the fire has no open front. */
  cell: number;
  headMetersPerMinute: number;
  /** Compass bearing of maximum spread there, degrees true. */
  headingDegrees: number;
  lengthToBreadth: number;
  /** Surface head-fire flame length there, feet (Byram). */
  headFlameFeet: number;
  /** The leading cell torches or crowns: no hand or engine line holds it (as studio/initialAttack.ts). */
  crowning: boolean;
  fuelCode: number;
  slopePercent: number;
}

export const NO_FRONT: FrontBehaviour = {
  cell: -1,
  headMetersPerMinute: 0,
  headingDegrees: 0,
  lengthToBreadth: 1,
  headFlameFeet: 0,
  crowning: false,
  fuelCode: 0,
  slopePercent: 0,
};

export interface FireGeometry {
  front: FrontBehaviour;
  /** Ground distance from the ignition cell to the farthest burned cell, metres. */
  reachMeters: number;
  /** Farthest burned cell from the leading cell (the heel), or -1. */
  heelCell: number;
  /** Cell bounds of the burned cells (inclusive), or null when none. */
  box: { minX: number; maxX: number; minY: number; maxY: number } | null;
}

/**
 * Where a fire stands at `minute`. Its front is its burned cells that still face ground that
 * can burn and is unburned at that minute; the leading cell is the front cell farthest from the
 * ignition cell (the head of a wind- or slope-driven fire; a flank once the head is stopped).
 * Rothermel there is read from the solver's per-cell behaviour.
 */
export function fireGeometry(field: FireSolveResult, grid: LandscapeGrid, source: number, originCell: number, minute: number): FireGeometry {
  const cells = field.cellsBySource[source];
  const n = countAtMost(field.arrivalBySource[source], minute);
  if (n === 0) return { front: NO_FRONT, reachMeters: 0, heelCell: -1, box: null };
  const { width, height } = grid;
  const arrival = field.arrivalMinutes;
  const passable = field.behaviour.headRateMetersPerMinute;
  const ox = originCell >= 0 ? originCell % width : cells[0] % width;
  const oy = originCell >= 0 ? (originCell - ox) / width : (cells[0] - (cells[0] % width)) / width;
  let lead = -1;
  let leadD2 = -1;
  let reachD2 = 0;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const x = c % width;
    const y = (c - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const d2 = (x - ox) ** 2 + (y - oy) ** 2;
    if (d2 > reachD2) reachD2 = d2;
    if (d2 <= leadD2) continue;
    let open = false;
    for (let k = 0; k < 4 && !open; k++) {
      const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
      const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const m = ny * width + nx;
      open = passable[m] > 0 && !(arrival[m] <= minute);
    }
    if (open) {
      lead = c;
      leadD2 = d2;
    }
  }
  const anchor = lead >= 0 ? lead : cells[n - 1];
  const ax = anchor % width;
  const ay = (anchor - ax) / width;
  let heel = anchor;
  let heelD2 = -1;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const x = c % width;
    const d2 = (x - ax) ** 2 + ((c - x) / width - ay) ** 2;
    if (d2 > heelD2) {
      heelD2 = d2;
      heel = c;
    }
  }
  const b = field.behaviour;
  const front: FrontBehaviour =
    lead < 0
      ? NO_FRONT
      : {
          cell: lead,
          headMetersPerMinute: b.headRateMetersPerMinute[lead],
          headingDegrees: ((((b.headingRadians[lead] * 180) / Math.PI) % 360) + 360) % 360,
          lengthToBreadth: 1 / Math.sqrt(Math.max(1e-9, 1 - b.eccentricity[lead] ** 2)),
          headFlameFeet: b.headFlameFeet[lead],
          crowning: b.crownType[lead] !== 0,
          fuelCode: grid.fuelCodes[lead],
          slopePercent: grid.slopeTangent[lead] * 100,
        };
  return {
    front,
    reachMeters: Math.sqrt(reachD2) * grid.groundCellSizeMeters,
    heelCell: heel,
    box: { minX, maxX, minY, maxY },
  };
}

// ---- zones on the grid ----

/** A zone rasterised onto the landscape: cells whose centre lies inside it (plus its core and ring cells), and its core cell. */
export interface ZoneCells {
  cells: Int32Array;
  /** -1 when the core is off the grid. */
  core: number;
}

function inRing(lon: number, lat: number, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function rasterZone(grid: LandscapeGrid, ring: readonly LonLat[], core: LonLat, lonOfCol: Float64Array, latOfRow: Float64Array): ZoneCells {
  const at = (p: LonLat) => cellAt(grid, { longitude: p[0], latitude: p[1] });
  const set = new Set<number>();
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    const c = at([lon, lat]);
    if (c >= 0) set.add(c);
  }
  const coreCell = at(core);
  if (coreCell >= 0) set.add(coreCell);
  for (let r = 0; r < grid.height; r++) {
    const lat = latOfRow[r];
    if (lat < minLat || lat > maxLat) continue;
    for (let c = 0; c < grid.width; c++) {
      const lon = lonOfCol[c];
      if (lon < minLon || lon > maxLon) continue;
      if (inRing(lon, lat, ring)) set.add(r * grid.width + c);
    }
  }
  return { cells: Int32Array.from(set), core: coreCell };
}

/** Per zone, the earliest arrival of each source anywhere in it, and the arrival and source at its core. */
export interface ZoneArrivals {
  earliestBySource: Float32Array;
  coreArrival: number;
  coreSource: number;
}

export function zoneArrivals(field: FireSolveResult, zone: ZoneCells): ZoneArrivals {
  const earliestBySource = new Float32Array(field.sources.length).fill(Number.POSITIVE_INFINITY);
  for (const c of zone.cells) {
    const s = field.sourceIndexByCell[c];
    if (s >= 0 && field.arrivalMinutes[c] < earliestBySource[s]) earliestBySource[s] = field.arrivalMinutes[c];
  }
  return {
    earliestBySource,
    coreArrival: zone.core >= 0 ? field.arrivalMinutes[zone.core] : Number.POSITIVE_INFINITY,
    coreSource: zone.core >= 0 ? field.sourceIndexByCell[zone.core] : -1,
  };
}
