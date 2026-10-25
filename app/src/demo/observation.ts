/**
 * What the /demo AI commander sees, and when it is called. Pure: no React, network or LLM.
 *
 * - buildObservation turns the board (demo/model.ts) into the wire DemoObservation
 *   (demo/contracts.ts). Every number is simulator output (the fire numbers from the fire
 *   solver's footprint, demo/fireField.ts), rounded for the wire: minutes to integers, hectares
 *   to 0.1, metres to integers.
 * - wakeReasons is the monitor: between decisions the page checks the board every
 *   MONITOR_EVERY_MINUTES simulated minutes and calls the agent only when this returns a
 *   reason. It compares the board with a MonitorMemory taken when the agent last decided, so a
 *   standing situation the agent has already seen does not wake it again (until the periodic
 *   review).
 */

import type {
  AttackPositionObservation,
  CrewObservation,
  DemoObservation,
  FireObservation,
  UnreachableClassObservation,
  ZoneObservation,
  ZoneRouteObservation,
} from "./contracts";
import {
  DEPARTURE_SPREAD_MINUTES,
  boardWind,
  FORECAST_MINUTES,
  activeFires,
  attackPositions,
  crewTarget,
  positionDestKey,
  unreachableClasses,
  positionEta,
  positionLineDone,
  positionOptions,
  containOptions,
  currentContainment,
  fireAreaHa,
  firePerimeterM,
  perimeterGrowth,
  pointInRing,
  unitLineOn,
  fireReachesZone,
  totals,
  zoneCounts,
  zonePeople,
  zoneForecasts,
  evacuationEstimate,
  trafficPicture,
  vehiclesPerHousehold,
  worstSegment,
  type EvacuationEstimate,
  type Board,
  type Fire,
  type RouteOption,
  type ZoneForecast,
  type ZoneState,
} from "./model";
import { LOOKAHEAD_MINUTES } from "./fireField";
import { ORDER_COMPLIANCE, SHADOW_SHARE, accessClassOf, holdsFlameFeet, kindLabel } from "./realism";
import type { LonLat } from "../live/types";

/** Access classes that cannot drive to a target (model.unreachableClasses), for the wire. */
function unreachableObs(board: Board, destKey: string, to: LonLat): UnreachableClassObservation[] {
  return unreachableClasses(board, destKey, to).map((u) => ({ access_class: u.access, kinds: u.kinds, reason: u.reason }));
}
import { fuelLabel } from "../fire/fuelModels";

/** Attack positions of a burning fire for the wire (model.attackPositions; numbers from the solver and the travel model). */
function attackPositionObs(board: Board, fire: Fire): AttackPositionObservation[] {
  const minutes = (v: number | null) => (v === null ? null : Math.round(v));
  return attackPositions(board, fire).map((p) => ({
    id: p.id,
    kind: p.kind,
    lon: Math.round(p.point[0] * 1e5) / 1e5,
    lat: Math.round(p.point[1] * 1e5) / 1e5,
    fire_eta_min: minutes(positionEta(board, p)),
    protects_zone_ids: p.protectsZoneIds,
    fuel: fuelLabel(p.fuelCode),
    spread_m_per_min: round1(p.spreadMPerMin),
    flame_ft: round1(p.flameFt),
    crowning: p.crowning,
    spread_toward_deg: Math.round(p.spreadTowardDeg),
    line_m: Math.round(p.aM + p.bM),
    line_built_m: Math.round(p.line?.builtM ?? 0),
    crews_assigned: p.line ? board.teams.filter((t) => t.lineId === p.line!.id).map((t) => t.id) : [],
    line_done_min: minutes(positionLineDone(board, p)),
    options: positionOptions(board, fire, p).map((o) => ({
      crews: o.teams,
      arrive_min: Math.round(o.arriveMin),
      line_done_min: minutes(o.lineDoneMin),
      route: o.route,
    })),
    unreachable_classes: unreachableObs(board, positionDestKey(fire, p), p.point),
  }));
}

