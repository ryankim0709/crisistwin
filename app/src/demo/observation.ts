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
 *   review). A newly reported fire wakes it at once (newReportedFireIds, useDemoAgent), because
 *   the /live board is AI agent only: nothing attacks a fire until the agent dispatches units.
 * - Recommendations are model output, not orders: each burning fire's recommended_initial_attack
 *   (the run card filled by the closest free units, boardResponse.initialAttackRecommendation)
 *   and extended_attack_due (the due stage's sized orders, response/runCards.ts ESCALATION_ORDERS).
 *
 * Report rule (boardResponse.ts): a fire dispatch does not have yet is not in the observation at
 * all: no fire entry or id, no crews or orders on it (none can be sent), no zone ETA, threat,
 * slack or wake reason derived from it, and it is not in the initial-attack record. `forecasts`
 * must be zoneForecasts(board, "reported") (useCommandBoard passes those). A zone overrun by a fire
 * not yet reported is not listed (nor its caught households in the run totals) until a reported
 * fire has touched it (zone.knownTouchedAt); the board still counts them (outcomes, audit log).
 */

import type {
  AttackPositionObservation,
  CrewObservation,
  DemoObservation,
  DemoOrder,
  FireObservation,
  ResourceCountsObservation,
  UnreachableClassObservation,
  ZoneObservation,
  ZoneRouteObservation,
} from "./contracts";
import {
  DEPARTURE_SPREAD_MINUTES,
  MAX_FIRE_CUT_REROUTES,
  REROUTE_BACKOFF_MINUTES,
  boardWind,
  distanceM,
  teamPosition,
  FORECAST_MINUTES,
  activeFires,
  attackPositions,
  boardMoistureClass,
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
  MAX_SCHEDULE_AHEAD_MINUTES,
  orderPeakVehiclesPerMinute,
  zoneOrderStatus,
  EVERY_HOUSEHOLD_DRIVES,
  EVERY_HOUSEHOLD_DRIVES_LABEL,
  type EvacuationEstimate,
  type Board,
  type Fire,
  type FireStatus,
  type RouteOption,
  type Team,
  type TeamStatus,
  type ZoneForecast,
  type ZoneState,
} from "./model";
import { LOOKAHEAD_MINUTES } from "./fireField";
import { fireStateAreas } from "./fireState";
import { ORDER_COMPLIANCE, accessClassOf, holdsFlameFeet, kindLabel } from "./realism";
import { departmentStatus, dispatchable, fireEdgeSample, idleOnSceneReason, initialAttackRecommendation, isReported, reachFraction, unitAccessText } from "./boardResponse";
import { TANK_GALLONS } from "../response/units";
import { computeStrategyOptions, strategyLabel } from "./strategyOptions";
import { closedIds, closedRoadsObservation, closureKey } from "./roadClosures";
import { simClock } from "./format";
import { EVAC_SCHEDULE_LABEL, evacuationSchedule, strategyAid, type ZoneEvacPlan } from "./decisionAids";
import { runScore } from "./scoring";

/** The fire's strategy options and its chosen strategy for the wire (demo/strategyOptions.ts; model output, rounded). */
function strategyObs(board: Board, fire: Fire): Pick<FireObservation, "strategy_options" | "strategy"> {
  const options = computeStrategyOptions(board, fire);
  const minutes = (v: number | null) => (v === null ? null : Math.round(v));
  const chosen = board.response.fires.get(fire.id)?.strategy ?? null;
  return {
    strategy_options: options.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      tactic: o.tactic,
      position_id: o.positionId,
      works: o.works,
      line_m: o.lineM,
      flame_ft: Math.round(o.flameFt * 10) / 10,
      holds_flame_ft: o.holdsFlameFt,
      units_needed: o.unitsNeeded,
      send: o.send.map((s) => ({ crew_id: s.team.id, kind: s.team.kind, eta_min: Math.round(s.etaMin), route: s.road ? "road" : "estimate" })),
      already_assigned: o.assigned.map((t) => t.id),
      outcome: o.outcome,
      contained_in_min: minutes(o.containedInMin),
      line_done_min: minutes(o.lineDoneMin),
      fire_reaches_line_min: minutes(o.fireReachesLineMin),
      line_ready_before_fire: o.lineReadyBeforeFire,
      burned_ha: o.burnedHa,
      burned_ha_at: o.burnedHaAt,
      zones_reached: o.zonesReached,
      households_home_in_zones_reached: o.householdsHomeInZonesReached,
      protects_zone_ids: o.protectsZoneIds,
      not_containable_because: o.notContainableBecause,
      safety: o.safety,
    })),
    strategy: chosen
      ? {
          id: chosen.id,
          name: chosen.name,
          chosen_at_minute: Math.round(chosen.at),
          by: chosen.by,
          reason: chosen.reason,
          predicted: chosen.predictionText,
          still_offered: options.some((o) => o.id === chosen.id),
        }
      : null,
  };
}
import { ESCALATION_ORDERS, ESCALATION_STAGE_ACRES, MAX_ORDER_COUNT, ORDERABLE, dispatchLevel, type Orderable, type ResourceCounts } from "../response/runCards";
import { fuelLabel } from "../fire/fuelModels";
import type { LonLat } from "../live/types";

/** Access classes that cannot drive to a target (model.unreachableClasses), for the wire. */
function unreachableObs(board: Board, destKey: string, to: LonLat): UnreachableClassObservation[] {
  return unreachableClasses(board, destKey, to).map((u) => ({ access_class: u.access, kinds: u.kinds, reason: u.reason }));
}

/** Ground metres from the nearest point of a fire's open-edge sample to `p`, rounded to 10 m; null for an empty sample. */
function edgeDistanceM(edge: readonly LonLat[], p: LonLat): number | null {
  let best = Number.POSITIVE_INFINITY;
  for (const q of edge) best = Math.min(best, distanceM(p, q));
  return Number.isFinite(best) ? Math.round(best / 10) * 10 : null;
}

