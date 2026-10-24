// The review queue (D7): open field reports grouped into items the controller decides on,
// with the new / conflicting / stale / high-impact flags and an impact score. Pure: no React.
import { KIND_LABEL, labelPoint, nf, shortZoneName } from "./format";
import { distanceM, distanceToAreaM, distanceToLineM, pointInArea, routeUsesSegment } from "./geo";
import type { CheckTask, CommandResponse, FieldReport, HelpRequest, LonLat, ReportKind, ZoneGuidance } from "./types";

export type QueueFilter = "new" | "conflicting" | "stale" | "high";

const CLOSED = new Set(["dismissed", "resolved"]);
const ROAD_KINDS = new Set<ReportKind>(["road_blocked", "road_passable", "heavy_traffic"]);
/** Reports a controller has not reviewed yet. */
const UNREVIEWED = new Set(["unverified", "corroborated", "responder_confirmed"]);
/** Mirrors livecore.public.HALF_LIFE_S: past one half-life without a new observation is stale. */
const HALF_LIFE_S: Partial<Record<ReportKind, number>> = {
  fire_seen: 900,
  heavy_smoke: 900,
  heavy_traffic: 900,
  road_blocked: 7200,
  road_passable: 7200,
  hazard_down: 14400,
  shelter_full: 3600,
};
const DEFAULT_HALF_LIFE_S = 3600;
/** Mirrors livecore.public.CLUSTER_RADIUS_M: same-kind off-road reports this close form one item. */
const CLUSTER_RADIUS_M = 200;
/** A road report without a segment line is on a route when it lies this close to the route line. */
const ROUTE_NEAR_ROAD_M = 25;
/** An off-road item (fire, smoke, hazard) is near a route within this distance. */
const ROUTE_NEAR_POINT_M = 300;
/** A fire report this far outside the fire estimate contradicts it. */
const FIRE_CONFLICT_M = 1500;
/** Vehicles affected at or above which an item counts as high impact even off the routes. */
export const HIGH_IMPACT_VEH = 1000;
const FIXTURE_NOTE = /^drill fixture/i;

/** Seeded drill reports carry this note; the UI labels them "Fixture" instead of quoting it. */
export const isFixtureNote = (note: string | null) => !!note && FIXTURE_NOTE.test(note);

export interface QueueItem {
  id: string;
  kind: ReportKind;
  title: string;
  coord: LonLat;
  line: LonLat[] | null;
  segmentId: string | null;
  roadName: string | null;
  /** Not dismissed or resolved, newest first. */
  reports: FieldReport[];
  civilians: number;
  responders: number;
  newestObservedAt: string;
  confirmed: boolean;
  fixture: boolean;
  isNew: boolean;
  conflict: string | null;
  stale: boolean;
  /** Zone ids whose published route passes the item. */
  routeZones: string[];
  /** Vehicles in the zones the item affects (bundle counts). */
  vehicles: number;
  high: boolean;
  task: CheckTask | null;
  /** A need-help check-in instead of reports (`reports` is empty). */
  help: HelpRequest | null;
}

function titleFor(kind: ReportKind, road: string | null, destination: string | null): string {
  if (kind === "road_blocked") return road ? `${road} blocked` : "Road blocked";
  if (kind === "road_passable") return road ? `${road} passable` : "Road passable";
  if (kind === "heavy_traffic") return road ? `Heavy traffic on ${road}` : "Heavy traffic";
  if (kind === "shelter_full") return destination ? `${destination} full` : "Shelter full";
  return KIND_LABEL[kind] ?? kind;
}

function group(reports: FieldReport[]): FieldReport[][] {
  const bySegment = new Map<string, FieldReport[]>();
  const byDestination = new Map<string, FieldReport[]>();
  const clusters: FieldReport[][] = [];
  for (const r of reports) {
    if (ROAD_KINDS.has(r.kind) && r.road_ref) {
      const key = r.road_ref.segment_id;
      bySegment.set(key, [...(bySegment.get(key) ?? []), r]);
    } else if (r.kind === "shelter_full" && r.destination_id) {
      byDestination.set(r.destination_id, [...(byDestination.get(r.destination_id) ?? []), r]);
    } else if (r.kind === "help_needed") {
      clusters.push([r]);
    } else {
      const near = clusters.find(
        (c) => c[0].kind === r.kind && distanceM(c[0].location.coord, r.location.coord) <= CLUSTER_RADIUS_M,
      );
      if (near) near.push(r);
      else clusters.push([r]);
    }
  }
  return [...bySegment.values(), ...byDestination.values(), ...clusters];
}

