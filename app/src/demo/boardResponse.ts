/**
 * The /live command board's rule-based fire response: the shared response model
 * (app/src/response/) applied to the board (demo/model.ts). Pure: no React, network or LLM;
 * every draw comes from the board's seeded response stream. See docs/response-model.md.
 *
 * The /live board is AI agent only (docs/response-model.md "Decisions and mechanics"): the
 * response DECIDES nothing on its own. autoDispatch and autoEscalate are false (createResponseState;
 * useCommandBoard.ts also forces them off), so no run card, aircraft, resource order, extended
 * attack or station move-up happens unless the AI commander (or the drill controller) orders it
 * through model.ts applyOrder. The run card is still computed, as a recommendation for the
 * commander (initialAttackRecommendation, observation recommended_initial_attack). With the
 * flags on (scripts only) the former rule-based response runs as described below.
 *
 * What it does each board step (model.ts stepOnce calls in this order):
 * - respondToNewFire (from ignite): the fire's record and its seeded report delay. At the report
 *   (dispatchOnReport), only with autoDispatch: the run card for the fire's dispatch level, filled
 *   by the closest units by expected arrival (turnout + road time x congestion), within each
 *   department's drawdown; a shortfall is ordered as immediate-need mutual aid (with autoEscalate).
 * - responseTick (mechanics): unit lifecycle (returning, refilling, resting, out of service),
 *   work/rest and water, fire-cut roads, aircraft cycles, and placed orders reaching the board;
 *   move-up and cover only with autoDispatch.
 * - advanceContainment (mechanics): line per tactic, the seeded holding test. The tactic is the
 *   commander's (set_strategy, demo/strategyOptions.ts commanderTactic); only with autoDispatch
 *   (scripts) does the board pick it by flame length (reviewTactic, chooseTactic).
 * - escalate: initial-attack failure (the IA record) and, only with autoEscalate, the
 *   extended-attack orders; without it the due stage is logged for the commander.
 *
 * Report rule (docs/response-model.md "From ignition to dispatch"): a fire is known to dispatch
 * from FireResponse.reportAt on: ignition + the Simulation Studio user's report time when set
 * (fire.studio.reportAfterMin), else + the seeded modelled delay (response/report.ts). Nothing
 * acts on a fire before then: no run card, aircraft, escalation, resource order, send_crew or
 * attack position (model.ts dispatch / applyOrder / closeFire refuse with unreportedRefusal),
 * and the commander's observation and panels leave it out. Its physics still runs.
 *
 * Coupling: this module imports model.ts functions and model.ts imports this module; neither
 * uses the other at module load (only inside functions), so the cycle is safe.
 */

import { DEVELOPED_FUEL_CODE, cellAt } from "../fire/spread";
import {
  PERSONS_PER_HOUSEHOLD,
  SQ_M_PER_SQ_MI,
  SUBURBAN_MIN_PEOPLE_PER_SQ_MI,
  lineOfSight,
  nearestDeveloped,
  reportDelay,
  type ReportDelay,
} from "../response/report";
import { engineCrewHandLineMPerMin, formatDuration, planWork, type WorkMode, type WorkPlan } from "../response/reach";
import { countAtMost } from "./fireField";
import type { LonLat } from "../live/types";
import { commanderTactic, type ChosenStrategy } from "./strategyOptions";
import { DROP_HOLDS_FLAME_FEET, nearestWaterKm } from "../studio/aircraft";
import { DEFAULT_START_LOCAL_ISO } from "../studio/firefighting";
import {
  BREACH_LINE_LOSS_SHARE,
  BREACH_RETRY_MINUTES,
  INDIRECT_LEAD_MINUTES,
  buildsOn,
  chooseTactic,
  holdingTest,
  lineNeededMeters,
  tacticHoldsFeet,
  tacticRateFactor,
  TACTIC_LABEL,
  type Tactic,
} from "../response/containment";
import { OWN_AREA_RADIUS_M, type AirResponseKind, type Department, type FacilityContribution, type GroundResponseKind, type Tier, type UnitSeed, type AircraftSeed } from "../response/fleet";
import {
  MUTUAL_AID_ASSEMBLY_MINUTES,
  STATE_AIR_DISTANCE_KM,
  STATE_MAX_AIRCRAFT,
  STATE_MAX_GROUND_UNITS,
  UNABLE_TO_FILL_RETRY_MINUTES,
  fills,
  stateGroundLeadMinutes,
  variedLead,
} from "../response/orders";
import { chance, deriveStream, uniform, type RngStream } from "../response/rng";
import {
  CREWS_PER_STRIKE_TEAM,
  DOZERS_PER_STRIKE_TEAM,
  ENGINES_PER_STRIKE_TEAM,
  ESCALATION_ORDERS,
  ESCALATION_STAGE_ACRES,
  HECTARES_PER_ACRE,
  IA_SUCCESS_MAX_HA,
  IMMEDIATE_NEED_CAPS,
  dispatchLevel,
  groundFamilyOf,
  runCard,
  type DispatchLevel,
  type Orderable,
  type ResourceCounts,
} from "../response/runCards";
import {
  buildFlowIndex,
  congestionOnLeg,
  routeCutAt,
  type FlowIndex,
} from "../response/travel";
import {
  AVAILABILITY_DRAW_EVERY_MINUTES,
  ENGINE_REFILL_MINUTES,
  ENGINE_WATER_USE_GPM,
  KNOTS_PER_METER_PER_SECOND,
  MAX_SHIFT_MINUTES,
  MOPUP_KEEP,
  MOVE_UP_CHECK_EVERY_MINUTES,
  MOVE_UP_EMPTY_MINUTES,
  OUT_OF_SERVICE_MINUTES,
  OUT_OF_SERVICE_PROBABILITY,
  TANK_GALLONS,
  dropCycleMinutes,
  dropLineMeters,
  firstOverFireMinutes,
  mayFly,
  restMinutesAfter,
} from "../response/units";
import {
  activeRoute,
  boardActivity,
  boardMoistureClass,
  boardWind,
  cellLonLat,
  crewTarget,
  dispatch,
  distanceM,
  driveHome,
  fallbackDriveMinutes,
  fireDest,
  legStatus,
  logEvent,
  MAX_FIRE_CUT_REROUTES,
  perimeterIn,
  rerouteTeam,
  startRoadTrip,
  travelMinutesTo,
  unitLineOn,
  zoneAt,
  toLocal,
  type Board,
  type BoardEvent,
  type Fire,
  type Station,
  type Team,
} from "./model";
import { KIND_PREFIX, holdsFlameFeet } from "./realism";
import { simClock } from "./format";

// ---- state ----

export interface FireResponse {
  level: DispatchLevel;
  structure: boolean;
  dispatchedAt: number;
  /** First ground unit on scene, and first engine, board minutes. */
  firstArrivalAt: number | null;
  firstEngineAt: number | null;
  tactic: Tactic;
  tacticAt: number;
  /** Indirect line plan: the perimeter the line is built on and when the fire reaches it. */
  target: { minute: number; perimeterM: number } | null;
  retryAt: number;
  breaches: number;
  /** Escalation stages ordered (0 = initial attack only). */
  stage: number;
  ia: "in_progress" | "contained" | "failed";
  /** Cal OES OB#1 immediate need used for this incident (one time per incident). */
  immediateNeedUsed: boolean;
  airLineM: number;
  dipKm: number | null;
  /** Area when the response first knew it, ha (for the record). */
  containedHa: number | null;
  /**
   * Board minute the dispatch centre has the fire: ignition + the Studio-set report time
   * (report.by "studio") or + the modelled report delay (response/report.ts). Nothing acts on the
   * fire before it (see the report rule above).
   */
  reportAt: number;
  report: ReportDelay;
  /** Whether the run card has gone out (at reportAt). */
  dispatched: boolean;
  /** Line built by ground units, metres (capped at the reachable share of what is needed). */
  groundLineM: number;
  /** Fire edge sample (at whole REACH_EVERY_MINUTES minutes) and the share of it within reach of the units working it (for unitsKey). */
  reach: { minute: number; edge: LonLat[]; fraction: number | null; unitsKey?: string } | null;
  /** The commander's containment strategy (set_strategy, demo/strategyOptions.ts); absent / null = none chosen yet. */
  strategy?: ChosenStrategy | null;
}

/** How often the fire-edge sample and the reachable share are refreshed, minutes. */
const REACH_EVERY_MINUTES = 5;
/** Most edge points sampled per fire (bounded work). */
const MAX_EDGE_POINTS = 400;

export type AircraftStatus = "available" | "en_route" | "over_fire" | "returning" | "grounded";
export interface Aircraft {
  id: string;
  kind: AirResponseKind;
  baseName: string;
  base: LonLat;
  /** Straight-line km from base to its fire (the cycle distance); STATE_AIR_DISTANCE_KM for state aircraft. */
  baseKm: number;
  status: AircraftStatus;
  fireId: string | null;
  overFireAt: number | null;
  nextDropAt: number | null;
  returnAt: number | null;
  drops: number;
  tier: Tier;
}

export type OrderStatus = "pending" | "unable_to_fill" | "arrived" | "cancelled";
export interface PendingOrder {
  id: string;
  fireId: string;
  resource: Orderable;
  tier: "mutual_aid" | "state";
  placedAt: number;
  readyAt: number;
  status: OrderStatus;
  /** Ground units it brings (mutual aid: real off-board stations; state: from the board edge). */
  seeds: UnitSeed[];
  air: AirResponseKind | null;
  by: BoardEvent["actor"];
}

export interface ResponseStats {
  fires: number;
  iaContained: number;
  iaFailed: number;
  breaches: number;
  ordersPlaced: number;
  ordersUnableToFill: number;
  moveUps: number;
  routeCuts: number;
  firstArrivalMinutes: number[];
}

export interface ResponseState {
  rng: RngStream;
  /**
   * Rule-based dispatch decisions: the run card at each fire's report (units and aircraft) and
   * station move-up and cover. False on the /live board (AI agent only; RULE_RESPONSE_DEFAULT).
   */
  autoDispatch: boolean;
  /** Rule-based ordering: run-card shortfall orders and extended-attack orders when initial attack fails. False on /live. */
  autoEscalate: boolean;
  departments: Department[];
  /** Off-board units not yet ordered (mutual-aid pool). */
  pool: UnitSeed[];
  offBoardStations: Map<string, Station>;
  aircraft: Aircraft[];
  /** Aircraft at off-board bases (mutual-aid air), not yet ordered. */
  airPool: AircraftSeed[];
  orders: PendingOrder[];
  fires: Map<string, FireResponse>;
  stats: ResponseStats;
  counters: Record<string, number>;
  nextAvailabilityDraw: number;
  nextMoveUpCheck: number;
  stationEmptySince: Map<string, number>;
  flows: { minute: number; index: FlowIndex | null } | null;
  /** UTC epoch ms of board minute 0 (the wind series' start, else DEFAULT_START_LOCAL_ISO). */
  startEpochMs: number;
  label: string;
  /** Every facility that fields a unit (on the board, mutual aid, air bases in range), for the map. */
  facilities: FacilityContribution[];
}

/**
 * Board rule (not sourced; the user's requirement for /live): the response makes no decision on
 * its own. Every dispatch, order, release and move-up comes from model.ts applyOrder (the AI
 * commander or the drill controller); the simulator runs only the mechanics.
 */
export const RULE_RESPONSE_DEFAULT = false;

