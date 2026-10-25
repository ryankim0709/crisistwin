/**
 * Model-computed decision aids for the AI commander on the /live board (observation
 * `decision_aids`, demo/contracts.ts DecisionAidsObservation). Pure: no React, network or LLM.
 * The LLM only chooses among these; every number here comes from the board's models (the fire
 * solver's arrival field, the departure curve, the traffic picture, the strategy options).
 * See docs/command-demo-realism.md "Decision aids".
 *
 * 1. Evacuation schedule (evacuationSchedule): every zone a reported burning fire reaches within
 *    the solver's lookahead in free burn (the field already includes the line built so far, but not
 *    a containment that has not happened), with
 *    - its latest safe start: core ETA - (the departure lead for EVAC_TARGET_DEPARTED_SHARE of the
 *      complying households + route clearance + congested drive) - EVAC_SAFETY_MARGIN_MIN;
 *    - its threat: "if_containment_fails" when every fire reaching it is expected contained at
 *      least EVAC_CONTAINMENT_MARGIN_MIN before it arrives (demo/evacThreat.ts: the assigned
 *      units' containment, or for a fresh fire with nothing on it the recommended strategy's),
 *      else "free_burn";
 *    - its tier (action), proportional to the threat:
 *      order_now  free_burn and the latest safe start is within EVAC_DECISION_WINDOW_MIN of now (or
 *                 past: too_late) and the departure peak fits the roads now;
 *      schedule / reschedule / scheduled_ok  free_burn, latest safe start within the window, but
 *                 the earliest start whose departure peak fits under every shared road segment's
 *                 capacity beside the zones already leaving or scheduled is later (never after the
 *                 latest safe start); scheduled_ok also for a zone already scheduled in time;
 *      warn / warned  be ready to leave (warn_evacuation): the threat is if_containment_fails, or
 *                 free_burn with the latest safe start more than the window away (the aid says
 *                 order_now at recommended_start_minute = latest safe start - window, re-checked
 *                 at every call); warned when the zone already has a warning;
 *      leaving    an order is in effect.
 *      Zones not in the list need no action (a warning or schedule there can be withdrawn).
 *    - the expected caught if ordered now and at the recommended start (model.ts catch rule: home
 *      when fire reaches the core; carless and non-complying households never leave).
 * 2. Strategy recommendation per reported burning fire (strategyAid): each strategy option with
 *    the homes the solver's forecast burns by its containment (or by the line, or by the forecast
 *    horizon when it does not contain), the containable option that burns the fewest homes, and
 *    when none contains, an all-available-units package: every free unit that can reach the fire
 *    on the protection line ready before the fire that stands in front of the most households
 *    (else the perimeter option burning the fewest homes), the available aircraft, and the stages'
 *    sized extended-attack orders (response/runCards.ts ESCALATION_ORDERS).
 *
 * Units: board minutes (absolute minutes are named *_minute, durations *_min), households, persons.
 */

import { ESCALATION_ORDERS, MAX_ORDER_COUNT, type Orderable } from "../response/runCards";
import { initialAttackRecommendation, isReported } from "./boardResponse";
import { LOOKAHEAD_MINUTES } from "./fireField";
import {
  FORECAST_MINUTES,
  MAX_SCHEDULE_AHEAD_MINUTES,
  activeFires,
  dispatchable,
  evacuationEstimate,
  nearestFree,
  orderPeakVehiclesPerMinute,
  trafficPicture,
  withVehicle,
  type Board,
  type Fire,
  type RouteOption,
  type ZoneState,
} from "./model";
import {
  EVAC_CONTAINMENT_MARGIN_MIN,
  EVAC_DECISION_WINDOW_MIN,
  EVAC_DEPARTURE_LEAD_MIN,
  EVAC_SAFETY_MARGIN_MIN,
  EVAC_TARGET_DEPARTED_SHARE,
  STRATEGY_OVERDUE_GRACE_MIN,
  coreArrivalOf,
  expectedContainmentMinute,
  heldBefore,
  strategyOverdue,
} from "./evacThreat";
import { DEPARTURE_MEAN_MINUTES, ORDER_COMPLIANCE } from "./realism";
import { forecastHomesBurned } from "./scoring";
import { computeStrategyOptions, type StrategyOption } from "./strategyOptions";

