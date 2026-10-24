// Optional phone-panel mobility sidecar (Advan Weekly Patterns Plus via Dewey), schema 1.x.
// Contract: docs/mobility-sidecar.md. Licensed, local-only data; every value is a derived
// aggregate, never a count of people. Pure module (no React, no map).
import { clockParts } from "./timeline";
import { EVIDENCE_CLASSES, type EvidenceClass, type LngLat } from "./types";
import { isObj } from "./validate";

export const MOBILITY_KIND = "crisistwin_mobility";
export const SUPPORTED_MOBILITY_MAJOR = "1.";
/** Baseline arrays are indexed by local hour-of-week, Monday 00:00 = 0. */
export const HOURS_PER_WEEK = 168;
const HOUR_MS = 3_600_000;

/** Region ids the sidecar uses for series. */
export const EVACUATION_AREA = "evacuation_area";
export const SURROUNDING = "surrounding";

export const MOBILITY_BUILD_HINT =
  "uv run -q --no-project --with pyarrow python -m tools.dewey_mobility --subsets <dewey subsets dir> --output-dir app/public/replays";

/**
 * Cell colors, shared by the map layer and the legend so they cannot drift apart. Neutral
 * only (warm = fire, cyan = traffic): brightness encodes visits vs baseline, darker = fewer.
 */
export const MOBILITY_COLORS = {
  below: "#4b5560",
  near: "#9aa4ae",
  above: "#ffffff",
  /** No baseline visits but visits now: drawn as a hollow ring. */
  fresh: "#ffffff",
  flow: "#c3cdd6",
} as const;
/** log2(visits / baseline) at which the color scale saturates (4x either way). */
export const RATIO_SATURATION_LOG2 = 2;
/** Clamp for the ratio; a cell with a baseline but no visits (log2 of 0) sits at the floor. */
export const RATIO_FLOOR_LOG2 = -3;
export const RATIO_CEIL_LOG2 = 3;

