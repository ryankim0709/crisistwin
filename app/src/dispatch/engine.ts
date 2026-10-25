/**
 * Dispatch simulation: households, evacuation traffic and fire engines over the area road
 * graph, stepped one simulation minute at a time against a precomputed fire run.
 * Deterministic, no randomness, no network. The agent only issues orders (`applyOrders`);
 * every route, travel time, flow and count comes from here. See docs/adr/0014-dispatch-agent.md
 * and docs/adr/0017-dispatch-anywhere.md.
 *
 * Model, deliberately simple and visible in the UI:
 * - Every synthetic home is one household with the zone's average vehicles per home. Homes
 *   leave only on an evacuation order for their zone, one at a time in the area's departure
 *   order, spread uniformly over DEPARTURE_SPREAD_MINUTES (shorter while an engine supports
 *   the zone). Optionally (`setHouseholdBehavior`, population/householdBehavior.ts) each home
 *   instead leaves on its own triggers: its drawn delay after the order, its drawn delay after
 *   the fire reaches its zone (the neighbourhood cue; with no order only shadow and
 *   wait-and-see households), or at once when the fire comes within FIRE_CUE_NEAR_METERS of
 *   the house (the near cue), whichever is first; a household asleep at its first trigger
 *   (`setClock`) first takes WAKE_UP_MINUTES. Households staying by choice never leave.
 *   Households that leave with no order for their zone take the fastest exit they can reach.
 * - Households that have left queue at one of their zone's loading points (up to
 *   LOADING_POINTS_PER_ZONE road nodes spread over the zone; each home uses the nearest) and
 *   enter that point's route at most at its bottleneck capacity; routes that share an edge
 *   split its capacity. Downstream queues are not modelled: once released, a group drives at
 *   free-flow speed.
 * - Routing avoids every edge the fire model reaches within ROUTE_LOOKAHEAD_MINUTES, and every
 *   edge the planner has closed (a road closure, a failed bridge, or a planner-confirmed
 *   reported closure from src/intel/closures.ts). Closures passed at start hold for the whole
 *   run; `setRoadClosed` closes or reopens a road mid-run
 *   (docs/adr/0030-live-road-closures.md). Drivers already on the road re-route around such edges by themselves; a zone whose ordered exit becomes
 *   unreachable holds departures until it is given another exit, and a zone that can reach
 *   no exit at start is alerted.
 * - A household is "caught" (reported as "still home when the fire arrived", or "reached by
 *   fire after leaving home") when the modelled fire reaches its home before it leaves, its
 *   loading point while it queues there, or the road it is on. Households staying by choice
 *   are counted apart (`caughtByChoice`). Fire reaching a zone's core (loading node or
 *   centroid) marks the zone overrun: no more orders, but households still home there can
 *   still leave on a cue. This is a model count, not a casualty estimate.
 * - Engines drive at the same free-flow speeds, ignoring congestion; a station outside the
 *   road box first covers its straight-line approach at APPROACH_SPEED_KPH. With apparatus
 *   access on (`setApparatusAccess`, the agent's session) each unit is a ground apparatus kind
 *   (studio/apparatus.ts) routed only over the roads its road-access class may use (rules
 *   R01-R12, studio/roadAccess.ts; service roads and tracks included) at that class's speed, with
 *   the kind's turnout and line rate; a unit kept from a target by those rules gets "no access"
 *   and the rule (`noAccessTo`, `attackNoAccess`). Closed roads stay closed to every class. "Evacuation
 *   support" shortens a zone's departure spread; "structure defense" has no modelled effect on
 *   the fire.
 * - Fire attack: engines sent to a fire (`attack_fire`) stage at the reachable road node nearest
 *   its ignition point (routing as above) and build line once there (fireAttack.ts). When
 *   the line rings the fire it is out: the engine records it and returns the crews, and the
 *   session re-solves the fire without it and swaps the new exposure in (`setExposure`). Until
 *   then the fire follows the precomputed run.
 * - Staged waves: a zone can be staged behind another ordered or staged zone. It gets its
 *   order automatically once every household of that zone has left home and the loading
 *   queue (the road is free for the next wave), or earlier when its own order slack falls to
 *   STAGE_RELEASE_SLACK_MINUTES. Order slack is this module's estimate, not the agent's.
 * - Every order, staging, release and blocked route records a resident notice: what the
 *   households of that zone would be told. Notices are simulated; nothing is sent anywhere.
 */

import { groundMeters, roadLabel, type DispatchArea, type LonLat } from "./area";
import { HAND_CREW_MAX_HIKE_MINUTES, hikeMinutes, toblerKmh } from "../response/reach";
import { IA_SUCCESS_MAX_ACRES, IA_SUCCESS_MAX_HA, WILDLAND_RUN_CARDS } from "../response/runCards";
import type { FireExposure } from "./fireExposure";
import {
  NEAR_CUE_EXTRA_MINUTES,
  WAKE_UP_MINUTES,
  sleepingAt,
  type HouseholdBehavior,
} from "../population/householdBehavior";
import { tacticBlocked, type FireTactic } from "./fireTactics";
import type { LinePlan } from "../studio/firefighting";
import {
  GROUND_APPARATUS,
  grassRateMetersPerHour,
  type AccessClass,
  type GroundKind,
} from "../studio/apparatus";
import { RULE_TEXT, type EdgeAccess, type RoadRule } from "../studio/roadAccess";
import {
  DISPATCH_ENGINE_KIND,
  ENGINE_LINE_METERS_PER_MINUTE,
  fireAreaAt,
  lineNeededMeters,
  projectOutMinute,
  type FireAreaFrame,
  type FireTarget,
} from "./fireAttack";
import {
  edgeSeconds,
  pointAlongStep,
  routeCoords,
  routeTo,
  shortestPathTree,
  stepHead,
  type PathStep,
  type Route,
  type ShortestPathTree,
} from "./routing";

/** The live monitor checks the simulation this often by default (simulated minutes). */
export const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
export const CHECK_INTERVAL_CHOICES = [1, 2, 5, 10] as const;
/** Without any change, the agent still reviews the situation this often. */
export const MAX_QUIET_MINUTES = 30;
/** An urgent alert can bring a check forward, but never closer than this to the last decision. */
export const MIN_DECISION_GAP_MINUTES = 3;
/** A staged zone is released on its own when its order slack falls to this many minutes. */
export const STAGE_RELEASE_SLACK_MINUTES = 5;
/** Routing avoids edges the fire model reaches within this many minutes. */
export const ROUTE_LOOKAHEAD_MINUTES = 10;
/** The agent sees modelled fire arrival this far ahead. */
export const FORECAST_LOOKAHEAD_MINUTES = 60;
/** Assumed spread of household departures after an order, minutes. */
export const DEPARTURE_SPREAD_MINUTES = 45;
export const SUPPORTED_DEPARTURE_SPREAD_MINUTES = 20;
/** Engines on scene withdraw when the fire is this close to the zone core. */
export const UNIT_WITHDRAW_MARGIN_MINUTES = 5;
/** Assumed speed over a station's straight-line approach to the road box. */
export const APPROACH_SPEED_KPH = 40;
/** NFPA 1710 turnout for fire calls: an engine leaves its station 80 s after the order. */
export const TURNOUT_SECONDS = 80;
/**
 * With apparatus access on, a fire farther than this from every road a unit's class can use is
 * out of that unit's reach (the Studio crew dispatch's limit, studio/crewDispatch.ts).
 */
export const MAX_ROAD_GAP_METERS = 1500;
/**
 * Fire attack: a unit stages at the nearest reachable road node and its crew walks the rest
 * (response/reach.ts: Tobler off-path pace, flat ground assumed here), attacking only if the
 * walk takes at most HAND_CREW_MAX_HIKE_MINUTES (labelled assumption there).
 */
const MAX_ATTACK_WALK_METERS = (HAND_CREW_MAX_HIKE_MINUTES / 60) * toblerKmh(0) * 1000;
/**
 * Initial attack cap per fire: CAL FIRE's high dispatch-level run card's ground units
 * (response/runCards.ts WILDLAND_RUN_CARDS.high). ASSUMPTION: the high card is used as the cap
 * whatever the day's level; more units only once the fire passes the IA success size.
 */
const IA_GROUND_CAP =
  WILDLAND_RUN_CARDS.high.engines + WILDLAND_RUN_CARDS.high.hand_crews + WILDLAND_RUN_CARDS.high.dozers;
export const EXIT_OPTIONS_PER_ZONE = 3;
/**
 * Road nodes a zone's households load through. ASSUMPTION (no source): 4, spread over the zone
 * by farthest-point sampling of the nodes nearest its homes, starting from its main loading
 * node; each household enters at the nearest of them, i.e. it drives out of the neighbourhood
 * by the nearest of a few streets rather than all through one node.
 */
export const LOADING_POINTS_PER_ZONE = 4;
const SECONDS_PER_MINUTE = 60;
const VEHICLE_EPSILON = 0.01;
const MAX_ALERTS = 200;
const MAX_NOTICES = 300;
/** Bound on staging chains walked for waves and cycle checks; zones are capped at 60. */
const MAX_CHAIN = 64;

/** Household states, in the order a household moves through them. */
export const HomeStatus = {
  /** No evacuation order for its zone yet. */
  idle: 0,
  /** Ordered, still at home (getting ready). */
  ordered: 1,
  /** Left home, queued at the zone's loading point for road capacity. */
  queued: 2,
  driving: 3,
  safe: 4,
  caught: 5,
} as const;
export type HomeStatus = (typeof HomeStatus)[keyof typeof HomeStatus];

export type ZoneStatus = "no_order" | "ordered" | "cleared" | "overrun";
/**
 * Where a zone sits relative to the modelled fire, from its first fire contact: fire already
 * there, forecast within FORECAST_LOOKAHEAD_MINUTES, forecast later within the horizon, or not
 * forecast to reach it by the horizon at all ("outside" the fire path).
 */
export type ZoneImpact = "burning" | "threatened" | "later" | "outside";
export type UnitStatus = "available" | "en_route" | "on_scene" | "returning" | "stranded";
export type UnitTask = "evacuation_support" | "structure_defense" | "fire_attack";

export interface ZoneState {
  index: number;
  status: ZoneStatus;
  exitId: string | null;
  /** 1 for the first zone ordered to leave, 2 for the next, … */
  orderRank: number | null;
  orderedMinute: number | null;
  clearedMinute: number | null;
  route: Route | null;
  routeBlocked: boolean;
  /** Households not yet out of their homes (idle or ordered). */
  atHome: number;
  queued: number;
  onRoad: number;
  safe: number;
  /** Households reached by the fire before getting out (all kinds below). */
  caught: number;
  /** Of `caught`: households staying home by choice. */
  caughtByChoice: number;
  /** Of `caught`: households that had left home (queued at a loading point or driving). */
  caughtOnRoad: number;
  /**
   * Exit households take when they leave on a fire cue with no order for the zone (the fastest
   * reachable), or when the zone is overrun and its ordered route is cut; null when none yet.
   */
  selfExitId: string | null;
  fireContact: boolean;
  /** Set while the zone waits for its wave: no order yet, released by the engine. */
  stage: ZoneStage | null;
  /** Wave the zone left in: 1 when ordered directly, predecessor's wave + 1 when released. */
  wave: number | null;
}

export interface ZoneStage {
  exitId: string;
  /** Zone index whose households must be on the road before this one is told to leave. */
  after: number;
  stagedMinute: number;
}

/** What a zone's households would be told. Simulated: never delivered to anyone. */
export type NoticeKind = "leave_now" | "prepare" | "redirect" | "hold" | "all_clear";

export interface ResidentNotice {
  id: number;
  minute: number;
  zone: number;
  kind: NoticeKind;
  /** Households addressed: those of the zone not yet out (not the whole area). */
  homes: number;
  exitId: string | null;
  text: string;
}

/** One of a zone's loading points: households queue there for room on its route. */
interface LoadGroup {
  node: number;
  /** Home indices waiting here, first in first out. */
  queue: number[];
  releaseBudget: number;
  /** Route from `node` to the zone's current exit, or null when cut or not yet set. */
  route: Route | null;
}

