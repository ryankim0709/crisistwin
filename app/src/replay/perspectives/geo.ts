// Pure geometry and road-graph helpers for the 3D perspectives. No React, DOM or MapLibre.
// Coordinates are [longitude, latitude] (CRS84); distances are metres from a local
// equirectangular approximation, which is adequate at incident scale (tens of km).
import type { AreaGeometry, LngLat, ReplayModel, RoadEdge } from "../types";

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;
/** Endpoint coordinates are matched at ~0.1 m to recover from/to nodes. */
const NODE_KEY_DIGITS = 6;

function metresPerDegree(lat: number): [number, number] {
  return [EARTH_RADIUS_M * DEG * Math.cos(lat * DEG), EARTH_RADIUS_M * DEG];
}

export function distanceM(a: LngLat, b: LngLat): number {
  const [kx, ky] = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
}

/** Compass bearing in degrees (0 = north, clockwise) from a to b. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const [kx, ky] = metresPerDegree((a[1] + b[1]) / 2);
  return (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) / DEG + 360) % 360;
}

/** Shortest signed difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export interface Polyline {
  coords: LngLat[];
  /** Cumulative distance in metres at each vertex; last entry is the total length. */
  cum: number[];
}

export function polyline(coords: LngLat[]): Polyline {
  const cum = [0];
  for (let i = 1; i < coords.length; i += 1) cum.push(cum[i - 1] + distanceM(coords[i - 1], coords[i]));
  return { coords, cum };
}

export function polylineLength(line: Polyline): number {
  return line.cum[line.cum.length - 1] ?? 0;
}

/** Point at distance d (clamped) along the polyline. */
export function pointAlong(line: Polyline, d: number): LngLat {
  const { coords, cum } = line;
  if (coords.length === 1 || d <= 0) return coords[0];
  const total = polylineLength(line);
  if (d >= total) return coords[coords.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i += 1;
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? (d - cum[i - 1]) / span : 0;
  const a = coords[i - 1];
  const b = coords[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function rings(geometry: AreaGeometry): LngLat[][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function inRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 0 when p is inside the area, otherwise the approximate distance to its nearest edge in metres. */
export function distanceToAreaM(p: LngLat, geometry: AreaGeometry): number {
  const [kx, ky] = metresPerDegree(p[1]);
  let best = Infinity;
  for (const polygon of rings(geometry)) {
    const [outer, ...holes] = polygon;
    if (outer && inRing(p, outer) && !holes.some((hole) => inRing(p, hole))) return 0;
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const ax = (ring[i - 1][0] - p[0]) * kx;
        const ay = (ring[i - 1][1] - p[1]) * ky;
        const bx = (ring[i][0] - p[0]) * kx;
        const by = (ring[i][1] - p[1]) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
      }
    }
  }
  return best;
}

/** Area-weighted-ish centre: the bbox centre of the outer rings. */
export function areaCenter(geometry: AreaGeometry): LngLat | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of rings(geometry)) {
    for (const [x, y] of polygon[0] ?? []) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

const nodeKey = (c: LngLat) => `${c[0].toFixed(NODE_KEY_DIGITS)},${c[1].toFixed(NODE_KEY_DIGITS)}`;

export interface RoadGraph {
  edges: RoadEdge[];
  byId: Map<string, number>;
  /** Road indices whose first coordinate is at the given node key. */
  outgoing: Map<string, number[]>;
  lines: Polyline[];
  /** traffic edge index -> road index (-1 when absent). */
  trafficToRoad: number[];
  roadToTraffic: Map<number, number>;
}

/**
 * The normalized model does not carry from/to node ids, so connectivity is recovered from
 * shared endpoint coordinates (directed edges start at from_node and end at to_node).
 */
export function buildRoadGraph(model: ReplayModel): RoadGraph {
  const edges = model.roads?.items ?? [];
  const byId = new Map<string, number>();
  const outgoing = new Map<string, number[]>();
  edges.forEach((edge, i) => {
    byId.set(edge.id, i);
    if (edge.coords.length < 2) return;
    const key = nodeKey(edge.coords[0]);
    const list = outgoing.get(key);
    if (list) list.push(i);
    else outgoing.set(key, [i]);
  });
  const trafficToRoad = (model.traffic?.edgeIds ?? []).map((id) => byId.get(id) ?? -1);
  const roadToTraffic = new Map<number, number>();
  trafficToRoad.forEach((ri, ti) => {
    if (ri >= 0) roadToTraffic.set(ri, ti);
  });
  return { edges, byId, outgoing, lines: edges.map((e) => polyline(e.coords)), trafficToRoad, roadToTraffic };
}

/**
 * The connected edge to continue onto at the end of `road`: the straightest outgoing edge that
 * is not the reverse direction of the same segment, preferring open edges. Null at a dead end.
 */
export function nextEdge(graph: RoadGraph, road: number, closedRoads: ReadonlySet<number>): number | null {
  const edge = graph.edges[road];
  const n = edge.coords.length;
  if (n < 2) return null;
  const end = edge.coords[n - 1];
  const heading = bearingDeg(edge.coords[n - 2], end);
  const startKey = nodeKey(edge.coords[0]);
  let best: number | null = null;
  let bestScore = Infinity;
  for (const candidate of graph.outgoing.get(nodeKey(end)) ?? []) {
    const c = graph.edges[candidate];
    const isReverse =
      (edge.segmentId !== null && c.segmentId === edge.segmentId) ||
      nodeKey(c.coords[c.coords.length - 1]) === startKey;
    if (candidate === road || isReverse) continue;
    const turn = Math.abs(angleDiff(heading, bearingDeg(c.coords[0], c.coords[1])));
    const score = turn + (closedRoads.has(candidate) ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
