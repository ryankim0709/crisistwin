/**
 * All clear: lifting a zone's evacuation order (lift_evacuation) once the board's fire model says
 * the fire that threatened it can no longer reach it. Pure: no React, network or LLM.
 *
 * On /live the board decides nothing itself (AI agent only): the commander (Claude, or the human
 * controller in the zone panel) lifts an order, and only when allClearCheck says the zone is
 * eligible. The old automatic reopening (model.ts reopenZones) runs only with the rule-based
 * response (board.response.autoDispatch, scripts).
 *
 * Eligibility (allClearCheck), all of:
 * 1. The zone has an evacuation order in effect or done, or was overrun (zoneOrderStatus leaving,
 *    done, overrun), and is not already lifted.
 * 2. Every reported fire that threatened the zone (zone.threatFireIds, noteZoneThreats: a reported
 *    fire that put the zone in the evacuation order tier at some minute, demo/evacThreat.ts
 *    orderTierThreat, or reached it within the window, not held by its units' containment, while
 *    the zone had an order; kept until the zone is back to normal) is contained or out, and has been
 *    for at least ALL_CLEAR_HOLD_MINUTES (containedAt, else outAt for a fire closed by hand).
 * 3. No other reported burning fire puts the zone in the order tier now (orderTierThreat: not
 *    expected contained, with margin, before it reaches the zone's core, and arriving within the
 *    latest safe start plus the decision window in the solver's free-burn spread). A fire that
 *    reaches the zone only if its containment fails, or only hours later, warns the zone
 *    (warn_evacuation) rather than keeping its order: the lift is proportional to the threat.
 *    Before, any reported burning fire whose free-burn arrival came within
 *    ALL_CLEAR_WINDOW_MINUTES blocked the lift, which kept zones ordered for hours after a small
 *    fire was out while another fire burned under control elsewhere.
 * On /live the observation adds one more (observation.ts): the evacuation schedule
 * (decisionAids.ts, with each route's traffic) must not still order the zone (tier "order").
 * Only reported fires count (the commander's picture, boardResponse.ts report rule): an
 * unreported fire cannot block or allow a lift.
 *
 * Effect (liftEvacuation): the order ends at the lift minute (ZoneLift.at): departures freeze
 * (households not yet departed stay home), and every household that left drives back home along
 * its route: it starts back at max(its arrival at the destination, the lift) and is home
 * ZoneLift.returnMinutes later (model.ts zoneCounts: out -> returning -> home, conserved). The
 * zone's order status is "lifted" until everyone is back, no active fire still touches the zone
 * and the all-clear label time is over (finishLifts); then it is an ordinary quiet zone again.
 *
 * Simulated: every number is a model result; the thresholds below are labelled assumptions.
 */

import { simClock } from "./format";
import { isReported } from "./boardResponse";
import { fireHeldBeforeZone, orderTierThreat } from "./evacThreat";
import { activeFires, departed, logEvent, zoneCounts, zoneOrderStatus, type Board, type Fire, type ZoneState } from "./model";
import { emptyTrips } from "./traffic";

/**
 * ASSUMPTION (a board rule, not sourced): only a fire whose solver arrival at the zone comes within
 * this many minutes of the board clock can count as threatening it (rules 2 and 3). Equal to fireField.ts
 * LOOKAHEAD_MINUTES: every arrival the solver forecasts counts (its field always reaches at least
 * model.ts FORECAST_MINUTES = 120 ahead, up to 360). Longer than FORECAST_MINUTES on purpose: the
 * free-burn evacuation schedule (decisionAids.ts) reads the whole lookahead (and on /live the
 * observation refuses a lift the schedule still orders). A literal: allClear.ts and model.ts import each other, so a
 * constant of their modules cannot be read at module load.
 */
export const ALL_CLEAR_WINDOW_MINUTES = 360;