/** Attack positions of a burning fire for the wire (model.attackPositions; numbers from the solver and the travel model). */
function attackPositionObs(board: Board, fire: Fire): AttackPositionObservation[] {
  const minutes = (v: number | null) => (v === null ? null : Math.round(v));
  const edge = fireEdgeSample(board, fire);
  return attackPositions(board, fire).map((p) => ({
    id: p.id,
    kind: p.kind,
    lon: Math.round(p.point[0] * 1e5) / 1e5,
    lat: Math.round(p.point[1] * 1e5) / 1e5,
    fire_eta_min: minutes(positionEta(board, p)),
    from_fire_m: edgeDistanceM(edge, p.point),
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
      work_starts_min: Math.round(o.startMin),
      line_done_min: minutes(o.lineDoneMin),
      route: o.route,
    })),
    unreachable_classes: unreachableObs(board, positionDestKey(fire, p), p.point),
  }));
}


/** The response model's per-fire record for the observation (docs/response-model.md). */
function fireResponseObservation(board: Board, fire: Fire): Pick<
  FireObservation,
  | "tactic"
  | "dispatch_level"
  | "ia_status"
  | "escalation_stage"
  | "first_arrival_min"
  | "line_breaches"
  | "air_line_m"
  | "aircraft"
  | "reported_after_min"
  | "reported_by"
  | "reported_reason"
  | "edge_in_reach_pct"
  | "recommended_initial_attack"
  | "extended_attack_due"
> {
  const fr = board.response.fires.get(fire.id);
  const rec = initialAttackRecommendation(board, fire);
  const counts = (c: ResourceCounts): ResourceCountsObservation => ({ ...c });
  const due = fr && fr.stage > 0 && fire.status === "burning" ? ESCALATION_ORDERS[fr.stage - 1] : null;
  return {
    recommended_initial_attack: rec
      ? {
          run_card: counts(rec.card),
          still_needed: counts(rec.stillNeeded),
          units: rec.units.map((u) => ({ crew_id: u.team.id, kind: u.team.kind, eta_min: Math.round(u.etaMin), route: u.road ? "road" : "estimate" })),
          aircraft: rec.aircraft.map((a) => ({ aircraft_id: a.aircraft.id, kind: a.aircraft.kind, over_fire_min: Math.round(a.overFireMin) })),
          unfilled: counts(rec.unfilled),
        }
      : null,
    extended_attack_due:
      fr && due
        ? {
            stage: fr.stage,
            orders: (
              [
                ["engine_strike_team", due.engine_strike_teams],
                ["crew_strike_team", due.crew_strike_teams],
                ["dozer_strike_team", due.dozer_strike_teams],
                ["airtanker", due.airtankers],
                ["helicopter", due.helicopters],
              ] as [Orderable, number][]
            )
              .filter(([, n]) => n > 0)
              .map(([resource, count]) => ({ resource, count })),
          }
        : null,
    tactic: fr?.tactic ?? null,
    dispatch_level: fr ? (fr.structure ? "structure" : fr.level) : null,
    ia_status: fr?.ia ?? null,
    escalation_stage: fr?.stage ?? 0,
    first_arrival_min: fr?.firstArrivalAt == null ? null : Math.round(fr.firstArrivalAt - fire.ignitedAt),
    line_breaches: fr?.breaches ?? 0,
    air_line_m: Math.round(fr?.airLineM ?? 0),
    aircraft: board.response.aircraft.filter((a) => a.fireId === fire.id).map((a) => a.id),
    reported_after_min: fr ? Math.round(fr.reportAt - fire.ignitedAt) : null,
    reported_by: fr?.report.by ?? null,
    reported_reason: fr?.report.reason ?? null,
    edge_in_reach_pct: (() => {
      const f = reachFraction(board, fire);
      return f === null ? null : Math.round(f * 100);
    })(),
  };
}

/** Most aircraft and orders listed in one observation (the decide body is capped at 200 kB). */
const MAX_LISTED = 24;

/** Resource picture for the commander: departments, aircraft, orders, initial-attack record. */
function responseObservation(board: Board): DemoObservation["response"] {
  const r = board.response;
  const wind = boardWind(board);
  const firsts = r.stats.firstArrivalMinutes;
  return {
    auto_dispatch: r.autoDispatch,
    auto_escalate: r.autoEscalate,
    dispatch_level_now: dispatchLevel(boardMoistureClass(board), wind.speedMetersPerSecond),
    departments: departmentStatus(board),
    mutual_aid_pool_units: r.pool.length,
    // Bounded for the 200 kB decide body: assigned aircraft first, at most MAX_LISTED.
    aircraft: [...r.aircraft]
      .sort((a, b) => Number(a.fireId === null) - Number(b.fireId === null))
      .slice(0, MAX_LISTED)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        base: a.baseName,
        status: a.status,
        fire_id: a.fireId,
        drops: a.drops,
        over_fire_in_min: a.status === "en_route" && a.overFireAt !== null ? Math.max(0, Math.ceil(a.overFireAt - board.minute)) : null,
      })),
    orders: r.orders
      .flatMap((o) => (o.status === "pending" || o.status === "unable_to_fill" ? [{ ...o, status: o.status }] : []))
      .slice(0, MAX_LISTED)
      .map((o) => ({ id: o.id, fire_id: o.fireId, resource: o.resource, tier: o.tier, status: o.status, eta_min: Math.max(0, Math.round(o.readyAt - board.minute)) })),
    orderable: ORDERABLE.map((resource) => ({ resource, max_count: MAX_ORDER_COUNT[resource] })),
    initial_attack: {
      fires: r.stats.fires,
      contained_in_ia: r.stats.iaContained,
      failed_ia: r.stats.iaFailed,
      line_breaches: r.stats.breaches,
      median_first_arrival_min: firsts.length ? Math.round([...firsts].sort((a, b) => a - b)[Math.floor(firsts.length / 2)]) : null,
    },
  };
}

/** Shown to the agent as inputs.travel and inputs.congestion. */
export const TRAVEL_LABEL =
  `Road network per apparatus class (POST /api/demo/crew_routes), units always drive a road line (with a straight off-road leg to a point off the network); a dispatched unit waits at its base until its road route is known. Options list only crews that can reach the fire or position: a class whose road legs there fail (unreachable_classes) is left out. Options with route "estimate" use straight line x 1.3 at 60 km/h (assumption) for a crew whose road time is not known yet. Drive times carry a seeded +/-20% variation (assumption); a road cut by fire stops the unit for a new road leg, at most ${MAX_FIRE_CUT_REROUTES} times per trip (each new leg after the first asked for ${REROUTE_BACKOFF_MINUTES} min later than the one before, assumption); the next cut gives the trip up (crews[].blocked_by_fire) and leaves the unit free where it stopped, to be sent again`;
