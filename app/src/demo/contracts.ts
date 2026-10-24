/**
 * Wire contract between the /demo page and app/backend/api/demo.py (+ demo_realism.py). Change
 * both sides and docs/command-demo-realism.md together.
 *
 * POST /api/demo/routes: `{ fires: LonLat[][] }` (closed rings of the fires that are not out,
 * at most 60, each 4..200 points) -> `RoutesResponse`. Routes come from the live planner's
 * router over the Camp drill roads (livecore.routing), avoiding the posted fire areas.
 *
 * POST /api/demo/decide: `{ observation: DemoObservation }` (at most 200 kB) ->
 * application/x-ndjson, `DecisionEvent` lines ending with one "orders" or "error" line, as
 * /api/dispatch/decide (dispatch/contracts.ts). Non-2xx responses carry `{ error, detail }`.
 *
 * POST /api/demo/crew_routes: `CrewRoutesRequest` -> `CrewRoutesResponse`. Road travel for
 * firefighting units over the drill roads their apparatus class may use (livecore.inbound).
 * GET /api/demo/wind?mode=historical_replay|climatology_percentile -> `WindResponse`.
 * GET /api/demo/environment -> `EnvironmentResponse` (Camp terrain grid, carless households).
 *
 * Every number in an observation is simulator output (demo/model.ts), sourced data
 * (demo/realism.ts) or a labelled assumption; the agent only chooses among the ids it lists.
 * The server validates orders against the observation; the page validates again when it
 * applies them.
 *
 * Units: minutes are simulation minutes from T+0; metres; hectares; WGS84 [lon, lat]; wind
 * m/s, direction the wind blows FROM in degrees true; flame lengths feet.
 */

import type { LonLat } from "../live/types";
import type { RouteOption, TeamStatus, FireSource, FireStatus, TravelBasis } from "./model";
import type { DemoApparatusKind } from "./realism";

export const ROUTES_URL = "/api/demo/routes";
export const DECIDE_URL = "/api/demo/decide";
export const CREW_ROUTES_URL = "/api/demo/crew_routes";
export const WIND_URL = "/api/demo/wind";
export const ENVIRONMENT_URL = "/api/demo/environment";

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
}

export interface CrewRoutesResponse {
  routes: CrewRoute[];
  /** Always "not_modelled": the demo's households are not in the traffic twin. */
  congestion: "not_modelled";
  evidence_class: "simulated";
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
  /** Camp USGS 3DEP slope on a regular grid (row 0 = south), or null when unavailable. */
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
  households_no_vehicle: Record<string, number>;
  households_no_vehicle_source: string | null;
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
  inputs: { fuel: string; moisture: string; terrain: string; stations: string; travel: string; congestion: string };
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
  monitor: { woke_because: string[] };
  previous: { minute: number; summary: string; rejected: string[] } | null;
}

export type DemoOrder =
  | { type: "send_crew"; crew_id: string; fire_id: string; reason: string }
  | { type: "release_crew"; crew_id: string; reason: string }
  | { type: "order_evacuation"; zone_id: string; destination_id: string; reason: string };

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
