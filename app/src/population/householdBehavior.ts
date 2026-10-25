/**
 * Per-household evacuation behaviour for Simulation Studio and the Dispatch agent: not everyone
 * obeys an order, those who do leave after their own delay, some wait until they see the fire,
 * and people still at home leave when the fire comes close. Drawn once per synthetic home,
 * seeded by the road area and the home's index, so a run is reproducible and the same household
 * behaves the same across closures, order minutes and plans.
 *
 * Values come from the `grounded` profile of sim/behavior_params.json (docs/people-data.md
 * "Behaviour evidence"), through the generated population/behaviorParams.generated.ts:
 * - order compliance 0.875: Wong et al. 2020 Table 11 p. 39, Oct 2017 N. California (sourced);
 *   the rest stay home by choice and never leave (they are reported apart: "staying by choice");
 * - wait and see 0.13 of compliers: they ignore the order and leave only on the fire cue
 *   (derived: McLennan et al. 2019 preprint pp. 16-19, (0.17 x 2/3) / 0.875);
 * - shadow evacuation 0.291: with no order for their zone, this share of households still
 *   leaves on the fire cue (Wong et al. 2020 Table 11 p. 39, Oct 2017 non-recipients);
 * - delay from a trigger (the order, or the fire cue) to leaving home: lognormal, median 42.8
 *   min, sigma 1.246, capped at 1,440 min (derived: Camp mean, Grajdura 2022 pp. 51-52; Marshall
 *   spread, Forrister 2024 Table 4 p. 8). The same distribution is drawn again, independently,
 *   for the fire cue: Grajdura 2022 Table 3 p. 46 finds no significant difference in delay for
 *   households that first learned of the fire by seeing it (+4.9 min, n.s.).
 *
 * Fire cues (dispatch/engine.ts applies them; the fire is the modelled fire, every source,
 * reported or not, because residents see the real fire):
 * - neighbourhood cue: the fire reaches the household's zone (`FireExposure.zoneContact`). A
 *   household that means to leave (complier or wait-and-see; in a zone with no order only
 *   shadow and wait-and-see households) leaves its cue delay after it, or earlier if its order
 *   delay comes first. Witnessing flames or embers raised risk perception in Gatlinburg 2016,
 *   smoke did not (NIST TN 2103, Walpole et al. 2020); the zone as the cue's reach is an
 *   ASSUMPTION (zones are ~1.5 km grid cells).
 * - near cue: the fire comes within FIRE_CUE_NEAR_METERS of the house
 *   (`FireExposure.homeNear`): every household that is not staying by choice leaves then
 *   (NEAR_CUE_EXTRA_MINUTES), order or not. McLennan et al. 2019 (pp. 17-18) report residents
 *   leaving as the fire arrived (Black Saturday: 25% of leavers left after the fire arrived).
 * - asleep: a household whose first trigger falls in sleeping hours (23:00-06:00 Pacific, the
 *   same NIST TN 2174 hours as response/report.ts) first takes WAKE_UP_MINUTES to wake: the TN
 *   2174 Table 2 night offset (+18.5 min) for residential fires, transferred here from reporting
 *   a fire to responding to an order or a cue (derived).
 */

import type { DispatchArea } from "../dispatch/area";
import { NIGHT_FROM_HOUR, NIGHT_OFFSET_AT_HOMES_MIN, NIGHT_TO_HOUR, pacificHour } from "../response/report";
import { deriveStream, standardNormal, uniform } from "../response/rng";
import { BEHAVIOR_PARAMS } from "./behaviorParams.generated";

export type HouseholdBehaviorMode = "grounded" | "everyone";

export const HOUSEHOLD_BEHAVIOR_OPTIONS: readonly { value: HouseholdBehaviorMode; label: string }[] = [
  { value: "grounded", label: "Like real evacuations" },
  { value: "everyone", label: "Everyone leaves within 45 min" },
];

const {
  order_compliance: COMPLIANCE,
  departure_delay: DELAY,
  wait_and_see_given_compliance: WAIT,
  shadow_evacuation: SHADOW,
} = BEHAVIOR_PARAMS.params;
/** Share of ordered households that leave (Wong et al. 2020 Table 11). */
export const ORDER_COMPLIANCE = COMPLIANCE.p ?? 1;
/** Share of compliers that wait for the fire cue instead of leaving on the order (McLennan 2019, derived). */
export const WAIT_AND_SEE_SHARE = WAIT.p ?? 0;
/**
 * Share of households that leave on the fire cue with no order for their zone (Wong et al. 2020
 * Table 11). ASSUMPTION: the shadow evacuees are the most willing compliers (nested draw: the
 * same uniform as compliance, below this share), so the share of all households is exactly it.
 */
