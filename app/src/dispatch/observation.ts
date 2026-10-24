/**
 * Builds the agent's view of the simulation (`Observation`, contracts.ts) from the engine and
 * converts its wire orders back into engine orders. Pure: no React or network.
 */

import type { Observation, WireOrder, ZoneObservation } from "./contracts";
import {
  EXIT_OPTIONS_PER_ZONE,
  FORECAST_LOOKAHEAD_MINUTES,
  ROUTE_LOOKAHEAD_MINUTES,
  DEPARTURE_SPREAD_MINUTES,
  SUPPORTED_DEPARTURE_SPREAD_MINUTES,
  type Alert,
  type DispatchEngine,
  type IgnitionEvent,
  type Order,
  type OrderOutcome,
} from "./engine";
import { routeTo, shortestPathTree } from "./routing";

const SQUARE_METERS_PER_HECTARE = 10_000;

function etaWithin(arrival: number, now: number): number | null {
  if (!Number.isFinite(arrival)) return null;
  const minutes = arrival - now;
  if (minutes <= 0) return 0;
  return minutes <= FORECAST_LOOKAHEAD_MINUTES ? Math.round(minutes) : null;
}

function describeOrder(order: Order): string {
  if (order.type === "order_evacuation") return `evacuate ${order.zone_id} via ${order.exit_id}`;
  if (order.type === "dispatch_unit") return `${order.unit_id} → ${order.zone_id} (${order.task})`;
  return `recall ${order.unit_id}`;
}

/** The part of a fire frame the observation reads. */
export interface FrameSummary {
  elapsedMinutes: number;
  burnedAreaSquareMeters: number;
}

export interface ObservationInputs {
  engine: DispatchEngine;
  frames: readonly FrameSummary[];
  /** No-action baseline: households exposed by the horizon with no orders. */
  baselineHomesExposed: number | null;
  windFromDegrees: number;
  windSpeedMph: number;
  ignitions: IgnitionEvent[];
  nextRegularDecisionMinute: number;
  alerts: Alert[];
  previousOutcomes: OrderOutcome[];
  previousSummary: string;
}

