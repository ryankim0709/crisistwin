/**
 * Command board (Live command): a continuously running fire board on the active drill's zones
 * (Camp by default). The board starts no fires itself: fires arrive from Simulation Studio
 * (ingestStudioFire, one publish = the scenario's ignitions, wind and fuel moisture); firefighting
 * units fight them and households evacuate, on a simulation clock with no end state (24/7
 * monitoring). Pure: no React, network or LLM; deterministic, so the same environment, the same
 * Studio fires ingested at the same board minutes and the same orders replay the same run. See docs/adr/0047-command-demo.md and,
 * for what is modelled and what is assumed, docs/command-demo-realism.md.
 *
 * Model, shown in the UI:
 * - Fire spread is the simulator's cell solver, the same one /fire and Simulation Studio run
 *   (fire/spread.ts simulateScheduledFireSpread: Rothermel 1972 surface spread with crown fire,
 *   ember spotting and structure-to-structure spread at their defaults) on the drill's LANDFIRE
 *   landscape, with every board fire as a source. demo/fireField.ts holds the solve and what is
 *   read back from it; the page runs it off the main thread (useFireSolver) and the board clock
 *   holds while a required solve is pending (fireSolveDue), so a run does not depend on machine
 *   speed. A solve is required for a new fire, a contained or closed fire, a change of wind or
 *   fuel moisture (a newer Studio fire), and when the lookahead runs short; each continues from the
 *   burned state at that minute (spread.ts ResumeFrom). Wind and moisture are the newest Studio
 *   fire's (constant, as Studio runs them; StudioConditions).
 * - Containment race (as studio/initialAttack.ts and dispatch/fireAttack.ts): units on scene
 *   build line at their sourced production rate for the fuel and slope (realism.ts
 *   lineMetersPerMinute). The fire is contained when the line reaches its perimeter (the
 *   solver footprint's edge facing ground that can still burn, fireField.ts) AND the head flame
 *   at its leading front cell is within the longest flame an on-scene unit's line holds (PMS 465
 *   Hauling chart: 4 ft hand tools, 8 ft engines and dozers) and that cell is not crowning. Until
 *   then the line is flank line and cannot exceed the perimeter. Mop-up MOPUP_MINUTES, then the
 *   fire is out. A contained fire stops spreading in the solver from its containment minute.
 * - Predictive (indirect) attack (attack.ts): each burning fire lists attack positions read from
 *   the solver's lookahead (where the head is forecast at +30/+60 min, its flanks, where it first
 *   reaches a zone), each with a line across the forecast spread. A unit sent to a position
 *   drives there and builds that line outward from its anchor at its sourced rate; built line
 *   enters the solver as control lines (spread.ts ControlLines) in LINE_RESOLVE_CHUNK_M chunks,
 *   each a re-solve from the burned ground, so the forecast and the actual spread respect it. A
 *   fire with line is contained when the solver, with that line, forecasts no further spread.
 * - Fires come only from Simulation Studio: each ignition of a published scenario starts at
 *   the ingest minute + its Studio start minute. No scheduled, random or hand-placed fires; a
 *   fire_seen field report only joins a fire already there (joinFieldReport). Spot fires come
 *   from the solver's ember spotting and belong to the fire that threw them. At most
 *   MAX_ACTIVE_FIRES burn or smoulder at once.
 * - Households come from the drill's scenario resource snapshot (docs/scenario-snapshots.md,
 *   matched by zone id): households, occupants (persons), evacuating vehicles and the carless
 *   households that need transport. Without a snapshot (or a zone it does not list) the drill
 *   file's households and vehicles and the environment's carless counts are used, and persons
 *   are unknown. Carless households cannot drive out and stay home. Households
 *   with a vehicle leave on an evacuation order (ORDER_COMPLIANCE of them) or, with no order,
 *   on the fire cue when fire touches the zone (SHADOW_SHARE of them), each with an
 *   exponential departure delay of mean DEPARTURE_MEAN_MINUTES (Camp, Grajdura 2022), then
 *   drive their route, taking the zone's evacuating vehicles / households with a vehicle each.
 *   Households home when fire reaches the zone core are caught. Persons follow their
 *   households (zonePeople); households and persons are conserved (checkBoardInvariants).
 *   "Touches" and "reaches" read the solver's arrival field over the zone's cells and at
 *   its core cell.
 * - Evacuation traffic (demo/traffic.ts): each whole minute the vehicles leaving every zone load
 *   their route's road segments; segment travel time follows the BPR volume-delay function on
 *   the drill roads' assumed capacities, so zones sharing a road slow each other. A cohort's
 *   arrival is fixed when it departs (departure + congested route time then, first in first out).
 * - Units: one per engine the snapshot lists as available at T+0, at its station, id = its
 *   engine_id (committed and out-of-service engines stay on the station records, not
 *   dispatchable), plus the assumed hand crews and dozer (realism.ts ASSUMED_EXTRA_UNITS,
 *   labelled as not in the snapshot). Without a snapshot: the assumed ROSTER at real CAL FIRE
 *   stations (GET /api/suppression/bases), the package's OSM stations or synthetic stations,
 *   labelled NO_SNAPSHOT_LABEL. A unit holds one assignment at a time: sending a busy unit
 *   reassigns it (release, then send; both logged). Units drive the road network for their apparatus class
 *   (POST /api/demo/crew_routes) after their turnout, always along a road line. A unit whose
 *   road route is not known yet waits at its base (travel "pending") and sets off, timed from
 *   its dispatch, when it arrives; one with no road route is released with the router's reason.
 * - A zone that was ordered out or overrun reopens once no fire has touched it for
 *   REOPEN_MINUTES and none is forecast to; caught households stay in the running total.
 *   Fires that are out leave the board after OUT_KEEP_MINUTES (their burned ground stays).
 *
 * Units: minutes are simulation minutes from T+0; distances metres; areas hectares on output;
 * flame lengths feet (the Hauling chart's unit).
 */

import { fuelLabel } from "../fire/fuelModels";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { cellAt, type FuelMoisture } from "../fire/spread";
import type { LonLat } from "../live/types";
import type { EngineKind, EngineStatus, ScenarioSnapshot, SnapshotBasis, SnapshotTotals, SnapshotZone } from "../live/scenarioSnapshot";
import {
  LOOKAHEAD_MINUTES,
  MAX_SOLVER_SOURCES,
  NO_FRONT,
  areaAt,
  fireGeometry,
  noSpreadReason,
  perimeterAt,
  rasterZone,
  zoneArrivals,
  type BuiltLineCells,
  type FireSolveRequest,
  type FireSolveResult,
  type FrontBehaviour,
  type SolveSource,
  type ZoneArrivals,
  type ZoneCells,
} from "./fireField";
import type { StudioFire } from "./contracts";
import type { AccessClass } from "../studio/apparatus";
import {
  LINE_RESOLVE_CHUNK_M,
  POSITION_REPLAN_MINUTES,
  builtExtent,
  planAttackPositions,
  rasterLine,
  type AttackPlan,
  type LineCells,
} from "./attack";
import {
  ASSUMED_EXTRA_UNITS,
  ASSUMED_UNIT_LABEL,
  DEPARTURE_MEAN_MINUTES,
  FALLBACK_CIRCUITY,
  FALLBACK_SPEED_KMH,
  KIND_PREFIX,
  METERS_PER_SECOND_PER_MPH,
  NO_SNAPSHOT_LABEL,
  ORDER_COMPLIANCE,
  ROSTER,
  SHADOW_SHARE,
  SNAPSHOT_ENGINE_KIND,
  departedShare,
  accessClassOf,
  holdsFlameFeet,
  kindShort,
  lineMetersPerMinute,
  turnoutMinutes,
  moistureOf,
  windAt,
  type DemoApparatusKind,
  type MoistureId,
  type SpreadInputs,
  type WindNow,
} from "./realism";
import {
  TRAFFIC_STEP_MINUTES,
  alongLine,
  arrivedBy,
  bprFactor,
  congestedMinutes,
  emptyTrips,
  freeFlowMinutes,
  queueDelayMinutes,
  recordCohort,
  type RouteSegment,
  type Trips,
} from "./traffic";

/** Mean departure delay after the cue (Camp, sourced). The observation's departure figure. */
export const DEPARTURE_SPREAD_MINUTES = DEPARTURE_MEAN_MINUTES;

export const MOPUP_MINUTES = 10;
export const OUT_KEEP_MINUTES = 30;
export const REOPEN_MINUTES = 90;
/** Forecasts (zone fire ETAs, containment estimates) look this far ahead in the solver's lookahead. */
export const FORECAST_MINUTES = 120;
/** A field report inside a fire, or one it reaches within this many minutes, joins that fire. */
export const REPORT_JOIN_MINUTES = 5;
export const MAX_ACTIVE_FIRES = 25;
/**
 * How far beyond the drill zones' half-width the live LANDFIRE landscape reaches for fires, m
 * (useDemoEnvironment sizes it with this plus a margin). The server already drops Studio
 * ignitions more than 3 km outside the zones' box (`outside_drill`); any still off the landscape
 * are skipped at ingest.
 */
export const IGNITION_OUTSIDE_MAX_M = 1500;
/** ASSUMPTION: units drive to the fire's heel, this far behind the burned edge, to anchor. */
export const ANCHOR_OFFSET_M = 100;
const MAX_EVENTS = 200;
const MAX_SEEN_REPORTS = 1000;
const MAX_STEP_MINUTES = 1;
const METERS_PER_DEG = 111_320;
const SQUARE_METERS_PER_HECTARE = 10_000;
const ZONE_RING_POINTS = 40;
const SYNTHETIC_STATION_COUNT = 3;
/** The hourly wind series changes on these boundaries (realism.ts windAt). */
const WIND_SAMPLE_MINUTES = 60;

/**
 * Moisture the solver would use with no Studio fire on the board. Never reached in practice:
 * every fire comes from Studio, whose conditions replace it before the fire starts.
 */
const NO_STUDIO_MOISTURE: MoistureId = "dry";

/** Every board fire comes from a Simulation Studio publish (spot fires belong to their parent fire). */
export type FireSource = "studio";
export type FireStatus = "burning" | "contained" | "out";

export interface Fire {
  id: string;
  source: FireSource;
  /** fire_seen field reports that joined this fire (closing it resolves them). */
  reportIds: string[];
  /** The Studio publish it came from: board tag ("S1"), scenario name and ignition name. */
  studio: { tag: string; name: string; ignition: string };
  origin: LonLat;
  ignitedAt: number;
  /** Whole board minute the solver lets it spread from (ceil of `ignitedAt`). */
  startMinute: number;
  /** Why it cannot spread (off the landscape, no fuel, already burned), or null; such a fire is not a solver source. */
  noSpread: string | null;
  /** Head spread rate at the leading front cell, m/min, rounded (display). */
  headRate: number;
  /** The solver's Rothermel behaviour at the leading front cell, now. */
  rates: FrontBehaviour;
  /** Solver footprint now: burned area (ha), open perimeter (m) and its growth over the next minute (m/min). */
  areaHa: number;
  perimeterM: number;
  perimeterGrowthMPerMin: number;
  /** Ground distance from the ignition point to the farthest burned cell, metres. */
  reachM: number;
  /** Where units drive to: the heel, ANCHOR_OFFSET_M behind the burned edge. */
  target: LonLat;
  /** Line built, metres. */
  lineM: number;
  status: FireStatus;
  containedAt: number | null;
  outAt: number | null;
  closedBy: "teams" | "manual" | null;
}

/**
 * `returning`: released (line finished, fire out, release_crew, its trip refused on the road),
 * driving back to its home station on a road leg; on no fire, and dispatchable from where it is.
 * It becomes `available` at the station on arrival.
 */
export type TeamStatus = "available" | "en_route" | "on_scene" | "returning";
/** A unit that can take an order to a fire now: free at its station, or driving back to it. */
export function dispatchable(team: Team): boolean {
  return team.status === "available" || team.status === "returning";
}
/**
 * How a unit's drive is timed: on the drill roads (`road`), with an off-network leg at one end
 * (`road_offboard`), or `pending`: dispatched (or released), waiting where it stands for its road route
 * (POST /api/demo/crew_routes). Units only ever move along a road line.
 */
export type TravelBasis = "road" | "road_offboard" | "pending";

export interface Team {
  /** The snapshot's engine_id for a snapshot engine (1:1); C1/C2/D1 or E1.. for assumed units. */
  id: string;
  kind: DemoApparatusKind;
  /** Station.id of its home station. */
  station: string;
  /** Snapshot engine it is (`engine_id`), or null for a unit the snapshot does not list. */
  engineId: string | null;
  /** True for a unit not in the snapshot (assumed hand crews and dozer; every unit of the fallback roster). */
  assumed: boolean;
  /** Where the unit is, or where it set off from while en route. */
  position: LonLat;
  status: TeamStatus;
  fireId: string | null;
  departAt: number | null;
  /** Board minute it starts moving along `route` (after turnout; at once on a return or a turnaround). */
  rollAt: number | null;
  arriveAt: number | null;
  /** Returning with no road route home yet: board minute it asks for one again (RETURN_RETRY_MINUTES). */
  returnRetryAt: number | null;
  /** Where it is driving to (the fire's heel when dispatched, or its attack line's anchor point). */
  target: LonLat | null;
  /** Road line while en route (null while its road route is pending). */
  route: LonLat[] | null;
  travel: TravelBasis | null;
  /** travelKey of the trip it is on (its road leg), while en route. */
  legKey: string | null;
  /** Attack line (AttackLine.id) it builds, or null for direct attack at the fire's edge. */
  lineId: string | null;
}

export interface RouteOption {
  destination_id: string;
  name: string;
  kind: string;
  eta_min: number;
  distance_m: number;
  via: string[];
  safety: "clear" | "passes_near_fire" | "passes_fire";
  line: LonLat[];
  /** Road segments in travel order (resolved from the answer's `segments` table); [] when unknown. */
  segments: RouteSegment[];
  /** Destination capacity in vehicles; null = unknown (exits). */
  destination_capacity_veh: number | null;
}

export interface ZoneState {
  id: string;
  name: string;
  households: number;
  /**
   * Households with no vehicle: they cannot drive out and need transport (snapshot
   * `needs_transport_households`; without a snapshot the environment's ACS carless count).
   */
  noVehicle: number;
  /** Where households, persons and vehicles come from: the resource snapshot, or the drill file. */
  demand: "snapshot" | "drill";
  /** Persons in the zone; null when unknown (no snapshot, or households with unknown occupants). Never 0 for unknown. */
  occupants: number | null;
  /** Persons in households whose occupants are known (all of them when `occupants` is set). */
  knownOccupants: number;
  /** Households whose occupants are unknown (all households without a snapshot). */
  unknownOccupantHouseholds: number;
  /** Persons in the carless households (need transport); null when unknown. */
  needsTransportOccupants: number | null;
  /** Vehicles owned in the zone (snapshot `vehicles`); null when unknown or without a snapshot. */
  vehiclesOwned: number | null;
  /** Persons caught at the overrun (frozen then); null when the zone's persons are unknown. */
  caughtPeople: number | null;
  /** Largest outer ring, thinned. */
  ring: LonLat[];
  core: LonLat;
  orderedAt: number | null;
  route: RouteOption | null;
  /** Fire-cue (shadow) evacuation with no order: when it started and the route taken. */
  shadowAt: number | null;
  shadowRoute: RouteOption | null;
  /** Minute fire first touched the zone / reached its core. */
  touchedAt: number | null;
  overrunAt: number | null;
  /** Last minute a fire touched the zone. */
  lastFireAt: number | null;
  caught: number;
  /**
   * Vehicles the zone's households drive out with: the snapshot's `evacuating_vehicles` (at most
   * 2 per household, docs/scenario-snapshots.md), else the drill file's zone vehicles. Households
   * with a vehicle take vehiclesPerHousehold each.
   */
  vehicles: number;
  /** Departed cohorts and their congested arrivals (traffic.ts). */
  trips: Trips;
}

export interface Station {
  id: string;
  name: string;
  location: LonLat;
  /** CAL FIRE facility type (FSB, FSA, CC, ...), "osm_fire_station", "synthetic", or the snapshot's station_class. */
  type: string;
  /**
   * Where the station comes from: the resource snapshot (`snapshot`), the CAL FIRE facilities
   * layer (`calfire_bases`), a drill package's OSM stations (`package_osm`) or `synthetic`.
   */
  source: "snapshot" | "calfire_bases" | "package_osm" | "synthetic";
  /** Basis of the station's location (snapshot), or null when not from the snapshot. */
  basis: SnapshotBasis | null;
  /** Engines the snapshot lists here (all statuses); [] for a station not from the snapshot. */
  engines: StationEngine[];
}

/** One engine of a snapshot station (docs/scenario-snapshots.md `snapshot_stations.engines`). Synthetic. */
export interface StationEngine {
  engine_id: string;
  kind: EngineKind;
  /** The board apparatus it runs as (realism.ts SNAPSHOT_ENGINE_KIND). */
  apparatus: DemoApparatusKind;
  status_at_start: EngineStatus;
  basis: SnapshotBasis;
  /** The board unit (Team.id) for an engine available at T+0; null = committed / out of service, not dispatchable. */
  team_id: string | null;
}

/** The snapshot the board was built from, as the UI shows it (fields as the API names them). */
export interface BoardSnapshotSummary {
  snapshot_id: string;
  incident_id: string;
  version: string;
  /** Drill start (T+0), ISO UTC. */
  scenario_time: string;
  created_at: string;
  label: string;
  sources: ScenarioSnapshot["sources"];
  basis: ScenarioSnapshot["basis"];
  notes: string[];
  totals: SnapshotTotals;
  /** Board zones with a snapshot row, and the ids of those without (they keep the drill file's counts). */
  zones_matched: number;
  zones_unmatched: string[];
}

