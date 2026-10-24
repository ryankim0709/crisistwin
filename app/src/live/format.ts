import type { AreaGeometry, ChangeKind, GuidanceLevel, LonLat, ReportKind, ReportStatus } from "./types";

export const LEVEL_LABEL: Record<GuidanceLevel, string> = {
  evacuate_now: "Evacuate now",
  be_ready: "Be ready",
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
