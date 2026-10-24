// Pure lookups for the responder and evacuee tabs. All results are model output, not evidence.
import type { AreaGeometry, ArrivalGrid, LngLat, ReplayModel, Zone } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
/** A closed edge this close to an exit counts as "closure near this exit". */
export const EXIT_CLOSURE_RADIUS_M = 150;
// Threat bands for roads, in seconds until modelled fire arrival.
export const THREAT_SOON_S = 30 * 60;
export const THREAT_IMMINENT_S = 10 * 60;

export function distanceM(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type ArrivalLookup =
  | { status: "outside" }
  | { status: "not_reached" }
  | { status: "reached"; atMs: number };

/** Modelled fire arrival at a point, using the contract's grid formula. */
export function arrivalAt(grid: ArrivalGrid, [lon, lat]: LngLat): ArrivalLookup {
  const col = Math.floor(((lon - grid.originLon) * grid.mPerDegLon) / grid.cellM);
  const row = Math.floor(((lat - grid.originLat) * grid.mPerDegLat) / grid.cellM);
  if (col < 0 || row < 0 || col >= grid.ncols || row >= grid.nrows) return { status: "outside" };
  const minutes = grid.minutes[row * grid.ncols + col];
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return { status: "not_reached" };
  return { status: "reached", atMs: grid.t0Ms + minutes * 60_000 };
}

function inRing(ring: LngLat[], [x, y]: LngLat): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(rings: LngLat[][], p: LngLat): boolean {
  return rings.length > 0 && inRing(rings[0], p) && !rings.slice(1).some((hole) => inRing(hole, p));
}

export function inArea(g: AreaGeometry, p: LngLat): boolean {
  return g.type === "Polygon" ? inPolygon(g.coordinates, p) : g.coordinates.some((poly) => inPolygon(poly, p));
}

/** Mean of the outer ring's vertices; good enough to place a pin inside a convex zone. */
export function areaCenter(g: AreaGeometry): LngLat {
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

export function zoneAt(zones: readonly Zone[], p: LngLat): Zone | null {
  for (const zone of zones) {
    if (inArea(zone.geometry, p)) return zone;
  }
  return null;
}

export interface NearbyDestination {
  id: string;
  name: string;
  kind: string;
  distanceM: number;
  closureNearby: boolean;
}

/** Nearest destinations by straight-line distance, with whether a modelled closure is near each. */
export function nearestDestinations(
  model: ReplayModel,
  p: LngLat,
  closedTrafficEdges: readonly number[],
  count: number,
): NearbyDestination[] {
  const roads = model.roads?.items ?? [];
  const roadById = new Map(roads.map((r) => [r.id, r]));
  const closedCoords: LngLat[] = [];
  for (const ti of closedTrafficEdges) {
    const edge = roadById.get(model.traffic?.edgeIds[ti] ?? "");
    if (edge) closedCoords.push(edge.coords[0], edge.coords[edge.coords.length - 1]);
  }
  return (model.destinations?.items ?? [])
    .map((d) => ({ d, distance: distanceM(p, d.coord) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map(({ d, distance }) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      distanceM: distance,
      closureNearby: closedCoords.some((c) => distanceM(c, d.coord) <= EXIT_CLOSURE_RADIUS_M),
    }));
}

export interface ThreatenedRoad {
  name: string;
  /** Traffic edge indices sharing this name within the window. */
  edges: number[];
  firstArrivalMs: number;
}

/**
 * Roads (grouped by name) whose modelled fire arrival falls in (now, now + windowS], soonest
 * first. Unnamed edges are grouped under their highway class.
 */
export function roadsCutWithin(model: ReplayModel, nowMs: number, windowS: number): ThreatenedRoad[] {
  const arrivals = model.insights?.edgeFireArrivalS ?? [];
  const traffic = model.traffic;
  if (!traffic || arrivals.length === 0) return [];
  const roadById = new Map((model.roads?.items ?? []).map((r) => [r.id, r]));
  const groups = new Map<string, ThreatenedRoad>();
  for (let i = 0; i < arrivals.length; i += 1) {
    const s = arrivals[i];
    if (s == null) continue;
    const at = model.clock.startMs + s * 1000;
    if (at <= nowMs || at > nowMs + windowS * 1000) continue;
    const edge = roadById.get(traffic.edgeIds[i]);
    const name = edge?.name ?? `Unnamed ${edge?.highway ?? "road"}`;
    const group = groups.get(name);
    if (group) {
      group.edges.push(i);
      group.firstArrivalMs = Math.min(group.firstArrivalMs, at);
    } else {
      groups.set(name, { name, edges: [i], firstArrivalMs: at });
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.firstArrivalMs - b.firstArrivalMs);
}

/** Threat code per traffic edge: 2 within 10 min, 1 within 30 min, 0 otherwise. */
export function edgeThreats(model: ReplayModel, nowMs: number): Map<number, 1 | 2> {
  const out = new Map<number, 1 | 2>();
  const arrivals = model.insights?.edgeFireArrivalS ?? [];
  for (let i = 0; i < arrivals.length; i += 1) {
    const s = arrivals[i];
    if (s == null) continue;
    const until = model.clock.startMs + s * 1000 - nowMs;
    if (until <= 0 || until > THREAT_SOON_S * 1000) continue;
    out.set(i, until <= THREAT_IMMINENT_S * 1000 ? 2 : 1);
  }
  return out;
}
