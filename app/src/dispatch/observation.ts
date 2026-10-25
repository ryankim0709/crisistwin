/**
 * Builds the agent's view of the simulation (`Observation`, contracts.ts) from the engine and
 * converts its wire orders back into engine orders. Pure: no React or network.
 */

import { FIRE_TACTICS, builtMeters, tacticBlocked } from "./fireTactics";
import { TURNOUT_SECONDS } from "./engine";
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
import { roadLabel } from "./area";
import { GROUND_APPARATUS } from "../studio/apparatus";
import { DELAY_MEDIAN_MINUTES, ORDER_COMPLIANCE } from "../population/householdBehavior";
import type { NoAccess } from "./engine";

const SQUARE_METERS_PER_HECTARE = 10_000;
/** Named roads listed in `roads.fire_cut_roads`, nearest-in-time first. */
const MAX_FIRE_CUT_ROADS = 12;

function etaWithin(arrival: number, now: number): number | null {
  if (!Number.isFinite(arrival)) return null;
  const minutes = arrival - now;
  if (minutes <= 0) return 0;
  return minutes <= FORECAST_LOOKAHEAD_MINUTES ? Math.round(minutes) : null;
}

/**
 * Roads routing cannot use now: the planner's closures, and the road segments the fire model
 * reaches within the routing lookahead (named roads earliest first).
 */
