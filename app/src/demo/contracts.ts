/**
 * Wire contract between the /demo page and app/backend/api/demo.py (+ demo_realism.py). Change
 * both sides and docs/command-demo-realism.md together.
 *
 * Every /api/demo/* endpoint takes an optional query parameter `incident=<incident_id>` (see
 * `demoUrl`): absent means the Camp drill; an unknown or non-active incident is a 404
 * `{ error, detail }`. The page follows the live active incident (live/active.ts) and passes it.
 *
 * POST /api/demo/routes: `{ fires: LonLat[][] }` (closed rings of the fires that are not out,
 * at most 60, each 4..200 points) -> `RoutesResponse`. Routes come from the live planner's
 * router over the incident's drill roads (livecore.routing), avoiding the posted fire areas.
 * Each option lists `segment_ids` into the answer's `segments` table (road runs with one
 * capacity; demo.py route_segments) for the board's congestion model (demo/traffic.ts); ids are
 * only comparable within one answer. Example segment:
 * `"e7166f": { "name": "San Pablo Avenue", "length_m": 111, "lanes": 2, "capacity_veh_h": 2400, "free_flow_min": 0.119 }`.
 *
 * POST /api/demo/decide: `{ observation: DemoObservation, urgency?: "urgent" | "routine" }` (at
 * most 200 kB; urgency picks the effort, api/demo.py decision_effort; default urgent) ->
 * application/x-ndjson, `DecisionEvent` lines ending with one "orders" or "error" line, as
 * /api/dispatch/decide (dispatch/contracts.ts). Non-2xx responses carry `{ error, detail }`.
 * The /live board is AI agent only: nothing is dispatched or ordered unless an order says so
 * (response.auto_dispatch / auto_escalate are false); per-fire recommended_initial_attack and
 * extended_attack_due are the simulator's recommendations, not orders.
 * Orders: send_crew, release_crew (crew_id may also be an aircraft id from response.aircraft;
 * aircraft take position_id null), order_evacuation (zone_id, destination_id, start_minute:
 * absolute whole board minute departures start, null = now, at most MAX_SCHEDULE_AHEAD_MINUTES
 * ahead), cancel_evacuation (zone_id; a scheduled order not yet started), and order_resources
 * (fire_id, resource, count; limits in response/runCards.ts ORDERABLE / MAX_ORDER_COUNT, mirrored
 * in demo.py ORDERABLE_RESOURCES), set_strategy (fire_id, strategy_id: one of the fire's
 * strategy_options ids, e.g. "direct", "parallel", "line:flank_left"; demo/strategyOptions.ts;
 * units then go with send_crew, position_id = the option's position_id), and the live drill actions
 * of `LiveOrder` (ids from the observation's `incident_picture`, the live drill's bounded picture:
 * incidentPicture.ts). Example staging decision at minute 40:
 * `[{type:"order_evacuation",zone_id:"Z1",destination_id:"D2",start_minute:null},
 *   {type:"order_evacuation",zone_id:"Z2",destination_id:"D1",start_minute:60},
 *   {type:"order_evacuation",zone_id:"Z3",destination_id:"D2",start_minute:75}]`. The response model behind the observation's `response` block and the
 * per-fire tactic fields is docs/response-model.md.
 *
 * POST /api/demo/crew_routes: `CrewRoutesRequest` -> `CrewRoutesResponse`. Road travel for
 * firefighting units over the drill roads their apparatus class may use (livecore.inbound), with
 * OSM surface/width/weight tags and DEM grade per road (docs/command-demo-realism.md "Road access").
 * GET /api/demo/road_access -> `RoadAccessResponse`: drill roads closed to each class.
 * GET /api/demo/wind?mode=historical_replay|climatology_percentile -> `WindResponse`.
 * GET /api/demo/environment -> `EnvironmentResponse` (drill centre, Camp terrain grid, carless households, package fire stations).
 * The page no longer uses `terrain`: slope comes from the LANDFIRE landscape the fire solver runs on.
 * Wind is searched from the incident's centre.
 *
 * GET /api/live/incidents/<id>/studio-fires (live API, any live role; docs/live-reports.md
 * "Studio fires") -> `StudioFiresResponse`: the runs Simulation Studio published for this
 * incident, newest first, at most 10. The board's only fire source (useStudioFires.ts).
 *
 * Every number in an observation is simulator output (demo/model.ts; fire numbers from the
 * fire solver, demo/fireField.ts), sourced data
 * (demo/realism.ts) or a labelled assumption; the agent only chooses among the ids it lists.
 * The server validates orders against the observation; the page validates again when it
 * applies them.
 *
 * Crews, stations and zone households come from the drill's scenario resource snapshot
 * (GET /api/live/incidents/<id>/snapshot, docs/scenario-snapshots.md): crew ids are the snapshot's
 * engine_ids (plus assumed C1, C2, D1), zones carry persons (`occupants`, `people_*`) and
 * needs-transport counts. Without a snapshot the assumed roster and drill-file counts are used and
 * `inputs.stations` says so.
 *
 * Units: minutes are simulation minutes from T+0; metres; hectares; WGS84 [lon, lat]; wind
 * m/s, direction the wind blows FROM in degrees true; flame lengths feet.
 */

import { DEFAULT_INCIDENT_ID } from "../live/api";
import type { LonLat } from "../live/types";
import type { RouteOption, TeamStatus, FireSource, FireStatus, TravelBasis } from "./model";
import type { CommsChannel, InjuryEvent, SimCommsItem } from "./runContracts";
import type { RouteSegment } from "./traffic";
import type { DemoApparatusKind } from "./realism";
import type { AccessClass } from "../studio/apparatus";
import type { Tactic } from "../response/containment";
import type { Tier } from "../response/fleet";
import type { DispatchLevel, Orderable } from "../response/runCards";
import type { DecisionUsage } from "../dispatch/contracts";

export type { DecisionUsage };

/**
 * How an option's arrival times were found: "road" = every crew's time is turnout plus its road
 * leg (POST /api/demo/crew_routes); "estimate" = at least one crew's road leg is not known yet,
 * so its time is the ASSUMPTION straight line x 1.3 at 60 km/h (that crew may still turn out to
 * have no road route).
 */
export type OptionRoute = "road" | "estimate";

/**
 * An apparatus road-access class (docs/suppression-data.md R01-R12) that cannot drive to a fire
 * or position: legs of that class there failed for a reason at the target's end, from 2 origins
 * (or from every origin its free units stand at), and none succeeded (model.ts classBlocked).
 * Its crews are left out of that target's options. `reason` is the router's
 * (livecore.inbound: no_open_road, no_access, target_in_fire, target_off_network).
 */
export interface UnreachableClassObservation {
  access_class: AccessClass;
  /** Crew kinds on the board that drive as this class. */
  kinds: DemoApparatusKind[];
  reason: string;
}