interface ZoneWork {
  /** Offset (within the zone's homes) of the next household to leave. */
  nextDeparture: number;
  departBudget: number;
  /** Loading points; group 0 is the zone's main loading node (its route is `zone.route`). */
  groups: LoadGroup[];
  /** Home indices the fire reaches, by arrival; `fireNext` is the first not yet reached. */
  fireOrder: number[];
  fireNext: number;
  vehiclesPerHome: number;
}

interface Packet {
  id: number;
  zone: number;
  homes: number[];
  vehicles: number;
  exitId: string;
  steps: PathStep[];
  stepIndex: number;
  stepElapsedSeconds: number;
  stuck: boolean;
}

/** Why a unit's road-access class keeps it from a target (studio/roadAccess.ts rules). */
export interface NoAccess {
  /** R01-R10; null when no single rule decides (e.g. no class road within reach of a fire). */
  rule: RoadRule | null;
  why: string;
  road: string | null;
}

export interface UnitState {
  id: string;
  /** Ground apparatus kind (studio/apparatus.ts); a Type 3 engine unless set otherwise. */
  kind: GroundKind;
  stationId: string;
  homeNode: number;
  status: UnitStatus;
  task: UnitTask | null;
  /** Zone index the unit is heading to or working in. */
  zone: number | null;
  /** Fire index (into `DispatchEngine.fires`) the unit is attacking. */
  fire: number | null;
  /** Node the unit drives to: the zone's loading node, or its staging node at a fire. */
  targetNode: number | null;
  /** Node the unit is at, or the tail of the edge it is on. */
  node: number;
  steps: PathStep[];
  stepIndex: number;
  stepElapsedSeconds: number;
  /** Seconds still to cover on a station's approach before driving the route. */
  holdSeconds: number;
  /** Minute the unit arrived on scene, for the crews panel. */
  arrivedMinute: number | null;
  /** Minutes the crew walks from its staging node to the fire before it can build line. */
  walkMinutes?: number;
}

export type AlertType =
  | "ignition"
  | "fire_contact"
  | "homes_caught"
  | "zone_overrun"
  | "route_blocked"
  | "route_changed"
  | "zone_cleared"
  | "unit_arrived"
  | "unit_withdrawn"
  | "unit_stranded"
  | "vehicles_exposed"
  | "wave_released"
  | "fire_out"
  | "fire_held"
  | "road_closed"
  | "road_reopened"
  | "self_evacuation";

/** A road closed by the planner: at start (minute 0) or mid-run. */
export interface RoadClosure {
  edge: number;
  minute: number;
}

export interface Alert {
  minute: number;
  type: AlertType;
  text: string;
  /** Alerts that should bring the next agent decision forward. */
  urgent: boolean;
}

export type Order =
  | { type: "order_evacuation"; zone_id: string; exit_id: string; reason: string }
  | {
      type: "stage_evacuation";
      zone_id: string;
      exit_id: string;
      after_zone_id: string;
      reason: string;
    }
  | { type: "dispatch_unit"; unit_id: string; zone_id: string; task: UnitTask; reason: string }
  | {
      type: "attack_fire";
      unit_id: string;
      fire_id: string;
      /** How to fight it; "direct" when absent (fireTactics.ts). */
      tactic?: FireTactic;
      reason: string;
    }
  | { type: "recall_unit"; unit_id: string; reason: string };

export interface OrderOutcome {
  order: Order;
  accepted: boolean;
  /** Why it was rejected, or what the simulator did. */
  note: string;
}

/** Household counts (homes, not vehicles) across the area. */
export interface Totals {
  homes: number;
  vehicles: number;
  /** In zones with no order yet. */
  notOrdered: number;
  /**
   * Ordered, at home or queued at a loading point; plus households of unordered zones that
   * left on a fire cue and are queued.
   */
  waiting: number;
  /**
   * Of `waiting`, households at home that will not leave (only with per-household departure
   * delays; 0 otherwise). Always set by `totals()`.
   */
  staying?: number;
  onRoad: number;
  safe: number;
  /** Reached by the fire before getting out; of these, the two below. */
  caught: number;
  /** Of `caught`, households staying home by choice (only with household behaviour). */
  caughtByChoice?: number;
  /** Of `caught`, households that had left home (at a loading point or on the road). */
  caughtOnRoad?: number;
}

/** A fire engines can be sent to, and their progress against it. */
export interface FireAttackState {
  target: FireTarget;
  /** Grass-equivalent line built around it so far, metres. */
  lineMeters: number;
  /** Minute the engines put it out, or null while it burns. */
  outMinute: number | null;
  /** How the engines on it are fighting it, or null when none have been sent. */
  tactic: FireTactic | null;
  /** Control line planned and built around it by flank or indirect attack (incl. built part). */
  line: LinePlan | null;
  /** Minute a line tactic holds it (it stops growing), from the current run; else null. */
  heldMinute: number | null;
  /** The held alert was raised and its crews released. */
  heldAnnounced: boolean;
  /**
   * Minute the fire reaches dispatch (ignition + call-in/processing delay, response/report.ts),
   * or null while it has not ignited. Until then the dispatcher cannot see or order on it.
   */
  reportedMinute: number | null;
  /** The "reported" alert was raised. */
  reportAnnounced: boolean;
}

export interface IgnitionEvent {
  minute: number;
  name: string;
}

/** Households that reached an exit in one minute (read-only bookkeeping for the people view). */
export interface ExitArrival {
  minute: number;
  exitId: string;
  zone: number;
  homes: number;
}

/** A group of households on the road: where it is on its route, for the people view. */
export interface PacketState {
  id: number;
  zone: number;
  /** Edge it is on, or null when its route has no steps left. */
  edge: number | null;
  /** Travelling the edge from `from` to `to`. */
  forward: boolean;
  /** Fraction of the edge driven, 0..1. */
  fraction: number;
  homes: number;
  vehicles: number;
  exitId: string;
  /** No route to any exit avoiding fire and closures: held where it is. */
  stuck: boolean;
}

export interface VehicleGroup {
  id: number;
  zone: number;
  position: LonLat;
  /** A point a little further along the route, for heading. */
  ahead: LonLat;
  vehicles: number;
  stuck: boolean;
}

export class DispatchEngine {
  readonly area: DispatchArea;
  /** Replaced by `setExposure` when a fire is put out and re-solved. */
  exposure: FireExposure;
  readonly horizonMinutes: number;
  /** Fires engines can attack (empty unless `setFires` was called). */
  fires: FireAttackState[] = [];
  private fireFrames: FireAreaFrame[] = [];
  minute = 0;
  zones: ZoneState[];
  units: UnitState[];
  /** Per home (index into `area.homes`). */
  readonly homeStatus: Uint8Array;
  /** Per home, the minute it joined its zone's loading queue, or -1. Bookkeeping only. */
  private readonly queuedMinute: Int32Array;
  /** Households that reached each exit, oldest first. Bookkeeping only; never read by the model. */
  readonly exitArrivals: ExitArrival[] = [];
  /**
   * Per-household behaviour (population/householdBehavior.ts), or null for the uniform
   * DEPARTURE_SPREAD_MINUTES model. Set by `setHouseholdBehavior`.
   */
  private behavior: HouseholdBehavior | null = null;
  /** Per zone, households still at home that stay by choice (only with household behaviour). */
  private stayingAtHome: Int32Array;
  /**
   * Per home, the minute it can act on its triggers: its first trigger, plus WAKE_UP_MINUTES
   * when that fell in sleeping hours; NaN before any trigger.
   */
  private awakeAt: Float64Array;
  /** Per zone, the earliest near-cue minute of its homes (skips zones the fire is far from). */
  private zoneNearMin: Float64Array;
  /** Per home, its loading point (index into its zone's `groups`). */
  private readonly homeGroup: Uint8Array;
  /** UTC epoch ms of T+0, for sleeping hours; null: never asleep. Set by `setClock`. */
  private startEpochMs: number | null = null;
  alerts: Alert[] = [];
  notices: ResidentNotice[] = [];
  private nextNoticeId = 1;
  private work: ZoneWork[];
  private packets: Packet[] = [];
  private nextPacketId = 1;
  private nextOrderRank = 1;
  private exitIndex: Map<string, number>;
  private zoneIndex: Map<string, number>;
  private stationIndex: Map<string, number>;
  private ignitions: IgnitionEvent[];
  /** Edges closed to traffic (indices into `area.edges`); replaced, never mutated, on change. */
  private closed: ReadonlySet<number>;
  /** The planner's closures in effect, oldest first. */
  roadClosures: RoadClosure[];
  /**
   * Road access of every edge per apparatus class (studio/roadAccess.ts), or null: every unit
   * then drives public roads at free-flow speed (the Studio's evacuation run).
   */
  private access: readonly EdgeAccess[] | null = null;
  /**
   * When set (the agent's session), zones outside the modelled fire path cannot be ordered or
   * staged: evacuating them would only add traffic to the roads threatened zones need. The
   * studio's evacuate-everyone policy leaves it off.
   */
  restrictToFirePath = false;

  constructor(
    area: DispatchArea,
    exposure: FireExposure,
    horizonMinutes: number,
    ignitions: IgnitionEvent[],
    closedEdges: ReadonlySet<number> = new Set(),
  ) {
    this.area = area;
    this.closed = closedEdges;
    this.roadClosures = [...closedEdges].map((edge) => ({ edge, minute: 0 }));
    this.exposure = exposure;
    this.horizonMinutes = horizonMinutes;
    this.ignitions = [...ignitions].sort((a, b) => a.minute - b.minute);
    this.exitIndex = new Map(area.exits.map((exit, i) => [exit.id, i]));
    this.zoneIndex = new Map(area.zones.map((zone, i) => [zone.id, i]));
    this.stationIndex = new Map(area.stations.map((station, i) => [station.id, i]));
    this.homeStatus = new Uint8Array(area.homes.length);
    this.queuedMinute = new Int32Array(area.homes.length).fill(-1);
    this.stayingAtHome = new Int32Array(area.zones.length);
    this.awakeAt = new Float64Array(area.homes.length).fill(NaN);
    this.zoneNearMin = this.zoneNearMinutes(exposure);
    const loading = loadingPoints(area);
    this.homeGroup = loading.homeGroup;
    this.zones = area.zones.map((zone, index) => ({
      index,
      status: "no_order",
      exitId: null,
      orderRank: null,
      orderedMinute: null,
      clearedMinute: null,
      route: null,
      routeBlocked: false,
      atHome: zone.homes,
      queued: 0,
      onRoad: 0,
      safe: 0,
      caught: 0,
      caughtByChoice: 0,
      caughtOnRoad: 0,
      selfExitId: null,
      fireContact: false,
      stage: null,
      wave: null,
    }));
    this.work = area.zones.map((zone, index) => ({
      nextDeparture: 0,
      departBudget: 0,
      groups: loading.nodes[index].map((node) => ({ node, queue: [], releaseBudget: 0, route: null })),
      fireOrder: this.fireOrderOf(index),
      fireNext: 0,
      vehiclesPerHome: zone.homes > 0 ? zone.vehicles / zone.homes : 0,
    }));
    this.units = area.stations.flatMap((station) =>
      station.units.map((unit) => ({
        id: unit.id,
        kind: DISPATCH_ENGINE_KIND as GroundKind,
        stationId: station.id,
        homeNode: station.node,
        status: "available" as UnitStatus,
        task: null,
        zone: null,
        fire: null,
        targetNode: null,
        node: station.node,
        steps: [],
        stepIndex: 0,
        stepElapsedSeconds: 0,
        holdSeconds: 0,
        arrivedMinute: null,
      })),
    );
    this.emitIgnitions(-1, 0);
    this.checkFire(0);
    this.alertUnreachableZones();
  }

  /** Closures can cut a zone off before any fire does; say so instead of hiding it. */
  private alertUnreachableZones(): void {
    if (this.closed.size === 0) return;
    const blocked = this.blockedAt(0);
    for (const zone of this.area.zones) {
      const tree = shortestPathTree(this.area, zone.node, blocked);
      if (this.area.exits.some((exit) => routeTo(this.area, tree, exit.node))) continue;
      this.alert(
        "route_blocked",
        `${zone.name} can reach no exit without crossing fire or a closed road.`,
        true,
      );
    }
  }

