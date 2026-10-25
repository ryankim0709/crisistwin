/**
 * How a burning fire threatens a zone, for the evacuation tiers of demo/decisionAids.ts and the
 * all-clear rule of demo/allClear.ts (one rule for both, so an order is kept exactly while the
 * aid would give it). Pure: no React, network or LLM; every number is a board model result, the
 * thresholds are labelled assumptions.
 *
 * Arrival: the fire's free-burn arrival at the zone's core (the solver's arrival field, which
 * includes line already built but not a containment that has not happened). The board catches
 * households still home when fire reaches the core (model.ts), so the core is what an order races.
 * For the fire that reaches the core first (ZoneArrival.coreSource) that is its own core arrival;
 * for another fire it is not tracked, and max(its arrival at any zone cell, the core's earliest
 * arrival) is used, a lower bound (fire reaches a cell of the zone no later than the core).
 *
 * Held before: the board's containment estimate for the fire (absolute board minute) falls at
 * least EVAC_CONTAINMENT_MARGIN_MIN before that arrival. Such a zone is threatened only if the
 * containment fails. Containment estimates, in this order:
 * - the units on the fire (model.ts currentContainment: direct-attack units, including those en
 *   route), unless the chosen strategy is overdue (its predicted containment or line passed
 *   STRATEGY_OVERDUE_GRACE_MIN ago with the fire still burning: the forecast failed);
 * - for a fire with no strategy chosen and no unit on it yet (a fresh report), the strategy aid's
 *   recommended option (demo/decisionAids.ts strategyAid: a perimeter option the model says
 *   contains, containedInMin from now), when the caller passes it. Lines are not counted: a line
 *   option holds the fire at the line, not by a time.
 *
 * Order tier (orderTierThreat): not held, and the fire's arrival leaves no more than
 * EVAC_DECISION_WINDOW_MIN beyond the latest safe start. The schedule (decisionAids.ts) computes
 * that start with each route's clearance and congested drive; the all-clear rule, which has no
 * traffic picture, uses the zone's own route's free-flow drive (0 without one): a later start than
 * the schedule's, so it can let a lift through a little sooner than the schedule would order again.
 *
 * Units: absolute board minutes are *_minute / *Minute, durations *_min / *Min.
 */

import { isReported } from "./boardResponse";
import { currentContainment, type Board, type Fire, type ZoneState } from "./model";
import { DEPARTURE_MEAN_MINUTES } from "./realism";

/** ASSUMPTION (aid rule, not sourced): a chosen strategy still burning this long after its predicted containment (or line done) is overdue. */
export const STRATEGY_OVERDUE_GRACE_MIN = 15;
/** ASSUMPTION (planning buffer, not sourced): the schedule wants every zone clear this many minutes before fire reaches its core. */
export const EVAC_SAFETY_MARGIN_MIN = 30;
/**
 * ASSUMPTION (planning target, not sourced): a zone is "clear" when this share of its complying
 * households with a vehicle have left. With exponential departures of mean DEPARTURE_MEAN_MINUTES
 * that takes DEPARTURE_MEAN_MINUTES x ln(1 / (1 - share)) minutes (90%: about 214 min).
 */
export const EVAC_TARGET_DEPARTED_SHARE = 0.9;
/** Departure lead for EVAC_TARGET_DEPARTED_SHARE, minutes (realism.ts DEPARTURE_MEAN_MINUTES, sourced; the share is an assumption). */
export const EVAC_DEPARTURE_LEAD_MIN = Math.round(DEPARTURE_MEAN_MINUTES * Math.log(1 / (1 - EVAC_TARGET_DEPARTED_SHARE)));
/**
 * ASSUMPTION (aid rule, not sourced): a zone threatened in free burn is ordered out once its
 * latest safe start is this close; earlier it is warned (be ready to leave). It covers the
 * commander's review cadence (observation.ts CONTINUOUS_GAP_MINUTES = 3 board min while a fire
 * burns) and its think time several times over, so a zone is not missed between two decisions.
 * Ordering at the latest safe start still meets the schedule's own target
 * (EVAC_TARGET_DEPARTED_SHARE of complying households gone EVAC_SAFETY_MARGIN_MIN before core
 * arrival); ordering earlier only adds to it.
 */
export const EVAC_DECISION_WINDOW_MIN = 30;
/**
 * ASSUMPTION (aid rule, derived from two assumptions above, not sourced): a fire counts as held
 * before a zone only when its containment is expected at least this long before it reaches the
 * zone's core. Sized so that a containment that fails is noticed (overdue after
 * STRATEGY_OVERDUE_GRACE_MIN) while the fire is still EVAC_SAFETY_MARGIN_MIN from the core, by the
 * same free-burn forecast. Life-safety caveat: a zone ordered only then has far less than the
 * departure lead the schedule otherwise plans for; that is the trade the warning tier makes so
 * that zones a small fire under control never reaches are not evacuated.
 */
