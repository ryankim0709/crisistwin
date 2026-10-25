/**
 * Command demo (/demo): a continuously running fire board on the active drill's zones (Camp by default). Fires keep
 * starting, firefighting units fight them and households evacuate, on a simulation clock with
 * no end state (24/7 monitoring). Pure: no React, network or LLM; seeded, so a seed, the same
 * environment and the same orders replay the same run. See docs/adr/0047-command-demo.md and,
 * for what is modelled and what is assumed, docs/command-demo-realism.md.
 *
 * Model, shown in the UI:
 * - Fire spread is the simulator's cell solver, the same one /fire and Simulation Studio run
 *   (fire/spread.ts simulateScheduledFireSpread: Rothermel 1972 surface spread with crown fire,
 *   ember spotting and structure-to-structure spread at their defaults) on the drill's LANDFIRE
 *   landscape, with every board fire as a source. demo/fireField.ts holds the solve and what is
 *   read back from it; the page runs it off the main thread (useFireSolver) and the board clock
 *   holds while a required solve is pending (fireSolveDue), so a run does not depend on machine
 *   speed. A solve is required for a new fire, a contained or closed fire, a change of the hourly
 *   wind sample or fuel moisture, and when the lookahead runs short; each continues from the
 *   burned state at that minute (spread.ts ResumeFrom), and each uses the current hour's wind
 *   for its whole lookahead.
 * - Containment race (as studio/initialAttack.ts and dispatch/fireAttack.ts): units on scene
 *   build line at their sourced production rate for the fuel and slope (realism.ts
 *   lineMetersPerMinute). The fire is contained when the line reaches its perimeter (the
 *   solver footprint's edge facing ground that can still burn, fireField.ts) AND the head flame
 *   at its leading front cell is within the longest flame an on-scene unit's line holds (PMS 465
 *   Hauling chart: 4 ft hand tools, 8 ft engines and dozers) and that cell is not crowning. Until
 *   then the line is flank line and cannot exceed the perimeter. Mop-up MOPUP_MINUTES, then the
 *   fire is out. A contained fire stops spreading in the solver from its containment minute.
 * - Scheduled ignitions arrive at the activity level's interval, forever. Spot fires come from
 *   the solver's ember spotting and belong to the fire that threw them. At most
 *   MAX_ACTIVE_FIRES burn or smoulder at once.
 * - Households: each zone's carless households (ACS) cannot drive out and stay home. Households
 *   with a vehicle leave on an evacuation order (ORDER_COMPLIANCE of them) or, with no order,
 *   on the fire cue when fire touches the zone (SHADOW_SHARE of them), each with an
 *   exponential departure delay of mean DEPARTURE_MEAN_MINUTES (Camp, Grajdura 2022), then
 *   drive their route's free-flow time. Households home when fire reaches the zone core are
 *   caught. "Touches" and "reaches" read the solver's arrival field over the zone's cells and at
 *   its core cell. Congestion is not modelled.
 * - Units start at real CAL FIRE stations (GET /api/suppression/bases) or, without the bases
 *   file, at synthetic stations; they drive the road network for their apparatus class
 *   (POST /api/demo/crew_routes) after their turnout, or a straight line x 1.3 while no road
 *   time is known.
 * - A zone that was ordered out or overrun reopens once no fire has touched it for
 *   REOPEN_MINUTES and none is forecast to; caught households stay in the running total.
 *   Fires that are out leave the board after OUT_KEEP_MINUTES (their burned ground stays).
 *
 * Units: minutes are simulation minutes from T+0; distances metres; areas hectares on output;
 * flame lengths feet (the Hauling chart's unit).
 */

import { fuelLabel, isBurnable } from "../fire/fuelModels";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { cellAt } from "../fire/spread";
import type { LonLat } from "../live/types";
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
  type FireSolveRequest,
  type FireSolveResult,
  type FrontBehaviour,
  type SolveSource,
  type ZoneArrivals,
  type ZoneCells,
} from "./fireField";
import {
  DEPARTURE_MEAN_MINUTES,
  FALLBACK_CIRCUITY,
  FALLBACK_SPEED_KMH,
  KIND_PREFIX,
  ORDER_COMPLIANCE,
  ROSTER,
  SHADOW_SHARE,
  departedShare,
  holdsFlameFeet,
  kindShort,
  lineMetersPerMinute,
  turnoutMinutes,
  windAt,
  type DemoApparatusKind,
  type MoistureId,
  type SpreadInputs,
} from "./realism";

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