  /** The zone's homes the fire reaches, earliest first. */
  private fireOrderOf(index: number): number[] {
    const { firstHome, homes } = this.area.zones[index];
    const arrival = this.exposure.homeArrival;
    const order: number[] = [];
    for (let h = firstHome; h < firstHome + homes; h += 1) {
      if (Number.isFinite(arrival[h])) order.push(h);
    }
    return order.sort((a, b) => arrival[a] - arrival[b]);
  }

  /** The fires engines can attack, and their burned area over time (from the current run). */
  setFires(
    targets: readonly FireTarget[],
    frames: readonly FireAreaFrame[],
    reportDelaysMinutes: readonly number[] = [],
  ): void {
    this.fires = targets.map((target, index) => ({
      reportedMinute:
        target.ignitedMinute === null ? null : target.ignitedMinute + (reportDelaysMinutes[index] ?? 0),
      reportAnnounced: false,
      target,
      lineMeters: 0,
      outMinute: null,
      tactic: null,
      line: null,
      heldMinute: null,
      heldAnnounced: false,
    }));
    this.fireFrames = [...frames];
  }

  /**
   * Swap in the exposure (and per-fire areas) of a re-solved run after a fire was put out at
   * or before the current minute. Arrivals up to now are unchanged by such a re-solve, so only
   * the future changes. Staged zones that are no longer reached by any fire stand down.
   */
  setExposure(
    exposure: FireExposure,
    frames: readonly FireAreaFrame[],
    heldMinutes: readonly (number | null)[] | null = null,
  ): void {
    this.exposure = exposure;
    this.zoneNearMin = this.zoneNearMinutes(exposure);
    this.fireFrames = [...frames];
    if (heldMinutes) {
      this.fires.forEach((fire, index) => {
        if (!fire.heldAnnounced) fire.heldMinute = heldMinutes[index] ?? null;
      });
    }
    const now = this.minute;
    this.zones.forEach((zone, index) => {
      const work = this.work[index];
      work.fireOrder = this.fireOrderOf(index);
      work.fireNext = work.fireOrder.filter((h) => exposure.homeArrival[h] <= now).length;
      if (zone.stage && zone.status === "no_order" && this.zoneImpact(index) === "outside") {
        zone.stage = null;
        this.notice(
          index,
          "all_clear",
          null,
          "The fire threatening your area is out. You no longer need to leave; stay alert.",
        );
      }
    });
  }

  /** Per-fire burned area over time in the current run. */
  fireFramesNow(): readonly FireAreaFrame[] {
    return this.fireFrames;
  }

  /** Index of a fire by its id, or undefined. */
  fireIndex(id: string): number | undefined {
    const index = this.fires.findIndex((fire) => fire.target.id === id);
    return index < 0 ? undefined : index;
  }

  /** Fire is burning now: started, not out, not held by a line. */
  fireBurning(index: number): boolean {
    const fire = this.fires[index];
    return (
      fire.outMinute === null &&
      !fire.heldAnnounced &&
      fire.target.ignitedMinute !== null &&
      fire.target.ignitedMinute <= this.minute
    );
  }

  /** Fire is burning and has been reported to dispatch (orderable, visible). */
  fireReported(index: number): boolean {
    const at = this.fires[index].reportedMinute;
    return this.fireBurning(index) && at !== null && at <= this.minute;
  }

  /** Set when a line tactic gained or lost crews: the session re-plans lines and re-solves. */
  linesDirty = false;

  /** Start minute of each engine on a fire: arrival on scene, or now plus its drive. */
  crewMinutes(index: number): number[] {
    return this.fireAttackers(index).map(
      (unit) =>
        (unit.status === "on_scene"
          ? (unit.arrivedMinute ?? this.minute)
          : this.minute + (this.unitEtaMinutes(unit) ?? 0)) + (unit.walkMinutes ?? 0),
    );
  }

  /** Install re-planned lines (one per fire, null for none) after a re-solve. */
  setFireLines(lines: readonly (LinePlan | null)[]): void {
    this.fires.forEach((fire, index) => {
      fire.line = lines[index] ?? null;
    });
    this.linesDirty = false;
  }

  /**
   * The nearest `max` units not already on a fire, with the minute each would start work
   * there; for what-if options of every tactic.
   */
  nearestUnits(index: number, max: number): { unitId: string; minute: number }[] {
    return this.units
      .filter((unit) => !(unit.task === "fire_attack" && unit.fire === index))
      .flatMap((unit) => {
        const plan = this.attackRoute(unit, index);
        return plan
          ? [{ unitId: unit.id, minute: this.minute + plan.seconds / SECONDS_PER_MINUTE }]
          : [];
      })
      .sort((a, b) => a.minute - b.minute)
      .slice(0, max);
  }

  /** Burned area of a fire now (or when it went out), m², from the current run. */
  fireAreaSquareMeters(index: number): number {
    return fireAreaAt(this.fireFrames, index, this.fires[index].outMinute ?? this.minute);
  }

  /** Grass-equivalent line still needed to ring the fire now, metres. */
  fireLineNeededMeters(index: number): number {
    return lineNeededMeters(this.fires[index].target, this.fireFrames, index, this.minute);
  }

  /** Units attacking a fire: on scene, or driving there. */
  fireAttackers(index: number): UnitState[] {
    return this.units.filter(
      (unit) =>
        unit.task === "fire_attack" &&
        unit.fire === index &&
        (unit.status === "on_scene" || unit.status === "en_route"),
    );
  }

  /**
   * Where a unit would stage to attack a fire: the reachable node (avoiding fire and closed
   * roads) nearest the fire's ignition point, and the drive there in seconds (including a
   * station's approach for a unit still at its station). Null when no road reaches.
   */
  attackRoute(
    unit: UnitState,
    index: number,
  ): { node: number; route: Route; seconds: number; walkMinutes: number } | null {
    if (unit.status === "stranded") return null;
    const from = this.unitNextNode(unit);
    const tree = this.unitTree(unit, from, this.blockedAt(this.minute));
    const { node: best, meters: bestMeters } = this.nearestReached(tree, this.fires[index].target.location);
    if (bestMeters > MAX_ATTACK_WALK_METERS) return null;
    const route = best < 0 ? null : routeTo(this.area, tree, best);
    if (!route) return null;
    const approach = unit.status === "available" ? this.approachSeconds(unit) : 0;
    const walkMinutes = hikeMinutes(Math.max(0, bestMeters), 0);
    // `seconds` is when line work can start: drive, station approach and the walk in.
    return { node: best, route, seconds: route.seconds + approach + walkMinutes * SECONDS_PER_MINUTE, walkMinutes };
  }

  /**
   * Simulator estimate of the minute a fire is out with the units attacking it now plus one
   * more engine starting at each minute in `extraArrivals`, or null if not by the horizon.
   */
  projectedOutMinute(
    index: number,
    extraArrivals: readonly number[] = [],
    extraRates?: readonly number[],
  ): number | null {
    const fire = this.fires[index];
    if (fire.outMinute !== null) return fire.outMinute;
    const attackers = this.fireAttackers(index);
    const arrivals = attackers.map((unit) =>
      unit.status === "on_scene" ? this.minute : this.minute + (this.unitEtaMinutes(unit) ?? 0),
    );
    const rates = [
      ...attackers.map((unit) => this.unitLineMetersPerMinute(unit)),
      ...extraArrivals.map((_, i) => extraRates?.[i] ?? ENGINE_LINE_METERS_PER_MINUTE),
    ];
    return projectOutMinute(
      fire.target,
      this.fireFrames,
      index,
      this.minute,
      fire.lineMeters,
      [...arrivals, ...extraArrivals],
      this.horizonMinutes,
      rates,
    );
  }

  /**
   * What-if options for a burning fire engines can attack: send the nearest 1..`max` units not
   * already on it (wherever they are now, including other assignments), with the simulator's
   * estimated out minute for each. Empty when the fire cannot be attacked now.
   */
  attackOptions(index: number, max: number): { unitIds: string[]; outMinute: number | null }[] {
    const fire = this.fires[index];
    if (!this.fireReported(index) || fire.target.directBlocked) return [];
    const candidates = this.units
      .filter((unit) => !(unit.task === "fire_attack" && unit.fire === index))
      .flatMap((unit) => {
        const plan = this.attackRoute(unit, index);
        return plan ? [{ unit, arrival: this.minute + plan.seconds / SECONDS_PER_MINUTE }] : [];
      })
      .sort((a, b) => a.arrival - b.arrival)
      .slice(0, max);
    return candidates.map((_, k) => {
      const chosen = candidates.slice(0, k + 1);
      return {
        unitIds: chosen.map((c) => c.unit.id),
        outMinute: this.projectedOutMinute(
          index,
          chosen.map((c) => c.arrival),
          chosen.map((c) => this.unitLineMetersPerMinute(c.unit)),
        ),
      };
    });
  }

  /**
   * Add a unit that is already out in the area (a Studio crew leaving the fire). It starts
   * available at `node` and withdraws to `homeNode`.
   */
  addUnit(
    id: string,
    stationId: string,
    node: number,
    homeNode: number,
    kind: GroundKind = DISPATCH_ENGINE_KIND,
  ): UnitState {
    const unit: UnitState = {
      id,
      kind,
      stationId,
      homeNode,
      status: "available",
      task: null,
      zone: null,
      fire: null,
      targetNode: null,
      node,
      steps: [],
      stepIndex: 0,
      stepElapsedSeconds: 0,
      holdSeconds: 0,
      arrivedMinute: null,
    };
    this.units.push(unit);
    return unit;
  }

  get closedEdges(): ReadonlySet<number> {
    return this.closed;
  }

  /**
   * Per-household behaviour (population/householdBehavior.ts): order and fire-cue delays,
   * shadow and wait-and-see households, and those staying by choice. While evacuation support
   * is on scene the order and cue delays are scaled by SUPPORTED / DEPARTURE spread. Call before
   * any order; null restores the uniform spread (no cues). Households staying by choice do not
   * hold up a zone's clearing or a staged wave's release.
   */
  setHouseholdBehavior(behavior: HouseholdBehavior | null): void {
    this.behavior =
      behavior && behavior.orderDelayMinutes.length === this.area.homes.length ? behavior : null;
    this.stayingAtHome.fill(0);
    const set = this.behavior;
    if (!set) return;
    this.area.zones.forEach((zone, index) => {
      for (let h = zone.firstHome; h < zone.firstHome + zone.homes; h += 1) {
        const status = this.homeStatus[h];
        if ((status === HomeStatus.idle || status === HomeStatus.ordered) && set.staysByChoice[h])
          this.stayingAtHome[index] += 1;
      }
    });
  }

  /** T+0 as UTC epoch ms, so households asleep at their first trigger take WAKE_UP_MINUTES. */
  setClock(startEpochMs: number | null): void {
    this.startEpochMs = startEpochMs !== null && Number.isFinite(startEpochMs) ? startEpochMs : null;
  }

  /** True during sleeping hours at simulation minute `minute` (false without a clock). */
  asleepAt(minute: number): boolean {
    return this.startEpochMs !== null && sleepingAt(this.startEpochMs + minute * 60_000);
  }

  /** True when per-household behaviour is set (`setHouseholdBehavior`). */
  get hasDepartureDelays(): boolean {
    return this.behavior !== null;
  }

  /** True when household behaviour is set and home `h` stays home by choice. */
  staysHome(home: number): boolean {
    return this.behavior !== null && this.behavior.staysByChoice[home] === 1;
  }

  /** Households of a zone still at home that stay by choice (0 without household behaviour). */
  stayingHomes(zone: number): number {
    return this.stayingAtHome[zone];
  }

  /**
   * True when a zone's queued households cannot get onto any road: its ordered route is cut,
   * or (no order, or overrun) none of its loading points has a route to any exit.
   */
  loadingHeld(zone: number): boolean {
    const state = this.zones[zone];
    if (state.status === "ordered") return state.routeBlocked || !state.route;
    return !this.work[zone].groups.some((group) => group.route);
  }