export class MobilityError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid mobility sidecar at ${path}: ${problem}.`);
    this.name = "MobilityError";
  }
}

export interface MobilitySeries {
  id: string;
  region: string;
  category: string;
  label: string;
  poiCount: number;
  /** One value per hour_starts entry. */
  visits: number[];
  /** 168 values by local hour-of-week. */
  baseline: number[];
}

export interface MobilityCell {
  id: string;
  center: LngLat;
  poiCount: number;
  inEvacuationArea: boolean;
  visits: number[];
  baseline: number[];
}

export interface MobilityFlow {
  cellId: string;
  center: LngLat;
  /** Lower bound: Advan omits small home-block-group counts. */
  visitors: number;
  baselineVisitors: number;
}

export interface MobilityFlowWeek {
  /** Monday of the week, YYYY-MM-DD, matching eventWeeks. */
  week: string;
  items: MobilityFlow[];
}

export interface Mobility {
  replayId: string;
  incidentPackage: string | null;
  evidenceClass: EvidenceClass;
  provider: string;
  license: string;
  /** Extraction bbox [west, south, east, north]. */
  bbox: [number, number, number, number];
  timezone: string;
  /** UTC epoch ms of each hourly bin (the file stores seconds). */
  hourStartsMs: number[];
  eventWeeks: string[];
  baselineWeeks: string[];
  baselineMethod: string;
  regions: Record<string, { label: string; blockGroups: number | null }>;
  series: MobilitySeries[];
  cells: { sizeDeg: number; minPois: number; items: MobilityCell[] };
  originFlows: { originLabel: string; baselineWeek: string; weeks: MobilityFlowWeek[] } | null;
  notes: string[];
}

type Obj = Record<string, unknown>;

function obj(value: unknown, path: string): Obj {
  if (!isObj(value)) throw new MobilityError(path, "expected an object");
  return value;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new MobilityError(path, "expected an array");
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MobilityError(path, "expected a non-empty string");
  }
  return value;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MobilityError(path, "expected a finite number");
  }
  return value;
}

function nonNeg(value: unknown, path: string): number {
  const n = num(value, path);
  if (n < 0) throw new MobilityError(path, "expected a nonnegative number");
  return n;
}

function strList(value: unknown, path: string): string[] {
  return arr(value, path).map((v, i) => str(v, `${path}[${i}]`));
}

/** A fixed-length array of nonnegative numbers (counts are never negative). */
function counts(value: unknown, length: number, path: string): number[] {
  const list = arr(value, path);
  if (list.length !== length) {
    throw new MobilityError(path, `expected ${length} values, found ${list.length}`);
  }
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    const v = list[i];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new MobilityError(`${path}[${i}]`, "expected a nonnegative finite number");
    }
    out[i] = v;
  }
  return out;
}

function lngLat(value: unknown, path: string): LngLat {
  const list = arr(value, path);
  if (list.length !== 2) throw new MobilityError(path, "expected [lon, lat]");
  const lon = num(list[0], `${path}[0]`);
  const lat = num(list[1], `${path}[1]`);
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new MobilityError(path, "coordinates out of range (expected [lon, lat] degrees)");
  }
  return [lon, lat];
}

function parseSeries(raw: unknown, path: string, hours: number): MobilitySeries {
  const o = obj(raw, path);
  return {
    id: str(o.id, `${path}.id`),
    region: str(o.region, `${path}.region`),
    category: str(o.category, `${path}.category`),
    label: str(o.label, `${path}.label`),
    poiCount: nonNeg(o.poi_count, `${path}.poi_count`),
    visits: counts(o.visits, hours, `${path}.visits`),
    baseline: counts(o.baseline, HOURS_PER_WEEK, `${path}.baseline`),
  };
}

function parseCell(raw: unknown, path: string, hours: number): MobilityCell {
  const o = obj(raw, path);
  return {
    id: str(o.id, `${path}.id`),
    center: lngLat(o.center, `${path}.center`),
    poiCount: nonNeg(o.poi_count, `${path}.poi_count`),
    inEvacuationArea: o.in_evacuation_area === true,
    visits: counts(o.visits, hours, `${path}.visits`),
    baseline: counts(o.baseline, HOURS_PER_WEEK, `${path}.baseline`),
  };
}

function parseFlows(raw: unknown, path: string): Mobility["originFlows"] {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, path);
  const weeks = arr(o.weeks, `${path}.weeks`).map((w, i): MobilityFlowWeek => {
    const wo = obj(w, `${path}.weeks[${i}]`);
    return {
      week: str(wo.week, `${path}.weeks[${i}].week`),
      items: arr(wo.items, `${path}.weeks[${i}].items`).map((item, j): MobilityFlow => {
        const p = `${path}.weeks[${i}].items[${j}]`;
        const io = obj(item, p);
        return {
          cellId: str(io.cell_id, `${p}.cell_id`),
          center: lngLat(io.center, `${p}.center`),
          visitors: nonNeg(io.visitors, `${p}.visitors`),
          baselineVisitors: nonNeg(io.baseline_visitors, `${p}.baseline_visitors`),
        };
      }),
    };
  });
  return {
    originLabel: str(o.origin_label, `${path}.origin_label`),
    baselineWeek: str(o.baseline_week, `${path}.baseline_week`),
    weeks,
  };
}

/** Validates the sidecar and converts it to camelCase, in milliseconds. Throws MobilityError. */
export function parseMobility(data: unknown): Mobility {
  const root = obj(data, "$");
  if (root.kind !== MOBILITY_KIND) {
    throw new MobilityError(
      "$.kind",
      `expected "${MOBILITY_KIND}", found ${JSON.stringify(root.kind)}`,
    );
  }
  const version = str(root.schema_version, "$.schema_version");
  if (!version.startsWith(SUPPORTED_MOBILITY_MAJOR)) {
    throw new MobilityError(
      "$.schema_version",
      `unsupported version ${version} (this viewer reads ${SUPPORTED_MOBILITY_MAJOR}x)`,
    );
  }
  const evidence = str(root.evidence_class, "$.evidence_class");
  if (!(EVIDENCE_CLASSES as readonly string[]).includes(evidence)) {
    throw new MobilityError("$.evidence_class", `unknown evidence class "${evidence}"`);
  }

  const source = obj(root.source, "$.source");
  const bboxList = arr(source.bbox, "$.source.bbox").map((v, i) => num(v, `$.source.bbox[${i}]`));
  if (bboxList.length !== 4) throw new MobilityError("$.source.bbox", "expected [w, s, e, n]");

  const hourStartsMs = arr(root.hour_starts, "$.hour_starts").map(
    (v, i) => num(v, `$.hour_starts[${i}]`) * 1000,
  );
  const hours = hourStartsMs.length;
  if (hours === 0 || hours % HOURS_PER_WEEK !== 0) {
    throw new MobilityError(
      "$.hour_starts",
      `expected a positive multiple of ${HOURS_PER_WEEK} hourly bins, found ${hours}`,
    );
  }
  for (let i = 1; i < hours; i++) {
    if (hourStartsMs[i] <= hourStartsMs[i - 1]) {
      throw new MobilityError(`$.hour_starts[${i}]`, "bins must be strictly increasing");
    }
  }
  const eventWeeks = strList(root.event_weeks, "$.event_weeks");
  if (eventWeeks.length !== hours / HOURS_PER_WEEK) {
    throw new MobilityError(
      "$.event_weeks",
      `${eventWeeks.length} weeks listed but hour_starts covers ${hours / HOURS_PER_WEEK}`,
    );
  }

  const baseline = obj(root.baseline, "$.baseline");
  const regionsRaw = obj(root.regions, "$.regions");
  const regions: Mobility["regions"] = {};
  for (const [id, value] of Object.entries(regionsRaw)) {
    const r = obj(value, `$.regions.${id}`);
    regions[id] = {
      label: str(r.label, `$.regions.${id}.label`),
      blockGroups: typeof r.block_groups === "number" ? r.block_groups : null,
    };
  }

  const cells = obj(root.cells, "$.cells");
  const notes = root.notes === undefined ? [] : strList(root.notes, "$.notes");

  return {
    replayId: str(root.replay_id, "$.replay_id"),
    incidentPackage: typeof root.incident_package === "string" ? root.incident_package : null,
    evidenceClass: evidence as EvidenceClass,
    provider: str(source.provider, "$.source.provider"),
    license: str(source.license, "$.source.license"),
    bbox: bboxList as [number, number, number, number],
    timezone: str(root.timezone, "$.timezone"),
    hourStartsMs,
    eventWeeks,
    baselineWeeks: strList(baseline.weeks, "$.baseline.weeks"),
    baselineMethod: str(baseline.method, "$.baseline.method"),
    regions,
    series: arr(root.series, "$.series").map((s, i) => parseSeries(s, `$.series[${i}]`, hours)),
    cells: {
      sizeDeg: num(cells.size_deg, "$.cells.size_deg"),
      minPois: nonNeg(cells.min_pois, "$.cells.min_pois"),
      items: arr(cells.items, "$.cells.items").map((c, i) =>
        parseCell(c, `$.cells.items[${i}]`, hours),
      ),
    },
    originFlows: parseFlows(root.origin_flows, "$.origin_flows"),
    notes,
  };
}

/** The sidecar sits next to the bundle: "/replays/camp-2018.json" -> "/replays/camp-2018.mobility.json". */
export function mobilityUrlFor(bundleUrl: string): string {
  return bundleUrl.replace(/\.json$/, ".mobility.json");
}

/** Returns null when the sidecar is not served (404, or the Vite dev server's HTML fallback). */
export async function fetchMobility(url: string, signal: AbortSignal): Promise<Mobility | null> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Mobility sidecar request returned HTTP ${response.status}.`);
  if ((response.headers.get("content-type") ?? "").includes("text/html")) return null;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("The mobility sidecar is not valid JSON.");
  }
  return parseMobility(data);
}

