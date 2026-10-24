/**
 * Dispatch simulation: evacuation traffic and fire engines over the area road graph, stepped
 * one simulation minute at a time against a precomputed fire run. Deterministic, no
 * randomness, no network. The agent only issues orders (`applyOrders`); every route, travel
 * time, flow and count comes from here. See docs/adr/0012-dispatch-agent.md.
 *
 * Model, deliberately simple and visible in the UI:
 * - Residents leave only on an evacuation order. After the order, households become ready to
 *   drive uniformly over DEPARTURE_SPREAD_MINUTES (shorter while an engine supports the zone).
 * - Ready vehicles queue at the zone's loading node and enter their route at most at the
 *   route's bottleneck capacity; zones whose routes share an edge split its capacity.
 *   Downstream queues are not modelled: once released, a cohort drives at free-flow speed.
 * - Routing avoids every edge the fire model reaches within ROUTE_LOOKAHEAD_MINUTES.
 *   Drivers already on the road re-route around such edges by themselves; a zone whose
 *   ordered exit becomes unreachable holds departures until it is given another exit.
 * - Vehicles still in a zone when fire reaches its core, or on an edge fire reaches, are
 *   counted "exposed": the model's fire reached them. This is not a casualty estimate.
 * - Engines drive at the same free-flow speeds, ignoring congestion. "Evacuation support"
 *   shortens a zone's departure spread; "structure defense" has no modelled effect on the
 *   fire, whose spread is fixed by the precomputed run.
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

export const DECISION_INTERVAL_MINUTES = 10;
/** An alert can bring the next decision forward, but never closer than this to the last. */
export const MIN_DECISION_GAP_MINUTES = 3;
/** Routing avoids edges the fire model reaches within this many minutes. */
export const ROUTE_LOOKAHEAD_MINUTES = 10;
/** The agent sees modelled fire arrival this far ahead. */
export const FORECAST_LOOKAHEAD_MINUTES = 60;
/** Assumed spread of household departures after an order, minutes. */
export const DEPARTURE_SPREAD_MINUTES = 45;
export const SUPPORTED_DEPARTURE_SPREAD_MINUTES = 20;
/** Engines on scene withdraw when the fire is this close to the zone core. */
export const UNIT_WITHDRAW_MARGIN_MINUTES = 5;
export const EXIT_OPTIONS_PER_ZONE = 3;
const SECONDS_PER_MINUTE = 60;
const VEHICLE_EPSILON = 0.01;
const MAX_ALERTS = 200;

export type ZoneStatus = "no_order" | "ordered" | "cleared" | "overrun";
export type UnitStatus = "available" | "en_route" | "on_scene" | "returning" | "stranded";
export type UnitTask = "evacuation_support" | "structure_defense";

export interface ZoneState {
  index: number;
  status: ZoneStatus;
  exitId: string | null;
  orderedMinute: number | null;
  route: Route | null;
  routeBlocked: boolean;
  notReady: number;
  queued: number;
  arrived: number;
  exposed: number;
  fireContact: boolean;
}

interface Packet {
  id: number;
  zone: number;
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
}

export type AlertType =
  | "ignition"
  | "fire_contact"
  | "zone_overrun"
  | "route_blocked"
  | "route_changed"
  | "zone_cleared"
  | "unit_arrived"
  | "unit_withdrawn"
  | "unit_stranded"
  | "vehicles_exposed";

export interface Alert {
  minute: number;
  type: AlertType;
  text: string;
  /** Alerts that should bring the next agent decision forward. */
  urgent: boolean;
}

export type Order =
  | { type: "order_evacuation"; zone_id: string; exit_id: string; reason: string }
  | { type: "dispatch_unit"; unit_id: string; zone_id: string; task: UnitTask; reason: string }
  | { type: "recall_unit"; unit_id: string; reason: string };

export interface OrderOutcome {
  order: Order;
  accepted: boolean;
  /** Why it was rejected, or what the simulator did. */
  note: string;
}

export interface Totals {
  vehicles: number;
  notOrdered: number;
  waiting: number;
  enRoute: number;
  arrived: number;
  exposed: number;
}

export interface IgnitionEvent {
  minute: number;
  name: string;
}

export class DispatchEngine {
  readonly area: DispatchArea;
  readonly exposure: FireExposure;
  readonly horizonMinutes: number;
  minute = 0;
  zones: ZoneState[];
  units: UnitState[];
  alerts: Alert[] = [];
  private packets: Packet[] = [];
  private nextPacketId = 1;
  private exitIndex: Map<string, number>;
  private zoneIndex: Map<string, number>;
  private ignitions: IgnitionEvent[];

