/**
 * Observed arrival-time raster from time-stamped fire perimeters, on a `LandscapeGrid`.
 *
 * Pure maths: no DOM, no network. Input perimeters are observed (satellite-derived FEDS
 * cumulative perimeters at half-day precision); the result between two snapshots is an
 * interpolation, so it is labelled `OBSERVED_ARRIVAL_LABEL`, never as a model run.
 *
 * Method. Let R(-1) be the ignition cells and R(k) the union of perimeters 0..k (cumulative,
 * so a later perimeter that rasterizes slightly smaller never "unburns" a cell). A cell that
 * first falls inside R(k) arrives at
 *
 *     t(prev) + f * (t(k) - t(prev)),   f = d_prev / (d_prev + d_next)
 *
 * where d_prev is its distance to R(k-1) and d_next its distance to the ground outside R(k)
 * (exact Euclidean distance transforms on the grid). The front therefore sweeps from the earlier
 * perimeter to the later one instead of jumping at snapshot times. `t(prev)` is the time of the
 * latest snapshot before k, including snapshots that added nothing (the fire had not yet grown
 * past R(k-1) then). Ignition cells arrive at their own minute.
 *
 * Grid: cell (col, row) has its centre at Web Mercator x = originX + col * cellSizeX,
 * y = originY + row * cellSizeY; cellSizeY is negative, so row 0 is the NORTH edge (see
 * `app/src/fire/landscape.ts`). Perimeter vertices are WGS84 [longitude, latitude] and go
 * through `lonLatToMercator`. Mercator cells are square, so distances in cell units give the
 * same ratio f as ground distances.
 *
 * Times are minutes after the fire's t0 (its earliest ignition); `Infinity` = never inside a
 * perimeter. Limits: ignitions later than the first snapshot only appear as pins (they do not
 * seed the sweep); all seeds start the first interval together at its start time.
 */

import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";

export const OBSERVED_ARRIVAL_LABEL = "Observed perimeters, interpolated between snapshots";

export type GridGeometry = Pick<
  LandscapeGrid,
  "width" | "height" | "originX" | "originY" | "cellSizeX" | "cellSizeY"
>;

/** GeoJSON-style polygon coordinates: rings of [longitude, latitude]; ring 0 is the outline. */
export type PolygonCoordinates = readonly (readonly (readonly number[])[])[];

export type PerimeterGeometry =
  | { type: "Polygon"; coordinates: PolygonCoordinates }
  | { type: "MultiPolygon"; coordinates: readonly PolygonCoordinates[] };

export interface PerimeterSnapshot {
  /** Minutes after t0. */
  minute: number;
  /** Cumulative burned outline; `null` = unchanged from the previous snapshot. */
  geometry: PerimeterGeometry | null;
}

export interface ArrivalSeed {
  longitude: number;
  latitude: number;
  /** Minutes after t0. */
  minute: number;
}

export interface ObservedArrival {
  /** Row-major on the grid (row 0 north), minutes after t0; `Infinity` = never. */
  arrivalMinutes: Float32Array;
  /** Time of the last snapshot, minutes after t0. */
  horizonMinutes: number;
  /** Snapshot times in minutes after t0, ascending. */
  snapshotMinutes: number[];
  /** Ignitions that seeded the sweep (on the board and not after the first snapshot). */
  seededIgnitions: number;
  /** Cells inside the last perimeter. */
  burnedCells: number;
  label: typeof OBSERVED_ARRIVAL_LABEL;
}

const INF = 1e20;

/** Fractional (col, row) of a lon/lat on the grid; cell centres sit on integers. */
function toGrid(grid: GridGeometry, lon: number, lat: number): [number, number] {
  const [x, y] = lonLatToMercator(lon, lat);
  return [(x - grid.originX) / grid.cellSizeX, (y - grid.originY) / grid.cellSizeY];
}

function polygonsOf(geometry: PerimeterGeometry): readonly PolygonCoordinates[] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

/**
 * Sets `mask[i] = 1` for every cell whose centre lies inside the geometry (even-odd within each
 * polygon, so holes stay unburned; polygons are OR-ed so overlapping parts never cancel).
 */
export function rasterizePerimeter(
  grid: GridGeometry,
  geometry: PerimeterGeometry,
  mask: Uint8Array,
): void {
  const { width, height } = grid;
  const crossings: number[] = [];
  for (const polygon of polygonsOf(geometry)) {
    const edges: number[] = []; // c0, r0, c1, r1 per edge
    let minRow = Infinity;
    let maxRow = -Infinity;
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      let [pc, pr] = toGrid(grid, ring[ring.length - 1][0], ring[ring.length - 1][1]);
      for (const vertex of ring) {
        const [c, r] = toGrid(grid, vertex[0], vertex[1]);
        if (r !== pr) edges.push(pc, pr, c, r);
        minRow = Math.min(minRow, r);
        maxRow = Math.max(maxRow, r);
        pc = c;
        pr = r;
      }
    }
    const rowStart = Math.max(0, Math.ceil(minRow));
    const rowEnd = Math.min(height - 1, Math.floor(maxRow));
    for (let row = rowStart; row <= rowEnd; row++) {
      crossings.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        const r0 = edges[e + 1];
        const r1 = edges[e + 3];
        // Half-open in row so a vertex on the scanline is counted once.
        if ((r0 <= row && row < r1) || (r1 <= row && row < r0)) {
          const c0 = edges[e];
          const c1 = edges[e + 2];
          crossings.push(c0 + ((row - r0) * (c1 - c0)) / (r1 - r0));
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      const base = row * width;
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil(crossings[k]));
        const to = Math.min(width - 1, Math.floor(crossings[k + 1]));
        for (let col = from; col <= to; col++) mask[base + col] = 1;
      }
    }
  }
}

