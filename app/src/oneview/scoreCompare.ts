/**
 * Baseline vs AI comparison at the same board minute (pure). Values come from the board's score
 * timeline (demo/runContracts.ts ScorePoint, computed by demo/scorePoint.ts); nothing is estimated here.
 */

import type { RunTimeline, ScorePoint } from "../demo/runContracts";

export type ScoreKey = "homesBurned" | "caughtPeople" | "injured" | "peopleSafe" | "worstVolumeToCapacity";

export interface ScoreMetric {
  key: ScoreKey;
  label: string;
  /** Which direction is the better outcome. */
  better: "lower" | "higher";
  format: (v: number) => string;
  /** Plain unit word for differences ("homes", "people", "v/c"). */
  unit: string;
}

const whole = (v: number) => Math.round(v).toLocaleString();

export const SCORE_METRICS: ScoreMetric[] = [
  { key: "homesBurned", label: "Homes burned", better: "lower", format: whole, unit: "homes" },
  { key: "caughtPeople", label: "People caught by fire", better: "lower", format: whole, unit: "people" },
  { key: "injured", label: "People injured", better: "lower", format: whole, unit: "people" },
  { key: "peopleSafe", label: "People safe", better: "higher", format: whole, unit: "people" },
  {
    key: "worstVolumeToCapacity",
    label: "Worst road traffic",
    better: "lower",
    format: (v) => `${v.toFixed(2)} v/c`,
    unit: "v/c",
  },
];

/** The last sample at or before `minute`, or null (no run yet, or the run has not reached it). */
export function pointAt(timeline: RunTimeline | null, minute: number): ScorePoint | null {
  if (!timeline) return null;
  let hit: ScorePoint | null = null;
  for (const p of timeline.points) {
    if (p.minute <= minute) hit = p;
    else break;
  }
  return hit;
}

export type Verdict = "better" | "worse" | "same";

/** AI vs baseline for one measure: the verdict and a plain-language difference ("42 fewer homes"). */
export function compare(metric: ScoreMetric, baseline: number, ai: number): { verdict: Verdict; text: string } {
  const diff = ai - baseline;
  const isRatio = metric.key === "worstVolumeToCapacity";
  const size = isRatio ? Math.abs(diff).toFixed(2) : Math.round(Math.abs(diff)).toLocaleString();
  if (size === "0" || size === "0.00") return { verdict: "same", text: "Same" };
  const lower = diff < 0;
  const verdict: Verdict = lower === (metric.better === "lower") ? "better" : "worse";
  const word = isRatio ? (lower ? "lower" : "higher") : lower ? "fewer" : "more";
  return { verdict, text: isRatio ? `${size} ${word}` : `${size} ${word} ${metric.unit}` };
}