  /** Road node home `h` loads through (its zone's nearest loading point). */
  loadingNodeOf(home: number): number {
    const zone = this.area.homes[home].zone;
    return this.work[zone].groups[this.homeGroup[home]]?.node ?? this.area.zones[zone].node;
  }

  private zoneNearMinutes(exposure: FireExposure): Float64Array {
    return Float64Array.from(this.area.zones, (zone) => {
      let first = Infinity;
      for (let h = zone.firstHome; h < zone.firstHome + zone.homes; h += 1)
        first = Math.min(first, exposure.homeNear?.[h] ?? Infinity);
      return first;
    });
  }

  /** Minute home `h` joined its loading queue, or -1 if it never has. */
  queuedSince(home: number): number {
    return this.queuedMinute[home];
  }

  /**
   * Route units per apparatus class over `access` (one entry per area edge, from
   * studio/crewDispatch.ts `accessTableFor`), and set unit kinds by id (others keep theirs).
   * Planner closures and the fire still block every class.
   */
  setApparatusAccess(
    access: readonly EdgeAccess[] | null,
    kinds: ReadonlyMap<string, GroundKind> = new Map(),
    notes: readonly string[] = [],
  ): void {
    this.access = access && access.length === this.area.edges.length ? access : null;
    for (const unit of this.units) unit.kind = kinds.get(unit.id) ?? unit.kind;
    this.apparatusNotes = this.access ? [...notes] : [];
  }

  /** How unit kinds and road access were decided (sources, assumptions), for the agent. */
  apparatusNotes: string[] = [];

  get apparatusAccess(): boolean {
    return this.access !== null;
  }

  unitClass(unit: UnitState): AccessClass {
    return GROUND_APPARATUS[unit.kind].access;
  }

  /** Seconds for `unit` to drive an edge: its class's speed there, else the edge's free-flow. */
  unitEdgeSeconds(unit: UnitState, edge: number): number {
    const kmh = this.access?.[edge].byClass[this.unitClass(unit)].speedKmh;
    return kmh ? this.area.edges[edge].lengthMeters / (kmh / 3.6) : edgeSeconds(this.area, edge);
  }

  /** Fastest drives for `unit` from `from` over the roads its class may use, avoiding `blocked`. */
  unitTree(unit: UnitState, from: number, blocked: (edge: number) => boolean): ShortestPathTree {
    const access = this.access;
    if (!access) return shortestPathTree(this.area, from, blocked);
    const cls = this.unitClass(unit);
    return shortestPathTree(
      this.area,
      from,
      (edge) => blocked(edge) || !access[edge].byClass[cls].passable,
      {
        arcs: this.area.allOutgoing ?? this.area.outgoing,
        seconds: (edge) => this.unitEdgeSeconds(unit, edge),
      },
    );
  }

  /** The first edge closed to `unit`'s class on `steps`, as a no-access reason; else null. */
  private firstClosedToClass(unit: UnitState, steps: readonly PathStep[]): NoAccess | null {
    const access = this.access;
    if (!access) return null;
    const cls = this.unitClass(unit);
    for (const step of steps) {
      const result = access[step.edge].byClass[cls];
      if (!result.passable) {
        return {
          rule: result.rule,
          why: `${RULE_TEXT[result.rule]}: ${result.notes[result.notes.length - 1] ?? RULE_TEXT[result.rule]}`,
          road: roadLabel(this.area.edges[step.edge]),
        };
      }
    }
    return null;
  }

  /**
   * Why `unit` cannot reach node `target` from `from` although an unrestricted vehicle could
   * (avoiding fire and closures): the first edge closed to its class on that vehicle's route.
   * Null when access is off or roads (fire, closures) are the block.
   */
  noAccessTo(unit: UnitState, from: number, target: number, blocked: (edge: number) => boolean): NoAccess | null {
    if (!this.access) return null;
    const tree = shortestPathTree(this.area, from, blocked, {
      arcs: this.area.allOutgoing ?? this.area.outgoing,
    });
    const open = routeTo(this.area, tree, target);
    return open ? this.firstClosedToClass(unit, open.steps) : null;
  }

  /**
   * Why `unit` cannot attack fire `index` (attackRoute is null): the rule on the unrestricted
   * route toward the fire, or the reach limit. Null when access is off.
   */
  attackNoAccess(unit: UnitState, index: number): NoAccess | null {
    if (!this.access || unit.status === "stranded") return null;
    const blocked = this.blockedAt(this.minute);
    const from = this.unitNextNode(unit);
    const tree = shortestPathTree(this.area, from, blocked, {
      arcs: this.area.allOutgoing ?? this.area.outgoing,
    });
    const node = this.nearestReached(tree, this.fires[index].target.location);
    const open = node.node < 0 ? null : routeTo(this.area, tree, node.node);
    const km = Math.round(MAX_ATTACK_WALK_METERS / 100) / 10;
    if (!open || node.meters > MAX_ATTACK_WALK_METERS)
      return { rule: null, why: `no open road within ${km} km of the fire (fire or closures)`, road: null };
    return (
      this.firstClosedToClass(unit, open.steps) ?? {
        rule: null,
        why: `no road its class can use within ${km} km of the fire`,
        road: null,
      }
    );
  }

  private nearestReached(tree: ShortestPathTree, location: LonLat): { node: number; meters: number } {
    let best = -1;
    let bestMeters = Infinity;
    for (let node = 0; node < this.area.nodes.length; node += 1) {
      if (!Number.isFinite(tree.seconds[node])) continue;
      const meters = groundMeters(this.area.nodes[node], location);
      if (meters < bestMeters) {
        best = node;
        bestMeters = meters;
      }
    }
    return { node: best, meters: bestMeters };
  }

  /** Grass-equivalent line one unit builds per minute (studio/apparatus.ts rates; 0 if none). */
  unitLineMetersPerMinute(unit: UnitState): number {
    return GROUND_APPARATUS[unit.kind].line ? grassRateMetersPerHour(unit.kind) / 60 : 0;
  }

  private noAccessText(reason: NoAccess | null): string {
    if (!reason) return "";
    return ` No access for its class: ${reason.rule ? `${reason.rule} ` : ""}${reason.why}${reason.road ? ` (${reason.road})` : ""}.`;
  }

  /**
   * Close or reopen a road now (the planner's live disruption). Ordered zones re-plan at once;
   * vehicles already on the road and engines re-route on the next step, exactly as around fire.
   * Raises an urgent alert so the monitor wakes the agent. False when nothing changed.
   */
  setRoadClosed(edge: number, closed: boolean): boolean {
    const road = this.area.edges[edge];
    if (!road || this.closed.has(edge) === closed) return false;
    const using = this.zones.filter((zone) => zone.route?.steps.some((step) => step.edge === edge));
    const next = new Set(this.closed);
    if (closed) {
      next.add(edge);
      this.roadClosures.push({ edge, minute: this.minute });
    } else {
      next.delete(edge);
      this.roadClosures = this.roadClosures.filter((closure) => closure.edge !== edge);
    }
    this.closed = next;
    const label = roadLabel(road);
    if (closed) {
      const routed =
        using.length > 0
          ? ` ${using.map((zone) => this.area.zones[zone.index].id).join(", ")} ${using.length === 1 ? "was" : "were"} routed over it and re-plan.`
          : "";
      this.alert("road_closed", `Planner closed ${label} at T+${this.minute}.${routed}`, true);
    } else {
      this.alert("road_reopened", `Planner reopened ${label} at T+${this.minute}.`, true);
    }
    this.updateZoneRoutes(this.blockedAt(this.minute));
    return true;
  }

  get finished(): boolean {
    return this.minute >= this.horizonMinutes;
  }

  /**
   * Blocked for routing at `minute`: closed by the planner, or the fire model reaches the edge
   * within the lookahead.
   */
  blockedAt(minute: number): (edge: number) => boolean {
    const arrival = this.exposure.edgeArrival;
    const closed = this.closed;
    const limit = minute + ROUTE_LOOKAHEAD_MINUTES;
    return (edge) => closed.has(edge) || arrival[edge] <= limit;
  }

  vehiclesPerHome(zone: number): number {
    return this.work[zone].vehiclesPerHome;
  }

  private alert(type: AlertType, text: string, urgent: boolean): void {
    this.alerts.push({ minute: this.minute, type, text, urgent });
    if (this.alerts.length > MAX_ALERTS) this.alerts.splice(0, this.alerts.length - MAX_ALERTS);
  }

  private zoneName(index: number): string {
    return this.area.zones[index].name;
  }

  private exitNode(exitId: string): number {
    return this.area.exits[this.exitIndex.get(exitId)!].node;
  }

  private emitIgnitions(after: number, upTo: number): void {
    // With fires set, the dispatcher learns of a fire when it is reported, not when it ignites.
    if (this.fires.length === 0) {
      for (const ignition of this.ignitions) {
        if (ignition.minute > after && ignition.minute <= upTo) {
          this.alert("ignition", `Fire ${ignition.name} starts.`, true);
        }
      }
    }
    for (const fire of this.fires) {
      if (fire.reportAnnounced || fire.reportedMinute === null || fire.reportedMinute > upTo) continue;
      fire.reportAnnounced = true;
      this.alert(
        "ignition",
        `Fire ${fire.target.name} reported at T+${Math.round(fire.reportedMinute)} (ignited T+${Math.round(fire.target.ignitedMinute ?? 0)}).`,
        true,
      );
    }
  }

  // ---- Orders --------------------------------------------------------------------------

  applyOrders(orders: readonly Order[]): OrderOutcome[] {
    return orders.map((order) => this.applyOrder(order));
  }

