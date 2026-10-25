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
 *
 * POST /api/demo/decide: `{ observation: DemoObservation }` (at most 200 kB) ->
 * application/x-ndjson, `DecisionEvent` lines ending with one "orders" or "error" line, as
 * /api/dispatch/decide (dispatch/contracts.ts). Non-2xx responses carry `{ error, detail }`.
 * Orders: send_crew, release_crew, order_evacuation, order_resources (fire_id, resource,
 * count; limits in response/runCards.ts ORDERABLE / MAX_ORDER_COUNT, mirrored in demo.py
 * ORDERABLE_RESOURCES), and the live drill actions of `LiveOrder` (ids from the observation's
 * `incident_picture`, the live drill's bounded picture: incidentPicture.ts). The response model behind the observation's `response` block and the
 * per-fire tactic fields is docs/response-model.md.
 *
 * POST /api/demo/crew_routes: `CrewRoutesRequest` -> `CrewRoutesResponse`. Road travel for
 * firefighting units over the drill roads their apparatus class may use (livecore.inbound), with
 * OSM surface/width/weight tags and DEM grade per road (docs/command-demo-realism.md "Road access").
 * GET /api/demo/road_access -> `RoadAccessResponse`: drill roads closed to each class.
 * GET /api/demo/wind?mode=historical_replay|climatology_percentile -> `WindResponse`.
 * GET /api/demo/environment -> `EnvironmentResponse` (drill centre, Camp terrain grid, carless households, package fire stations).
 * Wind is searched from the incident's centre.
 *
 * Every number in an observation is simulator output (demo/model.ts), sourced data
 * (demo/realism.ts) or a labelled assumption; the agent only chooses among the ids it lists.
 * The server validates orders against the observation; the page validates again when it
 * applies them.
 *
 * Units: minutes are simulation minutes from T+0; metres; hectares; WGS84 [lon, lat]; wind
 * m/s, direction the wind blows FROM in degrees true; flame lengths feet.
 */

import { DEFAULT_INCIDENT_ID } from "../live/api";
import type { LonLat } from "../live/types";
import type { RouteOption, TeamStatus, FireSource, FireStatus, TravelBasis } from "./model";
import type { DemoApparatusKind } from "./realism";
import type { Tactic } from "../response/containment";
import type { Tier } from "../response/fleet";
import type { DispatchLevel, Orderable } from "../response/runCards";

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

export interface RoutesResponse {
  zones: { zone_id: string; options: RouteOption[] }[];
  evidence_class: "simulated";
}

export interface RoutesRequest {
  fires: LonLat[][];
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
  crews_on_scene: string[];
  crews_en_route: string[];
  /** Estimate with the crews already assigned; null = they never catch it within the forecast. */
  contained_in_min: number | null;
  /** Sending the n nearest free crews on top of those assigned. */
  options: { crews: string[]; contained_in_min: number | null }[];
  /** Zones this fire is forecast to reach (edge) within the forecast window. */
  threatens_zone_ids: string[];
  /** Rothermel at the head now: rate m/min, flame length ft, heading degrees true, L:B. */
  head_m_per_min: number;
  head_flame_ft: number;
  heading_deg: number;
  length_to_breadth: number;
  slope_pct: number;
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
  reported_by: "911" | "camera" | "satellite" | "field_report" | null;
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
}

export interface CrewObservation {
  id: string;
  /** Apparatus type (studio/apparatus.ts GroundKind). */
  kind: DemoApparatusKind;
  label: string;
  /** Home base name (CAL FIRE facility, or a synthetic station). */
  base: string;
  status: TeamStatus;
  fire_id: string | null;
  /** Minutes until on scene, while en route. */
  eta_min: number | null;
  /** On its fire's fuel and slope (or where it stands, when free). */
  line_m_per_min: number;
  /** Longest head flame its line holds, ft (PMS 465 Hauling chart). */
  holds_flame_ft: number;
  /** How its current travel time was found, while en route. */
  travel: TravelBasis | null;
  /** Department name (response/fleet.ts) and the tier it came through (closest, mutual_aid, state). */
  department: string;
  tier: Tier;
  /** Water left, percent of tank (engines); null for crews and dozers. */
  water_pct: number | null;
  /** Hours worked since its last rest (relieved at 16 h; rests half as long, work/rest 2:1). */
  work_h: number;
  /** Off-road reach on its fire: metres from where it parked to the edge (null: not on scene or road access unknown). */
  parked_m: number | null;
  /** hose (within hose reach), hand_line (hiked in), dozer (walked in), out_of_reach. */
  work_mode: "hose" | "hand_line" | "dozer" | "out_of_reach" | null;
  /** Minutes until it starts building line (the hike or walk in). */
  working_in_min: number | null;
}

export interface ZoneObservation {
  id: string;
  name: string;
  households: number;
  status: "no_order" | "ordered" | "overrun";
  households_home: number;
  households_en_route: number;
  households_out: number;
  households_caught: number;
  /** Carless households (ACS) and how many are still home: they need transport. */
  households_no_vehicle: number;
  households_no_vehicle_home: number;
  /** Households leaving with no order, on the fire cue. */
  shadow_evacuating: boolean;
  fire_eta_min: number | null;
  fire_core_eta_min: number | null;
  /** fire_core_eta_min - departure_mean_min; null without a core ETA. */
  order_slack_min: number | null;
  destination_id: string | null;
  options: { destination_id: string; name: string; eta_min: number; safety: RouteOption["safety"] }[];
}

export interface DemoObservation {
  clock: {
    minute: number;
    /** Mean departure delay after the cue, minutes (Camp, sourced). */
    departure_mean_min: number;
    order_compliance: number;
    shadow_share: number;
    forecast_min: number;
  };
  activity: string;
  wind: { from_deg: number; speed_m_s: number; evidence: string; source: string };
  /** Provenance labels of the model inputs. */
  inputs: { fuel: string; moisture: string; terrain: string; stations: string; travel: string; congestion: string; response: string };
  fires: FireObservation[];
  crews: CrewObservation[];
  /** Zones that are threatened (fire ETA within the forecast) or already ordered/overrun. */
  zones: ZoneObservation[];
  /** Zones left out of `zones` because no fire threatens them. */
  quiet_zone_count: number;
  totals: {
    households: number;
    households_home_in_threatened_zones: number;
    households_caught_total: number;
    households_no_vehicle_at_risk: number;
    fires_burning: number;
    fires_out_total: number;
    crews_available: number;
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
    aircraft: { id: string; kind: string; base: string; status: string; fire_id: string | null; drops: number }[];
    /** Orders not yet on the board; eta_min until they arrive (or retry, when unable_to_fill). */
    orders: { id: string; fire_id: string; resource: Orderable; tier: "mutual_aid" | "state"; status: "pending" | "unable_to_fill"; eta_min: number }[];
    /** What order_resources accepts. */
    orderable: { resource: Orderable; max_count: number }[];
    initial_attack: { fires: number; contained_in_ia: number; failed_ia: number; line_breaches: number; median_first_arrival_min: number | null };
  };
  monitor: { woke_because: string[] };
  previous: { minute: number; summary: string; rejected: string[] } | null;
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
  | { type: "send_crew"; crew_id: string; fire_id: string; reason: string }
  | { type: "release_crew"; crew_id: string; reason: string }
  | { type: "order_evacuation"; zone_id: string; destination_id: string; reason: string }
  /** Extended-attack order through mutual aid or the state system (response/runCards.ts ORDERABLE, MAX_ORDER_COUNT). */
  | { type: "order_resources"; fire_id: string; resource: Orderable; count: number; reason: string };

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
    }
  | { type: "error"; error: string; detail: string };
