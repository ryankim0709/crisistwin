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
 *   the zone).
 * - Households that have left queue at the zone's loading node and enter their route at most
 *   at the route's bottleneck capacity; zones whose routes share an edge split its capacity.
 *   Downstream queues are not modelled: once released, a group drives at free-flow speed.
 * - Routing avoids every edge the fire model reaches within ROUTE_LOOKAHEAD_MINUTES, and every
 *   edge the planner has closed (a road closure or a failed bridge, closed for the whole run).
 *   Drivers already on the road re-route around such edges by themselves; a zone whose
 *   ordered exit becomes unreachable holds departures until it is given another exit.
 * - A household is "caught" when the modelled fire reaches its home before it leaves, when
 *   fire reaches its zone's core (loading node or centroid) while it is still in the zone, or
 *   when fire reaches the road it is on. This is a model count, not a casualty estimate.
 * - Engines drive at the same free-flow speeds, ignoring congestion; a station outside the
 *   road box first covers its straight-line approach at APPROACH_SPEED_KPH. "Evacuation
 *   support" shortens a zone's departure spread; "structure defense" has no modelled effect on
 *   the fire, whose spread is fixed by the precomputed run.
 * - Staged waves: a zone can be staged behind another ordered or staged zone. It gets its
 *   order automatically once every household of that zone has left home and the loading
 *   queue (the road is free for the next wave), or earlier when its own order slack falls to
 *   STAGE_RELEASE_SLACK_MINUTES. Order slack is this module's estimate, not the agent's.
 * - Every order, staging, release and blocked route records a resident notice: what the
 *   households of that zone would be told. Notices are simulated; nothing is sent anywhere.
 */