/**
 * The schedule's assumptions (each labelled where it is defined, demo/evacThreat.ts, shared with
 * demo/allClear.ts): target departed share and its departure lead, safety margin, decision
 * window, containment margin, strategy overdue grace.
 */
export {
  EVAC_CONTAINMENT_MARGIN_MIN,
  EVAC_DECISION_WINDOW_MIN,
  EVAC_DEPARTURE_LEAD_MIN,
  EVAC_SAFETY_MARGIN_MIN,
  EVAC_TARGET_DEPARTED_SHARE,
  STRATEGY_OVERDUE_GRACE_MIN,
};
/** Zones are listed while a reported fire reaches them within the solver's lookahead (fireField.ts LOOKAHEAD_MINUTES). */
export const EVAC_PLANNING_HORIZON_MIN = LOOKAHEAD_MINUTES;
/** Schedule search step, minutes (a board rule for the aid, not sourced). */
export const EVAC_SCHEDULE_STEP_MIN = 5;

export const EVAC_SCHEDULE_LABEL = `Evacuation schedule (model output, demo/decisionAids.ts): zones a reported burning fire reaches within ${EVAC_PLANNING_HORIZON_MIN} min in the fire model's free-burn forecast (line built so far included, containment not assumed in the ETA). threat: if_containment_fails when every fire reaching the zone is expected contained (its assigned units' estimate, or for a fresh fire with nothing on it the recommended strategy's) at least ${EVAC_CONTAINMENT_MARGIN_MIN} min before it arrives (contained_by_minute), else free_burn. Tiers (action): order_now = free_burn and latest_safe_start_minute within ${EVAC_DECISION_WINDOW_MIN} min of now (or past: too_late); schedule / reschedule = the same but the roads fit only from recommended_start_minute; scheduled_ok = already scheduled in time; warn = be ready to leave (warn_evacuation), for if_containment_fails zones and free_burn zones whose latest safe start is further than ${EVAC_DECISION_WINDOW_MIN} min (order_by_minute: when the aid will say order_now if nothing changes); warned = already warned; leaving = ordered. ASSUMPTIONS: the ${EVAC_DECISION_WINDOW_MIN} min decision window and the ${EVAC_CONTAINMENT_MARGIN_MIN} min containment margin (${STRATEGY_OVERDUE_GRACE_MIN} min overdue grace + ${EVAC_SAFETY_MARGIN_MIN} min safety margin). latest_safe_start_minute = now + core ETA - (${EVAC_DEPARTURE_LEAD_MIN} min for ${Math.round(EVAC_TARGET_DEPARTED_SHARE * 100)}% of complying households to leave, exponential departures of mean ${DEPARTURE_MEAN_MINUTES} min + clearance_min + congested drive) - ${EVAC_SAFETY_MARGIN_MIN} min margin (ASSUMPTIONS: target share and margin). recommended_start_minute: now when too_late, else the earliest minute the zone's departure peak fits every shared road segment's capacity beside the zones already leaving or scheduled, never after latest_safe_start_minute. expected_caught_*: households / persons still home at the core ETA under the board's catch rule (carless and the ${Math.round((1 - ORDER_COMPLIANCE) * 100)}% who do not comply never leave).`;

/** The schedule's tiers (see the module comment). */
export type EvacAction = "order_now" | "schedule" | "reschedule" | "scheduled_ok" | "leaving" | "warn" | "warned";
export type EvacThreat = "free_burn" | "if_containment_fails";