/**
 * One Simulation Studio run published for Live command (app/backend/api/live/studio_fires.py).
 * Units: `lon`/`lat` WGS84 degrees; `start_minute` integer minutes from the scenario's T+0;
 * `wind.speed_mph` open 20-ft wind, mph; `wind.from_deg` the bearing it blows FROM, degrees
 * true; moisture values fractions (0.06 = 6%); `published_at` ISO UTC (server wall clock).
 */
export interface StudioFire {
  fire_id: string;
  published_at: string;
  incident_id: string;
  name: string;
  scenario_id: string;
  region_id: string;
  /**
   * `start_minute`: integer minutes from Studio T+0. `report_minute`: minute on the same clock the
   * fire is reported to dispatch, set by the Studio user (start_minute <= report_minute <= 1440);
   * null = not set, so the board models its own report delay.
   */
  ignitions: { id: string; name: string; lon: number; lat: number; start_minute: number; report_minute: number | null }[];
  /** source: assumed | historical | worst_case | forecast (Studio's wind origin). */
  wind: { speed_mph: number; from_deg: number; source: string; label: string };
  moisture: {
    preset: string;
    label: string;
    values: { dead1h: number; dead10h: number; dead100h: number; liveHerb: number; liveWoody: number };
  };
  horizon_minutes: number;
  /** Ignition ids more than 3 km outside the drill zones' box; the board skips them. */
  outside_drill: string[];
  /**
   * The run's hourly weather series, or null (one constant wind, or a fire published before the
   * field existed). `minute` on the Studio clock (may be negative), wind mph / bearing FROM degrees
   * true, moisture fractions (null = the publish's `moisture`). The board reads it as Studio does.
   */
  weather_series: {
    source: string;
    evidence: string;
    samples: { minute: number; wind_speed_mph: number; wind_from_deg: number; moisture: StudioFire["moisture"]["values"] | null }[];
  } | null;
}

export interface StudioFiresResponse {
  fires: StudioFire[];
  evidence_class: "simulated";
}

export const ROUTES_URL = "/api/demo/routes";
export const DECIDE_URL = "/api/demo/decide";
export const CREW_ROUTES_URL = "/api/demo/crew_routes";
export const WIND_URL = "/api/demo/wind";
export const ENVIRONMENT_URL = "/api/demo/environment";
export const ROAD_ACCESS_URL = "/api/demo/road_access";

/** `url` for `incident`: Camp is the server default, so it is sent without the parameter. */
export function demoUrl(url: string, incidentId: string): string {
  if (incidentId === DEFAULT_INCIDENT_ID) return url;
  return `${url}${url.includes("?") ? "&" : "?"}incident=${encodeURIComponent(incidentId)}`;
}

/** A route option on the wire: segments by id (useDemoRoutes resolves them into `segments`). */
export type RouteOptionWire = Omit<RouteOption, "segments"> & { segment_ids: string[] };

export interface RoutesResponse {
  zones: { zone_id: string; options: RouteOptionWire[] }[];
  /** Road segments by id, for every option of this answer. Units: m, veh/h (one direction, all lanes), min. */
  segments: Record<string, Omit<RouteSegment, "id">>;
  /** Controller drill road closures the routes avoid (segment ids; live/useRoadClosures.ts), and whether the closure store answered. */
  closed_segment_ids?: string[];
  closures_status?: "ok" | "unavailable";
  evidence_class: "simulated";
}

export interface RoutesRequest {
  fires: LonLat[][];
  /** Destinations closed for this incident (fire forecast to reach them, or full; demo/safeDestinations.ts): never routed to. */
  excluded_destination_ids?: string[];
}

/** Road-access vehicle classes (docs/suppression-data.md R01-R12; studio/apparatus.ts AccessClass). */
export type AccessClassWire = "engine_t1_t2" | "engine_t3" | "engine_t4_t7" | "tender_support" | "tender_tactical";

export interface CrewRouteRequest {
  /** Caller's key, echoed back. */
  id: string;
  access_class: AccessClassWire;
  from: LonLat;
  to: LonLat;
}

/** At most 40 requests; `fires` as in RoutesRequest (roads inside a fire are not used). */
export interface CrewRoutesRequest {
  fires: LonLat[][];
  requests: CrewRouteRequest[];
}

export interface CrewRoute {
  id: string;
  /** Drive minutes (no turnout); null when there is no road route (`reason`). */
  drive_min: number | null;
  distance_m: number | null;
  /** road: on the drill roads; road_offboard: a straight-line x 1.3 leg to the nearest road first. */
  basis: "road" | "road_offboard" | null;
  /** Off-board leg, metres of straight line (0 when the origin is on the network). */
  offboard_m: number;
  reason: string | null;
  line: LonLat[];
  /**
   * Road access (optional; absent from older servers). `reached`: drives to the road nearest
   * `to`. `detour`: reaches it, but a faster road is closed to the class (`blocked_*`).
   * `stopped_short`: no road the class may use gets there; `drive_min`, `distance_m` and `line`
   * end at `stop_point`, and the unit covers `off_road_m_to_target` on foot or by hose lay.
   * null when there is no route (`reason`).
   */
  access_status?: "reached" | "detour" | "stopped_short" | null;
  /** Where the vehicle must stop (the last accessible road point nearest `to`); stopped_short only. */
  stop_point?: LonLat | null;
  /** Straight-line metres from the end of `line` to `to` (the road snap distance when reached). */
  off_road_m_to_target?: number | null;
  /** R01-R12 rule closing the better road (detour, stopped_short, or no route), e.g. "R05". */
  blocked_rule?: string | null;
  /** Plain-language reason, e.g. "Paved road too steep (22%) for a Type 1 engine on Pentz Road (R05)". */
  blocked_reason?: string | null;
  /** detour only: drive minutes an unrestricted vehicle would take. */
  unrestricted_drive_min?: number | null;
}

export interface CrewRoutesResponse {
  routes: CrewRoute[];
  /** Always "not_modelled": the demo's households are not in the traffic twin. */
  congestion: "not_modelled";
  evidence_class: "simulated";
  /** `ready`: OSM tags + DEM grade; `grade_only`: tags still loading; `none`: highway class only. */
  road_access?: { status: RoadAccessStatus; basis: string };
  /** Controller drill road closures every leg avoids (segment ids), and whether the closure store answered. */
  closed_segment_ids?: string[];
  closures_status?: "ok" | "unavailable";
}

export type RoadAccessStatus = "ready" | "grade_only" | "none";

/** Per apparatus class, drill road km closed by the road access rules (GET /api/demo/road_access). */
export interface RoadAccessClass {
  access_class: AccessClassWire;
  label: string;
  open_km: number;
  closed_km: number;
  top_rules: { rule: string; km: number; example: string }[];
}