  private applyOrder(order: Order): OrderOutcome {
    const reject = (note: string): OrderOutcome => ({ order, accepted: false, note });
    const blocked = this.blockedAt(this.minute);

    if (order.type === "order_evacuation" || order.type === "stage_evacuation") {
      const index = this.zoneIndex.get(order.zone_id);
      if (index === undefined) return reject(`Unknown zone ${order.zone_id}.`);
      if (!this.exitIndex.has(order.exit_id)) return reject(`Unknown exit ${order.exit_id}.`);
      const zone = this.zones[index];
      if (zone.status === "overrun") return reject(`${order.zone_id} is already overrun by fire.`);
      if (zone.status === "cleared") return reject(`${order.zone_id} has already cleared.`);
      if (
        this.restrictToFirePath &&
        zone.status === "no_order" &&
        this.zoneImpact(index) === "outside"
      )
        return reject(
          `${order.zone_id} is outside the fire path (no fire contact forecast by T+${this.horizonMinutes}); evacuating it would only add traffic.`,
        );
      const tree = shortestPathTree(this.area, this.area.zones[index].node, blocked);
      const route = routeTo(this.area, tree, this.exitNode(order.exit_id));
      if (!route)
        return reject(
          `${order.exit_id} is not reachable from ${order.zone_id} avoiding fire and closed roads.`,
        );
      if (order.type === "stage_evacuation") return this.stageZone(order, index, route);
      const outcome = this.orderZone(index, order.exit_id, route, 1);
      return { order, accepted: true, note: outcome };
    }

    const unit = this.units.find((candidate) => candidate.id === order.unit_id);
    if (!unit) return reject(`Unknown unit ${order.unit_id}.`);
    if (unit.status === "stranded") return reject(`${unit.id} is cut off by fire.`);
    const from = this.unitNextNode(unit);

    if (order.type === "recall_unit") {
      if (unit.status === "available") return reject(`${unit.id} is already at its station.`);
      const route = routeTo(this.area, this.unitTree(unit, from, blocked), unit.homeNode);
      if (!route)
        return reject(
          `${unit.id} has no route home avoiding fire and closed roads.${this.noAccessText(this.noAccessTo(unit, from, unit.homeNode, blocked))}`,
        );
      this.sendUnit(unit, from, route, "returning", null, null);
      return { order, accepted: true, note: `Returning to ${unit.stationId}.` };
    }

    if (order.type === "attack_fire") {
      const index = this.fireIndex(order.fire_id);
      if (index === undefined) return reject(`Unknown fire ${order.fire_id}.`);
      const fire = this.fires[index];
      if (fire.outMinute !== null) return reject(`${fire.target.name} is already out.`);
      if (!this.fireBurning(index)) return reject(`${fire.target.name} has not started.`);
      if (!this.fireReported(index)) return reject(`${fire.target.name} has not been reported yet.`);
      const tactic = order.tactic ?? "direct";
      const blockedTactic = tacticBlocked(fire.target, tactic);
      if (blockedTactic)
        return reject(
          `${fire.target.name} cannot be fought by ${tactic} attack: ${blockedTactic}.`,
        );
      if (fire.heldAnnounced) return reject(`${fire.target.name} is already held by its line.`);
      const switching = fire.tactic !== null && fire.tactic !== tactic;
      if (unit.task === "fire_attack" && unit.fire === index && !switching)
        return reject(`${unit.id} is already on ${fire.target.name}.`);
      let seconds = 0;
      if (!(unit.task === "fire_attack" && unit.fire === index)) {
        const attackers = this.fireAttackers(index).length;
        if (attackers >= IA_GROUND_CAP && this.fireAreaSquareMeters(index) / 10_000 <= IA_SUCCESS_MAX_HA)
          return reject(
            `${fire.target.name} already has its initial attack package (${attackers} ground units, the high run card). Send more once it grows past ${IA_SUCCESS_MAX_ACRES} acres.`,
          );
        const plan = this.attackRoute(unit, index);
        if (!plan)
          return reject(
            `${unit.id} has no road to ${fire.target.name} avoiding fire.${this.noAccessText(this.attackNoAccess(unit, index))}`,
          );
        const fromStation = unit.status === "available";
        this.sendUnit(unit, from, plan.route, "en_route", "fire_attack", null, plan.node);
        unit.fire = index;
        unit.walkMinutes = plan.walkMinutes;
        if (fromStation) this.holdAtStation(unit);
        seconds = plan.seconds;
      }
      // One tactic per fire: every crew on it now fights it this way.
      const lineBefore = fire.tactic !== null && fire.tactic !== "direct";
      if (lineBefore || tactic !== "direct") this.linesDirty = true;
      fire.tactic = tactic;
      const switched = switching
        ? ` All crews on ${fire.target.name} switch to ${tactic} attack.`
        : "";
      if (tactic === "direct") {
        const out = this.projectedOutMinute(index);
        return {
          order,
          accepted: true,
          note: `${unit.id} to ${fire.target.name} (direct attack), ${Math.round(seconds / SECONDS_PER_MINUTE)} min; with the crews on it the simulator estimates it out ${out === null ? "not by the horizon" : `at T+${Math.round(out)}`}.${switched}`,
        };
      }
      return {
        order,
        accepted: true,
        note: `${unit.id} to ${fire.target.name} (${tactic} attack), ${Math.round(seconds / SECONDS_PER_MINUTE)} min; the simulator re-plans the line and re-runs the fire.${switched}`,
      };
    }

    const index = this.zoneIndex.get(order.zone_id);
    if (index === undefined) return reject(`Unknown zone ${order.zone_id}.`);
    if (this.zones[index].status === "overrun")
      return reject(`${order.zone_id} is overrun by fire.`);
    if (order.task !== "evacuation_support" && order.task !== "structure_defense") {
      return reject(`Unknown zone task ${String(order.task)}; use attack_fire for a fire.`);
    }
    const route = routeTo(this.area, this.unitTree(unit, from, blocked), this.area.zones[index].node);
    if (!route)
      return reject(
        `${unit.id} cannot reach ${order.zone_id} avoiding fire and closed roads.${this.noAccessText(this.noAccessTo(unit, from, this.area.zones[index].node, blocked))}`,
      );
    const fromStation = unit.status === "available";
    this.sendUnit(unit, from, route, "en_route", order.task, index);
    if (fromStation) this.holdAtStation(unit);
    const minutes = Math.round((route.seconds + unit.holdSeconds) / SECONDS_PER_MINUTE);
    return {
      order,
      accepted: true,
      note: `${unit.id} en route to ${order.zone_id}, ${minutes} min.`,
    };
  }

  /** Order a zone out now (or redirect it); returns the outcome note. */
  private orderZone(
    index: number,
    exitId: string,
    route: Route,
    wave: number,
    released = false,
  ): string {
    const zone = this.zones[index];
    const redirect = zone.status !== "no_order" && zone.exitId !== exitId;
    const fresh = zone.status === "no_order";
    if (fresh) {
      zone.status = "ordered";
      zone.orderedMinute = this.minute;
      zone.orderRank = this.nextOrderRank++;
      zone.wave = wave;
      zone.stage = null;
      const { firstHome, homes } = this.area.zones[index];
      for (let h = firstHome; h < firstHome + homes; h += 1) {
        if (this.homeStatus[h] === HomeStatus.idle) this.homeStatus[h] = HomeStatus.ordered;
      }
    }
    zone.exitId = exitId;
    zone.route = route;
    zone.routeBlocked = false;
    this.setGroupRoutes(index, exitId, route, this.blockedAt(this.minute));
    if (redirect) {
      const blocked = this.blockedAt(this.minute);
      for (const packet of this.packets) {
        if (packet.zone === index) this.reroutePacket(packet, exitId, blocked);
      }
    }
    const minutes = Math.max(1, Math.round(route.seconds / SECONDS_PER_MINUTE));
    if (fresh || redirect) {
      const exit = this.exitLabel(exitId);
      this.notice(
        index,
        redirect ? "redirect" : "leave_now",
        exitId,
        redirect
          ? `Change of route: leave via ${exit} instead, about ${minutes} min drive.`
          : `${released ? `Your turn (wave ${wave}): leave` : "Leave"} now via ${exit}, about ${minutes} min drive.`,
      );
    }
    return `${redirect ? "Redirected" : "Ordered"} via ${exitId}, ${minutes} min free-flow.`;
  }

  private stageZone(
    order: Extract<Order, { type: "stage_evacuation" }>,
    index: number,
    route: Route,
  ): OrderOutcome {
    const reject = (note: string): OrderOutcome => ({ order, accepted: false, note });
    const zone = this.zones[index];
    if (zone.status !== "no_order")
      return reject(`${order.zone_id} is already ordered; use order_evacuation to redirect it.`);
    const after = this.zoneIndex.get(order.after_zone_id);
    if (after === undefined) return reject(`Unknown zone ${order.after_zone_id}.`);
    if (after === index) return reject("A zone cannot be staged after itself.");
    const predecessor = this.zones[after];
    if (predecessor.status === "cleared" || predecessor.status === "overrun")
      return reject(`${order.after_zone_id} has no households left to wait for; order directly.`);
    if (predecessor.status === "no_order" && !predecessor.stage)
      return reject(
        `${order.after_zone_id} has no order and is not staged; order or stage it first.`,
      );
    // Walk the predecessor's chain: staging must not close a loop.
    let cursor: number | null = after;
    for (let i = 0; cursor !== null && i < MAX_CHAIN; i += 1) {
      if (cursor === index) return reject("That staging would make a loop of waiting zones.");
      cursor = this.zones[cursor].stage?.after ?? null;
    }
    const restage = zone.stage !== null;
    zone.stage = { exitId: order.exit_id, after, stagedMinute: this.minute };
    const wave = this.waveOf(index) ?? 2;
    const slack = this.orderSlackMinutes(index);
    const exit = this.exitLabel(order.exit_id);
    this.notice(
      index,
      "prepare",
      order.exit_id,
      `Get ready, but stay home for now: you leave in wave ${wave}, after ${this.zoneName(after)}, so the road stays clear. You will be told when it is your turn; your route will be ${exit}.`,
    );
    const minutes = Math.max(1, Math.round(route.seconds / SECONDS_PER_MINUTE));
    return {
      order,
      accepted: true,
      note: `${restage ? "Re-staged" : "Staged"} as wave ${wave} after ${order.after_zone_id} via ${order.exit_id} (${minutes} min free-flow)${slack !== null ? `; released by T+${Math.max(0, Math.round(this.minute + slack - STAGE_RELEASE_SLACK_MINUTES))} at the latest` : ""}.`,
    };
  }

  /** 1 for a zone ordered directly; for a staged zone, its predecessor's wave + 1. */
  waveOf(index: number): number | null {
    let depth = 0;
    let cursor: number | null = index;
    for (let i = 0; cursor !== null && i < MAX_CHAIN; i += 1) {
      const zone: ZoneState = this.zones[cursor];
      if (zone.stage) {
        depth += 1;
        cursor = zone.stage.after;
        continue;
      }
      return zone.wave === null ? null : zone.wave + depth;
    }
    return null;
  }

  zoneImpact(index: number): ZoneImpact {
    const contact = this.exposure.zoneContact[index];
    if (!Number.isFinite(contact) || contact > this.horizonMinutes) return "outside";
    const minutes = contact - this.minute;
    if (minutes <= 0) return "burning";
    return minutes <= FORECAST_LOOKAHEAD_MINUTES ? "threatened" : "later";
  }

  /**
   * Minutes left to give this zone its order so every household can be out of its home and
   * onto the road before the modelled fire first reaches the zone: time to fire contact minus
   * the larger of the departure spread and the time for its vehicles to enter the route at the
   * bottleneck. Null when no fire contact is modelled. Negative means already late. An estimate
   * from simulator figures (ignores shared roads), never the agent's.
   */
  orderSlackMinutes(index: number): number | null {
    const contact = this.exposure.zoneContact[index];
    if (!Number.isFinite(contact)) return null;
    const zone = this.zones[index];
    const work = this.work[index];
    const supported = this.units.some(
      (unit) =>
        unit.status === "on_scene" && unit.task === "evacuation_support" && unit.zone === index,
    );
    const spread = supported ? SUPPORTED_DEPARTURE_SPREAD_MINUTES : DEPARTURE_SPREAD_MINUTES;
    let bottleneck = zone.route?.bottleneckVph ?? 0;
    const exitId = zone.stage?.exitId ?? zone.exitId;
    if (bottleneck <= 0 && exitId) {
      const blocked = this.blockedAt(this.minute);
      const tree = shortestPathTree(this.area, this.area.zones[index].node, blocked);
      bottleneck = routeTo(this.area, tree, this.exitNode(exitId))?.bottleneckVph ?? 0;
    }
    const vehicles = (zone.atHome + zone.queued) * work.vehiclesPerHome;
    const queueMinutes = bottleneck > 0 ? (vehicles / bottleneck) * SECONDS_PER_MINUTE : 0;
    return contact - this.minute - Math.max(spread, queueMinutes);
  }

  private exitLabel(exitId: string): string {
    const exit = this.area.exits[this.exitIndex.get(exitId) ?? -1];
    if (!exit) return exitId;
    return exit.road && !exit.name.includes(exit.road) ? `${exit.name} (${exit.road})` : exit.name;
  }

  private notice(zone: number, kind: NoticeKind, exitId: string | null, text: string): void {
    const state = this.zones[zone];
    this.notices.push({
      id: this.nextNoticeId++,
      minute: this.minute,
      zone,
      kind,
      homes: state.atHome + state.queued,
      exitId,
      text,
    });
    if (this.notices.length > MAX_NOTICES)
      this.notices.splice(0, this.notices.length - MAX_NOTICES);
  }