/** Where the board's units and household counts come from. */
export interface BoardResources {
  source: "snapshot" | "assumed_roster";
  /** User-visible line, e.g. "Resource snapshot snap_… : 25 engines available at T+0 …" or NO_SNAPSHOT_LABEL. */
  label: string;
  /** Why the board has no snapshot (no_snapshot 404, network), or null. */
  problem: string | null;
  /** Units that are snapshot engines / units the snapshot does not list (ASSUMED_UNIT_LABEL). */
  engineUnits: number;
  assumedUnits: number;
  /** The label carried by every assumed unit. */
  assumedLabel: string;
}

/** A road leg from POST /api/demo/crew_routes (drive minutes, after turnout). */
export interface TravelLeg {
  driveMinutes: number;
  line: LonLat[];
  basis: TravelBasis;
}

/** Everything the board reads from outside: landscape, wind, stations, carless counts. */
export interface DemoEnvironment {
  /** Fuel/terrain lookups and the hourly wind. */
  spread: SpreadInputs;
  /** Real stations by roster base; null = synthetic stations (bases file unavailable). */
  bases: { calfireStations: Station[]; localStations: Station[]; crewCamps: Station[] } | null;
  /** Where `bases` came from: the CAL FIRE layer, the drill package's OSM stations, or none. */
  basesSource: "calfire" | "package" | null;
  basesLabel: string;
  /** Carless households per zone id; missing zones count 0. */
  noVehicle: ReadonlyMap<string, number>;
  noVehicleLabel: string;
  /** LANDFIRE fuel, canopy and terrain the solver runs on (also the 3D board's ground). */
  landscape: LandscapeGrid;
  /** The prebuilt region it came from, or the drill area loaded live from LANDFIRE. */
  landscapeRegion: { id: string; name: string };
  landscapeSource: "stored" | "live";
}

export type EventKind = "ignition" | "contained" | "out" | "overrun" | "order" | "team" | "closed" | "zone" | "board" | "studio";
export interface BoardEvent {
  minute: number;
  kind: EventKind;
  /** studio = a Simulation Studio publish arriving (and its ignitions starting). */
  actor: "board" | "agent" | "you" | "studio";
  text: string;
}

/**
 * Wind and fuel moisture of a Simulation Studio run, as the board's solver uses them while that
 * run's fires are on the board. Studio holds its wind constant over a run; so does the board.
 * Units: m/s and degrees true (FROM) on the board; moisture fractions (0.06 = 6%).
 */
export interface StudioConditions {
  /** Board tag of the publish ("S1") and its scenario name. */
  tag: string;
  name: string;
  windSpeedMetersPerSecond: number;
  windSpeedMph: number;
  windFromDegrees: number;
  /** Studio's wind source (assumed, historical, worst_case, forecast) and label. */
  windSource: string;
  windLabel: string;
  moisture: FuelMoisture;
  moisturePreset: string;
  moistureLabel: string;
}

/** A Studio ignition waiting for its start minute. */
export interface ScheduledIgnition {
  /** Board fire id it starts as ("S1-F1"). */
  id: string;
  origin: LonLat;
  /** Board minute it starts (ingest minute + Studio start_minute). */
  at: number;
  studio: Fire["studio"];
}

/** The solver field the board runs on, with what the board reads from it per zone. */
export interface FireField extends FireSolveResult {
  /** Source index by fire id. */
  sourceIndex: Map<string, number>;
  /** Grid cell of each source's ignition point. */
  originCells: number[];
  zones: Map<string, ZoneArrivals>;
  /** fireGeometry per fire, cached per whole minute. */
  geometry: Map<string, { minute: number; value: ReturnType<typeof fireGeometry> }>;
}

export interface FireSolverState {
  field: FireField | null;
  /** Last solve failure, shown on the page; the clock holds until a solve succeeds. */
  error: string | null;
  /** Zones rasterised on the landscape (fixed per board). */
  zoneCells: Map<string, ZoneCells>;
}

export interface Board {
  /** Run label (and part of the solve key); the board itself draws no random numbers. */
  seed: number;
  minute: number;
  fireCount: number;
  fires: Fire[];
  teams: Team[];
  /** Every station: all snapshot stations (also those with no available engine), plus any base of an assumed unit. */
  stations: Station[];
  /** The resource snapshot the board was built from; null = none (fallback roster, NO_SNAPSHOT_LABEL). */
  snapshot: BoardSnapshotSummary | null;
  /** The full snapshot it was built from (rebuilds reuse it); null without one. */
  snapshotInput: ScenarioSnapshot | null;
  resources: BoardResources;
  zones: ZoneState[];
  env: DemoEnvironment;
  /** The solver's arrival field and its bookkeeping (fireField.ts). */
  solver: FireSolverState;
  /** Latest zone routes (POST /api/demo/routes); shadow evacuees take the best one. */
  routes: ReadonlyMap<string, RouteOption[]>;
  /** Road legs by travelKey; filled by the page from POST /api/demo/crew_routes. */
  travel: Map<string, TravelLeg>;
  /** Field reports already joined to a fire. */
  seenReports: string[];
  /** Studio publishes (fire_id) ingested by this board, oldest first; each starts once. */
  studioFireIds: string[];
  /**
   * Studio publishes this board never ingests (already there when it started, beyond the
   * page's first-load rule); null until the page has read the Studio feed for this board.
   */
  studioBaseline: string[] | null;
  /** Studio publishes ingested so far (the "S<n>" tag of the next is this + 1). */
  studioCount: number;
  /** Wind and moisture of the newest Studio fire ingested; null before the first. */
  conditions: StudioConditions | null;
  /** Studio ignitions waiting for their start minute, earliest first. */
  scheduled: ScheduledIgnition[];
  events: BoardEvent[];
  /** Running totals over the whole run. */
  caughtTotal: number;
  /** Persons caught over the whole run; null once a zone with unknown persons was caught. */
  caughtPeopleTotal: number | null;
  firesOutTotal: number;
  /** Burned area of fires already removed from the board, hectares. */
  removedBurnedHa: number;
  /** Evacuation traffic at the last whole-minute traffic step (evacuationTrafficStep). */
  traffic: TrafficState;
  /** Fire line built (or being built) at attack positions; enters the solver as control lines. */
  lines: AttackLine[];
  /** Attack positions per fire id, planned from the field (attack.ts), with what they were planned from. */
  attackPlans: Map<string, { field: FireSolveResult; minute: number; plans: AttackPlan[] }>;
  /** Trips (travelKey) the road router found no route for, and why. */
  noRoute: Map<string, string>;
  /**
   * Road reachability of each target per apparatus access class, by reachKey (access class,
   * trip destination id, target point): read from the unit legs of that class to that target
   * (applyTravelLeg / travelLegFailed). See classBlocked.
   */
  classReach: Map<string, ClassReach>;
}

/**
 * What the unit legs of one access class to one target found: reached = some unit of the class
 * got a road route there; otherwise the origins (travelKey `from` parts) whose legs failed for a
 * reason at the target's end (TARGET_SIDE_REASONS), and the first such reason.
 */
export interface ClassReach {
  reached: boolean;
  failedFrom: string[];
  reason: string | null;
}

/**
 * Line at one attack position (attack.ts), built by the units assigned to it from its anchor
 * point outward both ways at their sourced production rate (realism.ts lineMetersPerMinute, at
 * the anchor's fuel and slope). Built cells enter the solver as control lines in chunks of
 * LINE_RESOLVE_CHUNK_M (and when finished); each chunk re-solves the field. Units: metres, board minutes.
 */
export interface AttackLine {
  /** `${fireId}#${positionId}@lon,lat` (the anchor rounded to 4 decimals). */
  id: string;
  fireId: string;
  /** The position it was laid out at (frozen once the line is started). */
  plan: AttackPlan;
  lengthM: number;
  raster: LineCells;
  /** Per raster cell: board minute it was finished (Infinity until then) and the flame it holds, ft. */
  builtAt: Float32Array;
  holdsFt: Float32Array;
  builtM: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Evacuation traffic loads at one traffic step. Simulated. */
export interface TrafficState {
  /** Whole minute of the last step; null before the first. */
  minute: number | null;
  /** Departure flow loading each segment id, veh/h. */
  flow: Map<string, number>;
  /** Departure flow of each zone, veh/h. */
  zoneFlow: Map<string, number>;
  /** Segments of the routes in use, by id. */
  segments: Map<string, RouteSegment>;
  /** Vehicles queued at each segment (point queue), where demand has exceeded its capacity. */
  queue: Map<string, number>;
  /** Lindley recursion state per segment, continued while the zones loading it are unchanged. */
  queueCache: Map<string, { key: string; t: number; q: number }>;
}

export interface BaseZone {
  id: string;
  name: string;
  households: number;
  /** Vehicles in the zone (drill bundle); missing = one per household. */
  vehicles?: number;
  ring: LonLat[];
  core: LonLat;
}

// ---- geometry ----

/** Local metres (x east, y north) of `p` relative to `origin`. */
export function toLocal(origin: LonLat, p: LonLat): [number, number] {
  const kx = METERS_PER_DEG * Math.cos((origin[1] * Math.PI) / 180);
  return [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * METERS_PER_DEG];
}

export function fromLocal(origin: LonLat, [x, y]: [number, number]): LonLat {
  const kx = METERS_PER_DEG * Math.cos((origin[1] * Math.PI) / 180);
  return [origin[0] + x / kx, origin[1] + y / METERS_PER_DEG];
}

export function distanceM(a: LonLat, b: LonLat): number {
  const [x, y] = toLocal(a, b);
  return Math.hypot(x, y);
}

/** WGS84 centre of a landscape cell. */
export function cellLonLat(grid: LandscapeGrid, cell: number): LonLat {
  const x = cell % grid.width;
  const y = (cell - x) / grid.width;
  return mercatorToLonLat(grid.originX + x * grid.cellSizeX, grid.originY + y * grid.cellSizeY);
}

export function fireAreaHa(fire: Fire): number {
  return fire.areaHa;
}

/** Open perimeter of the fire's solver footprint now, metres. */
export function firePerimeterM(fire: Fire): number {
  return fire.perimeterM;
}

/** Perimeter `t` minutes from now in the solver's lookahead, metres (the current one once contained). */
export function perimeterIn(board: Board, fire: Fire, t: number): number {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return fire.perimeterM;
  return perimeterAt(field, s, board.minute + (fire.status === "burning" ? t : 0));
}

/** Perimeter growth over the next minute, m/min (0 once contained). */
export function perimeterGrowth(fire: Fire): number {
  return fire.status === "burning" ? fire.perimeterGrowthMPerMin : 0;
}

/** Where units drive to: the heel, ANCHOR_OFFSET_M behind the burned edge. */
export function crewTarget(fire: Fire): LonLat {
  return fire.target;
}

export function thinRing(ring: LonLat[], max = ZONE_RING_POINTS): LonLat[] {
  const open = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring;
  if (open.length <= max) return open;
  const step = open.length / max;
  return Array.from({ length: max }, (_, i) => open[Math.floor(i * step)]);
}

export function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- the solver field ----

/** The field the board runs on, or null before the first fire is solved. */
export function fireField(board: Board): FireField | null {
  return board.solver.field;
}

function stopMinute(fire: Fire): number | null {
  if (fire.status === "burning") return null;
  return fire.containedAt ?? fire.outAt;
}

/**
 * The wind the board runs on now: the newest Studio fire's (constant), or, with no Studio fire
 * yet (so no fire at all), the station series' current hour.
 */
export function boardWind(board: Board): WindNow {
  const c = board.conditions;
  if (c) return { speedMetersPerSecond: c.windSpeedMetersPerSecond, fromDegrees: c.windFromDegrees, hourIndex: 0, held: false };
  return windAt(board.env.spread.wind, board.minute);
}

function moistureKey(m: FuelMoisture): string {
  return [m.dead1h, m.dead10h, m.dead100h, m.liveHerb, m.liveWoody].join(",");
}

/** Wind and moisture at the board minute, as the solver takes them. */
function weatherNow(board: Board): { speed: number; from: number; moisture: FuelMoisture; moistureKey: string; key: string } {
  const w = boardWind(board);
  const moisture = board.conditions?.moisture ?? moistureOf(NO_STUDIO_MOISTURE);
  const mk = moistureKey(moisture);
  return { speed: w.speedMetersPerSecond, from: w.fromDegrees, moisture, moistureKey: mk, key: `${w.speedMetersPerSecond}|${w.fromDegrees}|${mk}` };
}

function fieldWeatherKey(field: FireSolveResult): string {
  return `${field.windSpeedMetersPerSecond}|${field.windFromDegrees}|${field.moistureKey}`;
}

/**
 * Why the board needs a new solve before its clock may move, or null. Pure; `step` holds while
 * this is non-null, so every solve happens at a board-defined minute.
 */
export function fireSolveDue(board: Board): string | null {
  const { field, error } = board.solver;
  if (error) return "the last fire solve failed";
  const spreading = board.fires.filter((f) => f.status === "burning" && f.noSpread === null);
  if (!field) return spreading.length > 0 ? `new fire ${spreading[0].id}` : null;
  for (const f of spreading) if (!field.sourceIndex.has(f.id)) return `new fire ${f.id}`;
  for (const f of board.fires) {
    if (f.status === "burning") continue;
    const s = field.sourceIndex.get(f.id);
    if (s !== undefined && field.sources[s].stopMinute !== stopMinute(f)) return `${f.id} ${f.status === "contained" ? "contained" : "closed"}`;
  }
  if (spreading.length === 0) return null;
  if (weatherNow(board).key !== fieldWeatherKey(field)) return "wind or fuel moisture changed";
  if (lineKey(board) !== field.lineKey) return "fire line built";
  if (board.minute + FORECAST_MINUTES > field.horizonMinutes) return "lookahead renewed";
  return null;
}

/** The solve the board needs now (call when fireSolveDue is non-null and no solve failed). */
export function buildFireSolveRequest(board: Board): FireSolveRequest {
  const field = board.solver.field;
  const weather = weatherNow(board);
  const horizonMinutes = Math.ceil(board.minute) + LOOKAHEAD_MINUTES;
  let candidates = board.fires.filter(
    (f) => f.noSpread === null && f.startMinute < horizonMinutes && (f.status === "burning" || field?.sourceIndex.has(f.id)),
  );
  if (candidates.length > MAX_SOLVER_SOURCES) {
    // Drop the oldest stopped fires: their burned ground stays, as ground of no listed fire.
    const burning = candidates.filter((f) => f.status === "burning");
    const stopped = candidates.filter((f) => f.status !== "burning").slice(-(MAX_SOLVER_SOURCES - burning.length));
    const keep = new Set([...burning, ...stopped]);
    candidates = candidates.filter((f) => keep.has(f));
  }
  const sources: SolveSource[] = candidates.map((f) => ({
    fireId: f.id,
    location: f.origin,
    startMinute: f.startMinute,
    stopMinute: stopMinute(f),
  }));
  let resume: FireSolveRequest["resume"] = null;
  if (field) {
    const remap = new Int8Array(field.sources.length).fill(-1);
    sources.forEach((s, i) => {
      const old = field.sourceIndex.get(s.fireId);
      if (old !== undefined) remap[old] = i;
    });
    const arrivalMinutes = field.arrivalMinutes.slice();
    const sourceIndexByCell = new Int8Array(arrivalMinutes.length);
    for (let i = 0; i < arrivalMinutes.length; i++) {
      const old = field.sourceIndexByCell[i];
      const next = old >= 0 ? remap[old] : -1;
      sourceIndexByCell[i] = next;
      // A stopped fire's cells past its stop are not history (the board stops before it moves on).
      const stop = next >= 0 ? sources[next].stopMinute : null;
      if (stop !== null && arrivalMinutes[i] > stop) arrivalMinutes[i] = Number.POSITIVE_INFINITY;
    }
    resume = { arrivalMinutes, sourceIndexByCell, earlierBehaviour: field.behaviour, earlierWindSpeedMph: field.windSpeedMph };
  }
  return {
    key: `${board.seed}|${board.minute}|${weather.key}|${sources.map((s) => `${s.fireId}:${s.stopMinute}`).join(",")}|${lineKey(board)}`,
    fromMinute: field ? board.minute : null,
    horizonMinutes,
    windSpeedMetersPerSecond: weather.speed,
    windFromDegrees: weather.from,
    moisture: weather.moisture,
    moistureKey: weather.moistureKey,
    sources,
    controlLines: builtLineCells(board),
    lineKey: lineKey(board),
    resume,
  };
}

/** Metres of a line the solver counts: whole LINE_RESOLVE_CHUNK_M chunks, or all of a finished line. */
export function lineChunkM(line: AttackLine): number {
  if (line.completedAt !== null) return line.lengthM;
  return Math.min(line.lengthM, Math.floor((line.builtM + 1e-6) / LINE_RESOLVE_CHUNK_M) * LINE_RESOLVE_CHUNK_M);
}

/** Which built line the solver should respect now; a solve echoes it (FireSolveResult.lineKey). */
export function lineKey(board: Board): string {
  return board.lines
    .filter((l) => lineChunkM(l) > 0)
    .map((l) => `${l.id}:${lineChunkM(l).toFixed(1)}`)
    .join(",");
}

/** The built cells of every line up to its counted chunk, with their build minutes, for the solver. */
function builtLineCells(board: Board): BuiltLineCells | null {
  const cells: number[] = [];
  const minutes: number[] = [];
  const holds: number[] = [];
  for (const line of board.lines) {
    const chunk = lineChunkM(line) + 1e-6;
    const { cells: lc, needM } = line.raster;
    for (let k = 0; k < lc.length && needM[k] <= chunk; k++) {
      if (!Number.isFinite(line.builtAt[k])) continue;
      cells.push(lc[k]);
      minutes.push(line.builtAt[k]);
      holds.push(line.holdsFt[k]);
    }
  }
  if (cells.length === 0) return null;
  return { cells: Int32Array.from(cells), holdFromMinute: Float32Array.from(minutes), holdsFeet: Float32Array.from(holds) };
}

/**
 * Installs a solve. False (nothing changed) when it was asked at a different board minute
 * than now (a restarted or moved board); the page then asks again.
 */
export function applyFireSolve(board: Board, result: FireSolveResult, requestedAtMinute: number): boolean {
  if (requestedAtMinute !== board.minute) return false;
  const grid = board.env.landscape;
  const sourceIndex = new Map(result.sources.map((s, i) => [s.fireId, i]));
  const zones = new Map<string, ZoneArrivals>();
  for (const [id, cells] of board.solver.zoneCells) zones.set(id, zoneArrivals(result, cells));
  board.solver.field = {
    ...result,
    sourceIndex,
    originCells: result.sources.map((s) => cellAt(grid, { longitude: s.location[0], latitude: s.location[1] })),
    zones,
    geometry: new Map(),
  };
  board.solver.error = null;
  for (const fire of board.fires) refreshFire(board, fire);
  return true;
}

/** Records a failed solve; the clock stays held and the page retries. */
export function fireSolveFailed(board: Board, message: string): void {
  if (board.solver.error === message) return;
  board.solver.error = message;
  log(board, "board", "board", `Fire model failed: ${message}`);
}

/** Upwind of `p` by `meters`, toward the bearing the wind blows from. */
function upwindOf(board: Board, p: LonLat, meters: number): LonLat {
  const th = (boardWind(board).fromDegrees * Math.PI) / 180;
  return fromLocal(p, [Math.sin(th) * meters, Math.cos(th) * meters]);
}

/** Recomputes a fire's footprint snapshot (area, perimeter, front, heel) from the field at the board minute. */
function refreshFire(board: Board, fire: Fire): void {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) {
    fire.areaHa = fire.perimeterM = fire.perimeterGrowthMPerMin = fire.reachM = 0;
    fire.rates = NO_FRONT;
    fire.headRate = 0;
    fire.target = upwindOf(board, fire.origin, ANCHOR_OFFSET_M);
    return;
  }
  const grid = board.env.landscape;
  const minute = board.minute;
  fire.areaHa = areaAt(field, grid, s, minute) / SQUARE_METERS_PER_HECTARE;
  fire.perimeterM = perimeterAt(field, s, minute);
  fire.perimeterGrowthMPerMin = fire.status === "burning" ? perimeterAt(field, s, minute + 1) - fire.perimeterM : 0;
  const whole = Math.floor(minute);
  let cached = field.geometry.get(fire.id);
  if (!cached || cached.minute !== whole) {
    cached = { minute: whole, value: fireGeometry(field, grid, s, field.originCells[s], whole) };
    field.geometry.set(fire.id, cached);
  }
  const g = cached.value;
  fire.rates = fire.status === "burning" ? g.front : { ...g.front, headMetersPerMinute: 0 };
  fire.headRate = Math.round(fire.rates.headMetersPerMinute * 10) / 10;
  fire.reachM = g.reachMeters;
  if (g.heelCell < 0) {
    fire.target = upwindOf(board, fire.origin, ANCHOR_OFFSET_M);
  } else {
    const heel = cellLonLat(grid, g.heelCell);
    const lead = g.front.cell >= 0 ? cellLonLat(grid, g.front.cell) : fire.origin;
    const [x, y] = toLocal(lead, heel);
    const d = Math.hypot(x, y);
    fire.target = d > 1 ? fromLocal(heel, [(x / d) * ANCHOR_OFFSET_M, (y / d) * ANCHOR_OFFSET_M]) : upwindOf(board, heel, ANCHOR_OFFSET_M);
  }
}

