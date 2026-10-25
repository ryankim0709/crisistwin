/**
 * The /demo board's fire spread: Simulation Studio's and /fire's cell solver
 * (fire/spread.ts simulateScheduledFireSpread, Rothermel 1972 surface spread with crown fire,
 * ember spotting and structure-to-structure spread with Studio's settings) on the drill's LANDFIRE
 * landscape, and what the board reads back from its arrival field. Pure: no React, worker or
 * network. The worker (fireSolver.worker.ts) runs `solveFireField`; the board (model.ts)
 * builds the request and applies the result. See docs/command-demo-realism.md.
 *
 * Time. Returned arrivals are board minutes and read directly against `board.minute`.
 * The solver uses the published run's T+0 so time-keyed draws match Studio's.
 *
 * Settings. The published FireSettings go straight to the shared solver, including its seed,
 * weather series and optional mechanisms. Until an intervention, Live solves the complete Studio
 * input with its original horizon from T+0. Resume applies after firefighting changes the fire,
 * or when Live continues past Studio's horizon. Resume and control-line times are translated to
 * the Studio clock before the solve; returned arrivals use board minutes.
 *
 * Units: minutes are board minutes; distances ground metres; areas square metres here
 * (hectares on the board); wind mph at the solver boundary (FireSettings), m/s on the board;
 * flame lengths feet.
 */

import { isBurnable } from "../fire/fuelModels";
import type { LandscapeGrid } from "../fire/landscape";
import {
  DEFAULT_STRUCTURE_SPREAD,
  DEVELOPED_FUEL_CODE,
  NonBurnableIgnitionError,
  cellAt,
  simulateScheduledFireSpread,
  type CellBehaviour,
  type ControlLines,
} from "../fire/spread";
import type { FireSettings, IgnitionSource } from "../fire/scheduledTypes";
import type { StochasticRunSummary } from "../fire/stochastic";
import type { LonLat } from "../live/types";
import type { FuelMoisture } from "../fire/spread";
import { METERS_PER_SECOND_PER_MPH } from "./realism";

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

/** Built line cells for the solver (sparse): cell, minute it was finished, longest flame it holds. */
export interface BuiltLineCells {
  cells: Int32Array;
  holdFromMinute: Float32Array;
  holdsFeet: Float32Array;
}

/** Dense solver control lines from sparse built cells; a cell built twice keeps its earlier build. */
export function denseControlLines(grid: LandscapeGrid, built: BuiltLineCells): ControlLines {
  const count = grid.width * grid.height;
  const holdFromMinute = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
  const holdsFlameLengthFeet = new Float32Array(count);
  for (let k = 0; k < built.cells.length; k++) {
    const c = built.cells[k];
    if (built.holdFromMinute[k] < holdFromMinute[c]) {
      holdFromMinute[c] = built.holdFromMinute[k];
      holdsFlameLengthFeet[c] = built.holdsFeet[k];
    }
  }
  return { holdFromMinute, holdsFlameLengthFeet };
}

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
  /** Published Studio settings; the horizon grows only after Live continues past the Studio run. */
  settings: FireSettings;
  /** Board minute corresponding to Studio T+0, so stochastic wind steps use Studio's clock. */
  clockStartMinute: number;
  /** True after Live firefighting/manual closure changes the Studio fire; only then resume history. */
  intervened: boolean;
  /** Open 20-ft wind, m/s, and the bearing it blows FROM, degrees true. */
  windSpeedMetersPerSecond: number;
  windFromDegrees: number;
  /** Fuel moisture fractions (0.06 = 6%) and a key that identifies them. */
  moisture: FuelMoisture;
  moistureKey: string;
  sources: SolveSource[];
  /**
   * Fire line built on the board so far (demo/attack.ts), as the solver's control lines: fire
   * does not cross a cell built by the minute it would arrive unless the flame facing it is
   * longer than the cell holds (fire/spread.ts ControlLines). Null = none.
   */
  controlLines: BuiltLineCells | null;
  /** Which built line this solve includes (model.ts lineKey); echoed in the result. */
  lineKey: string;
  /**
   * Cells put out by suppression (demo/suppression.ts) by the resume minute: burned ground that
   * spreads no further and throws no embers. The solver's own inert path for resumed cells
   * (fire/spread.ts ResumeFrom: a fixed cell with source -1 does not spread); the result keeps
   * each cell's fire (sourceIndexByCell), so the fire's area and perimeter still count it.
   * Only cells already burned at `fromMinute` are affected. Null or absent = none.
   */
  inertCells?: Int32Array | null;
  /** The earlier field, remapped to `sources` (-1 = burned by a fire no longer listed). */
  resume: {
    arrivalMinutes: Float32Array;
    sourceIndexByCell: Int8Array;
    earlierBehaviour: CellBehaviour;
    earlierWindSpeedMph: number;
  } | null;
}