export type Activity = "quiet" | "active" | "severe";

export interface ActivityLevel {
  label: string;
  /**
   * ASSUMPTION (mapping): the fuel moisture scenario this activity level runs with, one of the
   * Scott & Burgan (2005) Table 1 scenarios in fire/spread.ts MOISTURE_PRESETS.
   */
  moisture: MoistureId;
  /** Minutes between scheduled ignitions (scenario assumption). */
  ignitionEvery: [number, number];
}

export const ACTIVITY: Record<Activity, ActivityLevel> = {
  quiet: { label: "Quiet", moisture: "moderate", ignitionEvery: [25, 45] },
  active: { label: "Active", moisture: "dry", ignitionEvery: [12, 20] },
  severe: { label: "Severe", moisture: "critical", ignitionEvery: [6, 12] },
};
export const ACTIVITIES: Activity[] = ["quiet", "active", "severe"];

/** "spot" is kept for older logs; spot fires now belong to the solver source that threw them. */
export type FireSource = "scenario" | "spot" | "field_report" | "manual";
export type FireStatus = "burning" | "contained" | "out";

export interface Fire {
  id: string;
  source: FireSource;
  /** Field reports that started or joined this fire. */
  reportIds: string[];
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

export type TeamStatus = "available" | "en_route" | "on_scene";
export type TravelBasis = "road" | "road_offboard" | "straight_line";

export interface Team {
  id: string;
  kind: DemoApparatusKind;
  station: string;
  /** Where the unit is, or where it set off from while en route. */
  position: LonLat;
  status: TeamStatus;
  fireId: string | null;
  departAt: number | null;
  arriveAt: number | null;
  /** Where it is driving to (the fire's heel when dispatched). */
  target: LonLat | null;
  /** Road line while en route, when the road route is known. */
  route: LonLat[] | null;
  travel: TravelBasis | null;
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
}

export interface ZoneState {
  id: string;
  name: string;
  households: number;
  /** Households with no vehicle (ACS): they cannot drive out. */
  noVehicle: number;
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
}

export interface Station {
  id: string;
  name: string;
  location: LonLat;
  /** CAL FIRE facility type (FSB, FSA, CC, ...) or "synthetic". */
  type: string;
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

export type EventKind = "ignition" | "contained" | "out" | "overrun" | "order" | "team" | "closed" | "zone" | "board";
export interface BoardEvent {
  minute: number;
  kind: EventKind;
  actor: "board" | "agent" | "you";
  text: string;
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
  seed: number;
  activity: Activity;
  minute: number;
  rng: number;
  nextIgnitionAt: number;
  fireCount: number;
  fires: Fire[];
  teams: Team[];
  stations: Station[];
  zones: ZoneState[];
  env: DemoEnvironment;
  /** The solver's arrival field and its bookkeeping (fireField.ts). */
  solver: FireSolverState;
  /** Latest zone routes (POST /api/demo/routes); shadow evacuees take the best one. */
  routes: ReadonlyMap<string, RouteOption[]>;
  /** Road legs by travelKey; filled by the page from POST /api/demo/crew_routes. */
  travel: Map<string, TravelLeg>;
  /** Field reports already turned into (or joined to) a fire. */
  seenReports: string[];
  events: BoardEvent[];
  /** Running totals over the whole run. */
  caughtTotal: number;
  firesOutTotal: number;
  /** Burned area of fires already removed from the board, hectares. */
  removedBurnedHa: number;
}

export interface BaseZone {
  id: string;
  name: string;
  households: number;
  ring: LonLat[];
  core: LonLat;
}

// ---- seeded randomness (mulberry32) ----

function nextRandom(board: Board): number {
  let t = (board.rng = (board.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function between(board: Board, [lo, hi]: [number, number]): number {
  return lo + (hi - lo) * nextRandom(board);
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

/** Wind and moisture at the board minute, as the solver takes them. */
function weatherNow(board: Board): { speed: number; from: number; moisture: MoistureId; key: string } {
  const w = windAt(board.env.spread.wind, board.minute);
  const moisture = ACTIVITY[board.activity].moisture;
  return { speed: w.speedMetersPerSecond, from: w.fromDegrees, moisture, key: `${w.speedMetersPerSecond}|${w.fromDegrees}|${moisture}` };
}

function fieldWeatherKey(field: FireSolveResult): string {
  return `${field.windSpeedMetersPerSecond}|${field.windFromDegrees}|${field.moisture}`;
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
  if (weatherNow(board).key !== fieldWeatherKey(field)) return "hourly wind or fuel moisture changed";
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
    key: `${board.seed}|${board.minute}|${weather.key}|${sources.map((s) => `${s.fireId}:${s.stopMinute}`).join(",")}`,
    fromMinute: field ? board.minute : null,
    horizonMinutes,
    windSpeedMetersPerSecond: weather.speed,
    windFromDegrees: weather.from,
    moisture: weather.moisture,
    sources,
    resume,
  };
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
  const th = (windAt(board.env.spread.wind, board.minute).fromDegrees * Math.PI) / 180;
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
  return chosen.map((z, i) => ({ id: `S${i + 1}`, name: `Synthetic station ${i + 1}`, location: z.core, type: "synthetic" }));
}

/** The roster's units, each at its base: real bases nearest first, else synthetic round-robin. */
function buildTeams(zones: BaseZone[], env: DemoEnvironment): { teams: Team[]; stations: Station[] } {
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
      teams.push({
        id: `${prefix}${counters[prefix]}`,
        kind,
        station: station?.id ?? "",
        position: location,
        status: "available",
        fireId: null,
        departAt: null,
        arriveAt: null,
        target: null,
        route: null,
        travel: null,
      });
    }
  }
  return { teams, stations: [...used.values()] };
}

/** Zones rasterised on the landscape's cells (cell centres inside the thinned ring, plus core and ring cells). */
function rasterZones(grid: LandscapeGrid, zones: ZoneState[]): Map<string, ZoneCells> {
  const lonOfCol = new Float64Array(grid.width);
  for (let c = 0; c < grid.width; c += 1) lonOfCol[c] = mercatorToLonLat(grid.originX + c * grid.cellSizeX, grid.originY)[0];
  const latOfRow = new Float64Array(grid.height);
  for (let r = 0; r < grid.height; r += 1) latOfRow[r] = mercatorToLonLat(grid.originX, grid.originY + r * grid.cellSizeY)[1];
  return new Map(zones.map((z) => [z.id, rasterZone(grid, z.ring, z.core, lonOfCol, latOfRow)]));
}

export function createBoard(zones: BaseZone[], activity: Activity, seed: number, env: DemoEnvironment): Board {
  const { teams, stations } = buildTeams(zones, env);
  const zoneStates: ZoneState[] = zones.map((z) => {
    const households = Math.max(0, Math.round(z.households));
    return {
      id: z.id,
      name: z.name,
      households,
      noVehicle: Math.min(households, Math.max(0, Math.round(env.noVehicle.get(z.id) ?? 0))),
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
    };
  });
  const board: Board = {
    seed,
    activity,
    minute: 0,
    rng: seed >>> 0,
    nextIgnitionAt: 0,
    fireCount: 0,
    fires: [],
    teams,
    stations,
    zones: zoneStates,
    env,
    solver: { field: null, error: null, zoneCells: rasterZones(env.landscape, zoneStates) },
    routes: new Map(),
    travel: new Map(),
    seenReports: [],
    events: [],
    caughtTotal: 0,
    firesOutTotal: 0,
    removedBurnedHa: 0,
  };
  const kinds = ROSTER.map((r) => `${r.count} ${kindShort(r.kind)}${r.count > 1 ? "s" : ""}`).join(", ");
  log(board, "board", "board", `Monitoring started, ${ACTIVITY[activity].label.toLowerCase()} fire activity, seed ${seed}. Ready: ${kinds}.`);
  return board;
}

function log(board: Board, kind: EventKind, actor: BoardEvent["actor"], text: string): void {
  board.events.unshift({ minute: Math.round(board.minute), kind, actor, text });
  if (board.events.length > MAX_EVENTS) board.events.length = MAX_EVENTS;
}

export function setActivity(board: Board, activity: Activity): void {
  if (board.activity === activity) return;
  board.activity = activity;
  board.nextIgnitionAt = Math.min(board.nextIgnitionAt, board.minute + between(board, ACTIVITY[activity].ignitionEvery));
  log(board, "board", "you", `Fire activity set to ${ACTIVITY[activity].label.toLowerCase()}.`);
}

/** Latest zone routes; shadow evacuees take a zone's best option. */
export function setRoutes(board: Board, routes: ReadonlyMap<string, RouteOption[]>): void {
  board.routes = routes;
}

const SOURCE_TEXT: Record<FireSource, string> = {
  scenario: "New ignition",
  spot: "Spot fire",
  field_report: "Field report",
  manual: "Fire added by hand",
};

export function zoneAt(board: Board, p: LonLat): ZoneState | null {
  return board.zones.find((z) => pointInRing(p, z.ring)) ?? null;
}

export function activeFires(board: Board): Fire[] {
  return board.fires.filter((f) => f.status !== "out");
}

/** Starts a fire at `origin`; `at` is its ignition minute (default now; scheduled ignitions pass their scheduled minute). */
export function ignite(
  board: Board,
  origin: LonLat,
  source: FireSource,
  actor: BoardEvent["actor"],
  reportId?: string,
  at: number = board.minute,
): Fire | null {
  if (activeFires(board).length >= MAX_ACTIVE_FIRES) return null;
  board.fireCount += 1;
  const grid = board.env.landscape;
  const noSpread = noSpreadReason(grid, board.solver.field?.arrivalMinutes ?? null, origin, board.minute);
  const fire: Fire = {
    id: `F${board.fireCount}`,
    source,
    reportIds: reportId ? [reportId] : [],
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
    actor,
    `${SOURCE_TEXT[source]}: ${fire.id}${zone ? ` in ${zone.name}` : ""}${cell >= 0 ? `, ${fuelLabel(grid.fuelCodes[cell])}` : ""}${noSpread ? ` (${noSpread})` : ""}.`,
  );
  return fire;
}

/** Candidates a scheduled ignition tries before giving up on finding wildland fuel. */
const IGNITION_CANDIDATES = 24;
/** How far beyond a zone's edge (outward from its core) a scheduled ignition may land, m. */
export const IGNITION_OUTSIDE_MAX_M = 1500;

/**
 * A scheduled ignition point near a community. Candidates alternate, starting inside: inside a
 * random zone (between its core and a vertex), then in a ring up to IGNITION_OUTSIDE_MAX_M beyond
 * a vertex, pointing away from the core (toward the wildland around a town). The first candidate on a
 * Scott & Burgan fuel model wins (most WUI fires start in vegetation; developed ground burns in the
 * solver only by structure spread). If none of IGNITION_CANDIDATES is burnable, the first in-zone
 * candidate is used (the solver may still refuse it, and the fire is then labelled as unable to
 * spread). All draws come from the board's seeded generator.
 */
function randomIgnitionPoint(board: Board): LonLat | null {
  if (board.zones.length === 0) return null;
  let fallback: LonLat | null = null;
  for (let i = 0; i < IGNITION_CANDIDATES; i++) {
    const zone = board.zones[Math.floor(nextRandom(board) * board.zones.length)];
    const vertex = zone.ring[Math.floor(nextRandom(board) * zone.ring.length)];
    const u = nextRandom(board);
    let p: LonLat;
    if (!vertex) p = zone.core;
    else if (i % 2 === 0) {
      const t = 0.15 + 0.6 * u;
      p = [zone.core[0] + (vertex[0] - zone.core[0]) * t, zone.core[1] + (vertex[1] - zone.core[1]) * t];
    } else {
      const [x, y] = toLocal(zone.core, vertex);
      const r = Math.hypot(x, y);
      const out = r > 1 ? (r + IGNITION_OUTSIDE_MAX_M * u) / r : 1;
      p = fromLocal(zone.core, [x * out, y * out]);
    }
    fallback ??= p;
    if (noSpreadReason(board.env.landscape, board.solver.field?.arrivalMinutes ?? null, p, board.minute) === null &&
      isVegetated(board, p)) return p;
  }
  return fallback;
}

/** On a Scott & Burgan fuel model (vegetation), not developed or non-burnable ground. */
function isVegetated(board: Board, p: LonLat): boolean {
  return isBurnable(board.env.spread.ground.fuelCodeAt(p));
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
 * Turns a fire_seen field report into a fire, or joins it to the fire already there (burned
 * there, or reached within REPORT_JOIN_MINUTES). Each report is used once.
 */
export function addReportFire(board: Board, reportId: string, coord: LonLat): Fire | null {
  if (board.seenReports.includes(reportId)) return null;
  board.seenReports.push(reportId);
  if (board.seenReports.length > MAX_SEEN_REPORTS) board.seenReports.shift();
  const near = activeFires(board).find((f) => waitMinutes(board, f, coord, REPORT_JOIN_MINUTES) !== null);
  if (near) {
    near.reportIds.push(reportId);
    log(board, "ignition", "board", `Field report joined to ${near.id}.`);
    return null;
  }
  return ignite(board, coord, "field_report", "board", reportId);
}

// ---- units ----

/** Cache key of a road leg: unit, where it starts (rounded) and the fire. */
export function travelKey(team: Team, from: LonLat, fireId: string): string {
  return `${team.id}|${from[0].toFixed(4)},${from[1].toFixed(4)}|${fireId}`;
}

/** ASSUMPTION fallback drive time: straight line x FALLBACK_CIRCUITY at FALLBACK_SPEED_KMH. */
export function fallbackDriveMinutes(from: LonLat, to: LonLat): number {
  return ((distanceM(from, to) * FALLBACK_CIRCUITY) / (FALLBACK_SPEED_KMH * 1000)) * 60;
}

/** Minutes from dispatch to on scene: turnout plus the road leg, or the fallback. */
export function travelMinutes(board: Board, team: Team, fire: Fire): number {
  const from = teamPosition(board, team);
  const leg = board.travel.get(travelKey(team, from, fire.id));
  return turnoutMinutes(team.kind) + (leg ? leg.driveMinutes : fallbackDriveMinutes(from, crewTarget(fire)));
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

/** Where a unit is now (en route: along its road line after turnout, or the straight line). */
export function teamPosition(board: Board, team: Team): LonLat {
  if (team.status !== "en_route" || team.departAt === null || team.arriveAt === null || team.target === null) return team.position;
  const rolling = team.departAt + turnoutMinutes(team.kind);
  const span = team.arriveAt - rolling;
  const u = span > 0 ? Math.min(1, Math.max(0, (board.minute - rolling) / span)) : board.minute >= rolling ? 1 : 0;
  return along(team.route && team.route.length > 1 ? team.route : [team.position, team.target], u);
}

function release(board: Board, team: Team): void {
  team.position = teamPosition(board, team);
  team.status = "available";
  team.fireId = null;
  team.departAt = team.arriveAt = null;
  team.target = team.route = null;
  team.travel = null;
}

/**
 * A road leg arrived for `key`. Units en route on that leg that were timed by the fallback are
 * re-timed (departure + turnout + road minutes) and follow the road line.
 */
export function applyTravelLeg(board: Board, key: string, leg: TravelLeg): void {
  board.travel.set(key, leg);
  if (board.travel.size > 2000) board.travel.delete(board.travel.keys().next().value as string);
  for (const team of board.teams) {
    if (team.status !== "en_route" || team.travel !== "straight_line" || team.fireId === null || team.departAt === null) continue;
    if (travelKey(team, team.position, team.fireId) !== key) continue;
    team.arriveAt = team.departAt + turnoutMinutes(team.kind) + leg.driveMinutes;
    team.route = leg.line;
    team.travel = leg.basis;
  }
}

export type BoardOrder =
  | { type: "send_crew"; crew_id: string; fire_id: string; reason?: string }
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
      release(board, team);
      log(board, "team", actor, `${team.id} released.`);
      return null;
    }
    const fire = board.fires.find((f) => f.id === order.fire_id);
    if (!fire || fire.status !== "burning") return `${order.fire_id} is not burning.`;
    if (team.fireId === fire.id) return `${team.id} is already on ${fire.id}.`;
    const from = teamPosition(board, team);
    const leg = board.travel.get(travelKey(team, from, fire.id));
    const target = crewTarget(fire);
    team.position = from;
    team.status = "en_route";
    team.fireId = fire.id;
    team.departAt = board.minute;
    team.target = target;
    team.route = leg?.line ?? null;
    team.travel = leg?.basis ?? "straight_line";
    team.arriveAt = board.minute + turnoutMinutes(team.kind) + (leg ? leg.driveMinutes : fallbackDriveMinutes(from, target));
    log(
      board,
      "team",
      actor,
      `${team.id} (${kindShort(team.kind)}) sent to ${fire.id}, on scene in ${Math.ceil(team.arriveAt - board.minute)} min${leg ? "" : " (straight-line estimate)"}.`,
    );
    return null;
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

/** Puts a fire out by hand; its units are freed. It stops spreading in the solver from now. */
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
  const end = zone.overrunAt !== null ? Math.min(minute, zone.overrunAt) : minute;
  const ordered = zone.orderedAt === null ? 0 : ORDER_COMPLIANCE * departedShare(end - zone.orderedAt);
  const shadow = zone.shadowAt === null || zone.shadowRoute === null ? 0 : SHADOW_SHARE * departedShare(end - zone.shadowAt);
  return Math.floor(withVehicle(zone) * Math.max(ordered, shadow));
}

export interface ZoneCounts {
  home: number;
  enRoute: number;
  out: number;
  caught: number;
  /** Carless households still home (included in `home`): need transport. */
  noVehicleHome: number;
}

export function zoneCounts(zone: ZoneState, minute: number): ZoneCounts {
  const left = departed(zone, minute);
  const drive = (zone.route ?? zone.shadowRoute)?.eta_min ?? 0;
  const out = departed(zone, minute - drive);
  return {
    home: Math.max(0, zone.households - left - zone.caught),
    enRoute: left - out,
    out,
    caught: zone.caught,
    noVehicleHome: zone.overrunAt !== null ? 0 : zone.noVehicle,
  };
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
    if (t.fireId !== fire.id || t.status !== "on_scene") continue;
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
  const level = ACTIVITY[board.activity];
  const wholeMinute = Math.floor(board.minute + dt) > Math.floor(board.minute);
  board.minute = landOn ?? board.minute + dt;

  while (board.nextIgnitionAt <= board.minute) {
    const at = board.nextIgnitionAt;
    const p = randomIgnitionPoint(board);
    if (p) ignite(board, p, "scenario", "board", undefined, at);
    board.nextIgnitionAt = at + between(board, level.ignitionEvery);
  }

  for (const team of board.teams) {
    if (team.status !== "en_route" || team.arriveAt === null || team.arriveAt > board.minute) continue;
    const fire = board.fires.find((f) => f.id === team.fireId);
    if (fire && fire.status === "burning") {
      team.position = team.target ?? crewTarget(fire);
      team.status = "on_scene";
      team.departAt = team.arriveAt = null;
      team.route = null;
    } else release(board, team);
  }

  for (const fire of board.fires) {
    refreshFire(board, fire);
    if (fire.status === "burning") {
      const work = onSceneWork(board, fire);
      // Line cannot exceed the perimeter; flank line is outflanked as the perimeter grows.
      fire.lineM = Math.min(fire.perimeterM, fire.lineM + work.lineMPerMin * dt);
      if (work.count > 0 && fire.lineM >= fire.perimeterM && lineHoldsHead(fire, work.holdsFt)) {
        fire.status = "contained";
        fire.containedAt = board.minute;
        log(board, "contained", "board", `${fire.id} contained at ${fire.areaHa.toFixed(1)} ha.`);
      }
    } else if (fire.status === "contained" && fire.containedAt !== null && board.minute - fire.containedAt >= MOPUP_MINUTES) {
      fire.status = "out";
      fire.outAt = board.minute;
      fire.closedBy = "teams";
      board.firesOutTotal += 1;
      for (const team of board.teams) if (team.fireId === fire.id) release(board, team);
      log(board, "out", "board", `${fire.id} is out; its units are free.`);
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
      board.caughtTotal += zone.caught;
      log(
        board,
        "overrun",
        "board",
        `Fire reached the core of ${zone.name}${zone.caught ? `: ${zone.caught.toLocaleString("en-US")} households still home${zone.noVehicle ? `, ${zone.noVehicle.toLocaleString("en-US")} of them without a vehicle` : ""}` : ""}.`,
      );
    }
  }

  if (wholeMinute) reopenZones(board);
}

/**
 * Advance the clock by `minutes`, in steps of at most one minute, landing exactly on each
 * scheduled ignition and each hourly wind boundary. Stops (the rest is not stepped) as soon as
 * the fire field needs a new solve (fireSolveDue), so solves happen at board-defined minutes.
 */
export function step(board: Board, minutes: number): void {
  let left = minutes;
  while (left > 1e-9) {
    if (fireSolveDue(board) !== null) return;
    let dt = Math.min(MAX_STEP_MINUTES, left);
    const hour = (Math.floor(board.minute / WIND_SAMPLE_MINUTES) + 1) * WIND_SAMPLE_MINUTES;
    const ignition = board.nextIgnitionAt > board.minute ? board.nextIgnitionAt : Infinity;
    const boundary = Math.min(hour, ignition);
    let landOn: number | null = null;
    if (board.minute + dt >= boundary - 1e-9) {
      dt = boundary - board.minute;
      landOn = boundary;
    }
    stepOnce(board, dt, landOn);
    left -= dt;
  }
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

/** Containment estimate with the units already assigned. */
export function currentContainment(board: Board, fire: Fire): number | null {
  const assigned = board.teams.filter((t) => t.fireId === fire.id);
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
}

/** Free units nearest this fire first (by arrival time). */
export function nearestFree(board: Board, fire: Fire): { team: Team; eta: number }[] {
  return board.teams
    .filter((t) => t.status === "available")
    .map((team) => ({ team, eta: teamArrival(board, team, fire) }))
    .sort((a, b) => a.eta - b.eta || a.team.id.localeCompare(b.team.id));
}

/** Sending the n nearest free units (n = 1..max) on top of those already assigned. */
export function containOptions(board: Board, fire: Fire, max = 4): ContainOption[] {
  if (fire.status !== "burning") return [];
  const assignedTeams = board.teams.filter((t) => t.fireId === fire.id);
  const assigned = assignedTeams.map((t) => teamArrival(board, t, fire));
  const assignedWork = assignedTeams.map((t) => workOf(board, t, fire));
  const free = nearestFree(board, fire);
  const out: ContainOption[] = [];
  for (let n = 1; n <= Math.min(max, free.length); n += 1) {
    const pick = free.slice(0, n);
    out.push({
      teams: pick.map((p) => p.team.id),
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
  burning: number;
  contained: number;
  firesOutTotal: number;
  burnedHa: number;
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
    if (forecasts?.get(zone.id)?.edgeEta != null || zone.touchedAt !== null) t.noVehicleAtRisk += c.noVehicleHome;
  }
  for (const fire of board.fires) {
    if (fire.status === "burning") t.burning += 1;
    else if (fire.status === "contained") t.contained += 1;
    // Each burned cell belongs to one fire, so the areas add without double counting.
    t.burnedHa += fire.areaHa;
  }
  return t;
}
