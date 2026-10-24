// Illustrative vehicle particles. Positions are a pure function of simulation time, so
// pausing or scrubbing the replay clock freezes or moves them deterministically. Dots
// illustrate modelled per-edge counts; they are not tracked vehicles.
import type { ClosureInterval, LngLat, RoadEdge, TrafficFrame } from "./types";

/** Upper bound on drawn particles per frame, for rendering performance. */
export const MAX_PARTICLES = 4000;
/** Upper bound per edge so one long queue cannot use the whole budget. */
export const MAX_PARTICLES_PER_EDGE = 60;

const EARTH_RADIUS_M = 6_371_008.8;
const KPH_TO_MPS = 1 / 3.6;

export interface EdgePath {
  coords: LngLat[];
  /** Cumulative distance in metres at each vertex; last entry is the polyline length. */
  cumulative: number[];
  lengthM: number;
}

function distanceM(a: LngLat, b: LngLat): number {
  // Equirectangular approximation; edges are short (well under 10 km).
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * (Math.PI / 180) * Math.cos(lat);
  const dy = (b[1] - a[1]) * (Math.PI / 180);
  return Math.hypot(dx, dy) * EARTH_RADIUS_M;
}

export function buildEdgePath(edge: RoadEdge): EdgePath {
  const cumulative = [0];
  for (let i = 1; i < edge.coords.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceM(edge.coords[i - 1], edge.coords[i]));
  }
  const geometric = cumulative[cumulative.length - 1];
  return { coords: edge.coords, cumulative, lengthM: geometric > 0 ? geometric : edge.lengthM };
}

export function pointAlong(path: EdgePath, fraction: number): LngLat {
  const target = fraction * path.cumulative[path.cumulative.length - 1];
  let i = 1;
  while (i < path.cumulative.length - 1 && path.cumulative[i] < target) i += 1;
  const segStart = path.cumulative[i - 1];
  const segLen = path.cumulative[i] - segStart;
  const f = segLen > 0 ? (target - segStart) / segLen : 0;
  const a = path.coords[i - 1];
  const b = path.coords[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Stable pseudo-random jitter in [0, 1) so particles on an edge are not evenly spaced. */
function jitter(edge: number, k: number): number {
  const x = Math.sin(edge * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** How many modelled vehicles one dot stands for in this frame (>= 1). */
export function vehiclesPerParticle(frame: TrafficFrame): number {
  let total = 0;
  for (const [, veh] of frame.edges) total += veh;
  return Math.max(1, Math.ceil(total / MAX_PARTICLES));
}

/**
 * Per frame, how far (in edge lengths) particles on each edge have travelled by the frame's
 * start, integrating mean speed over earlier frames so motion stays continuous across frames.
 */
export type TravelIndex = Map<number, number>[];

export function buildTravelIndex(
  frames: readonly TrafficFrame[],
  paths: readonly (EdgePath | null)[],
  closures: readonly ClosureInterval[],
): TravelIndex {
  const intervals = new Map<number, [number, number | null][]>();
  for (const [edge, first, reopened] of closures) {
    const list = intervals.get(edge) ?? [];
    list.push([first, reopened]);
    intervals.set(edge, list);
  }
  const closedAt = (edge: number, k: number) =>
    intervals.get(edge)?.some(([first, reopened]) => first <= k && (reopened === null || k < reopened)) ??
    false;
  const running = new Map<number, number>();
  const index: TravelIndex = [];
  for (let k = 0; k < frames.length; k += 1) {
    const frame = frames[k];
    const startOffsets = new Map<number, number>();
    const dtSeconds = k + 1 < frames.length ? (frames[k + 1].atMs - frame.atMs) / 1000 : 0;
    for (const [edge, , speedKph] of frame.edges) {
      const path = paths[edge];
      const start = running.get(edge) ?? 0;
      startOffsets.set(edge, start);
      if (!path || speedKph <= 0 || closedAt(edge, k)) continue;
      // Not wrapped to [0, 1): callers scale this value, and wrapping would make that jump.
      running.set(edge, start + (dtSeconds * speedKph * KPH_TO_MPS) / path.lengthM);
    }
    index.push(startOffsets);
  }
  return index;
}

export interface ParticleOptions {
  /** Edge paths indexed like traffic.edge_ids; null when the edge has no geometry. */
  paths: (EdgePath | null)[];
  frame: TrafficFrame;
  /** Travel offsets at this frame's start, from buildTravelIndex. */
  offsets: Map<number, number> | undefined;
  simTimeMs: number;
  closed: ReadonlySet<number>;
  /**
   * Multiplier (0, 1] on displayed motion. At fast playback, dots would strobe; the caller may
   * slow them to an illustrative pace. Positions remain a pure function of simulation time.
   */
  motionScale: number;
}

/** Particle positions at `simTimeMs`, a stopped flag per particle, and the dot scale. */
export function particlePositions({
  paths,
  frame,
  offsets,
  simTimeMs,
  closed,
  motionScale,
}: ParticleOptions): {
  coords: LngLat[];
  stopped: boolean[];
  perParticle: number;
} {
  const perParticle = vehiclesPerParticle(frame);
  const intoFrameSeconds = Math.max(0, (simTimeMs - frame.atMs) / 1000);
  const coords: LngLat[] = [];
  const stopped: boolean[] = [];
  for (const [edgeIndex, veh, speedKph] of frame.edges) {
    const path = paths[edgeIndex];
    if (!path || veh <= 0) continue;
    const n = Math.min(MAX_PARTICLES_PER_EDGE, Math.max(1, Math.round(veh / perParticle)));
    const isStopped = closed.has(edgeIndex) || speedKph <= 0;
    const start = offsets?.get(edgeIndex) ?? 0;
    const travel =
      (start + (isStopped ? 0 : (intoFrameSeconds * speedKph * KPH_TO_MPS) / path.lengthM)) * motionScale;
    for (let k = 0; k < n && coords.length < MAX_PARTICLES; k += 1) {
      const base = (k + jitter(edgeIndex, k) * 0.6) / n;
      const fraction = (((base + travel) % 1) + 1) % 1;
      coords.push(pointAlong(path, fraction));
      stopped.push(isStopped);
    }
  }
  return { coords, stopped, perParticle };
}
