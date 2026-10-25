/**
 * Command board (Live command): a continuously running fire board on the active drill's zones
 * (Camp by default). The board starts no fires itself: fires arrive from Simulation Studio
 * (ingestStudioFire, one publish = the scenario's ignitions, wind and fuel moisture); firefighting
 * units fight them and households evacuate, on a simulation clock with no end state (24/7
 * monitoring). Pure: no React, network or LLM; every draw is seeded (the response model's stream,
 * the solver's natural variation), so the same environment, the same Studio fires ingested at the
 * same board minutes and the same orders replay the same run. See docs/adr/0047-command-demo.md,
 * docs/command-demo-realism.md and docs/response-model.md.
 *
 * Model, shown in the UI:
 * - Fire spread is the simulator's cell solver, the same one /fire and Simulation Studio run
 *   (fire/spread.ts simulateScheduledFireSpread: Rothermel 1972 surface spread with crown fire,
 *   ember spotting and structure-to-structure spread at their defaults, seeded natural variation
 *   on by default) on the drill's LANDFIRE landscape, with every board fire as a source.
 *   demo/fireField.ts holds the solve and what is read back from it; the page runs it off the
 *   main thread (useFireSolver) and the board clock holds while a required solve is pending
 *   (fireSolveDue), so a run does not depend on machine speed. A solve is required for a new
 *   fire, a contained or closed fire, a change of wind or fuel moisture (a newer Studio fire),
 *   and when the lookahead runs short; each continues from the burned state at that minute
 *   (spread.ts ResumeFrom). Wind and moisture are the newest Studio fire's (constant, as Studio
 *   runs them; StudioConditions).
 * - Response (demo/boardResponse.ts, the shared model in app/src/response/, docs/response-model.md):
 *   AI agent only: the board decides nothing itself. Once a fire is reported (seeded report delay
 *   by remoteness) the run card for its dispatch level is computed as a recommendation for the
 *   commander, and units go only when ordered (applyOrder); units build line at their sourced production rate
 *   for the fuel and slope (realism.ts lineMetersPerMinute) with the tactic the head flame allows
 *   (Hauling chart: direct within 4 ft hand tools / 8 ft engines and dozers, parallel or indirect
 *   to 11 ft, flank only above). The fire is contained when the tactic's line covers the
 *   perimeter it must enclose (the solver footprint's edge facing ground that can still burn,
 *   fireField.ts) and passes a seeded holding test; failed initial attack makes an extended-attack
 *   stage due (logged; the commander orders mutual-aid and state resources). Units have states
 *   (returning, refilling, resting, out of service). A contained fire stops spreading in the
 *   solver from its containment minute.
 * - Cell fire state and suppression (demo/suppression.ts, read through demo/fireState.ts): each
 *   burned cell burns for its crossing time plus Anderson (1969) residence time, then is burned
 *   out. Direct-attack units put out burning edge cells within reach at their line production
 *   rate (the knocked-down edge stops advancing: inert in the solver, with line around it);
 *   mop-up units put out burning cells inside a contained fire. A contained fire is out once
 *   nothing of it still burns (and MOPUP_MINUTES after containment at the earliest).
 * - The AI commander's orders (applyOrder) act on the same units and state machine: send_crew
 *   adds a unit (or an available aircraft) to a fire or reassigns it from another;
 *   release_crew sends it home; order_resources places an order; order_evacuation orders a zone
 *   out. The response model owns only the mechanics: travel, arrival, work, water, work/rest,
 *   availability, orders arriving, and the return to station after containment or release.
 * - Fires come only from Simulation Studio: each ignition of a published scenario starts at
 *   the ingest minute + its Studio start minute. No scheduled, random or hand-placed fires; a
 *   fire_seen field report only joins a fire already there (joinFieldReport, which also counts
 *   as the fire's report). Spot fires come from the solver's ember spotting and belong to the
 *   fire that threw them. At most MAX_ACTIVE_FIRES burn or smoulder at once.
 * - Households come from the drill's scenario resource snapshot (docs/scenario-snapshots.md,
 *   matched by zone id): households, occupants (persons), evacuating vehicles and the carless
 *   households that need transport. Without a snapshot (or a zone it does not list) the drill
 *   file's households and vehicles and the environment's carless counts are used, and persons
 *   are unknown. Carless households cannot drive out and stay home. Households
 *   with a vehicle leave only on an evacuation order (ORDER_COMPLIANCE of them): this board has
 *   no self-evacuation on the fire cue (a deliberate simplification, docs/command-demo-realism.md),
 *   so who leaves when is the commander's call. An order leaves now or is scheduled for a later
 *   board minute (ZoneState.pendingOrder), so zones can be staged instead of all loading the
 *   roads at once. From the minute an order takes effect each household has an exponential departure
 *   delay of mean DEPARTURE_MEAN_MINUTES (Camp, Grajdura 2022), then drives the order's route,
 *   taking the zone's evacuating vehicles / households with a vehicle each.
 *   Households home when fire reaches the zone core are caught. Persons follow their
 *   households (zonePeople); households and persons are conserved (checkBoardInvariants).
 *   "Touches" and "reaches" read the solver's arrival field over the zone's cells and at
 *   its core cell.
 * - Evacuation traffic (demo/traffic.ts): each whole minute the vehicles leaving every zone load
 *   their route's road segments; segment travel time follows the BPR volume-delay function on
 *   the drill roads' assumed capacities plus point queues, so zones sharing a road slow each
 *   other. The same per-zone vehicle flows slow fire units on shared roads
 *   (boardResponse.flowIndex, response/travel.ts).
 * - Units: with a resource snapshot, one engine unit per engine the snapshot lists as available
 *   at T+0, at its station, id = its engine_id (committed and out-of-service engines stay on the
 *   station records, not dispatchable); hand crews, dozers, aircraft and the mutual-aid pool come
 *   from the CAL FIRE facilities layer (response/fleet.ts buildFleet, assumed counts per
 *   facility). Without a snapshot the whole fleet comes from the layer; without either, the
 *   assumed ROSTER. Units drive the road network for their apparatus class (POST
 *   /api/demo/crew_routes) after their turnout, or a straight line x 1.3 while no road time is
 *   known; a unit parks where its road ends and works the edge as its reach allows
 *   (response/reach.ts).
 * - A zone that was ordered out or overrun reopens once no fire has touched it for
 *   REOPEN_MINUTES and none is forecast to; caught households stay in the running total.
 *   Fires that are out leave the board after OUT_KEEP_MINUTES (their burned ground stays).
 *
 * Units: minutes are simulation minutes from T+0; distances metres; areas hectares on output;
 * flame lengths feet (the Hauling chart's unit).
 */

import { fuelLabel } from "../fire/fuelModels";
import { simClock } from "./format";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { DEVELOPED_FUEL_CODE, cellAt, type FuelMoisture } from "../fire/spread";
import type { LonLat } from "../live/types";
import type { EngineKind, EngineStatus, ScenarioSnapshot, SnapshotBasis, SnapshotTotals, SnapshotZone } from "../live/scenarioSnapshot";
import { DRAWDOWN_KEEP_SHARE, buildFleet, engineTurnoutMinutes, type BaseInput, type Department, type Tier, type UnitSeed } from "../response/fleet";
import { MAX_ORDER_COUNT, ORDERABLE, type Orderable } from "../response/runCards";
import { buildsOn, chooseTactic, lineNeededMeters, tacticHoldsFeet, tacticRateFactor, type Tactic } from "../response/containment";
import { applyStrategyOrder, commanderTactic, type SetStrategyOrder } from "./strategyOptions";
import { uniform } from "../response/rng";
import type { WorkMode } from "../response/reach";
import { AVAILABILITY_DRAW_EVERY_MINUTES, ENGINE_WATER_USE_GPM, OUT_OF_SERVICE_MINUTES, OUT_OF_SERVICE_PROBABILITY, TANK_GALLONS } from "../response/units";
import {
  accrueContainmentLine,
  advanceContainment,
  arriveHome,
  arriveOnScene,
  createResponseState,
  dispatchAircraft,
  dispatchable,
  escalate,
  expectedArrival,
  flowIndex,
  onContained,
  placeOrder,
  reachFraction,
  isReported,
  releaseAircraftOrder,
  respondToNewFire,
  responseTick,
  unreportedRefusal,
  sendHome,
  tacticLineRate,
  teamFromSeed,
  type ResponseState,
} from "./boardResponse";
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
  burningCellCount,
  createSuppressionState,
  extinguishFire,
  hasKnockdown,
  inertCellsForSolve,
  knockdownKey,
  reportKnockdown,
  knockdownLineCells,
  suppressionTick,
  updateBurnDurations,
  type SuppressionState,
} from "./suppression";
import { congestionOnLeg, travelVariation } from "../response/travel";
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

export { dispatchable } from "./boardResponse";

/** Mean departure delay after the cue (Camp, sourced). The observation's departure figure. */
export const DEPARTURE_SPREAD_MINUTES = DEPARTURE_MEAN_MINUTES;

/**
 * ASSUMPTION (board rule, not sourced): a contained fire is out no sooner than this many minutes
 * after containment, and only once none of its cells is still burning (demo/suppression.ts:
 * burned out, or put out by mop-up).
 */
export const MOPUP_MINUTES = 10;
export const OUT_KEEP_MINUTES = 30;
export const REOPEN_MINUTES = 90;
/** Forecasts (zone fire ETAs, containment estimates) look this far ahead in the solver's lookahead. */
export const FORECAST_MINUTES = 120;
/**
 * ASSUMPTION (a board rule, not sourced): an evacuation order can be scheduled at most this many
 * minutes ahead of the board clock (order_evacuation start_minute). Twice the forecast horizon:
 * the commander can stage zones past what the fire model forecasts, not park an order for hours.
 * Mirrored in app/backend/api/demo.py MAX_SCHEDULE_AHEAD_MINUTES.
 */
export const MAX_SCHEDULE_AHEAD_MINUTES = 2 * FORECAST_MINUTES;
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
  /**
   * The Studio publish it came from: board tag ("S1"), scenario name and ignition name, and
   * reportAfterMin = Studio report_minute - start_minute: minutes after ignition the fire is
   * reported to dispatch, as the Studio user set it (an assumption); null = not set, so the
   * board models the report delay (boardResponse.ts reportFor).
   */
  studio: { tag: string; name: string; ignition: string; reportAfterMin: number | null };
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
 * Unit states (docs/response-model.md): available; en_route to a fire; on_scene building line;
 * refilling (engine off the line for water); returning home after release (can be redispatched);
 * moving_up to cover an empty station; resting (work/rest 2:1); out_of_service (seeded).
 * boardResponse.dispatchable: available, returning and moving_up units can take an order.
 */
export type TeamStatus =
  | "available"
  | "en_route"
  | "on_scene"
  | "refilling"
  | "returning"
  | "moving_up"
  | "resting"
  | "out_of_service";
/**
 * How a unit's drive is timed: on the drill roads (`road`), with an off-network leg at one end
 * (`road_offboard`), or `pending`: dispatched (or released), waiting where it stands for its road
 * route (POST /api/demo/crew_routes). Units only ever move along a road line. `straight_line` is
 * kept for the wire type only; the board no longer produces it.
 */
export type TravelBasis = "road" | "road_offboard" | "straight_line" | "pending";

