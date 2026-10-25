/**
 * Wire contract between the /dispatch page and POST /api/dispatch/decide
 * (app/backend/api/dispatch.py). Change both sides and docs/adr/0014-dispatch-agent.md (amended
 * by docs/adr/0017-dispatch-anywhere.md, 0019-live-dispatch-monitor.md,
 * 0021-fire-path-scoped-evacuation.md, 0022-dispatch-fire-attack.md,
 * 0030-live-road-closures.md and 0031-dispatch-run-memory.md) together.
 *
 * The page calls the agent only when its live monitor (monitor.ts) finds a material change;
 * `monitor.woke_because` lists those reasons.
 *
 * Request body: `{ "observation": Observation, "session_id"?: string }`, JSON, at most 200 kB.
 * With `session_id` (a lowercase UUID per dispatcher run) the server journals each decision in
 * MongoDB Atlas and shows the agent earlier finished runs on the same `area.id`
 * (app/backend/api/dispatch_runs.py, docs/adr/0031-dispatch-run-memory.md).
 * Response: `application/x-ndjson`, one `DecisionEvent` per line, ending with exactly one
 * "orders" or "error" event. Non-2xx responses carry `{ error, detail }` JSON instead.
 *
 * Every number in an observation is simulator output or a scenario assumption. The agent
 * chooses among the options listed (zone exits from `exit_options`, units, tasks); it never
 * supplies a route, time or count. The server validates every order against the observation
 * and the page validates again against the live engine before applying it.
 *
 * Order slack (`order_slack_min`) and fire attack estimates (`fires[].out_eta_min`,
 * `attack_options`) are the simulator's estimates, never the agent's.
 *
 * Units: minutes are elapsed simulation minutes from scenario T+0; homes are synthetic
 * households (each with the zone's average vehicles per home); vehicles are counts; capacities
 * are vehicles per hour.
 */

import type { UnitStatus, UnitTask, ZoneImpact, ZoneStatus } from "./engine";

export const DECIDE_URL = "/api/dispatch/decide";
/** POST the simulator's outcome when a run ends: `RunOutcome` → 204 (404 with no journal). */
export const runOutcomeUrl = (sessionId: string) => `/api/dispatch/runs/${sessionId}/outcome`;

export interface RunOutcome {
  area_id: string;
  minute: number;
  horizon_minutes: number;
  /** True when the run reached the horizon; false when it was stopped early. */
  finished: boolean;
  totals: Observation["totals"];
  /** Households exposed by the horizon if nobody is ordered out (simulator baseline). */
  no_action_exposed: number | null;
}
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
  /**
   * Of homes_waiting, households that will not leave (grounded household behaviour, the
   * dispatch page's default; always 0 with the uniform departure spread).
   */
  homes_staying: number;
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
  /**
   * Simulator classification from the fire model's first contact: "burning" (fire is there),
   * "threatened" (within the forecast lookahead), "later" (after the lookahead, before the
   * horizon) or "outside" (not reached by the horizon). Outside zones cannot be ordered or
   * staged.
   */
  impact: ZoneImpact;
  /** Minutes until fire reaches the zone core (vehicles still there are exposed), same rules. */
  fire_core_eta_min: number | null;
  assigned_exit: string | null;
  /**
   * Minutes left to order the zone so every remaining household can be on the road before the
   * fire first reaches it (simulator estimate; negative = already late). Null when no fire
   * contact is modelled, or once the zone is cleared or overrun.
   */
  order_slack_min: number | null;
  /** Wave the zone left in (1 = ordered directly), or will leave in while staged. */
  wave: number | null;
  /** While staged: the zone it waits for, and the exit it will be sent to. */
  staged_after: string | null;
  staged_exit: string | null;
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
  /** Apparatus label, e.g. "Type 3 engine (4x4)" (studio/apparatus.ts). */
  apparatus: string;
  /** Road-access class it routes by (docs/suppression-data.md, R01-R12). */
  access_class: string;
  station_id: string;
  status: UnitStatus;
  task: UnitTask | null;
  zone_id: string | null;
  /** Fire the unit is attacking (task fire_attack). */
  fire_id: string | null;
  /** Minutes until a moving unit arrives where it is heading; null when not moving. */
  eta_min: number | null;
  /** Drive minutes from the unit's position to threatened zones (fire_eta_min not null). */
  drive_min_to: Record<string, number>;
  /**
   * Threatened zones and burning fires (by id) the unit cannot reach because of its road-access
   * class, with the blocking rule, e.g. "R05 paved grade too steep: grade 19% above 16% limit
   * for engine_t1_t2 (Foo Road)". Empty when nothing is blocked by class.
   */
  no_access: Record<string, string>;
}

/** How engines fight a fire (fireTactics.ts). */
export type FireTacticName = "direct" | "flank" | "indirect";

/**
 * A what-if the simulator solved: send these engines with this tactic (crews already on the
 * fire stay and switch to it). Every figure is from re-running the fire model.
 */