export interface ZoneEvacPlan {
  zone: ZoneState;
  /** Minutes from now until fire reaches the core (basis "core") or, with no core arrival in the lookahead, the zone's edge (basis "edge"). */
  etaMin: number;
  etaBasis: "core" | "edge";
  /** The zone's contained forecast (model.zoneForecasts, up to the assigned units' containment), minutes, or null. */
  forecastCoreEtaMin: number | null;
  option: RouteOption | null;
  clearanceMin: number;
  congestedEtaMin: number;
  latestSafeStartMinute: number;
  recommendedStartMinute: number;
  tooLate: boolean;
  /** Recommended start could not keep a shared segment under capacity before the latest safe start (it starts then anyway). */
  overCapacity: boolean;
  action: EvacAction;
  /** free_burn, or if_containment_fails (every fire reaching the zone held before it: demo/evacThreat.ts). */
  threat: EvacThreat;
  /**
   * What the zone needs now, order or not: "order" (free_burn and the latest safe start within
   * EVAC_DECISION_WINDOW_MIN, or past) or "warn". For a zone leaving it says whether the order is
   * still needed (observation.ts refuses an all clear while it is "order").
   */
  tier: "order" | "warn";
  /** if_containment_fails: the latest expected containment (board minute) of the fires reaching the zone; null otherwise. */
  containedByMinute: number | null;
  /** Board minute the aid says order_now at in free burn if nothing changes: latest safe start - EVAC_DECISION_WINDOW_MIN (now at the earliest). */
  orderByMinute: number;
  expectedCaughtNow: { households: number; people: number | null };
  expectedCaughtAtRecommended: { households: number; people: number | null };
}

/** Households and persons home at absolute minute `eta` when the order takes effect at `start` (model.ts departed / caughtPeopleAt, in expectation). */
export function expectedCaught(zone: ZoneState, start: number, eta: number): { households: number; people: number | null } {
  const w = withVehicle(zone);
  const share = eta > start ? 1 - Math.exp(-(eta - start) / DEPARTURE_MEAN_MINUTES) : 0;
  const leaving = w * ORDER_COMPLIANCE * share;
  const households = Math.round(zone.households - leaving);
  if (zone.occupants === null) return { households, people: null };
  const vehiclePersons = Math.max(0, zone.occupants - (zone.needsTransportOccupants ?? 0));
  const people = Math.round(zone.occupants - (w > 0 ? (leaving * vehiclePersons) / w : 0));
  return { households, people };
}

/**
 * Whether every reported burning fire reaching the zone within the horizon is held before it
 * (demo/evacThreat.ts heldBefore at its free-burn arrival at the zone's core, coreArrivalOf), and
 * the latest of their expected containments; null when one is not held.
 */
function heldBeforeZone(board: Board, zone: ZoneState, sources: ReadonlyMap<number, number | null>): { containedBy: number } | null {
  const za = board.solver.field?.zones.get(zone.id);
  if (!za) return null;
  const limit = board.minute + EVAC_PLANNING_HORIZON_MIN;
  let containedBy = -Infinity;
  for (const [s, containedAt] of sources) {
    if (!(za.earliestBySource[s] <= limit)) continue;
    if (!heldBefore(containedAt, coreArrivalOf(board, zone, s))) return null;
    containedBy = Math.max(containedBy, containedAt!);
  }
  return Number.isFinite(containedBy) ? { containedBy } : null;
}

/** Free-burn arrivals of reported burning fires at the zone (core, else edge), minutes from now, within the horizon; null when none. */
function freeBurnEta(board: Board, zone: ZoneState, sources: ReadonlyMap<number, unknown>): { etaMin: number; basis: "core" | "edge" } | null {
  const field = board.solver.field;
  const za = field?.zones.get(zone.id);
  if (!field || !za) return null;
  const limit = board.minute + EVAC_PLANNING_HORIZON_MIN;
  if (sources.has(za.coreSource) && za.coreArrival <= limit) return { etaMin: Math.max(0, za.coreArrival - board.minute), basis: "core" };
  let edge = Infinity;
  for (const s of sources.keys()) edge = Math.min(edge, za.earliestBySource[s]);
  return edge <= limit ? { etaMin: Math.max(0, edge - board.minute), basis: "edge" } : null;
}