  /** Release staged zones whose predecessor has left, or whose own slack has run out. */
  private releaseStaged(blocked: (edge: number) => boolean): void {
    // Several passes so a chain whose predecessor is released this minute is evaluated in order.
    for (let pass = 0; pass < MAX_CHAIN; pass += 1) {
      let released = false;
      for (const zone of this.zones) {
        const stage = zone.stage;
        if (!stage || zone.status !== "no_order") continue;
        const before = this.zones[stage.after];
        const predecessorGone =
          before.status === "cleared" ||
          before.status === "overrun" ||
          (before.status === "ordered" &&
            before.atHome - this.stayingAtHome[before.index] + before.queued === 0) ||
          (before.status === "no_order" && !before.stage);
        const slack = this.orderSlackMinutes(zone.index);
        const deadline = slack !== null && slack <= STAGE_RELEASE_SLACK_MINUTES;
        if (!predecessorGone && !deadline) continue;
        const wave = (this.waveOf(stage.after) ?? 1) + 1;
        const tree = shortestPathTree(this.area, this.area.zones[zone.index].node, blocked);
        let exitId = stage.exitId;
        let route = routeTo(this.area, tree, this.exitNode(exitId));
        if (!route) {
          for (const exit of this.area.exits) {
            const candidate = routeTo(this.area, tree, exit.node);
            if (candidate && (!route || candidate.seconds < route.seconds)) {
              route = candidate;
              exitId = exit.id;
            }
          }
        }
        const id = this.area.zones[zone.index].id;
        if (!route) {
          zone.stage = null;
          this.alert(
            "route_blocked",
            `${this.zoneName(zone.index)} is due to leave but no exit is reachable avoiding fire.`,
            true,
          );
          this.notice(
            zone.index,
            "hold",
            null,
            "Every route out is cut off by fire in the simulation. Shelter in place until dispatch gives a route.",
          );
          continue;
        }
        zone.stage = null;
        this.orderZone(zone.index, exitId, route, wave, true);
        released = true;
        const why = predecessorGone
          ? `${this.area.zones[stage.after].id} is on the road`
          : "its time to leave ran out before the previous wave finished";
        this.alert(
          "wave_released",
          `Wave ${wave}: ${id} told to leave via ${exitId} (${why}).`,
          !predecessorGone,
        );
      }
      if (!released) break;
    }
  }

  /**
   * An engine sent from its station first waits out turnout and its approach, even when its
   * assignment is at the station's own node (it is not on scene until then).
   */
  private holdAtStation(unit: UnitState): void {
    unit.holdSeconds = this.approachSeconds(unit);
    if (unit.holdSeconds > 0 && unit.status === "on_scene") {
      unit.status = "en_route";
      unit.arrivedMinute = null;
    }
  }

  /** Time from the order to an engine at its station reaching the road graph: turnout, then its approach. */
  private approachSeconds(unit: UnitState): number {
    const station = this.area.stations[this.stationIndex.get(unit.stationId) ?? -1];
    const turnout = this.access ? GROUND_APPARATUS[unit.kind].turnoutMinutes * 60 : TURNOUT_SECONDS;
    return turnout + (station ? station.approachMeters / (APPROACH_SPEED_KPH / 3.6) : 0);
  }

  /** Node the unit is at, or the head of the edge it is driving (it finishes that edge). */
  private unitNextNode(unit: UnitState): number {
    if (unit.stepIndex < unit.steps.length && unit.stepElapsedSeconds > 0) {
      return stepHead(this.area, unit.steps[unit.stepIndex]);
    }
    return unit.node;
  }

  private sendUnit(
    unit: UnitState,
    from: number,
    route: Route,
    status: UnitStatus,
    task: UnitTask | null,
    zone: number | null,
    targetNode: number | null = zone === null ? null : this.area.zones[zone].node,
  ): void {
    unit.node = from;
    unit.steps = route.steps;
    unit.stepIndex = 0;
    unit.stepElapsedSeconds = 0;
    unit.holdSeconds = 0;
    if (unit.fire !== null && this.fires[unit.fire]?.tactic !== "direct" && !this.releasing)
      this.linesDirty = true;
    unit.task = task;
    unit.zone = zone;
    unit.fire = null;
    unit.targetNode = targetNode;
    unit.arrivedMinute = null;
    if (route.steps.length > 0) unit.status = status;
    else if (status === "returning") unit.status = "available";
    else {
      unit.status = "on_scene";
      unit.arrivedMinute = this.minute;
    }
  }

  // ---- Stepping ------------------------------------------------------------------------

  /** Advance one minute. */
  step(): void {
    if (this.finished) return;
    const previous = this.minute;
    this.minute += 1;
    const now = this.minute;
    this.emitIgnitions(previous, now);
    const blocked = this.blockedAt(now);
    this.checkFire(now);
    this.releaseStaged(blocked);
    this.updateZoneRoutes(blocked);
    this.departures();
    this.release();
    this.advancePackets(now, blocked);
    this.advanceUnits(now, blocked);
    this.attackFires(blocked);
    this.checkCleared();
  }

  /** Crews leaving a fire that is out or held: no line re-plan is needed for them. */
  private releasing = false;

  /**
   * Direct attack: engines on scene build line, and a fire whose edge is ringed is out. Line
   * tactics: the line is in the fire model already; once the run shows the fire held, its crews
   * are released. Either way the crews go home.
   */
  private attackFires(blocked: (edge: number) => boolean): void {
    this.fires.forEach((fire, index) => {
      if (fire.outMinute !== null) return;
      if (fire.tactic !== null && fire.tactic !== "direct") {
        if (fire.heldAnnounced || fire.heldMinute === null || fire.heldMinute > this.minute) return;
        fire.heldAnnounced = true;
        const hectares = this.fireAreaSquareMeters(index) / 10_000;
        const crews = this.fireAttackers(index);
        this.alert(
          "fire_held",
          `${fire.target.name} is held by its ${fire.tactic} line at ${hectares < 10 ? hectares.toFixed(1) : Math.round(hectares)} ha${crews.length > 0 ? `; ${crews.map((unit) => unit.id).join(", ")} released` : ""}.`,
          false,
        );
        this.sendHome(crews, blocked);
        return;
      }
      // An engine starts building the minute after it arrives (projectOutMinute does the same).
      const working = this.units.filter(
        (unit) =>
          unit.status === "on_scene" &&
          unit.task === "fire_attack" &&
          unit.fire === index &&
          (unit.arrivedMinute ?? 0) + (unit.walkMinutes ?? 0) < this.minute,
      );
      if (working.length === 0) return;
      fire.lineMeters += working.reduce((sum, unit) => sum + this.unitLineMetersPerMinute(unit), 0);
      if (fire.lineMeters < this.fireLineNeededMeters(index)) return;
      fire.outMinute = this.minute;
      const hectares = this.fireAreaSquareMeters(index) / 10_000;
      this.alert(
        "fire_out",
        `${fire.target.name} is out: ${working.map((unit) => unit.id).join(", ")} contained it at ${hectares < 10 ? hectares.toFixed(1) : Math.round(hectares)} ha.`,
        false,
      );
      this.sendHome(this.fireAttackers(index), blocked);
    });
  }

  private sendHome(units: readonly UnitState[], blocked: (edge: number) => boolean): void {
    this.releasing = true;
    for (const unit of units) {
      const from = this.unitNextNode(unit);
      const home = routeTo(this.area, this.unitTree(unit, from, blocked), unit.homeNode);
      if (home) this.sendUnit(unit, from, home, "returning", null, null);
      else {
        unit.status = "stranded";
        this.alert("unit_stranded", `${unit.id} has no fire-free route home.`, true);
      }
    }
    this.releasing = false;
  }

  private catchHome(zone: ZoneState, home: number): void {
    const status = this.homeStatus[home];
    if (status === HomeStatus.idle || status === HomeStatus.ordered) {
      zone.atHome -= 1;
      if (this.staysHome(home)) {
        this.stayingAtHome[zone.index] -= 1;
        zone.caughtByChoice += 1;
      }
    } else if (status === HomeStatus.queued) {
      zone.queued -= 1;
      zone.caughtOnRoad += 1;
    } else return;
    this.homeStatus[home] = HomeStatus.caught;
    zone.caught += 1;
  }

  private checkFire(now: number): void {
    const { zoneContact, zoneCore, homeArrival, nodeArrival } = this.exposure;
    for (const zone of this.zones) {
      const name = this.zoneName(zone.index);
      const work = this.work[zone.index];
      if (!zone.fireContact && zoneContact[zone.index] <= now) {
        zone.fireContact = true;
        const remaining = zone.atHome + zone.queued;
        this.alert(
          "fire_contact",
          `Fire reaches ${name}; ${remaining} homes have not left.`,
          zone.status !== "cleared" && remaining > 0,
        );
      }
      // Households still at home when the fire reaches their house.
      let caughtAtHome = 0;
      while (
        work.fireNext < work.fireOrder.length &&
        homeArrival[work.fireOrder[work.fireNext]] <= now
      ) {
        const home = work.fireOrder[work.fireNext++];
        const status = this.homeStatus[home];
        if (status === HomeStatus.idle || status === HomeStatus.ordered) {
          this.catchHome(zone, home);
          caughtAtHome += 1;
        }
      }
      if (caughtAtHome > 0 && zone.status !== "overrun") {
        this.alert(
          "homes_caught",
          `Fire reached ${caughtAtHome} home${caughtAtHome === 1 ? "" : "s"} in ${zone.status === "no_order" ? "unordered " : ""}${name} before they left.`,
          true,
        );
      }
      // Households queued at a loading point the fire has reached.
      let caughtQueued = 0;
      for (const group of work.groups) {
        if (group.queue.length === 0 || !(nodeArrival[group.node] <= now)) continue;
        for (const home of group.queue) this.catchHome(zone, home);
        caughtQueued += group.queue.length;
        group.queue = [];
      }
      if (caughtQueued > 0)
        this.alert(
          "vehicles_exposed",
          `Fire reached a loading point of ${name}: ${caughtQueued} households waiting there to get onto the road are caught.`,
          true,
        );
      if (zone.status !== "overrun" && zone.status !== "cleared" && zoneCore[zone.index] <= now) {
        zone.status = "overrun";
        zone.stage = null;
        const home = zone.atHome - this.stayingAtHome[zone.index];
        this.alert(
          "zone_overrun",
          `Fire reaches the core of ${name}: ${home} households still home (not counting ${this.stayingAtHome[zone.index]} staying by choice) and ${zone.queued} queued; no more orders here.`,
          true,
        );
      }
    }
  }

  private updateZoneRoutes(blocked: (edge: number) => boolean): void {
    for (const zone of this.zones) {
      if (zone.status === "ordered" && zone.exitId) {
        if (!zone.route || zone.route.steps.some((step) => blocked(step.edge))) {
          const tree = shortestPathTree(this.area, this.area.zones[zone.index].node, blocked);
          const route = routeTo(this.area, tree, this.exitNode(zone.exitId));
          const id = this.area.zones[zone.index].id;
          if (route) {
            zone.route = route;
            if (zone.routeBlocked) zone.routeBlocked = false;
            else
              this.alert(
                "route_changed",
                `Route from ${id} to ${zone.exitId} re-planned around fire and closed roads.`,
                false,
              );
          } else if (!zone.routeBlocked) {
            zone.route = null;
            zone.routeBlocked = true;
            this.notice(
              zone.index,
              "hold",
              zone.exitId,
              `Your route to ${this.exitLabel(zone.exitId)} is cut off by fire or a road closure. If you have not left, wait for a new route.`,
            );
            this.alert(
              "route_blocked",
              `${this.zoneName(zone.index)} cannot reach ${zone.exitId} without crossing fire or a closed road; departures are held until it gets another exit.`,
              true,
            );
          }
        }
        this.refreshGroupRoutes(zone.index, zone.exitId, zone.route, blocked);
        continue;
      }
      // Households on their own (no order, or the zone is overrun): keep a route to the exit
      // they took, else to the fastest one they can still reach.
      if (zone.status === "no_order" || zone.status === "overrun") {
        if (zone.queued === 0) continue;
        this.selfRoute(zone.index, blocked);
      }
    }
  }

  /**
   * Route for households leaving with no order (or from an overrun zone): the exit they already
   * took if still reachable from the main loading node, else the fastest reachable exit.
   */
  private selfRoute(index: number, blocked: (edge: number) => boolean): void {
    const zone = this.zones[index];
    const work = this.work[index];
    const current = zone.selfExitId ?? (zone.status === "overrun" ? zone.exitId : null);
    const primary = work.groups[0].route;
    if (
      current &&
      primary &&
      primary.target === this.exitNode(current) &&
      !primary.steps.some((step) => blocked(step.edge))
    ) {
      this.refreshGroupRoutes(index, current, primary, blocked);
      return;
    }
    const tree = shortestPathTree(this.area, this.area.zones[index].node, blocked);
    let best: { id: string; route: Route } | null = null;
    if (current) {
      const route = routeTo(this.area, tree, this.exitNode(current));
      if (route) best = { id: current, route };
    }
    if (!best) {
      for (const exit of this.area.exits) {
        const route = routeTo(this.area, tree, exit.node);
        if (route && (!best || route.seconds < best.route.seconds)) best = { id: exit.id, route };
      }
    }
    if (!best) {
      for (const group of work.groups) group.route = null;
      return;
    }
    if (zone.selfExitId === null && zone.status === "no_order")
      this.alert(
        "self_evacuation",
        `Households in ${this.zoneName(index)} leave on their own as the fire reaches them (no order), via ${best.id}.`,
        false,
      );
    zone.selfExitId = best.id;
    this.setGroupRoutes(index, best.id, best.route, blocked);
  }