// ---- setup ----

/**
 * Synthetic stations (fallback when the CAL FIRE bases file is unavailable): `count` zone
 * cores spread across the area by farthest-point sampling, starting from the zone with the
 * most households. Not real fire stations; labelled so on the board.
 */
export function pickStations(zones: BaseZone[], count: number): Station[] {
  if (zones.length === 0) return [];
  const chosen = [zones.reduce((best, z) => (z.households > best.households ? z : best))];
  while (chosen.length < Math.min(count, zones.length)) {
    let best = zones[0];
    let bestD = -1;
    for (const z of zones) {
      const d = Math.min(...chosen.map((c) => distanceM(c.core, z.core)));
      if (d > bestD) {
        bestD = d;
        best = z;
      }
    }
    chosen.push(best);
  }
  return chosen.map((z, i) => ({
    id: `S${i + 1}`,
    name: `Synthetic station ${i + 1}`,
    location: z.core,
    type: "synthetic",
    source: "synthetic",
    basis: null,
    engines: [],
  }));
}

/** Centre of the zones' cores' bounding box (the "drill centre" assumed units start nearest to). */
export function zonesCoreCentre(zones: readonly { core: LonLat }[]): LonLat | null {
  if (zones.length === 0) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const { core } of zones) {
    minLon = Math.min(minLon, core[0]); maxLon = Math.max(maxLon, core[0]);
    minLat = Math.min(minLat, core[1]); maxLat = Math.max(maxLat, core[1]);
  }
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

function newTeam(id: string, kind: DemoApparatusKind, station: string, location: LonLat, engineId: string | null, assumed: boolean): Team {
  return {
    id,
    kind,
    station,
    engineId,
    assumed,
    position: location,
    status: "available",
    fireId: null,
    departAt: null,
    rollAt: null,
    arriveAt: null,
    returnRetryAt: null,
    target: null,
    route: null,
    travel: null,
    legKey: null,
    lineId: null,
  };
}

/** Fallback (no snapshot): the assumed ROSTER's units, each at its base: real bases nearest first, else synthetic round-robin. */
function rosterTeams(zones: BaseZone[], env: DemoEnvironment): { teams: Team[]; stations: Station[] } {
  const synthetic = env.bases ? [] : pickStations(zones, SYNTHETIC_STATION_COUNT);
  const used = new Map<string, Station>();
  const counters: Record<string, number> = {};
  const teams: Team[] = [];
  let robin = 0;
  for (const { kind, count, base } of ROSTER) {
    const pool = env.bases
      ? base === "calfire_station"
        ? env.bases.calfireStations
        : base === "local_station"
          ? env.bases.localStations
          : env.bases.crewCamps
      : synthetic;
    for (let i = 0; i < count; i += 1) {
      // One unit of a kind per real base (crewDispatch.ts UNITS_PER_KIND_PER_STATION); crews
      // and the synthetic fallback cycle through the pool.
      const station = env.bases && base !== "crew_camp" ? pool[i % Math.max(1, pool.length)] : pool[robin++ % Math.max(1, pool.length)];
      const prefix = KIND_PREFIX[kind];
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      const location = station?.location ?? zones[0]?.core ?? [0, 0];
      if (station) used.set(station.id, station);
      teams.push(newTeam(`${prefix}${counters[prefix]}`, kind, station?.id ?? "", location, null, true));
    }
  }
  return { teams, stations: [...used.values()] };
}

/**
 * Units from the resource snapshot: one per engine `available` at T+0, at its station, with the
 * engine_id as its id (committed and out-of-service engines stay on the station's record only);
 * stations = every snapshot station. Then ASSUMED_EXTRA_UNITS (hand crews, dozer), at the
 * nearest CAL FIRE crew camp / state station when the CAL FIRE layer loaded, else at the
 * snapshot station nearest the drill centre. `skipped` lists engines that could not become units.
 */
function snapshotTeams(
  zones: BaseZone[],
  env: DemoEnvironment,
  snapshot: ScenarioSnapshot,
): { teams: Team[]; stations: Station[]; skipped: string[] } {
  const teams: Team[] = [];
  const ids = new Set<string>();
  const skipped: string[] = [];
  const stations: Station[] = snapshot.stations.map((s) => {
    const engines: StationEngine[] = [];
    for (const e of s.engines) {
      const apparatus = SNAPSHOT_ENGINE_KIND[e.kind];
      if (!apparatus) {
        skipped.push(`${e.engine_id} (unknown kind ${String(e.kind)})`);
        continue;
      }
      const dispatchable = e.status_at_start === "available" && !ids.has(e.engine_id);
      if (e.status_at_start === "available" && !dispatchable) skipped.push(`${e.engine_id} (duplicate engine id)`);
      if (dispatchable) {
        ids.add(e.engine_id);
        teams.push(newTeam(e.engine_id, apparatus, s.station_id, s.location, e.engine_id, false));
      }
      engines.push({
        engine_id: e.engine_id,
        kind: e.kind,
        apparatus,
        status_at_start: e.status_at_start,
        basis: e.basis,
        team_id: dispatchable ? e.engine_id : null,
      });
    }
    return {
      id: s.station_id,
      name: s.name,
      location: s.location,
      type: s.station_class ?? "snapshot",
      source: "snapshot",
      basis: s.basis,
      engines,
    };
  });

  const centre = zonesCoreCentre(zones);
  const nearestSnapshot = centre
    ? (stations.reduce<Station | null>((best, s) => (!best || distanceM(centre, s.location) < distanceM(centre, best.location) ? s : best), null))
    : (stations[0] ?? null);
  const counters: Record<string, number> = {};
  const extra = new Map<string, Station>();
  for (const { kind, count, base } of ASSUMED_EXTRA_UNITS) {
    // CAL FIRE bases are sorted nearest the drill first (useDemoEnvironment stationsFrom).
    const real = env.basesSource === "calfire" && env.bases ? (base === "crew_camp" ? env.bases.crewCamps : env.bases.calfireStations) : [];
    const station = real[0] ?? nearestSnapshot;
    if (station && station.source !== "snapshot") extra.set(station.id, station);
    const prefix = KIND_PREFIX[kind];
    for (let i = 0; i < count; i += 1) {
      let id: string;
      do {
        counters[prefix] = (counters[prefix] ?? 0) + 1;
        id = `${prefix}${counters[prefix]}`;
      } while (ids.has(id));
      ids.add(id);
      teams.push(newTeam(id, kind, station?.id ?? "", station?.location ?? centre ?? zones[0]?.core ?? [0, 0], null, true));
    }
  }
  return { teams, stations: [...stations, ...[...extra.values()].filter((s) => !stations.some((t) => t.id === s.id))], skipped };
}

/** Rasterised zones on the landscape's cells (cell centres inside the thinned ring, plus core and ring cells). */
function rasterZones(grid: LandscapeGrid, zones: ZoneState[]): Map<string, ZoneCells> {
  const lonOfCol = new Float64Array(grid.width);
  for (let c = 0; c < grid.width; c += 1) lonOfCol[c] = mercatorToLonLat(grid.originX + c * grid.cellSizeX, grid.originY)[0];
  const latOfRow = new Float64Array(grid.height);
  for (let r = 0; r < grid.height; r += 1) latOfRow[r] = mercatorToLonLat(grid.originX, grid.originY + r * grid.cellSizeY)[1];
  return new Map(zones.map((z) => [z.id, rasterZone(grid, z.ring, z.core, lonOfCol, latOfRow)]));
}

/** A count from outside: a finite number rounded and floored at 0, else 0. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** A count that may be unknown (null stays null, never 0). */
function countOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

/** A zone's starting state: from its snapshot row when there is one, else the drill file and the environment. */
function zoneState(z: BaseZone, snap: SnapshotZone | undefined, env: DemoEnvironment): ZoneState {
  const common = {
    id: z.id,
    name: z.name,
    ring: thinRing(z.ring),
    core: z.core,
    orderedAt: null,
    route: null,
    shadowAt: null,
    shadowRoute: null,
    touchedAt: null,
    overrunAt: null,
    lastFireAt: null,
    caught: 0,
    trips: emptyTrips(),
  };
  if (snap) {
    const households = count(snap.households);
    const unknown = Math.min(households, count(snap.unknown_households));
    const occupants = unknown > 0 ? null : countOrNull(snap.occupants);
    return {
      ...common,
      households,
      noVehicle: Math.min(households, count(snap.needs_transport_households)),
      demand: "snapshot",
      occupants,
      knownOccupants: count(snap.known_occupants),
      unknownOccupantHouseholds: unknown,
      needsTransportOccupants: occupants === null ? null : Math.min(occupants, count(snap.needs_transport_occupants)),
      vehiclesOwned: countOrNull(snap.vehicles),
      caughtPeople: occupants === null ? null : 0,
      vehicles: count(snap.evacuating_vehicles),
    };
  }
  const households = count(z.households);
  return {
    ...common,
    households,
    noVehicle: Math.min(households, count(env.noVehicle.get(z.id) ?? 0)),
    demand: "drill",
    occupants: null,
    knownOccupants: 0,
    unknownOccupantHouseholds: households,
    needsTransportOccupants: null,
    vehiclesOwned: null,
    caughtPeople: null,
    vehicles: z.vehicles === undefined ? households : count(z.vehicles),
  };
}

/** The snapshot's own fields for the board (BoardSnapshotSummary). */
function snapshotSummary(snapshot: ScenarioSnapshot, zones: ZoneState[]): BoardSnapshotSummary {
  const unmatched = zones.filter((z) => z.demand !== "snapshot").map((z) => z.id);
  return {
    snapshot_id: snapshot.snapshot_id,
    incident_id: snapshot.incident_id,
    version: snapshot.version,
    scenario_time: snapshot.scenario_time,
    created_at: snapshot.created_at,
    label: snapshot.label,
    sources: snapshot.sources ?? [],
    basis: snapshot.basis ?? {},
    notes: snapshot.notes ?? [],
    totals: snapshot.totals,
    zones_matched: zones.length - unmatched.length,
    zones_unmatched: unmatched,
  };
}

/** What the board starts from besides the drill zones and the environment. */
export interface BoardResourceInput {
  /** The drill's resource snapshot (GET /api/live/incidents/<id>/snapshot); null = none. */
  snapshot: ScenarioSnapshot | null;
  /** Why there is none (shown with NO_SNAPSHOT_LABEL), e.g. the 404 no_snapshot detail. */
  problem?: string | null;
}

export function createBoard(zones: BaseZone[], seed: number, env: DemoEnvironment, input: BoardResourceInput = { snapshot: null }): Board {
  const snapshot = input.snapshot;
  const snapZones = new Map((snapshot?.zones ?? []).map((z) => [z.zone_id, z]));
  const zoneStates: ZoneState[] = zones.map((z) => zoneState(z, snapZones.get(z.id), env));
  const built = snapshot ? snapshotTeams(zones, env, snapshot) : { ...rosterTeams(zones, env), skipped: [] as string[] };
  const { teams, stations } = built;
  const assumedUnits = teams.filter((t) => t.assumed).length;
  const engineUnits = teams.length - assumedUnits;
  const summary = snapshot ? snapshotSummary(snapshot, zoneStates) : null;
  const resources: BoardResources = snapshot
    ? {
        source: "snapshot",
        label: `Resource snapshot ${snapshot.snapshot_id} (synthetic engines; see basis): ${engineUnits} of ${snapshot.totals.engines_total} engines available at T+0 at ${stations.filter((s) => s.source === "snapshot").length} stations; ${assumedUnits} hand crew and dozer units ${ASSUMED_UNIT_LABEL}`,
        problem: built.skipped.length ? `Engines not on the board: ${built.skipped.join(", ")}` : null,
        engineUnits,
        assumedUnits,
        assumedLabel: ASSUMED_UNIT_LABEL,
      }
    : {
        source: "assumed_roster",
        label: NO_SNAPSHOT_LABEL,
        problem: input.problem ?? null,
        engineUnits: 0,
        assumedUnits,
        assumedLabel: ASSUMED_UNIT_LABEL,
      };
  const board: Board = {
    seed,
    minute: 0,
    fireCount: 0,
    fires: [],
    teams,
    stations,
    snapshot: summary,
    snapshotInput: snapshot,
    resources,
    zones: zoneStates,
    env,
    solver: { field: null, error: null, zoneCells: rasterZones(env.landscape, zoneStates) },
    routes: new Map(),
    travel: new Map(),
    seenReports: [],
    studioFireIds: [],
    studioBaseline: null,
    studioCount: 0,
    conditions: null,
    scheduled: [],
    events: [],
    caughtTotal: 0,
    caughtPeopleTotal: zoneStates.every((z) => z.occupants !== null) ? 0 : null,
    firesOutTotal: 0,
    removedBurnedHa: 0,
    traffic: { minute: null, flow: new Map(), zoneFlow: new Map(), segments: new Map(), queue: new Map(), queueCache: new Map() },
    lines: [],
    attackPlans: new Map(),
    noRoute: new Map(),
    classReach: new Map(),
  };
  const byKind = new Map<DemoApparatusKind, number>();
  for (const t of teams) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  const kinds = [...byKind].map(([k, n]) => `${n} ${kindShort(k)}${n > 1 ? "s" : ""}`).join(", ");
  log(
    board,
    "board",
    "board",
    `Monitoring started (run ${seed}). Ready: ${kinds || "no units"}. ${resources.label}${resources.problem ? ` (${resources.problem})` : ""}. No fires: a fire starts here when Simulation Studio runs a simulation for this drill.`,
  );
  return board;
}


