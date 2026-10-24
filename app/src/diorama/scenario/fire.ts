/**
 * Scripted wind-biased fire spread over a regular grid (see `FireField` in `../types`).
 *
 * Arrival "effort" τ is computed with Dijkstra over 8-connected cells: the cost of moving
 * between neighbours is distance / rate, where rate depends on fuel (tree density), wind
 * alignment, slope and smooth deterministic noise. τ is then mapped to scenario seconds by a
 * time warp so the fire starts small, runs during the middle of the story and slows during
 * resolution. A crew-held section refuses ignition from `heldFrom` on. This is a visual
 * device, not a fire behaviour model.
 */
import type { FireField, Vec2, World } from "../types";
import { createRng, distanceToPolyline, heightAt, WORLD_SEED } from "../world";

export const FIRE_CELL_SIZE = 4;
const ORIGIN_X = -260;
const ORIGIN_Z = -220;
const COLS = 90; // x ∈ [-260, 100)
const ROWS = 45; // z ∈ [-220, -40)
export const BURN_DURATION_S = 12;

/** Base spread rate on full fuel, no wind, flat ground (units per warped second). */
const BASE_RATE = 1.8;
/**
 * Wind factor = WIND_BACKING + WIND_HEAD · ((1 + cos θ) / 2)^WIND_FOCUS, θ = angle to the wind:
 * a narrow fast head, slow flanks and a weak backing fire. Slope factor = exp(SLOPE_BIAS · slope).
 */
const WIND_HEAD = 9;
const WIND_FOCUS = 80;
const WIND_BACKING = 0.35;
const SLOPE_BIAS = 0.8;
/** Cells whose centre lies south of this line are town terrace and never burn. */
const TERRACE_Z = -50;
/** Roads, river margin and cleared space around homes act as fuel breaks. */
const ROAD_BREAK = 4.5;
const RIVER_BREAK = 6;
const HOME_CLEARANCE = 10;
/** Grass with no trees nearby still carries a slow creeping fire. */
const GRASS_FUEL = 0.04;

/**
 * Spread speed multiplier over scenario time: smouldering start, full run in the middle,
 * calmer resolution once crews are working. τ(t) = ∫ multiplier dt.
 */
function spreadMultiplier(t: number): number {
  if (t < 5) return 0.25;
  if (t < 11) return 0.25 + ((t - 5) / 6) * 0.75;
  if (t < 64) return 1;
  if (t < 76) return 1 - ((t - 64) / 12) * 0.7;
  return 0.3;
}

const WARP_STEP = 0.01;

type Warp = { tauAt: (t: number) => number; timeAt: (tau: number) => number };

function buildWarp(maxT: number): Warp {
  const n = Math.ceil(maxT / WARP_STEP) + 1;
  const tau = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const tm = (i - 0.5) * WARP_STEP;
    tau[i] = tau[i - 1] + spreadMultiplier(tm) * WARP_STEP;
  }
  const tauAt = (t: number) => {
    const f = Math.min(n - 1, Math.max(0, t / WARP_STEP));
    const i = Math.min(n - 2, Math.floor(f));
    return tau[i] + (tau[i + 1] - tau[i]) * (f - i);
  };
  const timeAt = (value: number) => {
    if (value > tau[n - 1]) return Infinity;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tau[mid] <= value) lo = mid;
      else hi = mid;
    }
    const span = tau[hi] - tau[lo];
    return (lo + (span > 0 ? (value - tau[lo]) / span : 0)) * WARP_STEP;
  };
  return { tauAt, timeAt };
}

export const cellCenter = (col: number, row: number): Vec2 => ({
  x: ORIGIN_X + (col + 0.5) * FIRE_CELL_SIZE,
  z: ORIGIN_Z + (row + 0.5) * FIRE_CELL_SIZE,
});

