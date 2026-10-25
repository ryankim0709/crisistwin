/**
 * Shared contracts for the single-view scenario run (/run, app/src/oneview/) and the pieces it
 * composes: board run modes and score timeline (useCommandBoard), what the AI agent was shown
 * (useDemoAgent), simulated comms and injuries on the board (simComms.ts) and curated demo seeds.
 *
 * Units: `minute` is the board clock (whole minutes from scenario T+0, demo/model.ts Board.minute),
 * never wall time. Coordinates are [lon, lat] WGS84 degrees. Every simulated item carries
 * `evidence: "simulated"` (AGENTS.md: keep simulated and observed data distinct).
 */

import type { DemoObservation } from "./contracts";

export type LonLat = [number, number];

/** How the board runs. "baseline": the clock runs with nobody acting (no AI, no rule-based dispatch, no orders). "ai": the AI commander drives (today's /live behaviour). */
export type BoardRunMode = "baseline" | "ai";

/** One sample of the run's outcome, taken once per board minute (or less often on fast clocks). */
export interface ScorePoint {
  minute: number;
  /** demo/scoring.ts runScore().homesBurned. */
  homesBurned: number;
  /** People caught by fire (runScore casualties, whole run: casualtiesRunPeople, else households). */
  caughtPeople: number;
  /** Injured people so far (simComms injuries, any status but "none"); 0 before simComms lands. */
  injured: number;
  /** People who reached a destination (safe) so far. */
  peopleSafe: number;
  /** People still at home inside zones the fire is forecast to reach. */
  peopleAtRisk: number;
  /** Worst congestion on any evacuation road segment now, as volume/capacity (traffic.ts). */
  worstVolumeToCapacity: number;
  /** Burned area, hectares. */
  areaBurnedHa: number;
}

export interface RunTimeline {
  mode: BoardRunMode;
  /** Board seed the run used (useCommandBoard newSeed / restart(seed)). */
  seed: number;
  points: ScorePoint[];
}

/** What one AI call was shown, kept for the "What the agent sees" panel. */
export interface AgentInputSnapshot {
  /** Unique per call (e.g. `${seed}-${minute}-${n}`). */
  id: string;
  /** Board minute of the observation. */
  minute: number;
  /** Date.now() when the call was made (display only). */
  sentAtMs: number;
  urgency: "urgent" | "routine";
  /** Plain-language wake reasons (useDemoAgent wake.reasons). */
  reasons: string[];
  /** The exact observation posted to /api/demo/decide. */
  observation: DemoObservation;
  /** JSON size of the observation in bytes. */
  bytes: number;
}

/** Radio/phone channel of a simulated message. */
export type CommsChannel = "911" | "civilian_report" | "fd_radio" | "pd_radio" | "ems_radio";

export type CommsKind =
  | "fire_sighting"
  | "spot_fire"
  | "trapped"
  | "injury"
  | "medical"
  | "traffic"
  | "road_blocked"
  | "unit_status"
  | "evacuation_status"
  | "other";

/** A simulated 911 call, civilian report or responder radio line generated from board state. */
export interface SimCommsItem {
  /** "simc-<n>"; stable within a run. */
  id: string;
  minute: number;
  channel: CommsChannel;
  kind: CommsKind;
  /** Who is speaking, plain text: "Caller on Grizzly Peak Blvd", "Engine 21", "BPD unit 4". */
  from: string;
  /** The message as heard (short, plain language). */
  text: string;
  zoneId: string | null;
  coord: LonLat | null;
  severity: "info" | "urgent" | "life_threat";
  /** Linked injury when kind is injury/medical/trapped. */
  injuryId: string | null;
  evidence: "simulated";
}

export type InjuryCause = "burn" | "smoke" | "vehicle_crash" | "medical";
export type InjurySeverity = "minor" | "serious" | "critical";
export type InjuryStatus = "waiting" | "unit_en_route" | "treated" | "transported" | "died";

/** A simulated fire-related injury (or trapped party) needing a medical/rescue unit. */
export interface InjuryEvent {
  /** "inj-<n>"; send_rescue on the board takes this id. */
  id: string;
  minute: number;
  zoneId: string | null;
  coord: LonLat;
  people: number;
  cause: InjuryCause;
  severity: InjurySeverity;
  status: InjuryStatus;
  assignedUnitId: string | null;
  evidence: "simulated";
}

/** Board-side state of the comms/injury generator (Board.simComms, demo/simComms.ts). */
export interface SimCommsState {
  items: SimCommsItem[];
  injuries: InjuryEvent[];
  nextId: number;
}

/** A curated, low-variance demo scenario (app/src/oneview/demoSeeds.ts; docs/demo-seeds.md). */
export interface DemoSeedPreset {
  id: string;
  label: string;
  /** One line on what the run shows (from measured baseline runs, not guessed). */
  blurb: string;
  /** Board region id (e.g. a Berkeley Hills & Tilden board at 30 km). */
  regionId: string;
  /** Board seed (useCommandBoard restart(seed)). */
  seed: number;
  ignitions: { lon: number; lat: number; startMinute: number; reportMinute: number | null }[];
  wind: { speedMph: number; fromDeg: number };
  moisturePreset: "critical" | "dry" | "moderate" | "wet";
  horizonMinutes: number;
  /** Measured outcomes of the no-action run (eval harness --policy none), for the blurb and sanity checks. */
  measured: { homesBurned: number; caughtPeople: number; atMinute: number } | null;
}