export const EVAC_CONTAINMENT_MARGIN_MIN = STRATEGY_OVERDUE_GRACE_MIN + EVAC_SAFETY_MARGIN_MIN;

/** Whether the fire's chosen strategy is past its predicted containment (or line done) by more than STRATEGY_OVERDUE_GRACE_MIN. */
export function strategyOverdue(board: Board, fire: Fire): boolean {
  const chosen = board.response.fires.get(fire.id)?.strategy ?? null;
  const promised = chosen ? (chosen.containedInMin ?? chosen.lineDoneMin) : null;
  return chosen !== null && promised !== null && fire.status === "burning" && board.minute > chosen.at + promised + STRATEGY_OVERDUE_GRACE_MIN;
}

/**
 * Board minute a burning reported fire is expected contained (see the module comment), or null
 * when nothing is expected to contain it. `recommendedContainedInMin`: the strategy aid's
 * recommended containment, minutes from now (null when none contains or it was not computed),
 * used only while no strategy is chosen and no unit is on the fire.
 */
export function expectedContainmentMinute(board: Board, fire: Fire, recommendedContainedInMin: number | null = null): number | null {
  if (fire.status !== "burning" || !isReported(board, fire) || strategyOverdue(board, fire)) return null;
  const assigned = board.teams.some((t) => t.fireId === fire.id);
  const chosen = board.response.fires.get(fire.id)?.strategy ?? null;
  if (assigned || chosen) {
    const c = currentContainment(board, fire);
    return c === null ? null : board.minute + c;
  }
  return recommendedContainedInMin === null ? null : board.minute + recommendedContainedInMin;
}

/** Whether containment at `containedAtMinute` comes at least EVAC_CONTAINMENT_MARGIN_MIN before an arrival at `arrivalMinute` (Infinity = never in the lookahead). */
export function heldBefore(containedAtMinute: number | null, arrivalMinute: number): boolean {
  return containedAtMinute !== null && containedAtMinute + EVAC_CONTAINMENT_MARGIN_MIN <= arrivalMinute;
}

/** The fire's (solver source `s`) free-burn arrival at the zone's core, board minute (see the module comment); Infinity when not in the lookahead. */
export function coreArrivalOf(board: Board, zone: ZoneState, s: number): number {
  const za = board.solver.field?.zones.get(zone.id);
  if (!za) return Infinity;
  return s === za.coreSource ? za.coreArrival : Math.max(za.earliestBySource[s], za.coreArrival);
}

/** Whether a burning reported fire is held before the zone's core by its units' expected containment (module comment; no recommendation basis). */
export function fireHeldBeforeZone(board: Board, zone: ZoneState, fire: Fire): boolean {
  const s = board.solver.field?.sourceIndex.get(fire.id);
  if (s === undefined) return false;
  return heldBefore(expectedContainmentMinute(board, fire), coreArrivalOf(board, zone, s));
}

/**
 * Whether `fire` alone puts the zone in the evacuation order tier now (module comment): not held
 * before the zone's core and arriving within the latest safe start (zone route's free-flow drive,
 * EVAC_DEPARTURE_LEAD_MIN, EVAC_SAFETY_MARGIN_MIN) plus EVAC_DECISION_WINDOW_MIN. False for a fire
 * not burning or not reported. Used by demo/allClear.ts.
 */
export function orderTierThreat(board: Board, zone: ZoneState, fire: Fire): boolean {
  const s = board.solver.field?.sourceIndex.get(fire.id);
  if (s === undefined || fire.status !== "burning" || !isReported(board, fire)) return false;
  const core = coreArrivalOf(board, zone, s);
  if (heldBefore(expectedContainmentMinute(board, fire), core)) return false;
  // No core arrival in the lookahead: plan on the zone's edge, as the schedule does (eta_basis "edge").
  const arrival = Number.isFinite(core) ? core : (board.solver.field?.zones.get(zone.id)?.earliestBySource[s] ?? Infinity);
  if (!Number.isFinite(arrival)) return false;
  const drive = zone.route?.eta_min ?? zone.pendingOrder?.route.eta_min ?? 0;
  return arrival - (EVAC_DEPARTURE_LEAD_MIN + drive + EVAC_SAFETY_MARGIN_MIN) <= board.minute + EVAC_DECISION_WINDOW_MIN;
}