  /** Every loading point's route to `exitId`; group 0 takes `primary` (the main node's route). */
  private setGroupRoutes(
    index: number,
    exitId: string,
    primary: Route | null,
    blocked: (edge: number) => boolean,
  ): void {
    const groups = this.work[index].groups;
    const target = this.exitNode(exitId);
    groups.forEach((group, i) => {
      group.route =
        i === 0
          ? primary
          : routeTo(this.area, shortestPathTree(this.area, group.node, blocked), target);
    });
  }

  /** Re-plan loading-point routes that cross a blocked edge (group 0 follows `primary`). */
  private refreshGroupRoutes(
    index: number,
    exitId: string,
    primary: Route | null,
    blocked: (edge: number) => boolean,
  ): void {
    const groups = this.work[index].groups;
    const target = this.exitNode(exitId);
    groups.forEach((group, i) => {
      if (i === 0) {
        group.route = primary;
        return;
      }
      if (
        group.route &&
        group.route.target === target &&
        !group.route.steps.some((step) => blocked(step.edge))
      )
        return;
      group.route = routeTo(this.area, shortestPathTree(this.area, group.node, blocked), target);
    });
  }

  private departures(): void {
    const supported = new Set(
      this.units
        .filter(
          (unit) =>
            unit.status === "on_scene" && unit.task === "evacuation_support" && unit.zone !== null,
        )
        .map((unit) => unit.zone as number),
    );
    for (const zone of this.zones) {
      if (zone.atHome <= 0) continue;
      const spread = supported.has(zone.index)
        ? SUPPORTED_DEPARTURE_SPREAD_MINUTES
        : DEPARTURE_SPREAD_MINUTES;
      if (this.behavior) {
        if (zone.status !== "cleared")
          this.behaviorDepartures(zone, spread / DEPARTURE_SPREAD_MINUTES);
        continue;
      }
      // Uniform spread: ordered zones (and overrun zones that were ordered) only.
      if (zone.orderedMinute === null || (zone.status !== "ordered" && zone.status !== "overrun"))
        continue;
      const { firstHome, homes } = this.area.zones[zone.index];
      const work = this.work[zone.index];
      work.departBudget += homes / spread;
      while (work.departBudget >= 1 && work.nextDeparture < homes) {
        const home = firstHome + work.nextDeparture++;
        if (this.homeStatus[home] !== HomeStatus.ordered) continue;
        this.leaveHome(zone, home);
        work.departBudget -= 1;
      }
      if (work.nextDeparture >= homes) work.departBudget = 0;
    }
  }

  /** A household leaves home and queues at its loading point. */
  private leaveHome(zone: ZoneState, home: number): void {
    this.homeStatus[home] = HomeStatus.queued;
    this.queuedMinute[home] = this.minute;
    this.work[zone.index].groups[this.homeGroup[home]].queue.push(home);
    zone.atHome -= 1;
    zone.queued += 1;
  }

  /**
   * Departures with household behaviour (population/householdBehavior.ts): a household leaves
   * at the first of its order delay after the zone's order, its cue delay after the fire
   * reached its zone (with no order only shadow and wait-and-see households), and the near cue
   * (fire within FIRE_CUE_NEAR_METERS of the house) + NEAR_CUE_EXTRA_MINUTES. A household
   * asleep at its first trigger acts WAKE_UP_MINUTES later. Order and cue delays are scaled by
   * `scale` (evacuation support on scene). Staying by choice: never.
   */
  private behaviorDepartures(zone: ZoneState, scale: number): void {
    const behavior = this.behavior!;
    const now = this.minute;
    const contact = this.exposure.zoneContact[zone.index];
    const contactSeen = contact <= now;
    const ordered = zone.orderedMinute;
    if (ordered === null && !contactSeen && !(this.zoneNearMin[zone.index] <= now)) return;
    const near = this.exposure.homeNear;
    const { firstHome, homes } = this.area.zones[zone.index];
    for (let home = firstHome; home < firstHome + homes; home += 1) {
      const status = this.homeStatus[home];
      if (status !== HomeStatus.idle && status !== HomeStatus.ordered) continue;
      if (behavior.staysByChoice[home]) continue;
      const orderStart = ordered !== null && status === HomeStatus.ordered ? ordered : Infinity;
      const cueStart =
        contactSeen && (ordered !== null || behavior.leavesWithoutOrder[home]) ? contact : Infinity;
      const nearStart = near && near[home] <= now ? near[home] : Infinity;
      const first = Math.min(orderStart, cueStart, nearStart);
      if (!(first <= now)) continue;
      if (Number.isNaN(this.awakeAt[home]))
        this.awakeAt[home] = first + (this.asleepAt(first) ? WAKE_UP_MINUTES : 0);
      const awake = this.awakeAt[home];
      const due = Math.min(
        Math.max(orderStart, awake) + behavior.orderDelayMinutes[home] * scale,
        Math.max(cueStart, awake) + behavior.cueDelayMinutes[home] * scale,
        Math.max(nearStart, awake) + NEAR_CUE_EXTRA_MINUTES,
      );
      if (!(due <= now)) continue;
      this.leaveHome(zone, home);
    }
  }

  /** Release queued households onto their routes, sharing each edge's capacity between routes. */
  private release(): void {
    const desired: { zone: number; group: LoadGroup; route: Route; want: number }[] = [];
    const load = new Map<number, number>();
    for (const zone of this.zones) {
      const work = this.work[zone.index];
      if (zone.queued === 0 || zone.status === "cleared") continue;
      // An ordered zone whose route is cut holds its departures until it gets another exit.
      if (zone.status === "ordered" && (!zone.route || zone.routeBlocked)) continue;
      const main = work.groups[0];
      for (let i = 1; i < work.groups.length; i += 1) {
        // A loading point with no route of its own: its households drive on to the main one.
        const group = work.groups[i];
        if (!group.route && main.route && group.queue.length > 0) {
          main.queue.push(...group.queue);
          group.queue = [];
        }
      }
      for (const group of work.groups) {
        if (!group.route || group.queue.length === 0) continue;
        const want = Math.min(
          group.queue.length * work.vehiclesPerHome,
          group.route.bottleneckVph / SECONDS_PER_MINUTE,
        );
        desired.push({ zone: zone.index, group, route: group.route, want });
        for (const step of group.route.steps)
          load.set(step.edge, (load.get(step.edge) ?? 0) + want);
      }
    }
    for (const { zone: index, group, route, want } of desired) {
      const zone = this.zones[index];
      const work = this.work[index];
      const exitId =
        zone.status === "ordered" ? zone.exitId! : (zone.selfExitId ?? zone.exitId ?? "");
      let factor = 1;
      for (const step of route.steps) {
        const capacityPerMinute = this.area.edges[step.edge].capacityVph / SECONDS_PER_MINUTE;
        factor = Math.min(factor, capacityPerMinute / (load.get(step.edge) ?? capacityPerMinute));
      }
      const vehicles = want * factor;
      if (vehicles <= VEHICLE_EPSILON || work.vehiclesPerHome <= 0) continue;
      group.releaseBudget += vehicles / work.vehiclesPerHome;
      const count = Math.min(group.queue.length, Math.floor(group.releaseBudget + 1e-9));
      group.releaseBudget -= count;
      if (group.queue.length === count) group.releaseBudget = Math.min(group.releaseBudget, 1);
      if (count === 0) continue;
      const homes = group.queue.splice(0, count);
      zone.queued -= count;
      if (route.steps.length === 0) {
        for (const home of homes) this.homeStatus[home] = HomeStatus.safe;
        zone.safe += count;
        this.exitArrivals.push({ minute: this.minute, exitId, zone: index, homes: count });
        continue;
      }
      for (const home of homes) this.homeStatus[home] = HomeStatus.driving;
      zone.onRoad += count;
      this.packets.push({
        id: this.nextPacketId++,
        zone: index,
        homes,
        vehicles: count * work.vehiclesPerHome,
        exitId,
        steps: route.steps,
        stepIndex: 0,
        stepElapsedSeconds: 0,
        stuck: false,
      });
    }
  }

  /** Re-route a packet from the end of its current edge; nearest reachable exit if needed. */
  private reroutePacket(packet: Packet, exitId: string, blocked: (edge: number) => boolean): void {
    const current = packet.steps[packet.stepIndex];
    const head = current ? stepHead(this.area, current) : null;
    if (head === null) return;
    const tree = shortestPathTree(this.area, head, blocked);
    let route = routeTo(this.area, tree, this.exitNode(exitId));
    let target = exitId;
    if (!route) {
      let best: { route: Route; id: string } | null = null;
      for (const exit of this.area.exits) {
        const candidate = routeTo(this.area, tree, exit.node);
        if (candidate && (!best || candidate.seconds < best.route.seconds))
          best = { route: candidate, id: exit.id };
      }
      if (best) {
        route = best.route;
        target = best.id;
      }
    }
    if (!route) {
      packet.stuck = true;
      return;
    }
    packet.steps = [current, ...route.steps];
    packet.stepIndex = 0;
    packet.exitId = target;
    packet.stuck = false;
  }

  private advancePackets(now: number, blocked: (edge: number) => boolean): void {
    const arrival = this.exposure.edgeArrival;
    const caughtByZone = new Map<number, number>();
    const remaining: Packet[] = [];
    for (const packet of this.packets) {
      const zone = this.zones[packet.zone];
      const current = packet.steps[packet.stepIndex];
      if (current && arrival[current.edge] <= now) {
        for (const home of packet.homes) this.homeStatus[home] = HomeStatus.caught;
        zone.onRoad -= packet.homes.length;
        zone.caught += packet.homes.length;
        zone.caughtOnRoad += packet.homes.length;
        caughtByZone.set(packet.zone, (caughtByZone.get(packet.zone) ?? 0) + packet.homes.length);
        continue;
      }
      const ahead = packet.steps.slice(packet.stepIndex + 1);
      if (packet.stuck || ahead.some((step) => blocked(step.edge))) {
        this.reroutePacket(packet, zone.exitId ?? packet.exitId, blocked);
      }
      if (!packet.stuck) {
        let budget = SECONDS_PER_MINUTE;
        while (budget > 0 && packet.stepIndex < packet.steps.length) {
          const left =
            edgeSeconds(this.area, packet.steps[packet.stepIndex].edge) - packet.stepElapsedSeconds;
          if (left > budget) {
            packet.stepElapsedSeconds += budget;
            budget = 0;
          } else {
            budget -= left;
            packet.stepIndex += 1;
            packet.stepElapsedSeconds = 0;
          }
        }
      }
      if (packet.stepIndex >= packet.steps.length) {
        for (const home of packet.homes) this.homeStatus[home] = HomeStatus.safe;
        zone.onRoad -= packet.homes.length;
        zone.safe += packet.homes.length;
        this.exitArrivals.push({
          minute: now,
          exitId: packet.exitId,
          zone: packet.zone,
          homes: packet.homes.length,
        });
      } else remaining.push(packet);
    }
    this.packets = remaining;
    for (const [index, homes] of caughtByZone) {
      this.alert(
        "vehicles_exposed",
        `${homes} households from ${this.area.zones[index].id} caught on a road the fire reached.`,
        true,
      );
    }
  }