/** Departure flow (veh/min) zone `z` puts on the road at absolute minute `t` from a start at `start` (the exponential curve). */
function flowAt(z: ZoneState, start: number, t: number): number {
  return t < start ? 0 : orderPeakVehiclesPerMinute(z) * Math.exp(-(t - start) / DEPARTURE_MEAN_MINUTES);
}

/**
 * The evacuation schedule over the zones reported fires threaten in free burn (see the module
 * comment), most urgent first (latest safe start ascending). `forecastCore` gives the contained
 * forecast's core ETA per zone (model.zoneForecasts "reported"). `recommendedContainedInMin`: per
 * fire id, the strategy aid's recommended containment in minutes from now (strategyAid, null when
 * none contains); used only for a fire with no strategy and no unit yet (demo/evacThreat.ts).
 */
export function evacuationSchedule(
  board: Board,
  routes: ReadonlyMap<string, RouteOption[]>,
  forecastCore: (zoneId: string) => number | null,
  recommendedContainedInMin: ReadonlyMap<string, number | null> = new Map(),
): ZoneEvacPlan[] {
  const field = board.solver.field;
  if (!field) return [];
  // Source index -> the fire's expected containment (board minute) or null.
  const sources = new Map<number, number | null>();
  for (const f of activeFires(board)) {
    const s = field.sourceIndex.get(f.id);
    if (s !== undefined && f.status === "burning" && isReported(board, f)) sources.set(s, expectedContainmentMinute(board, f, recommendedContainedInMin.get(f.id) ?? null));
  }
  if (sources.size === 0) return [];
  const now = board.minute;
  const picture = trafficPicture(board);
  const drafts: ZoneEvacPlan[] = [];
  // A lifted zone (demo/allClear.ts) has no order in effect, even while its residents drive back: a fire threatening it again plans it anew.
  const leaving = (z: ZoneState) => z.orderedAt !== null && z.lift === null;
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) continue;
    const eta = freeBurnEta(board, zone, sources);
    if (!eta) continue;
    const options = routes.get(zone.id) ?? [];
    const coreAbs = now + eta.etaMin;
    let best: { option: RouteOption; clearance: number; drive: number; latest: number } | null = null;
    for (const option of options) {
      const e = evacuationEstimate(board, picture, zone, option, eta.etaMin);
      const latest = coreAbs - (EVAC_DEPARTURE_LEAD_MIN + e.clearanceMin + e.congestedEtaMin) - EVAC_SAFETY_MARGIN_MIN;
      // Prefer routes that do not pass the fire, then the latest safe start (the most time).
      const rank = (o: RouteOption) => (o.safety === "clear" ? 0 : o.safety === "passes_near_fire" ? 1 : 2);
      if (!best || rank(option) < rank(best.option) || (rank(option) === rank(best.option) && latest > best.latest)) {
        best = { option, clearance: e.clearanceMin, drive: e.congestedEtaMin, latest };
      }
    }
    // A leaving zone keeps its route (it can only be redirected).
    if (leaving(zone) && zone.route) {
      const current = options.find((o) => o.destination_id === zone.route!.destination_id) ?? zone.route;
      const e = evacuationEstimate(board, picture, zone, current, eta.etaMin);
      best = { option: current, clearance: e.clearanceMin, drive: e.congestedEtaMin, latest: coreAbs - (EVAC_DEPARTURE_LEAD_MIN + e.clearanceMin + e.congestedEtaMin) - EVAC_SAFETY_MARGIN_MIN };
    }
    const latest = best ? best.latest : coreAbs - EVAC_DEPARTURE_LEAD_MIN - EVAC_SAFETY_MARGIN_MIN;
    const held = heldBeforeZone(board, zone, sources);
    drafts.push({
      zone,
      etaMin: Math.round(eta.etaMin),
      etaBasis: eta.basis,
      forecastCoreEtaMin: forecastCore(zone.id),
      option: best?.option ?? null,
      clearanceMin: Math.round(best?.clearance ?? 0),
      congestedEtaMin: Math.round(best?.drive ?? 0),
      latestSafeStartMinute: Math.floor(latest),
      recommendedStartMinute: Math.round(now),
      tooLate: latest <= now,
      overCapacity: false,
      action: "order_now",
      threat: held ? "if_containment_fails" : "free_burn",
      tier: !held && latest <= now + EVAC_DECISION_WINDOW_MIN ? "order" : "warn",
      containedByMinute: held ? Math.round(held.containedBy) : null,
      orderByMinute: Math.max(Math.round(now), Math.floor(latest - EVAC_DECISION_WINDOW_MIN)),
      expectedCaughtNow: leaving(zone) ? expectedCaught(zone, zone.orderedAt!, coreAbs) : expectedCaught(zone, now, coreAbs),
      expectedCaughtAtRecommended: { households: 0, people: null },
    });
  }
  drafts.sort((a, b) => a.latestSafeStartMinute - b.latestSafeStartMinute || a.zone.id.localeCompare(b.zone.id));

  // Departure flows already on (or committed to) the roads: zones leaving, then each planned zone in turn.
  const planned: { zone: ZoneState; start: number; segments: Set<string> }[] = [];
  for (const z of board.zones) {
    if (z.overrunAt !== null || !leaving(z) || !z.route) continue;
    planned.push({ zone: z, start: z.orderedAt!, segments: new Set(z.route.segments.map((s) => s.id)) });
  }
  const fits = (plan: ZoneEvacPlan, t: number): boolean => {
    for (const seg of plan.option?.segments ?? []) {
      let flow = orderPeakVehiclesPerMinute(plan.zone);
      for (const p of planned) if (p.segments.has(seg.id)) flow += flowAt(p.zone, p.start, t);
      if (flow > seg.capacity_veh_h / 60) return false;
    }
    return true;
  };
  for (const plan of drafts) {
    const zone = plan.zone;
    const coreAbs = now + plan.etaMin;
    if (leaving(zone)) {
      plan.action = "leaving";
      plan.recommendedStartMinute = Math.round(zone.orderedAt!);
      plan.expectedCaughtAtRecommended = expectedCaught(zone, zone.orderedAt!, coreAbs);
      continue;
    }
    const pending = zone.pendingOrder;
    // Warning tier: threatened only if containment fails, or (free burn) the latest safe start is
    // more than the decision window away. A schedule already set in time stays (its departures
    // are committed on the roads); for a contingent zone warn_evacuation replaces it.
    if (plan.tier === "warn") {
      if (plan.threat === "free_burn" && pending && pending.startMinute <= plan.latestSafeStartMinute) {
        plan.action = "scheduled_ok";
        plan.recommendedStartMinute = pending.startMinute;
        plan.expectedCaughtAtRecommended = expectedCaught(zone, pending.startMinute, coreAbs);
        if (plan.option) planned.push({ zone, start: pending.startMinute, segments: new Set(plan.option.segments.map((s) => s.id)) });
        continue;
      }
      plan.action = zone.warning && !pending && zone.lift === null ? "warned" : "warn";
      plan.recommendedStartMinute = plan.orderByMinute;
      plan.expectedCaughtAtRecommended = expectedCaught(zone, plan.orderByMinute, coreAbs);
      continue;
    }
    let start = Math.round(now);
    const latest = Math.min(plan.latestSafeStartMinute, Math.floor(now + MAX_SCHEDULE_AHEAD_MINUTES));
    if (!plan.tooLate && plan.option) {
      let t = Math.round(now);
      while (t <= latest && !fits(plan, t)) t += EVAC_SCHEDULE_STEP_MIN;
      if (t > latest) {
        plan.overCapacity = true;
        t = Math.max(Math.round(now), latest);
      }
      start = t;
    }
    plan.recommendedStartMinute = start;
    plan.expectedCaughtAtRecommended = expectedCaught(zone, start, coreAbs);
    if (start <= now + 1e-9) plan.action = "order_now";
    else if (pending && pending.startMinute <= plan.latestSafeStartMinute && pending.startMinute <= start + EVAC_SCHEDULE_STEP_MIN) plan.action = "scheduled_ok";
    else plan.action = pending ? "reschedule" : "schedule";
    if (plan.option) planned.push({ zone, start: pending && plan.action === "scheduled_ok" ? pending.startMinute : start, segments: new Set(plan.option.segments.map((s) => s.id)) });
  }
  return drafts;
}