export interface ClosedRoadProps {
  segment_id: string;
  name: string | null;
  /** Class -> the rule (R01-R12) that closes this road to it. */
  closed: Partial<Record<AccessClassWire, string>>;
  /** Plain-language reason for the first class it is closed to. */
  reason: string;
  grade_pct: number | null;
}

export interface RoadAccessResponse {
  status: RoadAccessStatus;
  basis: string;
  classes: RoadAccessClass[];
  /** Drill road segments closed to at least one class. */
  closed_roads: GeoJSON.FeatureCollection<GeoJSON.LineString, ClosedRoadProps>;
  /** OSM tags are observed; grade is derived from the DEM; the access rules are assumptions. */
  evidence_class: "derived";
}

export interface WindResponse {
  mode: "historical_replay" | "climatology_percentile";
  evidence_class: "observed" | "derived";
  start_utc: string;
  hours: number;
  /** source: iem_hads = RAWS (20-ft wind), iem_asos = airport ASOS (10 m wind). */
  station: { id: string; name: string; distance_km: number; source: string | null } | null;
  /** Hourly, `hours + 1` samples; speed m/s; direction the wind blows FROM, degrees true. */
  samples: { t_utc: string; speed_ms: number | null; from_deg: number | null }[];
  provenance: Record<string, unknown>;
}

export interface EnvironmentResponse {
  /** Centre of the incident's drill zones, WGS84 [lon, lat]. */
  center?: LonLat;
  /** Camp USGS 3DEP slope on a regular grid (row 0 = south); null for other incidents or when unavailable. */
  terrain: {
    origin_lon: number;
    origin_lat: number;
    cell_m: number;
    ncols: number;
    nrows: number;
    m_per_deg_lon: number;
    m_per_deg_lat: number;
    /** Rise over run x 1000, integers. */
    slope_milli: number[];
    /** Upslope bearing, whole degrees true. */
    upslope_deg: number[];
    source: string;
  } | null;
  terrain_detail: string | null;
  /** Carless households per drill zone id (ACS, from the replay bundle's demand table). */
  households_no_vehicle: Record<string, number>; // {} when unknown (non-Camp)
  households_no_vehicle_source: string | null;
  /** Fire stations of a Studio drill package (OpenStreetMap, observed); [] for Camp or when absent. */
  stations?: { id: string; name: string; lon: number; lat: number }[];
  /** Provenance of `stations`; null when there are none. */
  stations_source?: string | null;
}

export interface FireObservation {
  id: string;
  source: FireSource;
  status: FireStatus;
  age_min: number;
  area_ha: number;
  perimeter_m: number;
  perimeter_growth_m_per_min: number;
  line_m: number;
  /** Line built over current perimeter, percent (0-100). */
  containment_pct: number;
  /**
   * The fire's ground by cell state now (demo/fireState.ts), hectares; the three add up to area_ha
   * (up to rounding). burning: cells the fire is in now (cell resolution: the flaming front fills
   * part of each); burned_out: its modelled fuel has finished flaming; extinguished: put out by
   * crews (direct attack on the edge, mop-up inside the line). Simulated.
   */
  burning_ha: number;
  burned_out_ha: number;
  extinguished_ha: number;
  crews_on_scene: string[];
  crews_en_route: string[];
  /** Estimate with the crews already assigned; null = they never catch it within the forecast. */
  contained_in_min: number | null;
  /** Sending the n nearest free crews that can reach the fire by road, on top of those assigned. */
  options: { crews: string[]; contained_in_min: number | null; route: OptionRoute }[];
  /** Access classes with no road route to the fire (direct attack); their crews are not in `options`. */
  unreachable_classes: UnreachableClassObservation[];
  /** Zones this fire is forecast to reach (edge) within the forecast window. */
  threatens_zone_ids: string[];
  /**
   * Area, perimeter and growth are the fire solver's footprint for this fire (demo/fireField.ts):
   * perimeter is its edge facing ground that can still burn. The head fields are the solver's
   * Rothermel behaviour at the fire's leading front cell (its burned cell farthest from the
   * ignition that still faces unburned fuel): rate m/min, surface flame length ft, heading
   * degrees true, L:B, slope. When that cell torches or crowns no line holds it, so
   * contained_in_min is null whatever head_flame_ft says.
   */
  head_m_per_min: number;
  head_flame_ft: number;
  heading_deg: number;
  length_to_breadth: number;
  slope_pct: number;
  /** Line finished or under way at this fire's attack positions, metres (counts through the fire model, not containment_pct). */
  indirect_line_m: number;
  /** Where line ahead of this fire would go (predictive attack); [] unless burning. */
  attack_positions: AttackPositionObservation[];
  /** Response model (docs/response-model.md): tactic chosen by flame length (Hauling chart). */
  tactic: Tactic | null;
  /** Dispatch level the run card was sized by, or "structure" for a fire on developed ground. */
  dispatch_level: DispatchLevel | "structure" | null;
  /** Initial attack: in progress, contained (at 10 acres or less, no escalation), or failed. */
  ia_status: "in_progress" | "contained" | "failed" | null;
  /** Extended-attack stages ordered (0 = initial attack only). */
  escalation_stage: number;
  /** Minutes from ignition to the first unit or aircraft on scene; null before any arrives. */
  first_arrival_min: number | null;
  /** Minutes from ignition until the dispatch centre had the fire (call-in, answer, transfer, processing; response/report.ts). */
  reported_after_min: number | null;
  /** "studio" = the report minute was set in Simulation Studio (an assumption), not modelled. */
  reported_by: "911" | "camera" | "satellite" | "field_report" | "studio" | null;
  /** Why it took that long, plain language ("4 km from the nearest home, at night, found by an AI camera"). */
  reported_reason: string | null;
  /** Share of the fire's edge within reach of the ground units on scene, percent; null before any is there. */
  edge_in_reach_pct: number | null;
  /** Times a finished line failed its seeded holding test. */
  line_breaches: number;
  /** Line made by aircraft drops on this fire, metres. */
  air_line_m: number;
  /** Aircraft assigned to this fire. */
  aircraft: string[];
  /**
   * Recommendation only (boardResponse.ts initialAttackRecommendation; nothing is sent): the run
   * card for dispatch_level less what is already assigned or on order (still_needed), filled by
   * the closest free board units by expected arrival and the nearest available aircraft; unfilled
   * is what only order_resources can bring. null unless the fire is burning and reported.
   */
  recommended_initial_attack: InitialAttackObservation | null;
  /** Extended-attack stage due (initial attack failed or the fire grew past the stage size) and its sized orders; recommendation only, null before any. */
  extended_attack_due: { stage: number; orders: { resource: Orderable; count: number }[] } | null;
  /**
   * Containment strategies for this fire with the model's consequences (demo/strategyOptions.ts);
   * choose one with set_strategy and assign units with send_crew. [] unless burning and reported.
   */
  strategy_options: StrategyOptionObservation[];
  /** The strategy chosen for this fire (set_strategy), or null: none chosen yet (send_crew without a position is then direct attack). */
  strategy: ChosenStrategyObservation | null;
}