export const CONGESTION_LABEL =
  "Evacuation traffic simulated on the board: each minute's departures load their route's road segments; moving time follows the BPR volume-delay function (Bureau of Public Roads 1964, alpha 0.15, beta 4) and demand above capacity waits in a point queue, on the drill roads' assumed capacities (lanes x 600-2,000 veh/h per lane by road class). Arrival is fixed at departure. Fire units: BPR (1964) delay from the board's own evacuation flows on shared roads (1,700 veh/h per direction, HCM 2010; against-flow weight 0.5 assumed)";
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
  const source = board.env.landscapeSource;
  // UTC date the cached copy was stored (useDemoEnvironment fills landscapeCachedAt for a Mongo-cache load).
  const storedOn = source === "cached" ? board.env.landscapeCachedAt?.slice(0, 10) : undefined;
  const where =
    source === "stored"
      ? `the prebuilt landscape "${r.name}"`
      : source === "cached"
      ? `${r.name}, a cached copy of LANDFIRE${storedOn ? ` (stored ${storedOn})` : ""}`
      : `${r.name}, loaded live from LANDFIRE`;
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
    return `Drill file households and vehicles; carless households from the drill environment; persons unknown (no resource snapshot)${EVERY_HOUSEHOLD_DRIVES ? `. ${EVERY_HOUSEHOLD_DRIVES_LABEL}` : ""}`;
  }
  const unmatched = s.zones_unmatched.length;
  return `Resource snapshot ${s.snapshot_id} (T+0 ${s.scenario_time}; households synthetic, occupants and vehicles ${[...new Set([s.basis.occupants, s.basis.vehicles].flat())].join("/")}; see docs/scenario-snapshots.md): ${s.zones_matched} zones${unmatched ? `, ${unmatched} zones not in the snapshot keep the drill file's households with persons unknown` : ""}. Households with a vehicle take the zone's evacuating vehicles; ${EVERY_HOUSEHOLD_DRIVES ? EVERY_HOUSEHOLD_DRIVES_LABEL : "carless households (needs transport) stay home"}`;
}

/** How often (simulated minutes) the page runs the monitor between decisions (a new reported fire is checked on every board change). */
export const MONITOR_EVERY_MINUTES = 1;
/**
 * UI/ops choice: while the incident is hot (a reported fire burning, or a zone threatened with
 * people home and no order), the page calls the agent again this many board minutes after each
 * decision's orders land (a continuous review), even when no event fired. Events wake it at once.
 */
export const CONTINUOUS_GAP_MINUTES = 3;
/** With only contained fires or leaving zones on the board, the agent reviews at least this often (simulated minutes). */
export const REVIEW_EVERY_MINUTES = 30;
/** A zone with no order in effect and this much order slack or less (from its scheduled start, when it has one) wakes the agent. */
export const SLACK_ALERT_MINUTES = 10;
/** Ids listed in one wake reason before "and n more". */
const MAX_IDS_IN_REASON = 8;

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Core ETA - mean departure delay, as if ordered now (null without a core ETA). */
function orderSlack(forecast: ZoneForecast | undefined): number | null {
  return forecast?.coreEta == null ? null : Math.round(forecast.coreEta - DEPARTURE_SPREAD_MINUTES);
}

/** The same slack for an order that starts at the zone's scheduled minute instead of now (null when not scheduled or no core ETA). */
function scheduledSlack(board: Board, zone: ZoneState, forecast: ZoneForecast | undefined): number | null {
  const pending = zone.pendingOrder;
  if (!pending || forecast?.coreEta == null) return null;
  return Math.round(forecast.coreEta - Math.max(0, pending.startMinute - board.minute) - DEPARTURE_SPREAD_MINUTES);
}

/** Overrun, and known to the commander: a reported fire has touched the zone (report rule). */
function knownOverrun(zone: ZoneState): boolean {
  return zone.overrunAt !== null && zone.knownTouchedAt !== null;
}

function zoneStatus(zone: ZoneState): ZoneObservation["status"] {
  if (zone.overrunAt !== null) return "overrun";
  if (zone.pendingOrder) return "scheduled";
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
  urgency: WakeUrgency = "urgent",
): DemoObservation {
  const minute = board.minute;
  // The commander sees only fires the dispatch centre knows about (response/report.ts).
  const fires = activeFires(board).filter((f) => isReported(board, f));
  // Decision aids (demo/decisionAids.ts): zones in the free-burn evacuation schedule are listed too, so they can be ordered.
  const plans = evacuationSchedule(board, routes, (id) => forecasts.get(id)?.coreEta ?? null);
  const planned = new Set(plans.map((p) => p.zone.id));

  const listed = board.zones.filter((zone) => {
    const f = forecasts.get(zone.id);
    return (
      planned.has(zone.id) ||
      zone.orderedAt !== null ||
      zone.pendingOrder !== null ||
      knownOverrun(zone) ||
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
    latest_start_minute: e.latestStartMinute === null ? null : Math.floor(e.latestStartMinute),
    scheduled_on_route: e.scheduledOnRoute.map((x) => ({ zone_id: x.zoneId, start_minute: x.startMinute, vehicles: Math.round(x.vehicles) })),
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
    const pending = zone.pendingOrder;
    const orderStatus = zoneOrderStatus(zone, minute);
    const startsIn = pending ? Math.max(0, Math.round(pending.startMinute - minute)) : null;
    const scheduledIdx = pending ? options.findIndex((o) => o.destination_id === pending.route.destination_id) : -1;
    const scheduledMargin = scheduledIdx >= 0 && startsIn !== null ? estimates[scheduledIdx].marginMin : null;
    return {
      id: zone.id,
      name: zone.name,
      households: zone.households,
      status: zoneStatus(zone),
      order: {
        status: orderStatus,
        start_minute: pending ? pending.startMinute : zone.orderedAt !== null ? Math.round(zone.orderedAt) : null,
        starts_in_min: startsIn,
        destination_id: pending ? pending.route.destination_id : ordered ? (zone.route?.destination_id ?? null) : null,
        margin_at_start_min: scheduledMargin === null || startsIn === null ? null : Math.round(scheduledMargin - startsIn),
      },
      departure_peak_veh_h: Math.round(orderPeakVehiclesPerMinute(zone) * 60),
      departure_flow_now_veh_h: Math.round(board.traffic.zoneFlow.get(zone.id) ?? 0),
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
    const cells = fireStateAreas(board, fire);
    return {
      id: fire.id,
      source: fire.source,
      status: fire.status,
      age_min: Math.round(minute - fire.ignitedAt),
      area_ha: round1(fireAreaHa(fire)),
      perimeter_m: Math.round(perimeter),
      perimeter_growth_m_per_min: round1(perimeterGrowth(fire)),
      line_m: Math.round(fire.lineM),
      containment_pct: containmentPct(fire),
      burning_ha: round1(cells.burningHa),
      burned_out_ha: round1(cells.burnedOutHa),
      extinguished_ha: round1(cells.extinguishedHa),
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
      ...fireResponseObservation(board, fire),
      head_m_per_min: round1(fire.rates.headMetersPerMinute),
      head_flame_ft: round1(fire.rates.headFlameFeet),
      heading_deg: Math.round(fire.rates.headingDegrees),
      length_to_breadth: round1(fire.rates.lengthToBreadth),
      slope_pct: Math.round(fire.rates.slopePercent),
      indirect_line_m: Math.round(board.lines.filter((l) => l.fireId === fire.id).reduce((sum, l) => sum + l.builtM, 0)),
      attack_positions: attackPositionObs(board, fire),
      ...strategyObs(board, fire),
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
      travel: team.status === "en_route" || team.status === "returning" ? team.travel : null,
      eta_home_min:
        team.status === "returning" && team.travel !== "pending" && team.arriveAt !== null
          ? Math.max(0, Math.ceil(team.arriveAt - minute))
          : null,
      position_id: team.lineId ? (board.lines.find((l) => l.id === team.lineId)?.plan.id ?? null) : null,
      department: board.response.departments.find((d) => d.id === team.department)?.name ?? team.department,
      tier: team.tier,
      water_pct: team.waterGallons === null ? null : Math.round((team.waterGallons / (TANK_GALLONS[team.kind] ?? team.waterGallons)) * 100),
      work_h: round1(team.workMinutes / 60),
      parked_m: team.parkedM === null || !team.accessKnown ? null : Math.round(team.parkedM),
      from_fire_m: fire && fire.status === "burning" ? edgeDistanceM(fireEdgeSample(board, fire), teamPosition(board, team)) : null,
      work_mode: team.workMode,
      working_in_min: team.workStartAt === null ? null : Math.max(0, Math.ceil(team.workStartAt - minute)),
      road_cuts: team.status === "en_route" ? team.fireCuts : 0,
      blocked_by_fire: team.blockedByFire
        ? {
            fire_id: team.blockedByFire.fireId,
            position_id: team.blockedByFire.lineId ? (board.lines.find((l) => l.id === team.blockedByFire!.lineId)?.plan.id ?? null) : null,
            at_minute: Math.round(team.blockedByFire.minute),
            cuts: team.blockedByFire.cuts,
          }
        : null,
    };
  });

  const spread = board.env.spread;
  const boardTotals = totals(board, forecasts);
  // Caught in zones overrun by a fire not yet reported and not listed (report rule): left out of the run totals until known.
  const hidden = { households: 0, people: 0 as number | null };
  for (const zone of board.zones) {
    if (zone.overrunAt === null || knownOverrun(zone) || listed.includes(zone)) continue;
    hidden.households += zone.caught;
    hidden.people = hidden.people === null || zone.caughtPeople === null ? null : hidden.people + zone.caughtPeople;
  }
  const wind = boardWind(board);
  const studio = board.conditions;
  return {
    clock: {
      minute: Math.round(minute),
      departure_mean_min: DEPARTURE_SPREAD_MINUTES,
      order_compliance: ORDER_COMPLIANCE,
      forecast_min: FORECAST_MINUTES,
      max_schedule_ahead_min: MAX_SCHEDULE_AHEAD_MINUTES,
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
      response: board.response.label,
      strategy: strategyLabel(),
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
      households_caught_total: board.caughtTotal - hidden.households,
      households_no_vehicle_at_risk: boardTotals.noVehicleAtRisk,
      people: boardTotals.people.total,
      people_known: boardTotals.people.known,
      unknown_occupant_households: boardTotals.people.unknownHouseholds,
      people_caught_total:
        boardTotals.people.caughtTotal === null || hidden.people === null ? boardTotals.people.caughtTotal : boardTotals.people.caughtTotal - hidden.people,
      needs_transport_people_at_risk: boardTotals.people.needsTransportAtRisk,
      fires_burning: fires.filter((f) => f.status === "burning").length,
      fires_out_total: board.firesOutTotal,
      crews_available: board.teams.filter((t) => dispatchable(t) && t.fireId === null && t.status !== "returning").length,
      crews_returning: board.teams.filter((t) => t.status === "returning").length,
    },
    response: responseObservation(board),
    monitor: { woke_because: wokeBecause, urgency },
    previous,
    outcomes: outcomesObs(board),
    decision_aids: {
      evacuation_method: EVAC_SCHEDULE_LABEL,
      evacuation: plans.map(planObs),
      strategy: fires.flatMap((fire) => {
        const aid = strategyAid(board, fire);
        if (!aid) return [];
        return [
          {
            fire_id: fire.id,
            recommended_strategy_id: aid.recommended?.option.id ?? null,
            recommended_send: aid.recommended ? aid.recommended.option.send.map((u) => ({ crew_id: u.team.id, position_id: aid.recommended!.option.positionId })) : [],
            options: aid.options.map((o) => ({
              id: o.option.id,
              containable: o.containable,
              homes_burned_forecast: o.homesBurned,
              by_min: o.homesByMin,
              households_in_zones_reached: o.householdsInZonesReached,
            })),
            all_units: aid.allUnits
              ? {
                  strategy_id: aid.allUnits.option.option.id,
                  send: aid.allUnits.send.map((u) => ({ crew_id: u.crewId, position_id: u.positionId, eta_min: u.etaMin })),
                  aircraft: aid.allUnits.aircraft.map((a) => ({ aircraft_id: a.aircraftId, over_fire_min: a.overFireMin })),
                  order_resources: aid.allUnits.orders,
                }
              : null,
            idle_units: aid.idleUnits,
          },
        ];
      }),
    },
    closed_roads: closedRoadsObservation(board),
  };
}

/** The run's outcome metrics for the wire (demo/scoring.ts). */
function outcomesObs(board: Board): NonNullable<DemoObservation["outcomes"]> {
  const s = runScore(board);
  const b = s.casualties.breakdown;
  return {
    caught_people: board.caughtPeopleTotal,
    caught_households: board.caughtTotal,
    caught_breakdown: {
      no_vehicle: b.noVehicle.households,
      no_order: b.noOrder.households,
      stayed_despite_order: b.stayedDespiteOrder.households,
      ordered_too_late: b.tooLate.households,
    },
    homes_burned: s.homesBurned,
    homes_reached_saved: s.homesReachedSaved,
    homes_method: s.homesMethod,
    area_burned_ha: s.areaBurnedHa,
  };
}

/** One evacuation schedule entry for the wire (demo/decisionAids.ts). */
function planObs(p: ZoneEvacPlan): NonNullable<DemoObservation["decision_aids"]>["evacuation"][number] {
  return {
    zone_id: p.zone.id,
    action: p.action,
    eta_min: p.etaMin,
    eta_basis: p.etaBasis,
    forecast_core_eta_min: p.forecastCoreEtaMin,
    destination_id: p.option?.destination_id ?? null,
    clearance_min: p.clearanceMin,
    congested_eta_min: p.congestedEtaMin,
    latest_safe_start_minute: p.latestSafeStartMinute,
    recommended_start_minute: p.recommendedStartMinute,
    too_late: p.tooLate,
    over_capacity: p.overCapacity,
    households: p.zone.households,
    people: p.zone.occupants,
    expected_caught_households_if_ordered_now: p.expectedCaughtNow.households,
    expected_caught_people_if_ordered_now: p.expectedCaughtNow.people,
    expected_caught_people_at_recommended: p.expectedCaughtAtRecommended.people,
  };
}

// ---- monitor ----

/** Containment share of a fire's perimeter covered by line (100 once contained or out), as in the observation. */
export function containmentPct(fire: Fire): number {
  if (fire.status !== "burning") return 100;
  const perimeter = firePerimeterM(fire);
  return perimeter > 0 ? Math.min(100, Math.round((fire.lineM / perimeter) * 100)) : 0;
}

/** 1 = order slack at or under SLACK_ALERT_MINUTES, 2 = already late (slack <= 0). */
type SlackTier = 1 | 2;

/**
 * How pressing a wake is. Urgent (a new fire, a zone short of time or reached by fire with people
 * home, a fire outrunning its crews or breaching a line, a failing strategy, a unit standing at a
 * fire with no work, an extended-attack stage due, the operator's "Ask Claude now") runs the board
 * at 1× while Claude decides (autoSpeed.ts) and at the configured effort; routine (continuous and
 * periodic reviews, arrivals, finished lines, freed crews, newly threatened zones, road closures,
 * refused orders) runs at the reviewing speed and the routine effort (api/demo.py decision_effort).
 */
export type WakeUrgency = "urgent" | "routine";

export type WakeKind =
  | "new_fire"
  | "escalation"
  | "outrun"
  | "freed"
  | "zone_slack"
  | "arrived"
  | "idle_on_scene"
  | "line_finished"
  | "line_breached"
  | "strategy_failing"
  | "zone_touched"
  | "zone_threatened"
  | "road_closed"
  | "refused"
  | "continuous_review"
  | "periodic_review"
  | "changes";

export interface WakeTrigger {
  kind: WakeKind;
  urgency: WakeUrgency;
  text: string;
}

/** The monitor's answer: why to call the agent now (triggers [] = stay quiet). */
export interface Wake {
  triggers: WakeTrigger[];
  /** The trigger texts, for observation.monitor.woke_because. */
  reasons: string[];
  urgency: WakeUrgency;
}

/** Review triggers (the gap- or period-based calls), as opposed to events that wake the agent at once. */
export const REVIEW_KINDS: ReadonlySet<WakeKind> = new Set(["continuous_review", "periodic_review", "changes"]);

interface FireMemo {
  areaHa: number;
  reachM: number;
  containmentPct: number;
  status: FireStatus;
  breaches: number;
  strategyId: string | null;
  /** The chosen strategy was not containable or no longer offered. */
  strategyFailing: boolean;
}

interface TeamMemo {
  status: TeamStatus;
  fireId: string | null;
  /** On scene and doing work (past any hike in, not idle). */
  working: boolean;
  /** On scene at a burning fire with no work (idleOnSceneReason). */
  idle: boolean;
}

/** What the agent saw at its last decision; the monitor wakes it on changes since. */
export interface MonitorMemory {
  minute: number;
  /** Fires on the board (not out). */
  fireIds: string[];
  /** Crews that cannot take an order now (not dispatchable: en route, on scene, refilling, resting, out of service). */
  busyCrewIds: string[];
  /** Burning fires their assigned crews could not contain. */
  outrunFireIds: string[];
  /** Zones with no order in effect short of time (scheduled ones from their start), by slack tier. */
  slackTiers: Record<string, SlackTier>;
  /** Extended-attack stage due per reported burning fire (boardResponse.ts FireResponse.stage). */
  escalationStages: Record<string, number>;
  /** Per reported fire (not out): size, reach, containment, breaches and the chosen strategy's state. */
  fires: Record<string, FireMemo>;
  /** Per unit: status, fire and whether it works or stands idle on scene. */
  teams: Record<string, TeamMemo>;
  /** Attack lines finished on reported fires. */
  finishedLineIds: string[];
  /** Zones a reported fire has reached (zone.knownTouchedAt). */
  touchedZoneIds: string[];
  /** Zones threatened (threatenedZones). */
  threatenedZoneIds: string[];
  /** roadClosures.closureKey. */
  closures: string;
  /** Board minute the decision's orders were applied (the page sets it, afterDecision); reviews count from it. */
  appliedAt: number | null;
  /** Orders refused (server or page) in that decision. */
  refused: number;
  /** That decision was itself woken by refused orders (a refusal re-wakes the agent at most once in a row). */
  wokeOnRefusal: boolean;
}

function escalationStages(board: Board): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of board.fires) {
    const stage = board.response.fires.get(f.id)?.stage ?? 0;
    if (f.status === "burning" && isReported(board, f) && stage > 0) out[f.id] = stage;
  }
  return out;
}

/**
 * Reported fires (not out) the agent has not decided on yet (not in `memory`). The page's monitor
 * (useDemoAgent) calls the agent at once for these, without waiting for its MONITOR_EVERY_MINUTES
 * check: on this board nothing attacks a new fire until the agent dispatches it.
 */
export function newReportedFireIds(board: Board, memory: MonitorMemory | null): string[] {
  const known = new Set(memory?.fireIds ?? []);
  return activeFires(board)
    .filter((f) => isReported(board, f) && !known.has(f.id))
    .map((f) => f.id);
}

function outrunFires(board: Board): Fire[] {
  // A fire whose crews are building line ahead of it is fought through the fire model, not the perimeter race.
  return board.fires.filter(
    (f) =>
      f.status === "burning" &&
      isReported(board, f) &&
      currentContainment(board, f) === null &&
      !board.teams.some((t) => t.fireId === f.id && t.lineId !== null),
  );
}

/** Order slack of a zone with no order in effect: from its scheduled start when it has one, else as if ordered now. */
function zoneSlack(board: Board, zone: ZoneState, forecast: ZoneForecast | undefined): number | null {
  return zone.pendingOrder ? scheduledSlack(board, zone, forecast) : orderSlack(forecast);
}

function slackTiers(board: Board, forecasts: Map<string, ZoneForecast>): Record<string, SlackTier> {
  const out: Record<string, SlackTier> = {};
  for (const zone of board.zones) {
    if (zone.orderedAt !== null || zone.overrunAt !== null) continue;
    const slack = zoneSlack(board, zone, forecasts.get(zone.id));
    if (slack === null || slack > SLACK_ALERT_MINUTES) continue;
    out[zone.id] = slack <= 0 ? 2 : 1;
  }
  return out;
}

/** Whether the fire's chosen strategy is not containable now or no longer offered (strategyOptions.ts). */
function strategyFailing(board: Board, fire: Fire): boolean {
  const chosen = board.response.fires.get(fire.id)?.strategy;
  if (!chosen || fire.status !== "burning") return false;
  const option = computeStrategyOptions(board, fire).find((o) => o.id === chosen.id);
  return !option || option.outcome === "not_containable";
}

function teamMemo(board: Board, team: Team): TeamMemo {
  const idle = idleOnSceneReason(board, team) !== null;
  const working =
    !idle &&
    team.status === "on_scene" &&
    team.fireId !== null &&
    team.workMode !== null &&
    team.workMode !== "out_of_reach" &&
    (team.workStartAt === null || team.workStartAt <= board.minute);
  return { status: team.status, fireId: team.fireId, working, idle };
}

function fireMemo(board: Board, fire: Fire): FireMemo {
  return {
    areaHa: fireAreaHa(fire),
    reachM: fire.reachM,
    containmentPct: containmentPct(fire),
    status: fire.status,
    breaches: board.response.fires.get(fire.id)?.breaches ?? 0,
    strategyId: board.response.fires.get(fire.id)?.strategy?.id ?? null,
    strategyFailing: strategyFailing(board, fire),
  };
}

/** Zones with people home, no order in effect and a reported fire forecast to reach them (edge or core). */
function threatenedZones(board: Board, forecasts: Map<string, ZoneForecast>): ZoneState[] {
  return board.zones.filter((zone) => {
    if (zone.orderedAt !== null || zone.pendingOrder !== null || zone.overrunAt !== null) return false;
    const f = forecasts.get(zone.id);
    return (f?.edgeEta != null || f?.coreEta != null) && zoneCounts(zone, board.minute).home > 0;
  });
}

/** Hot: a reported fire burning or a zone threatened; the agent then reviews every CONTINUOUS_GAP_MINUTES. */
function incidentHot(board: Board, forecasts: Map<string, ZoneForecast>): boolean {
  return board.fires.some((f) => f.status === "burning" && isReported(board, f)) || threatenedZones(board, forecasts).length > 0;
}

/** Warm: a reported fire not out (contained, mop-up) or a zone still leaving; reviewed every REVIEW_EVERY_MINUTES. */
function incidentWarm(board: Board): boolean {
  return activeFires(board).some((f) => isReported(board, f)) || board.zones.some((z) => zoneOrderStatus(z, board.minute) === "leaving");
}

const reportedLines = (board: Board) =>
  board.lines.filter((l) => {
    const fire = board.fires.find((f) => f.id === l.fireId);
    return fire !== undefined && isReported(board, fire);
  });

/** Snapshot of the board as the agent sees it in this call's observation. */
export function rememberDecision(board: Board, forecasts: Map<string, ZoneForecast> = zoneForecasts(board, "reported")): MonitorMemory {
  const fires: Record<string, FireMemo> = {};
  for (const f of activeFires(board)) if (isReported(board, f)) fires[f.id] = fireMemo(board, f);
  const teams: Record<string, TeamMemo> = {};
  for (const t of board.teams) teams[t.id] = teamMemo(board, t);
  return {
    minute: board.minute,
    fireIds: Object.keys(fires),
    busyCrewIds: board.teams.filter((t) => !dispatchable(t)).map((t) => t.id),
    outrunFireIds: outrunFires(board).map((f) => f.id),
    slackTiers: slackTiers(board, forecasts),
    escalationStages: escalationStages(board),
    fires,
    teams,
    finishedLineIds: reportedLines(board).filter((l) => l.completedAt !== null).map((l) => l.id),
    touchedZoneIds: board.zones.filter((z) => z.knownTouchedAt !== null).map((z) => z.id),
    threatenedZoneIds: threatenedZones(board, forecasts).map((z) => z.id),
    closures: closureKey(board),
    appliedAt: null,
    refused: 0,
    wokeOnRefusal: false,
  };
}

/**
 * The memory after a decision's orders were applied: `seen` (the board when the call started, so
 * events while Claude thought still wake it), with the units and fires the orders touched taken
 * from the board now, so the decision's own effects (a released crew free again, a newly chosen
 * strategy) do not wake it again.
 */
export function afterDecision(
  seen: MonitorMemory,
  board: Board,
  orders: DemoOrder[],
  refused: number,
  wokeOnRefusal: boolean,
): MonitorMemory {
  const teams = { ...seen.teams };
  const busy = new Set(seen.busyCrewIds);
  const fires = { ...seen.fires };
  for (const order of orders) {
    if (order.type === "send_crew" || order.type === "release_crew") {
      const team = board.teams.find((t) => t.id === order.crew_id);
      if (!team) continue;
      teams[team.id] = teamMemo(board, team);
      if (dispatchable(team)) busy.delete(team.id);
      else busy.add(team.id);
    } else if (order.type === "set_strategy") {
      const fire = board.fires.find((f) => f.id === order.fire_id);
      if (fire && fires[fire.id]) fires[fire.id] = { ...fires[fire.id], strategyId: board.response.fires.get(fire.id)?.strategy?.id ?? null, strategyFailing: strategyFailing(board, fire) };
    }
  }
  return { ...seen, teams, fires, busyCrewIds: [...busy], appliedAt: board.minute, refused, wokeOnRefusal };
}

const signed = (v: number, unit: string, digits = 0) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)} ${unit}`;

