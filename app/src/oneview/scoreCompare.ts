/**
 * Baseline vs AI comparison at the same board minute (pure). Values come from the board's score
 * timeline (demo/runContracts.ts ScorePoint, computed by demo/scorePoint.ts); nothing is estimated here.
 */

import type { RunTimeline, ScorePoint } from "../demo/runContracts";

export type ScoreKey = "homesBurned" | "caughtPeople" | "injured" | "peopleSafe" | "areaBurnedHa" | "worstVolumeToCapacity";

export interface ScoreMetric {
  key: ScoreKey;
  label: string;
  /** Which direction is the better outcome. */
  better: "lower" | "higher";
  format: (v: number) => string;
  /** Plain unit word for differences ("homes", "people", "acres", "v/c"). */
  unit: string;
  /** Factor from the stored value to the unit of `unit` (hectares to acres); 1 when omitted. */
  diffScale?: number;
}

const whole = (v: number) => Math.round(v).toLocaleString();

/** Acres per hectare (1 acre = 4046.8564224 m² by definition; 1 ha = 10 000 m²). */
export const ACRES_PER_HECTARE = 2.47105;

/** "1,234 ac (499 ha)": acres first, hectares secondary. */
function acresAndHectares(ha: number): string {
  return `${Math.round(ha * ACRES_PER_HECTARE).toLocaleString()} ac (${Math.round(ha).toLocaleString()} ha)`;
}

export const SCORE_METRICS: ScoreMetric[] = [
  { key: "homesBurned", label: "Homes burned", better: "lower", format: whole, unit: "homes" },
  { key: "caughtPeople", label: "People caught by fire", better: "lower", format: whole, unit: "people" },
  { key: "injured", label: "People injured", better: "lower", format: whole, unit: "people" },
  { key: "peopleSafe", label: "People safe", better: "higher", format: whole, unit: "people" },
  { key: "areaBurnedHa", label: "Area burned", better: "lower", format: acresAndHectares, unit: "acres", diffScale: ACRES_PER_HECTARE },
  {
    key: "worstVolumeToCapacity",
    label: "Worst road traffic",
    better: "lower",
    format: (v) => `${v.toFixed(2)} v/c`,
    unit: "v/c",
  },
];

/** The last sample at or before `minute`, or null (no run yet, or the run has not reached it). Points are in minute order. */
export function pointAt(timeline: RunTimeline | null, minute: number): ScorePoint | null {
  const points = timeline?.points;
  if (!points || points.length === 0 || points[0].minute > minute) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].minute <= minute) lo = mid;
    else hi = mid - 1;
  }
  return points[lo];
}

export type Verdict = "better" | "worse" | "same";

/** AI vs baseline for one measure: the verdict and a plain-language difference ("42 fewer homes", "120 fewer acres"). */
export function compare(metric: ScoreMetric, baseline: number, ai: number): { verdict: Verdict; text: string } {
  const diff = (ai - baseline) * (metric.diffScale ?? 1);
  const isRatio = metric.key === "worstVolumeToCapacity";
  const size = isRatio ? Math.abs(diff).toFixed(2) : Math.round(Math.abs(diff)).toLocaleString();
  if (size === "0" || size === "0.00") return { verdict: "same", text: "Same" };
  const lower = diff < 0;
  const verdict: Verdict = lower === (metric.better === "lower") ? "better" : "worse";
  const word = isRatio ? (lower ? "lower" : "higher") : lower ? "fewer" : "more";
  return { verdict, text: isRatio ? `${size} ${word}` : `${size} ${word} ${metric.unit}` };
}