// ---- strategy ----

export interface StrategyHomes {
  option: StrategyOption;
  /** Whether the model says it holds the fire: contained, or a line finished before the fire reaches it with no breach or crown warning. */
  containable: boolean;
  /** Minutes from now the homes forecast runs to (containment, the line, or the forecast horizon). */
  homesByMin: number;
  /** Homes (households) the solver's forecast has burned by then (scoring.ts method), including those already burned. */
  homesBurned: number;
  /** Households of the zones the option's fire reaches (structures, evacuated or not). */
  householdsInZonesReached: number;
}

export interface FireStrategyAid {
  fire: Fire;
  options: StrategyHomes[];
  /** The containable option burning the fewest homes (ties: sooner, fewer units), or null when none contains. */
  recommended: StrategyHomes | null;
  /**
   * Units to send for the recommended option: the option's own (the fewest that contain) plus the
   * run card's closest free units still needed (boardResponse.initialAttackRecommendation), so a
   * first attack is not sized at the bare minimum of a forecast. [] without a recommendation.
   */
  recommendedSend: { crewId: string; positionId: string | null }[];
  /**
   * The chosen strategy predicted containment (or its line finished) more than
   * STRATEGY_OVERDUE_GRACE_MIN ago and the fire still burns: the forecast has failed, so allUnits is filled too.
   */
  overdue: boolean;
  /** When nothing contains (or the chosen strategy is overdue): every free unit on the option burning the fewest homes, available aircraft and the stage's sized orders. */
  allUnits: {
    option: StrategyHomes;
    send: { crewId: string; positionId: string | null; etaMin: number }[];
    aircraft: { aircraftId: string; overFireMin: number }[];
    orders: { resource: Orderable; count: number }[];
  } | null;
  /** Free units (dispatchable, on no fire) while this fire burns uncontained. */
  idleUnits: string[];
}