/**
 * What changed since the last decision, in one line (all numbers from the board's models): per
 * reported fire its area and growth, reach from ignition, containment and status, and its units
 * (working, en route, idle on scene); fires gone out; orders refused last time. Events (arrivals,
 * lines, zones, closures) wake the agent on their own and are listed in their own reasons.
 */
function changesSince(board: Board, memory: MonitorMemory): string {
  const since = Math.round(board.minute - (memory.appliedAt ?? memory.minute));
  const parts: string[] = [];
  for (const fire of activeFires(board)) {
    const before = memory.fires[fire.id];
    if (!before || !isReported(board, fire)) continue;
    const area = fireAreaHa(fire);
    const bits = [
      fire.status !== before.status ? `${before.status} → ${fire.status}` : null,
      `${round1(area)} ha (${signed(area - before.areaHa, "ha", 1)})`,
      `reach ${Math.round(fire.reachM)} m from ignition (${signed(fire.reachM - before.reachM, "m")})`,
      `containment ${before.containmentPct}% → ${containmentPct(fire)}%`,
    ];
    const units = board.teams.filter((t) => t.fireId === fire.id);
    const memo = units.map((t) => ({ t, m: teamMemo(board, t) }));
    const working = memo.filter((x) => x.m.working).map((x) => x.t.id);
    const enRoute = units.filter((t) => t.status === "en_route").map((t) => t.id);
    const idle = memo.filter((x) => x.m.idle).map((x) => x.t.id);
    const hiking = units.filter((t) => t.status === "on_scene" && t.workStartAt !== null && t.workStartAt > board.minute).map((t) => t.id);
    bits.push(
      units.length === 0
        ? "no units assigned"
        : [
            working.length ? `working ${listIds(working)}` : null,
            hiking.length ? `walking in ${listIds(hiking)}` : null,
            enRoute.length ? `en route ${listIds(enRoute)}` : null,
            idle.length ? `idle on scene ${listIds(idle)}` : null,
          ]
            .filter(Boolean)
            .join(", ") || `units ${listIds(units.map((t) => t.id))}`,
    );
    parts.push(`${fire.id}: ${bits.filter(Boolean).join(", ")}`);
  }
  const out = memory.fireIds.filter((id) => !activeFires(board).some((f) => f.id === id));
  if (out.length) parts.push(`out: ${listIds(out)}`);
  if (memory.refused > 0) parts.push(`${memory.refused} order${memory.refused > 1 ? "s" : ""} refused last time (previous.rejected)`);
  return `Since the last decision (${simClock(memory.appliedAt ?? memory.minute)}, ${since} min ago): ${parts.length ? parts.join("; ") : "no reported fire on the board"}.`;
}

