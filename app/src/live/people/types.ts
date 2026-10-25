import type { IsoTime, LonLat } from "../types";

/** Why people count as stuck (docs/twin-api.md "People snapshot"). */
export type StuckReason = "long_queue" | "road_closed" | "fire" | "no_route" | "turned_back";

/** People by state. They add up to `population` (checked on the server). */
export interface PeopleCounts {
  /** Residents whose household has not left yet. */
  home: number;
  /** Residents of households with no vehicle; the model does not move them. */
  home_no_car: number;
  /** Residents staying put on purpose in the model (did not comply with the order), or with no road nearby. */
  staying: number;
  driving: number;
  /** Waiting in traffic for less than the long-queue threshold, or waiting to get on the road. */
  queued: number;
  stuck: number;
  out: number;
}

export interface PeopleZone extends PeopleCounts {
  id: string;
  name: string;
  coord: LonLat;
  population: number;
  vehicles: number;
  persons_per_vehicle: number;
  basis: "acs" | "assumed" | "estimated";
}

/** `edges.rows`: [edge_index, moving, queued, stuck, reason, veh, speed_kph, max_wait_min, free_flow_kph, length_m, line]. */
export type PeopleEdgeRow = [number, number, number, number, StuckReason | null, number, number, number, number, number, LonLat[]];

export interface PeoplePoint {
  coord: LonLat;
  people: number;
  veh: number;
  state: "queued" | "stuck";
  reason: StuckReason | null;
  text: string;
}

export interface StuckCluster {
  id: string;
  reason: StuckReason;
  reason_text: string;
  road: string | null;
  people: number;
  veh: number;
  coord: LonLat;
  edge_indexes: number[];
  longest_wait_min: number;
  /** Plain-language label, e.g. "900 stuck on Ridge Road: in traffic 15+ min". */
  label: string;
}

export interface PeopleDestination {
  id: string;
  name: string;
  kind: string;
  coord: LonLat;
  people: number;
  veh: number;
  last_10_min_people: number;
}

/** GET /api/live/incidents/{id}/people (docs/twin-api.md "People snapshot"). Every value is simulated. */
export interface PeopleSnapshot {
  kind: "crisistwin_live_people";
  schema_version: string;
  incident_id: string;
  evidence_class: "simulated";
  label: string;
  now: IsoTime;
  drill_replay_now: IsoTime;
  /** Drill seconds per wall second; 0 when the drill clock is paused or stopped. */
  drill_speed: number;
  long_queue_min: number;
  totals: {
    people: PeopleCounts & { population: number };
    vehicles: { total: number; home: number; driving: number; queued: number; stuck: number; out: number };
    conserved: boolean;
  };
  stuck_by_reason: Record<StuckReason, number>;
  zones: PeopleZone[];
  edges: { fields: string[]; rows: PeopleEdgeRow[] };
  edges_omitted: { edges: number; people: number };
  points: PeoplePoint[];
  stuck: StuckCluster[];
  destinations: PeopleDestination[];
  basis: {
    population: string;
    persons_per_vehicle: number;
    persons_per_vehicle_basis: string;
    persons_per_vehicle_check: string;
    zones_census: number;
    zones_assumed: number;
    /** sim.behavior preset the twin's demand uses (`historical`: everyone ordered leaves), or `custom`. */
    people_behavior: string;
  };
  limitations: string[];
}