/**
 * One containment strategy for a fire (demo/strategyOptions.ts StrategyOption). Model output:
 * perimeter tactics forecast by the line race (model.ts containedIn with that tactic) for the
 * fewest of the nearest free units that contain the fire; line strategies (an attack position)
 * by line production against the forecast fire arrival. Minutes from now; metres; hectares; feet.
 */
export interface StrategyOptionObservation {
  /** set_strategy strategy_id: a tactic ("direct", "parallel", "indirect", "structure", "flank") or "line:<attack position id>". */
  id: string;
  name: string;
  kind: "perimeter" | "line";
  tactic: Tactic | null;
  /** send_crew position_id for its units (null = direct attack at the fire). */
  position_id: string | null;
  works: string;
  line_m: number;
  /** Flame the line faces, ft, and what the finished line holds, ft (null: no flame test, or no units). */
  flame_ft: number;
  holds_flame_ft: number | null;
  /** Units by kind it takes: already assigned plus `send`. */
  units_needed: Partial<Record<DemoApparatusKind, number>>;
  /** Free units to send for it now (send_crew with position_id), nearest first, each with its arrival in minutes. */
  send: { crew_id: string; kind: DemoApparatusKind; eta_min: number; route: OptionRoute }[];
  already_assigned: string[];
  /** contained: forecast to contain (contained_in_min); not_containable: not with the available units (not_containable_because); line_ahead: a line whose effect the fire model computes once built. */
  outcome: "contained" | "not_containable" | "line_ahead";
  contained_in_min: number | null;
  line_done_min: number | null;
  fire_reaches_line_min: number | null;
  line_ready_before_fire: boolean | null;
  /** Burned area at `burned_ha_at` (the solver's free-burn forecast to that minute: an upper bound). */
  burned_ha: number | null;
  burned_ha_at: string;
  /** Zones the fire reaches before containment (within the forecast when not contained), with their households still home. */
  zones_reached: string[];
  households_home_in_zones_reached: number;
  protects_zone_ids: string[];
  not_containable_because: string | null;
  /** Safety notes from the model: flame-length bands (PMS 465 Hauling chart), crown fire, fire at a line first, reach. */
  safety: string[];
}

/** The strategy chosen for a fire, with what the model predicted when it was chosen. */
export interface ChosenStrategyObservation {
  id: string;
  name: string;
  chosen_at_minute: number;
  by: "agent" | "you" | "board" | "studio";
  reason: string;
  /** The option's consequences at that minute, one line (model output). */
  predicted: string;
  /** Whether it is still among strategy_options now (an attack position can be replanned away). */
  still_offered: boolean;
}

/** Resource families of a run card (response/runCards.ts ResourceCounts). */
export interface ResourceCountsObservation {
  engines: number;
  hand_crews: number;
  dozers: number;
  air_attack: number;
  airtankers: number;
  helicopters: number;
}

export interface InitialAttackObservation {
  run_card: ResourceCountsObservation;
  still_needed: ResourceCountsObservation;
  /** Closest free board units for the card, by expected arrival (minutes; route "estimate" = straight-line assumption). */
  units: { crew_id: string; kind: string; eta_min: number; route: "road" | "estimate" }[];
  /** Nearest available aircraft (send with send_crew, position_id null): minutes until over the fire. */
  aircraft: { aircraft_id: string; kind: string; over_fire_min: number }[];
  unfilled: ResourceCountsObservation;
}

/**
 * One place to build line ahead of a fire, read from the fire solver's lookahead
 * (demo/attack.ts): `head_30` / `head_60` where the head is forecast 30 / 60 min from now,
 * `flank_left` / `flank_right` the forecast flanks 30 min from now, `zone_<zone id>` where the
 * fire first reaches that zone. The line runs across the forecast spread there, `line_m` long,
 * built outward from the point (lon, lat) by the units sent with send_crew position_id. Built
 * line is a barrier in the fire model: the forecast (zone ETAs, this list) already includes it.
 */
export interface AttackPositionObservation {
  id: string;
  kind: "head" | "flank_left" | "flank_right" | "zone";
  /** The line's anchor point, WGS84. */
  lon: number;
  lat: number;
  /** Minutes until fire reaches the point in the forecast (0 = there now; null = not within the lookahead). */
  fire_eta_min: number | null;
  /** Ground metres from the fire's open edge now to the point (how far ahead of the fire the line is); null without a solve. */
  from_fire_m: number | null;
  /** Zones the line stands in front of (geometric reading of the forecast). */
  protects_zone_ids: string[];
  /** LANDFIRE fuel model at the point. */
  fuel: string;
  /** The solver's spread rate toward the line there, m/min, and the flame facing it, ft (Byram). */
  spread_m_per_min: number;
  flame_ft: number;
  /** The fire torches or crowns there: no ground line holds it. */
  crowning: boolean;
  /** Bearing the fire is forecast to spread toward there, degrees true. */
  spread_toward_deg: number;
  line_m: number;
  line_built_m: number;
  crews_assigned: string[];
  /** Minutes until the line is finished with the crews assigned; null = none or not within 6 h. */
  line_done_min: number | null;
  /**
   * Sending the n free crews that start building first (on top of those assigned): last arrival
   * at the end of its road leg (turnout + drive), last start of work (arrival + the walk from
   * where it parks to the point, response/reach.ts; crews that would park out of reach of the
   * point are left out) and when the line would be done.
   */
  options: { crews: string[]; arrive_min: number; work_starts_min: number; line_done_min: number | null; route: OptionRoute }[];
  /** Access classes with no road route to the point; their crews are not in `options`. */
  unreachable_classes: UnreachableClassObservation[];
}