const MAX_TEAMS = 160;
const MAX_ORDERS_KEPT = 60;
const TACTIC_REVIEW_MINUTES = 10;
const HOME_M = 60;

export function createResponseState(
  seed: number,
  departments: Department[],
  pool: UnitSeed[],
  offBoardStations: Station[],
  aircraftSeeds: AircraftSeed[],
  onBoard: (p: LonLat) => boolean,
  startUtc: string | null,
  label: string,
): ResponseState {
  const parsed = startUtc ? Date.parse(startUtc) : NaN;
  const counters: Record<string, number> = {};
  const aircraft: Aircraft[] = [];
  const airPool: AircraftSeed[] = [];
  // Aircraft at bases within flight range all answer initial attack (aircraft are dispatched
  // statewide by closest resource); none are "off the board" for flying. airPool stays for
  // ordered aircraft beyond the bases list (state tier).
  for (const a of aircraftSeeds) {
    const prefix = a.kind === "air_attack" ? "AA" : a.kind === "helicopter_t2" ? "H" : "T";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    aircraft.push({
      id: `${prefix}${counters[prefix]}`,
      kind: a.kind,
      baseName: a.baseName,
      base: a.location,
      baseKm: 0,
      status: "available",
      fireId: null,
      overFireAt: null,
      nextDropAt: null,
      returnAt: null,
      drops: 0,
      tier: onBoard(a.location) ? "closest" : "mutual_aid",
    });
  }
  return {
    rng: deriveStream(seed, "response"),
    autoDispatch: RULE_RESPONSE_DEFAULT,
    autoEscalate: RULE_RESPONSE_DEFAULT,
    departments,
    pool,
    offBoardStations: new Map(offBoardStations.map((s) => [s.id, s])),
    aircraft,
    airPool,
    orders: [],
    fires: new Map(),
    stats: { fires: 0, iaContained: 0, iaFailed: 0, breaches: 0, ordersPlaced: 0, ordersUnableToFill: 0, moveUps: 0, routeCuts: 0, firstArrivalMinutes: [] },
    counters,
    nextAvailabilityDraw: 0,
    nextMoveUpCheck: MOVE_UP_CHECK_EVERY_MINUTES,
    stationEmptySince: new Map(),
    flows: null,
    startEpochMs: Number.isFinite(parsed) ? parsed : Date.parse(DEFAULT_START_LOCAL_ISO),
    label,
    facilities: [],
  };
}

export function fireResponse(board: Board, fire: Fire): FireResponse | null {
  return board.response.fires.get(fire.id) ?? null;
}

// ---- helpers ----

const isEngine = (k: GroundResponseKind) => k === "engine_t3" || k === "engine_t1";
const DISPATCHABLE = new Set(["available", "returning", "moving_up"]);

export function dispatchable(team: Team): boolean {
  return DISPATCHABLE.has(team.status);
}

function nextId(board: Board, prefix: string): string {
  const c = board.response.counters;
  if (c[prefix] === undefined) {
    // Continue after the ids already on the board.
    let max = 0;
    for (const t of board.teams) if (t.id.startsWith(prefix)) max = Math.max(max, Number(t.id.slice(prefix.length)) || 0);
    c[prefix] = max;
  }
  c[prefix] += 1;
  return `${prefix}${c[prefix]}`;
}

/**
 * Outbound evacuation flows on the board's routes now, indexed for congestion lookups (cached per
 * minute). One traffic state with the evacuees: each leaving zone's departure flow, veh/h, from
 * the board's evacuation traffic step (model.ts evacuationTrafficStep, board.traffic.zoneFlow:
 * the departure curve x the snapshot's vehicles per household), on its current route line.
 */
export function flowIndex(board: Board): FlowIndex | null {
  const minute = Math.floor(board.minute);
  const cached = board.response.flows;
  if (cached && cached.minute === minute) return cached.index;
  const flows = [];
  for (const zone of board.zones) {
    const route = activeRoute(zone);
    const vehiclesPerHour = board.traffic.zoneFlow.get(zone.id) ?? 0;
    if (!route || route.line.length < 2 || vehiclesPerHour <= 0) continue;
    flows.push({ line: route.line, vehiclesPerHour });
  }
  const lat0 = board.zones[0]?.core[1] ?? 0;
  const index = flows.length > 0 ? buildFlowIndex(flows, lat0) : null;
  board.response.flows = { minute, index };
  return index;
}

/**
 * Expected minutes to on scene (no seeded variation): turnout (from rest only) + the road leg (or
 * the straight-line estimate while it is not known) x congestion (model.ts travelMinutesTo).
 */
export function expectedArrival(board: Board, team: Team, fire: Fire): number {
  if (team.fireId === fire.id) {
    return team.status === "on_scene" || team.status === "refilling" ? 0 : Math.max(0, (team.arriveAt ?? board.minute) - board.minute);
  }
  return travelMinutesTo(board, team, fire.id, crewTarget(fire));
}

/** Whether the unit's department lets it go (drawdown), unless the fire is in the department's own area. */
function departmentAllows(board: Board, team: Team, fire: Fire): boolean {
  if (!isEngine(team.kind)) return true;
  const dept = board.response.departments.find((d) => d.id === team.department);
  if (!dept || dept.keepEngines <= 0) return true;
  const own = dept.stationIds.some((id) => {
    const s = board.stations.find((st) => st.id === id);
    return s ? distanceM(s.location, fire.origin) <= OWN_AREA_RADIUS_M : false;
  });
  if (own) return true;
  return freeEngines(board, dept.id) - 1 >= dept.keepEngines;
}

/** A department's uncommitted engines: free on the board plus still in the off-board pool. */
function freeEngines(board: Board, departmentId: string): number {
  return (
    board.teams.filter((t) => t.department === departmentId && isEngine(t.kind) && t.status === "available").length +
    board.response.pool.filter((s) => s.departmentId === departmentId && isEngine(s.kind)).length
  );
}

/** Drawdown for a unit still in the off-board pool: its department lends it only while it keeps its reserve. */
function poolAllows(board: Board, seed: UnitSeed): boolean {
  if (!isEngine(seed.kind)) return true;
  const dept = board.response.departments.find((d) => d.id === seed.departmentId);
  if (!dept || dept.keepEngines <= 0) return true;
  return freeEngines(board, dept.id) - 1 >= dept.keepEngines;
}

/**
 * Sends `team` to `fire` for direct attack (the run card, orders and send_crew all use this):
 * model.ts dispatch, which times it as turnout (from rest) + road leg x congestion x a seeded
 * variation and moves it only along its road line (waiting for the leg when not known yet).
 * Returns null, or why it cannot go.
 */
export function dispatchTeam(board: Board, team: Team, fire: Fire, actor: BoardEvent["actor"], why = ""): string | null {
  return dispatch(board, team, fire, fireDest(fire), actor, why);
}

/**
 * Sends a unit home (or to the station it covers, or its demobilisation point) on a road leg
 * (model.ts driveHome); it can be redispatched while returning.
 */
export function sendHome(board: Board, team: Team): void {
  const cover = team.coverStation ? board.stations.find((s) => s.id === team.coverStation) : undefined;
  driveHome(board, team, cover?.location ?? team.home, cover?.id ?? team.station);
}

/** At its station: rest owed (work/rest 2:1), else available. */
export function arriveHome(board: Board, team: Team): void {
  const stationId = team.coverStation ?? team.station;
  const station = board.stations.find((s) => s.id === stationId);
  logEvent(
    board,
    "team",
    "board",
    team.coverStation ? `${team.id} in position covering ${station?.name ?? stationId}.` : `${team.id} back at ${station?.name ?? stationId}.`,
    { action: team.coverStation ? "covering_station" : "back_at_station", teamIds: [team.id], stationId },
  );
  team.position = team.target ?? team.home;
  team.target = null;
  team.departAt = team.arriveAt = team.rollAt = null;
  if (team.restOwed > 0) {
    team.status = "resting";
    team.restUntil = board.minute + team.restOwed;
    team.restOwed = 0;
    team.workMinutes = 0;
    return;
  }
  team.status = "available";
}

// ---- initial attack ----

/** The run card for a new fire, filled by the closest units (and aircraft); a shortfall goes to mutual aid. */
export function respondToNewFire(board: Board, fire: Fire): void {
  const r = board.response;
  const ground = board.env.spread.ground;
  const structure = ground.fuelCodeAt(fire.origin) === DEVELOPED_FUEL_CODE;
  // Fire danger from the Studio run's fuel moisture (its Scott & Burgan class) and wind.
  const level = dispatchLevel(boardMoistureClass(board), boardWind(board).speedMetersPerSecond);
  r.fires.set(fire.id, {
    level,
    structure,
    dispatchedAt: board.minute,
    firstArrivalAt: null,
    firstEngineAt: null,
    tactic: structure ? "structure" : "direct",
    tacticAt: -Infinity,
    target: null,
    retryAt: -Infinity,
    breaches: 0,
    stage: 0,
    ia: "in_progress",
    immediateNeedUsed: false,
    airLineM: 0,
    dipKm: null,
    containedHa: null,
    ...reportFor(board, fire, structure),
    dispatched: false,
    groundLineM: 0,
    reach: null,
  });
}

/** The seeded delay from ignition to dispatch for a new fire (response/report.ts). */
/** ASSUMPTION: households within this distance (in sight of the smoke) could see the fire; reported only. */
const VIEW_RADIUS_M = 3000;

/** Metres from `p` to the nearest point of a polyline. */
function toPolylineM(p: LonLat, line: readonly LonLat[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const [ax, ay] = toLocal(p, line[i - 1]);
    const [bx, by] = toLocal(p, line[i]);
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
  }
  return best;
}

/**
 * The seeded delay from ignition to dispatch for a new fire (response/report.ts), from how
 * remote its origin is: the nearest occupied home (a developed cell of the landscape, or a
 * zone dense enough to be suburban that contains it), whether terrain hides the fire from it,
 * the nearest known road (the board's evacuation route lines: drill roads, a partial network),
 * and the time of day.
 */
function reportFor(board: Board, fire: Fire, structure: boolean): { reportAt: number; report: ReportDelay } {
  const grid = board.env.landscape;
  const zone = zoneAt(board, fire.origin);
  let denseZone = false;
  if (zone) {
    // Shoelace area of the zone ring in local metres.
    const pts = zone.ring.map((p) => toLocal(zone.core, p));
    let twice = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) twice += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    const sqMi = Math.abs(twice) / 2 / SQ_M_PER_SQ_MI;
    denseZone = sqMi > 0 && (zone.households * PERSONS_PER_HOUSEHOLD) / sqMi >= SUBURBAN_MIN_PEOPLE_PER_SQ_MI;
  }
  const home = denseZone ? { meters: 0, at: fire.origin } : nearestDeveloped(grid, fire.origin);
  const homeInSight = home ? lineOfSight(grid, fire.origin, home.at) : true;
  let road = Infinity;
  for (const options of board.routes.values()) for (const o of options) if (o.line.length > 1) road = Math.min(road, toPolylineM(fire.origin, o.line));
  let householdsInView = 0;
  for (const z of board.zones) {
    if (z.households > 0 && distanceM(z.core, fire.origin) <= VIEW_RADIUS_M && lineOfSight(grid, fire.origin, z.core)) householdsInView += z.households;
  }
  const modelled = reportDelay(board.response.rng, {
    ignitionEpochMs: board.response.startEpochMs + fire.ignitedAt * 60_000,
    location: fire.origin,
    nearestHomeM: home?.meters ?? null,
    homeInSight,
    nearestRoadM: Number.isFinite(road) ? road : null,
    householdsInView,
    developed: structure,
    wildland: !structure,
    // Studio ignitions are not reported at ignition; a field report that joins the fire reports it then (model.ts joinFieldReport).
    alreadyReported: false,
  });
  // The modelled delay is drawn even when Studio set the report time, so the seeded stream (and
  // with it every later draw) is the same whether or not a report time is set.
  const set = fire.studio.reportAfterMin;
  if (set === null) return { reportAt: fire.ignitedAt + modelled.totalMinutes, report: modelled };
  // Studio-set: a scenario assumption, not modelled; the whole delay is the set time.
  const report: ReportDelay = {
    ...modelled,
    by: "studio",
    totalMinutes: set,
    callMinutes: set,
    answerMinutes: 0,
    transferMinutes: 0,
    processingMinutes: 0,
    reason: `report time set in Simulation Studio (${fire.studio.tag}, ${set} min after ignition), not modelled`,
  };
  return { reportAt: fire.ignitedAt + set, report };
}