/** Shown to the agent as inputs.travel and inputs.congestion. */
export const TRAVEL_LABEL =
  "Road network per apparatus class (POST /api/demo/crew_routes), units always drive a road line (with a straight off-road leg to a point off the network); a dispatched unit waits at its base until its road route is known. Options list only crews that can reach the fire or position: a class whose road legs there fail (unreachable_classes) is left out. Options with route \"estimate\" use straight line x 1.3 at 60 km/h (assumption) for a crew whose road time is not known yet";
export const CONGESTION_LABEL =
  "Evacuation traffic simulated on the board: each minute's departures load their route's road segments; moving time follows the BPR volume-delay function (Bureau of Public Roads 1964, alpha 0.15, beta 4) and demand above capacity waits in a point queue, on the drill roads' assumed capacities (lanes x 600-2,000 veh/h per lane by road class). Arrival is fixed at departure. Fire units drive at free-flow times";
/** How the board's wind reaches the fire model; appended to observation.wind.source. */
export const WIND_APPROACH_LABEL = `the wind is held constant, as Simulation Studio runs it; each solve looks ${LOOKAHEAD_MINUTES / 60} h ahead and the fire model re-solves on a new, contained or closed fire and as fire line is built (line is a barrier in the model), continuing from the burned ground`;

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** "Assumed in Simulation Studio: ..." wind line for the board (null before any Studio fire). */
export function studioWindLabel(board: Board): string | null {
  const c = board.conditions;
  if (!c) return null;
  const speed = Math.round(c.windSpeedMph * 10) / 10;
  return `Assumed in Simulation Studio (${c.tag}, '${c.name}'): ${speed} mph (${c.windSpeedMetersPerSecond.toFixed(1)} m/s) from ${Math.round(c.windFromDegrees)}°, ${c.windSource.replace(/_/g, " ")}${c.windLabel ? ` (${c.windLabel})` : ""}, constant`;
}

/** "Assumed in Simulation Studio: ..." fuel moisture line (null before any Studio fire). */
export function studioMoistureLabel(board: Board): string | null {
  const c = board.conditions;
  if (!c) return null;
  const m = c.moisture;
  return `Assumed in Simulation Studio (${c.tag}): ${c.moistureLabel} (1 h ${pct(m.dead1h)}, 10 h ${pct(m.dead10h)}, 100 h ${pct(m.dead100h)}, live herbaceous ${pct(m.liveHerb)}, live woody ${pct(m.liveWoody)})`;
}

/** "Model inputs" line for fire spread: the simulator's solver on the board's landscape, with its wind and moisture. */
export function fireModelLabel(board: Board): string {
  const r = board.env.landscapeRegion;
  const where = board.env.landscapeSource === "stored" ? `the prebuilt landscape "${r.name}"` : `${r.name}, loaded live from LANDFIRE`;
  const c = board.conditions;
  const conditions = c
    ? `wind and fuel moisture assumed in Simulation Studio ('${c.name}', ${c.tag}): ${Math.round(c.windSpeedMph * 10) / 10} mph from ${Math.round(c.windFromDegrees)}°, ${c.moistureLabel} fuel moisture`
    : "no fire yet: wind and fuel moisture will come from the Simulation Studio run that starts one";
  return `the simulator's cell solver, the same as /fire and Simulation Studio (Rothermel 1972 surface spread with crown fire, ember spotting and structure-to-structure spread at their defaults), on LANDFIRE fuel, canopy and terrain of ${where}; ${conditions}; ${WIND_APPROACH_LABEL}`;
}