function log(board: Board, kind: EventKind, actor: BoardEvent["actor"], text: string): void {
  board.events.unshift({ minute: Math.round(board.minute), kind, actor, text });
  if (board.events.length > MAX_EVENTS) board.events.length = MAX_EVENTS;
}

/**
 * Latest zone routes; shadow evacuees take a zone's best option. A zone already leaving keeps its
 * destination but follows the newest route there (when the answer still offers it), so its
 * segment ids match the other zones' for the traffic model (ids are per answer).
 */
export function setRoutes(board: Board, routes: ReadonlyMap<string, RouteOption[]>): void {
  board.routes = routes;
  for (const zone of board.zones) {
    const options = routes.get(zone.id);
    if (!options) continue;
    const same = (r: RouteOption | null) => (r ? (options.find((o) => o.destination_id === r.destination_id) ?? r) : null);
    zone.route = same(zone.route);
    zone.shadowRoute = same(zone.shadowRoute);
  }
}

export function zoneAt(board: Board, p: LonLat): ZoneState | null {
  return board.zones.find((z) => pointInRing(p, z.ring)) ?? null;
}

export function activeFires(board: Board): Fire[] {
  return board.fires.filter((f) => f.status !== "out");
}

/**
 * Starts fire `id` at `origin`; `at` is its ignition minute (the Studio ignition's scheduled
 * minute, which the clock lands on exactly). Null when MAX_ACTIVE_FIRES are already active.
 */
function ignite(board: Board, id: string, origin: LonLat, at: number, studio: Fire["studio"]): Fire | null {
  if (activeFires(board).length >= MAX_ACTIVE_FIRES) return null;
  board.fireCount += 1;
  const grid = board.env.landscape;
  const noSpread = noSpreadReason(grid, board.solver.field?.arrivalMinutes ?? null, origin, board.minute);
  const fire: Fire = {
    id,
    source: "studio",
    reportIds: [],
    studio,
    origin,
    ignitedAt: at,
    startMinute: Math.ceil(at),
    noSpread,
    headRate: 0,
    rates: NO_FRONT,
    areaHa: 0,
    perimeterM: 0,
    perimeterGrowthMPerMin: 0,
    reachM: 0,
    target: origin,
    lineM: 0,
    status: "burning",
    containedAt: null,
    outAt: null,
    closedBy: null,
  };
  board.fires.push(fire);
  refreshFire(board, fire);
  const zone = zoneAt(board, origin);
  const cell = cellAt(grid, { longitude: origin[0], latitude: origin[1] });
  log(
    board,
    "ignition",
    "studio",
    `Studio ignition ${fire.id} started${zone ? ` in ${zone.name}` : ""}${cell >= 0 ? `, ${fuelLabel(grid.fuelCodes[cell])}` : ""}${noSpread ? ` (${noSpread})` : ""}.`,
  );
  return fire;
}

/** Starts the scheduled Studio ignitions whose minute has come, earliest first. */
function startDueIgnitions(board: Board): void {
  while (board.scheduled.length > 0 && board.scheduled[0].at <= board.minute) {
    const s = board.scheduled.shift()!;
    if (!ignite(board, s.id, s.origin, s.at, s.studio)) {
      log(board, "studio", "studio", `Studio ignition ${s.id} not started: ${MAX_ACTIVE_FIRES} fires are already on the board.`);
    }
  }
}

/** Readable board id part from a Studio ignition name ("F1"); F<n> when the name has no letters or digits. */
function ignitionPart(name: string, index: number): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || `F${index + 1}`;
}

/**
 * Ingests one Simulation Studio publish (once per fire_id). Its wind and fuel moisture become the
 * board's conditions: the solver runs one wind, so a newer publish's conditions apply to every
 * fire on the board. Each ignition is scheduled at the board minute now + its Studio
 * start_minute, as fire "S<n>-<ignition name>" (n counts this board's publishes). Ignitions the
 * server lists in `outside_drill`, or off the board's landscape, are skipped with an event saying
 * why. Returns false when this publish was already ingested.
 */
export function ingestStudioFire(board: Board, fire: StudioFire): boolean {
  if (board.studioFireIds.includes(fire.fire_id)) return false;
  board.studioFireIds.push(fire.fire_id);
  board.studioCount += 1;
  const tag = `S${board.studioCount}`;
  const previous = board.conditions;
  const replacing = previous !== null && (activeFires(board).length > 0 || board.scheduled.length > 0);
  const v = fire.moisture.values;
  board.conditions = {
    tag,
    name: fire.name,
    windSpeedMph: fire.wind.speed_mph,
    windSpeedMetersPerSecond: fire.wind.speed_mph * METERS_PER_SECOND_PER_MPH,
    windFromDegrees: fire.wind.from_deg,
    windSource: fire.wind.source,
    windLabel: fire.wind.label,
    moisture: { dead1h: v.dead1h, dead10h: v.dead10h, dead100h: v.dead100h, liveHerb: v.liveHerb, liveWoody: v.liveWoody },
    moisturePreset: fire.moisture.preset,
    moistureLabel: fire.moisture.label || fire.moisture.preset,
  };
  const grid = board.env.landscape;
  const outside = new Set(fire.outside_drill);
  const taken = new Set([...board.fires.map((f) => f.id), ...board.scheduled.map((s) => s.id)]);
  const skipped: string[] = [];
  let scheduled = 0;
  fire.ignitions.forEach((ign, i) => {
    const name = ign.name || ign.id;
    if (outside.has(ign.id)) {
      skipped.push(`${name} is more than 3 km outside the drill's zones`);
      return;
    }
    if (cellAt(grid, { longitude: ign.lon, latitude: ign.lat }) < 0) {
      skipped.push(`${name} is off the board's landscape (${board.env.landscapeRegion.name})`);
      return;
    }
    const base = `${tag}-${ignitionPart(name, i)}`;
    let id = base;
    for (let k = 2; taken.has(id); k += 1) id = `${base}-${k}`;
    taken.add(id);
    board.scheduled.push({
      id,
      origin: [ign.lon, ign.lat],
      at: board.minute + Math.max(0, ign.start_minute),
      studio: { tag, name: fire.name, ignition: name },
    });
    scheduled += 1;
  });
  board.scheduled.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const total = fire.ignitions.length;
  const count = scheduled === total ? `${total} ignition${total === 1 ? "" : "s"}` : `${scheduled} of ${total} ignitions`;
  const c = board.conditions;
  log(
    board,
    "studio",
    "studio",
    `Studio fire '${fire.name}' received as ${tag}: ${count}, wind ${Math.round(c.windSpeedMph * 10) / 10} mph from ${Math.round(c.windFromDegrees)}° (${c.windSource.replace(/_/g, " ")}), ${c.moistureLabel} fuel moisture.${
      replacing ? ` These conditions now apply to every fire on the board (the fire model runs one wind), replacing ${previous!.tag}'s.` : ""
    }`,
  );
  for (const why of skipped) log(board, "studio", "studio", `${tag}: ignition skipped, ${why}.`);
  startDueIgnitions(board);
  return true;
}

/** Whether the fire can spread in the solver (it is on the landscape, on fuel, on unburned ground). */
export function headOnWildlandFuel(fire: Fire): boolean {
  return fire.noSpread === null;
}

/** Minutes until `fire` reaches `p` in the solver's lookahead (0 = burned now), or null when not within `limit`. */
export function waitMinutes(board: Board, fire: Fire, p: LonLat, limit = FORECAST_MINUTES): number | null {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return null;
  const cell = cellAt(board.env.landscape, { longitude: p[0], latitude: p[1] });
  if (cell < 0 || field.sourceIndexByCell[cell] !== s) return null;
  const wait = field.arrivalMinutes[cell] - board.minute;
  if (wait <= 0) return 0;
  return fire.status === "burning" && wait <= limit ? wait : null;
}

/** Whether `fire` started in the zone, or reaches it (any cell or its core) within `limit` minutes. */
export function fireReachesZone(board: Board, fire: Fire, zone: ZoneState, limit: number): boolean {
  if (pointInRing(fire.origin, zone.ring)) return true;
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  const za = field?.zones.get(zone.id);
  if (!field || s === undefined || !za) return false;
  return za.earliestBySource[s] - board.minute <= limit || (za.coreSource === s && za.coreArrival - board.minute <= limit);
}

/**
 * Joins a fire_seen field report to the fire already there (burned there, or reached within
 * REPORT_JOIN_MINUTES), so closing that fire resolves the report on the drill. Reports never
 * start fires: one no fire covers is left alone (and checked again later). Each joins once.
 */
export function joinFieldReport(board: Board, reportId: string, coord: LonLat): Fire | null {
  if (board.seenReports.includes(reportId)) return null;
  const near = activeFires(board).find((f) => waitMinutes(board, f, coord, REPORT_JOIN_MINUTES) !== null);
  if (!near) return null;
  board.seenReports.push(reportId);
  if (board.seenReports.length > MAX_SEEN_REPORTS) board.seenReports.shift();
  near.reportIds.push(reportId);
  log(board, "ignition", "board", `Field report joined to ${near.id}.`);
  return near;
}

// ---- units ----

/**
 * Cache key of a road leg: unit, where it starts and where it goes (rounded), and the trip's
 * destination id (the fire for direct attack, the attack line's id for a position).
 */
export function travelKey(team: Team, from: LonLat, destKey: string, to: LonLat): string {
  return `${team.id}|${originKey(from)}|${destKey}|${targetKey(to)}`;
}

const originKey = (p: LonLat): string => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
const targetKey = (p: LonLat): string => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

/**
 * Router reasons (livecore.inbound InboundReason) that come from the target's end of a trip or
 * the class's roads to it, so they hold for every unit of that access class. origin_off_network
 * and origin_in_fire belong to one unit's start and only exclude that unit.
 */
export const TARGET_SIDE_REASONS: ReadonlySet<string> = new Set(["no_open_road", "no_access", "target_in_fire", "target_off_network"]);
/**
 * An access class is taken as unable to reach a target once legs of that class from this many
 * distinct origins failed there for a target-side reason (or from every origin its free units
 * stand at, when fewer), and no unit of the class got a road route there. Two origins guard
 * against one station sitting in a pocket of roads the class cannot leave.
 */
export const REACH_CONFIRM_ORIGINS = 2;
const MAX_CLASS_REACH = 4000;

/** Key of board.classReach: access class, trip destination id (fire id or line id) and target point (as in travelKey). */
export function reachKey(access: AccessClass, destKey: string, to: LonLat): string {
  return `${access}|${destKey}|${targetKey(to)}`;
}

/** Records what a unit leg (travelKey `key`) says about its class reaching its target; reason null = a road route. */
function noteReach(board: Board, key: string, reason: string | null): void {
  const parts = key.split("|");
  if (parts.length !== 4) return;
  const [teamId, from, destKey, to] = parts;
  const team = board.teams.find((t) => t.id === teamId);
  if (!team || (reason !== null && !TARGET_SIDE_REASONS.has(reason))) return;
  const rk = `${accessClassOf(team.kind)}|${destKey}|${to}`;
  const entry = board.classReach.get(rk) ?? { reached: false, failedFrom: [], reason: null };
  if (reason === null) entry.reached = true;
  else {
    if (!entry.failedFrom.includes(from)) entry.failedFrom.push(from);
    entry.reason ??= reason;
  }
  board.classReach.set(rk, entry);
  if (board.classReach.size > MAX_CLASS_REACH) board.classReach.delete(board.classReach.keys().next().value as string);
}

/** Why units of `access` cannot drive to `to` (trip `destKey`), or null (reachable or not known yet). See REACH_CONFIRM_ORIGINS. */
export function classBlocked(board: Board, access: AccessClass, destKey: string, to: LonLat): string | null {
  const entry = board.classReach.get(reachKey(access, destKey, to));
  if (!entry || entry.reached || entry.reason === null) return null;
  if (entry.failedFrom.length >= REACH_CONFIRM_ORIGINS) return entry.reason;
  const origins = new Set(
    board.teams.filter((t) => dispatchable(t) && accessClassOf(t.kind) === access).map((t) => originKey(tripStart(board, t).from)),
  );
  return [...origins].every((o) => entry.failedFrom.includes(o)) ? entry.reason : null;
}

/**
 * A unit's trip to `to` (trip `destKey`) as known now: by its road leg (turnout + drive), by the
 * ASSUMPTION straight-line estimate while that leg is not known, or none (its own leg failed, or
 * its access class cannot reach the target, classWide).
 */
export type LegStatus =
  | { route: "road" | "estimate"; minutes: number }
  | { route: "none"; reason: string; classWide: boolean };

export function legStatus(board: Board, team: Team, destKey: string, to: LonLat): LegStatus {
  const start = tripStart(board, team);
  const from = start.from;
  const lead = start.turnoutMin + start.leadMin;
  const key = travelKey(team, from, destKey, to);
  const leg = board.travel.get(key);
  if (leg) return { route: "road", minutes: lead + leg.driveMinutes };
  const own = board.noRoute.get(key);
  if (own) return { route: "none", reason: own, classWide: false };
  const blocked = classBlocked(board, accessClassOf(team.kind), destKey, to);
  if (blocked) return { route: "none", reason: blocked, classWide: true };
  return { route: "estimate", minutes: lead + fallbackDriveMinutes(from, to) };
}

/** An access class on the board that cannot reach a target, with the unit kinds it covers and the router's reason. */
export interface UnreachableClass {
  access: AccessClass;
  kinds: DemoApparatusKind[];
  reason: string;
}

/** Access classes of the board's units that cannot reach `to` (trip `destKey`), in a fixed order. */
export function unreachableClasses(board: Board, destKey: string, to: LonLat): UnreachableClass[] {
  const kinds = new Map<AccessClass, DemoApparatusKind[]>();
  for (const t of board.teams) {
    const access = accessClassOf(t.kind);
    const list = kinds.get(access) ?? [];
    if (!list.includes(t.kind)) list.push(t.kind);
    kinds.set(access, list);
  }
  return [...kinds.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([access, ks]) => {
      const reason = classBlocked(board, access, destKey, to);
      return reason ? [{ access, kinds: [...ks].sort(), reason }] : [];
    });
}

/**
 * ASSUMPTION estimate of a drive not yet routed: straight line x FALLBACK_CIRCUITY at
 * FALLBACK_SPEED_KMH. Only for options and ETAs shown before the road time is known; units
 * never move on it (they wait at base until their road route arrives).
 */
export function fallbackDriveMinutes(from: LonLat, to: LonLat): number {
  return ((distanceM(from, to) * FALLBACK_CIRCUITY) / (FALLBACK_SPEED_KMH * 1000)) * 60;
}

/** Minutes from dispatch to arrival at `to`: turnout plus the road leg, or the estimate. */
export function travelMinutesTo(board: Board, team: Team, destKey: string, to: LonLat): number {
  const { from, leadMin, turnoutMin } = tripStart(board, team);
  const leg = board.travel.get(travelKey(team, from, destKey, to));
  return turnoutMin + leadMin + (leg ? leg.driveMinutes : fallbackDriveMinutes(from, to));
}

/** Minutes from dispatch to on scene for direct attack: turnout plus the road leg, or the estimate. */
export function travelMinutes(board: Board, team: Team, fire: Fire): number {
  return travelMinutesTo(board, team, fire.id, crewTarget(fire));
}

function along(line: LonLat[], u: number): LonLat {
  if (line.length === 1) return line[0];
  const lengths = line.slice(1).map((p, i) => distanceM(line[i], p));
  const total = lengths.reduce((s, l) => s + l, 0);
  let left = Math.min(1, Math.max(0, u)) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] > 0 ? Math.min(1, left / lengths[i]) : 1;
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f];
    }
    left -= lengths[i];
  }
  return line[line.length - 1];
}

/** Share of its road line a moving unit has covered at board minute `minute` (0..1). */
function routeShare(team: Team, minute: number): number {
  if (team.rollAt === null || team.arriveAt === null) return 0;
  const span = team.arriveAt - team.rollAt;
  return span > 0 ? Math.min(1, Math.max(0, (minute - team.rollAt) / span)) : minute >= team.rollAt ? 1 : 0;
}

function moving(team: Team): boolean {
  return (
    (team.status === "en_route" || team.status === "returning") &&
    team.rollAt !== null &&
    team.arriveAt !== null &&
    team.route !== null &&
    team.route.length >= 2
  );
}

/**
 * Where a unit is now: en route or returning on a road line, along it after turnout (by time);
 * waiting for its road route, or otherwise, where it stands.
 */
export function teamPosition(board: Board, team: Team): LonLat {
  if (!moving(team)) return team.position;
  return along(team.route!, routeShare(team, board.minute));
}

/** The part of `line` between shares u0 <= u1 (by length), as a polyline. */
function subLine(line: LonLat[], u0: number, u1: number): LonLat[] {
  const lengths = line.slice(1).map((p, i) => distanceM(line[i], p));
  const total = lengths.reduce((a, b) => a + b, 0);
  const out: LonLat[] = [along(line, u0)];
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    acc += lengths[i];
    const u = total > 0 ? acc / total : 1;
    if (u > u0 && u < u1) out.push(line[i + 1]);
  }
  out.push(along(line, u1));
  return out;
}

/** A returning unit's trips are keyed from where it was at the start of this many board minutes (so its road legs are reused). */
export const RETURN_KEY_MINUTES = 5;
/** A unit with no road route home asks again after this many board minutes (the fire may have moved off the road). */
export const RETURN_RETRY_MINUTES = 10;
/** A released unit this close to its station is back (metres). */
const AT_STATION_M = 50;

/**
 * Where a unit's next trip starts, for its road leg key: `from` (rounded into travelKey), the
 * minutes and road line from where it is now back to `from` (`leadMin`, `lead`: a returning unit
 * turns around and drives back along its return road to where it was at the start of the
 * current RETURN_KEY_MINUTES bucket), and its turnout (none for a unit already on the road
 * home). A unit en route or on scene starts from where it is, after turnout, as before.
 */
export interface TripStart {
  from: LonLat;
  leadMin: number;
  lead: LonLat[];
  turnoutMin: number;
}

/** `withLead`: also build the `lead` line (only dispatch needs it; otherwise []). */
export function tripStart(board: Board, team: Team, withLead = false): TripStart {
  const here = teamPosition(board, team);
  if (team.status !== "returning") return { from: here, leadMin: 0, lead: [], turnoutMin: turnoutMinutes(team.kind) };
  if (!moving(team) || board.minute <= team.rollAt!) return { from: here, leadMin: 0, lead: [], turnoutMin: 0 };
  const bucket = Math.max(team.rollAt!, Math.floor((board.minute + 1e-6) / RETURN_KEY_MINUTES) * RETURN_KEY_MINUTES);
  const u0 = routeShare(team, bucket);
  const u1 = routeShare(team, board.minute);
  if (u1 <= u0) return { from: here, leadMin: 0, lead: [], turnoutMin: 0 };
  const lead = withLead ? subLine(team.route!, u0, u1).reverse() : [];
  return { from: along(team.route!, u0), leadMin: board.minute - bucket, lead, turnoutMin: 0 };
}

/** The drawn and driven line of a leg: its road line, then the short walk-in from the road end to the target. */
function roadLine(leg: TravelLeg, target: LonLat): LonLat[] {
  const end = leg.line[leg.line.length - 1];
  return end && distanceM(end, target) > 1 ? [...leg.line, target] : leg.line;
}

/** Takes a unit off its assignment and trip, free where it stands (dispatch reassigns from there). */
function detach(board: Board, team: Team): void {
  team.position = teamPosition(board, team);
  team.status = "available";
  team.fireId = null;
  team.lineId = null;
  team.legKey = null;
  team.departAt = team.rollAt = team.arriveAt = team.returnRetryAt = null;
  team.target = team.route = null;
  team.travel = null;
}

/** A unit's status read afresh (after a call that changed it, which TypeScript's narrowing does not see). */
const statusOf = (team: Team): TeamStatus => team.status;

function homeStation(board: Board, team: Team): Station | undefined {
  return board.stations.find((s) => s.id === team.station);
}

/**
 * Releases a unit (line finished, fire out, release_crew, a trip with no road route): it leaves
 * its assignment and drives back to its home station on a road leg (status `returning`), or is
 * `available` at once when already there.
 */
function release(board: Board, team: Team): void {
  detach(board, team);
  const home = homeStation(board, team);
  if (!home || distanceM(team.position, home.location) <= AT_STATION_M) {
    if (home) team.position = home.location;
    return;
  }
  startReturnTrip(board, team, `home:${home.id}`);
}

/**
 * Starts (or retries) the drive home from where the unit stands, trip `destKey`: on its road leg
 * when known (crew_routes, class-aware, an off-network end as road_offboard), else it waits there
 * (`pending`) until the page fetches it. Never a straight-line drive.
 */
function startReturnTrip(board: Board, team: Team, destKey: string): void {
  const home = homeStation(board, team)!;
  const key = travelKey(team, team.position, destKey, home.location);
  const leg = board.travel.get(key);
  team.status = "returning";
  team.fireId = null;
  team.lineId = null;
  team.target = home.location;
  team.legKey = key;
  team.departAt = team.rollAt = board.minute;
  team.returnRetryAt = null;
  team.route = leg ? roadLine(leg, home.location) : null;
  team.travel = leg ? leg.basis : "pending";
  // While pending, arriveAt is only the ASSUMPTION estimate shown; the unit does not move on it.
  team.arriveAt = board.minute + (leg ? leg.driveMinutes : fallbackDriveMinutes(team.position, home.location));
  const why = board.noRoute.get(key);
  if (why) returnFailed(board, team, why);
}

/** No road route home (`reason`): the unit waits where it is, still returning, and asks again after RETURN_RETRY_MINUTES. */
function returnFailed(board: Board, team: Team, reason: string): void {
  team.legKey = null;
  team.route = null;
  team.travel = "pending";
  team.arriveAt = null;
  team.returnRetryAt = board.minute + RETURN_RETRY_MINUTES;
  log(
    board,
    "team",
    "board",
    `${team.id} has no road route back to ${homeStation(board, team)?.name ?? team.station} (${reason.replace(/_/g, " ")}); it waits where it is and tries again in ${RETURN_RETRY_MINUTES} min.`,
  );
}

/** Returning units: arrival at the station, and retries of a drive home that had no road route. */
function stepReturns(board: Board): void {
  for (const team of board.teams) {
    if (team.status !== "returning") continue;
    if (team.returnRetryAt !== null) {
      if (team.returnRetryAt <= board.minute + 1e-6) startReturnTrip(board, team, `home:${team.station}@${Math.round(board.minute)}`);
      continue;
    }
    if (team.travel === "pending" || team.arriveAt === null || team.arriveAt > board.minute) continue;
    const home = homeStation(board, team);
    detach(board, team);
    if (home) team.position = home.location;
    log(board, "team", "board", `${team.id} is back at ${home?.name ?? team.station} and available.`);
  }
}

/**
 * A road leg arrived for `key`. Units dispatched (or released) on that trip and waiting for it
 * set off along the road line, timed from their dispatch: rollAt (departure + turnout; the
 * release itself for a drive home) + road minutes.
 */
export function applyTravelLeg(board: Board, key: string, leg: TravelLeg): void {
  board.travel.set(key, leg);
  noteReach(board, key, null);
  if (board.travel.size > 2000) board.travel.delete(board.travel.keys().next().value as string);
  for (const team of board.teams) {
    if ((team.status !== "en_route" && team.status !== "returning") || team.travel !== "pending" || team.legKey !== key) continue;
    if (team.rollAt === null || !team.target) continue;
    team.arriveAt = team.rollAt + leg.driveMinutes;
    team.route = roadLine(leg, team.target);
    team.travel = leg.basis;
  }
}

/**
 * The road router found no route for trip `key` (`reason`): units waiting to set off on it are
 * released (they drive home, or stay free at their station); a unit waiting for its drive home
 * waits and retries (returnFailed).
 */
export function travelLegFailed(board: Board, key: string, reason: string): void {
  board.noRoute.set(key, reason);
  if (board.noRoute.size > 2000) board.noRoute.delete(board.noRoute.keys().next().value as string);
  noteReach(board, key, reason);
  const why = reason.replace(/_/g, " ");
  for (const team of board.teams) {
    if (team.status === "returning" && team.travel === "pending" && team.legKey === key) {
      returnFailed(board, team, reason);
      continue;
    }
    if (team.status !== "en_route" || team.travel !== "pending" || team.legKey !== key) continue;
    const dest = team.lineId ? (board.lines.find((l) => l.id === team.lineId)?.plan.id ?? "its position") : "the fire";
    const fireId = team.fireId;
    release(board, team);
    log(
      board,
      "team",
      "board",
      `${team.id} has no road route to ${fireId ?? "its fire"} ${dest} (${why}); ${statusOf(team) === "returning" ? "it drives back to its station" : "it stays at its station"}.`,
    );
  }
}

// ---- attack positions and line ----

/** At most this many lines are kept; the oldest finished one goes first (its cells leave the solver). */
export const MAX_LINES = 200;

/** A position as listed: its plan (frozen at the line's when a line is under way there) and that line. */
export type AttackPosition = AttackPlan & { line: AttackLine | null };

function plansFor(board: Board, fire: Fire): AttackPlan[] {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined || fire.status !== "burning" || fire.noSpread !== null) return [];
  // Planned at a board-defined minute (the replan bucket or the solve), so it does not depend on the tick.
  // (1e-6 absorbs float drift in the accumulated clock.)
  const minute = Math.max(Math.floor((board.minute + 1e-6) / POSITION_REPLAN_MINUTES) * POSITION_REPLAN_MINUTES, field.fromMinute ?? 0);
  const cached = board.attackPlans.get(fire.id);
  if (cached && cached.field === field && cached.minute === minute) return cached.plans;
  const plans = planAttackPositions(field, board.env.landscape, s, field.originCells[s], minute, board.solver.zoneCells);
  board.attackPlans.set(fire.id, { field, minute, plans });
  return plans;
}

/** Attack positions of a burning fire now: the planned ones, with any unfinished line kept where it was laid out. */
export function attackPositions(board: Board, fire: Fire): AttackPosition[] {
  if (fire.status !== "burning") return [];
  const open = board.lines.filter((l) => l.fireId === fire.id && l.completedAt === null);
  const out: AttackPosition[] = plansFor(board, fire).map((p) => {
    const line = open.find((l) => l.plan.id === p.id) ?? null;
    return { ...(line?.plan ?? p), line };
  });
  for (const l of open) if (!out.some((o) => o.line === l)) out.push({ ...l.plan, line: l });
  return out;
}

/** Minutes until any fire reaches the position's anchor in the field (0 = burned), or null beyond the lookahead. */
export function positionEta(board: Board, plan: AttackPlan): number | null {
  const a = board.solver.field?.arrivalMinutes[plan.cell];
  if (a === undefined || !Number.isFinite(a)) return null;
  return Math.max(0, a - board.minute);
}

/** A unit's line production on a line, m/min (sourced rate at the anchor's fuel and slope). */
export function unitLineRateOn(team: Team, plan: AttackPlan): number {
  return lineMetersPerMinute(team.kind, plan.fuelCode, plan.slopePercent);
}

/** Id of the line a unit would build at `plan` (also its trip key, see travelKey). */
export function lineIdFor(fire: Fire, plan: AttackPlan): string {
  return `${fire.id}#${plan.id}@${plan.point[0].toFixed(4)},${plan.point[1].toFixed(4)}`;
}