  constructor(
    area: DispatchArea,
    exposure: FireExposure,
    horizonMinutes: number,
    ignitions: IgnitionEvent[],
  ) {
    this.area = area;
    this.exposure = exposure;
    this.horizonMinutes = horizonMinutes;
    this.ignitions = [...ignitions].sort((a, b) => a.minute - b.minute);
    this.exitIndex = new Map(area.exits.map((exit, i) => [exit.id, i]));
    this.zoneIndex = new Map(area.zones.map((zone, i) => [zone.id, i]));
    this.zones = area.zones.map((zone, index) => ({
      index,
      status: "no_order",
      exitId: null,
      orderedMinute: null,
      route: null,
      routeBlocked: false,
      notReady: zone.vehicles,
      queued: 0,
      arrived: 0,
      exposed: 0,
      fireContact: false,
    }));
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
      })),
    );
    this.emitIgnitions(-1, 0);
    this.checkFire(0);
  }

  get finished(): boolean {
    return this.minute >= this.horizonMinutes;
  }

  /** Blocked for routing at `minute`: the fire model reaches the edge within the lookahead. */
  blockedAt(minute: number): (edge: number) => boolean {
    const arrival = this.exposure.edgeArrival;
    const limit = minute + ROUTE_LOOKAHEAD_MINUTES;
    return (edge) => arrival[edge] <= limit;
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
        this.alert("ignition", `Fire ${ignition.name} starts (scheduled ignition).`, true);
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

    if (order.type === "order_evacuation") {
      const index = this.zoneIndex.get(order.zone_id);
      if (index === undefined) return reject(`Unknown zone ${order.zone_id}.`);
      if (!this.exitIndex.has(order.exit_id)) return reject(`Unknown exit ${order.exit_id}.`);
      const zone = this.zones[index];
      if (zone.status === "overrun") return reject(`${order.zone_id} is already overrun by fire.`);
      const tree = shortestPathTree(this.area, this.area.zones[index].node, blocked);
      const route = routeTo(this.area, tree, this.exitNode(order.exit_id));
      if (!route) return reject(`${order.exit_id} is not reachable from ${order.zone_id} avoiding fire.`);
      const redirect = zone.status !== "no_order" && zone.exitId !== order.exit_id;
      if (zone.status === "no_order") {
        zone.status = "ordered";
        zone.orderedMinute = this.minute;
      }
      zone.exitId = order.exit_id;
      zone.route = route;
      zone.routeBlocked = false;
      if (redirect) {
        for (const packet of this.packets) {
          if (packet.zone === index) this.reroutePacket(packet, order.exit_id, blocked);
        }
      }
      const minutes = Math.round(route.seconds / SECONDS_PER_MINUTE);
      return {
        order,
        accepted: true,
        note: `${redirect ? "Redirected" : "Ordered"} via ${order.exit_id}, ${minutes} min free-flow.`,
      };
    }

    const unit = this.units.find((candidate) => candidate.id === order.unit_id);
    if (!unit) return reject(`Unknown unit ${order.unit_id}.`);
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
    if (this.zones[index].status === "overrun") return reject(`${order.zone_id} is overrun by fire.`);
    if (order.task !== "evacuation_support" && order.task !== "structure_defense") {
      return reject(`Unknown task ${String(order.task)}.`);
    }
    const route = routeTo(
      this.area,
      shortestPathTree(this.area, from, blocked),
      this.area.zones[index].node,
    );
    if (!route) return reject(`${unit.id} cannot reach ${order.zone_id} avoiding fire.`);
    this.sendUnit(unit, from, route, "en_route", order.task, index);
    const minutes = Math.round(route.seconds / SECONDS_PER_MINUTE);
    return { order, accepted: true, note: `${unit.id} en route to ${order.zone_id}, ${minutes} min.` };
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
    unit.task = task;
    unit.zone = zone;
    unit.status = route.steps.length === 0 ? (status === "returning" ? "available" : "on_scene") : status;
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
    this.updateZoneRoutes(blocked);
    this.departures();
    this.release();
    this.advancePackets(now, blocked);
    this.advanceUnits(now, blocked);
    this.checkCleared();
  }

  private checkFire(now: number): void {
    const { zoneContact, zoneCore } = this.exposure;
    for (const zone of this.zones) {
      const name = this.zoneName(zone.index);
      if (!zone.fireContact && zoneContact[zone.index] <= now) {
        zone.fireContact = true;
        const remaining = Math.round(zone.notReady + zone.queued);
        this.alert(
          "fire_contact",
          `Fire reaches the edge of ${name}; ${remaining} vehicles have not left.`,
          zone.status !== "cleared" && remaining > 0,
        );
      }
      if (zone.status !== "overrun" && zone.status !== "cleared" && zoneCore[zone.index] <= now) {
        const caught = zone.notReady + zone.queued;
        zone.exposed += caught;
        zone.notReady = 0;
        zone.queued = 0;
        zone.status = "overrun";
        this.alert("zone_overrun", `Fire reaches the core of ${name}: ${Math.round(caught)} vehicles still there.`, true);
      }
    }
  }

  private updateZoneRoutes(blocked: (edge: number) => boolean): void {
    for (const zone of this.zones) {
      if (zone.status !== "ordered" || !zone.exitId) continue;
      if (zone.route && !zone.route.steps.some((step) => blocked(step.edge))) continue;
      const tree = shortestPathTree(this.area, this.area.zones[zone.index].node, blocked);
      const route = routeTo(this.area, tree, this.exitNode(zone.exitId));
      if (route) {
        zone.route = route;
        if (zone.routeBlocked) zone.routeBlocked = false;
        else {
          this.alert(
            "route_changed",
            `Route from ${zone.index >= 0 ? this.area.zones[zone.index].id : ""} to ${zone.exitId} re-planned around fire.`,
            false,
          );
        }
      } else if (!zone.routeBlocked) {
        zone.route = null;
        zone.routeBlocked = true;
        this.alert(
          "route_blocked",
          `${this.zoneName(zone.index)} cannot reach ${zone.exitId} without crossing fire; departures are held until it gets another exit.`,
          true,
        );
      }
    }
  }

  private departures(): void {
    const supported = new Set(
      this.units
        .filter((unit) => unit.status === "on_scene" && unit.task === "evacuation_support" && unit.zone !== null)
        .map((unit) => unit.zone as number),
    );
    for (const zone of this.zones) {
      if (zone.status !== "ordered" || zone.notReady <= 0) continue;
      const spread = supported.has(zone.index) ? SUPPORTED_DEPARTURE_SPREAD_MINUTES : DEPARTURE_SPREAD_MINUTES;
      const leaving = Math.min(zone.notReady, this.area.zones[zone.index].vehicles / spread);
      zone.notReady -= leaving;
      zone.queued += leaving;
    }
  }

  /** Release queued vehicles onto their routes, sharing each edge's capacity between zones. */
  private release(): void {
    const desired = new Map<number, number>();
    const load = new Map<number, number>();
    for (const zone of this.zones) {
      if (zone.status !== "ordered" || !zone.route || zone.routeBlocked || zone.queued <= VEHICLE_EPSILON) continue;
      const want = Math.min(zone.queued, zone.route.bottleneckVph / SECONDS_PER_MINUTE);
      desired.set(zone.index, want);
      for (const step of zone.route.steps) load.set(step.edge, (load.get(step.edge) ?? 0) + want);
    }
    for (const [index, want] of desired) {
      const zone = this.zones[index];
      let factor = 1;
      for (const step of zone.route!.steps) {
        const capacityPerMinute = this.area.edges[step.edge].capacityVph / SECONDS_PER_MINUTE;
        factor = Math.min(factor, capacityPerMinute / (load.get(step.edge) ?? capacityPerMinute));
      }
      const vehicles = want * factor;
      if (vehicles <= VEHICLE_EPSILON) continue;
      zone.queued -= vehicles;
      if (zone.route!.steps.length === 0) {
        zone.arrived += vehicles;
        continue;
      }
      this.packets.push({
        id: this.nextPacketId++,
        zone: index,
        vehicles,
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
        if (candidate && (!best || candidate.seconds < best.route.seconds)) best = { route: candidate, id: exit.id };
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
    const exposedByZone = new Map<number, number>();
    const remaining: Packet[] = [];
    for (const packet of this.packets) {
      const zone = this.zones[packet.zone];
      const current = packet.steps[packet.stepIndex];
      if (current && arrival[current.edge] <= now) {
        zone.exposed += packet.vehicles;
        exposedByZone.set(packet.zone, (exposedByZone.get(packet.zone) ?? 0) + packet.vehicles);
        continue;
      }
      const ahead = packet.steps.slice(packet.stepIndex + 1);
      if (packet.stuck || ahead.some((step) => blocked(step.edge))) {
        this.reroutePacket(packet, zone.exitId ?? packet.exitId, blocked);
      }
      if (!packet.stuck) {
        let budget = SECONDS_PER_MINUTE;
        while (budget > 0 && packet.stepIndex < packet.steps.length) {
          const left = edgeSeconds(this.area, packet.steps[packet.stepIndex].edge) - packet.stepElapsedSeconds;
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
      if (packet.stepIndex >= packet.steps.length) zone.arrived += packet.vehicles;
      else remaining.push(packet);
    }
    this.packets = remaining;
    for (const [index, vehicles] of exposedByZone) {
      this.alert(
        "vehicles_exposed",
        `${Math.round(vehicles)} vehicles from ${this.area.zones[index].id} caught on a road the fire reached.`,
        true,
      );
    }
  }

  private advanceUnits(now: number, blocked: (edge: number) => boolean): void {
    const core = this.exposure.zoneCore;
    for (const unit of this.units) {
      if (unit.status === "on_scene" && unit.zone !== null && core[unit.zone] <= now + UNIT_WITHDRAW_MARGIN_MINUTES) {
        const zoneId = this.area.zones[unit.zone].id;
        const route = routeTo(this.area, shortestPathTree(this.area, unit.node, blocked), unit.homeNode);
        if (route) {
          this.sendUnit(unit, unit.node, route, "returning", null, null);
          this.alert("unit_withdrawn", `${unit.id} withdraws from ${zoneId}: fire is about to reach it.`, true);
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
        const target = unit.status === "returning" || unit.zone === null ? unit.homeNode : this.area.zones[unit.zone].node;
        const route = routeTo(this.area, shortestPathTree(this.area, from, blocked), target);
        if (route) {
          const current = unit.stepElapsedSeconds > 0 ? [unit.steps[unit.stepIndex]] : [];
          unit.steps = [...current, ...route.steps];
          unit.stepIndex = 0;
        } else {
          const home = routeTo(this.area, shortestPathTree(this.area, from, blocked), unit.homeNode);
          if (home && unit.status !== "returning") {
            this.alert("unit_stranded", `${unit.id} cannot reach its assignment avoiding fire; returning.`, true);
            this.sendUnit(unit, from, home, "returning", null, null);
          } else {
            unit.status = "stranded";
            this.alert("unit_stranded", `${unit.id} has no fire-free route.`, true);
            continue;
          }
        }
      }
      let budget = SECONDS_PER_MINUTE;
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
      if (unit.stepIndex >= unit.steps.length) {
        unit.steps = [];
        unit.stepIndex = 0;
        if (unit.status === "returning") {
          unit.status = "available";
          unit.task = null;
          unit.zone = null;
        } else {
          unit.status = "on_scene";
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
    const enRoute = this.enRouteByZone();
    for (const zone of this.zones) {
      if (zone.status !== "ordered") continue;
      if (zone.notReady + zone.queued + (enRoute.get(zone.index) ?? 0) <= VEHICLE_EPSILON) {
        zone.status = "cleared";
        this.alert("zone_cleared", `${this.zoneName(zone.index)} is clear: every vehicle reached an exit.`, false);
      }
    }
  }

  private enRouteByZone(): Map<number, number> {
    const totals = new Map<number, number>();
    for (const packet of this.packets) totals.set(packet.zone, (totals.get(packet.zone) ?? 0) + packet.vehicles);
    return totals;
  }

  // ---- Read models ---------------------------------------------------------------------

  totals(): Totals {
    let vehicles = 0;
    let notOrdered = 0;
    let waiting = 0;
    let arrived = 0;
    let exposed = 0;
    for (const zone of this.zones) {
      vehicles += this.area.zones[zone.index].vehicles;
      if (zone.status === "no_order") notOrdered += zone.notReady;
      else waiting += zone.notReady + zone.queued;
      arrived += zone.arrived;
      exposed += zone.exposed;
    }
    const enRoute = this.packets.reduce((sum, packet) => sum + packet.vehicles, 0);
    return { vehicles, notOrdered, waiting, enRoute, arrived, exposed };
  }

  /** Cohorts on the road, for the map. */
  vehiclePositions(): { position: LonLat; vehicles: number; zone: number; stuck: boolean }[] {
    return this.packets.map((packet) => {
      const step = packet.steps[packet.stepIndex];
      const fraction = step ? packet.stepElapsedSeconds / edgeSeconds(this.area, step.edge) : 1;
      return {
        position: step ? pointAlongStep(this.area, step, fraction) : this.area.nodes[this.area.zones[packet.zone].node],
        vehicles: packet.vehicles,
        zone: packet.zone,
        stuck: packet.stuck,
      };
    });
  }

  unitPosition(unit: UnitState): LonLat {
    const step = unit.steps[unit.stepIndex];
    if (!step) return this.area.nodes[unit.node];
    return pointAlongStep(this.area, step, unit.stepElapsedSeconds / edgeSeconds(this.area, step.edge));
  }

  /** Remaining path of a moving unit. */
  unitPath(unit: UnitState): LonLat[] {
    if (unit.status !== "en_route" && unit.status !== "returning") return [];
    return routeCoords(this.area, unit.steps, unit.stepIndex);
  }

  /** Active evacuation routes, for the map. */
  activeRoutes(): { zone: number; exitId: string; coords: LonLat[] }[] {
    return this.zones
      .filter((zone) => zone.status === "ordered" && zone.route && !zone.routeBlocked && zone.exitId)
      .map((zone) => ({ zone: zone.index, exitId: zone.exitId!, coords: routeCoords(this.area, zone.route!.steps) }));
  }

  enRoute(zone: number): number {
    return this.enRouteByZone().get(zone) ?? 0;
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
