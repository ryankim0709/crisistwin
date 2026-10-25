/**
 * Per-household evacuation behaviour for Simulation Studio: not everyone obeys an order, and
 * those who do leave after their own delay. Drawn once per synthetic home, seeded by the road
 * area and the home's index, so a run is reproducible and the same household behaves the same
 * across closures, order minutes and plans.
 *
 * Values come from the `grounded` profile of sim/behavior_params.json (docs/people-data.md
 * "Behaviour evidence"), through the generated population/behaviorParams.generated.ts:
 * - order compliance 0.875: Wong et al. 2020 Table 11 p. 39, Oct 2017 N. California (sourced);
 *   the rest stay home;
 * - delay from the order to leaving home: lognormal, median 42.8 min, sigma 1.246, capped at
 *   1,440 min (derived: Camp mean, Grajdura 2022 pp. 51-52; Marshall spread, Forrister 2024
 *   Table 4 p. 8).
 *
 * Not drawn here (follow-ups): shadow evacuation (0.291: households leaving without an order;
 * the Studio orders every reachable zone at once, so it matters only before a late order) and
 * wait-and-see (0.13 of compliers leave only when they see fire). The dispatch engine applies
 * the delays (`DispatchEngine.setDepartureDelays`).
 */

import type { DispatchArea } from "../dispatch/area";
import { deriveStream, standardNormal, uniform } from "../response/rng";
import { BEHAVIOR_PARAMS } from "./behaviorParams.generated";

export type HouseholdBehaviorMode = "grounded" | "everyone";

export const HOUSEHOLD_BEHAVIOR_OPTIONS: readonly { value: HouseholdBehaviorMode; label: string }[] = [
  { value: "grounded", label: "Like real evacuations" },
  { value: "everyone", label: "Everyone leaves within 45 min" },
];

const { order_compliance: COMPLIANCE, departure_delay: DELAY } = BEHAVIOR_PARAMS.params;
/** Share of ordered households that leave. */
export const ORDER_COMPLIANCE = COMPLIANCE.p ?? 1;
/** Lognormal delay from the order to leaving home, minutes. */
export const DELAY_MEDIAN_MINUTES = DELAY.median_min ?? 0;
export const DELAY_SIGMA = DELAY.sigma ?? 0;
export const DELAY_MAX_MINUTES = DELAY.max_min ?? Infinity;
/** Fixed seed of the household draws; the area id and home index make each stream distinct. */
export const HOUSEHOLD_SEED = 20181108;

const cache = new WeakMap<DispatchArea, Float32Array>();

/**
 * Minutes from the zone's order to each home leaving (index = home); Infinity for a household
 * that stays. Cached per area object.
 */
export function householdDepartureDelays(area: DispatchArea): Float32Array {
  const cached = cache.get(area);
  if (cached) return cached;
  const delays = new Float32Array(area.homes.length);
  for (let home = 0; home < delays.length; home += 1) {
    const rng = deriveStream(HOUSEHOLD_SEED, `${area.id}#${home}`);
    if (uniform(rng) >= ORDER_COMPLIANCE) {
      delays[home] = Infinity;
      continue;
    }
    const minutes = DELAY_MEDIAN_MINUTES * Math.exp(DELAY_SIGMA * standardNormal(rng));
    delays[home] = Math.min(DELAY_MAX_MINUTES, minutes);
  }
  cache.set(area, delays);
  return delays;
}

/** Plain-language summary of the behaviour a mode applies. */
export function householdBehaviorText(mode: HouseholdBehaviorMode): string {
  return mode === "grounded"
    ? `${Math.round(ORDER_COMPLIANCE * 1000) / 10}% leave when ordered, each after its own delay (median ${Math.round(DELAY_MEDIAN_MINUTES)} min); the rest stay. From fire surveys.`
    : "Every household leaves, spread evenly over 45 min.";
}

/** `basis.people_behavior` label of the people picture. */
export function behaviorLabel(grounded: boolean): string {
  return grounded ? "grounded (not everyone obeys)" : "everyone leaves";
}