function createLine(board: Board, fire: Fire, plan: AttackPlan): AttackLine {
  const id = lineIdFor(fire, plan);
  const existing = board.lines.find((l) => l.id === id);
  if (existing) return existing;
  const raster = rasterLine(board.env.landscape, plan.point, plan.a, plan.b, plan.aM, plan.bM);
  const line: AttackLine = {
    id,
    fireId: fire.id,
    plan,
    lengthM: plan.aM + plan.bM,
    raster,
    builtAt: new Float32Array(raster.cells.length).fill(Number.POSITIVE_INFINITY),
    holdsFt: new Float32Array(raster.cells.length),
    builtM: 0,
    startedAt: null,
    completedAt: null,
  };
  board.lines.push(line);
  if (board.lines.length > MAX_LINES) {
    const drop = board.lines.findIndex((l) => l.completedAt !== null);
    const [gone] = board.lines.splice(drop >= 0 ? drop : 0, 1);
    // An unfinished line dropped for room: its units are released (no unit points at a missing line).
    for (const t of board.teams) if (gone && t.lineId === gone.id) release(board, t);
  }
  return line;
}

/** Built extent of a line from its anchor toward each end, metres. */
export function lineBuiltExtent(line: AttackLine): { a: number; b: number } {
  return builtExtent(line.builtM, line.plan.aM, line.plan.bM);
}

/** Units on scene building `line`: total m/min and the longest flame their line holds. */
function lineWork(board: Board, line: AttackLine): { rate: number; holdsFt: number } {
  let rate = 0;
  let holdsFt = 0;
  for (const t of board.teams) {
    if (t.lineId !== line.id || t.status !== "on_scene") continue;
    rate += unitLineRateOn(t, line.plan);
    holdsFt = Math.max(holdsFt, holdsFlameFeet(t.kind));
  }
  return { rate, holdsFt };
}

/** Next built length at which the solver must see the line: the next chunk, or its end. */
function nextLineChunkM(line: AttackLine): number {
  return Math.min(line.lengthM, (Math.floor((line.builtM + 1e-6) / LINE_RESOLVE_CHUNK_M) + 1) * LINE_RESOLVE_CHUNK_M);
}

/** Builds every line over [from, from + dt] at the rate of the units on scene at `from`. */
function buildLines(board: Board, from: number, dt: number): void {
  for (const line of board.lines) {
    if (line.completedAt !== null || dt <= 0) continue;
    const { rate, holdsFt } = lineWork(board, line);
    if (rate <= 0) continue;
    const b0 = line.builtM;
    let b1 = Math.min(line.lengthM, b0 + rate * dt);
    const chunk = nextLineChunkM(line);
    if (Math.abs(b1 - chunk) < 1e-6) b1 = chunk; // the clock landed on the chunk (step)
    line.startedAt ??= from;
    const { needM } = line.raster;
    for (let k = 0; k < needM.length && needM[k] <= b1 + 1e-6; k++) {
      if (Number.isFinite(line.builtAt[k])) continue;
      line.builtAt[k] = from + Math.max(0, needM[k] - b0) / rate;
      line.holdsFt[k] = holdsFt;
    }
    line.builtM = b1;
    if (b1 >= line.lengthM - 1e-6) {
      line.builtM = line.lengthM;
      line.completedAt = from + (line.lengthM - b0) / rate;
      const crew = board.teams.filter((t) => t.lineId === line.id);
      for (const t of crew) release(board, t);
      log(
        board,
        "team",
        "board",
        `${line.fireId} ${line.plan.id}: ${Math.round(line.lengthM)} m of line finished${crew.length ? `; ${crew.map((t) => t.id).join(", ")} head back to their stations` : ""}. The line stays in the fire model.`,
      );
    }
  }
}

/** Earliest board minute after now at which a line reaches its next chunk, or a unit reaches its line. */
function nextLineEvent(board: Board): number {
  let next = Number.POSITIVE_INFINITY;
  for (const line of board.lines) {
    if (line.completedAt !== null) continue;
    const { rate } = lineWork(board, line);
    if (rate > 0) next = Math.min(next, board.minute + (nextLineChunkM(line) - line.builtM) / rate);
  }
  for (const t of board.teams) {
    if (t.lineId && t.status === "en_route" && t.travel !== "pending" && t.arriveAt !== null && t.arriveAt > board.minute) {
      next = Math.min(next, t.arriveAt);
    }
  }
  return next;
}

/**
 * The fire is held by the line: the field already includes the line built now and forecasts no
 * cell of this fire burning after now (to its horizon, at least FORECAST_MINUTES ahead).
 * Returns the minute it stopped growing, or null.
 */
function heldByLine(board: Board, fire: Fire): number | null {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined || field.lineKey !== lineKey(board)) return null;
  if (!board.lines.some((l) => l.fireId === fire.id && l.builtM > 0)) return null;
  const arrivals = field.arrivalBySource[s];
  const last = arrivals.length ? arrivals[arrivals.length - 1] : Number.NEGATIVE_INFINITY;
  return last <= board.minute ? Math.max(last, field.fromMinute ?? 0) : null;
}

/** One order option at a position: the n nearest free units that can reach it, added to those on the line. */
export interface PositionOption {
  teams: string[];
  /** Minutes until the last of these units is there. */
  arriveMin: number;
  /** "road": every unit's time is its road leg; "estimate": at least one road leg is not known yet (ASSUMPTION straight line). */
  route: "road" | "estimate";
  /** Minutes until the line is finished with the assigned units plus these; null = not within LINE_DONE_LOOK_MINUTES. */
  lineDoneMin: number | null;
}

/** Line completion estimates look this far ahead, minutes. */
export const LINE_DONE_LOOK_MINUTES = 360;

/** Minutes until `remainingM` of line is built by units arriving at `arrivals` (minutes) at `rates` (m/min), or null. */
function lineDoneIn(remainingM: number, arrivals: number[], rates: number[]): number | null {
  if (remainingM <= 0) return 0;
  const order = arrivals.map((a, i) => [a, rates[i]] as const).sort((p, q) => p[0] - q[0]);
  let built = 0;
  let rate = 0;
  for (let i = 0; i < order.length; i++) {
    const t0 = order[i][0];
    rate += order[i][1];
    const t1 = i + 1 < order.length ? order[i + 1][0] : LINE_DONE_LOOK_MINUTES;
    if (rate > 0 && built + rate * (t1 - t0) >= remainingM) {
      const t = t0 + (remainingM - built) / rate;
      return t <= LINE_DONE_LOOK_MINUTES ? t : null;
    }
    built += rate * Math.max(0, t1 - t0);
  }
  return null;
}

function lineArrival(board: Board, team: Team): number {
  if (team.status === "on_scene") return 0;
  return Math.max(0, (team.arriveAt ?? board.minute) - board.minute);
}

/** Line completion with the units already on this position (minutes), or null. */
export function positionLineDone(board: Board, pos: AttackPosition): number | null {
  const line = pos.line;
  if (!line) return null;
  const teams = board.teams.filter((t) => t.lineId === line.id);
  if (teams.length === 0) return null;
  return lineDoneIn(line.lengthM - line.builtM, teams.map((t) => lineArrival(board, t)), teams.map((t) => unitLineRateOn(t, pos)));
}

/** Trip destination id of a position (its line's id, also the travelKey destination). */
export function positionDestKey(fire: Fire, pos: AttackPosition): string {
  return pos.line?.id ?? lineIdFor(fire, pos);
}

/**
 * Dispatchable units (free, or returning to their station: timed from where they are) that can
 * reach `to` (trip `destKey`), nearest by arrival first; units with no road route there are left out.
 */