export function buildObservation(inputs: ObservationInputs): Observation {
  const { engine } = inputs;
  const { area, exposure, minute } = engine;
  const blocked = engine.blockedAt(minute);

  const frame = [...inputs.frames].reverse().find((f) => f.elapsedMinutes <= minute);
  const unitsOnScene = new Map<number, string[]>();
  for (const unit of engine.units) {
    if (unit.status === "on_scene" && unit.zone !== null) {
      unitsOnScene.set(unit.zone, [...(unitsOnScene.get(unit.zone) ?? []), unit.id]);
    }
  }

  const zones: ZoneObservation[] = engine.zones.map((state) => {
    const zone = area.zones[state.index];
    const tree = shortestPathTree(area, zone.node, blocked);
    const options = area.exits
      .map((exit) => ({ exit, route: routeTo(area, tree, exit.node) }))
      .filter((option) => option.route !== null)
      .sort((a, b) => a.route!.seconds - b.route!.seconds)
      .slice(0, EXIT_OPTIONS_PER_ZONE)
      .map(({ exit, route }) => ({
        exit_id: exit.id,
        drive_min: Math.max(1, Math.round(route!.seconds / 60)),
        bottleneck_vph: Math.round(route!.bottleneckVph),
      }));
    // The assigned exit stays visible as an option while it is reachable.
    if (state.exitId && !options.some((o) => o.exit_id === state.exitId)) {
      const exit = area.exits.find((e) => e.id === state.exitId)!;
      const route = routeTo(area, tree, exit.node);
      if (route) {
        options.push({
          exit_id: exit.id,
          drive_min: Math.max(1, Math.round(route.seconds / 60)),
          bottleneck_vph: Math.round(route.bottleneckVph),
        });
      }
    }
    const perHome = engine.vehiclesPerHome(state.index);
    const waitingVehicles = (state.atHome + state.queued) * perHome;
    return {
      id: zone.id,
      name: zone.name,
      status: state.status,
      order_rank: state.orderRank,
      homes_total: zone.homes,
      homes_waiting: state.status === "no_order" ? 0 : state.atHome + state.queued,
      homes_en_route: state.onRoad,
      homes_out: state.safe,
      homes_exposed: state.caught,
      vehicles_waiting: Math.round(state.status === "no_order" ? 0 : waitingVehicles),
      fire_eta_min: etaWithin(exposure.zoneContact[state.index], minute),
      fire_core_eta_min: etaWithin(exposure.zoneCore[state.index], minute),
      assigned_exit: state.exitId,
      queue_clear_min:
        state.route && !state.routeBlocked
          ? Math.round((waitingVehicles / state.route.bottleneckVph) * 60)
          : null,
      route_blocked: state.routeBlocked,
      exit_options: options,
      units_on_scene: unitsOnScene.get(state.index) ?? [],
    };
  });

  const threatened = zones.filter(
    (zone) => zone.fire_eta_min !== null && zone.status !== "cleared" && zone.status !== "overrun",
  );
  const units = engine.units.map((unit) => {
    const drive: Record<string, number> = {};
    if (unit.status !== "stranded" && threatened.length > 0) {
      const tree = shortestPathTree(area, unit.node, blocked);
      for (const zone of threatened) {
        const route = routeTo(area, tree, area.zones.find((z) => z.id === zone.id)!.node);
        if (route) drive[zone.id] = Math.max(0, Math.round(route.seconds / 60));
      }
    }
    return {
      id: unit.id,
      station_id: unit.stationId,
      status: unit.status,
      task: unit.task,
      zone_id: unit.zone === null ? null : area.zones[unit.zone].id,
      eta_min: (() => {
        const eta = engine.unitEtaMinutes(unit);
        return eta === null ? null : Math.round(eta);
      })(),
      drive_min_to: drive,
    };
  });

  const totals = engine.totals();
  return {
    area: { id: area.id, name: area.name },
    clock: {
      minute,
      horizon_minutes: engine.horizonMinutes,
      next_regular_decision_minute: inputs.nextRegularDecisionMinute,
    },
    fire: {
      burned_area_ha: Math.round((frame?.burnedAreaSquareMeters ?? 0) / SQUARE_METERS_PER_HECTARE),
      no_action_homes_exposed: inputs.baselineHomesExposed,
      wind_from_degrees: inputs.windFromDegrees,
      wind_speed_mph: inputs.windSpeedMph,
      upcoming_ignitions: inputs.ignitions.filter((i) => i.minute > minute),
      evidence_class: "simulated",
    },
    totals: {
      homes: totals.homes,
      not_ordered: totals.notOrdered,
      waiting: totals.waiting,
      en_route: totals.onRoad,
      out: totals.safe,
      exposed: totals.caught,
    },
    zones,
    exits: area.exits.map((exit) => ({ id: exit.id, name: exit.name })),
    units,
    alerts: inputs.alerts.map(({ minute: m, type, text }) => ({ minute: m, type, text })),
    previous_outcomes: inputs.previousOutcomes.map((outcome) => ({
      order: describeOrder(outcome.order),
      accepted: outcome.accepted,
      note: outcome.note,
    })),
    previous_summary: inputs.previousSummary,
    model_notes: [
      `Fire ETAs are the fire model's forecast, shown up to ${FORECAST_LOOKAHEAD_MINUTES} min ahead; the fire spread is precomputed and is not changed by any order.`,
      `After an evacuation order households leave over ${DEPARTURE_SPREAD_MINUTES} min (${SUPPORTED_DEPARTURE_SPREAD_MINUTES} min while an engine is on scene on evacuation_support), then queue at the zone's loading point for road capacity.`,
      `Routes avoid roads the fire reaches within ${ROUTE_LOOKAHEAD_MINUTES} min. Zones whose exit becomes unreachable hold departures until given another exit.`,
      "structure_defense has no modelled effect on fire spread. Engines on scene withdraw automatically when fire is about to reach the zone core.",
      "A household counts as exposed when fire reaches its home before it leaves, reaches the zone core while it is still in the zone, or reaches the road it is on.",
      ...area.notes,
    ],
  };
}

/** Wire orders to engine orders; the engine validates them again against its live state. */
export function toEngineOrders(orders: readonly WireOrder[]): Order[] {
  return orders.map((order) => ({ ...order }));
}
