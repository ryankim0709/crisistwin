/**
 * Wire contract between the /demo page and app/backend/api/demo.py. Change both sides and
 * docs/adr/0047-command-demo.md together.
 *
 * POST /api/demo/routes: `{ fires: LonLat[][] }` (closed rings of the fires that are not out,
 * at most 60, each 4..200 points) -> `RoutesResponse`. Routes come from the live planner's
 * router over the Camp drill roads (livecore.routing), avoiding the posted fire areas.
 *
 * POST /api/demo/decide: `{ observation: DemoObservation }` (at most 200 kB) ->
 * application/x-ndjson, `DecisionEvent` lines ending with one "orders" or "error" line, as
 * /api/dispatch/decide (dispatch/contracts.ts). Non-2xx responses carry `{ error, detail }`.
 *
 * Every number in an observation is simulator output (demo/model.ts) or a scenario
 * assumption; the agent only chooses among the ids it lists. The server validates orders
 * against the observation; the page validates again when it applies them.
 *
 * Units: minutes are simulation minutes from T+0; metres; hectares; WGS84 [lon, lat].
 */

import type { LonLat } from "../live/types";
import type { RouteOption, TeamStatus, FireSource, FireStatus } from "./model";

export const ROUTES_URL = "/api/demo/routes";
export const DECIDE_URL = "/api/demo/decide";

export interface RoutesResponse {
  zones: { zone_id: string; options: RouteOption[] }[];
  evidence_class: "simulated";
}

export interface RoutesRequest {
  fires: LonLat[][];
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
}

export interface CrewObservation {
  id: string;
  status: TeamStatus;
  fire_id: string | null;
  /** Minutes until on scene, while en route. */
  eta_min: number | null;
  line_m_per_min: number;
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
  fire_eta_min: number | null;
  fire_core_eta_min: number | null;
  /** fire_core_eta_min - departure_spread_min; null without a core ETA. */
  order_slack_min: number | null;
  destination_id: string | null;
  options: { destination_id: string; name: string; eta_min: number; safety: RouteOption["safety"] }[];
}

export interface DemoObservation {
  clock: { minute: number; departure_spread_min: number; forecast_min: number };
  activity: string;
  wind: { from_deg: number; length_to_breadth: number };
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
