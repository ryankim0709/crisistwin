// Small planar geometry helpers for the workspace (WGS84 [lon, lat] in, meters out).
// An equirectangular projection around each point is accurate to well under 1% at Paradise's scale.
import type { AreaGeometry, LonLat } from "./types";

const M_PER_DEG_LAT = 111_320;

function project(origin: LonLat, p: LonLat): [number, number] {
  const k = Math.cos((origin[1] * Math.PI) / 180) * M_PER_DEG_LAT;
  return [(p[0] - origin[0]) * k, (p[1] - origin[1]) * M_PER_DEG_LAT];
}

export function distanceM(a: LonLat, b: LonLat): number {
  const [x, y] = project(a, b);
  return Math.hypot(x, y);
}

/** Shortest distance from `p` to the polyline `line`, meters. */
export function distanceToLineM(p: LonLat, line: readonly LonLat[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return distanceM(p, line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = project(p, line[i - 1]);
    const [bx, by] = project(p, line[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function inRing(p: LonLat, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygons(geometry: AreaGeometry): LonLat[][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

export function pointInArea(p: LonLat, geometry: AreaGeometry): boolean {
  return polygons(geometry).some((poly) => poly[0] && inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h)));
}

/** 0 inside the area, else the distance to its nearest edge, meters. */
export function distanceToAreaM(p: LonLat, geometry: AreaGeometry): number {
  if (pointInArea(p, geometry)) return 0;
  let best = Infinity;
  for (const poly of polygons(geometry)) for (const ring of poly) best = Math.min(best, distanceToLineM(p, ring));
  return best;
}

/** The point a `fraction` (0..1) of the way along `line` by length. */
export function alongLine(line: readonly LonLat[], fraction: number): LonLat {
  if (line.length < 2) return line[0];
  const lengths = line.slice(1).map((p, i) => distanceM(line[i], p));
  let target = lengths.reduce((a, b) => a + b, 0) * fraction;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : Math.min(1, target / lengths[i]);
      const [a, b] = [line[i], line[i + 1]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    target -= lengths[i];
  }
  return line[line.length - 1];
}

/** True when `route` runs along the road `segment`, not merely through one of its end intersections:
 *  at least two of the segment's quarter points lie within `m` meters of the route. */
export function routeUsesSegment(segment: readonly LonLat[], route: readonly LonLat[], m = 30): boolean {
  if (segment.length < 2) return segment.length === 1 && distanceToLineM(segment[0], route) <= m;
  return [0.25, 0.5, 0.75].filter((f) => distanceToLineM(alongLine(segment, f), route) <= m).length >= 2;
}