/** Whether the fire's report time was set in Simulation Studio (it then wins over field reports). */
export function reportSetInStudio(board: Board, fire: Fire): boolean {
  return board.response.fires.get(fire.id)?.report.by === "studio";
}

/** "911 call", "AI camera alert", "satellite detection", "field report" or "report time set in Simulation Studio". */
export const REPORT_BY_LABEL: Record<ReportDelay["by"], string> = {
  "911": "911 call",
  camera: "AI camera alert",
  satellite: "satellite detection",
  field_report: "field report",
  studio: "report time set in Simulation Studio",
};

/**
 * Why nobody can act on `fire` yet, or null once it is reported (the report rule above). The AI
 * commander never sees an unreported fire, so it is told no reported fire has that id; a person
 * (the drill controller, who sees it on the map labelled "not yet reported") is told when it reports.
 */
export function unreportedRefusal(board: Board, fire: Fire, actor: BoardEvent["actor"]): string | null {
  const fr = board.response.fires.get(fire.id);
  if (!fr || board.minute >= fr.reportAt) return null;
  if (actor === "agent") return `Unknown fire ${fire.id}: no reported fire has that id.`;
  const when = `${simClock(fr.reportAt)}${fr.report.by === "studio" ? ", set in Simulation Studio" : ", modelled report delay"}`;
  return `${fire.id} has not been reported to dispatch yet (reported at ${when}); no unit can act on it before then.`;
}

/** Whether the dispatch centre knows about the fire (the commander sees only reported fires). */
export function isReported(board: Board, fire: Fire): boolean {
  const fr = board.response.fires.get(fire.id);
  return !fr || board.minute >= fr.reportAt;
}

/** At the report: log it and send the run card. */
function dispatchOnReport(board: Board, fire: Fire, fr: FireResponse): void {
  const r = board.response;
  fr.dispatched = true;
  fr.dispatchedAt = board.minute;
  // Counted at the report, so the initial-attack record (observation response.initial_attack) holds known fires only.
  r.stats.fires += 1;
  const after = Math.round(board.minute - fire.ignitedAt);
  const text =
    fr.report.by === "studio"
      ? `${fire.id} reported to dispatch at ${simClock(board.minute)}, ${after} min after it started (report time set in Simulation Studio).`
      : `${fire.id} reported by ${REPORT_BY_LABEL[fr.report.by]}, ${after} min after it started${fr.report.night ? " (night)" : ""}: ${fr.report.reason}.`;
  const decide = r.autoDispatch ? "" : " No automatic dispatch: units go only when the AI agent (or you) orders them.";
  logEvent(board, "ignition", "board", text + decide, {
    action: "fire_reported",
    fireId: fire.id,
    reportedBy: fr.report.by,
    reportAfterMin: after,
  });
  if (!r.autoDispatch || fire.noSpread !== null || fire.status !== "burning") return;
  const level = fr.level;
  const structure = fr.structure;
  const card = runCard(level, structure);
  logEvent(board, "team", "board", `${fire.id}: ${structure ? "structure" : level} dispatch level, run card ${cardText(card)}.`, { action: "run_card", fireId: fire.id });
  const short = fillCard(board, fire, card);
  const shortGround = short.engines + short.hand_crews + short.dozers;
  if (shortGround > 0 && r.autoEscalate) {
    // Closest-resource shortfall: ordered from the adjacent area as immediate need (OB#1).
    if (short.engines > 0) placeOrder(board, fire, "engine_strike_team", 1, "board", "run card short of engines");
    if (short.hand_crews > 0) placeOrder(board, fire, "crew_strike_team", 1, "board", "run card short of crews");
    if (short.dozers > 0) placeOrder(board, fire, "dozer_strike_team", 1, "board", "run card short of dozers");
  }
}