/** Fuel in [0, 1] per cell; 0 never burns. */
function buildFuel(world: World): Float32Array {
  const fuel = new Float32Array(COLS * ROWS);
  const treeCount = new Float32Array(COLS * ROWS);
  for (const tree of world.trees) {
    const col = Math.floor((tree.p.x - ORIGIN_X) / FIRE_CELL_SIZE);
    const row = Math.floor((tree.p.z - ORIGIN_Z) / FIRE_CELL_SIZE);
    if (col < 0 || row < 0 || col >= COLS || row >= ROWS) continue;
    treeCount[row * COLS + col] += 1;
  }
  const homes = world.buildings.filter((b) => b.kind !== "shelter" && b.kind !== "station");
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const c = cellCenter(col, row);
      const i = row * COLS + col;
      if (c.z > TERRACE_Z) continue;
      if (distanceToPolyline(c, world.river.points) < world.river.halfWidth + RIVER_BREAK) continue;
      if (world.edges.some((e) => distanceToPolyline(c, e.points) < ROAD_BREAK)) continue;
      if (homes.some((h) => Math.hypot(h.p.x - c.x, h.p.z - c.z) < HOME_CLEARANCE)) continue;
      // Trees within a 3×3 neighbourhood (12 × 12 units); dense forest has about 2.
      let trees = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const cc = col + dc;
          if (r < 0 || cc < 0 || r >= ROWS || cc >= COLS) continue;
          trees += treeCount[r * COLS + cc] * (dr === 0 && dc === 0 ? 1.5 : 1);
        }
      }
      fuel[i] = Math.min(1, GRASS_FUEL + Math.pow(trees / 2.2, 1.4));
    }
  }
  return fuel;
}

/** Smooth value noise in roughly [0.5, 1.5] so the front is patchy rather than circular. */
function buildNoise(): Float32Array {
  const rng = createRng(WORLD_SEED ^ 0x5f17e);
  const lattice = 6; // cells per lattice step
  const lc = Math.ceil(COLS / lattice) + 2;
  const lr = Math.ceil(ROWS / lattice) + 2;
  const coarse = new Float32Array(lc * lr);
  for (let i = 0; i < coarse.length; i++) coarse[i] = rng();
  const noise = new Float32Array(COLS * ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const fx = col / lattice;
      const fz = row / lattice;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const sx = fx - ix;
      const sz = fz - iz;
      const ux = sx * sx * (3 - 2 * sx);
      const uz = sz * sz * (3 - 2 * sz);
      const a = coarse[iz * lc + ix];
      const b = coarse[iz * lc + ix + 1];
      const c = coarse[(iz + 1) * lc + ix];
      const d = coarse[(iz + 1) * lc + ix + 1];
      const smooth = a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
      noise[row * COLS + col] = 0.45 + smooth * 0.8 + rng() * 0.3;
    }
  }
  return noise;
}

/**
 * Neighbour offsets (dc, dr) with |dc|, |dr| ≤ 3 and gcd 1: 32 directions, so a strongly
 * wind-driven head is not pulled onto the grid diagonals.
 */
const NEIGHBOURS: [number, number][] = (() => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const out: [number, number][] = [];
  for (let dr = -3; dr <= 3; dr++) {
    for (let dc = -3; dc <= 3; dc++) {
      if ((dr !== 0 || dc !== 0) && gcd(Math.abs(dr), Math.abs(dc)) === 1) out.push([dc, dr]);
    }
  }
  return out;
})();

/** True if every cell the straight hop crosses has fuel (fire cannot jump roads or water). */
function clearPath(fuel: Float32Array, col: number, row: number, dc: number, dr: number): boolean {
  const steps = 2 * Math.max(Math.abs(dc), Math.abs(dr));
  for (let k = 1; k < steps; k++) {
    const c = Math.round(col + (dc * k) / steps);
    const r = Math.round(row + (dr * k) / steps);
    if (fuel[r * COLS + c] <= 0) return false;
  }
  if (
    Math.abs(dc) === 1 &&
    Math.abs(dr) === 1 &&
    fuel[row * COLS + col + dc] <= 0 &&
    fuel[(row + dr) * COLS + col] <= 0
  ) {
    return false;
  }
  return true;
}

export type FireBuild = {
  field: FireField;
  /** First time any cell within `radius` of the polyline ignites (Infinity if none). */
  approachTime(points: Vec2[], radius: number): number;
  /** Sorted finite ignition times, for O(log n) burned-area queries. */
  sortedIgnitions: Float32Array;
};

export type HoldSpec = { heldFrom: number; centers: Vec2[]; radius: number };