export function reachableFree(board: Board, destKey: string, to: LonLat): { team: Team; eta: number; road: boolean }[] {
  return board.teams
    .filter(dispatchable)
    .flatMap((team) => {
      const leg = legStatus(board, team, destKey, to);
      return leg.route === "none" ? [] : [{ team, eta: leg.minutes, road: leg.route === "road" }];
    })
    .sort((a, b) => a.eta - b.eta || a.team.id.localeCompare(b.team.id));
}

/** Sending the n nearest free units that can reach it (by arrival at the anchor) to a position, n = 1..max. */
export function positionOptions(board: Board, fire: Fire, pos: AttackPosition, max = 2): PositionOption[] {
  const destKey = positionDestKey(fire, pos);
  const assigned = pos.line ? board.teams.filter((t) => t.lineId === pos.line!.id) : [];
  const free = reachableFree(board, destKey, pos.point);
  const remaining = (pos.line ? pos.line.lengthM - pos.line.builtM : pos.aM + pos.bM);
  const out: PositionOption[] = [];
  for (let n = 1; n <= Math.min(max, free.length); n += 1) {
    const pick = free.slice(0, n);
    out.push({
      teams: pick.map((p) => p.team.id),
      arriveMin: Math.max(...pick.map((p) => p.eta)),
      route: pick.every((p) => p.road) ? "road" : "estimate",
      lineDoneMin: lineDoneIn(
        remaining,
        [...assigned.map((t) => lineArrival(board, t)), ...pick.map((p) => p.eta)],
        [...assigned.map((t) => unitLineRateOn(t, pos)), ...pick.map((p) => unitLineRateOn(p.team, pos))],
      ),
    });
  }
  return out;
}

/** What a busy unit is assigned to, for the log ("S1-F1", "S1-F1 head_30"). */
function assignmentLabel(board: Board, team: Team): string {
  const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
  return line ? `${line.fireId} ${line.plan.id}` : (team.fireId ?? "its assignment");
}

/**
 * Sends `team` on a trip: by its road leg when known, else it waits at base until the leg arrives.
 * A unit holds one assignment at a time, so sending a unit that is en route or on scene (on a
 * fire or a line) REASSIGNS it: it is released from that assignment first (logged), then sent.
 * Nothing changes when the new trip is refused (no road route).
 */
function dispatch(
  board: Board,
  team: Team,
  fire: Fire,
  dest: { key: string; target: LonLat; label: string; line: (() => AttackLine) | null },
  actor: "agent" | "you",
): string | null {
  const start = tripStart(board, team, true);
  const here = teamPosition(board, team);
  const status = legStatus(board, team, dest.key, dest.target);
  if (status.route === "none") {
    const why = status.reason.replace(/_/g, " ");
    return status.classWide
      ? `${team.id} (${kindShort(team.kind)}, road access ${accessClassOf(team.kind)}) cannot reach ${dest.label}: no road route for its apparatus class there (${why}).`
      : `${team.id} has no road route to ${dest.label} (${why}).`;
  }
  const returning = team.status === "returning";
  if (team.status === "en_route" || team.status === "on_scene") {
    const previous = assignmentLabel(board, team);
    detach(board, team);
    log(board, "team", actor, `${team.id} released from ${previous} to be reassigned.`);
  } else if (returning) detach(board, team);
  const line = dest.line ? dest.line() : null;
  const key = travelKey(team, start.from, dest.key, dest.target);
  const leg = board.travel.get(key);
  team.position = here;
  team.status = "en_route";
  team.fireId = fire.id;
  team.lineId = line?.id ?? null;
  team.departAt = board.minute;
  team.rollAt = board.minute + start.turnoutMin;
  team.target = dest.target;
  if (leg) {
    // A returning unit turns around: back along its road home to the trip's start, then the leg.
    team.legKey = key;
    team.route = [...start.lead, ...roadLine(leg, dest.target)];
    team.travel = leg.basis;
    team.arriveAt = team.rollAt + start.leadMin + leg.driveMinutes;
  } else {
    // Waits where it stands for the road leg from here (the page fetches it); the time shown is the estimate.
    team.legKey = travelKey(team, here, dest.key, dest.target);
    team.route = null;
    team.travel = "pending";
    team.arriveAt = team.rollAt + fallbackDriveMinutes(here, dest.target);
  }
  const eta = Math.ceil(team.arriveAt - board.minute);
  const turned = returning ? " (turned back from its return to station)" : "";
  log(
    board,
    "team",
    actor,
    leg
      ? `${team.id} (${kindShort(team.kind)}) sent to ${dest.label}${turned}, on scene in ${eta} min.`
      : `${team.id} (${kindShort(team.kind)}) sent to ${dest.label}${turned}; waiting ${returning ? "where it is" : "at its station"} for its road route (about ${eta} min estimated).`,
  );
  return null;
}

/** send_crew on a unit already en route or on scene reassigns it (released from its assignment, then sent; see dispatch). */
export type BoardOrder =
  | { type: "send_crew"; crew_id: string; fire_id: string; position_id?: string | null; reason?: string }
  | { type: "release_crew"; crew_id: string; reason?: string }
  | { type: "order_evacuation"; zone_id: string; destination_id: string; reason?: string };

/**
 * Applies one order; returns null or why it was refused. `routes` are the zones' current
 * options from POST /api/demo/routes.
 */
export function applyOrder(
  board: Board,
  order: BoardOrder,
  routes: ReadonlyMap<string, RouteOption[]>,
  actor: "agent" | "you",
): string | null {
  if (order.type === "send_crew" || order.type === "release_crew") {
    const team = board.teams.find((t) => t.id === order.crew_id);
    if (!team) return `Unknown unit ${order.crew_id}.`;
    if (order.type === "release_crew") {
      if (team.status === "available") return `${team.id} is already free.`;
      if (team.status === "returning") return `${team.id} is already returning to its station.`;
      release(board, team);
      log(
        board,
        "team",
        actor,
        statusOf(team) === "returning" ? `${team.id} released; driving back to its station.` : `${team.id} released.`,
      );
      return null;
    }
    const fire = board.fires.find((f) => f.id === order.fire_id);
    if (!fire || fire.status !== "burning") return `${order.fire_id} is not burning.`;
    const positionId = order.position_id ?? null;
    if (positionId === null) {
      if (team.fireId === fire.id && team.lineId === null) return `${team.id} is already on ${fire.id}.`;
      return dispatch(board, team, fire, { key: fire.id, target: crewTarget(fire), label: fire.id, line: null }, actor);
    }
    const pos = attackPositions(board, fire).find((p) => p.id === positionId);
    if (!pos) return `${positionId} is not an attack position of ${fire.id} now.`;
    if (positionEta(board, pos) === 0) return `Fire has already reached ${fire.id} ${positionId}.`;
    const { line: existing, ...plan } = pos;
    const id = existing?.id ?? lineIdFor(fire, plan);
    if (team.lineId === id) return `${team.id} is already on ${fire.id} ${positionId}.`;
    return dispatch(
      board,
      team,
      fire,
      {
        key: id,
        target: plan.point,
        label: `${fire.id} ${positionId} (${Math.round(plan.aM + plan.bM)} m of line)`,
        line: () => existing ?? createLine(board, fire, plan),
      },
      actor,
    );
  }
  const zone = board.zones.find((z) => z.id === order.zone_id);
  if (!zone) return `Unknown zone ${order.zone_id}.`;
  if (zone.overrunAt !== null) return `${zone.name} is already overrun.`;
  const option = routes.get(zone.id)?.find((o) => o.destination_id === order.destination_id);
  if (!option) return `No route from ${zone.name} to ${order.destination_id}.`;
  if (zone.route?.destination_id === option.destination_id && zone.orderedAt !== null) return `${zone.name} is already going there.`;
  const redirect = zone.orderedAt !== null;
  zone.orderedAt ??= board.minute;
  zone.route = option;
  log(board, "order", actor, `${redirect ? "Redirected" : "Evacuation ordered"}: ${zone.name} to ${option.name}, ${option.eta_min} min drive.`);
  return null;
}

/** Puts a fire out by hand; its units are released (they drive back to their stations). It stops spreading in the solver from now. */
export function closeFire(board: Board, fireId: string): string | null {
  const fire = board.fires.find((f) => f.id === fireId);
  if (!fire || fire.status === "out") return `${fireId} is already out.`;
  fire.status = "out";
  fire.outAt = board.minute;
  fire.closedBy = "manual";
  board.firesOutTotal += 1;
  for (const team of board.teams) if (team.fireId === fire.id) release(board, team);
  log(board, "closed", "you", `${fire.id} closed out by hand.`);
  return null;
}

// ---- households ----

/** Households with a vehicle: the only ones who can drive out. */
export function withVehicle(zone: ZoneState): number {
  return Math.max(0, zone.households - zone.noVehicle);
}

/**
 * Households with a vehicle that have left by `minute`: the larger of the ordered share
 * (ORDER_COMPLIANCE) and the fire-cue share (SHADOW_SHARE), each times the exponential
 * departure curve since its cue. ASSUMPTION: max, not sum, so an order on a zone already
 * leaving on the fire cue does not count those households twice. Frozen at overrun.
 */
export function departed(zone: ZoneState, minute: number): number {
  return Math.floor(departedExact(zone, minute));
}

/** departed() before rounding down: the departure curve itself (for traffic flows). */
function departedExact(zone: ZoneState, minute: number): number {
  const end = zone.overrunAt !== null ? Math.min(minute, zone.overrunAt) : minute;
  const ordered = zone.orderedAt === null ? 0 : ORDER_COMPLIANCE * departedShare(end - zone.orderedAt);
  const shadow = zone.shadowAt === null || zone.shadowRoute === null ? 0 : SHADOW_SHARE * departedShare(end - zone.shadowAt);
  return withVehicle(zone) * Math.max(ordered, shadow);
}

export interface ZoneCounts {
  home: number;
  enRoute: number;
  out: number;
  caught: number;
  /** Carless households still home (included in `home`): need transport. */
  noVehicleHome: number;
}

/** Out = households whose cohort's congested arrival (zone.trips) is at or before `minute`. */
export function zoneCounts(zone: ZoneState, minute: number): ZoneCounts {
  const left = departed(zone, minute);
  const out = Math.min(left, arrivedBy(zone.trips, minute));
  return {
    home: Math.max(0, zone.households - left - zone.caught),
    enRoute: left - out,
    out,
    caught: zone.caught,
    noVehicleHome: zone.overrunAt !== null ? 0 : zone.noVehicle,
  };
}

/**
 * Persons of a zone by where they are. null fields = unknown (the zone's occupants are not all
 * known), never 0. Persons follow their households: the carless households' persons
 * (needsTransportOccupants) stay home; the rest (vehicle persons) are apportioned to departed
 * households in proportion, floor(households x vehicle persons / households with a vehicle), an
 * integer that reaches all vehicle persons exactly when all households with a vehicle have left.
 * Caught persons are frozen at the overrun (zone.caughtPeople). So home + enRoute + out + caught
 * = total always. ASSUMPTION: every household with a vehicle has the zone's mean persons per such
 * household (the snapshot gives per-zone sums, not who leaves first).
 */
export interface ZonePeople {
  /** All persons of the zone; null when unknown. */
  total: number | null;
  /** Persons in households whose occupants are known, and the households whose are not. */
  known: number;
  unknownHouseholds: number;
  home: number | null;
  enRoute: number | null;
  out: number | null;
  caught: number | null;
  /** Persons of carless households still home (included in `home`): need transport. */
  needsTransportHome: number | null;
}

/** Vehicle persons of the zone's first `households` households with a vehicle (see ZonePeople). */
function vehiclePersons(zone: ZoneState, households: number): number {
  if (zone.occupants === null) return 0;
  const withCar = withVehicle(zone);
  const persons = Math.max(0, zone.occupants - (zone.needsTransportOccupants ?? 0));
  if (withCar <= 0) return 0;
  return Math.floor((Math.min(households, withCar) * persons) / withCar);
}

export function zonePeople(zone: ZoneState, minute: number): ZonePeople {
  const base = { known: zone.knownOccupants, unknownHouseholds: zone.unknownOccupantHouseholds };
  if (zone.occupants === null) {
    return { ...base, total: null, home: null, enRoute: null, out: null, caught: null, needsTransportHome: null };
  }
  const c = zoneCounts(zone, minute);
  const left = vehiclePersons(zone, c.enRoute + c.out);
  const out = vehiclePersons(zone, c.out);
  const caught = zone.caughtPeople ?? 0;
  return {
    ...base,
    total: zone.occupants,
    home: Math.max(0, zone.occupants - left - caught),
    enRoute: left - out,
    out,
    caught,
    needsTransportHome: zone.overrunAt !== null ? 0 : (zone.needsTransportOccupants ?? 0),
  };
}

/** Persons caught if the zone is overrun at `minute`: everyone not yet left (null = unknown). */
function caughtPeopleAt(zone: ZoneState, minute: number): number | null {
  if (zone.occupants === null) return null;
  return Math.max(0, zone.occupants - vehiclePersons(zone, departed(zone, minute)));
}

// ---- evacuation traffic (demo/traffic.ts) ----

/** The route a zone's households are leaving on: the order's, else the fire-cue one. */
export function activeRoute(zone: ZoneState): RouteOption | null {
  return zone.route ?? zone.shadowRoute;
}

/**
 * A departing household takes its share of the zone's evacuating vehicles: snapshot
 * `evacuating_vehicles` / households with a vehicle (the snapshot caps each household at 2, so
 * this is 1-2), or without a snapshot the drill file's zone vehicles / households with a vehicle.
 * A fully ordered zone puts ORDER_COMPLIANCE x its evacuating vehicles on the road.
 * ASSUMPTION: at least 1 (a household that drives out takes a vehicle), which only binds for
 * households whose vehicles are unknown (the snapshot counts them as not needing transport).
 */
export function vehiclesPerHousehold(zone: ZoneState): number {
  const w = withVehicle(zone);
  return w > 0 ? Math.max(1, zone.vehicles / w) : 1;
}

/** Households with a vehicle the model will still send out after `minute` (0 once overrun). */
function stillToLeave(zone: ZoneState, minute: number): number {
  if (zone.overrunAt !== null) return 0;
  const share = Math.max(
    zone.orderedAt === null ? 0 : ORDER_COMPLIANCE,
    zone.shadowAt === null || zone.shadowRoute === null ? 0 : SHADOW_SHARE,
  );
  return Math.max(0, withVehicle(zone) * share - departedExact(zone, minute));
}

/**
 * One traffic step at whole minute `m`: each zone's departures in the last minute load its route's
 * segments (veh/h), and the households that left by `m` get their arrival = m + the congested
 * route time under those loads (first in first out per zone). Deterministic: reads only the
 * analytic departure curves, so the clock's tick size does not change it.
 */
function evacuationTrafficStep(board: Board, m: number): void {
  if (board.traffic.minute !== null && m <= board.traffic.minute) return;
  const flow = new Map<string, number>();
  const zoneFlow = new Map<string, number>();
  const segments = new Map<string, RouteSegment>();
  const users = new Map<string, ZoneState[]>();
  for (const zone of board.zones) {
    const route = activeRoute(zone);
    if (!route) continue;
    for (const s of route.segments) {
      segments.set(s.id, s);
      const list = users.get(s.id) ?? [];
      if (!list.includes(zone)) list.push(zone);
      users.set(s.id, list);
    }
    const households = departedExact(zone, m) - departedExact(zone, m - TRAFFIC_STEP_MINUTES);
    const f = Math.max(0, households) * vehiclesPerHousehold(zone) * (60 / TRAFFIC_STEP_MINUTES);
    if (f <= 0) continue;
    zoneFlow.set(zone.id, f);
    for (const s of route.segments) flow.set(s.id, (flow.get(s.id) ?? 0) + f);
  }
  const { queue, cache } = segmentQueues(board, m, users, segments);
  const flowOf = (s: RouteSegment) => flow.get(s.id) ?? 0;
  const queueOf = (s: RouteSegment) => queue.get(s.id) ?? 0;
  for (const zone of board.zones) {
    const route = activeRoute(zone);
    if (!route) continue;
    const d = departed(zone, m);
    const trips = zone.trips;
    const last = trips.departed.length ? trips.departed[trips.departed.length - 1] : 0;
    if (d <= last) continue;
    recordCohort(trips, m, d, congestedMinutes(route.segments, flowOf, route.eta_min, queueOf), route.line);
  }
  board.traffic = { minute: m, flow, zoneFlow, segments, queue, queueCache: cache };
}

/** Highest departure rate a zone's curves can reach (at the cue), vehicles per minute. */
function peakDepartureRate(zone: ZoneState): number {
  const share = Math.max(
    zone.orderedAt === null ? 0 : ORDER_COMPLIANCE,
    zone.shadowAt === null || zone.shadowRoute === null ? 0 : SHADOW_SHARE,
  );
  return ((withVehicle(zone) * share) / DEPARTURE_MEAN_MINUTES) * vehiclesPerHousehold(zone);
}

/**
 * Point queue at each segment at whole minute `m`: the Lindley recursion q(t) = max(0, q(t-1) +
 * inflow(t) - capacity) per minute over the departure curves of the zones whose current route
 * uses it (static loading, as the flows). Stateless in effect: the cached recursion is continued
 * only while the same zones with the same cues load the segment, else recomputed from their
 * earliest cue, so re-keyed route ids and tick sizes give the same answer. Segments whose total
 * peak inflow never exceeds capacity have no queue and are skipped.
 */
