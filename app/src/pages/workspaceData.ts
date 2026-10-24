// Small static files the workspace pages read. Full replay bundles (up to 40 MB) are never
// loaded here: pages use /replays/index.json, the variants index and the stress summary only.
import { useEffect, useState } from "react";

export const INCIDENTS_URL = "/replays/index.json";
export const VARIANTS_URL = "/replays/camp-2018.variants/index.json";
export const STRESS_URL = "/simulations/camp-2018.stress.json";
export const CAMP_ID = "camp-2018";

export type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "missing" }
  | { status: "error"; message: string };

class ShapeError extends Error {}

/** Fetches a JSON file once. A 404, or the Vite dev server's HTML fallback, is "missing". */
export function useJson<T>(url: string, parse: (raw: unknown) => T): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        const html = (response.headers?.get("content-type") ?? "").includes("text/html");
        if (response.status === 404 || html) return setState({ status: "missing" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setState({ status: "ready", data: parse(await response.json()) });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message =
          error instanceof ShapeError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Request failed.";
        setState({ status: "error", message });
      });
    return () => controller.abort();
    // `parse` is a module-level function for every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return state;
}

// --- incidents index ---------------------------------------------------------------------

export type LayerStatus = Record<string, string>;

export interface Incident {
  id: string;
  name: string;
  place: string;
  date: string;
  timezone: string;
  layerStatus: LayerStatus;
  packageVersion: string | null;
  clock: { start: string; end: string; stepSeconds: number } | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseIncidents(raw: unknown): Incident[] {
  const list = isObj(raw) && Array.isArray(raw.incidents) ? raw.incidents : null;
  if (!list) throw new ShapeError("The incidents index has no incidents list.");
  const out: Incident[] = [];
  for (const entry of list) {
    if (!isObj(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    const layers: LayerStatus = {};
    if (isObj(entry.layer_status)) {
      for (const [key, value] of Object.entries(entry.layer_status)) {
        // Index entries are plain strings; bundle-style entries carry { status }.
        const status = str(value) ?? (isObj(value) ? str(value.status) : null);
        if (status) layers[key] = status;
      }
    }
    const clock = isObj(entry.clock) ? entry.clock : null;
    const start = clock ? str(clock.start) : null;
    const end = clock ? str(clock.end) : null;
    out.push({
      id,
      name: str(entry.name) ?? id,
      place: str(entry.place) ?? "Place not listed",
      date: str(entry.date) ?? "",
      timezone: str(entry.timezone) ?? "UTC",
      layerStatus: layers,
      packageVersion: str(entry.package_version),
      clock: start && end ? { start, end, stepSeconds: num(clock?.step_seconds) ?? 60 } : null,
    });
  }
  return out;
}

export const LAYER_LABELS: Record<string, string> = {
  roads: "Roads",
  zones: "Evacuation zones",
  destinations: "Exits & refuges",
  events: "Orders & closures",
  traffic: "Traffic (simulated)",
  fire_perimeters: "Fire perimeters",
  fire_simulated: "Fire front (simulated)",
  fire_observations: "Fire observations",
  damage: "Damage assessment",
};

/** Layers in a stable display order; unknown keys from newer indexes follow. */
export function orderedLayers(status: LayerStatus): [string, string][] {
  const known = Object.keys(LAYER_LABELS).filter((key) => key in status);
  const extra = Object.keys(status).filter((key) => !(key in LAYER_LABELS));
  return [...known, ...extra].map((key) => [key, status[key]]);
}

export function layerLabel(key: string): string {
  return LAYER_LABELS[key] ?? key.replace(/_/g, " ");
}

export function replayHref(id: string, extra = ""): string {
  return `/replay?incident=${encodeURIComponent(id)}${extra}`;
}

// --- metrics and variants ------------------------------------------------------------------

export interface MetricDelta {
  baseline: number | null;
  variant: number | null;
  delta: number | null;
  pct: number | null;
}

export type Metrics = Record<string, MetricDelta>;

function parseMetric(raw: unknown): MetricDelta {
  const o = isObj(raw) ? raw : {};
  return {
    baseline: num(o.baseline),
    variant: num(o.variant),
    delta: num(o.delta),
    pct: num(o.pct),
  };
}

function parseMetrics(raw: unknown): Metrics {
  const out: Metrics = {};
  if (isObj(raw)) for (const [key, value] of Object.entries(raw)) out[key] = parseMetric(value);
  return out;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export interface Variant {
  id: string;
  title: string;
  question: string;
  evidenceClass: string;
  changes: string[];
  headline: Metrics;
  zoneRiskChanged: number | null;
  fireChanged: boolean;
}

export interface VariantsIndex {
  baseline: string;
  basis: Obj;
  baselineMetrics: Record<string, number | null>;
  variants: Variant[];
  skipped: { id: string; title: string; reason: string }[];
  limitations: string[];
}

export function parseVariants(raw: unknown): VariantsIndex {
  if (!isObj(raw) || !Array.isArray(raw.variants)) {
    throw new ShapeError("The what-if index has no variants list.");
  }
  const variants: Variant[] = [];
  for (const entry of raw.variants) {
    if (!isObj(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    variants.push({
      id,
      title: str(entry.title) ?? id,
      question: str(entry.question) ?? "",
      evidenceClass: str(entry.evidence_class) ?? "simulated",
      changes: strings(entry.changes),
      headline: parseMetrics(entry.headline),
      zoneRiskChanged: num(entry.zone_risk_changed),
      fireChanged: entry.fire_changed === true,
    });
  }
  const baselineMetrics: Record<string, number | null> = {};
  if (isObj(raw.baseline_metrics)) {
    for (const [key, value] of Object.entries(raw.baseline_metrics))
      baselineMetrics[key] = num(value);
  }
  const skipped = Array.isArray(raw.skipped)
    ? raw.skipped.filter(isObj).map((s) => ({
        id: str(s.id) ?? "",
        title: str(s.title) ?? str(s.id) ?? "Unnamed variant",
        reason: str(s.reason) ?? "No reason recorded.",
      }))
    : [];
  return {
    baseline: str(raw.baseline) ?? "",
    basis: isObj(raw.basis) ? raw.basis : {},
    baselineMetrics,
    variants,
    skipped,
    limitations: strings(raw.limitations),
  };
}

// --- stress runs -----------------------------------------------------------------------------

export interface StressRun {
  runId: string;
  label: string;
  rationale: string | null;
  evidenceClass: string;
  changes: string[];
  runtimeS: number | null;
  metrics: Metrics;
  zoneRiskChangedCount: number | null;
  exitShifts: {
    name: string;
    baseline: number | null;
    variant: number | null;
    delta: number | null;
  }[];
}

export interface StressDoc {
  mode: string;
  runs: StressRun[];
  budget: { maxRuns: number | null; runsUsed: number | null; stopped: string | null };
  baselineMetrics: Record<string, number | null>;
  basis: Obj;
  findings: { markdown: string; model: string | null } | null;
  rejected: string[];
  limitations: string[];
}

export function parseStress(raw: unknown): StressDoc {
  if (!isObj(raw) || !Array.isArray(raw.runs))
    throw new ShapeError("The stress file has no runs list.");
  const runs: StressRun[] = [];
  for (const entry of raw.runs) {
    if (!isObj(entry)) continue;
    const spec = isObj(entry.spec) ? entry.spec : {};
    const result = isObj(entry.result) ? entry.result : {};
    runs.push({
      runId: str(entry.run_id) ?? `run-${runs.length + 1}`,
      label: str(spec.label) ?? str(entry.run_id) ?? "Unnamed run",
      rationale: str(spec.rationale),
      evidenceClass: str(entry.evidence_class) ?? "simulated",
      changes: strings(entry.changes),
      runtimeS: num(entry.runtime_s),
      metrics: parseMetrics(result.metrics),
      zoneRiskChangedCount: num(result.zone_risk_changed_count),
      exitShifts: Array.isArray(result.exit_shifts)
        ? result.exit_shifts.filter(isObj).map((s) => ({
            name: str(s.name) ?? str(s.destination_id) ?? "Unnamed exit",
            baseline: num(s.baseline),
            variant: num(s.variant),
            delta: num(s.delta),
          }))
        : [],
    });
  }
  const budget = isObj(raw.budget) ? raw.budget : {};
  const baseline = isObj(raw.baseline) && isObj(raw.baseline.metrics) ? raw.baseline.metrics : {};
  const baselineMetrics: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(baseline)) baselineMetrics[key] = num(value);
  const findings =
    isObj(raw.findings) && str(raw.findings.markdown)
      ? { markdown: str(raw.findings.markdown) as string, model: str(raw.findings.model) }
      : null;
  return {
    mode: str(raw.mode) ?? "unknown",
    runs,
    budget: {
      maxRuns: num(budget.max_runs),
      runsUsed: num(budget.runs_used),
      stopped: str(budget.stopped),
    },
    baselineMetrics,
    basis: isObj(raw.basis) ? raw.basis : {},
    findings,
    rejected: Array.isArray(raw.rejected)
      ? raw.rejected.map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
      : [],
    limitations: strings(raw.limitations),
  };
}

// --- formatting ------------------------------------------------------------------------------

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmt(value: number | null): string {
  return value === null ? "n/a" : integer.format(value);
}

/** "+1,234" / "−1,234" / "no change"; the sign is always text, never colour alone. */
export function fmtDelta(delta: number | null): string {
  if (delta === null) return "n/a";
  if (delta === 0) return "no change";
  return `${delta > 0 ? "+" : "−"}${integer.format(Math.abs(delta))}`;
}

export type Direction = "higher-better" | "lower-better";

/** Outcome words follow the documented metric semantics (docs/replay-bundle.md, Variants). */
export function verdict(delta: number | null, direction: Direction): string {
  if (delta === null) return "";
  if (delta === 0) return "unchanged";
  return delta > 0 === (direction === "higher-better") ? "better" : "worse";
}

export interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  direction: Direction;
}

export const ARRIVED_BY_1800: MetricSpec = {
  key: "arrived_by_1800z_veh",
  label: "Vehicles out by",
  unit: "vehicles",
  direction: "higher-better",
};

export const OUTCOME_METRICS: MetricSpec[] = [
  ARRIVED_BY_1800,
  {
    key: "total_exposed_veh_min",
    label: "Total exposure",
    unit: "vehicle-min",
    direction: "lower-better",
  },
  {
    key: "peak_exposed_veh",
    label: "Peak exposed on roads",
    unit: "vehicles",
    direction: "lower-better",
  },
  { key: "peak_blocked_veh", label: "Peak blocked", unit: "vehicles", direction: "lower-better" },
];

/** "10:00 PST" for a metric key such as arrived_by_1800z_veh, in the incident's time zone. */
export function clockLabel(metricKey: string, date: string, timezone: string): string | null {
  const m = /(\d{2})(\d{2})z/.exec(metricKey);
  if (!m || !date) return null;
  const at = new Date(`${date}T${m[1]}:${m[2]}:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
      timeZoneName: "short",
    }).format(at);
  } catch {
    return null;
  }
}

export function formatDate(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  if (!date || Number.isNaN(at.getTime())) return date || "Date not listed";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(at);
}