export interface TacticOptionObservation {
  tactic: FireTacticName;
  engines: number;
  /** The nearest units not already on this fire, fastest first. */
  unit_ids: string[];
  /** Minutes from now until it is out (direct) or held by its line; null = not by the horizon. */
  contained_in_min: number | null;
  /** All fires, by the horizon, with this option instead of the current fire fighting. */
  burned_ha_at_horizon: number;
  homes_reached_by_horizon: number;
  /** Line planned, and line that held against the fire (flank and indirect only), km. */
  line_km: number | null;
  line_held_km: number | null;
}

/**
 * One fire of the run, and whether engines can put it out by direct attack. Every number is
 * simulator output (fireAttack.ts); the containment estimate is deliberately rough.
 */
export interface FireObservation {
  id: string;
  name: string;
  /**
   * "merged": another fire reached its ignition point first. "out": put out by direct attack.
   * "held": stopped by a flank or indirect line.
   */
  status: "not_started" | "burning" | "out" | "held" | "merged";
  /** Minutes until it starts (not_started only). */
  starts_in_min: number | null;
  area_ha: number;
  /** Head flame at the ignition point, feet; null while it crowns there. */
  head_flame_ft: number | null;
  crowning: boolean;
  /** Started on developed ground (a structure fire): engines can attack its head directly. */
  structure_fire: boolean;
  /** Engines can fight it at all with some tactic. */
  attackable: boolean;
  /** Per tactic, why it cannot be used now, or null when it can. */
  tactics_blocked: Record<FireTacticName, string | null>;
  /** The tactic the engines on it are using, or null when none are. */
  tactic: FireTacticName | null;
  /** Units on scene or en route on fire_attack. */
  attacking: string[];
  /** Direct attack: grass-equivalent line built and still needed to ring the fire, metres. */
  line_built_m: number;
  line_needed_m: number;
  /** Direct attack: estimate with the units on it now; null when none, or not by the horizon. */
  out_eta_min: number | null;
  /** Minute it went out (status out). */
  out_minute: number | null;
  /** Flank or indirect: control line planned and built so far, km. */
  control_line_km: number;
  control_line_built_km: number;
  /** Flank or indirect: minutes from now until its line holds it, per the current run. */
  held_in_min: number | null;
  /** Minute its line held it (status held). */
  held_minute: number | null;
  tactic_options: TacticOptionObservation[];
}

export interface Observation {
  area: { id: string; name: string };
  clock: {
    minute: number;
    horizon_minutes: number;
    /** Next live-monitor check (the agent is called only when a check finds a change). */
    next_check_minute: number;
    /**
     * The clock keeps running while the agent decides: simulated minutes its orders are
     * expected to take to land (its last decision's delay). tactic_options already assume it.
     */
    decision_delay_min: number;
  };
  monitor: {
    check_interval_minutes: number;
    /** Minute of the previous agent decision; null at the first one. */
    previous_decision_minute: number | null;
    /** What changed since the previous decision, found by the deterministic monitor. */
    woke_because: string[];
  };
  fire: {
    burned_area_ha: number;
    /** Households the fire model reaches by the horizon if nobody is ordered out. */
    no_action_homes_exposed: number | null;
    wind_from_degrees: number;
    wind_speed_mph: number;
    upcoming_ignitions: { name: string; minute: number }[];
    /** Zones and households in the fire path (impact other than "outside") and outside it. */
    fire_path: { zones: number; homes: number; outside_zones: number; outside_homes: number };
    /** By the horizon with the fire fighting now in effect: compare with tactic_options. */
    current_outcome: { burned_ha_at_horizon: number; homes_reached_by_horizon: number };
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
  /**
   * Roads routing cannot use now. `planner_closed` are the planner's closures (an assumption,
   * closed at start or mid-run at `since_minute`); `fire_cut_*` are road segments the fire model
   * reaches within the routing lookahead. Every exit option already avoids both.
   */
  roads: {
    planner_closed: { road: string; bridge: boolean; since_minute: number }[];
    fire_cut_segments: number;
    /** Named roads among them, earliest cut first, at most 12. */
    fire_cut_roads: string[];
  };
  fires: FireObservation[];
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
      type: "stage_evacuation";
      zone_id: string;
      exit_id: string;
      after_zone_id: string;
      reason: string;
    }
  | {
      type: "dispatch_unit";
      unit_id: string;
      zone_id: string;
      task: "evacuation_support" | "structure_defense";
      reason: string;
    }
  | {
      type: "attack_fire";
      unit_id: string;
      fire_id: string;
      tactic: FireTacticName;
      reason: string;
    }
  | { type: "recall_unit"; unit_id: string; reason: string };

/**
 * Token usage of one decision call and its cost (api/dispatch.py decision_usage), on the final
 * "orders" line and on an "error" line sent after the model answered. Prompt size =
 * input_tokens (uncached) + cache_read_input_tokens + cache_creation_input_tokens
 * (= cache_write_5m + cache_write_1h). cost_usd is from the server's list-price table for
 * `model`; null when that model is not priced there.
 */
export interface DecisionUsage {
  model: string;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output_tokens: number;
  cost_usd: number | null;
}

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
      /** Earlier runs on these roads the agent was shown from the run journal (0 = none). */
      recalled_runs?: number;
      evidence_class: "ai_decision";
      usage?: DecisionUsage | null;
    }
  | { type: "error"; error: string; detail: string; usage?: DecisionUsage | null };