function cardText(c: ResourceCounts): string {
  const parts = [
    [c.engines, "engine"],
    [c.hand_crews, "crew"],
    [c.dozers, "dozer"],
    [c.air_attack, "air attack"],
    [c.airtankers, "airtanker"],
    [c.helicopters, "helicopter"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}${n > 1 && !label.endsWith("attack") ? "s" : ""}`)
    .join(", ");
}

/** Off-board pool units considered per kind per run card (nearest by straight line), to bound the work. */
const POOL_CANDIDATES_PER_KIND = 8;

/**
 * Dispatches the closest units to fill `card`; returns what it could not fill. Candidates are
 * the board's dispatchable units and the off-board stations' units (closest-resource concept:
 * an off-board station nearer than any free board unit answers initial attack directly, from
 * its station, with its own turnout; it leaves the board again when released). Two passes:
 * the first keeps each department's drawdown reserve, the second (only for what is still
 * short) does not, because the closest resource is sent rather than none.
 */
function fillCard(board: Board, fire: Fire, card: ResourceCounts): ResourceCounts {
  const short: ResourceCounts = { ...card };
  const r = board.response;
  type Candidate = { t: Team | null; seed: UnitSeed | null; kind: GroundResponseKind; eta: number; id: string };
  const candidates: Candidate[] = board.teams
    .filter((t) => dispatchable(t) && t.fireId === null && legStatus(board, t, fire.id, crewTarget(fire)).route !== "none")
    .map((t) => ({ t, seed: null, kind: t.kind, eta: expectedArrival(board, t, fire), id: t.id }));
  const flows = flowIndex(board);
  const byDistance = [...r.pool].sort((a, b) => distanceM(a.location, fire.origin) - distanceM(b.location, fire.origin));
  const perKind = new Map<string, number>();
  const poolNear = byDistance.filter((s) => {
    const n = perKind.get(s.kind) ?? 0;
    perKind.set(s.kind, n + 1);
    return n < POOL_CANDIDATES_PER_KIND;
  });
  for (const seed of poolNear) {
    const target = crewTarget(fire);
    const eta = seed.turnoutMinutes + fallbackDriveMinutes(seed.location, target) * congestionOnLeg(flows, [seed.location, target]).multiplier;
    candidates.push({ t: null, seed, kind: seed.kind, eta, id: `pool:${seed.stationId}` });
  }
  candidates.sort((a, b) => a.eta - b.eta || a.id.localeCompare(b.id));
  const used = new Set<Candidate>();
  for (const pass of [0, 1]) {
    for (const c of candidates) {
      if (used.has(c)) continue;
      const family = groundFamilyOf(c.kind);
      if (short[family] <= 0) continue;
      let team = c.t;
      if (team && pass === 0 && !departmentAllows(board, team, fire)) continue;
      if (!team && c.seed) {
        if (pass === 0 && !poolAllows(board, c.seed)) continue;
        if (board.teams.length >= MAX_TEAMS) continue;
        r.pool = r.pool.filter((s) => s !== c.seed);
        team = teamFromSeed(board, c.seed);
        team.demobilise = true;
        const st = r.offBoardStations.get(c.seed.stationId);
        if (st && !board.stations.some((s) => s.id === st.id)) board.stations.push(st);
        board.teams.push(team);
      }
      if (!team) continue;
      used.add(c);
      if (dispatchTeam(board, team, fire, "board", c.seed ? " (run card, closest resource from off the board)" : " (run card)") !== null) {
        if (c.seed) {
          // No road there for it: back to the pool.
          board.teams = board.teams.filter((t) => t !== team);
          r.pool.push(c.seed);
        }
        continue;
      }
      short[family] -= 1;
    }
  }
  for (const family of ["air_attack", "airtankers", "helicopters"] as const) {
    const kind: AirResponseKind = family === "air_attack" ? "air_attack" : family === "airtankers" ? "airtanker_s2t" : "helicopter_t2";
    const free = board.response.aircraft
      .filter((a) => a.kind === kind && a.status === "available")
      .sort((a, b) => distanceM(a.base, fire.origin) - distanceM(b.base, fire.origin));
    for (const a of free.slice(0, short[family])) {
      dispatchAircraft(board, a, fire, "board");
      short[family] -= 1;
    }
  }
  return short;
}

/** Straight-line km from an aircraft's base to the fire (the cycle distance; STATE_AIR_DISTANCE_KM for state aircraft). */
function aircraftKm(a: Aircraft, fire: Fire): number {
  return a.tier === "state" ? STATE_AIR_DISTANCE_KM : distanceM(a.base, fire.origin) / 1000;
}

/** Minutes until an available aircraft sent now is over `fire` (response/units.ts firstOverFireMinutes). */
export function aircraftOverFireMinutes(a: Aircraft, fire: Fire): number {
  return firstOverFireMinutes(a.kind, aircraftKm(a, fire));
}

/**
 * Sends an available aircraft from its base to `fire` (the run card with autoDispatch, or a
 * send_crew order naming the aircraft: model.ts applyOrder). Returns null, or why it cannot go.
 */
export function dispatchAircraft(board: Board, a: Aircraft, fire: Fire, actor: BoardEvent["actor"]): string | null {
  const unreported = unreportedRefusal(board, fire, actor); // report rule
  if (unreported) return unreported;
  if (fire.status !== "burning") return `${fire.id} is not burning.`;
  if (a.status !== "available") {
    return a.fireId === fire.id ? `${a.id} is already on ${fire.id}.` : `${a.id} is ${a.status.replace(/_/g, " ")}${a.fireId ? ` (${a.fireId})` : ""} and cannot be sent; release it first or send an available aircraft.`;
  }
  const km = aircraftKm(a, fire);
  a.baseKm = km;
  a.status = "en_route";
  a.fireId = fire.id;
  a.overFireAt = board.minute + firstOverFireMinutes(a.kind, km);
  a.nextDropAt = null;
  a.returnAt = null;
  logEvent(board, "team", actor, `${a.id} (${a.kind.replace("_", " ")}) from ${a.baseName} to ${fire.id}, over the fire in ${Math.ceil(a.overFireAt - board.minute)} min.`, {
    action: "aircraft_dispatched",
    teamIds: [a.id],
    fireId: fire.id,
    etaMin: Math.ceil(a.overFireAt - board.minute),
  });
  return null;
}

/** release_crew naming an aircraft: it flies back to its base (state aircraft leave the board). Returns null or why not. */
export function releaseAircraftOrder(board: Board, a: Aircraft, actor: BoardEvent["actor"]): string | null {
  if (a.fireId === null || a.status === "returning") return `${a.id} is not assigned to a fire.`;
  const fromFire = a.fireId;
  releaseAircraft(board, a);
  logEvent(board, "team", actor, `${a.id} released from ${fromFire}; flying back to ${a.tier === "state" ? "its out-of-region base" : a.baseName}.`, {
    action: "released",
    teamIds: [a.id],
    fireId: fromFire,
  });
  return null;
}

/**
 * The run card for a reported, burning fire as a RECOMMENDATION for the commander (nothing is
 * sent): the card for its dispatch level (response/runCards.ts runCard), less what is already
 * assigned, filled the way the former rule-based dispatcher would (fillCard): the closest free
 * board units by expected arrival (turnout + road time x congestion, no seeded variation), within
 * each department's drawdown first, then without it; the nearest available aircraft by base
 * distance. `unfilled` is what the board's own units and aircraft cannot cover (order_resources
 * mutual aid / state). Off-board pool units are not listed: they come only by order_resources.
 * Pure: no state change, no random draw.
 */
export interface InitialAttackRecommendation {
  level: DispatchLevel;
  structure: boolean;
  card: ResourceCounts;
  /** Card less the units and aircraft already assigned to (or ordered for) the fire. */
  stillNeeded: ResourceCounts;
  units: { team: Team; etaMin: number; road: boolean }[];
  aircraft: { aircraft: Aircraft; overFireMin: number }[];
  unfilled: ResourceCounts;
}

const AIR_FAMILY_KIND = { air_attack: "air_attack", airtankers: "airtanker_s2t", helicopters: "helicopter_t2" } as const;

export function initialAttackRecommendation(board: Board, fire: Fire): InitialAttackRecommendation | null {
  const r = board.response;
  const fr = r.fires.get(fire.id);
  if (!fr || fire.status !== "burning" || !isReported(board, fire)) return null;
  const card = runCard(fr.level, fr.structure);
  const need: ResourceCounts = { ...card };
  for (const t of board.teams) if (t.fireId === fire.id) need[groundFamilyOf(t.kind)] -= 1;
  for (const a of r.aircraft) {
    if (a.fireId !== fire.id) continue;
    if (a.kind === "air_attack") need.air_attack -= 1;
    else if (a.kind === "helicopter_t2") need.helicopters -= 1;
    else need.airtankers -= 1;
  }
  // Ground strike teams already on order for this fire count against the card (by family).
  for (const o of r.orders) {
    if (o.fireId !== fire.id || (o.status !== "pending" && o.status !== "unable_to_fill")) continue;
    if (o.air === "helicopter_t2") need.helicopters -= 1;
    else if (o.air) need.airtankers -= 1;
    else for (const seed of o.seeds) need[groundFamilyOf(seed.kind)] -= 1;
  }
  for (const k of Object.keys(need) as (keyof ResourceCounts)[]) need[k] = Math.max(0, need[k]);
  const stillNeeded: ResourceCounts = { ...need };
  const candidates = board.teams
    .filter((t) => dispatchable(t) && t.fireId === null)
    .flatMap((t) => {
      const leg = legStatus(board, t, fire.id, crewTarget(fire));
      return leg.route === "none" ? [] : [{ team: t, etaMin: expectedArrival(board, t, fire), road: leg.route === "road" }];
    })
    .sort((a, b) => a.etaMin - b.etaMin || a.team.id.localeCompare(b.team.id));
  const picked = new Set<Team>();
  const pickedEngines = new Map<string, number>();
  const keepsReserve = (t: Team): boolean => {
    if (!isEngine(t.kind)) return true;
    const dept = r.departments.find((d) => d.id === t.department);
    if (!dept || dept.keepEngines <= 0) return true;
    const own = dept.stationIds.some((id) => {
      const st = board.stations.find((x) => x.id === id);
      return st ? distanceM(st.location, fire.origin) <= OWN_AREA_RADIUS_M : false;
    });
    return own || freeEngines(board, dept.id) - (pickedEngines.get(dept.id) ?? 0) - 1 >= dept.keepEngines;
  };
  const units: InitialAttackRecommendation["units"] = [];
  for (const pass of [0, 1]) {
    for (const c of candidates) {
      if (picked.has(c.team)) continue;
      const family = groundFamilyOf(c.team.kind);
      if (need[family] <= 0) continue;
      if (pass === 0 && !keepsReserve(c.team)) continue;
      picked.add(c.team);
      if (isEngine(c.team.kind)) pickedEngines.set(c.team.department, (pickedEngines.get(c.team.department) ?? 0) + 1);
      units.push(c);
      need[family] -= 1;
    }
  }
  units.sort((a, b) => a.etaMin - b.etaMin || a.team.id.localeCompare(b.team.id));
  const aircraft: InitialAttackRecommendation["aircraft"] = [];
  for (const family of ["air_attack", "airtankers", "helicopters"] as const) {
    const free = r.aircraft
      .filter((a) => a.kind === AIR_FAMILY_KIND[family] && a.status === "available")
      .map((a) => ({ aircraft: a, overFireMin: aircraftOverFireMinutes(a, fire) }))
      .sort((a, b) => a.overFireMin - b.overFireMin || a.aircraft.id.localeCompare(b.aircraft.id));
    for (const a of free.slice(0, need[family])) {
      aircraft.push(a);
      need[family] -= 1;
    }
  }
  return { level: fr.level, structure: fr.structure, card, stillNeeded, units, aircraft, unfilled: need };
}

/** "3 engines, 1 crew, 1 airtanker" for a set of resource counts ("none" when all zero). */
export function resourceCountsText(c: ResourceCounts): string {
  return cardText(c) || "none";
}

// ---- orders ----

const RESOURCE_UNITS: Record<Exclude<Orderable, "airtanker" | "helicopter">, { kind: GroundResponseKind; per: number }> = {
  engine_strike_team: { kind: "engine_t3", per: ENGINES_PER_STRIKE_TEAM },
  crew_strike_team: { kind: "hand_crew_t1", per: CREWS_PER_STRIKE_TEAM },
  dozer_strike_team: { kind: "dozer_t2", per: DOZERS_PER_STRIKE_TEAM },
};

/**
 * Orders `count` of a resource for `fire`. Ground strike teams: first from the mutual-aid pool
 * (real off-board stations, nearest first, within their department's drawdown) as immediate
 * need, once per incident and within the OB#1 caps; otherwise, or when the draw says the area
 * cannot fill it, from the state system (arriving at the board edge). Aircraft: from the state
 * system. Returns a short description of what was placed.
 */
export function placeOrder(board: Board, fire: Fire, resource: Orderable, count: number, by: BoardEvent["actor"], why: string, stage?: number): string {
  // Report rule: nothing is ordered for a fire dispatch does not have yet (callers check first; this guards the state).
  const refused = unreportedRefusal(board, fire, by);
  if (refused) return refused;
  const r = board.response;
  const fr = r.fires.get(fire.id);
  const placed: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    r.stats.ordersPlaced += 1;
    const id = `O${r.stats.ordersPlaced}`;
    ids.push(id);
    if (resource === "airtanker" || resource === "helicopter") {
      const air: AirResponseKind = resource === "airtanker" ? "airtanker_s2t" : "helicopter_t2";
      const ok = stateHasRoom(board, true, 1) && fills(r.rng, "state", boardActivity(board));
      const lead = firstOverFireMinutes(air, STATE_AIR_DISTANCE_KM);
      pushOrder(board, { id, fireId: fire.id, resource, tier: "state", placedAt: board.minute, readyAt: board.minute + (ok ? variedLead(r.rng, lead) : UNABLE_TO_FILL_RETRY_MINUTES), status: ok ? "pending" : "unable_to_fill", seeds: [], air, by });
      if (!ok) r.stats.ordersUnableToFill += 1;
      placed.push(`${id} ${resource} (state${ok ? "" : ", unable to fill yet"})`);
      continue;
    }
    const spec = RESOURCE_UNITS[resource];
    const capKey = resource === "engine_strike_team" ? "engine_strike_teams" : resource === "crew_strike_team" ? "crew_strike_teams" : "dozer_strike_teams";
    const usedHere = r.orders.filter((o) => o.fireId === fire.id && o.tier === "mutual_aid" && o.resource === resource).length;
    let tier: "mutual_aid" | "state" = !fr?.immediateNeedUsed && usedHere < IMMEDIATE_NEED_CAPS[capKey] ? "mutual_aid" : "state";
    let seeds: UnitSeed[] = [];
    if (tier === "mutual_aid") {
      const candidates = r.pool
        .filter((s) => s.kind === spec.kind)
        .sort((a, b) => distanceM(a.location, fire.origin) - distanceM(b.location, fire.origin));
      const picked: UnitSeed[] = [];
      for (const s of candidates) {
        if (picked.length >= spec.per) break;
        if (!poolAllows(board, s)) continue;
        picked.push(s);
        r.pool = r.pool.filter((x) => x !== s); // so the next pick sees the reduced reserve
      }
      if (picked.length >= spec.per && fills(r.rng, "mutual_aid", boardActivity(board))) {
        seeds = picked;
      } else {
        r.pool.push(...picked);
        tier = "state";
      }
    }
    if (tier === "state") {
      const ok = stateHasRoom(board, false, spec.per) && fills(r.rng, "state", boardActivity(board));
      const entry = boardEntry(board, fire.origin);
      seeds = Array.from({ length: spec.per }, () => ({
        kind: spec.kind,
        stationId: "state",
        departmentId: "state",
        location: entry,
        turnoutMinutes: 0,
        tier: "state" as Tier,
      }));
      const lead = stateGroundLeadMinutes();
      pushOrder(board, { id, fireId: fire.id, resource, tier, placedAt: board.minute, readyAt: board.minute + (ok ? variedLead(r.rng, lead) : UNABLE_TO_FILL_RETRY_MINUTES), status: ok ? "pending" : "unable_to_fill", seeds, air: null, by });
      if (!ok) r.stats.ordersUnableToFill += 1;
      placed.push(`${id} ${resource.replace(/_/g, " ")} (state system${ok ? `, at the board edge in about ${Math.round(lead / 60)} h` : ", unable to fill yet"})`);
    } else {
      pushOrder(board, { id, fireId: fire.id, resource, tier, placedAt: board.minute, readyAt: board.minute + variedLead(r.rng, MUTUAL_AID_ASSEMBLY_MINUTES), status: "pending", seeds, air: null, by });
      placed.push(`${id} ${resource.replace(/_/g, " ")} (mutual aid from ${r.offBoardStations.get(seeds[0].stationId)?.name ?? "an adjacent area"})`);
    }
  }
  if (fr && placed.length > 0) fr.immediateNeedUsed = fr.immediateNeedUsed || r.orders.some((o) => o.fireId === fire.id && o.tier === "mutual_aid");
  const text = `${fire.id}: ordered ${placed.join("; ")}${why ? ` (${why})` : ""}.`;
  const unfilled = r.orders.filter((o) => ids.includes(o.id) && o.status === "unable_to_fill").length;
  logEvent(board, "team", by, text, { action: "resources_ordered", fireId: fire.id, orderIds: ids, resource, count, unfilled, stage });
  return text;
}

/** Whether the state system can still send this board `n` more aircraft or ground units (STATE_MAX_*). */
function stateHasRoom(board: Board, air: boolean, n: number): boolean {
  const r = board.response;
  const pending = r.orders.filter((o) => o.tier === "state" && o.status === "pending" && (o.air !== null) === air);
  if (air) {
    const flying = r.aircraft.filter((a) => a.tier === "state").length;
    return flying + pending.length + n <= STATE_MAX_AIRCRAFT;
  }
  const units = board.teams.filter((t) => t.tier === "state").length + pending.reduce((s, o) => s + o.seeds.length, 0);
  return units + n <= STATE_MAX_GROUND_UNITS;
}

function pushOrder(board: Board, order: PendingOrder): void {
  board.response.orders.push(order);
  if (board.response.orders.length > MAX_ORDERS_KEPT) {
    const i = board.response.orders.findIndex((o) => o.status === "arrived" || o.status === "cancelled");
    board.response.orders.splice(i >= 0 ? i : 0, 1);
  }
}

/** The board-edge point nearest `p` (where out-of-region resources enter; ASSUMPTION). */
export function boardEntry(board: Board, p: LonLat): LonLat {
  const grid = board.env.landscape;
  const sw = cellLonLat(grid, (grid.height - 1) * grid.width);
  const ne = cellLonLat(grid, grid.width - 1);
  const [w, s, e, n] = [Math.min(sw[0], ne[0]), Math.min(sw[1], ne[1]), Math.max(sw[0], ne[0]), Math.max(sw[1], ne[1])];
  const candidates: LonLat[] = [
    [w, Math.min(n, Math.max(s, p[1]))],
    [e, Math.min(n, Math.max(s, p[1]))],
    [Math.min(e, Math.max(w, p[0])), s],
    [Math.min(e, Math.max(w, p[0])), n],
  ];
  return candidates.reduce((best, c) => (distanceM(c, p) < distanceM(best, p) ? c : best));
}

function materialiseOrder(board: Board, order: PendingOrder): void {
  const fire = board.fires.find((f) => f.id === order.fireId);
  if (!fire || fire.status !== "burning") {
    order.status = "cancelled";
    // Unused mutual-aid units go back to their pool.
    if (order.tier === "mutual_aid") board.response.pool.push(...order.seeds);
    logEvent(board, "team", "board", `Order ${order.id} cancelled: ${order.fireId} no longer needs it.`, { action: "order_cancelled", fireId: order.fireId, orderIds: [order.id] });
    return;
  }
  order.status = "arrived";
  if (order.air) {
    const prefix = order.air === "helicopter_t2" ? "H" : "T";
    const a: Aircraft = {
      id: nextAirId(board, prefix),
      kind: order.air,
      baseName: "state resources (out of region)",
      base: boardEntry(board, fire.origin),
      baseKm: STATE_AIR_DISTANCE_KM,
      status: "over_fire",
      fireId: fire.id,
      overFireAt: board.minute,
      nextDropAt: board.minute,
      returnAt: null,
      drops: 0,
      tier: "state",
    };
    board.response.aircraft.push(a);
    logEvent(board, "team", "board", `${a.id} (state airtanker or helicopter) over ${fire.id} (order ${order.id}).`, {
      action: "aircraft_over_fire",
      teamIds: [a.id],
      fireId: fire.id,
      orderIds: [order.id],
    });
    return;
  }
  for (const seed of order.seeds) {
    if (board.teams.length >= MAX_TEAMS) break;
    const team = teamFromSeed(board, seed);
    if (seed.tier === "mutual_aid") {
      const st = board.response.offBoardStations.get(seed.stationId);
      if (st && !board.stations.some((s) => s.id === st.id)) board.stations.push(st);
    }
    team.demobilise = true;
    board.teams.push(team);
    dispatchTeam(board, team, fire, "board", ` (order ${order.id}, ${seed.tier === "state" ? "state" : "mutual aid"})`);
  }
}

function nextAirId(board: Board, prefix: string): string {
  const c = board.response.counters;
  c[prefix] = (c[prefix] ?? 0) + 1;
  return `${prefix}${c[prefix]}`;
}

/** A board Team for a fleet seed (at its station, available). */
export function teamFromSeed(board: Board, seed: UnitSeed): Team {
  const tank = TANK_GALLONS[seed.kind];
  return {
    id: nextId(board, KIND_PREFIX[seed.kind]),
    kind: seed.kind,
    station: seed.stationId,
    engineId: null,
    // Counts per facility are assumptions (response/fleet.ts), and the snapshot does not list it.
    assumed: true,
    returnRetryAt: null,
    fireCuts: 0,
    rerouteAt: null,
    blockedByFire: null,
    legKey: null,
    lineId: null,
    position: seed.location,
    status: "available",
    fireId: null,
    departAt: null,
    arriveAt: null,
    target: null,
    route: null,
    travel: null,
    department: seed.departmentId,
    tier: seed.tier,
    home: seed.location,
    turnoutMinutes: seed.turnoutMinutes,
    rollAt: null,
    travelFactor: 1,
    waterGallons: tank ?? null,
    workMinutes: 0,
    restOwed: 0,
    restUntil: null,
    outOfServiceUntil: null,
    coverStation: null,
    demobilise: false,
    workMode: null,
    workStartAt: null,
    parkedM: null,
    reachM: 0,
    accessKnown: false,
  };
}

// ---- tick ----

/** Unit lifecycle, aircraft, orders, availability, move-up and fire-cut roads for one step. */
export function responseTick(board: Board, dt: number, wholeMinute: boolean): void {
  const r = board.response;
  const now = board.minute;
  for (const fire of board.fires) {
    const fr = r.fires.get(fire.id);
    if (fr && !fr.dispatched && now >= fr.reportAt) dispatchOnReport(board, fire, fr);
  }
  const removed = new Set<Team>();
  for (const team of board.teams) {
    // Work clock (travel to, work on and refilling at a fire count as work; idle time is rest at 2:1).
    if (team.fireId !== null && (team.status === "en_route" || team.status === "on_scene" || team.status === "refilling")) {
      team.workMinutes += dt;
    } else if (team.status === "available") {
      team.workMinutes = Math.max(0, team.workMinutes - 2 * dt);
    }
    if (team.fireId !== null && team.workMinutes >= MAX_SHIFT_MINUTES) {
      team.restOwed = restMinutesAfter(team.workMinutes);
      logEvent(board, "team", "board", `${team.id} relieved from ${team.fireId} after ${Math.round(team.workMinutes / 60)} h (work/rest 2:1): rests ${Math.round(team.restOwed / 60)} h.`, {
        action: "relieved",
        teamIds: [team.id],
        fireId: team.fireId,
      });
      if (team.demobilise) team.restOwed = 0;
      sendHome(board, team);
      continue;
    }
    if (team.status === "on_scene" && team.waterGallons !== null && team.fireId !== null) {
      team.waterGallons -= ENGINE_WATER_USE_GPM * dt;
      // step() lands on the minute the tank runs dry (model.ts nextTimedEvent); allow float residue.
      if (team.waterGallons <= 1e-6) {
        team.waterGallons = 0;
        team.status = "refilling";
        team.restUntil = now + ENGINE_REFILL_MINUTES;
      }
    } else if (team.status === "refilling" && team.restUntil !== null && now >= team.restUntil) {
      team.waterGallons = TANK_GALLONS[team.kind] ?? null;
      team.restUntil = null;
      const fire = board.fires.find((f) => f.id === team.fireId);
      if (fire && fire.status !== "out") team.status = "on_scene";
      else sendHome(board, team);
    } else if ((team.status === "returning" || team.status === "moving_up") && team.travel !== "pending" && team.arriveAt !== null && now >= team.arriveAt) {
      if (team.demobilise && team.status === "returning") {
        removed.add(team);
        if (team.tier === "mutual_aid") r.pool.push({ kind: team.kind, stationId: team.station, departmentId: team.department, location: team.home, turnoutMinutes: team.turnoutMinutes, tier: "mutual_aid" });
        continue;
      }
      arriveHome(board, team);
    } else if (team.status === "resting" && team.restUntil !== null && now >= team.restUntil) {
      team.status = "available";
      team.restUntil = null;
    } else if (team.status === "out_of_service" && team.outOfServiceUntil !== null && now >= team.outOfServiceUntil) {
      team.status = "available";
      team.outOfServiceUntil = null;
    }
  }
  if (removed.size > 0) board.teams = board.teams.filter((t) => !removed.has(t));

  // Seeded availability: idle units at home may go out of service (maintenance, training, elsewhere).
  if (now >= r.nextAvailabilityDraw) {
    r.nextAvailabilityDraw = now + AVAILABILITY_DRAW_EVERY_MINUTES;
    for (const team of board.teams) {
      if (team.status !== "available" || team.demobilise) continue;
      if (chance(r.rng, OUT_OF_SERVICE_PROBABILITY)) {
        team.status = "out_of_service";
        const [lo, hi] = OUT_OF_SERVICE_MINUTES;
        team.outOfServiceUntil = now + lo + (hi - lo) * uniform(r.rng);
      }
    }
  }

  for (const order of r.orders) {
    if (order.readyAt > now) continue;
    if (order.status === "pending") materialiseOrder(board, order);
    else if (order.status === "unable_to_fill") {
      const fire = board.fires.find((f) => f.id === order.fireId);
      if (!fire || fire.status !== "burning") {
        order.status = "cancelled";
        continue;
      }
      // Retry with the state system.
      const ok = stateHasRoom(board, order.air !== null, Math.max(1, order.seeds.length)) && fills(r.rng, "state", boardActivity(board));
      order.tier = "state";
      if (ok) {
        order.status = "pending";
        order.readyAt = now + variedLead(r.rng, order.air ? firstOverFireMinutes(order.air, STATE_AIR_DISTANCE_KM) : stateGroundLeadMinutes());
      } else {
        order.readyAt = now + UNABLE_TO_FILL_RETRY_MINUTES;
        r.stats.ordersUnableToFill += 1;
      }
    }
  }

  aircraftTick(board);
  if (wholeMinute) {
    cutRoads(board);
    if (now >= r.nextMoveUpCheck) {
      r.nextMoveUpCheck = now + MOVE_UP_CHECK_EVERY_MINUTES;
      // Moving an engine to cover another station is a dispatch decision: rule-based only (autoDispatch).
      if (r.autoDispatch) moveUpAndCover(board);
    }
  }
}

/** Units arriving on scene: record the fire's first arrival. */
export function noteArrival(board: Board, fire: Fire): void {
  const fr = board.response.fires.get(fire.id);
  if (fr) fr.tacticAt = -Infinity; // review the tactic with the new arrival
  if (fr && fr.firstArrivalAt === null) {
    fr.firstArrivalAt = board.minute;
    board.response.stats.firstArrivalMinutes.push(board.minute - fire.ignitedAt);
    if (board.response.stats.firstArrivalMinutes.length > 500) board.response.stats.firstArrivalMinutes.shift();
  }
}

function burnedAt(board: Board): (p: LonLat) => boolean {
  const field = board.solver.field;
  const grid = board.env.landscape;
  return (p) => {
    if (!field) return false;
    const cell = cellAt(grid, { longitude: p[0], latitude: p[1] });
    return cell >= 0 && field.arrivalMinutes[cell] <= board.minute;
  };
}

/**
 * En-route units whose road ahead has burned stop where they are and wait for a new road leg
 * (model.ts rerouteTeam: at most MAX_FIRE_CUT_REROUTES per trip, with a backoff; the cut after
 * that gives the trip up as blocked by fire and leaves the unit free where it stands).
 */
function cutRoads(board: Board): void {
  const burned = burnedAt(board);
  for (const team of board.teams) {
    if (team.status !== "en_route" || !team.route || team.route.length < 2 || team.fireId === null || team.arriveAt === null || team.rollAt === null) continue;
    const span = team.arriveAt - team.rollAt;
    const u = span > 0 ? Math.max(0, Math.min(1, (board.minute - team.rollAt) / span)) : 1;
    const cut = routeCutAt(team.route, u, burned);
    if (!cut) continue;
    const fireId = team.fireId;
    // Units only drive roads: it stops where it is and waits for a new road leg from there, or gives the trip up.
    const outcome = rerouteTeam(board, team);
    if (outcome === null) continue;
    board.response.stats.routeCuts += 1;
    if (outcome === "blocked") {
      const cuts = team.blockedByFire?.cuts ?? MAX_FIRE_CUT_REROUTES + 1;
      logEvent(
        board,
        "team",
        "board",
        `${team.id}: road to ${fireId} cut by fire ${cuts} times on this trip (after ${MAX_FIRE_CUT_REROUTES} reroutes); trip blocked by fire. It stops where it is, off ${fireId} and free to be re-tasked.`,
        { action: "road_blocked", teamIds: [team.id], fireId },
      );
      continue;
    }
    const wait = team.rerouteAt !== null ? Math.round(team.rerouteAt - board.minute) : 0;
    logEvent(
      board,
      "team",
      "board",
      `${team.id}: road to ${fireId} cut by fire (reroute ${team.fireCuts} of ${MAX_FIRE_CUT_REROUTES}); stopped, ${wait > 0 ? `asking for a new road route in ${wait} min` : "waiting for a new road route"}.`,
      { action: "road_cut", teamIds: [team.id], fireId },
    );
  }
}

/** Move-up and cover: a station whose units have all been committed for MOVE_UP_EMPTY_MINUTES gets a free engine from a station with two or more. */
function moveUpAndCover(board: Board): void {
  const r = board.response;
  const homes = new Map<string, Team[]>();
  for (const t of board.teams) {
    if (!isEngine(t.kind) || t.demobilise || t.tier !== "closest") continue;
    const list = homes.get(t.station);
    if (list) list.push(t);
    else homes.set(t.station, [t]);
  }
  const atStation = (t: Team, stationId: string) => {
    const s = board.stations.find((st) => st.id === stationId);
    return !!s && t.status === "available" && distanceM(t.position, s.location) <= HOME_M;
  };
  for (const [stationId, own] of homes) {
    const covered = board.teams.some((t) => t.coverStation === stationId && (t.status === "available" || t.status === "moving_up"));
    const home = own.some((t) => atStation(t, stationId));
    if (home) {
      r.stationEmptySince.delete(stationId);
      // Its own engines are back: covering engines go home.
      for (const t of board.teams) if (t.coverStation === stationId && t.status === "available") {
        t.coverStation = null;
        sendHome(board, t);
      }
      continue;
    }
    if (covered) continue;
    const since = r.stationEmptySince.get(stationId);
    if (since === undefined) {
      r.stationEmptySince.set(stationId, board.minute);
      continue;
    }
    if (board.minute - since < MOVE_UP_EMPTY_MINUTES) continue;
    const station = board.stations.find((s) => s.id === stationId);
    if (!station) continue;
    const donors = [...homes.entries()].filter(([id, list]) => id !== stationId && list.filter((t) => atStation(t, id)).length >= 2);
    let best: Team | null = null;
    for (const [id, list] of donors) {
      for (const t of list) {
        if (!atStation(t, id) || t.coverStation) continue;
        if (!best || distanceM(t.position, station.location) < distanceM(best.position, station.location)) best = t;
      }
    }
    if (!best) continue;
    best.coverStation = stationId;
    // A road trip (model.ts startRoadTrip), after turnout; no road route there drops the move-up.
    startRoadTrip(board, best, `cover:${stationId}`, station.location, "moving_up");
    if (best.status !== "moving_up") continue;
    r.stats.moveUps += 1;
    logEvent(board, "team", "board", `${best.id} moves up to cover ${station.name} (its engines committed for ${Math.round(board.minute - since)} min).`, {
      action: "move_up",
      teamIds: [best.id],
      stationId,
    });
  }
}

// ---- aircraft ----

function aircraftTick(board: Board): void {
  const now = board.minute;
  const wind = boardWind(board);
  const windKt = wind.speedMetersPerSecond * KNOTS_PER_METER_PER_SECOND;
  const epochMs = board.response.startEpochMs + now * 60_000;
  for (const a of board.response.aircraft) {
    if (a.status === "available" || a.status === "grounded") continue;
    const fire = a.fireId ? board.fires.find((f) => f.id === a.fireId) : undefined;
    if (a.status === "returning") {
      if (a.returnAt !== null && now >= a.returnAt) {
        if (a.tier === "state") a.status = "grounded"; // released state aircraft leave the board (pruned below)
        else {
          a.status = "available";
          a.fireId = null;
          a.returnAt = null;
        }
      }
      continue;
    }
    if (!fire || fire.status !== "burning") {
      releaseAircraft(board, a);
      continue;
    }
    if (a.status === "en_route" && a.overFireAt !== null && now >= a.overFireAt) {
      a.status = "over_fire";
      a.nextDropAt = now;
    }
    if (a.status !== "over_fire" || a.nextDropAt === null || now < a.nextDropAt) continue;
    const supervised = board.response.aircraft.some((o) => o.kind === "air_attack" && o.fireId === fire.id && o.status === "over_fire");
    if (!mayFly(a.kind, epochMs, fire.origin, windKt, supervised)) {
      a.nextDropAt = now + 15; // ASSUMPTION: re-check flight conditions every 15 min
      continue;
    }
    const cycle = dropCycleMinutes(a.kind, a.baseKm, dipKmFor(board, fire));
    if (cycle === null) continue; // air attack: supervision only
    // A load holds only where retardant or water can hold the head (PMS 465 pp.171, 174: not above 8 ft; not on crown fire).
    const fr = board.response.fires.get(fire.id);
    const fuel = board.env.spread.ground.fuelCodeAt(fire.origin);
    const usable = !fire.rates.crowning && (fire.rates.headFlameFeet <= DROP_HOLDS_FLAME_FEET || fr?.tactic === "parallel" || fr?.tactic === "indirect");
    const line = usable ? dropLineMeters(a.kind, fuel, windKt) : 0;
    if (line > 0 && fr) fr.airLineM += line;
    a.drops += 1;
    a.nextDropAt = now + cycle;
  }
  board.response.aircraft = board.response.aircraft.filter((a) => !(a.tier === "state" && a.status === "grounded"));
}

function releaseAircraft(board: Board, a: Aircraft): void {
  a.status = "returning";
  a.returnAt = board.minute + (a.baseKm > 0 ? firstOverFireMinutes(a.kind, a.baseKm) - firstOverFireMinutes(a.kind, 0) : 0);
  a.fireId = null;
  a.nextDropAt = a.overFireAt = null;
}

function dipKmFor(board: Board, fire: Fire): number | null {
  const fr = board.response.fires.get(fire.id);
  if (!fr) return null;
  if (fr.dipKm === null) fr.dipKm = nearestWaterKm(board.env.landscape, fire.origin) ?? -1;
  return fr.dipKm < 0 ? null : fr.dipKm;
}

// ---- containment ----

/** Units on scene that build line on this fire now. */
/** Units on scene that are working the edge now (not out of reach, not still hiking in). */
function builders(board: Board, fire: Fire, at = board.minute): Team[] {
  return board.teams.filter(
    (t) =>
      t.fireId === fire.id &&
      t.lineId === null &&
      t.status === "on_scene" &&
      !offEdge(t.workMode) &&
      (t.workStartAt === null || at >= t.workStartAt),
  );
}

function directHolds(board: Board, fire: Fire, teams: Team[]): number {
  let holds = 0;
  for (const t of teams) holds = Math.max(holds, holdsFlameFeet(t.kind));
  const fr = board.response.fires.get(fire.id);
  if (fr && fr.airLineM > 0) holds = Math.max(holds, DROP_HOLDS_FLAME_FEET);
  return holds;
}

function structureFront(board: Board, fire: Fire): boolean {
  if (fire.rates.cell >= 0) return fire.rates.fuelCode === DEVELOPED_FUEL_CODE;
  return board.env.spread.ground.fuelCodeAt(fire.origin) === DEVELOPED_FUEL_CODE;
}

/** Line per minute these units build on this fire with this tactic (working from `at`: past any hike in). */
export function tacticLineRate(board: Board, fire: Fire, teams: Team[], tactic: Tactic, at = board.minute): number {
  const fuel = board.env.spread.ground.fuelCodeAt(fire.origin);
  let rate = 0;
  for (const t of teams) {
    if (!buildsOn(t.kind, tactic)) continue;
    // Off-road reach (response/reach.ts): nothing until it has walked in, nothing out of reach,
    // and an engine crew on foot builds hand line at PMS 465 p.39 per-person rates.
    if (t.workStartAt !== null && at < t.workStartAt) continue;
    if (offEdge(t.workMode)) continue;
    if (t.workMode === "hand_line" && (t.kind === "engine_t3" || t.kind === "engine_t1")) {
      rate += engineCrewHandLineMPerMin(t.kind, fuel);
      continue;
    }
    rate += unitLineOn(board, t, fire) * tacticRateFactor(t.kind, fuel, tactic);
  }
  return rate;
}

/**
 * The line a fire's on-scene and en-route units would have built `t` minutes from now with a
 * tactic (each from its arrival), metres.
 */
function projectedLine(board: Board, fire: Fire, tactic: Tactic, t: number): number {
  let line = fire.lineM;
  for (const team of board.teams) {
    if (team.fireId !== fire.id || team.lineId !== null) continue;
    const eta = expectedArrival(board, team, fire);
    if (eta >= t || !buildsOn(team.kind, tactic)) continue;
    line += tacticLineRate(board, fire, [team], tactic) * (t - eta);
  }
  return line;
}

function reviewTactic(board: Board, fire: Fire, fr: FireResponse, teams: Team[]): void {
  const assigned = board.teams.filter((t) => t.fireId === fire.id);
  const droppers = board.response.aircraft.some((a) => a.fireId === fire.id && a.kind !== "air_attack");
  if (assigned.length === 0 && !droppers) return; // nothing to choose a tactic for yet
  // AI agent only: the tactic is the commander's (set_strategy; without one, direct attack, the
  // structure attack on developed ground: demo/strategyOptions.ts commanderTactic). The board
  // switches tactics by flame length only in the rule-based response (autoDispatch, scripts).
  const commanded = commanderTactic(board, fire);
  const tactic =
    commanded ??
    (() => {
      const holds = directHolds(board, fire, teams);
      const assignedHolds = Math.max(holds, droppers ? DROP_HOLDS_FLAME_FEET : 0, ...assigned.map((t) => holdsFlameFeet(t.kind)));
      const parallelNeed = (t: number) => lineNeededMeters("parallel", perimeterIn(board, fire, t), null);
      const parallelFeasible = [30, 60, 120].some((t) => projectedLine(board, fire, "parallel", t) >= parallelNeed(t));
      return chooseTactic({
        structure: structureFront(board, fire),
        crowning: fire.rates.crowning,
        headFlameFeet: fire.rates.headFlameFeet,
        directHoldsFeet: assignedHolds,
        parallelFeasible,
      });
    })();
  if (tactic !== fr.tactic && commanded !== undefined) {
    // What the commander's order means changed with the fuel at the head (direct <-> structure); not a choice.
    fr.tactic = tactic;
    fr.target = null;
  } else if (tactic !== fr.tactic) {
    logEvent(board, "team", "board", `${fire.id}: ${TACTIC_LABEL[tactic].toLowerCase()} (head flame ${fire.rates.headFlameFeet.toFixed(1)} ft${fire.rates.crowning ? ", crowning" : ""}).`, {
      action: "tactic",
      fireId: fire.id,
      label: TACTIC_LABEL[tactic],
    });
    fr.tactic = tactic;
    fr.target = null;
  }
  if (tactic === "indirect" && fr.target === null) {
    let chosen = INDIRECT_LEAD_MINUTES[INDIRECT_LEAD_MINUTES.length - 1] as number;
    for (const lead of INDIRECT_LEAD_MINUTES) {
      if (projectedLine(board, fire, "indirect", lead) >= perimeterIn(board, fire, lead)) {
        chosen = lead;
        break;
      }
    }
    fr.target = { minute: board.minute + chosen, perimeterM: perimeterIn(board, fire, chosen) };
  }
  fr.tacticAt = board.minute;
}

/**
 * Ground line the fire's direct-attack units build over the step (from, from + dt], with the
 * units as they were at the step's start (model.ts stepOnce calls it before anything else in the
 * step changes them; step() lands on every arrival, start of work and empty tank), so the line
 * is the same however the clock's ticks divide the time.
 */
export function accrueContainmentLine(board: Board, fire: Fire, from: number, dt: number): void {
  const fr = board.response.fires.get(fire.id);
  if (!fr || dt <= 0 || fire.status !== "burning") return;
  const teams = builders(board, fire, from);
  if (teams.length > 0) fr.groundLineM += tacticLineRate(board, fire, teams, fr.tactic, from) * dt;
}

/**
 * The containment race on a burning fire after a step (ground line accrues in
 * accrueContainmentLine). Returns true when the fire is contained this step (the caller marks it
 * contained). The tactic review, the cap to the reachable edge and the seeded holding test run
 * only when `decide` (model.ts stepOnce: the clock is on a whole minute), so the line, the number
 * of draws and the minute they happen do not depend on the tick size.
 */
export function advanceContainment(board: Board, fire: Fire, decide = true): boolean {
  const fr = board.response.fires.get(fire.id);
  if (!fr) return false;
  const teams = builders(board, fire);
  if (decide && board.minute - fr.tacticAt >= TACTIC_REVIEW_MINUTES) reviewTactic(board, fire, fr, teams);
  if (teams.length === 0 && fr.airLineM <= 0) return false;
  const needed = lineNeededMeters(fr.tactic, fire.perimeterM, fr.target?.perimeterM ?? null);
  // Ground line covers at most the share of the edge within reach of the units working it
  // (response/reach.ts); aircraft line can cover the rest. Line cannot exceed what the tactic
  // needs; flank line is outflanked as the perimeter grows.
  if (decide) fr.groundLineM = Math.min(needed * (reachFraction(board, fire, fr) ?? 1), fr.groundLineM);
  fire.lineM = Math.min(needed, fr.groundLineM + fr.airLineM);
  if (!decide) return false;
  // Aircraft lay line, but only ground resources on scene finish and hold it (retardant supports ground forces).
  if (fr.tactic === "flank" || teams.length === 0) return false;
  if (fr.tactic === "indirect" && fr.target) {
    if (board.minute < fr.target.minute) return false;
    if (fire.lineM < fr.target.perimeterM) {
      breach(board, fire, fr, "the fire reached an unfinished indirect line");
      return false;
    }
  } else if (fire.lineM < needed - 1e-6) return false;
  if (board.minute < fr.retryAt) return false;
  // No ground line holds a crowning head (only reachable with a commanded tactic: the rule-based choice is flank then).
  if (fire.rates.crowning && fr.tactic !== "structure") return false;
  // Direct attack waits for a unit whose line holds the head (crews alone at 4-8 ft do not test it).
  if (fr.tactic === "direct" && directHolds(board, fire, teams) < fire.rates.headFlameFeet) return false;
  const holds = tacticHoldsFeet(fr.tactic, directHolds(board, fire, teams));
  const test = holdingTest(board.response.rng, fire.rates.headFlameFeet, holds);
  if (test.held) return true;
  breach(board, fire, fr, `a ${test.flameFeet.toFixed(1)} ft flame crossed the line (holds ${holds} ft)`);
  return false;
}

function breach(board: Board, fire: Fire, fr: FireResponse, why: string): void {
  fire.lineM *= 1 - BREACH_LINE_LOSS_SHARE;
  fr.groundLineM *= 1 - BREACH_LINE_LOSS_SHARE;
  fr.airLineM *= 1 - BREACH_LINE_LOSS_SHARE;
  fr.breaches += 1;
  fr.retryAt = board.minute + BREACH_RETRY_MINUTES;
  fr.target = null;
  fr.tacticAt = -Infinity;
  board.response.stats.breaches += 1;
  logEvent(board, "team", "board", `${fire.id}: line breached, ${why}; ${Math.round(BREACH_LINE_LOSS_SHARE * 100)}% of the line lost.`, { action: "line_breached", fireId: fire.id });
}

/** At containment: the IA record, and every unit beyond the mop-up detail is released. */
export function onContained(board: Board, fire: Fire): void {
  const fr = board.response.fires.get(fire.id);
  if (fr) {
    fr.containedHa = fire.areaHa;
    if (fr.ia === "in_progress") {
      // CAL FIRE's goal metric: contained at 10 acres or less (whatever resources it took).
      if (fire.areaHa <= IA_SUCCESS_MAX_HA) {
        fr.ia = "contained";
        board.response.stats.iaContained += 1;
      } else {
        fr.ia = "failed";
        board.response.stats.iaFailed += 1;
      }
    }
  }
  const keep: Record<string, number> = { ...MOPUP_KEEP };
  const assigned = board.teams
    .filter((t) => t.fireId === fire.id)
    .sort((a, b) => Number(a.demobilise) - Number(b.demobilise) || distanceM(a.home, fire.origin) - distanceM(b.home, fire.origin));
  for (const t of assigned) {
    const family = groundFamilyOf(t.kind);
    if (t.status === "on_scene" && (keep[family] ?? 0) > 0) {
      keep[family] -= 1;
      continue;
    }
    sendHome(board, t);
  }
  for (const a of board.response.aircraft) if (a.fireId === fire.id) releaseAircraft(board, a);
  // Orders not yet on the board are cancelled; unused mutual-aid units go back to their pool.
  for (const o of board.response.orders) {
    if (o.fireId !== fire.id || (o.status !== "pending" && o.status !== "unable_to_fill")) continue;
    o.status = "cancelled";
    if (o.tier === "mutual_aid") board.response.pool.push(...o.seeds);
  }
}

/**
 * Escalation: when initial attack fails (the fire passes the IA size, a line is breached, or the
 * units on scene cannot catch it), the stage's extended-attack orders are placed; later stages
 * by size.
 */
export function escalate(board: Board, fire: Fire, iaCannotCatch: () => boolean): void {
  const r = board.response;
  const fr = r.fires.get(fire.id);
  // Report rule: no escalation (nor IA record) for a fire dispatch does not have yet; at the
  // report a fire already past a stage's size escalates on the next step.
  if (!fr || fire.status !== "burning" || board.minute < fr.reportAt) return;
  // Initial attack has failed once a burning fire is past the IA size (CAL FIRE goal metric).
  if (fr.ia === "in_progress" && fire.areaHa > IA_SUCCESS_MAX_HA) {
    fr.ia = "failed";
    r.stats.iaFailed += 1;
  }
  if (fr.stage >= ESCALATION_ORDERS.length) return;
  const acres = fire.areaHa / HECTARES_PER_ACRE;
  let why: string | null = null;
  if (acres >= ESCALATION_STAGE_ACRES[fr.stage]) why = `${Math.round(acres)} acres, past ${ESCALATION_STAGE_ACRES[fr.stage]}`;
  else if (fr.stage === 0 && fr.breaches > 0) why = "line breached in initial attack";
  else if (fr.stage === 0 && fr.firstArrivalAt !== null && board.minute - fr.tacticAt < 1 && iaCannotCatch()) why = "initial attack cannot catch it";
  if (!why) return;
  const order = ESCALATION_ORDERS[fr.stage];
  fr.stage += 1;
  if (!r.autoEscalate) {
    logEvent(board, "team", "board", `${fire.id}: extended attack stage ${fr.stage} due (${why}); nothing is ordered unless the AI agent (or you) orders it.`, {
      action: "escalation_due",
      fireId: fire.id,
      stage: fr.stage,
    });
    return;
  }
  const parts: [Orderable, number][] = [
    ["engine_strike_team", order.engine_strike_teams],
    ["crew_strike_team", order.crew_strike_teams],
    ["dozer_strike_team", order.dozer_strike_teams],
    ["airtanker", order.airtankers],
    ["helicopter", order.helicopters],
  ];
  for (const [res, n] of parts) if (n > 0) placeOrder(board, fire, res, n, "board", `stage ${fr.stage}: ${why}`, fr.stage);
}

/** Departments with their engine counts (for the observation). */
export function departmentStatus(board: Board): { id: string; name: string; tier: Tier; engines: number; engines_available: number; keep_engines: number }[] {
  return board.response.departments.map((d) => ({
    id: d.id,
    name: d.name,
    tier: d.tier,
    engines: d.engines,
    engines_available:
      d.tier === "closest"
        ? board.teams.filter((t) => t.department === d.id && isEngine(t.kind) && t.status === "available").length
        : board.response.pool.filter((s) => s.departmentId === d.id && isEngine(s.kind)).length,
    keep_engines: d.keepEngines,
  }));
}

// ---- off-road reach (response/reach.ts) ----

/**
 * A sample of the fire's open edge now: its burned cells that face unburned ground the solver
 * can spread into, at most MAX_EDGE_POINTS, as WGS84 points.
 */
function edgeSample(board: Board, fire: Fire, minute: number): LonLat[] {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return [];
  const grid = board.env.landscape;
  const cells = field.cellsBySource[s];
  const burned = countAtMost(field.arrivalBySource[s], minute);
  const w = grid.width;
  const open = (n: number) => n >= 0 && n < field.arrivalMinutes.length && field.arrivalMinutes[n] > minute && field.behaviour.headRateMetersPerMinute[n] > 0;
  const edge: number[] = [];
  for (let i = 0; i < burned; i += 1) {
    const c = cells[i];
    const x = c % w;
    if (open(c - w) || open(c + w) || (x > 0 && open(c - 1)) || (x < w - 1 && open(c + 1))) edge.push(c);
  }
  const stride = Math.max(1, Math.ceil(edge.length / MAX_EDGE_POINTS));
  const out: LonLat[] = [];
  for (let i = 0; i < edge.length; i += stride) out.push(cellLonLat(grid, edge[i]));
  return out;
}

/**
 * The edge sample, taken at the latest whole REACH_EVERY_MINUTES board minute (so it does not
 * depend on when a step happened to ask).
 */
function edgeOf(board: Board, fire: Fire, fr: FireResponse): LonLat[] {
  const bucket = Math.floor((board.minute + 1e-6) / REACH_EVERY_MINUTES) * REACH_EVERY_MINUTES;
  if (!fr.reach || fr.reach.minute !== bucket) {
    fr.reach = { minute: bucket, edge: edgeSample(board, fire, bucket), fraction: null };
  }
  return fr.reach.edge;
}

/**
 * Share of the fire's edge within reach of the ground units on scene (each within its reach
 * radius of where it parked), or null when no ground unit is on scene (unknown: not capped).
 */
export function reachFraction(board: Board, fire: Fire, fr: FireResponse | null = board.response.fires.get(fire.id) ?? null): number | null {
  if (!fr) return null;
  // Direct-attack units only: a unit building an attack line works its line, not the fire's edge.
  const units = board.teams.filter((t) => t.fireId === fire.id && t.lineId === null && (t.status === "on_scene" || t.status === "refilling") && t.workMode !== null);
  if (units.length === 0) return null;
  const edge = edgeOf(board, fire, fr);
  if (edge.length === 0) return 1;
  // Cached for the sample and the units working it (who is on scene changes between samples).
  const key = units.map((t) => `${t.id}:${t.workMode}:${t.reachM}`).join(",");
  if (fr.reach && fr.reach.fraction !== null && fr.reach.unitsKey === key) return fr.reach.fraction;
  let inside = 0;
  for (const p of edge) {
    if (units.some((t) => !offEdge(t.workMode) && distanceM(t.position, p) <= t.reachM)) inside += 1;
  }
  const fraction = inside / edge.length;
  if (fr.reach) {
    fr.reach.fraction = fraction;
    fr.reach.unitsKey = key;
  }
  return fraction;
}

/**
 * Why a unit on scene at a burning fire does no work now ("standing there"), or null when it
 * works or is about to: parked out of reach (work mode out_of_reach: of the fire's edge on direct
 * attack, of its line's anchor on an attack line), or on direct attack with no point of the
 * fire's open edge (the same sample as reachFraction) within its reach radius. A unit still
 * hiking in (workStartAt ahead), building an attack line or with unknown access is not counted.
 * Model output (the reach model and the solver's edge), for the agent's monitor.
 */
export function idleOnSceneReason(board: Board, team: Team): string | null {
  if (team.status !== "on_scene" || team.fireId === null) return null;
  const fire = board.fires.find((f) => f.id === team.fireId);
  if (!fire || fire.status !== "burning") return null;
  if (team.workMode === "out_of_reach") {
    const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
    const what = line ? `its ${fire.id} ${line.plan.id} line` : fire.id;
    return team.parkedM !== null && team.accessKnown
      ? `parked ${distanceText(team.parkedM)} from ${what}, too far to build line`
      : `too far from ${what} to build line`;
  }
  if (team.workMode === null || team.lineId !== null) return null;
  if (team.workStartAt !== null && team.workStartAt > board.minute) return null;
  const fr = board.response.fires.get(fire.id);
  if (!fr) return null;
  const edge = edgeOf(board, fire, fr);
  if (edge.length === 0 || edge.some((p) => distanceM(team.position, p) <= team.reachM)) return null;
  return `no open edge of ${fire.id} within its ${Math.round(team.reachM)} m reach`;
}

/**
 * How a ground unit parked at `parked` works ground at `target` (response/reach.ts planWork):
 * the straight-line distance, the climb between the two on the landscape's elevation, and the
 * steepest slope sampled at 11 points on the way. Used for direct attack (target: the nearest
 * point of the fire's open edge) and for an attack line (target: the line's anchor point).
 */
export function accessWorkPlan(board: Board, kind: GroundResponseKind, parked: LonLat, target: LonLat): WorkPlan & { distanceM: number } {
  const ground = board.env.spread.ground;
  const grid = board.env.landscape;
  const elev = (p: LonLat) => {
    const c = cellAt(grid, { longitude: p[0], latitude: p[1] });
    return c >= 0 ? grid.elevationMeters[c] : 0;
  };
  let maxSlopePct = 0;
  for (let i = 0; i <= 10; i += 1) {
    const p: LonLat = [parked[0] + ((target[0] - parked[0]) * i) / 10, parked[1] + ((target[1] - parked[1]) * i) / 10];
    maxSlopePct = Math.max(maxSlopePct, ground.slopeAt(p).slopeTangent * 100);
  }
  const d = distanceM(parked, target);
  return { ...planWork(kind, d, elev(target) - elev(parked), maxSlopePct), distanceM: d };
}

/** The fire's open-edge sample now (the same one reachFraction and idleOnSceneReason read), WGS84 points; [] without a solve. */
export function fireEdgeSample(board: Board, fire: Fire): LonLat[] {
  const fr = board.response.fires.get(fire.id);
  return fr ? edgeOf(board, fire, fr) : edgeSample(board, fire, board.minute);
}

/**
 * A unit reaches the end of its road leg: it parks there (the leg's last point; without a road
 * leg the access is unknown and it is taken to park at its target, labelled), and the work plan
 * sets how it attacks: hose within reach, hike in and build hand line, walk a dozer in, or out
 * of reach (response/reach.ts planWork).
 */
export function arriveOnScene(board: Board, team: Team, fire: Fire): void {
  const road = team.route && team.route.length > 1 && team.travel !== "straight_line";
  const parked = road ? team.route![team.route!.length - 1] : (team.target ?? crewTarget(fire));
  // Work starts from its arrival minute (step() lands on it), not from the step that noticed it.
  const arrivedAt = Math.min(board.minute, team.arriveAt ?? board.minute);
  team.position = parked;
  team.status = "on_scene";
  team.departAt = team.arriveAt = team.rollAt = null;
  team.route = null;
  team.accessKnown = !!road;
  const fr = board.response.fires.get(fire.id);
  const edge = fr ? edgeOf(board, fire, fr) : [];
  let nearest: LonLat = fire.target;
  let d = distanceM(parked, nearest);
  for (const p of edge) {
    const dp = distanceM(parked, p);
    if (dp < d) {
      d = dp;
      nearest = p;
    }
  }
  const plan = accessWorkPlan(board, team.kind, parked, nearest);
  team.workMode = plan.mode;
  team.workStartAt = arrivedAt + plan.startDelayMinutes;
  team.parkedM = d;
  team.reachM = plan.reachMeters;
  if (fr) fr.reach = null; // recompute the reachable share with this unit
  if (fr && fr.firstEngineAt === null && isEngine(team.kind)) fr.firstEngineAt = board.minute;
  noteArrival(board, fire);
  if (plan.mode === "hand_line" || plan.mode === "dozer" || plan.mode === "indirect" || plan.mode === "out_of_reach") {
    logEvent(board, "team", "board", unitAccessText(board, team), { action: "unit_access", teamIds: [team.id], fireId: fire.id, workMode: plan.mode });
  }
}

/** Builds no line on the fire edge: out of reach, or holding its road as indirect line. */
function offEdge(mode: WorkMode | null): boolean {
  return mode === "out_of_reach" || mode === "indirect";
}

const MODE_TEXT: Record<WorkMode, string> = {
  hose: "working the edge with hose",
  hand_line: "hiking in to build hand line",
  dozer: "walking the dozer in",
  indirect: "indirect: holding the road it parked on (too far to reach the edge in time)",
  out_of_reach: "too far from the fire to build line",
};

/** "830 m" / "1.2 km" (ground metres, for labels). */
export function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}

/** Plain language for a unit on scene: "E12 parked 600 m from F3 — hiking in to build hand line, ~14 min". */
export function unitAccessText(board: Board, team: Team): string {
  if (team.status !== "on_scene" && team.status !== "refilling") return "";
  if (team.workMode === null || team.parkedM === null) return `${team.id} on scene.`;
  const wait = team.workStartAt !== null ? Math.ceil(team.workStartAt - board.minute) : 0;
  // A unit building an attack line parks for its line's anchor, not for the fire's edge.
  const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
  const what = line ? `its ${line.fireId} ${line.plan.id} line` : team.fireId;
  const where = team.accessKnown ? `parked ${distanceText(team.parkedM)} from ${what}` : `at ${what} (road access not known; straight-line estimate)`;
  const mode = MODE_TEXT[team.workMode];
  return `${team.id} ${where} — ${wait > 0 ? `${mode}, ~${formatDuration(wait)}` : team.workMode === "hand_line" ? "building hand line" : team.workMode === "dozer" ? "cutting dozer line" : mode}.`;
}

/** Plain language for a fire's reachable edge, or null when it is all within reach (or unknown). */
export function reachText(board: Board, fire: Fire): string | null {
  const f = reachFraction(board, fire);
  if (f === null || f >= 0.995) return null;
  return `Only ${Math.round(f * 100)}% of this fire's edge is within reach of ground crews.`;
}

/** Pacific wall-clock "14:02" for a board minute (the board's clock starts at the wind series' T+0). */
export function wallClock(board: Board, minute: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(board.response.startEpochMs + minute * 60_000),
  );
}