export interface Team {
  /** The snapshot's engine_id for a snapshot engine (1:1); E/C/D + number for other units. */
  id: string;
  kind: DemoApparatusKind;
  /** Station.id of its home station. */
  station: string;
  /** Snapshot engine it is (`engine_id`), or null for a unit the snapshot does not list. */
  engineId: string | null;
  /** True for a unit not in the snapshot (facilities-layer units with assumed counts, the assumed roster). */
  assumed: boolean;
  /** Where the unit is, or where it set off from while moving. */
  position: LonLat;
  status: TeamStatus;
  fireId: string | null;
  departAt: number | null;
  arriveAt: number | null;
  /** Where it is driving to (the fire's anchor, its attack line's anchor point, its station, a station it covers). */
  target: LonLat | null;
  /** Road line while en route, when the road route is known. */
  route: LonLat[] | null;
  travel: TravelBasis | null;
  /** Department id (response/fleet.ts, or snapshot:<station id>) and the tier it came through. */
  department: string;
  tier: Tier;
  /** Home station location (or the board-edge entry for state resources). */
  home: LonLat;
  /** Report to rolling from rest, minutes (by staffing for engines; mobilisation for crews and dozers). */
  turnoutMinutes: number;
  /** Minute it starts moving on its current trip (after turnout). */
  rollAt: number | null;
  /** Congestion x seeded variation applied to the current trip's drive minutes. */
  travelFactor: number;
  /** Water on board, US gallons (engines; null for crews and dozers). */
  waterGallons: number | null;
  /** Minutes worked (travel and work on fires) since its last rest. */
  workMinutes: number;
  /** Rest owed when it gets home (work/rest 2:1), minutes. */
  restOwed: number;
  /** End of rest, or of refilling while refilling. */
  restUntil: number | null;
  outOfServiceUntil: number | null;
  /** Station it covers (move-up), or null. */
  coverStation: string | null;
  /** Ordered from off the board: leaves the board when released. */
  demobilise: boolean;
  /** Off-road reach on its fire (response/reach.ts): how it works, from when, how far it parked, its reach radius. */
  workMode: WorkMode | null;
  workStartAt: number | null;
  parkedM: number | null;
  reachM: number;
  /** Whether it parked at the end of a known road leg (false: straight-line estimate, parked at its target). */
  accessKnown: boolean;
  /** Returning with no road route home yet: board minute it asks for one again (RETURN_RETRY_MINUTES). */
  returnRetryAt: number | null;
  /** Fire-cut reroutes on its current trip (rerouteTeam; at most MAX_FIRE_CUT_REROUTES, then the trip is blocked). */
  fireCuts: number;
  /** Cut by fire and backing off: board minute it asks for its new road leg (REROUTE_BACKOFF_MINUTES); null otherwise. */
  rerouteAt: number | null;
  /** Its last trip was given up because fire kept cutting its road (rerouteTeam); null once it is re-tasked. */
  blockedByFire: TripBlocked | null;
  /** travelKey of the trip it is on, while en route (applyTravelLeg matches the leg by it). */
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
  /** Minute the zone's evacuation order took effect (departures start then); null = not leaving. */
  orderedAt: number | null;
  /** The route of the order in effect; null while no order is in effect. */
  route: RouteOption | null;
  /**
   * A scheduled evacuation order not yet in effect: departures start at its startMinute
   * (startScheduledEvacuations). Never set together with orderedAt or overrunAt.
   */
  pendingOrder: PendingEvacuation | null;
  /** Minute fire first touched the zone / reached its core (physics: any fire, reported or not). */
  touchedAt: number | null;
  /**
   * Minute the commander can know a fire touched the zone: the first touch by a fire that is
   * reported by then, or that fire's report minute when it touched earlier; null while only
   * unreported fires have touched it. Commander-facing views use it (zoneForecasts "reported").
   */
  knownTouchedAt: number | null;
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

/** An evacuation order scheduled for a later board minute (order_evacuation with start_minute). */
export interface PendingEvacuation {
  /** Whole board minute departures start. */
  startMinute: number;
  /** Route to the chosen destination (re-keyed to the newest routes, as a leaving zone's; setRoutes). */
  route: RouteOption;
  /** Board minute it was scheduled, and by whom. */
  issuedAt: number;
  actor: "agent" | "you";
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
  /** Facilities-layer agency, unit code and staffing (P/C/V), when known (response/fleet.ts BaseInput). */
  agency?: string;
  unit?: string | null;
  staffing?: string | null;
  /** What it fields, for the map: "Paradise FS · CAL FIRE · 2 engines, 1 dozer" (response/fleet.ts). */
  label?: string;
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
  source: "snapshot" | "facilities_layer" | "assumed_roster";
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
  bases: {
    calfireStations: Station[];
    localStations: Station[];
    crewCamps: Station[];
    /** Every facility with its layer metadata (stations, camps, air bases): the response fleet's input. */
    all: Station[];
  } | null;
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
  landscapeSource: "stored" | "cached" | "live";
  /** UTC ISO time the cached copy was stored (MongoDB landscape cache); only when `landscapeSource` is "cached". */
  landscapeCachedAt?: string;
}

export type EventKind = "ignition" | "contained" | "out" | "overrun" | "order" | "team" | "closed" | "zone" | "board" | "studio";
export interface BoardEvent {
  minute: number;
  kind: EventKind;
  /** studio = a Simulation Studio publish arriving (and its ignitions starting). */
  actor: "board" | "agent" | "you" | "studio";
  /** The audit text (the full audit log shows it as is). */
  text: string;
  /** What the event is about, as structured fields (live/activityFeedModel.ts reads these, not the text). */
  refs?: BoardEventRefs;
}

/** What a board event records; set at the log call sites in this file and in boardResponse.ts. */
export type BoardEventAction =
  | "monitoring_started"
  | "solver_failed"
  | "studio_received"
  | "ignition_skipped"
  | "ignition_not_started"
  | "ignition_started"
  | "report_joined"
  | "fire_reported"
  | "run_card"
  | "dispatched"
  | "reassigned"
  | "released"
  | "relieved"
  | "aircraft_dispatched"
  | "aircraft_over_fire"
  | "resources_ordered"
  | "order_cancelled"
  | "escalation_due"
  | "unit_access"
  | "tactic"
  /** set_strategy: the commander chose a fire's containment strategy (refs.label its name, refs.positionId for a line). */
  | "strategy_set"
  | "line_breached"
  | "line_finished"
  | "line_late"
  | "road_cut"
  /** A trip given up after MAX_FIRE_CUT_REROUTES fire-cut reroutes (model.ts rerouteTeam); the unit stops, free. */
  | "road_blocked"
  /** Controller drill road closure applied on the board (demo/roadClosures.ts): refs.label the road(s), teamIds the units rerouted, count the zones rerouted. */
  | "road_closed"
  /** A controller drill road closure lifted (demo/roadClosures.ts): refs.label the road(s). */
  | "road_reopened"
  /** No route around the closed road(s) for a zone (refs.zoneId): its leaving households wait (demo/roadClosures.ts). */
  | "no_route_closure"
  | "no_route_fire"
  | "no_route_home"
  | "no_route_cover"
  | "no_route_offboard"
  | "move_up"
  | "back_at_station"
  | "covering_station"
  | "evacuation_ordered"
  | "evacuation_redirected"
  /** An order_evacuation with a later start_minute (refs.startMinute), first time / replacing a scheduled one. */
  | "evacuation_scheduled"
  | "evacuation_rescheduled"
  /** A scheduled order cancelled before it started (cancel_evacuation). */
  | "evacuation_cancelled"
  /** A scheduled order's start minute arrived: departures begin (logged by the board). */
  | "evacuation_started"
  /** Fire first touched a zone with no order in effect (refs.startMinute when one is scheduled). Nobody leaves without an order. */
  | "zone_reached_no_order"
  | "zone_overrun"
  | "zone_reopened"
  | "contained"
  | "out"
  | "closed_by_hand"
  /** Burning edge put out by direct attack since the last report (refs.areaHa, teamIds; demo/suppression.ts). */
  | "knocked_down"
  /** Burning cells inside a contained fire put out by mop-up since the last report (refs.areaHa, teamIds). */
  | "mopped_up";

/**
 * Ids and model numbers behind a board event, as the model held them when it logged the event
 * (never parsed back out of the text). Units: minutes, hectares, metres; counts are households,
 * persons (null = unknown) and vehicles.
 */
export interface BoardEventRefs {
  action: BoardEventAction;
  fireId?: string;
  /** The zone the event is about (for an ignition, the zone it started in). */
  zoneId?: string;
  /** Board units (Team.id) or aircraft (Aircraft.id) the event concerns. */
  teamIds?: string[];
  destinationId?: string;
  stationId?: string;
  people?: number | null;
  households?: number;
  vehicles?: number;
  /** Attack position (AttackPlan.id) of a trip or a finished line. */
  positionId?: string;
  /** On-scene / over-the-fire ETA of a dispatch, or an evacuation route's drive, minutes. */
  etaMin?: number;
  /** Board minute a scheduled evacuation order starts (or was to start). */
  startMinute?: number;
  /** A dispatch waiting for its road route (etaMin is then an estimate). */
  pending?: boolean;
  areaHa?: number;
  lineM?: number;
  /** response/reach.ts WorkMode of a unit on scene (unit_access). */
  workMode?: string;
  /** Escalation stage (resources_ordered by escalation, escalation_due). */
  stage?: number;
  /** Resource orders (PendingOrder.id). */
  orderIds?: string[];
  /** What was ordered (Orderable), how many, and how many the system could not fill yet. */
  resource?: string;
  count?: number;
  unfilled?: number;
  /** Simulation Studio publish tag ("S1"). */
  studioTag?: string;
  /** fire_reported: how dispatch learned of the fire (response/report.ts ReportDelay.by) and minutes after ignition. */
  reportedBy?: "911" | "camera" | "satellite" | "field_report" | "studio";
  reportAfterMin?: number;
  /** The model's own display label for what changed (the tactic's TACTIC_LABEL). */
  label?: string;
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
  /** Run seed: the response model's stream (response/rng.ts) and the solver's natural variation derive from it. */
  seed: number;
  /** Seeded natural variation in fire spread (fire/stochastic.ts), seeded from `seed`; on by default. */
  naturalVariation: boolean;
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
  /** Latest zone routes (POST /api/demo/routes): the options an evacuation order picks from. */
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
  /** Rule-based response and resource management (demo/boardResponse.ts). */
  response: ResponseState;
  /** Per-cell burn durations and suppression (demo/suppression.ts; read through demo/fireState.ts). */
  suppression: SuppressionState;
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

const MOISTURE_IDS: readonly MoistureId[] = ["critical", "dry", "moderate", "wet"];

/**
 * The Scott & Burgan (2005) Table 1 class of the board's fuel moisture, for the response model's
 * fire-danger inputs (response/runCards.ts dispatchLevel): the Studio run's preset when it is one
 * of the four, else (a custom Studio moisture) the class whose dead 1-h moisture is nearest
 * (ASSUMPTION: 1-h moisture ranks fire danger); NO_STUDIO_MOISTURE before any Studio fire.
 */
export function boardMoistureClass(board: Board): MoistureId {
  const c = board.conditions;
  if (!c) return NO_STUDIO_MOISTURE;
  const preset = MOISTURE_IDS.find((id) => id === c.moisturePreset);
  if (preset) return preset;
  return MOISTURE_IDS.reduce((best, id) =>
    Math.abs(moistureOf(id).dead1h - c.moisture.dead1h) < Math.abs(moistureOf(best).dead1h - c.moisture.dead1h) ? id : best,
  );
}

/**
 * ASSUMPTION: the regional fire activity behind order fill probabilities (response/orders.ts
 * FILL_PROBABILITY), from the moisture class. The inverse of the mapping the board used before
 * fires came only from Studio (activity quiet = moderate, active = dry, severe = critical moisture,
 * docs/response-model.md); wet counts as quiet.
 */
export const FILL_ACTIVITY_BY_MOISTURE: Record<MoistureId, "quiet" | "active" | "severe"> = {
  wet: "quiet",
  moderate: "quiet",
  dry: "active",
  critical: "severe",
};

export function boardActivity(board: Board): "quiet" | "active" | "severe" {
  return FILL_ACTIVITY_BY_MOISTURE[boardMoistureClass(board)];
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
  // A resumed solve cannot start a fire before the minute it resumes from: a fire the field
  // has not seen yet (ignited while an earlier solve was running) starts at the resume minute.
  if (field) {
    for (const f of candidates) {
      if (!field.sourceIndex.has(f.id) && f.startMinute < board.minute) f.startMinute = Math.ceil(board.minute);
    }
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
    key: `${board.seed}|${board.naturalVariation ? "nv" : "det"}|${board.minute}|${weather.key}|${sources.map((s) => `${s.fireId}:${s.stopMinute}`).join(",")}|${lineKey(board)}`,
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
    // Cells put out by suppression spread no further (demo/suppression.ts; only with a resume).
    inertCells: field ? inertCellsForSolve(board) : null,
    // Same seed for every solve of a board, so a resumed solve repeats the same draws.
    stochastic: board.naturalVariation ? { enabled: true, seed: board.seed } : null,
  };
}

/** Turns seeded natural variation in fire spread on or off; the next solve starts over from the burned ground. */
export function setNaturalVariation(board: Board, on: boolean): void {
  board.naturalVariation = on;
}

/** Metres of a line the solver counts: whole LINE_RESOLVE_CHUNK_M chunks, or all of a finished line. */
export function lineChunkM(line: AttackLine): number {
  if (line.completedAt !== null) return line.lengthM;
  return Math.min(line.lengthM, Math.floor((line.builtM + 1e-6) / LINE_RESOLVE_CHUNK_M) * LINE_RESOLVE_CHUNK_M);
}

/** Which built line the solver should respect now; a solve echoes it (FireSolveResult.lineKey). */
export function lineKey(board: Board): string {
  const lines = board.lines
    .filter((l) => lineChunkM(l) > 0)
    .map((l) => `${l.id}:${lineChunkM(l).toFixed(1)}`)
    .join(",");
  // Direct-attack knockdown committed to the solver (demo/suppression.ts).
  const kd = knockdownKey(board);
  return kd ? `${lines}|${kd}` : lines;
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
  // Line around knocked-down edge cells (demo/suppression.ts), as the solver has it committed.
  const kd = knockdownLineCells(board);
  for (let k = 0; k < kd.cells.length; k++) {
    cells.push(kd.cells[k]);
    minutes.push(kd.minutes[k]);
    holds.push(kd.holds[k]);
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
  // How long each cell burns in this field (demo/suppression.ts); cells already burned keep theirs.
  updateBurnDurations(board);
  for (const fire of board.fires) refreshFire(board, fire);
  return true;
}

/** Records a failed solve; the clock stays held and the page retries. */
export function fireSolveFailed(board: Board, message: string): void {
  if (board.solver.error === message) return;
  board.solver.error = message;
  log(board, "board", "board", `Fire model failed: ${message}`, { action: "solver_failed" });
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

/** A board unit at `location`, free (the response model's fields at their idle values). */
function newTeam(
  id: string,
  kind: DemoApparatusKind,
  station: string,
  location: LonLat,
  engineId: string | null,
  assumed: boolean,
  department: string,
  turnout: number = turnoutMinutes(kind),
): Team {
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
    fireCuts: 0,
    rerouteAt: null,
    blockedByFire: null,
    target: null,
    route: null,
    travel: null,
    legKey: null,
    lineId: null,
    department,
    tier: "closest",
    home: location,
    turnoutMinutes: turnout,
    travelFactor: 1,
    waterGallons: TANK_GALLONS[kind] ?? null,
    workMinutes: 0,
    restOwed: 0,
    restUntil: null,
    outOfServiceUntil: null,
    coverStation: null,
    demobilise: false,
    workMode: null,
    workStartAt: null,
    parkedM: null,
    reachM: 0,
    accessKnown: false,
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
      teams.push(newTeam(`${prefix}${counters[prefix]}`, kind, station?.id ?? "", location, null, true, `roster:${station?.id ?? ""}`));
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
  /** False when the facilities layer supplies hand crews and dozers (buildBoardUnits). */
  extras = true,
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
        // Staffing is not in the snapshot: turnout as unknown staffing (response/fleet.ts engineTurnoutMinutes).
        teams.push(newTeam(e.engine_id, apparatus, s.station_id, s.location, e.engine_id, false, `snapshot:${s.station_id}`, engineTurnoutMinutes(null)));
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
  for (const { kind, count, base } of extras ? ASSUMED_EXTRA_UNITS : []) {
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
      teams.push(newTeam(id, kind, station?.id ?? "", station?.location ?? centre ?? zones[0]?.core ?? [0, 0], null, true, `assumed:${station?.id ?? ""}`));
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
    pendingOrder: null,
    touchedAt: null,
    knownTouchedAt: null,
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

/**
 * ASSUMPTION: a facilities-layer station within this distance of a snapshot station is the same
 * station; its layer engines are the snapshot's (not counted twice).
 */
export const SAME_STATION_M = 300;

/** Resource label of a board with no snapshot whose units come from the CAL FIRE facilities layer. */
export const NO_SNAPSHOT_FLEET_LABEL = "No resource snapshot for this drill — units from the CAL FIRE facilities layer (assumed counts per facility)";

const isEngineKind = (k: DemoApparatusKind) => k === "engine_t3" || k === "engine_t1";

/** Centre of the board's landscape grid [lon, lat]: where the fleet measures air bases' dispatch radius (response/fleet.ts buildFleet). */
function boardCentre(grid: LandscapeGrid): LonLat {
  return mercatorToLonLat(grid.originX + (grid.width / 2) * grid.cellSizeX, grid.originY + (grid.height / 2) * grid.cellSizeY);
}

/**
 * The board's units, stations, departments, mutual-aid pool and aircraft (filled into `board`):
 * - the response fleet (response/fleet.ts buildFleet) from the CAL FIRE facilities layer
 *   (`env.bases.all`): departments, assumed units per facility, on-board stations answering
 *   initial attack, off-board stations forming the mutual-aid pool, aircraft at their bases;
 * - with a resource snapshot, the on-board ENGINES are the snapshot's (one unit per engine
 *   available at T+0, one department per snapshot station); layer engines at a snapshot station
 *   (SAME_STATION_M) are dropped, other on-board layer engines join the pool (they answer as
 *   closest resources from off the drill's roster, response/boardResponse.ts fillCard). Hand crews
 *   and dozers come from the layer, or ASSUMED_EXTRA_UNITS without it;
 * - without a snapshot: the fleet as built (theirs), or the assumed ROSTER without the layer.
 * Seeded out-of-service at T+0 applies to the non-snapshot units only (the snapshot gives T+0).
 */
function buildBoardUnits(board: Board, zones: BaseZone[], env: DemoEnvironment, snapshot: ScenarioSnapshot | null): string[] {
  const grid = env.landscape;
  const onBoard = (p: LonLat) => cellAt(grid, { longitude: p[0], latitude: p[1] }) >= 0;
  const all = env.bases?.all ?? [];
  const fleet = buildFleet(
    all.map((s): BaseInput => ({ id: s.id, name: s.name, type: s.type, location: s.location, agency: s.agency, unit: s.unit, staffing: s.staffing })),
    onBoard,
    boardCentre(grid),
  );
  // Each facility labelled with what it fields (response/fleet.ts), for the map.
  const labelOf = new Map(fleet.facilities.map((f) => [f.id, f.label]));
  const stationOf = new Map(all.map((s) => [s.id, { ...s, label: labelOf.get(s.id) }] as const));
  board.response.facilities = fleet.facilities;
  const hasFleet = all.length > 0;
  const departments: Department[] = [];
  const pool: UnitSeed[] = [...fleet.offBoardUnits];
  const seeds: UnitSeed[] = [];
  let skipped: string[] = [];
  if (snapshot) {
    const built = snapshotTeams(zones, env, snapshot, !hasFleet);
    skipped = built.skipped;
    board.teams = built.teams;
    board.stations = built.stations;
    for (const st of built.stations) {
      if (st.source !== "snapshot") continue;
      const engines = built.teams.filter((t) => t.station === st.id && t.engineId !== null).length;
      if (engines === 0) continue;
      departments.push({
        id: `snapshot:${st.id}`,
        name: st.name,
        agencyClass: "osm",
        tier: "closest",
        stationIds: [st.id],
        engines,
        keepEngines: 0,
      });
    }
    if (!hasFleet) {
      // Assumed hand crews and dozer (no layer): one assumed department per base.
      for (const t of built.teams) {
        if (t.engineId !== null || departments.some((d) => d.id === t.department)) continue;
        departments.push({ id: t.department, name: `${ASSUMED_UNIT_LABEL}`, agencyClass: "synthetic", tier: "closest", stationIds: [t.station], engines: 0, keepEngines: 0 });
      }
    }
    const snapStations = built.stations.filter((st) => st.source === "snapshot");
    for (const u of fleet.units) {
      if (!isEngineKind(u.kind)) seeds.push(u);
      else if (!snapStations.some((st) => distanceM(st.location, u.location) <= SAME_STATION_M)) pool.push(u);
    }
  } else if (hasFleet) {
    seeds.push(...fleet.units);
  } else {
    // ROSTER fallback: each roster station is one assumed department.
    const { teams, stations } = rosterTeams(zones, env);
    board.teams = teams;
    board.stations = stations;
    for (const s of stations) {
      departments.push({
        id: `roster:${s.id}`,
        name: s.name,
        agencyClass: "synthetic",
        tier: "closest",
        stationIds: [s.id],
        engines: teams.filter((t) => t.station === s.id && isEngineKind(t.kind)).length,
        keepEngines: 0,
      });
    }
  }
  if (hasFleet) departments.push(...fleet.departments);
  board.response.departments = departments;
  board.response.pool = pool;
  for (const st of new Set(pool.map((u) => u.stationId))) {
    const station = stationOf.get(st);
    if (station) board.response.offBoardStations.set(st, station);
  }
  for (const u of seeds) {
    const team = teamFromSeed(board, u);
    board.teams.push(team);
    const st = stationOf.get(u.stationId);
    if (st && !board.stations.some((s) => s.id === st.id)) board.stations.push(st);
  }
  // Drawdown on what each department really has here (on the board and in the pool).
  for (const d of departments) {
    d.engines =
      board.teams.filter((t) => t.department === d.id && isEngineKind(t.kind)).length +
      pool.filter((u) => u.departmentId === d.id && isEngineKind(u.kind)).length;
    d.keepEngines = Math.floor(DRAWDOWN_KEEP_SHARE * d.engines);
  }
  // Seeded availability at T+0: some units start out of service (not the snapshot's engines).
  for (const t of board.teams) {
    if (t.engineId !== null) continue;
    if (uniform(board.response.rng) < OUT_OF_SERVICE_PROBABILITY) {
      t.status = "out_of_service";
      const [lo, hi] = OUT_OF_SERVICE_MINUTES;
      t.outOfServiceUntil = lo + (hi - lo) * uniform(board.response.rng);
    }
  }
  board.response.nextAvailabilityDraw = AVAILABILITY_DRAW_EVERY_MINUTES;
  board.response.label = hasFleet ? fleet.label : "Fixed roster (assumed): CAL FIRE facilities metadata unavailable";
  return skipped;
}

export function createBoard(zones: BaseZone[], seed: number, env: DemoEnvironment, input: BoardResourceInput = { snapshot: null }): Board {
  const snapshot = input.snapshot;
  const snapZones = new Map((snapshot?.zones ?? []).map((z) => [z.zone_id, z]));
  const zoneStates: ZoneState[] = zones.map((z) => zoneState(z, snapZones.get(z.id), env));
  const grid = env.landscape;
  const onBoard = (p: LonLat) => cellAt(grid, { longitude: p[0], latitude: p[1] }) >= 0;
  const fleetAircraft = buildFleet(
    (env.bases?.all ?? []).map((s): BaseInput => ({ id: s.id, name: s.name, type: s.type, location: s.location, agency: s.agency, unit: s.unit, staffing: s.staffing })),
    onBoard,
    boardCentre(grid),
  ).aircraft;
  const board: Board = {
    seed,
    naturalVariation: true,
    minute: 0,
    fireCount: 0,
    fires: [],
    teams: [],
    stations: [],
    snapshot: null,
    snapshotInput: snapshot,
    resources: { source: "assumed_roster", label: NO_SNAPSHOT_LABEL, problem: null, engineUnits: 0, assumedUnits: 0, assumedLabel: ASSUMED_UNIT_LABEL },
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
    // The board clock's T+0 is the drill's (snapshot scenario_time), else the wind series' start.
    response: createResponseState(seed, [], [], [], fleetAircraft, onBoard, snapshot?.scenario_time ?? env.spread.wind.startUtc, ""),
    suppression: createSuppressionState(grid.width * grid.height),
  };
  const skipped = buildBoardUnits(board, zones, env, snapshot);
  const teams = board.teams;
  const engineUnits = teams.filter((t) => t.engineId !== null).length;
  const assumedUnits = teams.length - engineUnits;
  board.snapshot = snapshot ? snapshotSummary(snapshot, zoneStates) : null;
  const pool = board.response.pool.length;
  const hasFleet = (env.bases?.all?.length ?? 0) > 0;
  board.resources = snapshot
    ? {
        source: "snapshot",
        label: `Resource snapshot ${snapshot.snapshot_id} (synthetic engines; see basis): ${engineUnits} of ${snapshot.totals.engines_total} engines available at T+0 at ${board.stations.filter((s) => s.source === "snapshot").length} stations; ${assumedUnits} hand crew and dozer units ${hasFleet ? "from the CAL FIRE facilities layer (assumed counts per facility)" : ASSUMED_UNIT_LABEL}; ${pool} units in the mutual-aid pool`,
        problem: skipped.length ? `Engines not on the board: ${skipped.join(", ")}` : null,
        engineUnits,
        assumedUnits,
        assumedLabel: ASSUMED_UNIT_LABEL,
      }
    : {
        source: hasFleet ? "facilities_layer" : "assumed_roster",
        label: hasFleet ? NO_SNAPSHOT_FLEET_LABEL : NO_SNAPSHOT_LABEL,
        problem: input.problem ?? null,
        engineUnits: 0,
        assumedUnits,
        assumedLabel: ASSUMED_UNIT_LABEL,
      };
  const byKind = new Map<DemoApparatusKind, number>();
  for (const t of teams) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  const kinds = [...byKind].map(([k, n]) => `${n} ${kindShort(k)}${n > 1 ? "s" : ""}`).join(", ");
  const air = board.response.aircraft.length;
  log(
    board,
    "board",
    "board",
    `Monitoring started (run ${seed}). Ready: ${kinds || "no units"}${air ? `, ${air} aircraft in range` : ""}; ${pool} units in the mutual-aid pool. ${board.resources.label}${board.resources.problem ? ` (${board.resources.problem})` : ""}. No fires: a fire starts here when Simulation Studio runs a simulation for this drill.`,
    { action: "monitoring_started", teamIds: teams.map((t) => t.id) },
  );
  return board;
}

export { log as logEvent };

function log(board: Board, kind: EventKind, actor: BoardEvent["actor"], text: string, refs?: BoardEventRefs): void {
  const minute = Math.round(board.minute);
  board.events.unshift(refs ? { minute, kind, actor, text, refs } : { minute, kind, actor, text });
  if (board.events.length > MAX_EVENTS) board.events.length = MAX_EVENTS;
}

/**
 * Latest zone routes. A zone already leaving (or scheduled to) keeps its destination but follows
 * the newest route there (when the answer still offers it), so its segment ids match the other
 * zones' for the traffic model (ids are per answer).
 */
export function setRoutes(board: Board, routes: ReadonlyMap<string, RouteOption[]>): void {
  board.routes = routes;
  for (const zone of board.zones) {
    const options = routes.get(zone.id);
    if (!options) continue;
    const same = (r: RouteOption | null) => (r ? (options.find((o) => o.destination_id === r.destination_id) ?? r) : null);
    zone.route = same(zone.route);
    if (zone.pendingOrder) zone.pendingOrder.route = same(zone.pendingOrder.route) ?? zone.pendingOrder.route;
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
    { action: "ignition_started", fireId: fire.id, zoneId: zone?.id, studioTag: fire.studio.tag },
  );
  // The response model: report delay, then the run card (boardResponse.ts).
  respondToNewFire(board, fire);
  return fire;
}

/** Starts the scheduled Studio ignitions whose minute has come, earliest first. */
function startDueIgnitions(board: Board): void {
  while (board.scheduled.length > 0 && board.scheduled[0].at <= board.minute) {
    const s = board.scheduled.shift()!;
    if (!ignite(board, s.id, s.origin, s.at, s.studio)) {
      log(board, "studio", "studio", `Studio ignition ${s.id} not started: ${MAX_ACTIVE_FIRES} fires are already on the board.`, {
        action: "ignition_not_started",
        fireId: s.id,
        studioTag: s.studio.tag,
      });
    }
  }
}

/**
 * Minutes after ignition a Studio ignition is reported to dispatch as the Studio user set it
 * (report_minute - start_minute, on the Studio clock), or null when not set (modelled delay).
 * The parse layer (useStudioFires.ts) already drops a report_minute before start_minute.
 */
export function studioReportAfterMin(ign: StudioFire["ignitions"][number]): number | null {
  const report = ign.report_minute;
  if (report === null || !Number.isFinite(report)) return null;
  return Math.max(0, report - ign.start_minute);
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
  let reportSet = 0;
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
      // Same offset convention as the start: the report comes report_minute - start_minute after ignition.
      studio: { tag, name: fire.name, ignition: name, reportAfterMin: studioReportAfterMin(ign) },
    });
    scheduled += 1;
    if (studioReportAfterMin(ign) !== null) reportSet += 1;
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
    }${
      reportSet > 0
        ? ` Report time set in Studio for ${reportSet === scheduled ? (scheduled === 1 ? "its ignition" : `all ${scheduled} ignitions`) : `${reportSet} of ${scheduled} ignitions`}; nobody can act on a fire before its report.`
        : ""
    }`,
    { action: "studio_received", studioTag: tag },
  );
  for (const why of skipped) log(board, "studio", "studio", `${tag}: ignition skipped, ${why}.`, { action: "ignition_skipped", studioTag: tag });
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
  // A Studio-set report time wins: a fire with one is not joined before it (the report waits and
  // is checked again on later polls), so a field report cannot make it known early.
  const near = activeFires(board).find(
    (f) => waitMinutes(board, f, coord, REPORT_JOIN_MINUTES) !== null && (isReported(board, f) || board.response.fires.get(f.id)?.report.by !== "studio"),
  );
  if (!near) return null;
  board.seenReports.push(reportId);
  if (board.seenReports.length > MAX_SEEN_REPORTS) board.seenReports.shift();
  near.reportIds.push(reportId);
  // A field report is a report: a fire the dispatch centre did not have yet is reported now (no discovery delay).
  const fr = board.response.fires.get(near.id);
  if (fr && !fr.dispatched && fr.reportAt > board.minute) {
    fr.reportAt = board.minute;
    fr.report = { ...fr.report, by: "field_report", totalMinutes: board.minute - near.ignitedAt, reason: "reported by a field report from the live drill" };
  }
  log(board, "ignition", "board", `Field report joined to ${near.id}.`, { action: "report_joined", fireId: near.id });
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
  if (leg) return { route: "road", minutes: lead + leg.driveMinutes * congestionFactor(board, leg.line) };
  const own = board.noRoute.get(key);
  if (own) return { route: "none", reason: own, classWide: false };
  const blocked = classBlocked(board, accessClassOf(team.kind), destKey, to);
  if (blocked) return { route: "none", reason: blocked, classWide: true };
  return { route: "estimate", minutes: lead + fallbackDriveMinutes(from, to) * congestionFactor(board, [from, to]) };
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

/** Evacuation-traffic congestion on a drive along `line` (response/travel.ts BPR on the board's evacuation flows; 1 = free). */
export function congestionFactor(board: Board, line: readonly LonLat[]): number {
  return congestionOnLeg(flowIndex(board), line).multiplier;
}

/**
 * Expected minutes from dispatch to arrival at `to` (trip `destKey`): turnout (from rest), the
 * lead back along a road home, and the road leg (or the ASSUMPTION estimate while it is not
 * known) times the evacuation-traffic congestion on it. No seeded variation (forecasts do not
 * consume draws).
 */
export function travelMinutesTo(board: Board, team: Team, destKey: string, to: LonLat): number {
  const { from, leadMin, turnoutMin } = tripStart(board, team);
  const leg = board.travel.get(travelKey(team, from, destKey, to));
  const drive = leg ? leg.driveMinutes : fallbackDriveMinutes(from, to);
  return turnoutMin + leadMin + drive * congestionFactor(board, leg ? leg.line : [from, to]);
}

/** Expected minutes from dispatch to on scene for direct attack (boardResponse.expectedArrival). */
export function travelMinutes(board: Board, team: Team, fire: Fire): number {
  return expectedArrival(board, team, fire);
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

const onTheRoad = (team: Team) => team.status === "en_route" || team.status === "returning" || team.status === "moving_up";

function moving(team: Team): boolean {
  return onTheRoad(team) && team.rollAt !== null && team.arriveAt !== null && team.route !== null && team.route.length >= 2;
}

/**
 * Where a unit is now: en route, returning or moving up on a road line, along it after turnout
 * (by time); waiting for its road route, or otherwise, where it stands.
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
 * minutes and road line from where it is now back to `from` (`leadMin`, `lead`: a unit on the
 * road home or moving up turns around and drives back along its road to where it was at the
 * start of the current RETURN_KEY_MINUTES bucket), and its turnout: the unit's own (by staffing,
 * response/fleet.ts) from rest at its station, none for a unit already rolling.
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
  if (team.status !== "returning" && team.status !== "moving_up") {
    return { from: here, leadMin: 0, lead: [], turnoutMin: team.status === "available" ? team.turnoutMinutes : 0 };
  }
  if (!moving(team) || board.minute <= team.rollAt!) return { from: here, leadMin: 0, lead: [], turnoutMin: 0 };
  const bucket = Math.max(team.rollAt!, Math.floor((board.minute + 1e-6) / RETURN_KEY_MINUTES) * RETURN_KEY_MINUTES);
  const u0 = routeShare(team, bucket);
  const u1 = routeShare(team, board.minute);
  if (u1 <= u0) return { from: here, leadMin: 0, lead: [], turnoutMin: 0 };
  const lead = withLead ? subLine(team.route!, u0, u1).reverse() : [];
  return { from: along(team.route!, u0), leadMin: board.minute - bucket, lead, turnoutMin: 0 };
}

/** The drawn and driven line of a leg: its road line only (a unit parks where its road ends; response/reach.ts). */
function roadLine(leg: TravelLeg): LonLat[] {
  return leg.line;
}

/** Takes a unit off its assignment and trip, free where it stands (dispatch reassigns from there). */
function detach(board: Board, team: Team): void {
  team.position = teamPosition(board, team);
  team.status = "available";
  team.fireId = null;
  team.lineId = null;
  team.legKey = null;
  team.departAt = team.rollAt = team.arriveAt = team.returnRetryAt = team.rerouteAt = null;
  team.fireCuts = 0;
  team.target = team.route = null;
  team.travel = null;
  team.workMode = team.workStartAt = team.parkedM = null;
}

/** A unit's status read afresh (after a call that changed it, which TypeScript's narrowing does not see). */
const statusOf = (team: Team): TeamStatus => team.status;

function homeStation(board: Board, team: Team): Station | undefined {
  return board.stations.find((s) => s.id === team.station);
}

/** Releases a unit (line finished, fire out, release_crew, a trip with no road route): boardResponse.sendHome, which drives it home on a road leg (driveHome). */
function release(board: Board, team: Team): void {
  sendHome(board, team);
}

/**
 * The road trip home of a released unit (boardResponse.sendHome owns the decision: its own
 * station, or the station it covers): off its assignment, then on a road leg home (status
 * `returning`), or home at once when already there (boardResponse.arriveHome: rest owed, then
 * available). Never a straight-line drive.
 */
export function driveHome(board: Board, team: Team, home: LonLat, homeId: string): void {
  detach(board, team);
  if (distanceM(team.position, home) <= AT_STATION_M) {
    team.target = home;
    arriveHome(board, team);
    return;
  }
  startRoadTrip(board, team, `home:${homeId}`, home, "returning");
}

/**
 * Starts (or retries) a drive along the roads from where the unit stands to `to`, trip
 * `destKey`: home (`returning`, rolling at once) or to cover a station (`moving_up`, after
 * turnout). On its road leg when known (crew_routes, class-aware, an off-network end as
 * road_offboard), else it waits there (`pending`) until the page fetches it.
 */
export function startRoadTrip(board: Board, team: Team, destKey: string, to: LonLat, status: "returning" | "moving_up"): void {
  const key = travelKey(team, team.position, destKey, to);
  const leg = board.travel.get(key);
  team.status = status;
  team.fireId = null;
  team.lineId = null;
  team.target = to;
  team.legKey = key;
  team.departAt = board.minute;
  team.rollAt = board.minute + (status === "moving_up" ? team.turnoutMinutes : 0);
  team.returnRetryAt = null;
  team.fireCuts = 0;
  team.rerouteAt = null;
  team.blockedByFire = null;
  team.travelFactor = 1;
  team.route = leg ? roadLine(leg) : null;
  team.travel = leg ? leg.basis : "pending";
  // While pending, arriveAt is only the ASSUMPTION estimate shown; the unit does not move on it.
  team.arriveAt = team.rollAt + (leg ? leg.driveMinutes : fallbackDriveMinutes(team.position, to));
  const why = board.noRoute.get(key);
  if (why) returnFailed(board, team, why);
}

/**
 * No road route for a drive home or a move-up (`reason`). Returning: the unit waits where it is,
 * still returning, and asks again after RETURN_RETRY_MINUTES; a unit ordered from off the board
 * (demobilise) leaves the board where it stands instead. Moving up: the move-up is dropped.
 */
function returnFailed(board: Board, team: Team, reason: string): void {
  const why = reason.replace(/_/g, " ");
  if (team.status === "moving_up") {
    log(board, "team", "board", `${team.id} has no road route to cover ${board.stations.find((s) => s.id === team.coverStation)?.name ?? "the station"} (${why}); it stays where it is.`, {
      action: "no_route_cover",
      teamIds: [team.id],
      stationId: team.coverStation ?? undefined,
    });
    team.coverStation = null;
    detach(board, team);
    return;
  }
  team.legKey = null;
  team.route = null;
  if (team.demobilise) {
    // boardResponse.responseTick removes it on "arrival" (now); nothing is drawn (no road line).
    team.travel = "road";
    team.arriveAt = board.minute;
    log(board, "team", "board", `${team.id} has no road route off the board (${why}); it is released from the board where it stands.`, {
      action: "no_route_offboard",
      teamIds: [team.id],
    });
    return;
  }
  team.travel = "pending";
  team.arriveAt = null;
  team.returnRetryAt = board.minute + RETURN_RETRY_MINUTES;
  log(
    board,
    "team",
    "board",
    `${team.id} has no road route back to ${homeStation(board, team)?.name ?? team.station} (${why}); it waits where it is and tries again in ${RETURN_RETRY_MINUTES} min.`,
    { action: "no_route_home", teamIds: [team.id], stationId: team.coverStation ?? team.station },
  );
}

/** Returning units whose drive home had no road route ask again (arrival itself is boardResponse.responseTick's). */
function stepReturns(board: Board): void {
  for (const team of board.teams) {
    if (team.status !== "returning" || team.returnRetryAt === null || team.returnRetryAt > board.minute + 1e-6 || !team.target) continue;
    const homeId = team.coverStation ?? team.station;
    startRoadTrip(board, team, `home:${homeId}@${Math.round(board.minute)}`, team.target, "returning");
  }
}

/**
 * A road leg arrived for `key`. Units dispatched (or released, or moving up) on that trip and
 * waiting for it set off along the road line, timed from their dispatch: rollAt (departure +
 * turnout; the release itself for a drive home) + road minutes x the trip's travel factor
 * (congestion x seeded variation, fixed at dispatch).
 */
export function applyTravelLeg(board: Board, key: string, leg: TravelLeg): void {
  board.travel.set(key, leg);
  noteReach(board, key, null);
  if (board.travel.size > 2000) board.travel.delete(board.travel.keys().next().value as string);
  for (const team of board.teams) {
    if (!onTheRoad(team) || team.travel !== "pending" || team.legKey !== key) continue;
    if (team.rollAt === null || !team.target) continue;
    team.rerouteAt = null;
    team.arriveAt = team.rollAt + leg.driveMinutes * team.travelFactor;
    team.route = roadLine(leg);
    team.travel = leg.basis;
  }
}

/**
 * The road router found no route for trip `key` (`reason`): units waiting to set off on it are
 * released (they drive home, or stay free at their station); a unit waiting for its drive home
 * or a move-up handles it in returnFailed.
 */
export function travelLegFailed(board: Board, key: string, reason: string): void {
  board.noRoute.set(key, reason);
  if (board.noRoute.size > 2000) board.noRoute.delete(board.noRoute.keys().next().value as string);
  noteReach(board, key, reason);
  const why = reason.replace(/_/g, " ");
  for (const team of board.teams) {
    if ((team.status === "returning" || team.status === "moving_up") && team.travel === "pending" && team.legKey === key) {
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
      { action: "no_route_fire", teamIds: [team.id], fireId: fireId ?? undefined },
    );
  }
}

/**
 * Fire-cut reroutes one trip may make (rerouteTeam); the next cut gives the trip up as blocked by
 * fire. **ASSUMPTION** (no source; a dispatcher re-tasks a unit whose road keeps burning rather
 * than let it circle): bounds the cut, wait, new leg, cut loop when the fire keeps crossing the
 * roads the router offers (the router avoids the fire's current rings, not where it is heading).
 */
export const MAX_FIRE_CUT_REROUTES = 3;
/**
 * Backoff before a cut unit asks for its k-th new road leg on a trip: (k - 1) x this many board
 * minutes (0, 3, 6 min), so a later leg is planned around a fire that has moved on. **ASSUMPTION**
 * (no source).
 */
export const REROUTE_BACKOFF_MINUTES = 3;

/** A trip given up because fire cut its road more than MAX_FIRE_CUT_REROUTES times (Team.blockedByFire). */
export interface TripBlocked {
  fireId: string;
  /** Attack line it was driving to, or null for direct attack. */
  lineId: string | null;
  /** Board minute of the cut that gave the trip up, and how many cuts the trip had (MAX_FIRE_CUT_REROUTES + 1). */
  minute: number;
  cuts: number;
  /** Where the unit stopped. */
  at: LonLat;
}

/**
 * A road through fire: an en-route unit whose road ahead has burned (boardResponse.cutRoads)
 * stops where it is. Up to MAX_FIRE_CUT_REROUTES times per trip it waits there for a new road
 * leg from there (`pending`; the page fetches it once the backoff, REROUTE_BACKOFF_MINUTES, has
 * passed, and the unit sets off from then: rollAt); the leg is always fetched afresh (any known
 * leg or no-route answer for that key predates the cut). The cut after that gives the trip up:
 * the unit is taken off its fire and stays free where it stands (`blockedByFire` set) for the
 * run card, the commander or a person to re-task. Returns what happened (null: no trip).
 */
export function rerouteTeam(board: Board, team: Team): "rerouted" | "blocked" | null {
  if (!team.target) return null;
  const here = teamPosition(board, team);
  if (team.legKey) board.travel.delete(team.legKey);
  if (team.fireCuts >= MAX_FIRE_CUT_REROUTES) {
    const blocked: TripBlocked = { fireId: team.fireId ?? "", lineId: team.lineId, minute: board.minute, cuts: team.fireCuts + 1, at: here };
    detach(board, team);
    team.blockedByFire = blocked;
    return "blocked";
  }
  team.fireCuts += 1;
  const destKey = team.lineId ?? team.fireId ?? "";
  const key = travelKey(team, here, destKey, team.target);
  board.travel.delete(key);
  board.noRoute.delete(key);
  team.position = here;
  team.rerouteAt = team.fireCuts > 1 ? board.minute + (team.fireCuts - 1) * REROUTE_BACKOFF_MINUTES : null;
  team.departAt = board.minute;
  team.rollAt = team.rerouteAt ?? board.minute;
  team.route = null;
  team.travel = "pending";
  team.legKey = key;
  team.arriveAt = team.rollAt + fallbackDriveMinutes(here, team.target) * team.travelFactor;
  return "rerouted";
}

/**
 * Whether the board is waiting on the road router for `team`'s current leg: a unit on the road
 * (dispatched, returning, moving up) whose trip is `pending` with its leg key set and not
 * backing off after a fire cut (rerouteAt). Units waiting for a retry of a drive home that had
 * no road route (returnRetryAt) have no leg key until then. Pure.
 */
export function legAwaited(board: Board, team: Team): boolean {
  return (
    onTheRoad(team) &&
    team.travel === "pending" &&
    team.legKey !== null &&
    team.target !== null &&
    !(team.rerouteAt !== null && team.rerouteAt > board.minute + 1e-6)
  );
}

/** Leg keys the board is waiting on the road router for (legAwaited), sorted. Pure. */
export function roadLegsAwaited(board: Board): string[] {
  return [...new Set(board.teams.filter((t) => legAwaited(board, t)).map((t) => t.legKey!))].sort();
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
        { action: "line_finished", fireId: line.fireId, positionId: line.plan.id, lineM: line.lengthM, teamIds: crew.map((t) => t.id) },
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
  return Math.min(next, nextTimedEvent(board));
}

/**
 * Earliest board minute after now at which a unit, aircraft, order or report changes state on
 * its own (arrivals, end of rest / refilling / out of service, start of work after a hike in,
 * an engine's tank running dry, retries, aircraft cycles, orders arriving, a fire's report).
 * step() lands on each, so these happen at the same board minute whatever the clock's tick.
 */
function nextTimedEvent(board: Board): number {
  const now = board.minute + 1e-9;
  let next = Number.POSITIVE_INFINITY;
  const at = (t: number | null | undefined) => {
    if (t !== null && t !== undefined && t > now && t < next) next = t;
  };
  for (const t of board.teams) {
    if (onTheRoad(t) && t.travel !== "pending") at(t.arriveAt);
    if (t.status === "refilling" || t.status === "resting") at(t.restUntil);
    if (t.status === "out_of_service") at(t.outOfServiceUntil);
    if (t.status === "on_scene") at(t.workStartAt);
    // boardResponse.responseTick drains water while on scene on a fire.
    if (t.status === "on_scene" && t.fireId !== null && t.waterGallons !== null && t.waterGallons > 0) at(board.minute + t.waterGallons / ENGINE_WATER_USE_GPM);
    if (t.status === "returning") at(t.returnRetryAt);
    at(t.rerouteAt);
  }
  for (const a of board.response.aircraft) {
    at(a.overFireAt);
    at(a.nextDropAt);
    at(a.returnAt);
  }
  for (const o of board.response.orders) if (o.status === "pending" || o.status === "unable_to_fill") at(o.readyAt);
  for (const f of board.fires) {
    const fr = board.response.fires.get(f.id);
    if (fr && !fr.dispatched) at(fr.reportAt);
  }
  at(board.response.nextAvailabilityDraw);
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
  // Line: attack-line cells, or the line around its knocked-down edge (demo/suppression.ts).
  if (!board.lines.some((l) => l.fireId === fire.id && l.builtM > 0) && !hasKnockdown(board, fire.id)) return null;
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

/** Where a trip goes: its destination id (travelKey), target point, log label, and the attack line it builds (null = direct attack). */
export interface TripDest {
  key: string;
  target: LonLat;
  label: string;
  line: (() => AttackLine) | null;
}

/**
 * Sends `team` on a trip (the run card, mutual-aid and state orders, send_crew: one path): by
 * its road leg when known, else it waits where it stands until the leg arrives (`pending`); it
 * only ever moves along a road line. Arrival = now + turnout (from rest) + the lead back along
 * its road home (a returning unit turns around) + road minutes x the evacuation-traffic
 * congestion on the leg x a seeded travel variation (response/travel.ts); the factor is kept so
 * a leg that arrives later times the unit consistently. A unit holds one assignment at a time,
 * so sending a unit that is en route or on scene REASSIGNS it (released from that assignment
 * first, logged). Returns null, or why it cannot go (no road route; nothing changes then).
 */
export function dispatch(board: Board, team: Team, fire: Fire, dest: TripDest, actor: BoardEvent["actor"], why = ""): string | null {
  // Report rule (boardResponse.ts): no unit goes to a fire dispatch does not have yet.
  const unreported = unreportedRefusal(board, fire, actor);
  if (unreported) return unreported;
  const start = tripStart(board, team, true);
  const here = teamPosition(board, team);
  const status = legStatus(board, team, dest.key, dest.target);
  if (status.route === "none") {
    const reason = status.reason.replace(/_/g, " ");
    return status.classWide
      ? `${team.id} (${kindShort(team.kind)}, road access ${accessClassOf(team.kind)}) cannot reach ${dest.label}: no road route for its apparatus class there (${reason}).`
      : `${team.id} has no road route to ${dest.label} (${reason}).`;
  }
  const returning = team.status === "returning" || team.status === "moving_up";
  if (team.status === "en_route" || team.status === "on_scene" || team.status === "refilling") {
    const previous = assignmentLabel(board, team);
    const previousFire = team.fireId;
    detach(board, team);
    log(board, "team", actor, `${team.id} released from ${previous} to be reassigned.`, { action: "reassigned", teamIds: [team.id], fireId: previousFire ?? undefined });
  } else if (returning) detach(board, team);
  const line = dest.line ? dest.line() : null;
  const key = travelKey(team, start.from, dest.key, dest.target);
  const leg = board.travel.get(key);
  const congestion = congestionFactor(board, leg ? leg.line : [start.from, dest.target]);
  team.travelFactor = congestion * travelVariation(board.response.rng);
  team.position = here;
  team.status = "en_route";
  team.fireId = fire.id;
  team.lineId = line?.id ?? null;
  team.coverStation = null;
  // A new trip: no fire cuts yet, and a trip given up as blocked by fire is superseded.
  team.fireCuts = 0;
  team.rerouteAt = null;
  team.blockedByFire = null;
  team.departAt = board.minute;
  team.rollAt = board.minute + start.turnoutMin;
  team.target = dest.target;
  if (leg) {
    // A returning unit turns around: back along its road home to the trip's start, then the leg.
    team.legKey = key;
    team.route = [...start.lead, ...roadLine(leg)];
    team.travel = leg.basis;
    team.arriveAt = team.rollAt + start.leadMin + leg.driveMinutes * team.travelFactor;
  } else {
    // Waits where it stands for the road leg from here (the page fetches it); the time shown is the estimate.
    team.legKey = travelKey(team, here, dest.key, dest.target);
    team.route = null;
    team.travel = "pending";
    team.arriveAt = team.rollAt + fallbackDriveMinutes(here, dest.target) * team.travelFactor;
  }
  const eta = Math.ceil(team.arriveAt - board.minute);
  const turned = returning ? " (turned back from its return to station)" : "";
  const slow = congestion > 1.05 ? `, slowed x${congestion.toFixed(1)} by evacuation traffic` : "";
  log(
    board,
    "team",
    actor,
    leg
      ? `${team.id} (${kindShort(team.kind)}) sent to ${dest.label}${why}${turned}, on scene in ${eta} min${slow}.`
      : `${team.id} (${kindShort(team.kind)}) sent to ${dest.label}${why}${turned}; waiting ${returning ? "where it is" : "at its station"} for its road route (about ${eta} min estimated${slow}).`,
    { action: "dispatched", teamIds: [team.id], fireId: fire.id, positionId: line?.plan.id, etaMin: eta, pending: !leg },
  );
  return null;
}

/** Direct attack: the trip to the fire's anchor (crewTarget). */
export function fireDest(fire: Fire): TripDest {
  return { key: fire.id, target: crewTarget(fire), label: fire.id, line: null };
}

/**
 * send_crew on a unit already en route or on scene reassigns it (released from its assignment, then sent; see dispatch).
 * order_evacuation: start_minute is the whole board minute departures start (absolute, on the
 * board clock; null / absent = now). A later minute schedules the order (ZoneState.pendingOrder);
 * re-issuing it for a scheduled zone replaces the schedule (new minute and/or destination, or now).
 * On a zone already leaving it redirects, now only. cancel_evacuation drops a scheduled order
 * that has not started (households already on the road cannot be called back).
 */
export type BoardOrder =
  | { type: "send_crew"; crew_id: string; fire_id: string; position_id?: string | null; reason?: string }
  | { type: "release_crew"; crew_id: string; reason?: string }
  | { type: "order_evacuation"; zone_id: string; destination_id: string; start_minute?: number | null; reason?: string }
  | { type: "cancel_evacuation"; zone_id: string; reason?: string }
  | { type: "order_resources"; fire_id: string; resource: Orderable; count: number; reason?: string }
  /** The fire's containment strategy, one of its strategy options (demo/strategyOptions.ts). */
  | SetStrategyOrder;

/**
 * Applies one order (the AI commander's or a person's). On /live this is the ONLY way anything is
 * dispatched, ordered, released or evacuated (boardResponse.ts: no rule-based response). send_crew
 * and release_crew also take an aircraft id from board.response.aircraft (sent from its base to
 * the fire; position_id must be null). Returns null or why it was refused. `routes` are the
 * zones' current options from POST /api/demo/routes.
 */
export function applyOrder(
  board: Board,
  order: BoardOrder,
  routes: ReadonlyMap<string, RouteOption[]>,
  actor: "agent" | "you",
): string | null {
  if (order.type === "set_strategy") return applyStrategyOrder(board, order, actor);
  if (order.type === "order_resources") {
    const fire = board.fires.find((f) => f.id === order.fire_id);
    const unreported = fire ? unreportedRefusal(board, fire, actor) : null;
    if (unreported) return unreported;
    if (!fire || fire.status !== "burning") return `${order.fire_id} is not burning.`;
    if (!(ORDERABLE as readonly string[]).includes(order.resource)) return `Unknown resource ${order.resource}.`;
    const count = Math.floor(order.count);
    if (!(count >= 1 && count <= MAX_ORDER_COUNT[order.resource])) return `count must be 1 to ${MAX_ORDER_COUNT[order.resource]} for ${order.resource}.`;
    placeOrder(board, fire, order.resource, count, actor, order.reason ?? "");
    return null;
  }
  if (order.type === "send_crew" || order.type === "release_crew") {
    const team = board.teams.find((t) => t.id === order.crew_id);
    // An aircraft id (response.aircraft): aircraft are sent and released with the same orders (direct attack only).
    const aircraft = team ? undefined : board.response.aircraft.find((a) => a.id === order.crew_id);
    if (aircraft) {
      if (order.type === "release_crew") return releaseAircraftOrder(board, aircraft, actor);
      const fire = board.fires.find((f) => f.id === order.fire_id);
      if (!fire) return `${order.fire_id} is not burning.`;
      if ((order.position_id ?? null) !== null) return `${aircraft.id} is an aircraft: it works the fire itself (position_id must be null).`;
      return dispatchAircraft(board, aircraft, fire, actor);
    }
    if (!team) return `Unknown unit ${order.crew_id}.`;
    if (order.type === "release_crew") {
      if (team.status === "returning") return `${team.id} is already returning to its station.`;
      if (team.fireId === null) return `${team.id} is not assigned to a fire.`;
      const fromFire = team.fireId;
      release(board, team);
      log(
        board,
        "team",
        actor,
        statusOf(team) === "returning" ? `${team.id} released; driving back to its station.` : `${team.id} released.`,
        { action: "released", teamIds: [team.id], fireId: fromFire },
      );
      return null;
    }
    const fire = board.fires.find((f) => f.id === order.fire_id);
    // Report rule: refused before anything else (an attack position of it is refused the same way).
    const unreported = fire ? unreportedRefusal(board, fire, actor) : null;
    if (unreported) return unreported;
    if (!fire || fire.status !== "burning") return `${order.fire_id} is not burning.`;
    if (team.status === "resting" || team.status === "out_of_service" || team.status === "refilling") {
      return `${team.id} is ${team.status.replace(/_/g, " ")} and cannot be sent.`;
    }
    const positionId = order.position_id ?? null;
    if (positionId === null) {
      if (team.fireId === fire.id && team.lineId === null) return `${team.id} is already on ${fire.id}.`;
      return dispatch(board, team, fire, fireDest(fire), actor);
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
  if (order.type === "cancel_evacuation") return cancelEvacuation(board, zone, actor);
  return orderEvacuation(board, zone, order, routes, actor);
}

/**
 * order_evacuation on one zone (see BoardOrder). start_minute is validated here: finite, rounded
 * to a whole board minute, at most MAX_SCHEDULE_AHEAD_MINUTES ahead. A start minute the clock has
 * already reached (the clock keeps running while the agent decides) means now, and the log says so.
 */
function orderEvacuation(
  board: Board,
  zone: ZoneState,
  order: Extract<BoardOrder, { type: "order_evacuation" }>,
  routes: ReadonlyMap<string, RouteOption[]>,
  actor: "agent" | "you",
): string | null {
  if (zone.overrunAt !== null) return `${zone.name} is already overrun.`;
  const option = routes.get(zone.id)?.find((o) => o.destination_id === order.destination_id);
  if (!option) return `No route from ${zone.name} to ${order.destination_id}.`;
  const raw = order.start_minute ?? null;
  if (raw !== null && !Number.isFinite(raw)) return `start_minute must be a board minute (got ${String(raw)}).`;
  const asked = raw === null ? null : Math.round(raw);
  if (asked !== null && asked > board.minute + MAX_SCHEDULE_AHEAD_MINUTES) {
    return `start_minute ${simClock(asked)} is more than ${MAX_SCHEDULE_AHEAD_MINUTES} min after the board clock (${simClock(board.minute)}).`;
  }
  // A start the clock has already reached leaves now.
  const start = asked !== null && asked > board.minute ? asked : null;
  const passed = asked !== null && start === null ? ` (its start ${simClock(asked)} had passed: leaving now)` : "";
  const refs = {
    zoneId: zone.id,
    destinationId: option.destination_id,
    etaMin: option.eta_min,
    households: zone.households,
    people: zone.occupants,
  };
  if (zone.orderedAt !== null) {
    // Leaving already: households are on the road, so only a redirect (now) is possible.
    if (start !== null) return `${zone.name} is already leaving (since ${simClock(zone.orderedAt)}); it can only be redirected now (no start_minute).`;
    if (zone.route?.destination_id === option.destination_id) return `${zone.name} is already going there.`;
    zone.route = option;
    log(board, "order", actor, `Redirected: ${zone.name} to ${option.name}, ${option.eta_min} min drive.`, { action: "evacuation_redirected", ...refs });
    return null;
  }
  const pending = zone.pendingOrder;
  if (start !== null) {
    if (pending && pending.startMinute === start && pending.route.destination_id === option.destination_id) {
      return `${zone.name} is already scheduled to leave at ${simClock(start)} toward ${option.name}.`;
    }
    zone.pendingOrder = { startMinute: start, route: option, issuedAt: board.minute, actor };
    const was = pending ? ` (was ${simClock(pending.startMinute)} toward ${pending.route.name})` : "";
    log(
      board,
      "order",
      actor,
      `Evacuation ${pending ? "rescheduled" : "scheduled"}: ${zone.name} to ${option.name} at ${simClock(start)}${was}, ${option.eta_min} min drive.`,
      { action: pending ? "evacuation_rescheduled" : "evacuation_scheduled", ...refs, startMinute: start },
    );
    return null;
  }
  zone.pendingOrder = null;
  zone.orderedAt = board.minute;
  zone.route = option;
  const replaced = pending ? ` (brought forward from ${simClock(pending.startMinute)})` : "";
  log(board, "order", actor, `Evacuation ordered: ${zone.name} to ${option.name}, ${option.eta_min} min drive${replaced}${passed}.`, {
    action: "evacuation_ordered",
    ...refs,
  });
  return null;
}

/** cancel_evacuation: drops a scheduled order that has not started. */
function cancelEvacuation(board: Board, zone: ZoneState, actor: "agent" | "you"): string | null {
  const pending = zone.pendingOrder;
  if (!pending) {
    return zone.orderedAt !== null
      ? `${zone.name} is already leaving (since ${simClock(zone.orderedAt)}); only a scheduled evacuation can be cancelled.`
      : `${zone.name} has no scheduled evacuation.`;
  }
  zone.pendingOrder = null;
  log(board, "order", actor, `Scheduled evacuation cancelled: ${zone.name} was to leave at ${simClock(pending.startMinute)} toward ${pending.route.name}.`, {
    action: "evacuation_cancelled",
    zoneId: zone.id,
    destinationId: pending.route.destination_id,
    startMinute: pending.startMinute,
    households: zone.households,
    people: zone.occupants,
  });
  return null;
}

/**
 * Scheduled orders whose start minute the clock has reached take effect: orderedAt is the
 * scheduled minute itself (not the step that noticed it), so departures do not depend on the
 * clock's tick size (step() also lands on these minutes). Not for a zone already overrun (its
 * schedule was dropped then).
 */
function startScheduledEvacuations(board: Board): void {
  for (const zone of board.zones) {
    const pending = zone.pendingOrder;
    if (!pending || pending.startMinute > board.minute + 1e-9) continue;
    zone.pendingOrder = null;
    if (zone.overrunAt !== null || zone.orderedAt !== null) continue;
    zone.orderedAt = pending.startMinute;
    zone.route = pending.route;
    const unsafe = pending.route.safety === "clear" ? "" : ` (route now ${pending.route.safety.replace(/_/g, " ")})`;
    log(board, "order", "board", `Scheduled evacuation started: ${zone.name} leaving toward ${pending.route.name}${unsafe}, ${pending.route.eta_min} min drive.`, {
      action: "evacuation_started",
      zoneId: zone.id,
      destinationId: pending.route.destination_id,
      etaMin: pending.route.eta_min,
      startMinute: pending.startMinute,
      households: zone.households,
      people: zone.occupants,
    });
  }
}

/** Board minute of the next scheduled evacuation start after now, or Infinity (step() lands on it). */
function nextScheduledStart(board: Board): number {
  let next = Infinity;
  for (const zone of board.zones) {
    const at = zone.pendingOrder?.startMinute;
    if (at !== undefined && at > board.minute + 1e-9 && at < next) next = at;
  }
  return next;
}

/**
 * Where a zone's evacuation stands: none (no order, nothing scheduled), scheduled (pendingOrder),
 * leaving (order in effect, households still to depart or on the road), done (every household
 * the order sends out has left and arrived), overrun.
 */
export type ZoneOrderStatus = "none" | "scheduled" | "leaving" | "done" | "overrun";

export function zoneOrderStatus(zone: ZoneState, minute: number): ZoneOrderStatus {
  if (zone.overrunAt !== null) return "overrun";
  if (zone.pendingOrder) return "scheduled";
  if (zone.orderedAt === null) return "none";
  return stillToLeave(zone, minute) < 1 && zoneCounts(zone, minute).enRoute === 0 ? "done" : "leaving";
}

/** Puts a fire out by hand; its units are released (they drive back to their stations). It stops spreading in the solver from now. */
export function closeFire(board: Board, fireId: string): string | null {
  const fire = board.fires.find((f) => f.id === fireId);
  if (!fire || fire.status === "out") return `${fireId} is already out.`;
  const unreported = unreportedRefusal(board, fire, "you");
  if (unreported) return unreported;
  fire.status = "out";
  fire.outAt = board.minute;
  fire.closedBy = "manual";
  board.firesOutTotal += 1;
  // Its cells still burning are put out now (demo/suppression.ts), so the map shows it out.
  extinguishFire(board, fire);
  for (const team of board.teams) if (team.fireId === fire.id) release(board, team);
  log(board, "closed", "you", `${fire.id} closed out by hand.`, { action: "closed_by_hand", fireId: fire.id, areaHa: fire.areaHa });
  return null;
}

// ---- households ----

/** Households with a vehicle: the only ones who can drive out. */
export function withVehicle(zone: ZoneState): number {
  return Math.max(0, zone.households - zone.noVehicle);
}

/**
 * Households with a vehicle that have left by `minute`: the ordered share (ORDER_COMPLIANCE)
 * times the exponential departure curve since the order took effect (zone.orderedAt; a scheduled
 * order counts from its start minute). Nobody leaves without an order. Frozen at overrun.
 */
export function departed(zone: ZoneState, minute: number): number {
  return Math.floor(departedExact(zone, minute));
}

/** departed() before rounding down: the departure curve itself (for traffic flows). */
function departedExact(zone: ZoneState, minute: number): number {
  const end = zone.overrunAt !== null ? Math.min(minute, zone.overrunAt) : minute;
  const ordered = zone.orderedAt === null ? 0 : ORDER_COMPLIANCE * departedShare(end - zone.orderedAt);
  return withVehicle(zone) * ordered;
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
export function vehiclePersons(zone: ZoneState, households: number): number {
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

/** The route a zone's households are leaving on: the order in effect's (null without one; a scheduled order's route is not in use yet). */
export function activeRoute(zone: ZoneState): RouteOption | null {
  return zone.orderedAt === null ? null : zone.route;
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
  if (zone.overrunAt !== null || zone.orderedAt === null) return 0;
  return Math.max(0, withVehicle(zone) * ORDER_COMPLIANCE - departedExact(zone, minute));
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
    recordCohort(trips, m, d, congestedMinutes(route.segments, flowOf, route.eta_min, queueOf), route.line, route.destination_id);
  }
  board.traffic = { minute: m, flow, zoneFlow, segments, queue, queueCache: cache };
}

/** Highest departure rate a zone's curve reaches (at the order's start), vehicles per minute; 0 with no order in effect. */
function peakDepartureRate(zone: ZoneState): number {
  return zone.orderedAt === null ? 0 : orderPeakVehiclesPerMinute(zone);
}

/**
 * Departure flow an evacuation order of this zone puts on the road at its start, vehicles per
 * minute: the exponential curve's initial rate, ORDER_COMPLIANCE x households with a vehicle /
 * DEPARTURE_MEAN_MINUTES x vehiclesPerHousehold. It decays from there (half of it after
 * DEPARTURE_MEAN_MINUTES x ln 2 = 64 min). Simulated; what staging zones over time spreads out.
 */
export function orderPeakVehiclesPerMinute(zone: ZoneState): number {
  return ((withVehicle(zone) * ORDER_COMPLIANCE) / DEPARTURE_MEAN_MINUTES) * vehiclesPerHousehold(zone);
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
    const key = zones.map((z) => `${z.id}@${z.orderedAt}:${z.overrunAt}`).join("|");
    const hit = board.traffic.queueCache.get(id);
    let t: number;
    let q: number;
    if (hit && hit.key === key && hit.t <= m) {
      t = hit.t;
      q = hit.q;
    } else {
      const cues = zones.flatMap((z) => (z.orderedAt === null ? [] : [z.orderedAt]));
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
  /**
   * Latest board minute an order on this option could start and keep a margin of 0: now +
   * marginMin. ASSUMPTION: the traffic of the other zones stays as it is now. null without a core ETA.
   */
  latestStartMinute: number | null;
  /**
   * Other zones with a scheduled (not yet started) order whose route shares a road segment with
   * this option: their start minute and the vehicles that order will put on the road
   * (ORDER_COMPLIANCE x households with a vehicle x vehicles per household). Not in clearanceMin,
   * which counts vehicles already leaving only.
   */
  scheduledOnRoute: { zoneId: string; startMinute: number; vehicles: number }[];
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
  // Households an order now (or the order in effect) still sends out.
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
  const optionSegments = new Set(option.segments.map((s) => s.id));
  const scheduledOnRoute: EvacuationEstimate["scheduledOnRoute"] = [];
  for (const other of board.zones) {
    const pending = other.pendingOrder;
    if (other === zone || !pending || !pending.route.segments.some((s) => optionSegments.has(s.id))) continue;
    scheduledOnRoute.push({
      zoneId: other.id,
      startMinute: pending.startMinute,
      vehicles: withVehicle(other) * ORDER_COMPLIANCE * vehiclesPerHousehold(other),
    });
  }
  scheduledOnRoute.sort((a, b) => a.startMinute - b.startMinute || a.zoneId.localeCompare(b.zoneId));
  const marginMin = coreEta === null ? null : coreEta - (DEPARTURE_MEAN_MINUTES + clearanceMin + congestedEtaMin);
  return {
    freeFlowMin: freeFlowMinutes(option.segments, option.eta_min),
    congestedEtaMin,
    vehiclesOnRouteNow,
    bottleneck,
    clearanceMin,
    destinationLoadVehicles: picture.byDestination.get(option.destination_id) ?? 0,
    destinationCapacityVeh: option.destination_capacity_veh,
    marginMin,
    latestStartMinute: marginMin === null ? null : board.minute + marginMin,
    scheduledOnRoute,
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
    if (zone.orderedAt === null && zone.overrunAt === null) continue;
    const quietSince = Math.max(zone.lastFireAt ?? -Infinity, zone.orderedAt ?? -Infinity);
    if (board.minute - quietSince < REOPEN_MINUTES) continue;
    forecast ??= zoneForecasts(board, "all");
    if (forecast.get(zone.id)?.edgeEta !== null) continue;
    zone.orderedAt = zone.overrunAt = zone.touchedAt = zone.knownTouchedAt = zone.lastFireAt = null;
    zone.route = null;
    zone.pendingOrder = null;
    zone.caught = 0;
    zone.caughtPeople = zone.occupants === null ? null : 0;
    zone.trips = emptyTrips();
    log(board, "zone", "board", `${zone.name} reopened: no fire near for ${REOPEN_MINUTES} min, households back home.`, {
      action: "zone_reopened",
      zoneId: zone.id,
      households: zone.households,
    });
  }
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
  const from = board.minute;
  board.minute = landOn ?? board.minute + dt;
  const wholeMinute = Math.floor(board.minute + 1e-9) > Math.floor(from + 1e-9);
  // The clock lands on every whole minute (step): board decisions (holding tests, tactic
  // reviews, containment and out calls, escalation, suppression) happen there only, so they
  // do not depend on the clock's tick size.
  const decide = landOn !== null && Number.isInteger(landOn);
  // Line at attack positions, by the units on scene over the step (the clock lands on their arrivals),
  // and direct-attack line, by the units as they were at the step's start (boardResponse.ts).
  buildLines(board, from, board.minute - from);
  for (const fire of board.fires) accrueContainmentLine(board, fire, from, board.minute - from);

  startDueIgnitions(board);

  // Unit lifecycle, reports and run cards, aircraft, orders, move-up (boardResponse.ts), then
  // retries of drives home that had no road route.
  responseTick(board, dt, wholeMinute);
  stepReturns(board);
  for (const team of board.teams) {
    // A unit waiting for its road route has not set off.
    if (team.status !== "en_route" || team.travel === "pending" || team.arriveAt === null || team.arriveAt > board.minute) continue;
    const fire = board.fires.find((f) => f.id === team.fireId);
    if (!fire || fire.status !== "burning") {
      release(board, team);
      continue;
    }
    const line = team.lineId ? board.lines.find((l) => l.id === team.lineId) : undefined;
    if (!line) {
      // Direct attack: parks at the end of its road leg and plans how to reach the edge (boardResponse.arriveOnScene).
      team.legKey = null;
      arriveOnScene(board, team, fire);
      continue;
    }
    // Attack line: at its anchor (the end of its road leg), building line outward.
    team.position = team.route && team.route.length > 0 ? team.route[team.route.length - 1] : (team.target ?? line.plan.point);
    team.status = "on_scene";
    team.departAt = team.rollAt = team.arriveAt = null;
    team.route = null;
    team.legKey = null;
    team.accessKnown = true;
    if (positionEta(board, line.plan) === 0) {
      log(board, "team", "board", `${team.id} reached ${fire.id} ${line.plan.id}, but fire got there first; it builds what line it can.`, {
        action: "line_late",
        teamIds: [team.id],
        fireId: fire.id,
        positionId: line.plan.id,
      });
    }
  }

  // Units putting burning cells out, one whole minute at a time (demo/suppression.ts).
  if (decide) suppressionTick(board, board.minute);

  for (const fire of board.fires) {
    refreshFire(board, fire);
    if (fire.status === "burning") {
      const held = decide ? heldByLine(board, fire) : null;
      // Tactic by flame length, line per tactic, seeded holding test (boardResponse.ts).
      if (advanceContainment(board, fire, decide)) {
        fire.status = "contained";
        fire.containedAt = board.minute;
        reportKnockdown(board, fire.id);
        log(board, "contained", "board", `${fire.id} contained at ${fire.areaHa.toFixed(1)} ha.`, { action: "contained", fireId: fire.id, areaHa: fire.areaHa });
        onContained(board, fire);
      } else if (held !== null) {
        // Indirect line at attack positions: the solver, with the line built so far, forecasts no further spread.
        fire.status = "contained";
        fire.containedAt = held;
        const built = board.lines.filter((l) => l.fireId === fire.id).reduce((sum, l) => sum + l.builtM, 0);
        const past = built > 0 ? `its ${Math.round(built)} m of line` : "its knocked-down edge";
        reportKnockdown(board, fire.id);
        log(board, "contained", "board", `${fire.id} contained at ${fire.areaHa.toFixed(1)} ha: the fire model forecasts no further spread past ${past}.`, {
          action: "contained",
          fireId: fire.id,
          areaHa: fire.areaHa,
          lineM: built,
        });
        onContained(board, fire);
      } else if (decide) {
        // "Cannot catch it": ground units on scene, none still coming, and no containment in the forecast.
        escalate(
          board,
          fire,
          () =>
            board.teams.some((t) => t.fireId === fire.id && t.status === "on_scene") &&
            !board.teams.some((t) => t.fireId === fire.id && t.status === "en_route") &&
            currentContainment(board, fire) === null,
        );
      }
    } else if (
      decide &&
      fire.status === "contained" &&
      fire.containedAt !== null &&
      board.minute - fire.containedAt >= MOPUP_MINUTES &&
      // Out = nothing of it still burning (burned out, or put out by mop-up).
      burningCellCount(board, fire) === 0
    ) {
      fire.status = "out";
      fire.outAt = board.minute;
      fire.closedBy = "teams";
      board.firesOutTotal += 1;
      reportKnockdown(board, fire.id);
      for (const team of board.teams) if (team.fireId === fire.id) release(board, team);
      log(board, "out", "board", `${fire.id} is out: nothing of it is still burning; its units head back to their stations.`, { action: "out", fireId: fire.id, areaHa: fire.areaHa });
    }
  }

  const kept: Fire[] = [];
  for (const fire of board.fires) {
    if (fire.status === "out" && fire.outAt !== null && board.minute - fire.outAt >= OUT_KEEP_MINUTES) {
      board.removedBurnedHa += fire.areaHa;
    } else kept.push(fire);
  }
  board.fires = kept;

  // Scheduled evacuation orders due by now take effect before the zones' fire checks below.
  startScheduledEvacuations(board);
  const field = board.solver.field;
  const active = activeSources(board);
  for (const zone of board.zones) {
    const za = field?.zones.get(zone.id);
    if (!za) continue;
    // Times are the solver's arrival minutes, not the step that noticed them, so they do not
    // depend on the clock's tick size.
    let touchedAt = Number.POSITIVE_INFINITY;
    // What the commander can know: touches by reported fires, from their report minute on.
    let knownAt = Number.POSITIVE_INFINITY;
    for (const [s, f] of active) {
      const at = za.earliestBySource[s];
      touchedAt = Math.min(touchedAt, at);
      const reportAt = board.response.fires.get(f.id)?.reportAt ?? f.ignitedAt;
      if (at <= board.minute && reportAt <= board.minute) knownAt = Math.min(knownAt, Math.max(at, reportAt));
    }
    if (touchedAt <= board.minute) {
      zone.touchedAt ??= touchedAt;
      zone.lastFireAt = board.minute;
    }
    if (knownAt <= board.minute) {
      const firstKnown = zone.knownTouchedAt === null;
      zone.knownTouchedAt ??= knownAt;
      // Fire at a zone with no order in effect: nobody leaves on their own on this board (no
      // self-evacuation); the log flags it for the commander, once a reported fire is there
      // (an unreported fire touching it is not logged: report rule, boardResponse.ts).
      if (firstKnown && zone.orderedAt === null && zone.overrunAt === null) {
        const pending = zone.pendingOrder;
        log(
          board,
          "zone",
          "board",
          pending
            ? `Fire reached ${zone.name} before its scheduled evacuation (${simClock(pending.startMinute)}): households are still home.`
            : `Fire reached ${zone.name} with no evacuation order: households stay home until ordered out.`,
          {
            action: "zone_reached_no_order",
            zoneId: zone.id,
            households: zone.households,
            people: zone.occupants,
            ...(pending ? { startMinute: pending.startMinute, destinationId: pending.route.destination_id } : {}),
          },
        );
      }
    }
    if (zone.overrunAt === null && za.coreArrival <= board.minute && active.has(za.coreSource)) {
      // A schedule that had not started by the core arrival never will (startScheduledEvacuations ran first this step).
      const dropped = zone.pendingOrder;
      zone.pendingOrder = null;
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
        `Fire reached the core of ${zone.name}${zone.caught ? `: ${zone.caught.toLocaleString("en-US")} households (${persons}) still home${zone.noVehicle ? `, ${zone.noVehicle.toLocaleString("en-US")} of them without a vehicle` : ""}` : ""}${dropped ? `; its evacuation scheduled for ${simClock(dropped.startMinute)} had not started` : ""}.`,
        {
          action: "zone_overrun",
          zoneId: zone.id,
          households: zone.caught,
          people: zone.caughtPeople,
          ...(dropped ? { startMinute: dropped.startMinute } : {}),
        },
      );
    }
  }

  if (wholeMinute) {
    evacuationTrafficStep(board, Math.floor(board.minute + 1e-9));
    reopenZones(board);
  }
}

/**
 * Advance the clock by `minutes`, in steps of at most one minute, landing exactly on each whole
 * minute, each scheduled Studio ignition, each scheduled evacuation start and each hour (the
 * station wind's boundary when no Studio fire set the wind), each LINE_RESOLVE_CHUNK_M of line
 * finished, and each timed unit, aircraft, order and report event (nextTimedEvent), so a run
 * does not depend on the clock's tick size. Stops (the rest is not stepped) as soon as
 * the fire field needs a new solve (fireSolveDue), so solves happen at board-defined minutes.
 * Also stops while `holdForLegs(board)` is true: the page's road-leg hold (useCrewRoutes.ts
 * createRoadLegHold, over roadLegsAwaited), so a unit waiting for its road leg sets off at the
 * board minute it was sent, whatever the router's latency. Without it (scripts), no such hold.
 */
export function step(board: Board, minutes: number, holdForLegs?: (board: Board) => boolean): void {
  let left = minutes;
  while (left > 1e-9) {
    if (fireSolveDue(board) !== null) break;
    if (holdForLegs?.(board)) break;
    let dt = Math.min(MAX_STEP_MINUTES, left);
    const hour = (Math.floor(board.minute / WIND_SAMPLE_MINUTES) + 1) * WIND_SAMPLE_MINUTES;
    const next = board.scheduled[0]?.at;
    const ignition = next !== undefined && next > board.minute ? next : Infinity;
    // Every whole minute too: board decisions and suppression run there (stepOnce `decide`).
    const whole = Math.floor(board.minute + 1e-9) + 1;
    const boundary = Math.min(whole, hour, ignition, nextLineEvent(board), nextScheduledStart(board));
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
 * - unit ids are unique; a unit not en route, on scene or refilling has no fire or line; a busy
 *   one has exactly one fire (it is in exactly one fire's crew list, never two) and, when on a
 *   line, that line is of that fire; no unit is on a straight-line trip;
 * - a snapshot engine unit is an engine its station lists as available at T+0;
 * - households: home + on the road + out + caught = households per zone, all non-negative, and
 *   carless households home are at most the households home;
 * - persons (where known): home + on the road + out + caught = the zone's persons, all non-negative;
 * - a scheduled evacuation (pendingOrder) is never held by a zone already leaving or overrun, and
 *   nobody leaves a zone with no order in effect (no self-evacuation).
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
    if (t.status === "en_route" || t.status === "on_scene" || t.status === "refilling") {
      if (t.fireId === null) problems.push(`${t.id} is ${t.status} with no fire`);
    } else {
      if (t.fireId !== null || t.lineId !== null) problems.push(`${t.id} is ${t.status} but assigned (${t.fireId} ${t.lineId})`);
      if ((t.status === "returning" || t.status === "moving_up") && (t.target === null || t.travel === null)) problems.push(`${t.id} is ${t.status} with no trip`);
    }
    // Units only move along road lines (a trip without one waits, `pending`).
    if (t.travel === "straight_line") problems.push(`${t.id} is on a straight-line trip`);
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
    if (zone.pendingOrder && (zone.orderedAt !== null || zone.overrunAt !== null)) problems.push(`${zone.id}: scheduled evacuation on a zone already leaving or overrun`);
    if (zone.orderedAt === null && left > 0) problems.push(`${zone.id}: ${left} households left with no order in effect`);
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
  /** m/min on this fire (direct attack). */
  lineMPerMin: number;
  /** Longest head flame its line holds, feet. */
  holdsFt: number;
  /** Apparatus kind, for the tactic's production factor (absent: direct-attack rate). */
  kind?: DemoApparatusKind;
}

/**
 * Minutes until units arriving at `arrivals` (minutes from now, 0 = on scene) contain `fire`,
 * or null when they never catch it within FORECAST_MINUTES. The perimeter is the solver's
 * lookahead; the head flame (and crowning) at the leading cell is taken to persist. The tactic
 * is the one these units would use (response/containment.ts chooseTactic): direct when their
 * line holds the head, parallel or indirect up to 11 ft, none above (flank only). Ground line
 * covers only the reachable share of the edge (response/reach.ts); aircraft line already laid
 * adds to it. `units[i]` describes arrival i.
 */
export function containedIn(board: Board, fire: Fire, arrivals: number[], units: UnitWork[], forced?: Tactic): number | null {
  if (fire.status !== "burning") return fire.status === "contained" ? 0 : null;
  if (arrivals.length === 0) return null;
  const holdsAll = Math.max(0, ...units.map((u) => u.holdsFt));
  const fuel = board.env.spread.ground.fuelCodeAt(fire.origin);
  const structure = (fire.rates.cell >= 0 ? fire.rates.fuelCode : fuel) === DEVELOPED_FUEL_CODE;
  // `forced`: the commander's tactic (demo/strategyOptions.ts commanderTactic), else the rule-based choice.
  const tactic = forced ?? chooseTactic({ structure, crowning: fire.rates.crowning, headFlameFeet: fire.rates.headFlameFeet, directHoldsFeet: holdsAll, parallelFeasible: true });
  // No ground line holds a crowning head (the rule-based choice is flank then anyway).
  if (tactic === "flank" || (fire.rates.crowning && tactic !== "structure")) return null;
  const rate = (u: UnitWork) => (u.kind && !buildsOn(u.kind, tactic) ? 0 : u.lineMPerMin * (u.kind ? tacticRateFactor(u.kind, fuel, tactic) : 1));
  let line = fire.lineM;
  const reach = reachFraction(board, fire) ?? 1;
  const airLine = board.response.fires.get(fire.id)?.airLineM ?? 0;
  for (let t = 1; t <= FORECAST_MINUTES; t += 1) {
    let holds = 0;
    for (let i = 0; i < arrivals.length; i += 1) {
      if (arrivals[i] < t && units[i]) {
        line += rate(units[i]);
        holds = Math.max(holds, units[i].holdsFt);
      }
    }
    const perimeter = perimeterIn(board, fire, t);
    // Parallel line carries the offset ring; indirect is forecast as parallel (its own plan is set when chosen).
    const needed = lineNeededMeters(tactic === "indirect" ? "parallel" : tactic, perimeter, null);
    line = Math.min(line, needed * reach + airLine);
    const holdsHead = tactic === "direct" ? lineHoldsHead(fire, holds) : tacticHoldsFeet(tactic, holds) >= fire.rates.headFlameFeet;
    if (holds > 0 && line >= needed && holdsHead) return t;
  }
  return null;
}

export function teamArrival(board: Board, team: Team, fire: Fire): number {
  if (team.fireId === fire.id) {
    // On scene: from when it starts building line (after any hike in; response/reach.ts).
    if (team.status === "on_scene" || team.status === "refilling") return Math.max(0, (team.workStartAt ?? board.minute) - board.minute);
    return Math.max(0, (team.arriveAt ?? board.minute) - board.minute);
  }
  return travelMinutes(board, team, fire);
}

export function workOf(board: Board, team: Team, fire: Fire): UnitWork {
  // A unit on scene works as its reach plan says (out of reach: no line; engine crew on foot: hand line).
  if (team.fireId === fire.id && team.workMode !== null) {
    const lineMPerMin = tacticLineRate(board, fire, [{ ...team, workStartAt: null }], "direct");
    return { lineMPerMin, holdsFt: team.workMode === "out_of_reach" || team.workMode === "indirect" ? 0 : holdsFlameFeet(team.kind) };
  }
  return { lineMPerMin: unitLineOn(board, team, fire), holdsFt: holdsFlameFeet(team.kind), kind: team.kind };
}

/** Containment estimate with the direct-attack units already assigned (units on attack lines work through the solver). */
export function currentContainment(board: Board, fire: Fire): number | null {
  const assigned = board.teams.filter((t) => t.fireId === fire.id && t.lineId === null);
  return containedIn(
    board,
    fire,
    assigned.map((t) => teamArrival(board, t, fire)),
    assigned.map((t) => workOf(board, t, fire)),
    commanderTactic(board, fire),
  );
}

export interface ContainOption {
  teams: string[];
  contained_in_min: number | null;
  /** "road": every unit's time is its road leg; "estimate": at least one road leg is not known yet (ASSUMPTION straight line). */
  route: "road" | "estimate";
}

/** Free units (available, returning or moving up, on no fire) that can reach this fire's crew target, nearest first (by expected arrival). */
export function nearestFree(board: Board, fire: Fire): { team: Team; eta: number; road: boolean }[] {
  return reachableFree(board, fire.id, crewTarget(fire)).map((r) => ({ ...r, eta: expectedArrival(board, r.team, fire) }))
    .sort((a, b) => a.eta - b.eta || a.team.id.localeCompare(b.team.id));
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
        commanderTactic(board, fire),
      ),
    });
  }
  return out;
}

export interface ZoneForecast {
  /** Minutes until fire reaches the zone (any of its cells) / its core cell; 0 = there; null = not within FORECAST_MINUTES. */
  edgeEta: number | null;
  coreEta: number | null;
  /** A fire has touched the zone (kept until it reopens): zone.touchedAt for scope "all", zone.knownTouchedAt for "reported". */
  touched: boolean;
}

/**
 * Which fires a forecast counts. "reported": only fires dispatch has (boardResponse.ts report
 * rule), for everything the commander and Claude see (useCommandBoard's forecasts, the
 * observation, outcomes, panels and map tags). "all": every fire, for the board's own physics
 * (zone reopening). An overrun zone reads 0 ("reported": once a reported fire has touched it).
 */
export type ForecastScope = "all" | "reported";

/**
 * Fire ETAs at each zone from the solver's arrival field (earliest arrival over the zone's cells
 * and at its core). A burning fire's arrivals count only up to its estimated containment with
 * the units assigned; a contained fire's only where it has already burned.
 */
export function zoneForecasts(board: Board, scope: ForecastScope): Map<string, ZoneForecast> {
  const field = board.solver.field;
  const limits = new Map<number, number>();
  for (const [s, f] of activeSources(board)) {
    if (scope === "reported" && !isReported(board, f)) continue;
    const stop = f.status === "contained" ? 0 : currentContainment(board, f);
    limits.set(s, Math.min(stop ?? FORECAST_MINUTES, FORECAST_MINUTES));
  }
  const eta = (arrival: number, limit: number): number | null => {
    const wait = arrival - board.minute;
    return wait <= 0 ? 0 : wait <= limit ? wait : null;
  };
  const out = new Map<string, ZoneForecast>();
  for (const zone of board.zones) {
    // An overrun zone reads 0; with "reported", only once a reported fire has touched it (an
    // overrun by a fire not yet reported is not known to the commander yet).
    if (zone.overrunAt !== null && (scope === "all" || zone.knownTouchedAt !== null)) {
      out.set(zone.id, { edgeEta: 0, coreEta: 0, touched: true });
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
    out.set(zone.id, {
      edgeEta: edge === null ? null : Math.round(edge),
      coreEta: core === null ? null : Math.round(core),
      touched: (scope === "reported" ? zone.knownTouchedAt : zone.touchedAt) !== null,
    });
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

/**
 * A zone is threatened when a fire has touched it (kept until the zone reopens) or the fire
 * forecast reaches any of its cells within FORECAST_MINUTES (zoneForecasts edgeEta, which counts
 * a burning fire only up to its estimated containment), in the forecasts' scope (with
 * "reported" forecasts, unreported fires threaten nothing). Without forecasts: zone.touchedAt.
 * Totals' "at risk" counts and the /live outcomes (demo/outcomes.ts) use this one rule.
 */
export function zoneThreatened(zone: ZoneState, forecasts?: Map<string, ZoneForecast>): boolean {
  const f = forecasts?.get(zone.id);
  return f ? f.edgeEta != null || f.touched : zone.touchedAt !== null;
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
    const atRisk = zoneThreatened(zone, forecasts);
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