/**
 * ASSUMPTION (a board rule, not sourced): every fire that threatened a zone must have been
 * contained (or out) at least this long before its order can be lifted, so a line that has just
 * passed its holding test is not trusted at once. Real repopulation follows damage and hazard
 * assessment over hours to days; the board compresses it.
 */
export const ALL_CLEAR_HOLD_MINUTES = 30;

/** Display only: the neutral "All clear" map label shows this many board minutes after the lift, then nothing. */
export const ALL_CLEAR_LABEL_MINUTES = 30;

/** A lifted evacuation order (ZoneState.lift). */
export interface ZoneLift {
  /** Board minute the order was lifted (departures freeze; returns start). */
  at: number;
  actor: "agent" | "you";
  reason: string;
  /**
   * Minutes a household drives back home: the free-flow drive time (RouteOption.eta_min) of the
   * zone's route at the lift; 0 when nobody had left. ASSUMPTION: return trips do not load the
   * evacuation traffic model (no re-entry congestion) and start as soon as the order is lifted
   * or the household reaches its destination.
   */
  returnMinutes: number;
  /** Households away from home (on the road or out) at the lift. */
  awayAtLift: number;
  /** Board minute every household that left was back home (null until then). */
  backAt: number | null;
}

export interface AllClearCheck {
  eligible: boolean;
  /** Why not (empty when eligible). */
  reasons: string[];
  /** Fires that threatened the zone, with their state now (status "gone" = out and off the board). */
  fires: { id: string; status: Fire["status"] | "gone"; settled: "contained" | "put_out" | null; sinceMin: number | null }[];
}

const MIN_EPS = 1e-6;

/** Solver arrival minute of each reported, not-out fire at the zone's cells (earliest over the zone), by fire. */
function arrivalsAt(board: Board, zone: ZoneState): Map<Fire, number> {
  const out = new Map<Fire, number>();
  const field = board.solver.field;
  const za = field?.zones.get(zone.id);
  if (!field || !za) return out;
  for (const fire of activeFires(board)) {
    if (!isReported(board, fire)) continue;
    const s = field.sourceIndex.get(fire.id);
    if (s === undefined) continue;
    const at = za.earliestBySource[s];
    if (Number.isFinite(at)) out.set(fire, at);
  }
  return out;
}

/**
 * Records, for every zone, the reported fires a lift waits for (arrival within
 * ALL_CLEAR_WINDOW_MINUTES): those that put it in the evacuation order tier now (demo/evacThreat.ts
 * orderTierThreat), and, while the zone has an order in effect or scheduled, every one not held
 * before it by its units' containment (as the former rule did for all fires): an order given on
 * the schedule's traffic-aware tier is not lifted the moment the forecast moves, only once that
 * fire is contained or out. Called by model.step on every whole minute; cleared when a lifted zone
 * is back to normal (finishLifts).
 */
export function noteZoneThreats(board: Board): void {
  for (const zone of board.zones) {
    const ordered = (zone.orderedAt !== null && zone.lift === null) || zone.pendingOrder !== null;
    for (const [fire, at] of arrivalsAt(board, zone)) {
      if (zone.threatFireIds.includes(fire.id) || at > board.minute + ALL_CLEAR_WINDOW_MINUTES) continue;
      if (orderTierThreat(board, zone, fire) || (ordered && fire.status === "burning" && !fireHeldBeforeZone(board, zone, fire))) zone.threatFireIds.push(fire.id);
    }
  }
}

/** Minutes since a fire was contained (else since it went out); null while burning. */
function settledFor(fire: Fire, minute: number): number | null {
  const at = fire.containedAt ?? fire.outAt;
  return fire.status === "burning" || at === null ? null : minute - at;
}