/** Build the fire field. With `hold`, cells in the held section never ignite at t ≥ heldFrom. */
export function buildFire(world: World, duration: number, hold: HoldSpec | null): FireBuild {
  const fuel = buildFuel(world);
  const noise = buildNoise();
  const warp = buildWarp(duration + 1);
  const n = COLS * ROWS;
  const heights = new Float32Array(n);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const c = cellCenter(col, row);
      heights[row * COLS + col] = heightAt(c.x, c.z);
    }
  }

  const inZone = new Uint8Array(n);
  if (hold) {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const c = cellCenter(col, row);
        const i = row * COLS + col;
        if (fuel[i] > 0 && hold.centers.some((h) => Math.hypot(h.x - c.x, h.z - c.z) < hold.radius))
          inZone[i] = 1;
      }
    }
  }
  const heldTau = hold ? warp.tauAt(hold.heldFrom) : Infinity;

  const tau = new Float64Array(n).fill(Infinity);
  const wind = world.wind.toward;
  const startCol = Math.floor((world.ignition.x - ORIGIN_X) / FIRE_CELL_SIZE);
  const startRow = Math.floor((world.ignition.z - ORIGIN_Z) / FIRE_CELL_SIZE);
  const start = startRow * COLS + startCol;
  if (fuel[start] <= 0) throw new Error("Fire ignition point has no fuel");
  tau[start] = 0;

  // Binary min-heap of (tau, cell).
  const heapTau: number[] = [];
  const heapCell: number[] = [];
  const push = (value: number, cell: number) => {
    let i = heapTau.length;
    heapTau.push(value);
    heapCell.push(cell);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapTau[parent] <= heapTau[i]) break;
      [heapTau[parent], heapTau[i]] = [heapTau[i], heapTau[parent]];
      [heapCell[parent], heapCell[i]] = [heapCell[i], heapCell[parent]];
      i = parent;
    }
  };
  const pop = (): number => {
    const top = heapCell[0];
    const lastTau = heapTau.pop()!;
    const lastCell = heapCell.pop()!;
    if (heapTau.length > 0) {
      heapTau[0] = lastTau;
      heapCell[0] = lastCell;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapTau.length && heapTau[l] < heapTau[m]) m = l;
        if (r < heapTau.length && heapTau[r] < heapTau[m]) m = r;
        if (m === i) break;
        [heapTau[m], heapTau[i]] = [heapTau[i], heapTau[m]];
        [heapCell[m], heapCell[i]] = [heapCell[i], heapCell[m]];
        i = m;
      }
    }
    return top;
  };

  const maxTau = warp.tauAt(duration);
  const done = new Uint8Array(n);
  push(0, start);
  while (heapTau.length > 0) {
    const cell = pop();
    if (done[cell]) continue;
    done[cell] = 1;
    const here = tau[cell];
    if (here > maxTau) break;
    const row = Math.floor(cell / COLS);
    const col = cell - row * COLS;
    for (const [dc, dr] of NEIGHBOURS) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= ROWS || c >= COLS) continue;
      const nb = r * COLS + c;
      if (done[nb] || fuel[nb] <= 0) continue;
      if (!clearPath(fuel, col, row, dc, dr)) continue;
      const len = Math.hypot(dr, dc) * FIRE_CELL_SIZE;
      const align = (dc * wind.x + dr * wind.z) / Math.hypot(dr, dc);
      const slope = Math.max(-0.6, Math.min(0.6, (heights[nb] - heights[cell]) / len));
      const rate =
        BASE_RATE *
        ((fuel[cell] + fuel[nb]) / 2) *
        (WIND_BACKING + WIND_HEAD * Math.pow((1 + align) / 2, WIND_FOCUS)) *
        Math.exp(SLOPE_BIAS * slope) *
        ((noise[cell] + noise[nb]) / 2);
      const next = here + len / rate;
      if (inZone[nb] && next >= heldTau) continue;
      if (next < tau[nb]) {
        tau[nb] = next;
        push(next, nb);
      }
    }
  }

  const ignitionTime = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = tau[i] <= maxTau ? warp.timeAt(tau[i]) : Infinity;
    ignitionTime[i] = t <= duration ? t : Infinity;
  }
  const heldCells = new Uint8Array(n);
  const heldFrom = hold ? hold.heldFrom : Infinity;
  if (hold) {
    // The held section is the protected part of the zone: still unburned when crews start.
    for (let i = 0; i < n; i++)
      if (inZone[i] && !(ignitionTime[i] < heldFrom - BURN_DURATION_S)) heldCells[i] = 1;
  }

  const finite = Array.from(ignitionTime).filter((t) => Number.isFinite(t));
  finite.sort((a, b) => a - b);
  const sortedIgnitions = Float32Array.from(finite);

  const field: FireField = {
    cols: COLS,
    rows: ROWS,
    originX: ORIGIN_X,
    originZ: ORIGIN_Z,
    cellSize: FIRE_CELL_SIZE,
    burnDuration: BURN_DURATION_S,
    ignitionTime,
    heldCells,
    heldFrom,
  };

  const approachTime = (points: Vec2[], radius: number) => {
    let best = Infinity;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const t = ignitionTime[row * COLS + col];
        if (t < best && distanceToPolyline(cellCenter(col, row), points) < radius) best = t;
      }
    }
    return best;
  };

  return { field, approachTime, sortedIgnitions };
}

/** Number of finite ignition times ≤ t in a sorted array. */
export function countIgnitedBy(sorted: Float32Array, t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
