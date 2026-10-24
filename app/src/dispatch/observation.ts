/**
 * Builds the agent's view of the simulation (`Observation`, contracts.ts) from the engine and
 * converts its wire orders back into engine orders. Pure: no React or network.
 */

import { FIRE_TACTICS, builtMeters, tacticBlocked } from "./fireTactics";
import type { TacticOption } from "./tacticOptions";
import type { FireObservation, Observation, WireOrder, ZoneObservation } from "./contracts";
import {
  EXIT_OPTIONS_PER_ZONE,
  FORECAST_LOOKAHEAD_MINUTES,
  ROUTE_LOOKAHEAD_MINUTES,
  DEPARTURE_SPREAD_MINUTES,
  STAGE_RELEASE_SLACK_MINUTES,
  SUPPORTED_DEPARTURE_SPREAD_MINUTES,
  type Alert,
  type DispatchEngine,
  type IgnitionEvent,
  type Order,
  type OrderOutcome,
} from "./engine";
import { ENGINE_HOLDS_FLAME_FEET, ENGINE_LINE_METERS_PER_MINUTE } from "./fireAttack";
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
  if (order.type === "stage_evacuation")
    return `stage ${order.zone_id} after ${order.after_zone_id} via ${order.exit_id}`;
  if (order.type === "dispatch_unit") return `${order.unit_id} → ${order.zone_id} (${order.task})`;
  if (order.type === "attack_fire") return `${order.unit_id} → fire ${order.fire_id} (fire_attack)`;
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
  nextCheckMinute: number;
  checkIntervalMinutes: number;
  previousDecisionMinute: number | null;
  wokeBecause: string[];
  alerts: Alert[];
  previousOutcomes: OrderOutcome[];
  previousSummary: string;
  /** What-if tactic options per fire index (tacticOptions.ts); fires missing have none. */
  tacticOptions?: ReadonlyMap<number, readonly TacticOption[]>;
  /** By the horizon with the fire fighting in effect now. */
  currentOutcome?: { burnedHectares: number; homesReached: number };
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
    const done = state.status === "cleared" || state.status === "overrun";
    const slack = done ? null : engine.orderSlackMinutes(state.index);
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
      impact: engine.zoneImpact(state.index),
      fire_core_eta_min: etaWithin(exposure.zoneCore[state.index], minute),
      assigned_exit: state.exitId,
      order_slack_min: slack === null ? null : Math.round(slack),
      wave: engine.waveOf(state.index),
      staged_after: state.stage ? area.zones[state.stage.after].id : null,
      staged_exit: state.stage?.exitId ?? null,
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
      fire_id: unit.fire === null ? null : engine.fires[unit.fire].target.id,
      eta_min: (() => {
        const eta = engine.unitEtaMinutes(unit);
        return eta === null ? null : Math.round(eta);
      })(),
      drive_min_to: drive,
    };
  });

  const fires: FireObservation[] = engine.fires.map((fire, index) => {
    const { target } = fire;
    const started = target.ignitedMinute !== null && target.ignitedMinute <= minute;
    const status: FireObservation["status"] =
      target.ignitedMinute === null
        ? "merged"
        : fire.outMinute !== null
          ? "out"
          : fire.heldAnnounced
            ? "held"
            : started
              ? "burning"
              : "not_started";
    const minutesFromNow = (at: number | null) =>
      at === null ? null : Math.max(0, Math.round(at - minute));
    const direct = fire.tactic === "direct";
    return {
      id: target.id,
      name: target.name,
      status,
      starts_in_min: status === "not_started" ? minutesFromNow(target.ignitedMinute) : null,
      area_ha:
        Math.round((engine.fireAreaSquareMeters(index) / SQUARE_METERS_PER_HECTARE) * 10) / 10,
      head_flame_ft: Number.isFinite(target.headFlameFeet)
        ? Math.round(target.headFlameFeet * 10) / 10
        : null,
      crowning: !Number.isFinite(target.headFlameFeet),
      structure_fire: target.structureFire,
      attackable: FIRE_TACTICS.some((tactic) => tacticBlocked(target, tactic) === null),
      tactics_blocked: {
        direct: tacticBlocked(target, "direct"),
        flank: tacticBlocked(target, "flank"),
        indirect: tacticBlocked(target, "indirect"),
      },
      tactic: fire.tactic,
      attacking: engine.fireAttackers(index).map((unit) => unit.id),
      line_built_m: direct ? Math.round(fire.lineMeters) : 0,
      line_needed_m:
        status === "burning" && direct ? Math.round(engine.fireLineNeededMeters(index)) : 0,
      out_eta_min:
        status === "burning" && direct ? minutesFromNow(engine.projectedOutMinute(index)) : null,
      out_minute: fire.outMinute,
      control_line_km: round1((fire.line?.plannedMeters ?? 0) / 1000),
      control_line_built_km: round1(builtMeters(fire.line, minute) / 1000),
      held_in_min:
        status === "burning" && !direct && fire.tactic !== null
          ? minutesFromNow(fire.heldMinute)
          : null,
      held_minute: fire.heldAnnounced ? fire.heldMinute : null,
      tactic_options: (inputs.tacticOptions?.get(index) ?? []).map((option) => ({
        tactic: option.tactic,
        engines: option.unitIds.length,
        unit_ids: option.unitIds,
        contained_in_min: minutesFromNow(option.containedMinute),
        burned_ha_at_horizon: Math.round(option.burnedHectares),
        homes_reached_by_horizon: option.homesReached,
        line_km: option.lineKm === null ? null : round1(option.lineKm),
        line_held_km: option.lineHeldKm === null ? null : round1(option.lineHeldKm),
      })),
    };
  });

  const outside = zones.filter((zone) => zone.impact === "outside");
  const outsideHomes = outside.reduce((sum, zone) => sum + zone.homes_total, 0);
  const totals = engine.totals();
  return {
    area: { id: area.id, name: area.name },
    clock: {
      minute,
      horizon_minutes: engine.horizonMinutes,
      next_check_minute: inputs.nextCheckMinute,
    },
    monitor: {
      check_interval_minutes: inputs.checkIntervalMinutes,
      previous_decision_minute: inputs.previousDecisionMinute,
      woke_because: inputs.wokeBecause,
    },
    fire: {
      burned_area_ha: Math.round((frame?.burnedAreaSquareMeters ?? 0) / SQUARE_METERS_PER_HECTARE),
      no_action_homes_exposed: inputs.baselineHomesExposed,
      wind_from_degrees: inputs.windFromDegrees,
      wind_speed_mph: inputs.windSpeedMph,
      upcoming_ignitions: inputs.ignitions.filter((i) => i.minute > minute),
      fire_path: {
        zones: zones.length - outside.length,
        homes: totals.homes - outsideHomes,
        outside_zones: outside.length,
        outside_homes: outsideHomes,
      },
      current_outcome: {
        burned_ha_at_horizon: Math.round(inputs.currentOutcome?.burnedHectares ?? 0),
        homes_reached_by_horizon: inputs.currentOutcome?.homesReached ?? 0,
      },
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
    fires,
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
      `impact classifies each zone from the fire model's first contact: burning (fire is there), threatened (within ${FORECAST_LOOKAHEAD_MINUTES} min), later (after that, by T+${engine.horizonMinutes}), outside (not reached by T+${engine.horizonMinutes}). Outside zones cannot be ordered or staged; the fire forecast is fixed, so a zone outside stays outside.`,
      `Fire ETAs are the fire model's forecast, shown up to ${FORECAST_LOOKAHEAD_MINUTES} min ahead; the fire spread is precomputed and is not changed by any order.`,
      `After an evacuation order households leave over ${DEPARTURE_SPREAD_MINUTES} min (${SUPPORTED_DEPARTURE_SPREAD_MINUTES} min while an engine is on scene on evacuation_support), then queue at the zone's loading point for road capacity.`,
      `Routes avoid roads the fire reaches within ${ROUTE_LOOKAHEAD_MINUTES} min. Zones whose exit becomes unreachable hold departures until given another exit.`,
      `A staged zone (stage_evacuation) gets no order yet; the simulator orders it out automatically once every household of its after_zone has left home and the loading queue, or as soon as its own order_slack_min falls to ${STAGE_RELEASE_SLACK_MINUTES}.`,
      "order_slack_min is the simulator's estimate: minutes until fire first reaches the zone minus the larger of the departure spread and the time its vehicles need to enter the route at the bottleneck. It ignores other zones sharing the road.",
      "structure_defense has no modelled effect on fire spread. Engines on scene in a zone withdraw automatically when fire is about to reach the zone core.",
      `fire_attack (attack_fire with a tactic): engines stage at the nearest road point to the fire's origin. direct: they build line around the whole edge at about ${Math.round(ENGINE_LINE_METERS_PER_MINUTE)} m/min each in grass (slower in heavier fuel) and the fire is out when the line rings its modelled edge, which keeps growing meanwhile; possible only where they can hold the head (head flame up to ${ENGINE_HOLDS_FLAME_FEET} ft and not crowning, or a structure fire). flank: they anchor at the heel and build line up both flanks toward the head; indirect: they build line around where the fire will be in about an hour, starting across the head. For flank and indirect the line is run through the fire model, which decides stretch by stretch whether it holds (the flame facing it is within what engines hold) or burns over; flanks burn far less intensely than the head. A fire that is out or held stops spreading: the forecast, zone ETAs and impact are recomputed, and its engines return to station. tactic_options are solved what-ifs; their contained_in_min, burned_ha_at_horizon and homes_reached_by_horizon compare with fire.current_outcome. Rough: ellipse perimeter for direct attack, no water supply, mop-up or rekindle.`,
      "A household counts as exposed when fire reaches its home before it leaves, reaches the zone core while it is still in the zone, or reaches the road it is on.",
      ...area.notes,
    ],
  };
}

/** Wire orders to engine orders; the engine validates them again against its live state. */
export function toEngineOrders(orders: readonly WireOrder[]): Order[] {
  return orders.map((order) => ({ ...order }));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