export interface CrewObservation {
  /** The snapshot's engine_id for a snapshot engine; C1, C2, D1 for the assumed units. */
  id: string;
  /** Apparatus type (studio/apparatus.ts GroundKind). */
  kind: DemoApparatusKind;
  /** Road-access class it drives as (unreachable_classes of fires and positions name these). */
  access_class: AccessClass;
  label: string;
  /** Home base name (snapshot station, CAL FIRE facility, or a synthetic station). */
  base: string;
  /** Home station id (snapshot station_id when from the snapshot). */
  station_id: string;
  /** Snapshot engine id (same as `id`), or null for a unit not in the snapshot. */
  engine_id: string | null;
  /** True for a unit the snapshot does not list (assumed hand crews and dozer; all units without a snapshot). */
  assumed: boolean;
  status: TeamStatus;
  fire_id: string | null;
  /** Minutes until on scene, while en route. */
  eta_min: number | null;
  /**
   * While `status` is "returning" (released: line finished, fire out, release_crew; driving
   * back to its home station on a road leg): minutes until it is back and available there;
   * null while its road home is not known yet. A returning crew can be sent again: options
   * time it from where it is.
   */
  eta_home_min: number | null;
  /** On its fire's fuel and slope (or where it stands, when free). */
  line_m_per_min: number;
  /** Longest head flame its line holds, ft (PMS 465 Hauling chart). */
  holds_flame_ft: number;
  /** How its current travel time was found, while en route or returning. */
  travel: TravelBasis | null;
  /** Attack position (FireObservation.attack_positions id) it is building line at; null = direct attack or free. */
  position_id: string | null;
  /** Department name (response/fleet.ts) and the tier it came through (closest, mutual_aid, state). */
  department: string;
  tier: Tier;
  /** Water left, percent of tank (engines); null for crews and dozers. */
  water_pct: number | null;
  /** Hours worked since its last rest (relieved at 16 h; rests half as long, work/rest 2:1). */
  work_h: number;
  /** Off-road reach on its fire: metres from where it parked to the edge, or to its line's anchor when position_id is set (null: not on scene or road access unknown). */
  parked_m: number | null;
  /** Ground metres from where it is now to its fire's open edge (null: not assigned to a burning fire, or no solve). */
  from_fire_m: number | null;
  /** hose (within hose reach), hand_line (hiked in), dozer (walked in), indirect (holds its road), out_of_reach. */
  work_mode: "hose" | "hand_line" | "dozer" | "indirect" | "out_of_reach" | null;
  /** Minutes until it starts building line (the hike or walk in). */
  working_in_min: number | null;
  /**
   * While en route: times fire has cut its road on this trip (model.ts rerouteTeam; each cut
   * stops it for a new road leg). The cut after MAX_FIRE_CUT_REROUTES (3) gives the trip up.
   */
  road_cuts: number;
  /**
   * Its last trip was given up because fire kept cutting its road: the fire, the attack position
   * (null = direct attack), the board minute and the number of cuts. The unit is free where it
   * stopped (status available, away from its station) until it is sent again; null otherwise.
   */
  blocked_by_fire: { fire_id: string; position_id: string | null; at_minute: number; cuts: number } | null;
}

export interface ZoneObservation {
  id: string;
  name: string;
  households: number;
  /** scheduled = an order with a later start_minute is pending (order.start_minute); ordered = an order is in effect. */
  status: "no_order" | "scheduled" | "ordered" | "overrun";
  /**
   * The zone's evacuation order (model.ts zoneOrderStatus): none, scheduled (departures start at
   * start_minute), leaving (in effect since start_minute), done (everyone it sends out has left and
   * arrived), overrun. Without an order only self-evacuees leave (self_evacuated, demo/selfEvacuation.ts).
   */
  order: {
    status: "none" | "scheduled" | "leaving" | "done" | "overrun";
    /** Board minute departures start (scheduled) or started (leaving, done); null otherwise. */
    start_minute: number | null;
    /** Scheduled only: minutes from now until start_minute. */
    starts_in_min: number | null;
    /** Destination of the scheduled order or of the order in effect. */
    destination_id: string | null;
    /**
     * Scheduled only: the scheduled destination's margin_min if departures start at start_minute
     * (its option's margin_min - starts_in_min; traffic as now). null without a core ETA.
     */
    margin_at_start_min: number | null;
  };
  /**
   * Departure flow an order puts on the road at its start, veh/h (order_compliance x households
   * with a vehicle / departure_mean_min x vehicles per household; it decays from there, to half in
   * about 64 min). Compare with the bottleneck capacity_veh_h of the zone's options. Simulated.
   */
  departure_peak_veh_h: number;
  /** This zone's departure flow at the last traffic step, veh/h (0 when nobody is leaving). */
  departure_flow_now_veh_h: number;
  households_home: number;
  households_en_route: number;
  households_out: number;
  households_caught: number;
  /** Carless households and how many are still home: they need transport (snapshot needs_transport_households, else ACS). */
  households_no_vehicle: number;
  households_no_vehicle_home: number;
  /** Where the counts come from: the resource snapshot, or the drill file (persons then unknown). */
  demand_source: "snapshot" | "drill";
  /**
   * Persons (snapshot occupants). null = unknown, never 0: `known_occupants` persons are known and
   * `unknown_occupant_households` households are not. people_* split the persons like the
   * households (home + en route + out + caught = occupants).
   */
  occupants: number | null;
  known_occupants: number;
  unknown_occupant_households: number;
  people_home: number | null;
  people_en_route: number | null;
  people_out: number | null;
  people_caught: number | null;
  /** Same as households_no_vehicle (the snapshot's name); their persons, and those still home. */
  needs_transport_households: number;
  needs_transport_occupants: number | null;
  needs_transport_occupants_home: number | null;
  fire_eta_min: number | null;
  fire_core_eta_min: number | null;
  /** fire_core_eta_min - departure_mean_min (as if ordered now); null without a core ETA. */
  order_slack_min: number | null;
  /** Destination of the order in effect; null when none is (a scheduled one is in `order`). */
  destination_id: string | null;
  /** Vehicles the zone evacuates with (snapshot evacuating_vehicles, else the drill file's) and how many are on the road now. */
  vehicles: number;
  vehicles_en_route: number;
  /**
   * Traffic margin of the zone's current destination when ordered, else of its option with the
   * largest margin: fire_core_eta_min - (departure_mean_min + clearance_min + congested_eta_min).
   * null without a core ETA.
   */
  margin_min: number | null;
  options: ZoneRouteObservation[];
  /**
   * Households with their own vehicle that have left on their own cues, no order needed
   * (self-evacuation, demo/selfEvacuation.ts; included in households_en_route / households_out).
   * Simulated.
   */
  self_evacuated: number;
  /** Strongest self-evacuation cue so far (fire forecast within 60 min, most neighbours gone, fire in the zone, fire within 500 m of the core); null = none. */
  self_evac_cue: "fire_approaching" | "neighbours_leaving" | "fire_in_zone" | "fire_near_core" | null;
}

/**
 * One evacuation route of a zone with the board's traffic model (demo/traffic.ts, model.ts
 * evacuationEstimate): BPR volume-delay on the drill roads' assumed capacities. Simulated.
 */