function segmentQueues(
  board: Board,
  m: number,
  users: Map<string, ZoneState[]>,
  segments: Map<string, RouteSegment>,
): { queue: Map<string, number>; cache: TrafficState["queueCache"] } {
  const queue = new Map<string, number>();
  const cache: TrafficState["queueCache"] = new Map();
  for (const [id, zones] of users) {
    const s = segments.get(id);
    if (!s) continue;
    const perMinute = s.capacity_veh_h / 60;
    if (zones.reduce((sum, z) => sum + peakDepartureRate(z), 0) <= perMinute) continue;
    const key = zones.map((z) => `${z.id}@${z.orderedAt}:${z.shadowAt}:${z.overrunAt}`).join("|");
    const hit = board.traffic.queueCache.get(id);
    let t: number;
    let q: number;
    if (hit && hit.key === key && hit.t <= m) {
      t = hit.t;
      q = hit.q;
    } else {
      const cues = zones.flatMap((z) => [z.orderedAt, z.shadowAt].filter((v): v is number => v !== null));
      t = Math.floor(Math.min(m, ...cues));
      q = 0;
    }
    while (t < m) {
      t += 1;
      let inflow = 0;
      for (const z of zones) inflow += Math.max(0, departedExact(z, t) - departedExact(z, t - 1)) * vehiclesPerHousehold(z);
      q = Math.max(0, q + inflow - perMinute);
    }
    cache.set(id, { key, t, q });
    if (q > 0) queue.set(id, q);
  }
  return { queue, cache };
}

/** Who is on (or committed to) each road segment and destination now. Simulated. */
export interface TrafficPicture {
  /** Per zone leaving: vehicles on the road now, and those plus the vehicles still to leave. */
  zones: Map<string, { route: RouteOption; onRoad: number; committed: number }>;
  bySegment: Map<string, { onRoad: number; committed: number; zoneIds: string[] }>;
  /** Vehicles sent to each destination (arrived or on the way). */
  byDestination: Map<string, number>;
  vehiclesOnRoad: number;
}

/**
 * A vehicle counts on every segment of its route from departure to arrival (the model's static
 * loading; it overstates the vehicles still ahead of a segment).
 */
export function trafficPicture(board: Board): TrafficPicture {
  const zones: TrafficPicture["zones"] = new Map();
  const bySegment: TrafficPicture["bySegment"] = new Map();
  const byDestination = new Map<string, number>();
  let vehiclesOnRoad = 0;
  for (const zone of board.zones) {
    const route = activeRoute(zone);
    if (!route) continue;
    const vph = vehiclesPerHousehold(zone);
    const c = zoneCounts(zone, board.minute);
    const onRoad = c.enRoute * vph;
    const committed = onRoad + stillToLeave(zone, board.minute) * vph;
    zones.set(zone.id, { route, onRoad, committed });
    vehiclesOnRoad += onRoad;
    byDestination.set(route.destination_id, (byDestination.get(route.destination_id) ?? 0) + (c.enRoute + c.out) * vph);
    for (const s of route.segments) {
      const entry = bySegment.get(s.id) ?? { onRoad: 0, committed: 0, zoneIds: [] };
      entry.onRoad += onRoad;
      entry.committed += committed;
      if (!entry.zoneIds.includes(zone.id)) entry.zoneIds.push(zone.id);
      bySegment.set(s.id, entry);
    }
  }
  return { zones, bySegment, byDestination, vehiclesOnRoad };
}

/** What sending (or keeping) a zone on one route option would mean in traffic. Simulated. */
export interface EvacuationEstimate {
  freeFlowMin: number;
  /** Route time under the current loads plus this zone's own departure flow, minutes. */
  congestedEtaMin: number;
  /** Vehicles on the road now from zones whose route shares a segment with this option. */
  vehiclesOnRouteNow: number;
  /**
   * The option's segment that takes longest to pass everything committed to it (other zones'
   * vehicles on the road or still to leave on routes using it, plus this zone's) at its capacity.
   */
  bottleneck: { segment: RouteSegment; committedVehicles: number } | null;
  /** That committed load / the bottleneck's capacity, minutes; 0 without segments. */
  clearanceMin: number;
  destinationLoadVehicles: number;
  destinationCapacityVeh: number | null;
  /** coreEta - (DEPARTURE_MEAN_MINUTES + clearanceMin + congestedEtaMin); null without a core ETA. */
  marginMin: number | null;
}

export function evacuationEstimate(
  board: Board,
  picture: TrafficPicture,
  zone: ZoneState,
  option: RouteOption,
  coreEta: number | null,
): EvacuationEstimate {
  const vph = vehiclesPerHousehold(zone);
  const own = picture.zones.get(zone.id);
  const ownSegments = new Set(own?.route.segments.map((s) => s.id) ?? []);
  const ownFlowNow = board.traffic.zoneFlow.get(zone.id) ?? 0;
  // Households an order now (or the order in effect) still sends out; ORDER_COMPLIANCE > SHADOW_SHARE.
  const toLeave = zone.overrunAt !== null ? 0 : Math.max(0, withVehicle(zone) * ORDER_COMPLIANCE - departedExact(zone, board.minute));
  // An unordered zone ordered now leaves at the exponential curve's initial rate.
  const ownFlow = zone.orderedAt !== null ? ownFlowNow : Math.max(ownFlowNow, (toLeave / DEPARTURE_MEAN_MINUTES) * 60 * vph);
  const othersFlow = (s: RouteSegment) =>
    Math.max(0, (board.traffic.flow.get(s.id) ?? 0) - (ownSegments.has(s.id) ? ownFlowNow : 0));
  const congestedEtaMin = congestedMinutes(
    option.segments,
    (s) => othersFlow(s) + ownFlow,
    option.eta_min,
    (s) => board.traffic.queue.get(s.id) ?? 0,
  );

  let bottleneck: EvacuationEstimate["bottleneck"] = null;
  let clearanceMin = 0;
  const near = new Set<string>();
  for (const s of option.segments) {
    const here = picture.bySegment.get(s.id);
    for (const id of here?.zoneIds ?? []) near.add(id);
    const shares = ownSegments.has(s.id);
    const others = Math.max(0, (here?.committed ?? 0) - (shares ? (own?.committed ?? 0) : 0));
    const committed = others + toLeave * vph + (shares ? (own?.onRoad ?? 0) : 0);
    const minutes = s.capacity_veh_h > 0 ? (committed / s.capacity_veh_h) * 60 : Infinity;
    if (bottleneck === null || minutes > clearanceMin) {
      bottleneck = { segment: s, committedVehicles: committed };
      clearanceMin = minutes;
    }
  }
  let vehiclesOnRouteNow = 0;
  for (const id of near) vehiclesOnRouteNow += picture.zones.get(id)?.onRoad ?? 0;
  return {
    freeFlowMin: freeFlowMinutes(option.segments, option.eta_min),
    congestedEtaMin,
    vehiclesOnRouteNow,
    bottleneck,
    clearanceMin,
    destinationLoadVehicles: picture.byDestination.get(option.destination_id) ?? 0,
    destinationCapacityVeh: option.destination_capacity_veh,
    marginMin: coreEta === null ? null : coreEta - (DEPARTURE_MEAN_MINUTES + clearanceMin + congestedEtaMin),
  };
}

/** Route time / free-flow time under the loads of the last traffic step (1 = free-flowing). */
export function routeDelayFactor(board: Board, route: RouteOption): number {
  const free = freeFlowMinutes(route.segments, route.eta_min);
  if (!(free > 0)) return 1;
  const t = board.traffic;
  return congestedMinutes(route.segments, (s) => t.flow.get(s.id) ?? 0, route.eta_min, (s) => t.queue.get(s.id) ?? 0) / free;
}

/**
 * The worst segment at the last traffic step: the longest queue delay, else the highest volume /
 * capacity; null when no one is leaving.
 */
export function worstSegment(
  board: Board,
): { segment: RouteSegment; flowVehH: number; factor: number; queueVeh: number; queueDelayMin: number } | null {
  const t = board.traffic;
  let best: ReturnType<typeof worstSegment> = null;
  let bestScore = -Infinity;
  for (const [id, segment] of t.segments) {
    const f = t.flow.get(id) ?? 0;
    const q = t.queue.get(id) ?? 0;
    if (f <= 0 && q <= 0) continue;
    const delay = queueDelayMinutes(q, segment.capacity_veh_h);
    // Any queue outranks any free-flowing segment; then by delay, else by volume / capacity.
    const score = q > 0 ? 1e6 + delay : f / segment.capacity_veh_h;
    if (score > bestScore) {
      bestScore = score;
      best = { segment, flowVehH: f, factor: bprFactor(Math.min(f, segment.capacity_veh_h), segment.capacity_veh_h), queueVeh: q, queueDelayMin: delay };
    }
  }
  return best;
}

/** Vehicles shown per marker at least; more when many are on the road (EVACUEE_MARKERS_MAX). */
export const VEHICLES_PER_MARKER_MIN = 10;
export const EVACUEE_MARKERS_MAX = 400;

export interface EvacueeMarker {
  zoneId: string;
  at: LonLat;
  /** Direction of travel, degrees true. */
  bearing: number;
  /** Vehicles this marker stands for. */
  vehicles: number;
}

/**
 * Evacuating vehicles on the road at `board.minute`, sampled for drawing: one marker per
 * `perMarker` vehicles of a zone (at least one per zone on the road), placed along its cohort's
 * road line (POST /api/demo/routes geometry) at the share of its congested trip time elapsed.
 */
export function evacueeMarkers(board: Board, maxMarkers = EVACUEE_MARKERS_MAX): EvacueeMarker[] {
  const now = board.minute;
  let total = 0;
  for (const zone of board.zones) total += zoneCounts(zone, now).enRoute * vehiclesPerHousehold(zone);
  if (total <= 0) return [];
  const perMarker = Math.max(VEHICLES_PER_MARKER_MIN, Math.ceil(total / maxMarkers));
  const out: EvacueeMarker[] = [];
  for (const zone of board.zones) {
    const t = zone.trips;
    if (t.at.length === 0) continue;
    const vph = vehiclesPerHousehold(zone);
    let pending = 0;
    let last: EvacueeMarker | null = null;
    for (let k = 0; k < t.at.length && out.length < maxMarkers; k += 1) {
      if (t.at[k] > now || t.arriveAt[k] <= now) continue;
      pending += (t.departed[k] - (k > 0 ? t.departed[k - 1] : 0)) * vph;
      const span = t.arriveAt[k] - t.at[k];
      const p = alongLine(t.line[k], span > 0 ? (now - t.at[k]) / span : 1);
      if (!p) continue;
      last = { zoneId: zone.id, at: p.at, bearing: p.bearing, vehicles: 0 };
      while (pending >= perMarker && out.length < maxMarkers) {
        out.push({ ...last, vehicles: perMarker });
        pending -= perMarker;
      }
    }
    if (last && pending > 0 && out.length < maxMarkers) out.push({ ...last, vehicles: Math.round(pending) });
  }
  return out;
}

// ---- stepping ----

function reopenZones(board: Board): void {
  let forecast: Map<string, ZoneForecast> | null = null;
  for (const zone of board.zones) {
    if (zone.orderedAt === null && zone.overrunAt === null && zone.shadowAt === null) continue;
    const quietSince = Math.max(zone.lastFireAt ?? -Infinity, zone.orderedAt ?? -Infinity, zone.shadowAt ?? -Infinity);
    if (board.minute - quietSince < REOPEN_MINUTES) continue;
    forecast ??= zoneForecasts(board);
    if (forecast.get(zone.id)?.edgeEta !== null) continue;
    zone.orderedAt = zone.overrunAt = zone.touchedAt = zone.lastFireAt = zone.shadowAt = null;
    zone.route = zone.shadowRoute = null;
    zone.caught = 0;
    zone.caughtPeople = zone.occupants === null ? null : 0;
    zone.trips = emptyTrips();
    log(board, "zone", "board", `${zone.name} reopened: no fire near for ${REOPEN_MINUTES} min, households back home.`);
  }
}

/** Line the units on scene build per minute on this fire, and the longest flame they hold. */
function onSceneWork(board: Board, fire: Fire): { lineMPerMin: number; holdsFt: number; count: number } {
  const slope = board.env.spread.ground.slopeAt(fire.origin);
  const fuel = board.env.spread.ground.fuelCodeAt(fire.origin);
  let lineMPerMin = 0;
  let holdsFt = 0;
  let count = 0;
  for (const t of board.teams) {
    if (t.fireId !== fire.id || t.status !== "on_scene" || t.lineId !== null) continue;
    lineMPerMin += lineMetersPerMinute(t.kind, fuel, slope.slopeTangent * 100);
    holdsFt = Math.max(holdsFt, holdsFlameFeet(t.kind));
    count += 1;
  }
  return { lineMPerMin, holdsFt, count };
}

/** Whether a line holding flames up to `holdsFt` holds the fire's head now (no crown fire there). */
function lineHoldsHead(fire: Fire, holdsFt: number): boolean {
  return holdsFt > 0 && !fire.rates.crowning && fire.rates.headFlameFeet <= holdsFt;
}

/** A unit's line on this fire's fuel and slope, m/min. */
export function unitLineOn(board: Board, team: Team, fire: Fire | null): number {
  const p = fire?.origin ?? team.position;
  const slope = board.env.spread.ground.slopeAt(p);
  return lineMetersPerMinute(team.kind, board.env.spread.ground.fuelCodeAt(p), slope.slopeTangent * 100);
}

/** Fires not out whose solver source index is known: the ones that can touch zones. */
function activeSources(board: Board): Map<number, Fire> {
  const field = board.solver.field;
  const out = new Map<number, Fire>();
  if (!field) return out;
  for (const f of activeFires(board)) {
    const s = field.sourceIndex.get(f.id);
    if (s !== undefined) out.set(s, f);
  }
  return out;
}

function stepOnce(board: Board, dt: number, landOn: number | null): void {
  const wholeMinute = Math.floor(board.minute + dt) > Math.floor(board.minute);
  const from = board.minute;
  board.minute = landOn ?? board.minute + dt;
  // Line at attack positions, by the units on scene over the step (the clock lands on their arrivals).
  buildLines(board, from, board.minute - from);

  startDueIgnitions(board);

  stepReturns(board);
  for (const team of board.teams) {
    // A unit waiting for its road route has not set off.
    if (team.status !== "en_route" || team.travel === "pending" || team.arriveAt === null || team.arriveAt > board.minute) continue;
    const fire = board.fires.find((f) => f.id === team.fireId);
    if (fire && fire.status === "burning") {
      team.position = team.target ?? crewTarget(fire);
      team.status = "on_scene";
      team.departAt = team.rollAt = team.arriveAt = null;
      team.route = null;
      team.legKey = null;
      const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
      if (line && positionEta(board, line.plan) === 0) {
        log(board, "team", "board", `${team.id} reached ${fire.id} ${line.plan.id}, but fire got there first; it builds what line it can.`);
      }
    } else release(board, team);
  }

  for (const fire of board.fires) {
    refreshFire(board, fire);
    if (fire.status === "burning") {
      const work = onSceneWork(board, fire);
      // Line cannot exceed the perimeter; flank line is outflanked as the perimeter grows.
      fire.lineM = Math.min(fire.perimeterM, fire.lineM + work.lineMPerMin * dt);
      const held = heldByLine(board, fire);
      if (work.count > 0 && fire.lineM >= fire.perimeterM && lineHoldsHead(fire, work.holdsFt)) {
        fire.status = "contained";
        fire.containedAt = board.minute;
        log(board, "contained", "board", `${fire.id} contained at ${fire.areaHa.toFixed(1)} ha.`);
      } else if (held !== null) {
        // Indirect line: the solver, with the line built so far, forecasts no further spread.
        fire.status = "contained";
        fire.containedAt = held;
        const built = board.lines.filter((l) => l.fireId === fire.id).reduce((sum, l) => sum + l.builtM, 0);
        log(board, "contained", "board", `${fire.id} contained at ${fire.areaHa.toFixed(1)} ha: the fire model forecasts no further spread past its ${Math.round(built)} m of line.`);
      }
    } else if (fire.status === "contained" && fire.containedAt !== null && board.minute - fire.containedAt >= MOPUP_MINUTES) {
      fire.status = "out";
      fire.outAt = board.minute;
      fire.closedBy = "teams";
      board.firesOutTotal += 1;
      for (const team of board.teams) if (team.fireId === fire.id) release(board, team);
      log(board, "out", "board", `${fire.id} is out; its units head back to their stations.`);
    }
  }

  const kept: Fire[] = [];
  for (const fire of board.fires) {
    if (fire.status === "out" && fire.outAt !== null && board.minute - fire.outAt >= OUT_KEEP_MINUTES) {
      board.removedBurnedHa += fire.areaHa;
    } else kept.push(fire);
  }
  board.fires = kept;

  const field = board.solver.field;
  const active = activeSources(board);
  for (const zone of board.zones) {
    const za = field?.zones.get(zone.id);
    if (!za) continue;
    // Times are the solver's arrival minutes, not the step that noticed them, so they do not
    // depend on the clock's tick size.
    let touchedAt = Number.POSITIVE_INFINITY;
    for (const s of active.keys()) touchedAt = Math.min(touchedAt, za.earliestBySource[s]);
    if (touchedAt <= board.minute) {
      zone.touchedAt ??= touchedAt;
      zone.lastFireAt = board.minute;
      // Fire cue with no order: the shadow share leaves on the zone's best route, if any.
      if (zone.orderedAt === null && zone.shadowAt === null && zone.overrunAt === null) {
        const best = board.routes.get(zone.id)?.[0] ?? null;
        if (best) {
          // The cue is the arrival when it fell in this step; later (routes arrived late), now.
          zone.shadowAt = touchedAt > board.minute - dt ? touchedAt : board.minute;
          zone.shadowRoute = best;
          log(board, "zone", "board", `Fire reached ${zone.name} with no order: some households leave on their own, toward ${best.name}.`);
        }
      }
    }
    if (zone.overrunAt === null && za.coreArrival <= board.minute && active.has(za.coreSource)) {
      zone.overrunAt = za.coreArrival;
      zone.lastFireAt = board.minute;
      zone.caught = zone.households - departed(zone, zone.overrunAt);
      zone.caughtPeople = caughtPeopleAt(zone, zone.overrunAt);
      board.caughtTotal += zone.caught;
      board.caughtPeopleTotal = board.caughtPeopleTotal === null || zone.caughtPeople === null ? null : board.caughtPeopleTotal + zone.caughtPeople;
      const persons = zone.caughtPeople === null ? "persons unknown" : `${zone.caughtPeople.toLocaleString("en-US")} persons`;
      log(
        board,
        "overrun",
        "board",
        `Fire reached the core of ${zone.name}${zone.caught ? `: ${zone.caught.toLocaleString("en-US")} households (${persons}) still home${zone.noVehicle ? `, ${zone.noVehicle.toLocaleString("en-US")} of them without a vehicle` : ""}` : ""}.`,
      );
    }
  }

  if (wholeMinute) {
    evacuationTrafficStep(board, Math.floor(board.minute + 1e-9));
    reopenZones(board);
  }
}