export const SHADOW_SHARE = SHADOW.p ?? 0;
/** Lognormal delay from a trigger (order or fire cue) to leaving home, minutes. */
export const DELAY_MEDIAN_MINUTES = DELAY.median_min ?? 0;
export const DELAY_SIGMA = DELAY.sigma ?? 0;
export const DELAY_MAX_MINUTES = DELAY.max_min ?? Infinity;
/**
 * Minutes from the near cue (fire within FIRE_CUE_NEAR_METERS of the house) to leaving.
 * ASSUMPTION: 0, the household leaves at once (11.7% of Fort McMurray evacuees reported no
 * preparation at all, McGee 2018 p. 1157); an optimistic bound, not a measured value.
 */
export const NEAR_CUE_EXTRA_MINUTES = 0;
/** NIST TN 2174 Table 2 night offset (via response/report.ts): time to wake and respond, minutes. */
export const WAKE_UP_MINUTES = NIGHT_OFFSET_AT_HOMES_MIN;
/** Fixed seed of the household draws; the area id and home index make each stream distinct. */
export const HOUSEHOLD_SEED = 20181108;

/** True during NIST TN 2174's sleeping hours (response/report.ts), Pacific local time. */
export function sleepingAt(epochMs: number): boolean {
  const h = pacificHour(epochMs);
  return h >= NIGHT_FROM_HOUR || h < NIGHT_TO_HOUR;
}

/** One drawn behaviour per home of an area (index = home). */
export interface HouseholdBehavior {
  /**
   * Minutes from the zone's order to leaving home; Infinity for households that stay by choice
   * and for wait-and-see households (they leave only on a fire cue).
   */
  orderDelayMinutes: Float32Array;
  /** Minutes from the neighbourhood fire cue to leaving home; Infinity for households that stay. */
  cueDelayMinutes: Float32Array;
  /** 1: responds to the neighbourhood cue even with no order for its zone (shadow or wait-and-see). */
  leavesWithoutOrder: Uint8Array;
  /** 1: stays home by choice whatever happens (never leaves). */
  staysByChoice: Uint8Array;
}

const cache = new WeakMap<DispatchArea, HouseholdBehavior>();

function delayDraw(rng: ReturnType<typeof deriveStream>): number {
  return Math.min(DELAY_MAX_MINUTES, DELAY_MEDIAN_MINUTES * Math.exp(DELAY_SIGMA * standardNormal(rng)));
}

/** The grounded behaviour of every home of an area, cached per area object. */
export function householdBehavior(area: DispatchArea): HouseholdBehavior {
  const cached = cache.get(area);
  if (cached) return cached;
  const n = area.homes.length;
  const behavior: HouseholdBehavior = {
    orderDelayMinutes: new Float32Array(n).fill(Infinity),
    cueDelayMinutes: new Float32Array(n).fill(Infinity),
    leavesWithoutOrder: new Uint8Array(n),
    staysByChoice: new Uint8Array(n),
  };
  for (let home = 0; home < n; home += 1) {
    // Draw order kept from the order-delay-only model: compliance, then the order delay, so a
    // complier that does not wait and see keeps its earlier delay.
    const rng = deriveStream(HOUSEHOLD_SEED, `${area.id}#${home}`);
    const u = uniform(rng);
    if (u >= ORDER_COMPLIANCE) {
      behavior.staysByChoice[home] = 1;
      continue;
    }
    const orderDelay = delayDraw(rng);
    const waits = uniform(rng) < WAIT_AND_SEE_SHARE;
    behavior.orderDelayMinutes[home] = waits ? Infinity : orderDelay;
    behavior.cueDelayMinutes[home] = delayDraw(rng);
    behavior.leavesWithoutOrder[home] = waits || u < SHADOW_SHARE ? 1 : 0;
  }
  cache.set(area, behavior);
  return behavior;
}

/** Plain-language summary of the behaviour a mode applies. */
export function householdBehaviorText(mode: HouseholdBehaviorMode): string {
  return mode === "grounded"
    ? `${Math.round(ORDER_COMPLIANCE * 1000) / 10}% leave when ordered, each after its own delay (median ${Math.round(DELAY_MEDIAN_MINUTES)} min, +${Math.round(WAKE_UP_MINUTES)} min to wake at night); ${Math.round(WAIT_AND_SEE_SHARE * 100)}% of them wait until the fire reaches their area, and ${Math.round(SHADOW_SHARE * 100)}% leave on the fire with no order. Anyone not staying by choice leaves when the fire comes close. The rest (${Math.round((1 - ORDER_COMPLIANCE) * 1000) / 10}%) stay by choice. From fire surveys.`
    : "Every household leaves, spread evenly over 45 min; no one leaves before an order.";
}

/** `basis.people_behavior` label of the people picture. */
export function behaviorLabel(grounded: boolean): string {
  return grounded ? "grounded (not everyone obeys; fire cues)" : "everyone leaves";
}