/** Where the zones' households, persons and vehicles come from (observation.inputs.demand). */
export function demandLabel(board: Board): string {
  const s = board.snapshot;
  if (!s) {
    return "Drill file households and vehicles; carless households from the drill environment; persons unknown (no resource snapshot)";
  }
  const unmatched = s.zones_unmatched.length;
  return `Resource snapshot ${s.snapshot_id} (T+0 ${s.scenario_time}; households synthetic, occupants and vehicles ${[...new Set([s.basis.occupants, s.basis.vehicles].flat())].join("/")}; see docs/scenario-snapshots.md): ${s.zones_matched} zones${unmatched ? `, ${unmatched} zones not in the snapshot keep the drill file's households with persons unknown` : ""}. Households with a vehicle take the zone's evacuating vehicles; carless households (needs transport) stay home`;
}

/** How often (simulated minutes) the page runs the monitor. */
export const MONITOR_EVERY_MINUTES = 2;
/** With fires on the board, the agent reviews at least this often (simulated minutes). */
export const REVIEW_EVERY_MINUTES = 30;
/** An unordered zone with this much order slack or less wakes the agent. */
export const SLACK_ALERT_MINUTES = 10;
/** Ids listed in one wake reason before "and n more". */
const MAX_IDS_IN_REASON = 8;

const round1 = (v: number): number => Math.round(v * 10) / 10;

function orderSlack(forecast: ZoneForecast | undefined): number | null {
  return forecast?.coreEta == null ? null : Math.round(forecast.coreEta - DEPARTURE_SPREAD_MINUTES);
}

function zoneStatus(zone: ZoneState): ZoneObservation["status"] {
  if (zone.overrunAt !== null) return "overrun";
  return zone.orderedAt !== null ? "ordered" : "no_order";
}

/** Burning minutes a fire still spreads within the forecast (0 once contained). */
function spreadLimit(board: Board, fire: Fire): number {
  if (fire.status !== "burning") return 0;
  return Math.min(currentContainment(board, fire) ?? FORECAST_MINUTES, FORECAST_MINUTES);
}


function listIds(ids: string[]): string {
  if (ids.length <= MAX_IDS_IN_REASON) return ids.join(", ");
  return `${ids.slice(0, MAX_IDS_IN_REASON).join(", ")} and ${ids.length - MAX_IDS_IN_REASON} more`;
}

/**
 * The observation for one agent call. Zones are listed when a fire is forecast to reach them
 * (edge or core), a fire started inside them, or they are ordered out or overrun; the rest are
 * only counted in quiet_zone_count.
 */
export function buildObservation(
  board: Board,
  routes: ReadonlyMap<string, RouteOption[]>,
  forecasts: Map<string, ZoneForecast>,
  wokeBecause: string[],
  previous: DemoObservation["previous"],
): DemoObservation {
  const minute = board.minute;
  const fires = activeFires(board);

  const listed = board.zones.filter((zone) => {
    const f = forecasts.get(zone.id);
    return (
      zone.orderedAt !== null ||
      zone.overrunAt !== null ||
      f?.edgeEta != null ||
      f?.coreEta != null ||
      fires.some((fire) => pointInRing(fire.origin, zone.ring))
    );
  });

  const picture = trafficPicture(board);
  const routeObs = (o: RouteOption, e: EvacuationEstimate): ZoneRouteObservation => ({
    destination_id: o.destination_id,
    name: o.name,
    safety: o.safety,
    free_flow_min: Math.round(e.freeFlowMin),
    congested_eta_min: Math.round(e.congestedEtaMin),
    vehicles_on_route_now: Math.round(e.vehiclesOnRouteNow),
    bottleneck: e.bottleneck
      ? {
          name: e.bottleneck.segment.name,
          capacity_veh_h: e.bottleneck.segment.capacity_veh_h,
          committed_vehicles: Math.round(e.bottleneck.committedVehicles),
        }
      : null,
    clearance_min: Math.round(e.clearanceMin),
    margin_min: e.marginMin === null ? null : Math.round(e.marginMin),
    destination_load_vehicles: Math.round(e.destinationLoadVehicles),
    destination_capacity_veh: e.destinationCapacityVeh,
  });

  const zones: ZoneObservation[] = listed.map((zone) => {
    const f = forecasts.get(zone.id);
    const counts = zoneCounts(zone, minute);
    const people = zonePeople(zone, minute);
    // An overrun zone cannot be ordered out (model.applyOrder refuses), so it offers nothing.
    const options = zone.overrunAt !== null ? [] : (routes.get(zone.id) ?? []);
    const estimates = options.map((o) => evacuationEstimate(board, picture, zone, o, f?.coreEta ?? null));
    const current = zone.orderedAt !== null ? options.findIndex((o) => o.destination_id === zone.route?.destination_id) : -1;
    const margins = estimates.flatMap((e) => (e.marginMin === null ? [] : [e.marginMin]));
    const margin = current >= 0 ? estimates[current].marginMin : margins.length ? Math.max(...margins) : null;
    const ordered = zone.orderedAt !== null;
    return {
      id: zone.id,
      name: zone.name,
      households: zone.households,
      status: zoneStatus(zone),
      households_home: counts.home,
      households_en_route: counts.enRoute,
      households_out: counts.out,
      households_caught: counts.caught,
      households_no_vehicle: zone.noVehicle,
      households_no_vehicle_home: counts.noVehicleHome,
      demand_source: zone.demand,
      occupants: people.total,
      known_occupants: people.known,
      unknown_occupant_households: people.unknownHouseholds,
      people_home: people.home,
      people_en_route: people.enRoute,
      people_out: people.out,
      people_caught: people.caught,
      needs_transport_households: zone.noVehicle,
      needs_transport_occupants: zone.needsTransportOccupants,
      needs_transport_occupants_home: people.needsTransportHome,
      shadow_evacuating: zone.shadowAt !== null && zone.orderedAt === null,
      fire_eta_min: f?.edgeEta ?? null,
      fire_core_eta_min: f?.coreEta ?? null,
      order_slack_min: orderSlack(f),
      vehicles: zone.vehicles,
      vehicles_en_route: Math.round(counts.enRoute * vehiclesPerHousehold(zone)),
      margin_min: margin === null ? null : Math.round(margin),
      destination_id: ordered ? (zone.route?.destination_id ?? null) : null,
      options: options.map((o, i) => routeObs(o, estimates[i])),
    };
  });

  const fireObs: FireObservation[] = fires.map((fire) => {
    const perimeter = firePerimeterM(fire);
    const teams = board.teams.filter((t) => t.fireId === fire.id);
    const limit = spreadLimit(board, fire);
    const contained = currentContainment(board, fire);
    return {
      id: fire.id,
      source: fire.source,
      status: fire.status,
      age_min: Math.round(minute - fire.ignitedAt),
      area_ha: round1(fireAreaHa(fire)),
      perimeter_m: Math.round(perimeter),
      perimeter_growth_m_per_min: round1(perimeterGrowth(fire)),
      line_m: Math.round(fire.lineM),
      containment_pct:
        fire.status !== "burning" ? 100 : perimeter > 0 ? Math.min(100, Math.round((fire.lineM / perimeter) * 100)) : 0,
      crews_on_scene: teams.filter((t) => t.status === "on_scene").map((t) => t.id),
      crews_en_route: teams.filter((t) => t.status === "en_route").map((t) => t.id),
      contained_in_min: contained === null ? null : Math.round(contained),
      options: containOptions(board, fire).map((o) => ({
        crews: o.teams,
        contained_in_min: o.contained_in_min === null ? null : Math.round(o.contained_in_min),
        route: o.route,
      })),
      unreachable_classes: fire.status === "burning" ? unreachableObs(board, fire.id, crewTarget(fire)) : [],
      threatens_zone_ids: listed.filter((zone) => fireReachesZone(board, fire, zone, limit)).map((zone) => zone.id),
      head_m_per_min: round1(fire.rates.headMetersPerMinute),
      head_flame_ft: round1(fire.rates.headFlameFeet),
      heading_deg: Math.round(fire.rates.headingDegrees),
      length_to_breadth: round1(fire.rates.lengthToBreadth),
      slope_pct: Math.round(fire.rates.slopePercent),
      indirect_line_m: Math.round(board.lines.filter((l) => l.fireId === fire.id).reduce((sum, l) => sum + l.builtM, 0)),
      attack_positions: attackPositionObs(board, fire),
    };
  });

  const crews: CrewObservation[] = board.teams.map((team) => {
    const fire = team.fireId ? (board.fires.find((f) => f.id === team.fireId) ?? null) : null;
    return {
      id: team.id,
      kind: team.kind,
      access_class: accessClassOf(team.kind),
      label: kindLabel(team.kind),
      base: board.stations.find((s) => s.id === team.station)?.name ?? team.station,
      station_id: team.station,
      engine_id: team.engineId,
      assumed: team.assumed,
      status: team.status,
      fire_id: team.fireId,
      eta_min:
        team.status === "en_route" && team.arriveAt !== null ? Math.max(0, Math.ceil(team.arriveAt - minute)) : null,
      line_m_per_min: round1(unitLineOn(board, team, fire)),
      holds_flame_ft: holdsFlameFeet(team.kind),
      travel: team.status === "en_route" ? team.travel : null,
      position_id: team.lineId ? (board.lines.find((l) => l.id === team.lineId)?.plan.id ?? null) : null,
    };
  });

  const spread = board.env.spread;
  const boardTotals = totals(board, forecasts);
  const wind = boardWind(board);
  const studio = board.conditions;
  return {
    clock: {
      minute: Math.round(minute),
      departure_mean_min: DEPARTURE_SPREAD_MINUTES,
      order_compliance: ORDER_COMPLIANCE,
      shadow_share: SHADOW_SHARE,
      forecast_min: FORECAST_MINUTES,
    },
    activity: studio
      ? `Fires come only from Simulation Studio runs (no scheduled or random ignitions); conditions from ${studio.tag} '${studio.name}'`
      : "No fires: fires come only from Simulation Studio runs (no scheduled or random ignitions)",
    wind: {
      from_deg: Math.round(wind.fromDegrees),
      speed_m_s: round1(wind.speedMetersPerSecond),
      evidence: studio ? "assumption" : spread.wind.evidence,
      source: `${studioWindLabel(board) ?? spread.wind.label}; ${WIND_APPROACH_LABEL}`,
    },
    inputs: {
      fuel: spread.ground.fuelLabel,
      moisture: studioMoistureLabel(board) ?? "none yet (comes from the Simulation Studio run that starts a fire)",
      terrain: spread.ground.terrainLabel,
      stations: board.resources.source === "snapshot" ? board.resources.label : `${board.resources.label}; ${board.env.basesLabel}`,
      demand: demandLabel(board),
      travel: TRAVEL_LABEL,
      congestion: CONGESTION_LABEL,
    },
    fires: fireObs,
    crews,
    zones,
    traffic: (() => {
      const worst = worstSegment(board);
      return {
        vehicles_on_road: Math.round(picture.vehiclesOnRoad),
        worst_segment: worst
          ? {
              name: worst.segment.name,
              flow_veh_h: Math.round(worst.flowVehH),
              capacity_veh_h: worst.segment.capacity_veh_h,
              delay_factor: round1(worst.factor),
              queue_vehicles: Math.round(worst.queueVeh),
              queue_delay_min: Math.round(worst.queueDelayMin),
            }
          : null,
      };
    })(),
    quiet_zone_count: board.zones.length - listed.length,
    totals: {
      households: board.zones.reduce((sum, z) => sum + z.households, 0),
      households_home_in_threatened_zones: zones.reduce((sum, z) => sum + z.households_home, 0),
      households_caught_total: board.caughtTotal,
      households_no_vehicle_at_risk: boardTotals.noVehicleAtRisk,
      people: boardTotals.people.total,
      people_known: boardTotals.people.known,
      unknown_occupant_households: boardTotals.people.unknownHouseholds,
      people_caught_total: boardTotals.people.caughtTotal,
      needs_transport_people_at_risk: boardTotals.people.needsTransportAtRisk,
      fires_burning: fires.filter((f) => f.status === "burning").length,
      fires_out_total: board.firesOutTotal,
      crews_available: board.teams.filter((t) => t.status === "available").length,
    },
    monitor: { woke_because: wokeBecause },
    previous,
  };
}

// ---- monitor ----

/** 1 = order slack at or under SLACK_ALERT_MINUTES, 2 = already late (slack <= 0). */
type SlackTier = 1 | 2;

/** What the agent saw at its last decision; the monitor wakes it on changes since. */
export interface MonitorMemory {
  minute: number;
  /** Fires on the board (not out). */
  fireIds: string[];
  /** Crews en route or on scene. */
  busyCrewIds: string[];
  /** Burning fires their assigned crews could not contain. */
  outrunFireIds: string[];
  /** Unordered zones short of time, by slack tier. */
  slackTiers: Record<string, SlackTier>;
}

function outrunFires(board: Board): Fire[] {
  // A fire whose crews are building line ahead of it is fought through the fire model, not the perimeter race.
  return board.fires.filter(
    (f) => f.status === "burning" && currentContainment(board, f) === null && !board.teams.some((t) => t.fireId === f.id && t.lineId !== null),
  );
}

function slackTiers(board: Board, forecasts: Map<string, ZoneForecast>): Record<string, SlackTier> {
  const out: Record<string, SlackTier> = {};
  for (const zone of board.zones) {
    if (zone.orderedAt !== null || zone.overrunAt !== null) continue;
    const slack = orderSlack(forecasts.get(zone.id));
    if (slack === null || slack > SLACK_ALERT_MINUTES) continue;
    out[zone.id] = slack <= 0 ? 2 : 1;
  }
  return out;
}

/** Snapshot of the board as the agent sees it in this call's observation. */
export function rememberDecision(board: Board, forecasts: Map<string, ZoneForecast> = zoneForecasts(board)): MonitorMemory {
  return {
    minute: board.minute,
    fireIds: activeFires(board).map((f) => f.id),
    busyCrewIds: board.teams.filter((t) => t.status !== "available").map((t) => t.id),
    outrunFireIds: outrunFires(board).map((f) => f.id),
    slackTiers: slackTiers(board, forecasts),
  };
}

/**
 * Why the agent should decide now, or [] when nothing changed enough since `memory` (null =
 * it has not decided yet).
 */
export function wakeReasons(
  board: Board,
  forecasts: Map<string, ZoneForecast>,
  memory: MonitorMemory | null,
): string[] {
  const reasons: string[] = [];
  const active = activeFires(board);
  const known = new Set(memory?.fireIds ?? []);

  const fresh = active.filter((f) => !known.has(f.id));
  if (fresh.length > 0) {
    reasons.push(`New fire${fresh.length > 1 ? "s" : ""} since the last decision: ${listIds(fresh.map((f) => `${f.id} (${f.source})`))}.`);
  }

  const free = board.teams.filter((t) => t.status === "available").map((t) => t.id);
  if (free.length > 0) {
    const seenOutrun = new Set(memory?.outrunFireIds ?? []);
    for (const fire of outrunFires(board)) {
      if (seenOutrun.has(fire.id) || !known.has(fire.id)) continue;
      const assigned = board.teams.filter((t) => t.fireId === fire.id).map((t) => t.id);
      reasons.push(
        `${fire.id} is no longer containable by its crews (${assigned.length ? assigned.join(", ") : "none assigned"}); free: ${listIds(free)}.`,
      );
    }
  }

  const wasBusy = new Set(memory?.busyCrewIds ?? []);
  const freed = free.filter((id) => wasBusy.has(id));
  if (freed.length > 0) reasons.push(`Crew${freed.length > 1 ? "s" : ""} freed: ${listIds(freed)}.`);

  const tiers = slackTiers(board, forecasts);
  for (const zone of board.zones) {
    const tier = tiers[zone.id];
    if (tier === undefined || tier <= (memory?.slackTiers[zone.id] ?? 0)) continue;
    const slack = orderSlack(forecasts.get(zone.id));
    reasons.push(
      tier === 2
        ? `${zone.id} (${zone.name}) has no evacuation order and is already late: ${slack} min of order slack.`
        : `${zone.id} (${zone.name}) has no evacuation order and ${slack} min of order slack.`,
    );
  }

  const since = memory === null ? Infinity : board.minute - memory.minute;
  if (reasons.length === 0 && active.length > 0 && since >= REVIEW_EVERY_MINUTES) {
    reasons.push(
      memory === null
        ? `Periodic review: ${active.length} fire${active.length > 1 ? "s" : ""} on the board.`
        : `Periodic review: ${Math.round(since)} min since the last decision, ${active.length} fire${active.length > 1 ? "s" : ""} on the board.`,
    );
  }
  return reasons;
}