import type { DispatchArea, LonLat } from "./area";
import type { FireExposure } from "./fireExposure";
import {
  edgeSeconds,
  pointAlongStep,
  routeCoords,
  routeTo,
  shortestPathTree,
  stepHead,
  type PathStep,
  type Route,
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
export const EXIT_OPTIONS_PER_ZONE = 3;
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
export type UnitStatus = "available" | "en_route" | "on_scene" | "returning" | "stranded";
export type UnitTask = "evacuation_support" | "structure_defense";

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
  caught: number;
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
export type NoticeKind = "leave_now" | "prepare" | "redirect" | "hold";

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

interface ZoneWork {
  /** Offset (within the zone's homes) of the next household to leave. */
  nextDeparture: number;
  departBudget: number;
  /** Home indices waiting at the loading point, first in first out. */
  queue: number[];
  releaseBudget: number;
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

export interface UnitState {
  id: string;
  stationId: string;
  homeNode: number;
  status: UnitStatus;
  task: UnitTask | null;
  /** Zone index the unit is heading to or working in. */
  zone: number | null;
  /** Node the unit is at, or the tail of the edge it is on. */
  node: number;
  steps: PathStep[];
  stepIndex: number;
  stepElapsedSeconds: number;
  /** Seconds still to cover on a station's approach before driving the route. */
  holdSeconds: number;
  /** Minute the unit arrived on scene, for the crews panel. */
  arrivedMinute: number | null;
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
  | "wave_released";

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
  /** Ordered, at home or queued at the loading point. */
  waiting: number;
  onRoad: number;
  safe: number;
  caught: number;
}

export interface IgnitionEvent {
  minute: number;
  name: string;
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
  readonly exposure: FireExposure;
  readonly horizonMinutes: number;
  minute = 0;
  zones: ZoneState[];
  units: UnitState[];
  /** Per home (index into `area.homes`). */
  readonly homeStatus: Uint8Array;
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
  /** Edges closed to traffic for the whole run (indices into `area.edges`). */
  readonly closedEdges: ReadonlySet<number>;

  constructor(
    area: DispatchArea,
    exposure: FireExposure,
    horizonMinutes: number,
    ignitions: IgnitionEvent[],
    closedEdges: ReadonlySet<number> = new Set(),
  ) {
    this.area = area;
    this.closedEdges = closedEdges;
    this.exposure = exposure;
    this.horizonMinutes = horizonMinutes;
    this.ignitions = [...ignitions].sort((a, b) => a.minute - b.minute);
    this.exitIndex = new Map(area.exits.map((exit, i) => [exit.id, i]));
    this.zoneIndex = new Map(area.zones.map((zone, i) => [zone.id, i]));
    this.stationIndex = new Map(area.stations.map((station, i) => [station.id, i]));
    this.homeStatus = new Uint8Array(area.homes.length);
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
      fireContact: false,
      stage: null,
      wave: null,
    }));
    this.work = area.zones.map((zone) => {
      const fireOrder: number[] = [];
      for (let h = zone.firstHome; h < zone.firstHome + zone.homes; h += 1) {
        if (Number.isFinite(exposure.homeArrival[h])) fireOrder.push(h);
      }
      fireOrder.sort((a, b) => exposure.homeArrival[a] - exposure.homeArrival[b]);
      return {
        nextDeparture: 0,
        departBudget: 0,
        queue: [],
        releaseBudget: 0,
        fireOrder,
        fireNext: 0,
        vehiclesPerHome: zone.homes > 0 ? zone.vehicles / zone.homes : 0,
      };
    });
    this.units = area.stations.flatMap((station) =>
      station.units.map((unit) => ({
        id: unit.id,
        stationId: station.id,
        homeNode: station.node,
        status: "available" as UnitStatus,
        task: null,
        zone: null,
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
    const closed = this.closedEdges;
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
    for (const ignition of this.ignitions) {
      if (ignition.minute > after && ignition.minute <= upTo) {
        this.alert("ignition", `Fire ${ignition.name} starts.`, true);
      }
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
      const route = routeTo(this.area, shortestPathTree(this.area, from, blocked), unit.homeNode);
      if (!route) return reject(`${unit.id} has no fire-free route home.`);
      this.sendUnit(unit, from, route, "returning", null, null);
      return { order, accepted: true, note: `Returning to ${unit.stationId}.` };
    }

    const index = this.zoneIndex.get(order.zone_id);
    if (index === undefined) return reject(`Unknown zone ${order.zone_id}.`);
    if (this.zones[index].status === "overrun")
      return reject(`${order.zone_id} is overrun by fire.`);
    if (order.task !== "evacuation_support" && order.task !== "structure_defense") {
      return reject(`Unknown task ${String(order.task)}.`);
    }
    const route = routeTo(
      this.area,
      shortestPathTree(this.area, from, blocked),
      this.area.zones[index].node,
    );
    if (!route)
      return reject(`${unit.id} cannot reach ${order.zone_id} avoiding fire and closed roads.`);
    const fromStation = unit.status === "available";
    this.sendUnit(unit, from, route, "en_route", order.task, index);
    if (fromStation) unit.holdSeconds = this.approachSeconds(unit);
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
          (before.status === "ordered" && before.atHome + before.queued === 0) ||
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

  private approachSeconds(unit: UnitState): number {
    const station = this.area.stations[this.stationIndex.get(unit.stationId) ?? -1];
    return station ? station.approachMeters / (APPROACH_SPEED_KPH / 3.6) : 0;
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
  ): void {
    unit.node = from;
    unit.steps = route.steps;
    unit.stepIndex = 0;
    unit.stepElapsedSeconds = 0;
    unit.holdSeconds = 0;
    unit.task = task;
    unit.zone = zone;
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
    this.checkCleared();
  }

  private catchHome(zone: ZoneState, home: number): void {
    const status = this.homeStatus[home];
    if (status === HomeStatus.idle || status === HomeStatus.ordered) zone.atHome -= 1;
    else if (status === HomeStatus.queued) zone.queued -= 1;
    else return;
    this.homeStatus[home] = HomeStatus.caught;
    zone.caught += 1;
  }

  private checkFire(now: number): void {
    const { zoneContact, zoneCore, homeArrival } = this.exposure;
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
      if (zone.status !== "overrun" && zone.status !== "cleared" && zoneCore[zone.index] <= now) {
        const before = zone.caught;
        const { firstHome, homes } = this.area.zones[zone.index];
        for (let h = firstHome; h < firstHome + homes; h += 1) this.catchHome(zone, h);
        work.queue = [];
        zone.status = "overrun";
        zone.stage = null;
        this.alert(
          "zone_overrun",
          `Fire reaches the core of ${name}: ${zone.caught - before} homes still there are caught.`,
          true,
        );
      }
    }
  }

  private updateZoneRoutes(blocked: (edge: number) => boolean): void {
    for (const zone of this.zones) {
      if (zone.status !== "ordered" || !zone.exitId) continue;
      if (zone.route && !zone.route.steps.some((step) => blocked(step.edge))) continue;
      const tree = shortestPathTree(this.area, this.area.zones[zone.index].node, blocked);
      const route = routeTo(this.area, tree, this.exitNode(zone.exitId));
      const id = this.area.zones[zone.index].id;
      if (route) {
        zone.route = route;
        if (zone.routeBlocked) zone.routeBlocked = false;
        else
          this.alert(
            "route_changed",
            `Route from ${id} to ${zone.exitId} re-planned around fire.`,
            false,
          );
      } else if (!zone.routeBlocked) {
        zone.route = null;
        zone.routeBlocked = true;
        this.notice(
          zone.index,
          "hold",
          zone.exitId,
          `Your route to ${this.exitLabel(zone.exitId)} is cut off by fire. If you have not left, wait for a new route.`,
        );
        this.alert(
          "route_blocked",
          `${this.zoneName(zone.index)} cannot reach ${zone.exitId} without crossing fire or a closed road; departures are held until it gets another exit.`,
          true,
        );
      }
    }
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
      if (zone.status !== "ordered" || zone.atHome <= 0) continue;
      const { firstHome, homes } = this.area.zones[zone.index];
      const work = this.work[zone.index];
      const spread = supported.has(zone.index)
        ? SUPPORTED_DEPARTURE_SPREAD_MINUTES
        : DEPARTURE_SPREAD_MINUTES;
      work.departBudget += homes / spread;
      while (work.departBudget >= 1 && work.nextDeparture < homes) {
        const home = firstHome + work.nextDeparture++;
        if (this.homeStatus[home] !== HomeStatus.ordered) continue;
        this.homeStatus[home] = HomeStatus.queued;
        work.queue.push(home);
        zone.atHome -= 1;
        zone.queued += 1;
        work.departBudget -= 1;
      }
      if (work.nextDeparture >= homes) work.departBudget = 0;
    }
  }

  /** Release queued households onto their routes, sharing each edge's capacity between zones. */
  private release(): void {
    const desired = new Map<number, number>();
    const load = new Map<number, number>();
    for (const zone of this.zones) {
      const work = this.work[zone.index];
      if (zone.status !== "ordered" || !zone.route || zone.routeBlocked || work.queue.length === 0)
        continue;
      const want = Math.min(
        work.queue.length * work.vehiclesPerHome,
        zone.route.bottleneckVph / SECONDS_PER_MINUTE,
      );
      desired.set(zone.index, want);
      for (const step of zone.route.steps) load.set(step.edge, (load.get(step.edge) ?? 0) + want);
    }
    for (const [index, want] of desired) {
      const zone = this.zones[index];
      const work = this.work[index];
      let factor = 1;
      for (const step of zone.route!.steps) {
        const capacityPerMinute = this.area.edges[step.edge].capacityVph / SECONDS_PER_MINUTE;
        factor = Math.min(factor, capacityPerMinute / (load.get(step.edge) ?? capacityPerMinute));
      }
      const vehicles = want * factor;
      if (vehicles <= VEHICLE_EPSILON || work.vehiclesPerHome <= 0) continue;
      work.releaseBudget += vehicles / work.vehiclesPerHome;
      const count = Math.min(work.queue.length, Math.floor(work.releaseBudget + 1e-9));
      work.releaseBudget -= count;
      if (work.queue.length === count) work.releaseBudget = Math.min(work.releaseBudget, 1);
      if (count === 0) continue;
      const homes = work.queue.splice(0, count);
      zone.queued -= count;
      if (zone.route!.steps.length === 0) {
        for (const home of homes) this.homeStatus[home] = HomeStatus.safe;
        zone.safe += count;
        continue;
      }
      for (const home of homes) this.homeStatus[home] = HomeStatus.driving;
      zone.onRoad += count;
      this.packets.push({
        id: this.nextPacketId++,
        zone: index,
        homes,
        vehicles: count * work.vehiclesPerHome,
        exitId: zone.exitId!,
        steps: zone.route!.steps,
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
        const route = routeTo(
          this.area,
          shortestPathTree(this.area, unit.node, blocked),
          unit.homeNode,
        );
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
          unit.status === "returning" || unit.zone === null
            ? unit.homeNode
            : this.area.zones[unit.zone].node;
        const route = routeTo(this.area, shortestPathTree(this.area, from, blocked), target);
        if (route) {
          const current = unit.stepElapsedSeconds > 0 ? [unit.steps[unit.stepIndex]] : [];
          unit.steps = [...current, ...route.steps];
          unit.stepIndex = 0;
        } else {
          const home = routeTo(
            this.area,
            shortestPathTree(this.area, from, blocked),
            unit.homeNode,
          );
          if (home && unit.status !== "returning") {
            this.alert(
              "unit_stranded",
              `${unit.id} cannot reach its assignment avoiding fire; returning.`,
              true,
            );
            this.sendUnit(unit, from, home, "returning", null, null);
          } else {
            unit.status = "stranded";
            this.alert("unit_stranded", `${unit.id} has no fire-free route.`, true);
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
        const left = edgeSeconds(this.area, step.edge) - unit.stepElapsedSeconds;
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
        } else {
          unit.status = "on_scene";
          unit.arrivedMinute = now;
          this.alert(
            "unit_arrived",
            `${unit.id} on scene at ${this.area.zones[unit.zone!].id} (${unit.task === "evacuation_support" ? "evacuation support" : "structure defense"}).`,
            false,
          );
        }
      }
    }
  }

  private checkCleared(): void {
    for (const zone of this.zones) {
      if (zone.status !== "ordered") continue;
      if (zone.atHome + zone.queued + zone.onRoad === 0) {
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
      onRoad: 0,
      safe: 0,
      caught: 0,
    };
    for (const zone of this.zones) {
      const area = this.area.zones[zone.index];
      totals.homes += area.homes;
      totals.vehicles += area.vehicles;
      if (zone.status === "no_order") totals.notOrdered += zone.atHome;
      else totals.waiting += zone.atHome + zone.queued;
      totals.onRoad += zone.onRoad;
      totals.safe += zone.safe;
      totals.caught += zone.caught;
    }
    return totals;
  }

  /** Households queued at a zone's loading point, as vehicles. */
  queuedVehicles(zone: number): number {
    return this.zones[zone].queued * this.work[zone].vehiclesPerHome;
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
      unit.stepElapsedSeconds / edgeSeconds(this.area, step.edge),
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
      seconds += edgeSeconds(this.area, unit.steps[i].edge);
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