export interface ZoneRouteObservation {
  destination_id: string;
  name: string;
  safety: RouteOption["safety"];
  free_flow_min: number;
  /**
   * With the current loads plus this zone's own departure flow (as if ordered now, when not
   * ordered): BPR moving time plus the longest queue now waiting on the route.
   */
  congested_eta_min: number;
  /** Vehicles on the road now from zones whose route shares a road segment with this one. */
  vehicles_on_route_now: number;
  /** Slowest segment to pass everything committed to it (other zones' vehicles + this zone's). */
  bottleneck: { name: string; capacity_veh_h: number; committed_vehicles: number } | null;
  /** committed_vehicles / capacity, minutes. */
  clearance_min: number;
  margin_min: number | null;
  /** Latest board minute an order on this option can start with margin_min >= 0: minute + margin_min (traffic as now); null without a core ETA. */
  latest_start_minute: number | null;
  /**
   * Other zones with a scheduled order whose route shares a road segment with this option: start
   * minute and the vehicles that order will put on the road. Not counted in clearance_min.
   */
  scheduled_on_route: { zone_id: string; start_minute: number; vehicles: number }[];
  /** Vehicles already sent to this destination by all zones; capacity null = unknown (exits). */
  destination_load_vehicles: number;
  destination_capacity_veh: number | null;
}

export interface DemoObservation {
  clock: {
    minute: number;
    /** Mean departure delay after the cue, minutes (Camp, sourced). */
    departure_mean_min: number;
    order_compliance: number;
    forecast_min: number;
    /** order_evacuation start_minute may be at most minute + this (model.ts MAX_SCHEDULE_AHEAD_MINUTES). */
    max_schedule_ahead_min: number;
  };
  /** Where the board's fires come from (Simulation Studio only) and the run setting the conditions. */
  activity: string;
  /** The current hourly wind; `source` is its provenance plus how the fire model uses it. */
  wind: { from_deg: number; speed_m_s: number; evidence: string; source: string };
  /** Provenance labels of the model inputs. */
  inputs: { fuel: string; moisture: string; terrain: string; stations: string; travel: string; congestion: string; demand: string; response: string; strategy: string };
  fires: FireObservation[];
  crews: CrewObservation[];
  /** Zones that are threatened (fire ETA within the forecast) or already ordered, scheduled or overrun. */
  zones: ZoneObservation[];
  /** Evacuation traffic now (simulated): vehicles on the road and the busiest road segment. */
  traffic: {
    vehicles_on_road: number;
    /** delay_factor: BPR on the flow that passes (at most 1.15); queue_*: the point queue waiting there. */
    worst_segment: {
      name: string;
      flow_veh_h: number;
      capacity_veh_h: number;
      delay_factor: number;
      queue_vehicles: number;
      queue_delay_min: number;
    } | null;
  };
  /** Zones left out of `zones` because no fire threatens them. */
  quiet_zone_count: number;
  totals: {
    households: number;
    households_home_in_threatened_zones: number;
    households_caught_total: number;
    households_no_vehicle_at_risk: number;
    /** Persons on the board, known persons, households with unknown occupants (null totals = some unknown). */
    people: number | null;
    people_known: number;
    unknown_occupant_households: number;
    people_caught_total: number | null;
    needs_transport_people_at_risk: number | null;
    fires_burning: number;
    fires_out_total: number;
    /** Crews free at their station / driving back to it (both can be sent). */
    crews_available: number;
    crews_returning: number;
  };
  /** Resource picture from the response model (docs/response-model.md). */
  response: {
    auto_dispatch: boolean;
    auto_escalate: boolean;
    /** Level a new wildland fire would get now (fire danger: moisture scenario and wind). */
    dispatch_level_now: DispatchLevel;
    departments: { id: string; name: string; tier: Tier; engines: number; engines_available: number; keep_engines: number }[];
    /** Units at off-board stations that mutual-aid orders can still draw. */
    mutual_aid_pool_units: number;
    /** over_fire_in_min: minutes until an en-route aircraft is over its fire (null otherwise). */
    aircraft: { id: string; kind: string; base: string; status: string; fire_id: string | null; drops: number; over_fire_in_min: number | null }[];
    /** Orders not yet on the board; eta_min until they arrive (or retry, when unable_to_fill). */
    orders: { id: string; fire_id: string; resource: Orderable; tier: "mutual_aid" | "state"; status: "pending" | "unable_to_fill"; eta_min: number }[];
    /** What order_resources accepts. */
    orderable: { resource: Orderable; max_count: number }[];
    initial_attack: { fires: number; contained_in_ia: number; failed_ia: number; line_breaches: number; median_first_arrival_min: number | null };
  };
  /**
   * Why the page called (observation.ts wakeReasons): event reasons, a continuous or periodic
   * review, and last a "Since the last decision" line of what changed (model numbers). urgency:
   * urgent (board at 1× while deciding) or routine (continuous review; reviewing speed).
   */
  monitor: { woke_because: string[]; urgency: "urgent" | "routine" };
  previous: { minute: number; summary: string; rejected: string[] } | null;
  /** Run outcome metrics so far (demo/scoring.ts; model counts). Optional on the wire. */
  outcomes?: OutcomesObservation;
  /** Model-computed decision aids the commander chooses from (demo/decisionAids.ts). Optional on the wire. */
  decision_aids?: DecisionAidsObservation;
  /** Next-state forecast: fire reach per zone, road and destination loads if current orders proceed, dangers (demo/predict.ts). Optional on the wire. */
  predicted?: PredictedObservation;
  /** Joint evacuation plan balancing roads, destinations and the fire forecast (demo/evacBalance.ts). Optional on the wire. */
  evac_balance?: EvacBalanceObservation;
  /**
   * Drill road closures set by the controller (demo/roadClosures.ts): no unit or evacuation route
   * uses them; routes, options and ETAs already go around them. since_minute: board minute applied.
   */
  closed_roads?: { segment_id: string; name: string; since_minute: number; by: string }[];
  /**
   * Simulated 911 calls, civilian reports and FD / PD / EMS radio generated from the board each minute
   * (demo/simComms.ts; evidence "simulated", unverified: may repeat, be vague or wrong). recent: at most 25
   * from the last 30 board minutes, most severe kept first, newest first; open_injuries: waiting or with a
   * unit on the way; counts: messages per channel over the run.
   */
  sim_comms?: { recent: SimCommsItem[]; open_injuries: InjuryEvent[]; counts: Record<CommsChannel, number> };
  /** The live drill's incident picture (incidentPicture.ts); absent or null when the board runs without a live drill. */
  incident_picture?: IncidentPicture | null;
}

/** Where a picture line came from. real_phone / simulated_phone: an app participant; phone: a phone not in the participants list. */
export type PictureSource = "real_phone" | "simulated_phone" | "phone" | "historical_record" | "drill_fixture";

export interface PictureMessage {
  /** Live report id (confirm_report / dismiss_report take it). */
  id: string;
  kind: string;
  /** Drill minutes before `as_of_drill`. */
  min_ago: number | null;
  line: string;
  source: PictureSource;
  evidence_class: string;
  /** Live verification status (unverified, corroborated, responder_confirmed, confirmed). */
  status: string;
  road_id: string | null;
  zone_id: string | null;
}

