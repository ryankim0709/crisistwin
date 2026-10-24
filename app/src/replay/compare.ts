// What-if variants (docs/replay-bundle.md, "Variants"): loading, validation and merging onto
// the baseline. Variants are simulated counterfactuals; evidence layers stay the baseline's.
import type { ReplayModel } from "./types";
import {
  BundleError,
  arr,
  ascending,
  evidence,
  insights,
  isObj,
  obj,
  objOrEmpty,
  optNum,
  replayEvent,
  simulatedFire,
  str,
  strList,
  traffic,
} from "./validate";

export interface MetricDelta {
  baseline: number | null;
  variant: number | null;
  delta: number | null;
}

export interface VariantSummary {
  id: string;
  title: string;
  question: string;
  file: string;
  changes: string[];
  zoneRiskChanged: number | null;
  fireChanged: boolean;
}

export interface VariantIndex {
  variants: VariantSummary[];
  skipped: { id: string; title: string; reason: string }[];
  limitations: string[];
}

export interface Variant {
  id: string;
  title: string;
  question: string;
  changes: string[];
  metrics: Record<string, MetricDelta>;
  zoneRiskChanged: { zoneId: string; baseline: string; variant: string }[];
  limitations: string[];
  /** The scenario as a full model: baseline evidence layers plus variant traffic/events. */
  model: ReplayModel;
}

/** Display metadata for comparison metrics; `better` says which direction is an improvement. */
export const METRIC_INFO: Record<string, { label: string; unit: "veh" | "veh·min" | "s"; better: "higher" | "lower" }> = {
  arrived_by_1700z_veh: { label: "Arrived by 09:00 PST", unit: "veh", better: "higher" },
  arrived_by_1800z_veh: { label: "Arrived by 10:00 PST", unit: "veh", better: "higher" },
  arrived_by_2000z_veh: { label: "Arrived by 12:00 PST", unit: "veh", better: "higher" },
  arrived_at_end_veh: { label: "Arrived by end of run", unit: "veh", better: "higher" },
  peak_en_route_veh: { label: "Peak on the road", unit: "veh", better: "lower" },
  peak_blocked_veh: { label: "Peak blocked", unit: "veh", better: "lower" },
  peak_exposed_veh: { label: "Peak exposed to fire", unit: "veh", better: "lower" },
  exposed_veh_min: { label: "Exposure (vehicle-minutes)", unit: "veh·min", better: "lower" },
  blocked_at_end_veh: { label: "Blocked at end", unit: "veh", better: "lower" },
  clearance_time_s: { label: "Clearance time", unit: "s", better: "lower" },
};

function metricDelta(value: unknown): MetricDelta {
  const m = objOrEmpty(value);
  return {
    baseline: optNum(m.baseline, "metric.baseline"),
    variant: optNum(m.variant, "metric.variant"),
    delta: optNum(m.delta, "metric.delta"),
  };
}

export function parseVariantIndex(data: unknown): VariantIndex {
  const index = obj(data, "index");
  if (index.kind !== "crisistwin_variant_index") throw new BundleError("kind", "expected crisistwin_variant_index");
  return {
    variants: arr(index.variants, "variants").map((v, i) => {
      const item = obj(v, `variants[${i}]`);
      return {
        id: str(item.id, `variants[${i}].id`),
        title: str(item.title, `variants[${i}].title`),
        question: str(item.question, `variants[${i}].question`),
        file: str(item.file, `variants[${i}].file`),
        changes: strList(item.changes, `variants[${i}].changes`),
        zoneRiskChanged: optNum(item.zone_risk_changed, `variants[${i}].zone_risk_changed`),
        fireChanged: item.fire_changed === true,
      };
    }),
    skipped: arr(index.skipped ?? [], "skipped").map((v, i) => {
      const item = obj(v, `skipped[${i}]`);
      return {
        id: str(item.id, `skipped[${i}].id`),
        title: str(item.title, `skipped[${i}].title`),
        reason: str(item.reason, `skipped[${i}].reason`),
      };
    }),
    limitations: strList(index.limitations, "limitations"),
  };
}

/** Validate a variant file and merge it onto the baseline model. */
export function parseVariant(data: unknown, baseline: ReplayModel): Variant {
  const v = obj(data, "variant file");
  if (v.kind !== "crisistwin_variant") throw new BundleError("kind", "expected crisistwin_variant");
  const meta = obj(v.variant, "variant");
  evidence(meta.evidence_class, "variant.evidence_class");
  const trafficBlock = traffic(obj(v.traffic, "traffic"));
  if (baseline.traffic && trafficBlock.edgeIds.length !== baseline.traffic.edgeIds.length) {
    throw new BundleError("traffic.edge_ids", "must match the baseline edge order");
  }
  const events = ascending(
    arr(v.events ?? [], "events").map((e, i) => replayEvent(e, `events[${i}]`)),
    "events",
  );
  const comparison = objOrEmpty(v.comparison);
  const metrics: Record<string, MetricDelta> = {};
  for (const [key, value] of Object.entries(objOrEmpty(comparison.metrics))) metrics[key] = metricDelta(value);
  const fire = isObj(v.fire_simulated) ? simulatedFire(v.fire_simulated) : baseline.fireSimulated;
  return {
    id: str(meta.id, "variant.id"),
    title: str(meta.title, "variant.title"),
    question: str(meta.question, "variant.question"),
    changes: strList(meta.changes, "variant.changes"),
    metrics,
    zoneRiskChanged: arr(comparison.zone_risk_changed ?? [], "comparison.zone_risk_changed").map((z, i) => {
      const item = obj(z, `comparison.zone_risk_changed[${i}]`);
      return {
        zoneId: str(item.zone_id, `comparison.zone_risk_changed[${i}].zone_id`),
        baseline: str(item.baseline, `comparison.zone_risk_changed[${i}].baseline`),
        variant: str(item.variant, `comparison.zone_risk_changed[${i}].variant`),
      };
    }),
    limitations: strList(v.limitations, "limitations"),
    model: {
      ...baseline,
      traffic: trafficBlock,
      events,
      insights: isObj(v.insights) ? insights(v.insights) : baseline.insights,
      fireSimulated: fire,
    },
  };
}

/** Format a delta with sign and unit in text, e.g. "+6,836 veh" or "−8,757 veh·min". */
export function formatDelta(delta: number | null, unit: string): string {
  if (delta === null) return "n/a";
  if (unit === "s") {
    const minutes = Math.round(delta / 60);
    return `${minutes > 0 ? "+" : minutes < 0 ? "−" : "±"}${Math.abs(minutes).toLocaleString("en-US")} min`;
  }
  const rounded = Math.round(delta);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded).toLocaleString("en-US")} ${unit}`;
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "s") return `${Math.round(value / 60).toLocaleString("en-US")} min`;
  return Math.round(value).toLocaleString("en-US");
}

/** "better" / "worse" / "same" in words, so the table never relies on colour. */
export function deltaVerdict(delta: number | null, better: "higher" | "lower"): "better" | "worse" | "same" | "n/a" {
  if (delta === null) return "n/a";
  if (Math.round(delta) === 0) return "same";
  return (delta > 0) === (better === "higher") ? "better" : "worse";
}

export async function fetchJson(url: string, signal: AbortSignal): Promise<unknown | null> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  // The Vite dev server answers unknown paths with index.html.
  if ((response.headers.get("content-type") ?? "").includes("text/html")) return null;
  return response.json();
}