function newest(rs: FieldReport[]): FieldReport {
  return rs.reduce((a, b) => (b.observed_at > a.observed_at ? b : a));
}

function conflictOf(rs: FieldReport[], data: CommandResponse, coord: LonLat): string | null {
  const kinds = new Set(rs.map((r) => r.kind));
  if (kinds.has("road_blocked") && kinds.has("road_passable")) {
    const blocked = rs.filter((r) => r.kind === "road_blocked").length;
    const passable = rs.filter((r) => r.kind === "road_passable").length;
    return `${nf(blocked)} blocked, ${nf(passable)} passable`;
  }
  if (kinds.has("fire_seen")) {
    const fire = data.fire.geometry;
    if (!fire) return "No fire estimate to compare";
    const m = distanceToAreaM(coord, fire);
    if (m > FIRE_CONFLICT_M) return `${(m / 1000).toFixed(1)} km outside the fire estimate`;
  }
  return null;
}

function routeZonesFor(
  coord: LonLat,
  line: LonLat[] | null,
  routes: ZoneGuidance[],
  destinationId: string | null,
  onRoad: boolean,
): string[] {
  const out: string[] = [];
  for (const g of routes) {
    const routeLine = g.route?.line;
    if (!routeLine) continue;
    if (destinationId) {
      if (g.destination?.id === destinationId) out.push(g.zone_id);
      continue;
    }
    const near = line
      ? routeUsesSegment(line, routeLine)
      : distanceToLineM(coord, routeLine) <= (onRoad ? ROUTE_NEAR_ROAD_M : ROUTE_NEAR_POINT_M);
    if (near) out.push(g.zone_id);
  }
  return out;
}

/** Every open item, sorted by impact (vehicles affected, then on-route, then newest). */
export function buildQueue(data: CommandResponse, serverNowMs: number): QueueItem[] {
  const open = data.reports.filter((r) => !CLOSED.has(r.status));
  const routes = data.guidance.filter((g) => g.level !== "none" && g.route && !g.no_route);
  const vehicles = new Map(data.zones.map((z) => [z.id, z.vehicles]));
  const levels = new Map(data.guidance.map((g) => [g.zone_id, g.level]));
  const segmentLines = new Map<string, LonLat[]>();
  for (const item of data.public_items) {
    if (item.road_ref && item.line) segmentLines.set(item.road_ref.segment_id, item.line);
  }
  const destinations = new Map(data.destinations.map((d) => [d.id, d]));
  const taskByReport = new Map<string, CheckTask>();
  for (const t of data.tasks) {
    if (t.status !== "open" && t.status !== "accepted") continue;
    for (const id of t.report_ids) taskByReport.set(id, t);
  }

  const items: QueueItem[] = [];
  for (const rs of group(open)) {
    rs.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    const head = newest(rs);
    const segmentId = ROAD_KINDS.has(head.kind) ? (head.road_ref?.segment_id ?? null) : null;
    const roadName = head.road_ref?.name ?? null;
    const destinationId = head.kind === "shelter_full" ? head.destination_id : null;
    const line = segmentId ? (segmentLines.get(segmentId) ?? null) : null;
    const coord: LonLat = destinationId
      ? (destinations.get(destinationId)?.coord ?? head.location.coord)
      : line
        ? line[Math.floor(line.length / 2)]
        : head.location.coord;
    // The title follows the newest road report on a segment, so a reopened road reads "passable".
    const kind = head.kind;
    const confirmed = rs.some((r) => r.status === "confirmed");
    const parties = new Set(rs.filter((r) => r.reporter.role === "civilian").map((r) => r.reporter.party_key));
    const halfLife = HALF_LIFE_S[kind] ?? DEFAULT_HALF_LIFE_S;
    const stale = serverNowMs - new Date(head.observed_at).getTime() > halfLife * 1000;
    const routeZones = kind === "help_needed" ? [] : routeZonesFor(coord, line, routes, destinationId, segmentId !== null);
    const affected = new Set(routeZones);
    for (const z of data.zones) {
      const level = levels.get(z.id);
      if (level && level !== "none" && pointInArea(coord, z.geometry)) affected.add(z.id);
    }
    const veh = [...affected].reduce((sum, id) => sum + (vehicles.get(id) ?? 0), 0);
    const conflict = conflictOf(rs, data, coord);
    items.push({
      id: segmentId ? `seg:${segmentId}` : destinationId ? `dest:${destinationId}` : `rpt:${rs[rs.length - 1].id}`,
      kind,
      title: titleFor(kind, roadName, destinationId ? (destinations.get(destinationId)?.name ?? null) : null),
      coord,
      line,
      segmentId,
      roadName,
      reports: rs,
      civilians: parties.size,
      responders: rs.filter((r) => r.reporter.role === "responder").length,
      newestObservedAt: head.observed_at,
      confirmed,
      fixture: rs.every((r) => isFixtureNote(r.note)),
      isNew: !confirmed && !stale && rs.some((r) => UNREVIEWED.has(r.status)),
      conflict,
      stale,
      routeZones,
      vehicles: veh,
      high: routeZones.length > 0 || veh >= HIGH_IMPACT_VEH,
      task: rs.map((r) => taskByReport.get(r.id)).find((t) => !!t) ?? null,
      help: null,
    });
  }
  items.push(...helpItems(data));
  items.sort(
    (a, b) =>
      Number(!!b.help) - Number(!!a.help) ||
      b.vehicles - a.vehicles ||
      b.routeZones.length - a.routeZones.length ||
      b.newestObservedAt.localeCompare(a.newestObservedAt),
  );
  return items;
}

