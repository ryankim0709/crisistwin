/**
 * Wire contract between the /dispatch page and POST /api/dispatch/decide
 * (app/backend/api/dispatch.py). Change both sides and docs/adr/0014-dispatch-agent.md (amended
 * by docs/adr/0016-dispatch-anywhere.md) together.
 *
 * Request body: `{ "observation": Observation }`, JSON, at most 200 kB.
 * Response: `application/x-ndjson`, one `DecisionEvent` per line, ending with exactly one
 * "orders" or "error" event. Non-2xx responses carry `{ error, detail }` JSON instead.
 *
 * Every number in an observation is simulator output or a scenario assumption. The agent
 * chooses among the options listed (zone exits from `exit_options`, units, tasks); it never
 * supplies a route, time or count. The server validates every order against the observation
 * and the page validates again against the live engine before applying it.
 *
 * Units: minutes are elapsed simulation minutes from scenario T+0; homes are synthetic
 * households (each with the zone's average vehicles per home); vehicles are counts; capacities
 * are vehicles per hour.
 */

import type { UnitStatus, UnitTask, ZoneStatus } from "./engine";

export const DECIDE_URL = "/api/dispatch/decide";
export const MAX_ORDERS_PER_DECISION = 20;

export interface ExitOption {
  exit_id: string;
  /** Free-flow drive time from the zone avoiding fire, minutes (rounded). */
  drive_min: number;
  /** Smallest capacity on that route, vehicles/hour. */
  bottleneck_vph: number;
}

export interface ZoneObservation {
  id: string;
  name: string;
  status: ZoneStatus;
  /** Order in which the zone was told to leave (1 = first); null with no order. */
  order_rank: number | null;
  homes_total: number;
  /** Ordered households still at home or queued at the loading point. */
  homes_waiting: number;
  homes_en_route: number;
  homes_out: number;
  /** Households the modelled fire reached before they got out. */
  homes_exposed: number;
  /** Vehicles not yet driving (at home or queued), for capacity reasoning. */
  vehicles_waiting: number;
  /**
   * Minutes until the fire model reaches the zone edge, when within the forecast lookahead;
   * 0 when fire is already in the zone; null when not forecast within the lookahead.
   */
  fire_eta_min: number | null;
  /** Minutes until fire reaches the zone core (vehicles still there are exposed), same rules. */
  fire_core_eta_min: number | null;
  assigned_exit: string | null;
  /**
   * Minutes for `vehicles_waiting` to enter the assigned route at its bottleneck capacity,
   * ignoring departure spread and other zones sharing the road; null with no usable route.
   */
  queue_clear_min: number | null;
  route_blocked: boolean;
  /** Up to 3 reachable exits, fastest first. Empty when no exit is reachable. */
  exit_options: ExitOption[];
  units_on_scene: string[];
}

export interface UnitObservation {
  id: string;
  station_id: string;
  status: UnitStatus;
  task: UnitTask | null;
  zone_id: string | null;
  /** Minutes until a moving unit arrives where it is heading; null when not moving. */
  eta_min: number | null;
  /** Drive minutes from the unit's position to threatened zones (fire_eta_min not null). */
  drive_min_to: Record<string, number>;
}

export interface Observation {
  area: { id: string; name: string };
  clock: {
    minute: number;
    horizon_minutes: number;
    next_regular_decision_minute: number;
  };
  fire: {
    burned_area_ha: number;
    /** Households the fire model reaches by the horizon if nobody is ordered out. */
    no_action_homes_exposed: number | null;
    wind_from_degrees: number;
    wind_speed_mph: number;
    upcoming_ignitions: { name: string; minute: number }[];
    evidence_class: "simulated";
  };
  /** Household counts. */
  totals: {
    homes: number;
    not_ordered: number;
    waiting: number;
    en_route: number;
    out: number;
    exposed: number;
  };
  zones: ZoneObservation[];
  exits: { id: string; name: string }[];
  units: UnitObservation[];
  /** Alerts since the previous decision, oldest first. */
  alerts: { minute: number; type: string; text: string }[];
  /** Outcomes of the previous decision's orders. */
  previous_outcomes: { order: string; accepted: boolean; note: string }[];
  /** The agent's previous situation summary, for continuity. Empty at T+0. */
  previous_summary: string;
  model_notes: string[];
}

export type WireOrder =
  | { type: "order_evacuation"; zone_id: string; exit_id: string; reason: string }
  | {
      type: "dispatch_unit";
      unit_id: string;
      zone_id: string;
      task: "evacuation_support" | "structure_defense";
      reason: string;
    }
  | { type: "recall_unit"; unit_id: string; reason: string };

export type DecisionEvent =
  /** Streamed summary of the model's reasoning (adaptive thinking, summarized). */
  | { type: "thinking"; text: string }
  /** Streamed situation assessment the agent writes before ordering. */
  | { type: "text"; text: string }
  | {
      type: "orders";
      orders: WireOrder[];
      /** Orders the server dropped, with the reason. */
      rejected: { order: unknown; reason: string }[];
      /** One- or two-sentence summary the page sends back as `previous_summary`. */
      summary: string;
      model: string;
      evidence_class: "ai_decision";
    }
  | { type: "error"; error: string; detail: string };
