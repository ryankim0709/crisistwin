/**
 * What the /demo AI commander sees, and when it is called. Pure: no React, network or LLM.
 *
 * - buildObservation turns the board (demo/model.ts) into the wire DemoObservation
 *   (demo/contracts.ts). Every number is simulator output, rounded for the wire: minutes to
 *   integers, hectares to 0.1, metres to integers.
 * - wakeReasons is the monitor: between decisions the page checks the board every
 *   MONITOR_EVERY_MINUTES simulated minutes and calls the agent only when this returns a
 *   reason. It compares the board with a MonitorMemory taken when the agent last decided, so a
 *   standing situation the agent has already seen does not wake it again (until the periodic
 *   review). The live drill's picture has its own wake reasons (incidentPicture.ts
 *   pictureWakeReasons: new help request, road-blocked report, real-phone report, confirmation).
 */

import type { CrewObservation, DemoObservation, FireObservation, IncidentPicture, ZoneObservation } from "./contracts";
import {
  ACTIVITY,
  DEPARTURE_SPREAD_MINUTES,
  FORECAST_MINUTES,
  activeFires,
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
  zoneForecasts,
  type Board,
  type Fire,
  type RouteOption,
  type ZoneForecast,
  type ZoneState,
} from "./model";
import { ORDER_COMPLIANCE, SHADOW_SHARE, holdsFlameFeet, kindLabel, windAt } from "./realism";
import { departmentStatus, dispatchable, isReported, reachFraction } from "./boardResponse";
import { TANK_GALLONS } from "../response/units";
import { MAX_ORDER_COUNT, ORDERABLE, dispatchLevel } from "../response/runCards";

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
> {
  const fr = board.response.fires.get(fire.id);
  return {
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
  const wind = windAt(board.env.spread.wind, board.minute);
  const firsts = r.stats.firstArrivalMinutes;
  return {
    auto_dispatch: r.autoDispatch,
    auto_escalate: r.autoEscalate,
    dispatch_level_now: dispatchLevel(ACTIVITY[board.activity].moisture, wind.speedMetersPerSecond),
    departments: departmentStatus(board),
    mutual_aid_pool_units: r.pool.length,
    // Bounded for the 200 kB decide body: assigned aircraft first, at most MAX_LISTED.
    aircraft: [...r.aircraft]
      .sort((a, b) => Number(a.fireId === null) - Number(b.fireId === null))
      .slice(0, MAX_LISTED)
      .map((a) => ({ id: a.id, kind: a.kind, base: a.baseName, status: a.status, fire_id: a.fireId, drops: a.drops })),
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
  "Road network per apparatus class (POST /api/demo/crew_routes); straight line x 1.3 at 60 km/h until a road time is known (assumption); seeded +/-20% variation (assumption); a road cut by fire forces a reroute";
export const CONGESTION_LABEL =
  "Unit travel: BPR (1964) delay from the board's own evacuation flows on shared roads (1,700 veh/h per direction, HCM 2010; against-flow weight 0.5 assumed). Evacuee travel itself is free-flow (not modelled)";

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
  /** The live drill's incident picture (incidentPicture.ts), when the board runs beside one. */
  picture: IncidentPicture | null = null,
): DemoObservation {
  const minute = board.minute;
  // The commander sees only fires the dispatch centre knows about (response/report.ts).
  const fires = activeFires(board).filter((f) => isReported(board, f));

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

  const zones: ZoneObservation[] = listed.map((zone) => {
    const f = forecasts.get(zone.id);
    const counts = zoneCounts(zone, minute);
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
      shadow_evacuating: zone.shadowAt !== null && zone.orderedAt === null,
      fire_eta_min: f?.edgeEta ?? null,
      fire_core_eta_min: f?.coreEta ?? null,
      order_slack_min: orderSlack(f),
      destination_id: ordered ? (zone.route?.destination_id ?? null) : null,
      // An overrun zone cannot be ordered out (model.applyOrder refuses), so it offers nothing.
      options:
        zone.overrunAt !== null
          ? []
          : (routes.get(zone.id) ?? []).map((o) => ({
              destination_id: o.destination_id,
              name: o.name,
              eta_min: Math.round(o.eta_min),
              safety: o.safety,
            })),
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
      })),
      threatens_zone_ids: listed.filter((zone) => fireReachesZone(board, fire, zone, limit)).map((zone) => zone.id),
      ...fireResponseObservation(board, fire),
      head_m_per_min: round1(fire.rates.headMetersPerMinute),
      head_flame_ft: round1(fire.rates.headFlameFeet),
      heading_deg: Math.round(fire.rates.headingDegrees),
      length_to_breadth: round1(fire.rates.lengthToBreadth),
      slope_pct: Math.round(fire.rates.slopePercent),
    };
  });

  const crews: CrewObservation[] = board.teams.map((team) => {
    const fire = team.fireId ? (board.fires.find((f) => f.id === team.fireId) ?? null) : null;
    return {
      id: team.id,
      kind: team.kind,
      label: kindLabel(team.kind),
      base: board.stations.find((s) => s.id === team.station)?.name ?? team.station,
      status: team.status,
      fire_id: team.fireId,
      eta_min:
        team.status === "en_route" && team.arriveAt !== null ? Math.max(0, Math.ceil(team.arriveAt - minute)) : null,
      line_m_per_min: round1(unitLineOn(board, team, fire)),
      holds_flame_ft: holdsFlameFeet(team.kind),
      travel: team.status === "en_route" ? team.travel : null,
      department: board.response.departments.find((d) => d.id === team.department)?.name ?? team.department,
      tier: team.tier,
      water_pct: team.waterGallons === null ? null : Math.round((team.waterGallons / (TANK_GALLONS[team.kind] ?? team.waterGallons)) * 100),
      work_h: round1(team.workMinutes / 60),
      parked_m: team.parkedM === null || !team.accessKnown ? null : Math.round(team.parkedM),
      work_mode: team.workMode,
      working_in_min: team.workStartAt === null ? null : Math.max(0, Math.ceil(team.workStartAt - minute)),
    };
  });

  const spread = board.env.spread;
  const wind = windAt(spread.wind, minute);
  return {
    clock: {
      minute: Math.round(minute),
      departure_mean_min: DEPARTURE_SPREAD_MINUTES,
      order_compliance: ORDER_COMPLIANCE,
      shadow_share: SHADOW_SHARE,
      forecast_min: FORECAST_MINUTES,
    },
    activity: board.activity,
    wind: {
      from_deg: Math.round(wind.fromDegrees),
      speed_m_s: round1(wind.speedMetersPerSecond),
      evidence: spread.wind.evidence,
      source: spread.wind.label,
    },
    inputs: {
      fuel: spread.ground.fuelLabel,
      moisture: `${ACTIVITY[board.activity].moisture} (Scott & Burgan 2005 scenario, chosen by the activity level)`,
      terrain: spread.ground.terrainLabel,
      stations: board.env.basesLabel,
      travel: TRAVEL_LABEL,
      congestion: CONGESTION_LABEL,
      response: board.response.label,
    },
    fires: fireObs,
    crews,
    zones,
    quiet_zone_count: board.zones.length - listed.length,
    totals: {
      households: board.zones.reduce((sum, z) => sum + z.households, 0),
      households_home_in_threatened_zones: zones.reduce((sum, z) => sum + z.households_home, 0),
      households_caught_total: board.caughtTotal,
      households_no_vehicle_at_risk: totals(board, forecasts).noVehicleAtRisk,
      fires_burning: fires.filter((f) => f.status === "burning").length,
      fires_out_total: board.firesOutTotal,
      crews_available: board.teams.filter((t) => dispatchable(t) && t.fireId === null).length,
    },
    response: responseObservation(board),
    monitor: { woke_because: wokeBecause },
    previous,
    incident_picture: picture,
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
  return board.fires.filter((f) => f.status === "burning" && isReported(board, f) && currentContainment(board, f) === null);
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
    fireIds: activeFires(board).filter((f) => isReported(board, f)).map((f) => f.id),
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
  const active = activeFires(board).filter((f) => isReported(board, f));
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