export function roadsObservation(engine: DispatchEngine): Observation["roads"] {
  const { area, minute } = engine;
  const arrival = engine.exposure.edgeArrival;
  const limit = minute + ROUTE_LOOKAHEAD_MINUTES;
  let segments = 0;
  const firstCut = new Map<string, number>();
  area.edges.forEach((edge, index) => {
    if (engine.closedEdges.has(index) || !(arrival[index] <= limit)) return;
    segments += 1;
    if (!edge.name) return;
    const label = roadLabel(edge);
    firstCut.set(label, Math.min(firstCut.get(label) ?? Infinity, arrival[index]));
  });
  return {
    planner_closed: engine.roadClosures.map(({ edge, minute: since }) => ({
      road: roadLabel(area.edges[edge]),
      bridge: area.edges[edge].bridge,
      since_minute: since,
    })),
    fire_cut_segments: segments,
    fire_cut_roads: [...firstCut.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, MAX_FIRE_CUT_ROADS)
      .map(([road]) => road),
  };
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
  /** Simulated minutes the agent's orders are expected to take to land. */
  decisionDelayMinutes?: number;
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
      homes_staying: state.status === "no_order" ? 0 : engine.stayingHomes(state.index),
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
    const noAccess: Record<string, string> = {};
    if (unit.status !== "stranded" && threatened.length > 0) {
      const tree = engine.unitTree(unit, unit.node, blocked);
      for (const zone of threatened) {
        const node = area.zones.find((z) => z.id === zone.id)!.node;
        const route = routeTo(area, tree, node);
        if (route) drive[zone.id] = Math.max(0, Math.round(route.seconds / 60));
        else {
          const reason = engine.noAccessTo(unit, unit.node, node, blocked);
          if (reason) noAccess[zone.id] = noAccessText(reason);
        }
      }
    }
    if (unit.status !== "stranded" && engine.apparatusAccess) {
      engine.fires.forEach((fire, index) => {
        if (!engine.fireReported(index) || (unit.task === "fire_attack" && unit.fire === index)) return;
        if (engine.attackRoute(unit, index)) return;
        const reason = engine.attackNoAccess(unit, index);
        if (reason) noAccess[fire.target.id] = noAccessText(reason);
      });
    }
    return {
      id: unit.id,
      apparatus: GROUND_APPARATUS[unit.kind].label,
      access_class: engine.unitClass(unit),
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
      no_access: noAccess,
    };
  });

  // A fire that has ignited but not been reported (response/report.ts) is not visible yet.
  const fires: FireObservation[] = engine.fires.flatMap((fire, index) => {
    if (engine.fireBurning(index) && !engine.fireReported(index)) return [];
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
      decision_delay_min: Math.round((inputs.decisionDelayMinutes ?? 0) * 10) / 10,
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
    roads: roadsObservation(engine),
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
      `Fire ETAs are the fire model's forecast, shown up to ${FORECAST_LOOKAHEAD_MINUTES} min ahead; the fire spread changes only when engines put a fire out or hold it with line (it is then re-run).`,
      `Live clock: the simulation keeps running while you decide. Your orders take effect when your answer arrives, about clock.decision_delay_min simulated minutes after this observation, from wherever fire, traffic and engines are by then. Engines leaving a station need ${Math.round(TURNOUT_SECONDS)} s turnout before driving. tactic_options already account for both delays.`,
      engine.hasDepartureDelays
        ? `Household behaviour in this run is drawn from fire evacuation surveys and replaces the uniform departure spread: about ${Math.round(ORDER_COMPLIANCE * 100)}% of ordered households leave, each after its own delay from the order (median ${Math.round(DELAY_MEDIAN_MINUTES)} min, long tail; delays shrink by ${SUPPORTED_DEPARTURE_SPREAD_MINUTES}/${DEPARTURE_SPREAD_MINUTES} while an engine is on scene on evacuation_support); the rest stay home by choice whatever you order (homes_staying, counted inside homes_waiting). Households also leave on their own when the fire reaches their zone (some even with no order) or comes within about 500 m of the house, and anyone asleep (23:00-06:00) at their first warning takes about 18 min longer. A zone counts as cleared once everyone who will leave on the order has left. They queue at up to 4 loading points per zone for road capacity. homes_exposed is a model count of households the fire reached before they got out, not casualties. order_slack_min still assumes the uniform spread.`
        : `After an evacuation order households leave over ${DEPARTURE_SPREAD_MINUTES} min (${SUPPORTED_DEPARTURE_SPREAD_MINUTES} min while an engine is on scene on evacuation_support), then queue at the zone's loading point for road capacity.`,
      `Routes avoid roads the fire reaches within ${ROUTE_LOOKAHEAD_MINUTES} min (roads.fire_cut_*) and roads the planner closed (roads.planner_closed, the planner's assumption; they can close or reopen a road at any minute). exit_options already avoid both. Zones whose exit becomes unreachable hold departures until given another exit.`,
      `A staged zone (stage_evacuation) gets no order yet; the simulator orders it out automatically once every household of its after_zone has left home and the loading queue, or as soon as its own order_slack_min falls to ${STAGE_RELEASE_SLACK_MINUTES}.`,
      "order_slack_min is the simulator's estimate: minutes until fire first reaches the zone minus the larger of the departure spread and the time its vehicles need to enter the route at the bottleneck. It ignores other zones sharing the road.",
      "structure_defense has no modelled effect on fire spread. Engines on scene in a zone withdraw automatically when fire is about to reach the zone core.",
      `fire_attack (attack_fire with a tactic): engines stage at the nearest road point to the fire's origin. direct: they build line around the whole edge at about ${Math.round(ENGINE_LINE_METERS_PER_MINUTE)} m/min each in grass (slower in heavier fuel) and the fire is out when the line rings its modelled edge, which keeps growing meanwhile; possible only where they can hold the head (head flame up to ${ENGINE_HOLDS_FLAME_FEET} ft and not crowning, or a structure fire). flank: they anchor at the heel and build line up both flanks toward the head; indirect: they build line around where the fire will be in about an hour, starting across the head. For flank and indirect the line is run through the fire model, which decides stretch by stretch whether it holds (the flame facing it is within what engines hold) or burns over; flanks burn far less intensely than the head. A fire that is out or held stops spreading: the forecast, zone ETAs and impact are recomputed, and its engines return to station. tactic_options are solved what-ifs; their contained_in_min, burned_ha_at_horizon and homes_reached_by_horizon compare with fire.current_outcome. Rough: ellipse perimeter for direct attack, no water supply, mop-up or rekindle.`,
      "A household counts as exposed when fire reaches its home before it leaves, reaches the zone core while it is still in the zone, or reaches the road it is on.",
      ...engine.apparatusNotes,
      ...area.notes,
    ],
  };
}

/** Wire orders to engine orders; the engine validates them again against its live state. */
export function toEngineOrders(orders: readonly WireOrder[]): Order[] {
  return orders.map((order) => ({ ...order }));
}

/** "R04 unpaved track too soft: grade3 not allowed for engine_t1_t2 (Foo Road)". */
function noAccessText(reason: NoAccess): string {
  return `${reason.rule ? `${reason.rule} ` : ""}${reason.why}${reason.road ? ` (${reason.road})` : ""}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
