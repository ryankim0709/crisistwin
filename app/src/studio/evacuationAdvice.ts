/**
 * Plain-language summary of an optimised evacuation plan against the fastest-exit policy.
 * Pure: every number is a difference of two engine summaries (studio/evacuation.ts); nothing
 * here estimates anything.
 */

import type { EvacuationSummary } from "./evacuation";
import type { ZonePlanChange } from "./evacuationOptimizer";

export interface AdviceInput {
  baseline: EvacuationSummary;
  best: EvacuationSummary;
  changes: readonly ZonePlanChange[];
  improved: boolean;
  /** Roads the planner closed; 0 means all roads are open. */
  closureCount: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One sentence naming what the plan changes and what the engine says it buys. */
export function describeImprovement(input: AdviceInput): string {
  const { baseline, best, changes, improved, closureCount } = input;
  const context = closureCount > 0 ? "your closures" : "all roads open";
  if (!improved) {
    return `No strategy tried beat the fastest open exit under ${
      closureCount > 0 ? "these closures" : "these conditions"
    }.`;
  }
  const rerouted = changes.filter(
    (change) => change.exitId !== null && change.exitId !== change.fastestExitId,
  ).length;
  const staged = changes.filter((change) => change.afterZoneId !== null).length;
  const moves: string[] = [];
  if (rerouted > 0) moves.push(`sending ${plural(rerouted, "zone", "zones")} to other exits`);
  if (staged > 0) moves.push(`staging ${plural(staged, "zone", "zones")} in waves`);
  const what = moves.length > 0 ? moves.join(" and ") : "changing the plan";

  const outcomes: string[] = [];
  const caught = best.final.caught - baseline.final.caught;
  if (caught !== 0) {
    outcomes.push(
      `${Math.abs(caught)} ${caught < 0 ? "fewer" : "more"} ${Math.abs(caught) === 1 ? "household" : "households"} caught`,
    );
  }
  const safe = best.final.safe - baseline.final.safe;
  if (safe !== 0) {
    outcomes.push(
      `${Math.abs(safe)} ${safe > 0 ? "more" : "fewer"} ${Math.abs(safe) === 1 ? "household" : "households"} reaching an exit`,
    );
  }
  const hours = Number(
    (best.householdHoursEvacuating - baseline.householdHoursEvacuating).toFixed(1),
  );
  if (hours !== 0) {
    outcomes.push(`${Math.abs(hours).toFixed(1)} ${hours < 0 ? "fewer" : "more"} household-hours`);
  }
  if (baseline.allClearMinute !== null && best.allClearMinute !== null) {
    const gap = Math.round(best.allClearMinute - baseline.allClearMinute);
    if (gap !== 0) outcomes.push(`all clear ${Math.abs(gap)} min ${gap < 0 ? "earlier" : "later"}`);
  } else if (baseline.allClearMinute === null && best.allClearMinute !== null) {
    outcomes.push("everyone ordered is out by the horizon");
  }
  const tail = outcomes.length > 0 ? `: ${outcomes.join(", ")}` : "";
  return `With ${context}, ${what}${tail}.`;
}
