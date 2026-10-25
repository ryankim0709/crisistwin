/**
 * Run state of the simulated command board, for MongoDB: per zone, how many households (and
 * persons, where known) are in each evacuation status right now. The /live controller's browser
 * PUTs it to `/api/live/incidents/<incident_id>/run-state` (useRunStateSync.ts; contract in
 * docs/command-demo-realism.md "Run state in the database"). Pure: reads the board, no React,
 * network or LLM. Every count is the board's own (model.ts departed / zoneCounts / zonePeople /
 * vehiclePersons, ORDER_COMPLIANCE): this module only sorts the households the model already
 * counts into statuses, so it needs no rounding of its own and conserves population exactly.
 * Simulated: every number here is a model result, not an observation.
 *
 * Status <- model field (W = households with a vehicle = model.withVehicle, D = model.departed,
 * L = the households the order will send out in the end, see orderLeavers):
 * - caught: zone.caught (home when fire reached the zone core; only while zone.overrunAt is set).
 *   An overrun zone has nobody else home: its carless households are among the caught.
 * - evacuating: zoneCounts.enRoute (departed, cohort arrival in zone.trips still ahead).
 * - safe: zoneCounts.out (cohort arrival at the route's destination at or before the minute),
 *   plus zoneCounts.returning: after a lift (order status "lifted", demo/allClear.ts) households
 *   driving back home stay "safe" (out of the zone, no new status key) until they are home again,
 *   so a lifted zone's households flow safe -> home.
 * - waiting: an order in effect (zone.orderedAt set): L - D, the compliers still in their
 *   exponential departure delay (realism.departedShare). A scheduled order (zone.pendingOrder):
 *   all W, since none has left and compliance only applies once the order is in effect.
 * - not_leaving: an order in effect: W - L, the households with a vehicle that do not comply
 *   (1 - ORDER_COMPLIANCE of W, as the model's floor-rounded departure curve leaves them).
 * - needs_transport: zone.noVehicle (carless households, always home: the board has no pickup;
 *   0 with model.EVERY_HOUSEHOLD_DRIVES, which gives the data's carless households one car each)
 *   in a zone with an order in effect or scheduled, or threatened (model.zoneThreatened on the
 *   commander's "reported" forecasts, as the /live outcomes use).
 * - home: households in a zone with no order in effect or scheduled (W, plus the carless ones
 *   when the zone is not threatened). A reopened zone (model.reopenZones) is all home again. A
 *   lifted zone: every household not away is home (no waiting / not_leaving / needs_transport:
 *   the order has ended), including those back home after the lift (zoneCounts.returnedHome).
 * - unknown: always 0 for households (the model tracks every household); kept so every status
 *   key is present.
 * Persons follow their households exactly as model.zonePeople apportions them: vehiclePersons(n)
 * is the persons of the first n households with a vehicle, so waiting = vp(L) - vp(D),
 * not_leaving = vp(W) - vp(L), and the carless persons are the rest of zonePeople.home. A zone
 * whose occupants are unknown (zone.occupants null) has people: null, never zeros.
 */

import type { LonLat } from "../live/types";
import { ORDER_COMPLIANCE } from "./realism";
import {
  departed,
  vehiclePersons,
  withVehicle,
  zoneCounts,
  zoneForecasts,
  zoneOrderStatus,
  zonePeople,
  zoneThreatened,
  type Board,
  type RouteOption,
  type ZoneForecast,
  type ZoneOrderStatus,
  type ZoneState,
} from "./model";