export interface FireSolveResult {
  key: string;
  /** Published settings and clock origin this field used; detects changes beyond weather. */
  settingsKey: string;
  intervened: boolean;
  fromMinute: number | null;
  horizonMinutes: number;
  windSpeedMetersPerSecond: number;
  windFromDegrees: number;
  windSpeedMph: number;
  moisture: FuelMoisture;
  moistureKey: string;
  sources: SolveSource[];
  /** The request's lineKey: the built line this field respects. */
  lineKey: string;
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

/** Ground that carries fire under the run's structure-spread setting (default applies when absent). */
export function carriesFire(fuelCode: number, settings?: Pick<FireSettings, "structureSpread">): boolean {
  return isBurnable(fuelCode) || (fuelCode === DEVELOPED_FUEL_CODE && (settings?.structureSpread ?? DEFAULT_STRUCTURE_SPREAD).enabled);
}

/**
 * Why a fire at `p` cannot spread in the solver, or null when it can: off the modelled area, on
 * ground that carries no fire (the solver's own message), or on ground already burned by `minute`.
 */
export function noSpreadReason(grid: LandscapeGrid, arrival: Float32Array | null, p: LonLat, minute: number, settings?: FireSettings): string | null {
  const cell = cellAt(grid, { longitude: p[0], latitude: p[1] });
  if (cell < 0) return "outside the modelled area, so it cannot spread";
  const code = grid.fuelCodes[cell];
  if (!carriesFire(code, settings)) return new NonBurnableIgnitionError(code).reason;
  if (arrival && arrival[cell] <= minute) return "on ground that has already burned";
  return null;
}

/** One solve on `grid`. Throws on a contract violation (the board validates sources first). */
export function solveFireField(grid: LandscapeGrid, request: FireSolveRequest): FireSolveResult {
  const started = performance.now();
  const windSpeedMph = request.windSpeedMetersPerSecond / METERS_PER_SECOND_PER_MPH;
  const offset = request.clockStartMinute;
  const solverTimes = (times: Float32Array): Float32Array => offset === 0 ? times : times.map((t) => t - offset);
  const sources: IgnitionSource[] = request.sources.map((s) => ({
    id: s.fireId,
    location: { longitude: s.location[0], latitude: s.location[1] },
    startMinute: Math.max(0, s.startMinute - offset),
  }));
  // Put-out cells: fixed with source -1 in the resume (inert), their fire restored afterwards.
  const inert: { cell: number; owner: number }[] = [];
  let resumeOwners = request.resume?.sourceIndexByCell ?? null;
  if (request.resume && request.fromMinute !== null && request.inertCells && request.inertCells.length > 0) {
    resumeOwners = request.resume.sourceIndexByCell.slice();
    for (const c of request.inertCells) {
      if (c < 0 || c >= resumeOwners.length || !(request.resume.arrivalMinutes[c] <= request.fromMinute)) continue;
      inert.push({ cell: c, owner: resumeOwners[c] });
      resumeOwners[c] = -1;
    }
  }
  const run = simulateScheduledFireSpread(
    grid,
    {
      settings: {
        ...request.settings,
        horizonMinutes: request.horizonMinutes - offset,
      },
      sources,
      // No frames: the board reads the arrival field, and the map contours per fire.
      frameMinutes: [],
    },
    request.controlLines && request.controlLines.cells.length > 0
      ? denseControlLines(grid, { ...request.controlLines, holdFromMinute: solverTimes(request.controlLines.holdFromMinute) })
      : null,
    request.sources.some((s) => s.stopMinute !== null)
      ? request.sources.map((s) => s.stopMinute === null ? Number.POSITIVE_INFINITY : s.stopMinute - offset)
      : null,
    {
      reportCellBehaviour: true,
      resume:
        request.resume && request.fromMinute !== null
          ? {
              ...request.resume,
              fromMinute: request.fromMinute - offset,
              arrivalMinutes: solverTimes(request.resume.arrivalMinutes),
              sourceIndexByCell: resumeOwners ?? request.resume.sourceIndexByCell,
            }
          : null,
    },
  );
  const arrival = run.arrivalMinutes;
  if (offset !== 0) for (let i = 0; i < arrival.length; i++) arrival[i] += offset;
  const owner = run.sourceIndexByCell;
  // Fixed cells keep their resumed arrival, so an inert cell is still burned: give it back its fire.
  for (const { cell, owner: s } of inert) if (arrival[cell] <= request.horizonMinutes) owner[cell] = s;
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
          // Close the edge the earlier neighbour opened toward this cell, which it counted only
          // when this cell was passable (below). A burned cell can be impassable in this field:
          // a resumed solve keeps cells burned under earlier weather, and Rothermel spread is 0
          // once the dead fuel is wetter than the fuel model's moisture of extinction (Rothermel
          // 1972), e.g. GR2 (Mx 15%) at the 15% 1-h moisture of an overnight series hour.
          // Decrementing then would drive the perimeter negative.
          const t = owner[n];
          if (t >= 0 && passable[c] > 0) edges[t]--;
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
    settingsKey: `${request.clockStartMinute}|${JSON.stringify(request.settings)}`,
    intervened: request.intervened,
    fromMinute: request.fromMinute,
    horizonMinutes: request.horizonMinutes,
    windSpeedMetersPerSecond: request.windSpeedMetersPerSecond,
    windFromDegrees: request.windFromDegrees,
    windSpeedMph,
    moisture: request.moisture,
    moistureKey: request.moistureKey,
    sources: request.sources,
    lineKey: request.lineKey,
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
