/**
 * Resource orders beyond the board's own stations: which tier fills an order, whether it is
 * filled (seeded; other fires draw the pools down), and when the resources reach the board.
 * Pure. See docs/response-model.md, "Escalation and resource ordering".
 *
 * Ordering chain (Cal OES Operations Bulletin #1, April 2022, pp.1-3): the operational area
 * orders immediate-need resources from one adjacent operational area (here: the mutual-aid
 * pool of real stations off the board), once per incident and within the bulletin's caps; an
 * order the area cannot fill, and every later order, goes to the region and then the state
 * ("state" tier here). All times below are ASSUMPTIONS unless marked: no published lead times
 * for California strike teams were retrieved.
 */

import { dataValue } from "../studio/apparatus";
import { chance, lognormalFactor, type RngStream } from "./rng";

/** ASSUMPTION: a mutual-aid strike team assembles at a rendezvous before it rolls, minutes. */
export const MUTUAL_AID_ASSEMBLY_MINUTES = 30;
/** ASSUMPTION: an order placed through the region or the state takes this long to process and fill, minutes. */
export const STATE_ORDER_PROCESSING_MINUTES = 60;
/** ASSUMPTION: assembly of an out-of-region strike team after the order is filled, minutes. */
export const STATE_ASSEMBLY_MINUTES = 60;
/** ASSUMPTION: road distance from an out-of-region resource's home to the board edge, km. */
export const OUT_OF_REGION_DISTANCE_KM = 200;
/** Heavy-apparatus trunk-road cap, km/h (data leaf road_access.heavy_apparatus_speed_kmh_by_highway; the speeds are assumptions in the data). */
export const OUT_OF_REGION_SPEED_KMH = dataValue<Record<string, number>>("road_access.heavy_apparatus_speed_kmh_by_highway").trunk;
/** ASSUMPTION: out-of-region airtankers fly this far to the board, km (a state reload base beyond the bases list). */
export const STATE_AIR_DISTANCE_KM = 150;
/**
 * ASSUMPTION: the share of orders a tier fills, by board activity level. Stands in for
 * statewide drawdown by other fires (CAL FIRE's own resources are shared across the state);
 * a busier fire season fills fewer orders. Not calibrated.
 */
export const FILL_PROBABILITY: Record<"quiet" | "active" | "severe", { mutual_aid: number; state: number }> = {
  quiet: { mutual_aid: 0.9, state: 0.95 },
  active: { mutual_aid: 0.75, state: 0.85 },
  severe: { mutual_aid: 0.5, state: 0.7 },
};
/** ASSUMPTION: an order a tier could not fill ("UTF") is placed with the next tier after this many minutes. */
export const UNABLE_TO_FILL_RETRY_MINUTES = 30;
/**
 * ASSUMPTION: the state system sends one board at most this many ground units at once (about
 * eight engine strike teams' worth) and this many aircraft. CAL FIRE's whole fleet is about 23
 * airtankers and 10 staffed helicopters (calfire_house_2019 p.3-4; web counts unverified), shared
 * by every fire in the state; beyond the cap an order is unable to fill until resources return.
 */
export const STATE_MAX_GROUND_UNITS = 40;
export const STATE_MAX_AIRCRAFT = 8;
/** ASSUMPTION: lead-time variation of an order, lognormal log-SD (same order as travel variation). */
export const ORDER_LEAD_LOG_SD = 0.2;

/** Minutes from a filled state order to the resource reaching the board edge (before seeded variation). */
export function stateGroundLeadMinutes(): number {
  return STATE_ORDER_PROCESSING_MINUTES + STATE_ASSEMBLY_MINUTES + (OUT_OF_REGION_DISTANCE_KM / OUT_OF_REGION_SPEED_KMH) * 60;
}

/** Whether a tier fills an order now (one seeded draw). */
export function fills(rng: RngStream, tier: "mutual_aid" | "state", activity: "quiet" | "active" | "severe"): boolean {
  return chance(rng, FILL_PROBABILITY[activity][tier]);
}

/** A lead time with seeded variation (median = `minutes`). */
export function variedLead(rng: RngStream, minutes: number): number {
  return minutes * lognormalFactor(rng, ORDER_LEAD_LOG_SD);
}