/** Whether the zone's evacuation order can be lifted now, and why not (see the module comment). */
export function allClearCheck(board: Board, zone: ZoneState): AllClearCheck {
  const reasons: string[] = [];
  const minute = board.minute;
  const status = zoneOrderStatus(zone, minute);
  if (status === "lifted") reasons.push(`its evacuation order was already lifted at ${simClock(zone.lift!.at)}`);
  else if (status === "none") reasons.push("it has no evacuation order");
  else if (status === "scheduled") reasons.push("its evacuation is only scheduled (cancel_evacuation drops it)");
  if (!board.solver.field) reasons.push("no fire forecast yet");
  const fires: AllClearCheck["fires"] = [];
  for (const id of zone.threatFireIds) {
    const fire = board.fires.find((f) => f.id === id);
    if (!fire) {
      fires.push({ id, status: "gone", settled: null, sinceMin: null });
      continue;
    }
    // An unreported fire is never recorded (noteZoneThreats), so every listed fire is known.
    const since = settledFor(fire, minute);
    const settled = since === null ? null : fire.containedAt === null ? "put_out" : "contained";
    fires.push({ id, status: fire.status, settled, sinceMin: since === null ? null : Math.floor(since + MIN_EPS) });
    if (since === null) reasons.push(`${id} is still burning`);
    else if (since < ALL_CLEAR_HOLD_MINUTES - MIN_EPS) {
      reasons.push(`${id} was ${settled === "put_out" ? "put out" : "contained"} ${Math.floor(since + MIN_EPS)} min ago (wait ${ALL_CLEAR_HOLD_MINUTES} min)`);
    }
  }
  for (const [fire, at] of arrivalsAt(board, zone)) {
    if (fire.status !== "burning" || zone.threatFireIds.includes(fire.id)) continue;
    if (at <= minute + ALL_CLEAR_WINDOW_MINUTES && orderTierThreat(board, zone, fire)) {
      const wait = Math.max(0, Math.round(at - minute));
      reasons.push(`${fire.id} is forecast to reach it ${wait === 0 ? "now" : `in ${wait} min`} and is not expected contained before it`);
    }
  }
  return { eligible: reasons.length === 0, reasons, fires };
}

/** "fire S1-F2 contained 45 min ago" for the log, from the most recently settled threatening fire. */
export function allClearCitation(check: AllClearCheck): string {
  const settled = check.fires.filter((f) => f.sinceMin !== null).sort((a, b) => a.sinceMin! - b.sinceMin!);
  const f = settled[0];
  if (f) return `fire ${f.id} ${f.settled === "put_out" ? "put out" : "contained"} ${f.sinceMin} min ago`;
  if (check.fires.length) return `fire${check.fires.length > 1 ? "s" : ""} ${check.fires.map((x) => x.id).join(", ")} out`;
  return `no fire forecast to reach it within ${ALL_CLEAR_WINDOW_MINUTES} min`;
}

/**
 * lift_evacuation: refused (returns why) unless allClearCheck says the zone is eligible. Ends the
 * order at board.minute; households that left drive back home (ZoneLift.returnMinutes).
 */
export function liftEvacuation(board: Board, zone: ZoneState, actor: "agent" | "you", reason = ""): string | null {
  const check = allClearCheck(board, zone);
  if (!check.eligible) return `${zone.name}: the evacuation order cannot be lifted yet: ${check.reasons.join("; ")}.`;
  const minute = board.minute;
  const c = zoneCounts(zone, minute);
  const away = c.enRoute + c.out;
  const returnMinutes = away > 0 ? Math.max(0, zone.route?.eta_min ?? 0) : 0;
  zone.lift = { at: minute, actor, reason, returnMinutes, awayAtLift: away, backAt: away > 0 ? null : minute };
  const cite = allClearCitation(check);
  const settled = check.fires.filter((f) => f.sinceMin !== null).sort((a, b) => a.sinceMin! - b.sinceMin!)[0];
  logEvent(board, "order", actor, `Evacuation order lifted: ${zone.name} (${cite}); residents may return.`, {
    action: "evacuation_lifted",
    zoneId: zone.id,
    households: away,
    label: cite,
    ...(settled ? { fireId: settled.id } : {}),
  });
  logEvent(
    board,
    "zone",
    "board",
    away > 0
      ? `All clear: ${zone.name} residents returning home (${away.toLocaleString("en-US")} households, about ${Math.round(returnMinutes)} min drive back; simulated).`
      : `All clear: ${zone.name} (no household had left; everyone is home).`,
    { action: "zone_all_clear", zoneId: zone.id, households: away, etaMin: Math.round(returnMinutes) },
  );
  return null;
}