/**
 * Bounded summary of the live drill (incidentPicture.ts, at most PICTURE_MAX_BYTES of JSON). Every
 * number is a count of live API records; nothing is modelled here except `stuck` and
 * `destinations_near_capacity`, which are traffic-twin estimates labelled simulated.
 */
export interface IncidentPicture {
  /** Drill (replay) time of the command poll, ISO UTC. */
  as_of_drill: string | null;
  evidence: string;
  /** 2018 911 / radio / rescue record (historical_record, de-identified) replayed to drill time. */
  calls: {
    window_min: number | null;
    in_window: { "911": number; radio: number; rescue: number };
    total_so_far: { "911": number; radio: number; rescue: number };
    by_zone: { zone_id: string; "911": number; radio: number; rescue: number; help: number; fire: number }[];
  };
  reports_open: { total: number; by_kind: Record<string, number>; by_status: Record<string, number> };
  /** Open need_help check-ins (type checkin, send_rescue target) and open help_needed reports. */
  help_requests: {
    open_total: number;
    items: {
      id: string;
      type: "checkin" | "report";
      zone_id: string | null;
      min_ago: number | null;
      source: PictureSource;
      status: string;
      assignee: string | null;
      task_id: string | null;
      note: string | null;
    }[];
  };
  messages: PictureMessage[];
  /** Open road_blocked / heavy_traffic reports, newest first. */
  road_reports: {
    id: string;
    kind: "road_blocked" | "heavy_traffic";
    road_id: string | null;
    road_name: string | null;
    severity: string | null;
    status: string;
    source: PictureSource;
    min_ago: number | null;
  }[];
  /** Live road state (blocked / slow); decided_by "controller" = closed by a controller. */
  roads: { road_id: string; name: string | null; status: string; decided_by: string | null; public: boolean; independent_parties: number; responder_reports: number }[];
  /** Phone check-ins per zone. */
  checkins: { zone_id: string; out: number; staying: number; need_help: number }[];
  /** Traffic twin people snapshot (simulated estimates); null when not loaded. */
  stuck: {
    evidence_class: "simulated";
    people_stuck: number;
    by_reason: Record<string, number>;
    groups: { id: string; people: number; vehicles: number; road: string | null; reason: string; wait_min: number }[];
  } | null;
  /** Destinations whose simulated arrivals are at or over 80% of their vehicle capacity. */
  destinations_near_capacity: { id: string; name: string; kind: string; capacity_veh: number; arrived_veh: number; full: boolean; evidence_class: "simulated" }[];
  /** Zones with no phone signal (comms_outage inject). */
  comms: { no_signal_zone_ids: string[] };
  /** App participants; null when not loaded. */
  participants: {
    real: { count: number; by_role: Record<string, number> };
    simulated: { count: number; evidence_class: "simulated" };
    real_phone_reports: (PictureMessage & { from_real_phone: true })[];
    flagged: { id: string; kind: string; role: string; zone_id: string | null; status: string; flags: string[] }[];
  } | null;
}

export type DemoOrder =
  /**
   * position_id: one of that fire's attack_positions ids (indirect line there), or null / absent = direct attack at the fire.
   * A crew holds one assignment: send_crew on a crew en route or on scene reassigns it (released
   * from its fire or line, then sent; the page logs both).
   */
  | { type: "send_crew"; crew_id: string; fire_id: string; position_id?: string | null; reason: string }
  | { type: "release_crew"; crew_id: string; reason: string }
  /**
   * start_minute: absolute whole board minute departures start (clock.minute .. clock.minute +
   * max_schedule_ahead_min); null / absent = now. Re-issuing for a scheduled zone replaces its
   * schedule; for a zone already leaving it redirects (now only).
   */
  | { type: "order_evacuation"; zone_id: string; destination_id: string; start_minute?: number | null; reason: string }
  /** Cancels a scheduled order that has not started (order.status "scheduled"). */
  | { type: "cancel_evacuation"; zone_id: string; reason: string }
  /** Extended-attack order through mutual aid or the state system (response/runCards.ts ORDERABLE, MAX_ORDER_COUNT). */
  | { type: "order_resources"; fire_id: string; resource: Orderable; count: number; reason: string }
  /**
   * The fire's containment strategy: strategy_id one of its strategy_options ids. A perimeter
   * strategy sets the tactic the board works the fire with; a line strategy names the attack
   * position its units build. Units go with send_crew (the option's position_id).
   */
  | { type: "set_strategy"; fire_id: string; strategy_id: string; reason: string };

/**
 * Live drill actions on ids from `incident_picture` (demo.py normalize_live_order). The page runs
 * them through the live API as the controller (liveOrders.ts): send_rescue -> the help request's
 * assist task (POST checkins/{id}/help assign, or POST incidents/{id}/tasks kind assist for a
 * help_needed report); close_road -> confirm the road's open road_blocked report; reopen_road ->
 * resolve its blocked reports; confirm_report / dismiss_report -> POST reports/{id}/triage.
 */
export type LiveOrder =
  | { type: "send_rescue"; help_id: string; reason: string }
  | { type: "close_road"; road_id: string; reason: string }
  | { type: "reopen_road"; road_id: string; reason: string }
  | { type: "confirm_report"; report_id: string; reason: string }
  | { type: "dismiss_report"; report_id: string; reason: string };

export type CommanderOrder = DemoOrder | LiveOrder;

export const LIVE_ORDER_TYPES: ReadonlySet<string> = new Set(["send_rescue", "close_road", "reopen_road", "confirm_report", "dismiss_report"]);

export const isLiveOrder = (order: CommanderOrder): order is LiveOrder => LIVE_ORDER_TYPES.has(order.type);

export type DecisionEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "orders";
      orders: CommanderOrder[];
      rejected: { order: unknown; reason: string }[];
      summary: string;
      model: string;
      evidence_class: "ai_decision";
      /** Tokens and cost of this call (dispatch/contracts.ts DecisionUsage; api/dispatch.py decision_usage). */
      usage?: DecisionUsage | null;
    }
  | { type: "error"; error: string; detail: string; usage?: DecisionUsage | null };

/**
 * Run outcome metrics so far (demo/scoring.ts runScore), for the commander to optimise. Caught =
 * still home when fire reached the zone core; caught_breakdown splits it by why (no vehicle, no
 * order, did not comply, ordered too late). homes_burned: households x the zone's share of
 * developed cells burned (homes_method). Persons null = unknown.
 */