function holds(o: StrategyOption): boolean {
  if (o.outcome === "contained") return true;
  if (o.outcome !== "line_ahead" || o.lineReadyBeforeFire !== true) return false;
  return !o.safety.some((s) => s.startsWith("Crown fire") || s.includes("can be breached"));
}

function unitsOf(o: StrategyOption): number {
  return o.assigned.length + o.send.length;
}

const ORDER_KEYS: [Orderable, keyof (typeof ESCALATION_ORDERS)[number]][] = [
  ["engine_strike_team", "engine_strike_teams"],
  ["crew_strike_team", "crew_strike_teams"],
  ["dozer_strike_team", "dozer_strike_teams"],
  ["airtanker", "airtankers"],
  ["helicopter", "helicopters"],
];

/** The strategy aid of one reported burning fire (null otherwise). */
export function strategyAid(board: Board, fire: Fire): FireStrategyAid | null {
  if (fire.status !== "burning" || !isReported(board, fire)) return null;
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  const options = computeStrategyOptions(board, fire);
  if (s === undefined || options.length === 0) return null;
  const scored: StrategyHomes[] = options.map((option) => {
    const containable = holds(option);
    const by =
      option.outcome === "contained"
        ? (option.containedInMin ?? FORECAST_MINUTES)
        : containable && option.fireReachesLineMin !== null
          ? option.fireReachesLineMin
          : FORECAST_MINUTES;
    const households = option.zonesReached.reduce((sum, id) => sum + (board.zones.find((z) => z.id === id)?.households ?? 0), 0);
    return { option, containable, homesByMin: Math.round(by), homesBurned: forecastHomesBurned(board, s, board.minute + by).total, householdsInZonesReached: households };
  });
  const order = (a: StrategyHomes, b: StrategyHomes) =>
    a.homesBurned - b.homesBurned ||
    (a.option.containedInMin ?? a.option.lineDoneMin ?? Infinity) - (b.option.containedInMin ?? b.option.lineDoneMin ?? Infinity) ||
    unitsOf(a.option) - unitsOf(b.option) ||
    a.option.id.localeCompare(b.option.id);
  const containable = scored.filter((x) => x.containable).sort(order);
  const recommended = containable[0] ?? null;
  const overdue = strategyOverdue(board, fire);
  const recommendedSend: FireStrategyAid["recommendedSend"] = [];
  if (recommended) {
    const positionId = recommended.option.positionId;
    for (const u of recommended.option.send) recommendedSend.push({ crewId: u.team.id, positionId });
    for (const u of initialAttackRecommendation(board, fire)?.units ?? []) {
      if (!recommendedSend.some((x) => x.crewId === u.team.id)) recommendedSend.push({ crewId: u.team.id, positionId });
    }
  }
  const idleUnits = board.teams.filter((t) => dispatchable(t) && t.fireId === null && t.status !== "returning").map((t) => t.id);
  let allUnits: FireStrategyAid["allUnits"] = null;
  if (!recommended || overdue) {
    // Nothing holds the fire. The homes forecast cannot rank these (a line's effect on the fire is
    // only in the field once built), so: a protection line finished before the fire reaches it, with
    // no crown fire forecast there, in front of the most households not yet overrun; else the
    // perimeter option burning the fewest homes (flank and protect, which builds no holding line, last).
    const protectedHouseholds = (o: StrategyOption) =>
      o.protectsZoneIds.reduce((sum, id) => {
        const z = board.zones.find((x) => x.id === id);
        return sum + (z && z.overrunAt === null ? z.households : 0);
      }, 0);
    const lines = scored
      .filter((x) => x.option.kind === "line" && x.option.lineReadyBeforeFire === true && !x.option.safety.some((n) => n.startsWith("Crown fire")) && protectedHouseholds(x.option) > 0)
      .sort((a, b) => protectedHouseholds(b.option) - protectedHouseholds(a.option) || order(a, b));
    const pick = lines[0] ?? [...scored].sort((a, b) => Number(a.option.id === "flank") - Number(b.option.id === "flank") || order(a, b))[0];
    const free = nearestFree(board, fire);
    const positionId = pick.option.positionId;
    const rec = initialAttackRecommendation(board, fire);
    // Cumulative sized orders of the stages due so far (at least stage 1, since nothing contains),
    // less what was already ordered for this fire (any status but unable_to_fill).
    const stage = Math.max(1, Math.min(ESCALATION_ORDERS.length, board.response.fires.get(fire.id)?.stage ?? 0));
    const ordered = new Map<Orderable, number>();
    for (const o of board.response.orders) if (o.fireId === fire.id && o.status !== "unable_to_fill") ordered.set(o.resource, (ordered.get(o.resource) ?? 0) + 1);
    const due = (key: (typeof ORDER_KEYS)[number][1]) => ESCALATION_ORDERS.slice(0, stage).reduce((sum, st) => sum + st[key], 0);
    allUnits = {
      option: pick,
      send: free.map((r) => ({ crewId: r.team.id, positionId, etaMin: Math.round(r.eta) })),
      aircraft: (rec?.aircraft ?? []).map((a) => ({ aircraftId: a.aircraft.id, overFireMin: Math.round(a.overFireMin) })),
      orders: ORDER_KEYS.map(([resource, key]) => ({ resource, count: Math.min(MAX_ORDER_COUNT[resource], due(key) - (ordered.get(resource) ?? 0)) })).filter((o) => o.count > 0),
    };
  }
  return { fire, options: scored, recommended, recommendedSend, overdue, allUnits, idleUnits };
}
