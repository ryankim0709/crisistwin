import type { AreaGeometry, ChangeKind, DrillState, GuidanceLevel, LonLat, ReportKind, ReportStatus } from "./types";

export const LEVEL_LABEL: Record<GuidanceLevel, string> = {
  evacuate_now: "Evacuate now",
  be_ready: "Be ready",
  none: "No order",
};

/** The verdict phones show (design spec "Exact copy"); the web plates use the same words. */
export const VERDICT: Record<GuidanceLevel, string> = {
  evacuate_now: "Leave now",
  be_ready: "Be ready to leave",
  none: "No order",
};

export const KIND_LABEL: Record<ReportKind, string> = {
  road_blocked: "Road blocked",
  road_passable: "Road passable",
  heavy_traffic: "Heavy traffic",
  fire_seen: "Fire seen",
  heavy_smoke: "Heavy smoke",
  hazard_down: "Hazard down",
  shelter_full: "Shelter full",
  help_needed: "Help needed",
};

export const STATUS_LABEL: Record<ReportStatus, string> = {
  unverified: "Unverified",
  corroborated: "Corroborated",
  responder_confirmed: "Responder confirmed",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
  resolved: "Resolved",
};

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  reroute: "Reroute",
  route_lost: "Route lost",
  level_change: "Level change",
  new: "New",
  cleared: "Cleared",
};

/** Drill times are 2018 replay instants, shown in UTC to match the server's fire labels. */
export function drillClock(iso: string | null | undefined, seconds = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

export function drillDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

/** Wall-clock times, in the viewer's zone. */
export function wallClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 10)}…` : key;
}

/** Vertex mean of the largest outer ring: a label anchor, not a true centroid. */
export function labelPoint(geometry: AreaGeometry): LonLat | null {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best: LonLat[] | null = null;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (ring && (!best || ring.length > best.length)) best = ring;
  }
  if (!best || best.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const [lon, lat] of best) {
    x += lon;
    y += lat;
  }
  return [x / best.length, y / best.length];
}

/** A short elapsed duration: "42 s", "3 min", "1 h 05 min". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** replay_now advanced locally between polls, with the server's formula and clamp. */
export function drillNowAt(drill: DrillState, receivedAt: number | null, nowMs: number): string {
  if (!drill.running || receivedAt === null) return drill.replay_now;
  const base = new Date(drill.replay_now).getTime();
  const end = new Date(drill.clock.end).getTime();
  return new Date(Math.min(end, base + Math.max(0, nowMs - receivedAt) * drill.speed)).toISOString();
}

/** Integer with thousands separators. */
export const nf = (n: number) => Math.round(n).toLocaleString("en-US");

export const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`;

/** "Block Group 1, Census Tract 9.01" -> "Tract 9.01, BG 1"; other names unchanged. */
export function shortZoneName(name: string): string {
  const m = /^Block Group (\S+), Census Tract (\S+)$/.exec(name);
  return m ? `Tract ${m[2]}, BG ${m[1]}` : name;
}

/** "Via Fairview Dr to Walgreens, 2 min" from a route's road names, destination and ETA. */
export function viaLine(via: string[] | undefined, destination: string | null | undefined, etaMin?: number | null): string {
  const parts: string[] = [];
  if (via && via.length) parts.push(`Via ${via.slice(0, 2).join(", ")}`);
  if (destination) parts.push(parts.length ? `to ${destination}` : destination);
  const head = parts.join(" ");
  return etaMin != null ? `${head}, ${etaMin} min` : head;
}