export interface OutcomesObservation {
  caught_people: number | null;
  caught_households: number;
  caught_breakdown: { no_vehicle: number; no_order: number; stayed_despite_order: number; ordered_too_late: number };
  homes_burned: number;
  homes_reached_saved: number;
  homes_method: string;
  area_burned_ha: number;
  /** Simulated injuries so far (demo/injuries.ts injuryScore): people injured (any status), people who died of an injury no unit reached, people still waiting or being treated. Optional on the wire. */
  injured_people?: number;
  injury_deaths?: number;
  injured_open?: number;
}

/**
 * One zone of the evacuation schedule (demo/decisionAids.ts evacuationSchedule). eta_min: minutes
 * until fire reaches the core (eta_basis "core") or, with no core arrival in the lookahead, the
 * zone edge ("edge"), in the fire model's free-burn forecast (containment not assumed);
 * forecast_core_eta_min is the contained forecast (the zone's fire_core_eta_min). Absolute board
 * minutes: latest_safe_start_minute, recommended_start_minute. action: order_now (too_late or start
 * now), schedule / reschedule (order_evacuation with start_minute = recommended_start_minute),
 * scheduled_ok, leaving. expected_caught_*: expected households / persons home at that ETA.
 */
export interface EvacuationPlanObservation {
  zone_id: string;
  action: "order_now" | "schedule" | "leaving" | "scheduled_ok" | "reschedule";
  eta_min: number;
  eta_basis: "core" | "edge";
  forecast_core_eta_min: number | null;
  destination_id: string | null;
  clearance_min: number;
  congested_eta_min: number;
  latest_safe_start_minute: number;
  recommended_start_minute: number;
  too_late: boolean;
  over_capacity: boolean;
  households: number;
  people: number | null;
  expected_caught_households_if_ordered_now: number;
  expected_caught_people_if_ordered_now: number | null;
  expected_caught_people_at_recommended: number | null;
}

/** Per reported burning fire (demo/decisionAids.ts strategyAid): homes each strategy option burns, the recommendation, and the all-units package when nothing contains. */
export interface StrategyAidObservation {
  fire_id: string;
  /** Containable option burning the fewest homes; null when none contains (see all_units, also filled when overdue). */
  recommended_strategy_id: string | null;
  /** The option's units plus the run card's closest free units still needed. */
  recommended_send: { crew_id: string; position_id: string | null }[];
  /** The chosen strategy is past its predicted containment (or line done) by 15+ min and the fire still burns: all_units is filled. */
  overdue: boolean;
  options: { id: string; containable: boolean; homes_burned_forecast: number; by_min: number; households_in_zones_reached: number }[];
  all_units: {
    strategy_id: string;
    send: { crew_id: string; position_id: string | null; eta_min: number }[];
    aircraft: { aircraft_id: string; over_fire_min: number }[];
    order_resources: { resource: Orderable; count: number }[];
  } | null;
  idle_units: string[];
}

export interface DecisionAidsObservation {
  /** How the evacuation schedule is computed (assumptions named). */
  evacuation_method: string;
  evacuation: EvacuationPlanObservation[];
  strategy: StrategyAidObservation[];
}

/**
 * Next-state forecast (demo/predict.ts; simulated model output, never observed). Fire: the solver's
 * free-burn arrival field of the reported fires (line built so far included, containment not
 * assumed). Traffic: the zones leaving and scheduled now, on their current routes, with the
 * board's exponential departure curve, static segment loading and point queues (demo/traffic.ts).
 * Minutes are from now unless named *_minute. vc = departure demand / capacity (veh/h over veh/h).
 */
export interface PredictedObservation {
  method: string;
  /** The forecast horizons, minutes from now (30, 60, 120). */
  horizons_min: number[];
  /** Zones a reported fire reaches within the last horizon (or already burning in), soonest first. */
  zones: {
    zone_id: string;
    edge_eta_min: number | null;
    core_eta_min: number | null;
    /** Share of the zone's ground burned at now + each horizon, percent. */
    burned_pct: number[];
  }[];
  /** Road segments of the current and scheduled orders, most loaded or endangered first (bounded). */
  segments: {
    segment_id: string;
    name: string;
    capacity_veh_h: number;
    zone_ids: string[];
    /** Demand / capacity at now + each horizon. */
    vc: number[];
    peak_vc: number;
    peak_queue_vehicles: number;
    /** Queue delay at now + each horizon, minutes. */
    queue_delay_min: number[];
    /** Minutes until the fire forecast reaches the segment; null = not within the solver's lookahead. */
    fire_eta_min: number | null;
    /** Minutes until 90% of the committed traffic of its zones has passed it; null = nobody committed. */
    clears_in_min: number | null;
    /** Fire reaches it before its traffic clears. */
    danger: boolean;
  }[];
  destinations: {
    destination_id: string;
    name: string;
    /** Vehicles; null = unknown (no limit known). */
    capacity_veh: number | null;
    /** Vehicles arrived, on the way and still to leave on current and scheduled orders. */
    committed_vehicles: number;
    over_capacity: boolean;
  }[];
  /** One line per danger (model numbers): route segments cut before clearance, destinations over capacity. */
  dangers: string[];
}

/**
 * Joint evacuation plan (demo/evacBalance.ts; numerical optimizer, simulated): for every zone of
 * decision_aids.evacuation, a destination (one of the zone's route options) and a start minute,
 * minimising expected people caught at home + people on a route segment when the fire forecast
 * reaches it + destination overload + a small queue-time term, subject to shared segment capacity
 * (point queues), destination capacity and the free-burn fire forecast. Absolute board minutes:
 * start_minute. action: order_now / schedule / reschedule (order_evacuation with destination_id and
 * start_minute), keep (the scheduled order already matches), leaving (fixed: already ordered).
 */
export interface EvacBalanceObservation {
  method: string;
  zones: {
    zone_id: string;
    action: "order_now" | "schedule" | "reschedule" | "keep" | "leaving";
    destination_id: string | null;
    start_minute: number;
    /** Highest demand / capacity on its route over the plan window. */
    peak_vc: number;
    worst_segment: string | null;
    /** Expected at home when fire reaches the core (board catch rule); people null = unknown. */
    expected_caught_households: number;
    expected_caught_people: number | null;
    /** Vehicles departed but not past a route segment when the fire forecast reaches it. */
    exposed_vehicles: number;
    /** The fire forecast reaches a route segment before 90% of the zone's traffic has passed it. */
    fire_cuts_route: boolean;
    why: string;
  }[];
  /** The plan's totals, and the same zones all ordered now to decision_aids' destinations, for comparison. */
  totals: EvacBalanceTotals;
  all_now: EvacBalanceTotals;
}

export interface EvacBalanceTotals {
  expected_caught_people: number | null;
  expected_caught_households: number;
  exposed_vehicles: number;
  queue_vehicle_hours: number;
  peak_vc: number;
  zones_fire_cuts_route: number;
  destinations_over_capacity: number;
}