/**
 * Why the agent should decide now (`triggers` [] = stay quiet), compared with `memory` (null =
 * it has not decided yet). Events wake it at once; with none, a continuous review once the board
 * is CONTINUOUS_GAP_MINUTES past the last decision while the incident is hot (REVIEW_EVERY_MINUTES
 * while only warm). Any wake after a first decision ends with the "Since the last decision" line.
 */
export function wakeReasons(board: Board, forecasts: Map<string, ZoneForecast>, memory: MonitorMemory | null): Wake {
  const triggers: WakeTrigger[] = [];
  const push = (kind: WakeKind, urgency: WakeUrgency, text: string) => triggers.push({ kind, urgency, text });
  const active = activeFires(board).filter((f) => isReported(board, f));
  const known = new Set(memory?.fireIds ?? []);

  const fresh = active.filter((f) => !known.has(f.id));
  if (fresh.length > 0) {
    // Nothing is dispatched automatically on this board: a new fire with no unit on it waits for this decision.
    const unattacked = fresh.filter(
      (f) =>
        f.status === "burning" &&
        !board.teams.some((t) => t.fireId === f.id) &&
        !board.response.aircraft.some((a) => a.fireId === f.id),
    );
    push(
      "new_fire",
      "urgent",
      `New reported fire${fresh.length > 1 ? "s" : ""} since the last decision: ${listIds(fresh.map((f) => `${f.id} (${f.source})`))}.` +
        (unattacked.length
          ? ` No unit is assigned to ${listIds(unattacked.map((f) => f.id))} and nothing is dispatched automatically: send initial attack now (recommended_initial_attack).`
          : ""),
    );
  }

  const stages = escalationStages(board);
  for (const [fireId, stage] of Object.entries(stages)) {
    if (!known.has(fireId) || stage <= (memory?.escalationStages?.[fireId] ?? 0)) continue;
    const why = stage === 1 ? "initial attack failed" : `the fire passed ${ESCALATION_STAGE_ACRES[stage - 1]} acres`;
    push("escalation", "urgent", `${fireId}: extended attack stage ${stage} due (${why}); nothing is ordered automatically: see extended_attack_due.`);
  }

  // Free at their station or returning to it: both can be sent.
  const free = board.teams.filter(dispatchable).map((t) => t.id);
  if (free.length > 0) {
    const seenOutrun = new Set(memory?.outrunFireIds ?? []);
    for (const fire of outrunFires(board)) {
      if (seenOutrun.has(fire.id) || !known.has(fire.id)) continue;
      const assigned = board.teams.filter((t) => t.fireId === fire.id).map((t) => t.id);
      push("outrun", "urgent", `${fire.id} is no longer containable by its crews (${assigned.length ? assigned.join(", ") : "none assigned"}); free: ${listIds(free)}.`);
    }
  }

  const wasBusy = new Set(memory?.busyCrewIds ?? []);
  const freed = free.filter((id) => wasBusy.has(id));
  if (freed.length > 0) push("freed", "routine", `Crew${freed.length > 1 ? "s" : ""} freed: ${listIds(freed)}.`);

  const tiers = slackTiers(board, forecasts);
  for (const zone of board.zones) {
    const tier = tiers[zone.id];
    if (tier === undefined || tier <= (memory?.slackTiers[zone.id] ?? 0)) continue;
    const slack = zoneSlack(board, zone, forecasts.get(zone.id));
    const pending = zone.pendingOrder;
    const what = pending ? `is scheduled to leave at minute ${pending.startMinute}` : "has no evacuation order";
    push(
      "zone_slack",
      "urgent",
      tier === 2
        ? `${zone.id} (${zone.name}) ${what} and is already late: ${slack} min of order slack${pending ? " from its start" : ""}.`
        : `${zone.id} (${zone.name}) ${what} and ${slack} min of order slack${pending ? " from its start" : ""}.`,
    );
  }

  if (memory) {
    // Units: arrived on scene, or standing at a burning fire with no work.
    const arrived: string[] = [];
    const idle: string[] = [];
    for (const team of board.teams) {
      const before = memory.teams[team.id];
      const sameFire = before?.fireId === team.fireId;
      if (team.status === "on_scene" && team.fireId !== null && !(before?.status === "on_scene" && sameFire)) {
        arrived.push(unitAccessText(board, team).replace(/\.$/, "") || team.id);
      }
      const why = idleOnSceneReason(board, team);
      if (why !== null && !(before?.idle && sameFire)) idle.push(`${team.id} (${why})`);
    }
    if (arrived.length) push("arrived", "routine", `Arrived on scene: ${listIds(arrived)}.`);
    if (idle.length) {
      push("idle_on_scene", "urgent", `Standing at a fire with no work: ${listIds(idle)}. Reposition them (another attack position or fire) or release them.`);
    }

    const lines = reportedLines(board);
    const finished = new Set(memory.finishedLineIds);
    const done = lines.filter((l) => l.completedAt !== null && !finished.has(l.id));
    if (done.length) push("line_finished", "routine", `Line finished: ${listIds(done.map((l) => `${l.fireId} ${l.plan.id} (${Math.round(l.lengthM)} m)`))}.`);

    for (const fire of active) {
      const before = memory.fires[fire.id];
      if (!before) continue;
      const breaches = board.response.fires.get(fire.id)?.breaches ?? 0;
      if (breaches > before.breaches) push("line_breached", "urgent", `${fire.id}: the fire breached its line (${breaches} breach${breaches > 1 ? "es" : ""} so far).`);
      const chosen = board.response.fires.get(fire.id)?.strategy ?? null;
      if (chosen && strategyFailing(board, fire) && !(before.strategyId === chosen.id && before.strategyFailing)) {
        const offered = computeStrategyOptions(board, fire).some((o) => o.id === chosen.id);
        push(
          "strategy_failing",
          "urgent",
          `${fire.id}: the chosen strategy ${chosen.id} is ${offered ? "no longer containable with the units available (outcome not_containable)" : "no longer offered (still_offered false)"}: choose another.`,
        );
      }
    }

    const touchedBefore = new Set(memory.touchedZoneIds);
    for (const zone of board.zones) {
      if (zone.knownTouchedAt === null || touchedBefore.has(zone.id)) continue;
      const home = zoneCounts(zone, board.minute).home;
      push("zone_touched", home > 0 ? "urgent" : "routine", `Fire reached ${zone.id} (${zone.name}): ${home} household${home === 1 ? "" : "s"} home.`);
    }
    const threatenedBefore = new Set(memory.threatenedZoneIds);
    const threatened = threatenedZones(board, forecasts).filter((z) => !threatenedBefore.has(z.id));
    if (threatened.length) {
      push(
        "zone_threatened",
        "routine",
        `Newly threatened, no order: ${listIds(threatened.map((z) => `${z.id} (fire ETA ${forecasts.get(z.id)?.edgeEta ?? forecasts.get(z.id)?.coreEta} min)`))}.`,
      );
    }

    if (closureKey(board) !== memory.closures) push("road_closed", "routine", `Road closures changed: ${closedIds(board).length} closed now (closed_roads).`);
    if (memory.refused > 0 && !memory.wokeOnRefusal) {
      push("refused", "routine", `${memory.refused} order${memory.refused > 1 ? "s were" : " was"} refused in the last decision (previous.rejected): re-issue a valid order if it is still needed.`);
    }
  }

  if (triggers.length === 0 && active.length > 0) {
    const since = memory === null ? Infinity : board.minute - (memory.appliedAt ?? memory.minute);
    const burning = active.filter((f) => f.status === "burning").length;
    const zones = threatenedZones(board, forecasts).length;
    const picture = `${burning} fire${burning === 1 ? "" : "s"} burning, ${active.length - burning} contained${zones ? `, ${zones} zone${zones > 1 ? "s" : ""} threatened with no order` : ""}`;
    if (incidentHot(board, forecasts) && since >= CONTINUOUS_GAP_MINUTES) {
      push("continuous_review", "routine", `Continuous review: ${Number.isFinite(since) ? `${Math.round(since)} min since the last decision` : "first look"}; ${picture}.`);
    } else if (since >= REVIEW_EVERY_MINUTES) {
      push("periodic_review", "routine", `Periodic review: ${Number.isFinite(since) ? `${Math.round(since)} min since the last decision` : "first look"}; ${picture}.`);
    }
  } else if (triggers.length === 0 && memory !== null && incidentWarm(board)) {
    const since = board.minute - (memory.appliedAt ?? memory.minute);
    if (since >= REVIEW_EVERY_MINUTES) push("periodic_review", "routine", `Periodic review: ${Math.round(since)} min since the last decision; zones still leaving.`);
  }

  if (triggers.length > 0 && memory !== null) push("changes", "routine", changesSince(board, memory));
  return {
    triggers,
    reasons: triggers.map((t) => t.text),
    urgency: triggers.some((t) => t.urgency === "urgent") ? "urgent" : "routine",
  };
}