/** Felzenszwalb-Huttenlocher 1D squared distance transform of `f` (length n) into `d`. */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Squared distance (cells) from each cell of a w x h box to the nearest feature cell, where
 * `isFeature(i)` tests the box-local index. Writes into `out` (length >= w*h).
 */
function squaredDistance(w: number, h: number, isFeature: (i: number) => boolean, out: Float64Array) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) out[i] = isFeature(i) ? 0 : INF;
  for (let c = 0; c < w; c++) {
    for (let r = 0; r < h; r++) f[r] = out[r * w + c];
    edt1d(f, h, d, v, z);
    for (let r = 0; r < h; r++) out[r * w + c] = d[r];
  }
  for (let r = 0; r < h; r++) {
    const base = r * w;
    for (let c = 0; c < w; c++) f[c] = out[base + c];
    edt1d(f, w, d, v, z);
    for (let c = 0; c < w; c++) out[base + c] = d[c];
  }
}

/** Observed arrival raster; see the module comment for the method and its limits. */
export function arrivalFromPerimeters(
  grid: GridGeometry,
  snapshots: readonly PerimeterSnapshot[],
  ignitions: readonly ArrivalSeed[],
): ObservedArrival {
  const { width, height } = grid;
  const cells = width * height;
  const arrival = new Float32Array(cells).fill(Infinity);
  const ordered = [...snapshots].sort((a, b) => a.minute - b.minute);
  const firstSnapshot = ordered.length ? ordered[0].minute : Infinity;

  // R(-1): ignition cells that start the sweep.
  let previous = new Uint8Array(cells);
  let seeded = 0;
  let startMinute = Infinity;
  for (const seed of ignitions) {
    if (!(seed.minute <= firstSnapshot)) continue;
    const [c, r] = toGrid(grid, seed.longitude, seed.latitude);
    const col = Math.round(c);
    const row = Math.round(r);
    if (col < 0 || row < 0 || col >= width || row >= height) continue;
    const i = row * width + col;
    previous[i] = 1;
    arrival[i] = Math.min(arrival[i], seed.minute);
    startMinute = Math.min(startMinute, seed.minute);
    seeded++;
  }
  let prevMinute = Number.isFinite(startMinute) ? startMinute : firstSnapshot;
  let previousEmpty = seeded === 0;

  let scratchA = new Float64Array(0);
  let scratchB = new Float64Array(0);
  for (const snapshot of ordered) {
    if (!snapshot.geometry) {
      prevMinute = snapshot.minute;
      continue;
    }
    const current = previous.slice();
    rasterizePerimeter(grid, snapshot.geometry, current);

    // Box around the new cells' region R(k), grown by one cell so it holds ground outside R(k);
    // R(k-1) is inside R(k), so distances computed in the box are exact.
    let minC = width;
    let minR = height;
    let maxC = -1;
    let maxR = -1;
    let added = 0;
    for (let r = 0; r < height; r++) {
      const base = r * width;
      for (let c = 0; c < width; c++) {
        const i = base + c;
        if (!current[i]) continue;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (!previous[i]) added++;
      }
    }
    if (added === 0) {
      prevMinute = snapshot.minute;
      continue;
    }
    minC = Math.max(0, minC - 1);
    minR = Math.max(0, minR - 1);
    maxC = Math.min(width - 1, maxC + 1);
    maxR = Math.min(height - 1, maxR + 1);
    const w = maxC - minC + 1;
    const h = maxR - minR + 1;
    if (scratchA.length < w * h) {
      scratchA = new Float64Array(w * h);
      scratchB = new Float64Array(w * h);
    }
    const global = (i: number) => (minR + Math.floor(i / w)) * width + minC + (i % w);
    const span = snapshot.minute - prevMinute;
    if (!previousEmpty) {
      const prev = previous;
      const cur = current;
      squaredDistance(w, h, (i) => prev[global(i)] === 1, scratchA);
      squaredDistance(w, h, (i) => cur[global(i)] === 0, scratchB);
    }
    for (let i = 0; i < w * h; i++) {
      const g = global(i);
      if (!current[g] || previous[g]) continue;
      let fraction = 1;
      if (!previousEmpty) {
        const dPrev = Math.sqrt(scratchA[i]);
        const dNext = Math.sqrt(scratchB[i]);
        fraction = dPrev + dNext > 0 ? dPrev / (dPrev + dNext) : 1;
      }
      arrival[g] = prevMinute + fraction * span;
    }
    previous = current;
    previousEmpty = false;
    prevMinute = snapshot.minute;
  }

  let burnedCells = 0;
  for (let i = 0; i < cells; i++) if (previous[i]) burnedCells++;
  return {
    arrivalMinutes: arrival,
    horizonMinutes: ordered.length ? ordered[ordered.length - 1].minute : 0,
    snapshotMinutes: ordered.map((s) => s.minute),
    seededIgnitions: seeded,
    burnedCells,
    label: OBSERVED_ARRIVAL_LABEL,
  };
}