/** Open need-help check-ins: people, so they sort above every report. Placed at the shared
 * location, else at the zone's label point; one with neither is left to the map's count. */
function helpItems(data: CommandResponse): QueueItem[] {
  const zones = new Map(data.zones.map((z) => [z.id, z]));
  const tasks = new Map(data.tasks.map((t) => [t.id, t]));
  const out: QueueItem[] = [];
  for (const h of data.checkins.need_help) {
    const status = h.help?.status ?? "open";
    if (status === "resolved") continue;
    const zone = h.zone_id ? zones.get(h.zone_id) : undefined;
    const coord = h.coord ?? (zone ? labelPoint(zone.geometry) : null);
    if (!coord) continue;
    out.push({
      id: `help:${h.id}`,
      kind: "help_needed",
      title: zone ? `Help needed, ${shortZoneName(zone.name)}` : "Help needed",
      coord,
      line: null,
      segmentId: null,
      roadName: null,
      reports: [],
      civilians: 1,
      responders: 0,
      newestObservedAt: h.at,
      confirmed: status !== "open",
      fixture: false,
      isNew: status === "open",
      conflict: null,
      stale: false,
      routeZones: [],
      vehicles: 0,
      high: true,
      task: h.help?.task_id ? (tasks.get(h.help.task_id) ?? null) : null,
      help: h,
    });
  }
  return out;
}

export function matches(item: QueueItem, filter: QueueFilter): boolean {
  if (filter === "new") return item.isNew;
  if (filter === "conflicting") return item.conflict !== null;
  if (filter === "stale") return item.stale;
  return item.high;
}

/** The pending proposal an item caused or feeds, if any. */
export function proposalFor(item: QueueItem, data: CommandResponse): string | null {
  const ids = new Set(item.reports.map((r) => r.id));
  for (const p of data.proposals) {
    if (p.status !== "pending") continue;
    if (item.segmentId && (p.cause_segment_ids ?? []).includes(item.segmentId)) return p.id;
    if (item.segmentId && p.inputs.blocked_segment_ids.includes(item.segmentId) && item.confirmed) return p.id;
    if (p.tasks.some((t) => t.report_ids.some((id) => ids.has(id)))) return p.id;
  }
  return null;
}