/** Index of the hourly bin containing ms, or -1 outside the sidecar's range. */
export function hourIndexAt(m: Mobility, ms: number): number {
  const starts = m.hourStartsMs;
  if (ms < starts[0] || ms >= starts[starts.length - 1] + HOUR_MS) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  // A gap between bins (not expected) is outside any bin.
  return ms < starts[lo] + HOUR_MS ? lo : -1;
}

/** Start of the first bin and end of the last, in UTC epoch ms. */
export function mobilityRangeMs(m: Mobility): [number, number] {
  return [m.hourStartsMs[0], m.hourStartsMs[m.hourStartsMs.length - 1] + HOUR_MS];
}

/** Baseline value for hour index i (local hour-of-week repeats weekly). */
export function baselineAt(baseline: readonly number[], i: number): number {
  return baseline[i % HOURS_PER_WEEK];
}

/** Which event week (index into eventWeeks) hour index i falls in; -1 for i < 0. */
export function weekIndexAt(i: number): number {
  return i < 0 ? -1 : Math.floor(i / HOURS_PER_WEEK);
}

/**
 * Color-scale input: log2(visits / baseline), clamped. Null when neither exists (hide);
 * "fresh" when there are visits but no baseline.
 */
export function ratioLog2(visits: number, baseline: number): number | "fresh" | null {
  if (baseline <= 0) return visits > 0 ? "fresh" : null;
  if (visits <= 0) return RATIO_FLOOR_LOG2;
  return Math.max(RATIO_FLOOR_LOG2, Math.min(RATIO_CEIL_LOG2, Math.log2(visits / baseline)));
}

export interface DayTick {
  /** Hour index of local midnight. */
  index: number;
  label: string;
  /** Weekly (Monday) ticks carry a date label. */
  major: boolean;
}

/** Local-midnight ticks over the whole range, found from the clock (so DST shifts are honored). */
export function dayTicks(m: Mobility): DayTick[] {
  const out: DayTick[] = [];
  m.hourStartsMs.forEach((ms, index) => {
    const p = clockParts(ms, m.timezone);
    if (!p.time.startsWith("00:")) return;
    const day = new Date(`${p.date}T00:00:00Z`);
    const weekday = day.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    const monthDay = day.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    out.push({ index, label: `${weekday} ${monthDay}`, major: weekday === "Mon" });
  });
  return out;
}