/** Every status a household or person can be in (the run-state contract's keys). */
export const RUN_STATUSES = ["home", "waiting", "evacuating", "safe", "needs_transport", "not_leaving", "caught", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Non-negative integer count per status; all keys present. */
export type StatusCounts = Record<RunStatus, number>;

export interface RunStateOrder {
  /**
   * "lifted": the order was lifted (lift_evacuation, demo/allClear.ts); start_minute is then the lift minute and destination_id / route are null.
   * "warning": be ready to leave (warn_evacuation, demo/evacWarning.ts); nobody leaves (households stay home); start_minute is the
   * warning minute, destination_id / route the route to be ready for.
   */
  status: ZoneOrderStatus;
  /** Board minute the order took effect (in effect / overrun), is scheduled to, was lifted (lifted) or warned (warning); null with none. */
  start_minute: number | null;
  destination_id: string | null;
  /**
   * The order's route (the board's route option: zone.route in effect / overrun, the scheduled
   * order's route), so the server can publish it as the zone's resident guidance
   * (app/backend/api/live/board_guidance.py); null with no order. Coordinates [lon, lat], rounded
   * to 5 decimals; eta_min free-flow minutes, distance_m metres.
   */
  route: RunStateRoute | null;
  /** Who gave the zone's latest evacuation order or cancellation on the board; null when unknown or none. */
  issued_by: "ai_agent" | "controller" | null;
}

export interface RunStateRoute {
  via: string[];
  eta_min: number;
  distance_m: number;
  safety: RouteOption["safety"];
  line: LonLat[];
}

export interface RunStateZone {
  zone_id: string;
  /** Sums to the zone's households. */
  households: StatusCounts;
  /** Sums to the zone's persons; null when they are unknown. */
  people: StatusCounts | null;
  order: RunStateOrder;
}

/** PUT /api/live/incidents/<incident_id>/run-state body. Simulated. */
export interface RunStatePayload {
  /** The board run (a new board, Reset board or a restart gives a new one; boardRunId). */
  run_id: string;
  /** Simulation minutes since T+0 the counts are for (fractional; the board clock). */
  board_minute: number;
  zones: RunStateZone[];
  totals: { households: StatusCounts; people: StatusCounts | null };
}

/**
 * What the page PUTs: the run state plus the run this page last saved for the incident (null on
 * its first save). A different run_id with previous_run_id = the stored one is this page's new
 * board (reset, restart, landscape change): the server replaces the run itself. Another page's
 * run_id is refused 409 `run_state_owned` while that page keeps saving (single-writer lease).
 */
export interface RunStatePutBody extends RunStatePayload {
  previous_run_id: string | null;
}

/** PUT answer. */
export interface RunStatePutResponse {
  run_id: string;
  board_minute: number;
  households_written: number;
  households_changed: number;
  snapshot: unknown;
  /** Resident guidance versions this save published from the board's orders (board_guidance.py); null when that failed. */
  guidance_published?: number | null;
}

export function emptyCounts(): StatusCounts {
  return { home: 0, waiting: 0, evacuating: 0, safe: 0, needs_transport: 0, not_leaving: 0, caught: 0, unknown: 0 };
}

const runIds = new WeakMap<Board, string>();

/**
 * The run id of a board object: fixed for its life, new for every board built (useCommandBoard
 * builds a new Board on first load, Reset board, restart and a landscape change, each starting
 * with every household home). Not part of the simulation (seeded draws are untouched).
 */
export function boardRunId(board: Board): string {
  let id = runIds.get(board);
  if (!id) {
    const random =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : Math.floor(Math.random() * 2 ** 32).toString(16);
    id = `board-${board.seed.toString(36)}-${random}`;
    runIds.set(board, id);
  }
  return id;
}

/**
 * Households with a vehicle the order in effect sends out in the end: the limit of
 * departed() = floor(W x ORDER_COMPLIANCE x share) as share -> 1 (share < 1 always), i.e.
 * ceil(x) - 1 for x = W x ORDER_COMPLIANCE > 0. Never below what has already departed
 * (guards float rounding of the curve after very long runs).
 */
function orderLeavers(zone: ZoneState, departedNow: number): number {
  const x = withVehicle(zone) * ORDER_COMPLIANCE;
  return Math.max(departedNow, x > 0 ? Math.ceil(x) - 1 : 0);
}

/** Board event actions that set or cancel a zone's evacuation order (their actor is who ordered it). */
const ORDER_ACTIONS = new Set([
  "evacuation_ordered",
  "evacuation_redirected",
  "evacuation_scheduled",
  "evacuation_rescheduled",
  "evacuation_cancelled",
  "evacuation_lifted",
  "evacuation_warned",
  "evacuation_warning_withdrawn",
]);

/** Zone id -> who gave its latest evacuation order (board.events is newest first and capped, so it may be missing). */
function orderIssuers(board: Board): Map<string, "ai_agent" | "controller"> {
  const out = new Map<string, "ai_agent" | "controller">();
  for (const e of board.events) {
    const zoneId = e.refs?.zoneId;
    if (!zoneId || out.has(zoneId) || !ORDER_ACTIONS.has(e.refs!.action)) continue;
    if (e.actor === "agent") out.set(zoneId, "ai_agent");
    else if (e.actor === "you") out.set(zoneId, "controller");
  }
  return out;
}

function routeSummary(route: RouteOption | null): RunStateRoute | null {
  if (!route || route.line.length < 2) return null;
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  return {
    via: route.via,
    eta_min: route.eta_min,
    distance_m: route.distance_m,
    safety: route.safety,
    line: route.line.map((p) => [r5(p[0]), r5(p[1])] as LonLat),
  };
}

function zoneRunState(zone: ZoneState, minute: number, threatened: boolean, issuedBy: RunStateOrder["issued_by"] = null): RunStateZone {
  const status = zoneOrderStatus(zone, minute);
  const c = zoneCounts(zone, minute);
  const p = zonePeople(zone, minute);
  const h = emptyCounts();
  const persons = p.total === null ? null : emptyCounts();
  h.evacuating = c.enRoute;
  // Driving back after a lift counts as safe until home (see the module comment).
  h.safe = c.out + c.returning;
  if (persons) {
    persons.evacuating = p.enRoute!;
    persons.safe = p.out! + p.returning!;
  }
  if (zone.overrunAt !== null) {
    // Departures froze at the overrun: everyone not departed then is caught (home = 0, unless
    // households came back after a lift before a later overrun: zoneCounts.returnedHome).
    h.caught = c.caught;
    h.home = c.home;
    if (persons) {
      persons.caught = p.caught!;
      persons.home = p.home!;
    }
  } else if (status === "lifted") {
    // The order has ended: everyone not away is home (zoneCounts.home, which includes returnedHome).
    h.home = c.home;
    if (persons) persons.home = p.home!;
  } else {
    const W = withVehicle(zone);
    const D = departed(zone, minute);
    const vp = (n: number) => vehiclePersons(zone, n);
    const ordered = zone.orderedAt !== null;
    const scheduled = !ordered && zone.pendingOrder !== null;
    // Vehicle households not departed: waiting / not_leaving / home.
    if (ordered) {
      const L = orderLeavers(zone, D);
      h.waiting = L - D;
      h.not_leaving = W - L;
      if (persons) {
        persons.waiting = vp(L) - vp(D);
        persons.not_leaving = vp(W) - vp(L);
      }
    } else if (scheduled) {
      h.waiting = W - D;
      if (persons) persons.waiting = vp(W) - vp(D);
    } else {
      h.home = W - D;
      if (persons) persons.home = vp(W) - vp(D);
    }
    // Carless households (and their persons: the rest of zonePeople.home) never leave.
    const carlessKey: RunStatus = ordered || scheduled || threatened ? "needs_transport" : "home";
    h[carlessKey] += c.noVehicleHome;
    if (persons) persons[carlessKey] += p.home! - (vp(W) - vp(D));
  }
  const lifted = status === "lifted" ? zone.lift : null;
  // A warning (demo/evacWarning.ts) sends the route residents are to be ready for; start_minute is when it was issued.
  const warning = status === "warning" ? zone.warning : null;
  const route = lifted
    ? null
    : zone.orderedAt !== null || zone.overrunAt !== null
      ? zone.route
      : (zone.pendingOrder?.route ?? warning?.route ?? null);
  const actorOf = (a: "agent" | "you") => (a === "agent" ? "ai_agent" : "controller");
  return {
    zone_id: zone.id,
    households: h,
    people: persons,
    order: {
      status,
      start_minute: lifted ? lifted.at : (zone.pendingOrder?.startMinute ?? zone.orderedAt ?? warning?.at ?? null),
      destination_id: route?.destination_id ?? null,
      route: routeSummary(route),
      issued_by: lifted ? actorOf(lifted.actor) : zone.pendingOrder ? actorOf(zone.pendingOrder.actor) : warning ? actorOf(warning.actor) : issuedBy,
    },
  };
}

/**
 * The board's run state now. `forecasts` are the commander's zone forecasts
 * (zoneForecasts(board, "reported"), useCommandBoard's `forecasts`); computed when omitted.
 */
export function boardRunState(
  board: Board,
  options: { runId?: string; forecasts?: Map<string, ZoneForecast> } = {},
): RunStatePayload {
  const forecasts = options.forecasts ?? zoneForecasts(board, "reported");
  const issuers = orderIssuers(board);
  const zones = board.zones.map((z) => zoneRunState(z, board.minute, zoneThreatened(z, forecasts), issuers.get(z.id) ?? null));
  const households = emptyCounts();
  let people: StatusCounts | null = emptyCounts();
  for (const z of zones) {
    for (const k of RUN_STATUSES) households[k] += z.households[k];
    if (people && z.people) for (const k of RUN_STATUSES) people[k] += z.people[k];
    else people = null;
  }
  return { run_id: options.runId ?? boardRunId(board), board_minute: board.minute, zones, totals: { households, people } };
}

const sum = (c: StatusCounts) => RUN_STATUSES.reduce((a, k) => a + c[k], 0);
const badCounts = (c: StatusCounts) => RUN_STATUSES.filter((k) => !Number.isInteger(c[k]) || c[k] < 0);

/**
 * What must hold of a run state built from `board` at the same minute ([] = all good):
 * per zone, household statuses are non-negative integers summing to zone.households, with
 * evacuating / safe / caught equal to the model's zoneCounts (safe = out + returning) and
 * evacuating + safe = departed - returnedHome (households back home after a lift);
 * persons are null exactly when zone.occupants is, and otherwise sum to it and match zonePeople;
 * totals are the zone sums (persons null when any zone's are).
 */
export function checkRunState(payload: RunStatePayload, board: Board): string[] {
  const problems: string[] = [];
  const byId = new Map(board.zones.map((z) => [z.id, z]));
  if (payload.zones.length !== board.zones.length) problems.push(`${payload.zones.length} zones for ${board.zones.length} on the board`);
  const households = emptyCounts();
  let people: StatusCounts | null = emptyCounts();
  for (const z of payload.zones) {
    const zone = byId.get(z.zone_id);
    if (!zone) {
      problems.push(`${z.zone_id}: not a board zone`);
      continue;
    }
    const c = zoneCounts(zone, payload.board_minute);
    const p = zonePeople(zone, payload.board_minute);
    const bad = badCounts(z.households);
    if (bad.length) problems.push(`${z.zone_id}: household ${bad.join(", ")} not a non-negative integer`);
    if (sum(z.households) !== zone.households) problems.push(`${z.zone_id}: household statuses sum to ${sum(z.households)}, not ${zone.households}`);
    if (z.households.evacuating !== c.enRoute || z.households.safe !== c.out + c.returning || z.households.caught !== c.caught) {
      problems.push(`${z.zone_id}: evacuating/safe/caught ${z.households.evacuating}/${z.households.safe}/${z.households.caught} != model ${c.enRoute}/${c.out + c.returning}/${c.caught}`);
    }
    if (z.households.unknown !== 0) problems.push(`${z.zone_id}: ${z.households.unknown} households unknown`);
    if (z.households.evacuating + z.households.safe !== departed(zone, payload.board_minute) - c.returnedHome) problems.push(`${z.zone_id}: evacuating + safe != departed - returned home`);
    if ((z.people === null) !== (zone.occupants === null)) problems.push(`${z.zone_id}: persons ${z.people === null ? "null" : "set"} but occupants ${zone.occupants}`);
    if (z.people && zone.occupants !== null) {
      const badP = badCounts(z.people);
      if (badP.length) problems.push(`${z.zone_id}: person ${badP.join(", ")} not a non-negative integer`);
      if (sum(z.people) !== zone.occupants) problems.push(`${z.zone_id}: person statuses sum to ${sum(z.people)}, not ${zone.occupants}`);
      if (z.people.evacuating !== p.enRoute || z.people.safe !== p.out! + p.returning! || z.people.caught !== p.caught) problems.push(`${z.zone_id}: persons evacuating/safe/caught != zonePeople`);
    }
    for (const k of RUN_STATUSES) households[k] += z.households[k];
    if (people && z.people) for (const k of RUN_STATUSES) people[k] += z.people[k];
    else people = null;
  }
  for (const k of RUN_STATUSES) if (payload.totals.households[k] !== households[k]) problems.push(`totals: households ${k} ${payload.totals.households[k]} != ${households[k]}`);
  if ((payload.totals.people === null) !== (people === null)) problems.push("totals: persons null mismatch");
  else if (people && payload.totals.people) {
    for (const k of RUN_STATUSES) if (payload.totals.people[k] !== people[k]) problems.push(`totals: persons ${k} ${payload.totals.people[k]} != ${people[k]}`);
  }
  return problems;
}

const isDev = (() => {
  try {
    return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
})();

/**
 * Throws when the run state breaks an invariant (checkRunState): always when `force`, else in
 * Vite dev builds only. The sync hook catches it and does not save a broken state.
 */
export function assertRunState(payload: RunStatePayload, board: Board, force = false): void {
  if (!isDev && !force) return;
  const problems = checkRunState(payload, board);
  if (problems.length) throw new Error(`Run state invariant broken at minute ${payload.board_minute.toFixed(2)}: ${problems.join("; ")}`);
}
