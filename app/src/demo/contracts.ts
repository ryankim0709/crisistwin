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
 * POST /api/demo/decide: `{ observation: DemoObservation }` (at most 200 kB) ->
 * application/x-ndjson, `DecisionEvent` lines ending with one "orders" or "error" line, as
 * /api/dispatch/decide (dispatch/contracts.ts). Non-2xx responses carry `{ error, detail }`.
 * Orders: send_crew, release_crew, order_evacuation, and order_resources (fire_id, resource,
 * count; limits in response/runCards.ts ORDERABLE / MAX_ORDER_COUNT, mirrored in demo.py
 * ORDERABLE_RESOURCES). The response model behind the observation's `response` block and the
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
import type { RouteSegment } from "./traffic";
import type { DemoApparatusKind } from "./realism";
import type { AccessClass } from "../studio/apparatus";
import type { Tactic } from "../response/containment";
import type { Tier } from "../response/fleet";
import type { DispatchLevel, Orderable } from "../response/runCards";

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
  ignitions: { id: string; name: string; lon: number; lat: number; start_minute: number }[];
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
   * Sending the n nearest free crews that can reach the point by road (on top of those
   * assigned): last arrival (turnout + drive) and when the line would be done.
   */
  options: { crews: string[]; arrive_min: number; line_done_min: number | null; route: OptionRoute }[];
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
  /** Households leaving with no order, on the fire cue. */
  shadow_evacuating: boolean;
  fire_eta_min: number | null;
  fire_core_eta_min: number | null;
  /** fire_core_eta_min - departure_mean_min; null without a core ETA. */
  order_slack_min: number | null;
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
    shadow_share: number;
    forecast_min: number;
  };
  /** Where the board's fires come from (Simulation Studio only) and the run setting the conditions. */
  activity: string;
  /** The current hourly wind; `source` is its provenance plus how the fire model uses it. */
  wind: { from_deg: number; speed_m_s: number; evidence: string; source: string };
  /** Provenance labels of the model inputs. */
  inputs: { fuel: string; moisture: string; terrain: string; stations: string; travel: string; congestion: string; demand: string; response: string };
  fires: FireObservation[];
  crews: CrewObservation[];
  /** Zones that are threatened (fire ETA within the forecast) or already ordered/overrun. */
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
    aircraft: { id: string; kind: string; base: string; status: string; fire_id: string | null; drops: number }[];
    /** Orders not yet on the board; eta_min until they arrive (or retry, when unable_to_fill). */
    orders: { id: string; fire_id: string; resource: Orderable; tier: "mutual_aid" | "state"; status: "pending" | "unable_to_fill"; eta_min: number }[];
    /** What order_resources accepts. */
    orderable: { resource: Orderable; max_count: number }[];
    initial_attack: { fires: number; contained_in_ia: number; failed_ia: number; line_breaches: number; median_first_arrival_min: number | null };
  };
  monitor: { woke_because: string[] };
  previous: { minute: number; summary: string; rejected: string[] } | null;
}

export type DemoOrder =
  /**
   * position_id: one of that fire's attack_positions ids (indirect line there), or null / absent = direct attack at the fire.
   * A crew holds one assignment: send_crew on a crew en route or on scene reassigns it (released
   * from its fire or line, then sent; the page logs both).
   */
  | { type: "send_crew"; crew_id: string; fire_id: string; position_id?: string | null; reason: string }
  | { type: "release_crew"; crew_id: string; reason: string }
  | { type: "order_evacuation"; zone_id: string; destination_id: string; reason: string }
  /** Extended-attack order through mutual aid or the state system (response/runCards.ts ORDERABLE, MAX_ORDER_COUNT). */
  | { type: "order_resources"; fire_id: string; resource: Orderable; count: number; reason: string };

export type DecisionEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | {
      type: "orders";
      orders: DemoOrder[];
      rejected: { order: unknown; reason: string }[];
      summary: string;
      model: string;
      evidence_class: "ai_decision";
    }
  | { type: "error"; error: string; detail: string };