/**
 * "Reported after 34 min — 4 km from the nearest home, at night" / "Reported after 15 min —
 * report time set in Simulation Studio (S1, 15 min after ignition), not modelled", or null before the report.
 */
export function reportText(board: Board, fire: Fire): string | null {
  const fr = board.response.fires.get(fire.id);
  if (!fr || board.minute < fr.reportAt) return null;
  return `Reported after ${Math.round(fr.reportAt - fire.ignitedAt)} min — ${fr.report.reason}.`;
}

/** For the drill controller's views: "Not yet reported (simulated): reported at T+00:15, set in Simulation Studio", or null once reported. */
export function notReportedText(board: Board, fire: Fire): string | null {
  const fr = board.response.fires.get(fire.id);
  if (!fr || board.minute >= fr.reportAt || fire.status === "out") return null;
  return `Not yet reported (simulated): reported to dispatch at ${simClock(fr.reportAt)} (${wallClock(board, fr.reportAt)}), ${fr.report.by === "studio" ? "set in Simulation Studio" : "modelled report delay"}. No unit can act on it before then.`;
}

/** Map / 3D label of a fire: "S1-F1", "S1-F1 · contained", or "S1-F1 · not yet reported (sim)". */
export function fireMapLabel(board: Board, fire: Fire): string {
  if (fire.status !== "burning") return `${fire.id} · ${fire.status}`;
  return isReported(board, fire) ? fire.id : `${fire.id} · not yet reported (sim)`;
}

/** "Started 14:02 · reported 14:11 · first engine 14:24" (only what has happened). */
export function fireTimeline(board: Board, fire: Fire): string {
  const fr = board.response.fires.get(fire.id);
  const parts = [`Started ${wallClock(board, fire.ignitedAt)}`];
  if (fr) {
    if (board.minute >= fr.reportAt) {
      parts.push(`reported ${wallClock(board, fr.reportAt)}${fr.report.by === "studio" ? " (set in Studio)" : ""}`);
    } else parts.push(`not yet reported (simulated; reports ${wallClock(board, fr.reportAt)}${fr.report.by === "studio" ? ", set in Studio" : ", modelled"})`);
    if (fr.firstEngineAt !== null) parts.push(`first engine ${wallClock(board, fr.firstEngineAt)}`);
    else if (fr.firstArrivalAt !== null) parts.push(`first unit ${wallClock(board, fr.firstArrivalAt)}`);
  }
  return parts.join(" · ");
}