  private advanceUnits(now: number, blocked: (edge: number) => boolean): void {
    const core = this.exposure.zoneCore;
    for (const unit of this.units) {
      if (
        unit.status === "on_scene" &&
        unit.zone !== null &&
        core[unit.zone] <= now + UNIT_WITHDRAW_MARGIN_MINUTES
      ) {
        const zoneId = this.area.zones[unit.zone].id;
        const route = routeTo(this.area, this.unitTree(unit, unit.node, blocked), unit.homeNode);
        if (route) {
          this.sendUnit(unit, unit.node, route, "returning", null, null);
          this.alert(
            "unit_withdrawn",
            `${unit.id} withdraws from ${zoneId}: fire is about to reach it.`,
            true,
          );
        } else {
          unit.status = "stranded";
          this.alert("unit_stranded", `${unit.id} is cut off in ${zoneId}.`, true);
        }
        continue;
      }
      if (unit.status !== "en_route" && unit.status !== "returning") continue;
      const ahead = unit.steps.slice(unit.stepIndex + (unit.stepElapsedSeconds > 0 ? 1 : 0));
      if (ahead.some((step) => blocked(step.edge))) {
        const from = this.unitNextNode(unit);
        const target =
          unit.status === "returning" || unit.targetNode === null ? unit.homeNode : unit.targetNode;
        const route = routeTo(this.area, this.unitTree(unit, from, blocked), target);
        if (route) {
          const current = unit.stepElapsedSeconds > 0 ? [unit.steps[unit.stepIndex]] : [];
          unit.steps = [...current, ...route.steps];
          unit.stepIndex = 0;
        } else {
          const home = routeTo(this.area, this.unitTree(unit, from, blocked), unit.homeNode);
          if (home && unit.status !== "returning") {
            this.alert(
              "unit_stranded",
              `${unit.id} cannot reach its assignment avoiding fire and closed roads; returning.`,
              true,
            );
            this.sendUnit(unit, from, home, "returning", null, null);
          } else {
            unit.status = "stranded";
            this.alert(
              "unit_stranded",
              `${unit.id} has no route avoiding fire and closed roads.`,
              true,
            );
            continue;
          }
        }
      }
      let budget = SECONDS_PER_MINUTE;
      if (unit.holdSeconds > 0) {
        const used = Math.min(budget, unit.holdSeconds);
        unit.holdSeconds -= used;
        budget -= used;
      }
      while (budget > 0 && unit.stepIndex < unit.steps.length) {
        const step = unit.steps[unit.stepIndex];
        const left = this.unitEdgeSeconds(unit, step.edge) - unit.stepElapsedSeconds;
        if (left > budget) {
          unit.stepElapsedSeconds += budget;
          budget = 0;
        } else {
          budget -= left;
          unit.node = stepHead(this.area, step);
          unit.stepIndex += 1;
          unit.stepElapsedSeconds = 0;
        }
      }
      if (unit.stepIndex >= unit.steps.length && unit.holdSeconds <= 0) {
        unit.steps = [];
        unit.stepIndex = 0;
        if (unit.status === "returning") {
          unit.status = "available";
          unit.task = null;
          unit.zone = null;
          unit.fire = null;
          unit.targetNode = null;
        } else {
          unit.status = "on_scene";
          unit.arrivedMinute = now;
          this.alert(
            "unit_arrived",
            unit.fire !== null
              ? `${unit.id} on scene at ${this.fires[unit.fire].target.name}, attacking the fire.`
              : `${unit.id} on scene at ${this.area.zones[unit.zone!].id} (${unit.task === "evacuation_support" ? "evacuation support" : "structure defense"}).`,
            false,
          );
        }
      }
    }
  }

  private checkCleared(): void {
    for (const zone of this.zones) {
      if (zone.status !== "ordered") continue;
      if (zone.atHome - this.stayingAtHome[zone.index] + zone.queued + zone.onRoad === 0) {
        zone.status = "cleared";
        zone.clearedMinute = this.minute;
        this.alert(
          "zone_cleared",
          `${this.zoneName(zone.index)} is clear: ${zone.safe} homes reached an exit${zone.caught > 0 ? `, ${zone.caught} were caught` : ""}.`,
          false,
        );
      }
    }
  }

  // ---- Read models ---------------------------------------------------------------------

  totals(): Totals {
    const totals: Totals = {
      homes: 0,
      vehicles: 0,
      notOrdered: 0,
      waiting: 0,
      staying: 0,
      onRoad: 0,
      safe: 0,
      caught: 0,
      caughtByChoice: 0,
      caughtOnRoad: 0,
    };
    let caughtByChoice = 0;
    let caughtOnRoad = 0;
    let staying = 0;
    for (const zone of this.zones) {
      const area = this.area.zones[zone.index];
      totals.homes += area.homes;
      totals.vehicles += area.vehicles;
      if (zone.status === "no_order") {
        totals.notOrdered += zone.atHome;
        totals.waiting += zone.queued;
      } else {
        totals.waiting += zone.atHome + zone.queued;
        staying += this.stayingAtHome[zone.index];
      }
      totals.onRoad += zone.onRoad;
      totals.safe += zone.safe;
      totals.caught += zone.caught;
      caughtByChoice += zone.caughtByChoice;
      caughtOnRoad += zone.caughtOnRoad;
    }
    totals.staying = staying;
    totals.caughtByChoice = caughtByChoice;
    totals.caughtOnRoad = caughtOnRoad;
    return totals;
  }

  /** Households queued at a zone's loading point, as vehicles. */
  queuedVehicles(zone: number): number {
    return this.zones[zone].queued * this.work[zone].vehiclesPerHome;
  }

  /** Households on the road by group, with the edge each is on (read-only). */
  packetStates(): PacketState[] {
    return this.packets.map((packet) => {
      const step = packet.steps[packet.stepIndex];
      return {
        id: packet.id,
        zone: packet.zone,
        edge: step ? step.edge : null,
        forward: step ? step.forward : true,
        fraction: step
          ? Math.min(1, packet.stepElapsedSeconds / edgeSeconds(this.area, step.edge))
          : 0,
        homes: packet.homes.length,
        vehicles: packet.vehicles,
        exitId: packet.exitId,
        stuck: packet.stuck,
      };
    });
  }

  /** Groups on the road, for the 3D view. */
  vehicleGroups(): VehicleGroup[] {
    return this.packets.map((packet) => {
      const step = packet.steps[packet.stepIndex];
      if (!step) {
        const node = this.area.nodes[this.area.zones[packet.zone].node];
        return {
          id: packet.id,
          zone: packet.zone,
          position: node,
          ahead: node,
          vehicles: packet.vehicles,
          stuck: packet.stuck,
        };
      }
      const seconds = edgeSeconds(this.area, step.edge);
      const fraction = packet.stepElapsedSeconds / seconds;
      return {
        id: packet.id,
        zone: packet.zone,
        position: pointAlongStep(this.area, step, fraction),
        ahead: pointAlongStep(this.area, step, Math.min(1, fraction + 0.05)),
        vehicles: packet.vehicles,
        stuck: packet.stuck,
      };
    });
  }

  unitPosition(unit: UnitState): LonLat {
    const step = unit.steps[unit.stepIndex];
    if (!step) return this.area.nodes[unit.node];
    return pointAlongStep(
      this.area,
      step,
      unit.stepElapsedSeconds / this.unitEdgeSeconds(unit, step.edge),
    );
  }

  /** Remaining path of a moving unit. */
  unitPath(unit: UnitState): LonLat[] {
    if (unit.status !== "en_route" && unit.status !== "returning") return [];
    return routeCoords(this.area, unit.steps, unit.stepIndex);
  }

  /** Minutes until a moving unit reaches its destination, or null when it is not moving. */
  unitEtaMinutes(unit: UnitState): number | null {
    if (unit.status !== "en_route" && unit.status !== "returning") return null;
    let seconds = unit.holdSeconds - unit.stepElapsedSeconds;
    for (let i = unit.stepIndex; i < unit.steps.length; i += 1)
      seconds += this.unitEdgeSeconds(unit, unit.steps[i].edge);
    return Math.max(0, seconds / SECONDS_PER_MINUTE);
  }

  /** Active evacuation routes, for the map. */
  activeRoutes(): { zone: number; exitId: string; route: Route }[] {
    return this.zones
      .filter(
        (zone) => zone.status === "ordered" && zone.route && !zone.routeBlocked && zone.exitId,
      )
      .map((zone) => ({ zone: zone.index, exitId: zone.exitId!, route: zone.route! }));
  }
}

interface LoadingPoints {
  /** Per zone, its loading nodes; the first is the zone's main loading node. */
  nodes: number[][];
  /** Per home, the index of its loading node in its zone's list. */
  homeGroup: Uint8Array;
}

const loadingCache = new WeakMap<DispatchArea, LoadingPoints>();
/** Spatial hash cell for the nearest-road-node search, ground metres (numerical only). */
const NODE_HASH_METERS = 250;

/**
 * Each zone's loading points (LOADING_POINTS_PER_ZONE, labelled assumption): the nodes nearest
 * its homes (over nodes with a public-road arc), then farthest-point sampling from the zone's
 * main loading node; every home loads at the nearest chosen node. Cached per area.
 */
export function loadingPoints(area: DispatchArea): LoadingPoints {
  const cached = loadingCache.get(area);
  if (cached) return cached;
  const lat0 = (area.bbox[1] + area.bbox[3]) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const key = (x: number, y: number) => `${x},${y}`;
  const cellOf = (p: LonLat): [number, number] => [
    Math.floor((p[0] * mPerDegLon) / NODE_HASH_METERS),
    Math.floor((p[1] * mPerDegLat) / NODE_HASH_METERS),
  ];
  const hash = new Map<string, number[]>();
  area.nodes.forEach((point, node) => {
    if ((area.outgoing[node]?.length ?? 0) === 0) return;
    const [x, y] = cellOf(point);
    const list = hash.get(key(x, y));
    if (list) list.push(node);
    else hash.set(key(x, y), [node]);
  });
  const nearestNode = (p: LonLat, fallback: number): number => {
    const [x, y] = cellOf(p);
    let best = fallback;
    let bestMeters = Infinity;
    for (let ring = 0; ring <= 4; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const node of hash.get(key(x + dx, y + dy)) ?? []) {
            const meters = groundMeters(area.nodes[node], p);
            if (meters < bestMeters) {
              bestMeters = meters;
              best = node;
            }
          }
        }
      }
      // A node within this ring's inner radius cannot be beaten by a farther ring.
      if (bestMeters <= ring * NODE_HASH_METERS) break;
    }
    return best;
  };
  const homeGroup = new Uint8Array(area.homes.length);
  const nodes = area.zones.map((zone) => {
    const homeNodes: number[] = [];
    for (let h = zone.firstHome; h < zone.firstHome + zone.homes; h += 1)
      homeNodes.push(nearestNode(area.homes[h].position, zone.node));
    const candidates = [...new Set(homeNodes)];
    const chosen = [zone.node];
    const distance = candidates.map((node) => groundMeters(area.nodes[node], area.nodes[zone.node]));
    while (chosen.length < LOADING_POINTS_PER_ZONE) {
      let pick = -1;
      for (let i = 0; i < candidates.length; i += 1)
        if (distance[i] > 0 && (pick < 0 || distance[i] > distance[pick])) pick = i;
      if (pick < 0) break;
      const node = candidates[pick];
      chosen.push(node);
      candidates.forEach((candidate, i) => {
        distance[i] = Math.min(distance[i], groundMeters(area.nodes[candidate], area.nodes[node]));
      });
    }
    homeNodes.forEach((homeNode, i) => {
      let best = 0;
      let bestMeters = Infinity;
      chosen.forEach((node, g) => {
        const meters = groundMeters(area.nodes[node], area.nodes[homeNode]);
        if (meters < bestMeters) {
          bestMeters = meters;
          best = g;
        }
      });
      homeGroup[zone.firstHome + i] = best;
    });
    return chosen;
  });
  const result = { nodes, homeGroup };
  loadingCache.set(area, result);
  return result;
}

/** Run with no orders to the horizon: what the model shows if nobody is told to leave. */
export function noActionBaseline(
  area: DispatchArea,
  exposure: FireExposure,
  horizonMinutes: number,
): Totals {
  const engine = new DispatchEngine(area, exposure, horizonMinutes, []);
  while (!engine.finished) engine.step();
  return engine.totals();
}