/**
 * Advance the clock by `minutes`, in steps of at most one minute, landing exactly on each
 * scheduled Studio ignition and each hour (the station wind's boundary when no Studio fire set the wind), and on
 * each unit's arrival at an attack line and each LINE_RESOLVE_CHUNK_M of line finished. Stops (the rest is not stepped) as soon as
 * the fire field needs a new solve (fireSolveDue), so solves happen at board-defined minutes.
 */
export function step(board: Board, minutes: number): void {
  let left = minutes;
  while (left > 1e-9) {
    if (fireSolveDue(board) !== null) break;
    let dt = Math.min(MAX_STEP_MINUTES, left);
    const hour = (Math.floor(board.minute / WIND_SAMPLE_MINUTES) + 1) * WIND_SAMPLE_MINUTES;
    const next = board.scheduled[0]?.at;
    const ignition = next !== undefined && next > board.minute ? next : Infinity;
    const boundary = Math.min(hour, ignition, nextLineEvent(board));
    let landOn: number | null = null;
    if (board.minute + dt >= boundary - 1e-9) {
      dt = boundary - board.minute;
      landOn = boundary;
    }
    stepOnce(board, dt, landOn);
    left -= dt;
  }
  if (boardAssertions.enabled) {
    if (boardAssertions.throwOnFailure) assertBoardInvariants(board);
    else reportBoardInvariants(board);
  }
}

// ---- invariants (dev assertions) ----

/**
 * Dev-only checks after every step (on in Vite dev builds; a script may set them). In the page a
 * broken invariant is logged with console.error (once per message) so a live demo keeps running;
 * `throwOnFailure` makes step() throw instead (scratch checks).
 */
export const boardAssertions: { enabled: boolean; throwOnFailure: boolean } = {
  enabled: (() => {
    try {
      return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
    } catch {
      return false;
    }
  })(),
  throwOnFailure: false,
};

const reportedProblems = new Set<string>();

function reportBoardInvariants(board: Board): void {
  for (const problem of checkBoardInvariants(board)) {
    if (reportedProblems.has(problem)) continue;
    reportedProblems.add(problem);
    console.error(`Board invariant broken at minute ${board.minute.toFixed(2)}: ${problem}`);
  }
}

/**
 * What must always hold on the board, as messages ([] = all good):
 * - unit ids are unique; a free unit has no fire or line; a busy one has exactly one fire (it is
 *   in exactly one fire's crew list, never two) and, when on a line, that line is of that fire;
 * - a snapshot engine unit is an engine its station lists as available at T+0;
 * - households: home + on the road + out + caught = households per zone, all non-negative, and
 *   carless households home are at most the households home;
 * - persons (where known): home + on the road + out + caught = the zone's persons, all non-negative.
 */
export function checkBoardInvariants(board: Board): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const crewOf = new Map<string, string[]>();
  for (const fire of board.fires) {
    for (const t of board.teams) if (t.fireId === fire.id) crewOf.set(t.id, [...(crewOf.get(t.id) ?? []), fire.id]);
  }
  const engines = new Map<string, StationEngine>();
  for (const st of board.stations) for (const e of st.engines) engines.set(e.engine_id, e);
  for (const t of board.teams) {
    if (ids.has(t.id)) problems.push(`unit id ${t.id} appears twice`);
    ids.add(t.id);
    const fires = crewOf.get(t.id) ?? [];
    if (fires.length > 1) problems.push(`${t.id} is on ${fires.length} fires (${fires.join(", ")})`);
    if (t.status === "available" || t.status === "returning") {
      if (t.fireId !== null || t.lineId !== null) problems.push(`${t.id} is ${t.status} but assigned (${t.fireId} ${t.lineId})`);
      if (t.status === "returning" && (t.target === null || t.travel === null)) problems.push(`${t.id} is returning with no trip home`);
    } else if (t.fireId === null) problems.push(`${t.id} is ${t.status} with no fire`);
    if (t.lineId !== null) {
      const line = board.lines.find((l) => l.id === t.lineId);
      if (!line) problems.push(`${t.id} is on line ${t.lineId}, which is not on the board`);
      else if (line.fireId !== t.fireId) problems.push(`${t.id} builds ${line.fireId}'s line but is on ${t.fireId}`);
    }
    if (t.engineId !== null) {
      const e = engines.get(t.engineId);
      if (!e || e.status_at_start !== "available" || e.team_id !== t.id) problems.push(`${t.id} is not an engine available at T+0 (${t.engineId})`);
    }
  }
  for (const zone of board.zones) {
    const c = zoneCounts(zone, board.minute);
    if (c.home + c.enRoute + c.out + c.caught !== zone.households) {
      problems.push(`${zone.id}: households ${c.home}+${c.enRoute}+${c.out}+${c.caught} != ${zone.households}`);
    }
    if (c.home < 0 || c.enRoute < 0 || c.out < 0 || c.caught < 0) problems.push(`${zone.id}: negative household count`);
    // zoneCounts floors `home` at 0, so check the unclamped balance too.
    const left = departed(zone, board.minute);
    if (left + zone.caught > zone.households) problems.push(`${zone.id}: ${left} left + ${zone.caught} caught > ${zone.households} households`);
    if (c.noVehicleHome > c.home) problems.push(`${zone.id}: ${c.noVehicleHome} carless home > ${c.home} home`);
    const p = zonePeople(zone, board.minute);
    if (p.total !== null) {
      const parts = [p.home!, p.enRoute!, p.out!, p.caught!];
      if (parts.reduce((a, b) => a + b, 0) !== p.total) problems.push(`${zone.id}: persons ${parts.join("+")} != ${p.total}`);
      if (parts.some((v) => v < 0)) problems.push(`${zone.id}: negative person count`);
      const leftPersons = vehiclePersons(zone, left);
      if (leftPersons + (zone.caughtPeople ?? 0) > p.total) problems.push(`${zone.id}: ${leftPersons} persons left + ${zone.caughtPeople} caught > ${p.total}`);
    }
  }
  return problems;
}

/** Throws when an invariant is broken (dev assertion). */
export function assertBoardInvariants(board: Board): void {
  const problems = checkBoardInvariants(board);
  if (problems.length > 0) throw new Error(`Board invariant broken at minute ${board.minute.toFixed(2)}: ${problems.join("; ")}`);
}

// ---- stations and their engines (what the UI lists) ----

/** A station engine now: its T+0 record plus the unit's current assignment. */
export interface StationEngineNow extends StationEngine {
  /** False for committed / out-of-service engines (never on the board as units). */
  dispatchable: boolean;
  /** The unit's status now; null when not dispatchable. */
  unit_status: TeamStatus | null;
  fire_id: string | null;
  /** Attack position (AttackLine plan id) it builds line at, or null. */
  position_id: string | null;
}

export interface StationRecord {
  station: Station;
  engines: StationEngineNow[];
  /** Every board unit based here (snapshot engines and assumed units), by id. */
  unit_ids: string[];
  /** Units based here and free now. */
  units_available_now: number;
}

/** Per-station records with each engine's status at T+0 and whether its unit is dispatched now. */
export function stationRecords(board: Board): StationRecord[] {
  return board.stations.map((station) => {
    const units = board.teams.filter((t) => t.station === station.id);
    const engines = station.engines.map((e): StationEngineNow => {
      const team = e.team_id ? board.teams.find((t) => t.id === e.team_id) : undefined;
      const line = team?.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
      return {
        ...e,
        dispatchable: team !== undefined,
        unit_status: team?.status ?? null,
        fire_id: team?.fireId ?? null,
        position_id: line?.plan.id ?? null,
      };
    });
    return {
      station,
      engines,
      unit_ids: units.map((t) => t.id),
      units_available_now: units.filter((t) => t.status === "available").length,
    };
  });
}

// ---- forecasts (what the agent and the panels see) ----

export interface UnitWork {
  /** m/min on this fire. */
  lineMPerMin: number;
  /** Longest head flame its line holds, feet. */
  holdsFt: number;
}

/**
 * Minutes until units arriving at `arrivals` (minutes from now, 0 = on scene) contain `fire`,
 * or null when they never catch it within FORECAST_MINUTES. The perimeter is the solver's
 * lookahead; the head flame (and crowning) at the leading cell is taken to persist.
 * `units[i]` describes arrival i.
 */
export function containedIn(board: Board, fire: Fire, arrivals: number[], units: UnitWork[]): number | null {
  if (fire.status !== "burning") return fire.status === "contained" ? 0 : null;
  if (arrivals.length === 0) return null;
  let line = fire.lineM;
  for (let t = 1; t <= FORECAST_MINUTES; t += 1) {
    let holds = 0;
    for (let i = 0; i < arrivals.length; i += 1) {
      if (arrivals[i] < t && units[i]) {
        line += units[i].lineMPerMin;
        holds = Math.max(holds, units[i].holdsFt);
      }
    }
    const perimeter = perimeterIn(board, fire, t);
    line = Math.min(line, perimeter);
    if (holds > 0 && line >= perimeter && lineHoldsHead(fire, holds)) return t;
  }
  return null;
}

function teamArrival(board: Board, team: Team, fire: Fire): number {
  if (team.fireId === fire.id) {
    return team.status === "on_scene" ? 0 : Math.max(0, (team.arriveAt ?? board.minute) - board.minute);
  }
  return travelMinutes(board, team, fire);
}

function workOf(board: Board, team: Team, fire: Fire): UnitWork {
  return { lineMPerMin: unitLineOn(board, team, fire), holdsFt: holdsFlameFeet(team.kind) };
}

/** Containment estimate with the direct-attack units already assigned (units on attack lines work through the solver). */
export function currentContainment(board: Board, fire: Fire): number | null {
  const assigned = board.teams.filter((t) => t.fireId === fire.id && t.lineId === null);
  return containedIn(
    board,
    fire,
    assigned.map((t) => teamArrival(board, t, fire)),
    assigned.map((t) => workOf(board, t, fire)),
  );
}

export interface ContainOption {
  teams: string[];
  contained_in_min: number | null;
  /** "road": every unit's time is its road leg; "estimate": at least one road leg is not known yet (ASSUMPTION straight line). */
  route: "road" | "estimate";
}

/** Free units that can reach this fire's crew target, nearest first (by arrival time). */
export function nearestFree(board: Board, fire: Fire): { team: Team; eta: number; road: boolean }[] {
  return reachableFree(board, fire.id, crewTarget(fire));
}

/** Direct attack: sending the n nearest free units (n = 1..max) on top of the direct-attack units already assigned. */
export function containOptions(board: Board, fire: Fire, max = 4): ContainOption[] {
  if (fire.status !== "burning") return [];
  const assignedTeams = board.teams.filter((t) => t.fireId === fire.id && t.lineId === null);
  const assigned = assignedTeams.map((t) => teamArrival(board, t, fire));
  const assignedWork = assignedTeams.map((t) => workOf(board, t, fire));
  const free = nearestFree(board, fire);
  const out: ContainOption[] = [];
  for (let n = 1; n <= Math.min(max, free.length); n += 1) {
    const pick = free.slice(0, n);
    out.push({
      teams: pick.map((p) => p.team.id),
      route: pick.every((p) => p.road) ? "road" : "estimate",
      contained_in_min: containedIn(
        board,
        fire,
        [...assigned, ...pick.map((p) => p.eta)],
        [...assignedWork, ...pick.map((p) => workOf(board, p.team, fire))],
      ),
    });
  }
  return out;
}

export interface ZoneForecast {
  /** Minutes until fire reaches the zone (any of its cells) / its core cell; 0 = there; null = not within FORECAST_MINUTES. */
  edgeEta: number | null;
  coreEta: number | null;
}

/**
 * Fire ETAs at each zone from the solver's arrival field (earliest arrival over the zone's cells
 * and at its core). A burning fire's arrivals count only up to its estimated containment with
 * the units assigned; a contained fire's only where it has already burned.
 */
export function zoneForecasts(board: Board): Map<string, ZoneForecast> {
  const field = board.solver.field;
  const limits = new Map<number, number>();
  for (const [s, f] of activeSources(board)) {
    const stop = f.status === "contained" ? 0 : currentContainment(board, f);
    limits.set(s, Math.min(stop ?? FORECAST_MINUTES, FORECAST_MINUTES));
  }
  const eta = (arrival: number, limit: number): number | null => {
    const wait = arrival - board.minute;
    return wait <= 0 ? 0 : wait <= limit ? wait : null;
  };
  const out = new Map<string, ZoneForecast>();
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) {
      out.set(zone.id, { edgeEta: 0, coreEta: 0 });
      continue;
    }
    const za = field?.zones.get(zone.id);
    let edge: number | null = null;
    let core: number | null = null;
    if (za) {
      for (const [s, limit] of limits) {
        const e = eta(za.earliestBySource[s], limit);
        if (e !== null && (edge === null || e < edge)) edge = e;
      }
      const coreLimit = limits.get(za.coreSource);
      if (coreLimit !== undefined) core = eta(za.coreArrival, coreLimit);
    }
    out.set(zone.id, { edgeEta: edge === null ? null : Math.round(edge), coreEta: core === null ? null : Math.round(core) });
  }
  return out;
}

export interface Totals {
  households: number;
  home: number;
  enRoute: number;
  out: number;
  /** Households caught in zones still overrun now. */
  caught: number;
  /** Households caught over the whole run. */
  caughtTotal: number;
  /** Carless households home in zones a fire touches or is forecast to reach: need transport. */
  noVehicleAtRisk: number;
  /** Persons, summed over zones (zonePeople); a null field = some zone's persons are unknown. */
  people: PeopleTotals;
  burning: number;
  contained: number;
  firesOutTotal: number;
  burnedHa: number;
}

export interface PeopleTotals {
  total: number | null;
  /** Persons in households with known occupants, and households with unknown occupants. */
  known: number;
  unknownHouseholds: number;
  home: number | null;
  enRoute: number | null;
  out: number | null;
  /** Caught in zones still overrun now / over the whole run. */
  caught: number | null;
  caughtTotal: number | null;
  /** Persons of carless households home in zones a fire touches or is forecast to reach. */
  needsTransportAtRisk: number | null;
}

export function totals(board: Board, forecasts?: Map<string, ZoneForecast>): Totals {
  const t: Totals = {
    households: 0,
    home: 0,
    enRoute: 0,
    out: 0,
    caught: 0,
    caughtTotal: board.caughtTotal,
    noVehicleAtRisk: 0,
    people: {
      total: 0,
      known: 0,
      unknownHouseholds: 0,
      home: 0,
      enRoute: 0,
      out: 0,
      caught: 0,
      caughtTotal: board.caughtPeopleTotal,
      needsTransportAtRisk: 0,
    },
    burning: 0,
    contained: 0,
    firesOutTotal: board.firesOutTotal,
    burnedHa: board.removedBurnedHa,
  };
  for (const zone of board.zones) {
    const c = zoneCounts(zone, board.minute);
    t.households += zone.households;
    t.home += c.home;
    t.enRoute += c.enRoute;
    t.out += c.out;
    t.caught += c.caught;
    const atRisk = forecasts?.get(zone.id)?.edgeEta != null || zone.touchedAt !== null;
    if (atRisk) t.noVehicleAtRisk += c.noVehicleHome;
    const p = zonePeople(zone, board.minute);
    const tp = t.people;
    const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
    tp.known += p.known;
    tp.unknownHouseholds += p.unknownHouseholds;
    tp.total = add(tp.total, p.total);
    tp.home = add(tp.home, p.home);
    tp.enRoute = add(tp.enRoute, p.enRoute);
    tp.out = add(tp.out, p.out);
    tp.caught = add(tp.caught, p.caught);
    if (atRisk) tp.needsTransportAtRisk = add(tp.needsTransportAtRisk, p.needsTransportHome);
  }
  for (const fire of board.fires) {
    if (fire.status === "burning") t.burning += 1;
    else if (fire.status === "contained") t.contained += 1;
    // Each burned cell belongs to one fire, so the areas add without double counting.
    t.burnedHa += fire.areaHa;
  }
  return t;
}