/**
 * A new evacuation order on a lifted zone (model.ts orderEvacuation): the lift ends at once and
 * its households still driving back count as home (a board simplification: they leave again with
 * the new order's departure curve). Households are conserved.
 */
export function endLiftForNewOrder(board: Board, zone: ZoneState): void {
  if (!zone.lift) return;
  const c = zoneCounts(zone, board.minute);
  const onWay = c.enRoute + c.out + c.returning;
  resetOrder(zone);
  zone.lift = null;
  zone.threatFireIds = [];
  if (onWay > 0) {
    logEvent(board, "zone", "board", `${zone.name}: new order while ${onWay.toLocaleString("en-US")} households were still on their way back; counted home and leaving again (board simplification).`, {
      action: "zone_back_home",
      zoneId: zone.id,
      households: onWay,
    });
  }
}

function resetOrder(zone: ZoneState): void {
  zone.orderedAt = null;
  zone.route = null;
  zone.pendingOrder = null;
  zone.trips = emptyTrips();
}

/** Whether an active (not out) fire's burned ground reaches the zone now (any fire: the board's physics). */
function touchedNow(board: Board, zone: ZoneState): boolean {
  const field = board.solver.field;
  const za = field?.zones.get(zone.id);
  if (!field || !za) return false;
  for (const fire of activeFires(board)) {
    const s = field.sourceIndex.get(fire.id);
    if (s !== undefined && za.earliestBySource[s] <= board.minute) return true;
  }
  return false;
}

/**
 * Every whole minute (model.step): a lifted zone whose households are all back drops its order
 * (logged once); once no active fire touches it, its touch and overrun marks are cleared (as the
 * former reopening did: caught households stay in the run totals); once all that is done and the
 * all-clear label time is over, the lift record goes and the zone is an ordinary quiet zone.
 */
export function finishLifts(board: Board): void {
  const minute = board.minute;
  for (const zone of board.zones) {
    const lift = zone.lift;
    if (!lift) continue;
    if (zone.orderedAt !== null) {
      const c = zoneCounts(zone, minute);
      if (c.enRoute + c.out + c.returning === 0) {
        const back = departed(zone, minute);
        resetOrder(zone);
        if (lift.backAt === null) {
          lift.backAt = minute;
          logEvent(board, "zone", "board", `${zone.name}: all ${back.toLocaleString("en-US")} households that left are back home (simulated).`, {
            action: "zone_back_home",
            zoneId: zone.id,
            households: back,
          });
        }
      }
    }
    if ((zone.touchedAt !== null || zone.overrunAt !== null) && !touchedNow(board, zone)) {
      zone.touchedAt = zone.knownTouchedAt = zone.lastFireAt = null;
      if (zone.overrunAt !== null) {
        zone.overrunAt = null;
        zone.caught = 0;
        zone.caughtPeople = zone.occupants === null ? null : 0;
      }
    }
    if (zone.orderedAt === null && zone.overrunAt === null && zone.touchedAt === null && minute - lift.at >= ALL_CLEAR_LABEL_MINUTES - MIN_EPS) {
      zone.lift = null;
      zone.threatFireIds = [];
    }
  }
}

/** Whether the zone's "All clear" label shows now (the first ALL_CLEAR_LABEL_MINUTES after its lift). */
export function allClearLabelShown(zone: ZoneState, minute: number): boolean {
  return zone.lift !== null && minute - zone.lift.at < ALL_CLEAR_LABEL_MINUTES;
}
