/**
 * When the modelled fire reaches points of the dispatch area, read from the scheduled run's
 * frame perimeters. Arrival is resolved to frame resolution (the studio's 5-minute display
 * steps plus ignition minutes): a point first inside frame k has arrival frame k's minute.
 * The combined footprint only grows, so each point needs a binary search over frames.
 */

import type { Polygon, Position } from "geojson";
import type { ScheduledFireFrame } from "../fire/scheduledTypes";
import type { DispatchArea, LonLat } from "./area";

interface IndexedPolygon {
  bbox: [number, number, number, number];
  rings: Position[][];
}

function indexPolygon(geometry: Polygon): IndexedPolygon {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of geometry.coordinates[0] ?? []) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { bbox: [minX, minY, maxX, maxY], rings: geometry.coordinates };
}

function inRing(ring: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(polygon: IndexedPolygon, x: number, y: number): boolean {
  const [minX, minY, maxX, maxY] = polygon.bbox;
  if (x < minX || x > maxX || y < minY || y > maxY) return false;
  if (!inRing(polygon.rings[0], x, y)) return false;
  for (let h = 1; h < polygon.rings.length; h += 1) {
    if (inRing(polygon.rings[h], x, y)) return false;
  }
  return true;
}

export interface FireExposure {
  /** Modelled arrival minute per graph node; Infinity when not reached within the horizon. */
  nodeArrival: Float64Array;
  /** Earliest arrival over each edge's endpoints and middle vertex. */
  edgeArrival: Float64Array;
  /** First fire contact anywhere in each zone (hull vertices, centroid, loading node). */
  zoneContact: Float64Array;
  /** Fire reaches the zone's core (loading node or centroid): remaining vehicles are exposed. */
  zoneCore: Float64Array;
}

/** Arrival minute of each point, by binary search over the growing footprint. */
export function arrivalMinutes(points: readonly LonLat[], frames: readonly ScheduledFireFrame[]): Float64Array {
  const indexed = frames.map((frame) => frame.perimeters.map((p) => indexPolygon(p.geometry)));
  const burnedAt = (k: number, [x, y]: LonLat) => indexed[k].some((polygon) => inPolygon(polygon, x, y));
  const result = new Float64Array(points.length).fill(Infinity);
  const last = frames.length - 1;
  if (last < 0) return result;
  points.forEach((point, i) => {
    if (!burnedAt(last, point)) return;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (burnedAt(mid, point)) hi = mid;
      else lo = mid + 1;
    }
    result[i] = frames[lo].elapsedMinutes;
  });
  return result;
}

export function computeExposure(area: DispatchArea, frames: readonly ScheduledFireFrame[]): FireExposure {
  const midpoints = area.edges.map((edge) => edge.coords[Math.floor(edge.coords.length / 2)]);
  const zonePoints = area.zones.map((zone) => [...zone.polygon, zone.centroid]);
  const flatZonePoints = zonePoints.flat();
  const [nodeArrival, midArrival, zoneArrival] = [
    arrivalMinutes(area.nodes, frames),
    arrivalMinutes(midpoints, frames),
    arrivalMinutes(flatZonePoints, frames),
  ];

  const edgeArrival = new Float64Array(area.edges.length);
  area.edges.forEach((edge, i) => {
    edgeArrival[i] = Math.min(nodeArrival[edge.from], nodeArrival[edge.to], midArrival[i]);
  });

  const zoneContact = new Float64Array(area.zones.length);
  const zoneCore = new Float64Array(area.zones.length);
  let offset = 0;
  area.zones.forEach((zone, i) => {
    const count = zonePoints[i].length;
    let contact = nodeArrival[zone.node];
    for (let k = 0; k < count; k += 1) contact = Math.min(contact, zoneArrival[offset + k]);
    const centroidArrival = zoneArrival[offset + count - 1];
    zoneContact[i] = contact;
    zoneCore[i] = Math.min(nodeArrival[zone.node], centroidArrival);
    offset += count;
  });

  return { nodeArrival, edgeArrival, zoneContact, zoneCore };
}
