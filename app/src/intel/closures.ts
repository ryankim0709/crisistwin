/**
 * Confirmed, publicly reported road closures resolved onto a dispatch area's edges
 * (docs/incident-intel.md (e)). Pure; the backend stores geometry, never edge indices.
 * Reported closures only block routing; they never change the fire model.
 */

import {
  groundMeters,
  type Bbox,
  type DispatchArea,
  type LonLat,
  type RoadEdge,
} from "../dispatch/area";
import type { IntelCandidate } from "./api";

export interface ClosureMatch {
  eventId: string;
  edges: number[];
  /** True when a later confirmed reopening of the same road lifts this closure. */
  lifted: boolean;
}
export interface ClosureResolution {
  closedEdges: Set<number>;
  /** One per closure; an empty `edges` is a closure that matched no road in this area. */
  matches: ClosureMatch[];
}

const SUFFIXES = new Set([
  "st",
  "street",
  "rd",
  "road",
  "ave",
  "avenue",
  "blvd",
  "boulevard",
  "dr",
  "drive",
  "ln",
  "lane",
  "hwy",
  "highway",
  "way",
  "ct",
  "court",
  "pl",
  "place",
  "pkwy",
  "parkway",
]);

/** Case, punctuation and road-suffix insensitive road name; "" when nothing is left. */
export function normaliseRoadName(name: string | null | undefined): string {
  const words = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const kept = words.filter((word) => !SUFFIXES.has(word));
  return (kept.length > 0 ? kept : words).join(" ");
}

/** Metres from `point` to the polyline, by the shortest segment distance. */
function distanceToPolyline(point: LonLat, coords: readonly LonLat[]): number {
  let best = Infinity;
  for (let i = 0; i < coords.length; i += 1) {
    const a = coords[i];
    const b = coords[i + 1] ?? a;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2));
    best = Math.min(best, groundMeters(point, [a[0] + t * dx, a[1] + t * dy]));
  }
  return best;
}

function edgesNear(area: DispatchArea, name: string, point: LonLat, radius: number): RoadEdge[] {
  return area.edges.filter(
    (edge) =>
      normaliseRoadName(edge.name) === name && distanceToPolyline(point, edge.coords) <= radius,
  );
}

export function resolveClosureEdges(
  area: DispatchArea,
  closures: readonly IntelCandidate[],
): ClosureResolution {
  const confirmed = closures
    .filter(
      (c) => c.review_status === "confirmed" && c.mapping && normaliseRoadName(c.mapping.road_name),
    )
    .sort(
      (a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id),
    );
  const closedEdges = new Set<number>();
  const matches: ClosureMatch[] = [];
  const reopenings = confirmed.filter((c) => c.type === "road_reopened");
  for (const closure of confirmed) {
    if (closure.type !== "road_closed" && closure.type !== "road_blocked") continue;
    const { mapping } = closure;
    if (!mapping) continue;
    const name = normaliseRoadName(mapping.road_name);
    const edges = edgesNear(area, name, mapping.point, mapping.radius_m).map((e) => e.index);
    // A later confirmed reopening of the same road within its radius lifts the closure.
    const lifted = reopenings.some(
      (r) =>
        r.occurred_at > closure.occurred_at &&
        r.mapping &&
        normaliseRoadName(r.mapping.road_name) === name &&
        groundMeters(r.mapping.point, mapping.point) <=
          Math.max(r.mapping.radius_m, mapping.radius_m),
    );
    matches.push({ eventId: closure.event_id, edges, lifted });
    if (!lifted) for (const edge of edges) closedEdges.add(edge);
  }
  return { closedEdges, matches };
}

/** Reported closure types that block live routing; `road_reopened` only lifts them. */
export const BLOCKING_TYPES: readonly string[] = ["road_closed", "road_blocked"];

function inBbox(point: LonLat, [west, south, east, north]: Bbox): boolean {
  return point[0] >= west && point[0] <= east && point[1] >= south && point[1] <= north;
}

/**
 * Which reports may touch a live session (docs/incident-intel.md (e)): planner-confirmed,
 * from a live-mode document (`mode === "live"`; archive captures are history and never apply),
 * of a closure or reopening type, with a mapped point inside the session area's bbox.
 * A later confirmed reopening of the same road lifts a closure (`resolveClosureEdges`).
 */
export function liveSessionReports(
  area: DispatchArea,
  candidates: readonly IntelCandidate[],
): IntelCandidate[] {
  return candidates.filter(
    (c) =>
      c.review_status === "confirmed" &&
      c.mode === "live" &&
      (BLOCKING_TYPES.includes(c.type) || c.type === "road_reopened") &&
      c.mapping !== null &&
      inBbox(c.mapping.point, area.bbox),
  );
}

export interface LiveClosures {
  /** Edges no live route may use; pass as `SessionInputs.closedEdges` at start. */
  closedEdges: Set<number>;
  /** Blocking reports in force that matched at least one road segment. */
  applied: IntelCandidate[];
  /** Blocking reports in force that matched no road in this area: listed, never dropped. */
  unmatched: IntelCandidate[];
  /** Blocking reports lifted by a later confirmed reopening. */
  lifted: IntelCandidate[];
}

/** Applies `liveSessionReports` then resolves the closures onto `area`'s edges. */
export function liveClosures(
  area: DispatchArea,
  candidates: readonly IntelCandidate[],
): LiveClosures {
  const reports = liveSessionReports(area, candidates);
  const { closedEdges, matches } = resolveClosureEdges(area, reports);
  const byId = new Map(matches.map((m) => [m.eventId, m]));
  const result: LiveClosures = { closedEdges, applied: [], unmatched: [], lifted: [] };
  for (const report of reports) {
    if (!BLOCKING_TYPES.includes(report.type)) continue;
    // No match entry: the mapped road name normalised to nothing, so it cannot match a road.
    const match = byId.get(report.event_id);
    if (match?.lifted) result.lifted.push(report);
    else if (!match || match.edges.length === 0) result.unmatched.push(report);
    else result.applied.push(report);
  }
  return result;
}
