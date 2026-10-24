// Pure time and data lookups for the replay view. No React, DOM or MapLibre here.
import type { ClosureInterval, EvidenceClass, ReplayEvent, ReplayModel, TrafficMetrics } from "./types";

/** Index of the last item with atMs <= t, or -1 if every item is later. Items ascend by atMs. */
export function lastAtOrBefore(items: readonly { atMs: number }[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].atMs <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The perimeter in effect applies from its `at` until the next snapshot; no interpolation. */
export function perimeterIndexAt(model: ReplayModel, t: number): number {
  return lastAtOrBefore(model.perimeters, t);
}

export function frameIndexAt(model: ReplayModel, t: number): number {
  return model.traffic ? lastAtOrBefore(model.traffic.frames, t) : -1;
}

/** Traffic edge indices closed at frame k (first_closed_frame <= k < reopened_frame), ascending. */
export function closedEdgesAt(closures: readonly ClosureInterval[], k: number): number[] {
  if (k < 0) return [];
  const out: number[] = [];
  for (const [edge, first, reopened] of closures) {
    if (first <= k && (reopened === null || k < reopened)) out.push(edge);
  }
  return out.sort((a, b) => a - b);
}

export function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Simulated front in effect, shown only before the first observed perimeter (after that the
 * observed perimeter drives the hazard). -1 when none applies.
 */
export function simulatedFrontIndexAt(model: ReplayModel, t: number): number {
  const sim = model.fireSimulated;
  if (!sim) return -1;
  const firstObserved = model.perimeters[0]?.atMs ?? Infinity;
  if (t >= firstObserved) return -1;
  return lastAtOrBefore(sim.fronts, t);
}

export function clampTime(model: ReplayModel, t: number): number {
  return Math.min(model.clock.endMs, Math.max(model.clock.startMs, t));
}

/** Zone ids with an evacuation order (or warning) issued at or before event index `upTo`. */
export function zoneStatesAt(
  events: readonly ReplayEvent[],
  upTo: number,
): Map<string, "ordered" | "warned"> {
  const states = new Map<string, "ordered" | "warned">();
  for (let i = 0; i <= upTo && i < events.length; i += 1) {
    const kind = eventCategory(events[i].type);
    if (kind !== "order" && kind !== "warning") continue;
    for (const id of events[i].zoneIds) {
      if (kind === "order") states.set(id, "ordered");
      else if (!states.has(id)) states.set(id, "warned");
    }
  }
  return states;
}

export type EventCategory = "fire" | "order" | "warning" | "closure" | "other";

export function eventCategory(type: string): EventCategory {
  const t = type.toLowerCase();
  if (t.includes("clos")) return "closure";
  if (t.includes("warning") || t.includes("alert")) return "warning";
  if (t.includes("order") || t.includes("evacuat")) return "order";
  if (t.includes("perimeter") || t.includes("fire") || t.includes("ignition")) return "fire";
  return "other";
}

export const EVIDENCE_LABEL: Record<EvidenceClass, string> = {
  observed: "Observed",
  reported: "Reported",
  reconstructed: "Reconstructed",
  derived: "Derived",
  simulated: "Simulated",
  fixture: "Fixture",
};

/** Short provenance phrase used next to the perimeter age, e.g. "satellite estimate". */
export const PERIMETER_PROVENANCE: Record<EvidenceClass, string> = {
  observed: "observed record",
  reported: "reported perimeter",
  reconstructed: "satellite/expert reconstruction",
  derived: "derived estimate",
  simulated: "simulated",
  fixture: "synthetic fixture",
};

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function formatDuration(seconds: number): string {
  return formatAge(seconds * 1000);
}

export interface ClockParts {
  date: string;
  time: string;
  zone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function clockParts(ms: number, timeZone: string): ClockParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(ms)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    zone: timeZone === "UTC" ? "UTC" : (parts.timeZoneName ?? timeZone),
  };
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** 16-point compass name for a bearing in degrees (0 = north, clockwise). */
export function compassPoint(deg: number): string {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** "HH:MM TZ" in the given zone, or an em dash for null. */
export function localTime(ms: number | null, timeZone: string): string {
  if (ms === null) return "—";
  const p = clockParts(ms, timeZone);
  return `${p.time.slice(0, 5)} ${p.zone}`;
}

export type MetricKey = Exclude<keyof TrafficMetrics, "atMs">;

/** Evenly downsampled metric series for sparklines, keeping the first and last rows. */
export function metricSeries(
  rows: readonly TrafficMetrics[],
  key: MetricKey,
  maxPoints: number,
): { atMs: number; value: number }[] {
  if (rows.length === 0) return [];
  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out: { atMs: number; value: number }[] = [];
  for (let i = 0; i < rows.length; i += stride) out.push({ atMs: rows[i].atMs, value: rows[i][key] });
  const last = rows[rows.length - 1];
  if (out[out.length - 1].atMs !== last.atMs) out.push({ atMs: last.atMs, value: last[key] });
  return out;
}

/**
 * How the model fire's ignition was placed: "reconstructed" when its provenance says so
 * (e.g. NIST time and origin), otherwise "assumed".
 */
export function ignitionBasis(model: ReplayModel): "assumed" | "reconstructed" {
  const p = model.fireSimulated?.ignition?.provenance ?? "";
  return /^reconstructed\b/i.test(p) ? "reconstructed" : "assumed";
}

/** Calendar year of the incident (clock start, local time). */
export function incidentYear(model: ReplayModel): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: model.incident.timezone, year: "numeric" }).format(
    model.clock.startMs,
  );
}

/** Short name of who recorded the fire observations ("NIST"), or a neutral word. */
export function observationSource(model: ReplayModel): string {
  const label = model.fireObservations?.sourceLabel ?? "";
  return /\bNIST\b/.test(label) ? "NIST" : "recorded";
}

export function hasFixtureData(model: ReplayModel): boolean {
  return Object.values(model.layerStatus).some((s) => s.status === "fixture");
}

export interface TickBucket {
  key: string;
  category: EventCategory;
  fraction: number;
  count: number;
  label: string;
}

/** Collapse events into at most `buckets` positions per category so dense timelines stay legible. */
export function eventTicks(
  events: readonly ReplayEvent[],
  startMs: number,
  endMs: number,
  buckets: number,
): TickBucket[] {
  const span = Math.max(1, endMs - startMs);
  const byKey = new Map<string, TickBucket>();
  for (const event of events) {
    if (event.atMs < startMs || event.atMs > endMs) continue;
    const category = eventCategory(event.type);
    const bucket = Math.min(buckets - 1, Math.floor(((event.atMs - startMs) / span) * buckets));
    const key = `${category}:${bucket}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, {
        key,
        category,
        fraction: (event.atMs - startMs) / span,
        count: 1,
        label: event.label,
      });
    }
  }
  return Array.from(byKey.values());
}
