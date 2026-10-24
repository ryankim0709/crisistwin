/**
 * Command demo (/demo): a continuously running fire board on the active drill's zones (Camp by default). Fires keep
 * starting, firefighting units fight them and households evacuate, on a simulation clock with
 * no end state (24/7 monitoring). Pure: no React, network or LLM; seeded, so a seed, the same
 * environment and the same orders replay the same run. See docs/adr/0047-command-demo.md and,
 * for what is modelled and what is assumed, docs/command-demo-realism.md.
 *
 * Model, shown in the UI:
 * - Fire spread is Rothermel (1972) from the fuel, slope and wind at the fire's head
 *   (demo/realism.ts spreadRates, reusing fire/rothermel.ts). The wind is an hourly station
 *   series (GET /api/demo/wind) that changes over the clock. A fire is one ellipse with the
 *   ignition at its rear: each minute its head, back and flank grow by the Rothermel head,
 *   backing and flank rates, and its axis is the spread-weighted mean heading. A lumped
 *   simplification of FARSITE's Huygens wavelet propagation (Finney 1998): no per-vertex
 *   fuel or slope, and a wind shift turns the whole ellipse rather than growing a new head.
 * - Containment race (as studio/initialAttack.ts and dispatch/fireAttack.ts): units on scene
 *   build line at their sourced production rate for the fuel and slope (realism.ts
 *   lineMetersPerMinute). The fire is contained when the line reaches its perimeter AND the
 *   head flame length is within the longest flame an on-scene unit's line holds (PMS 465
 *   Hauling chart: 4 ft hand tools, 8 ft engines and dozers). Until then the line is flank
 *   line and cannot exceed the perimeter. Mop-up MOPUP_MINUTES, then the fire is out.
 * - Scheduled ignitions arrive at the activity level's interval, forever; burning fires with a
 *   head intensity above the spotting threshold throw spot fires downwind. At most
 *   MAX_ACTIVE_FIRES burn or smoulder at once.
 * - Households: each zone's carless households (ACS) cannot drive out and stay home. Households
 *   with a vehicle leave on an evacuation order (ORDER_COMPLIANCE of them) or, with no order,
 *   on the fire cue when fire touches the zone (SHADOW_SHARE of them), each with an
 *   exponential departure delay of mean DEPARTURE_MEAN_MINUTES (Camp, Grajdura 2022), then
 *   drive their route's free-flow time. Households home when fire reaches the zone core are
 *   caught. Congestion is not modelled.
 * - Units start at real CAL FIRE stations (GET /api/suppression/bases) or, without the bases
 *   file, at synthetic stations; they drive the road network for their apparatus class
 *   (POST /api/demo/crew_routes) after their turnout, or a straight line x 1.3 while no road
 *   time is known.
 * - A zone that was ordered out or overrun reopens once no fire has touched it for
 *   REOPEN_MINUTES and none is forecast to; caught households stay in the running total.
 *   Fires that are out leave the board after OUT_KEEP_MINUTES.
 *
 * Units: minutes are simulation minutes from T+0; distances metres; areas hectares on output;
 * flame lengths feet (the Hauling chart's unit).
 */

import { isBurnable } from "../fire/fuelModels";
import { SPOTTING_MIN_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND } from "../fire/spread";
import { ellipsePerimeter } from "../studio/initialAttack";
import type { LonLat } from "../live/types";
import {
  DEPARTURE_MEAN_MINUTES,
  FALLBACK_CIRCUITY,
  FALLBACK_FUEL_CODE,
  FALLBACK_SPEED_KMH,
  FALLBACK_WIND,
  FALLBACK_WIND_FROM_DEG,
  FALLBACK_WIND_SPEED_M_PER_S,
  KIND_PREFIX,
  ORDER_COMPLIANCE,
  ROSTER,
  SHADOW_SHARE,
  SpreadCache,
  departedShare,
  groundFrom,
  holdsFlameFeet,
  kindShort,
  lineMetersPerMinute,
  spreadRates,
  turnoutMinutes,
  type DemoApparatusKind,
  type MoistureId,
  type SpreadRates,
} from "./realism";

/** Mean departure delay after the cue (Camp, sourced). The observation's departure figure. */
export const DEPARTURE_SPREAD_MINUTES = DEPARTURE_MEAN_MINUTES;
/** Wind direction of the fallback environment (realism.ts FALLBACK_WIND_FROM_DEG). */
export const WIND_FROM_DEG = FALLBACK_WIND_FROM_DEG;
/** A Type 3 engine's line in the fallback fuel on flat ground, m/min (PMS 465 p.164). */
export const TEAM_LINE_M_PER_MIN = lineMetersPerMinute("engine_t3", FALLBACK_FUEL_CODE, 0);
const FALLBACK_WIND_SPEEDS = { speedMetersPerSecond: FALLBACK_WIND_SPEED_M_PER_S, fromDegrees: FALLBACK_WIND_FROM_DEG };
/** Back over head rate of the fallback environment (fallback fuel and wind, flat, dry). */
export const BACK_RATIO = (() => {
  const r = spreadRates(FALLBACK_FUEL_CODE, 0, 0, FALLBACK_WIND_SPEEDS, "dry");
  return r.headMetersPerMinute > 0 ? r.backMetersPerMinute / r.headMetersPerMinute : 1;
})();

export const MOPUP_MINUTES = 10;
export const OUT_KEEP_MINUTES = 30;
export const REOPEN_MINUTES = 90;
/** Forecasts (zone fire ETAs, containment estimates) look this far ahead, at current rates. */
export const FORECAST_MINUTES = 120;
/** A field report inside a fire, or one it reaches within this many minutes, joins that fire. */
export const REPORT_JOIN_MINUTES = 5;
export const MAX_ACTIVE_FIRES = 25;
/** ASSUMPTION: units drive to the fire's heel, this far behind the burned edge, to anchor. */
export const ANCHOR_OFFSET_M = 100;
/** Size given to a fire at ignition so its outline is drawable, metres. */
const MIN_DRAW_M = 15;
const MAX_EVENTS = 200;
const MAX_SEEN_REPORTS = 1000;
const MAX_STEP_MINUTES = 1;
const METERS_PER_DEG = 111_320;
const SQUARE_METERS_PER_HECTARE = 10_000;
const ELLIPSE_POINTS = 40;
const ZONE_RING_POINTS = 40;
const SYNTHETIC_STATION_COUNT = 3;
const FORECAST_BISECTIONS = 12;

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
  /** Burning fires at least this large can throw spot fires (scenario assumption). */
  spotMinHa: number;
  spotChancePerMinute: number;
}

export const ACTIVITY: Record<Activity, ActivityLevel> = {
  quiet: { label: "Quiet", moisture: "moderate", ignitionEvery: [25, 45], spotMinHa: 60, spotChancePerMinute: 0.01 },
  active: { label: "Active", moisture: "dry", ignitionEvery: [12, 20], spotMinHa: 40, spotChancePerMinute: 0.02 },
  severe: { label: "Severe", moisture: "critical", ignitionEvery: [6, 12], spotMinHa: 25, spotChancePerMinute: 0.04 },
};
export const ACTIVITIES: Activity[] = ["quiet", "active", "severe"];

export type FireSource = "scenario" | "spot" | "field_report" | "manual";
export type FireStatus = "burning" | "contained" | "out";

export interface Fire {
  id: string;
  source: FireSource;
  /** Field reports that started or joined this fire. */
  reportIds: string[];
  origin: LonLat;
  ignitedAt: number;
  /** Current head spread rate, m/min (display; the spread uses `rates`). */
  headRate: number;
  /** Minutes of free growth so far (stops when contained). */
  tau: number;
  /** Distances grown from the ignition, metres: head, back, and the flank half-width. */
  headM: number;
  backM: number;
  flankM: number;
  /** Accumulated head-spread vector (east, north), metres; sets the ellipse axis. */
  axisEastM: number;
  axisNorthM: number;
  /** Rothermel rates at the head, this minute. */
  rates: SpreadRates;
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
  /** Largest outer ring, thinned; fire contact is tested on these vertices. */
  ring: LonLat[];
  core: LonLat;
  orderedAt: number | null;
  route: RouteOption | null;
  /** Fire-cue (shadow) evacuation with no order: when it started and the route taken. */
  shadowAt: number | null;
  shadowRoute: RouteOption | null;
  /** Minute fire first touched the zone edge / reached its core. */
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

/** Everything the board reads from outside: spread inputs, stations, carless counts. */
export interface DemoEnvironment {
  spread: SpreadCache;
  /** Real stations by roster base; null = synthetic stations (bases file unavailable). */
  bases: { calfireStations: Station[]; localStations: Station[]; crewCamps: Station[] } | null;
  basesLabel: string;
  /** Carless households per zone id; missing zones count 0. */
  noVehicle: ReadonlyMap<string, number>;
  noVehicleLabel: string;
}

export function fallbackEnvironment(): DemoEnvironment {
  return {
    spread: new SpreadCache(groundFrom(null), FALLBACK_WIND),
    bases: null,
    basesLabel: "Synthetic stations (assumed: CAL FIRE bases file unavailable)",
    noVehicle: new Map(),
    noVehicleLabel: "Carless households unknown (counted as 0)",
  };
}

export type EventKind = "ignition" | "contained" | "out" | "overrun" | "order" | "team" | "closed" | "zone" | "board";
export interface BoardEvent {
  minute: number;
  kind: EventKind;
  actor: "board" | "agent" | "you";
  text: string;
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

/** Unit vector (east, north) of the fire's axis: the spread-weighted mean heading. */
function axisOf(fire: Pick<Fire, "axisEastM" | "axisNorthM" | "rates">): [number, number] {
  const n = Math.hypot(fire.axisEastM, fire.axisNorthM);
  if (n > 1e-9) return [fire.axisEastM / n, fire.axisNorthM / n];
  const th = (fire.rates.headingDegrees * Math.PI) / 180;
  return [Math.sin(th), Math.cos(th)];
}

interface Shape {
  head: number;
  back: number;
  flank: number;
}

/** The fire's ellipse `t` minutes from now, if its current rates persist. */
function shapeIn(fire: Fire, t: number): Shape {
  const grow = fire.status === "burning" ? t : 0;
  return {
    head: Math.max(MIN_DRAW_M, fire.headM + fire.rates.headMetersPerMinute * grow),
    back: Math.max(MIN_DRAW_M / 2, fire.backM + fire.rates.backMetersPerMinute * grow),
    flank: Math.max(MIN_DRAW_M / 2, fire.flankM + fire.rates.flankMetersPerMinute * grow),
  };
}

function insideShape(fire: Fire, shape: Shape, p: LonLat): boolean {
  const [ux, uy] = axisOf(fire);
  const [ex, ny] = toLocal(fire.origin, p);
  const x = ex * ux + ny * uy;
  const y = -ex * uy + ny * ux;
  const a = (shape.head + shape.back) / 2;
  const c = (shape.head - shape.back) / 2;
  const b = shape.flank;
  return ((x - c) / a) ** 2 + (y / b) ** 2 <= 1;
}

/** Whether the fire covers `p` now. */
export function fireCovers(fire: Fire, p: LonLat): boolean {
  return insideShape(fire, shapeIn(fire, 0), p);
}

/**
 * Minutes until the fire covers `p` if its current rates persist (0 = covered now), or null
 * when not within `limit`. Bisection: the ellipse only grows.
 */
export function waitMinutes(fire: Fire, p: LonLat, limit = FORECAST_MINUTES): number | null {
  if (fireCovers(fire, p)) return 0;
  if (fire.status !== "burning" || limit <= 0) return null;
  const far = shapeIn(fire, limit);
  const reach = Math.hypot(Math.max(far.head, far.back), far.flank);
  if (distanceM(fire.origin, p) > reach || !insideShape(fire, far, p)) return null;
  let lo = 0;
  let hi = limit;
  for (let i = 0; i < FORECAST_BISECTIONS; i += 1) {
    const mid = (lo + hi) / 2;
    if (insideShape(fire, shapeIn(fire, mid), p)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Burning minutes (fire.tau scale) at which the fire covers `p`, at current rates; Infinity
 * when not within the forecast. A fire given only `origin` and `headRate` grows as a circle.
 */
export function arrivalTau(fire: Pick<Fire, "origin" | "headRate"> & Partial<Fire>, p: LonLat): number {
  if (fire.rates === undefined) {
    const d = distanceM(fire.origin, p);
    return d === 0 ? 0 : fire.headRate > 0 ? d / fire.headRate : Infinity;
  }
  const wait = waitMinutes(fire as Fire, p);
  return wait === null ? Infinity : (fire.tau ?? 0) + wait;
}

export function fireAreaHa(fire: Fire): number {
  const s = shapeIn(fire, 0);
  return (Math.PI * ((s.head + s.back) / 2) * s.flank) / SQUARE_METERS_PER_HECTARE;
}

function perimeterOf(shape: Shape): number {
  const a = (shape.head + shape.back) / 2;
  const b = shape.flank;
  // Ramanujan's approximation, via studio/initialAttack.ts ellipsePerimeter(area, L:B).
  return ellipsePerimeter(Math.PI * a * b, Math.max(a, b) / Math.min(a, b));
}

/** Perimeter `t` minutes from now at current rates, metres. */
export function firePerimeterM(fire: Fire, t = 0): number {
  return perimeterOf(shapeIn(fire, t));
}

/** Perimeter growth this minute, m/min (0 once contained). */
export function perimeterGrowth(fire: Fire | number): number {
  if (typeof fire === "number") {
    // A head rate alone: the fallback environment's ellipse shape at that head rate.
    const back = fire * BACK_RATIO;
    const r = spreadRates(FALLBACK_FUEL_CODE, 0, 0, FALLBACK_WIND_SPEEDS, "dry");
    const a = (fire + back) / 2;
    const b = a / r.lengthToBreadth;
    return ellipsePerimeter(Math.PI * a * b, r.lengthToBreadth);
  }
  if (fire.status !== "burning") return 0;
  return firePerimeterM(fire, 1) - firePerimeterM(fire, 0);
}

/** Closed outline of the fire at its current size. */
export function fireRing(fire: Fire, points = ELLIPSE_POINTS): LonLat[] {
  const s = shapeIn(fire, 0);
  const [ux, uy] = axisOf(fire);
  const a = (s.head + s.back) / 2;
  const c = (s.head - s.back) / 2;
  const ring: LonLat[] = [];
  for (let i = 0; i < points; i += 1) {
    const th = (2 * Math.PI * i) / points;
    const x = c + a * Math.cos(th);
    const y = s.flank * Math.sin(th);
    ring.push(fromLocal(fire.origin, [x * ux - y * uy, x * uy + y * ux]));
  }
  ring.push(ring[0]);
  return ring;
}

/** The fire's head point now. */
export function headPoint(fire: Fire): LonLat {
  const [ux, uy] = axisOf(fire);
  return fromLocal(fire.origin, [ux * fire.headM, uy * fire.headM]);
}

/** Where units drive to: the heel, ANCHOR_OFFSET_M behind the burned back edge. */
export function crewTarget(fire: Fire): LonLat {
  const [ux, uy] = axisOf(fire);
  const back = shapeIn(fire, 0).back + ANCHOR_OFFSET_M;
  return fromLocal(fire.origin, [-ux * back, -uy * back]);
}

/** Ignition point of a spot fire `dist` metres beyond the head, offset `side` across. */
function downwindOf(fire: Fire, dist: number, side: number): LonLat {
  const [ux, uy] = axisOf(fire);
  const along = fire.headM + dist;
  return fromLocal(fire.origin, [along * ux - side * uy, along * uy + side * ux]);
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

export function createBoard(zones: BaseZone[], activity: Activity, seed: number, env: DemoEnvironment = fallbackEnvironment()): Board {
  const { teams, stations } = buildTeams(zones, env);
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
    zones: zones.map((z) => {
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
    }),
    env,
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

function ratesAt(board: Board, p: LonLat): SpreadRates {
  return board.env.spread.at(p, board.minute, ACTIVITY[board.activity].moisture);
}

export function ignite(
  board: Board,
  origin: LonLat,
  source: FireSource,
  actor: BoardEvent["actor"],
  reportId?: string,
): Fire | null {
  if (activeFires(board).length >= MAX_ACTIVE_FIRES) return null;
  board.fireCount += 1;
  const rates = ratesAt(board, origin);
  const fire: Fire = {
    id: `F${board.fireCount}`,
    source,
    reportIds: reportId ? [reportId] : [],
    origin,
    ignitedAt: board.minute,
    headRate: Math.round(rates.headMetersPerMinute * 10) / 10,
    tau: 0,
    headM: 0,
    backM: 0,
    flankM: 0,
    axisEastM: 0,
    axisNorthM: 0,
    rates,
    lineM: 0,
    status: "burning",
    containedAt: null,
    outAt: null,
    closedBy: null,
  };
  board.fires.push(fire);
  const zone = zoneAt(board, origin);
  log(
    board,
    "ignition",
    actor,
    `${SOURCE_TEXT[source]}: ${fire.id}${zone ? ` in ${zone.name}` : ""}, head ${fire.headRate} m/min, flame ${rates.headFlameFeet.toFixed(0)} ft${isBurnable(rates.fuelCode) ? "" : " (no wildland fuel here, so no spread)"}.`,
  );
  return fire;
}

/** Candidates a scheduled ignition tries before giving up on finding wildland fuel. */
const IGNITION_CANDIDATES = 24;
/** How far beyond a zone's edge (outward from its core) a scheduled ignition may land, m. */
const IGNITION_OUTSIDE_MAX_M = 1500;

/**
 * A scheduled ignition point near a community. Candidates alternate, starting inside: inside a
 * random zone (between its core and a vertex), then in a ring up to IGNITION_OUTSIDE_MAX_M beyond
 * a vertex, pointing away from the core (toward the wildland around a town). The first candidate on a
 * Scott & Burgan fuel model wins: dense urban zones (LANDFIRE NB91 etc.) carry no fire on this
 * board, so a fire there would never spread. If none of IGNITION_CANDIDATES is burnable, the
 * first in-zone candidate is used. All draws come from the board's seeded generator.
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
    if (isBurnable(board.env.spread.ground.fuelCodeAt(p))) return p;
  }
  return fallback;
}

/** Whether the fire's head is on a Scott & Burgan fuel model (else it cannot spread here). */
export function headOnWildlandFuel(fire: Fire): boolean {
  return isBurnable(fire.rates.fuelCode);
}

/**
 * Turns a fire_seen field report into a fire, or joins it to the fire already there (inside
 * it, or reached within REPORT_JOIN_MINUTES). Each report is used once.
 */
export function addReportFire(board: Board, reportId: string, coord: LonLat): Fire | null {
  if (board.seenReports.includes(reportId)) return null;
  board.seenReports.push(reportId);
  if (board.seenReports.length > MAX_SEEN_REPORTS) board.seenReports.shift();
  const near = activeFires(board).find((f) => waitMinutes(f, coord, REPORT_JOIN_MINUTES) !== null);
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

/** Puts a fire out by hand; its units are freed. */
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

/** A unit's line on this fire's fuel and slope, m/min. */
export function unitLineOn(board: Board, team: Team, fire: Fire | null): number {
  const p = fire?.origin ?? team.position;
  const slope = board.env.spread.ground.slopeAt(p);
  return lineMetersPerMinute(team.kind, board.env.spread.ground.fuelCodeAt(p), slope.slopeTangent * 100);
}

function growFire(board: Board, fire: Fire, dt: number): void {
  const r = ratesAt(board, headPoint(fire));
  fire.rates = r;
  fire.headRate = Math.round(r.headMetersPerMinute * 10) / 10;
  fire.tau += dt;
  fire.headM += r.headMetersPerMinute * dt;
  fire.backM += r.backMetersPerMinute * dt;
  fire.flankM += r.flankMetersPerMinute * dt;
  const th = (r.headingDegrees * Math.PI) / 180;
  fire.axisEastM += r.headMetersPerMinute * dt * Math.sin(th);
  fire.axisNorthM += r.headMetersPerMinute * dt * Math.cos(th);
}

function stepOnce(board: Board, dt: number): void {
  const level = ACTIVITY[board.activity];
  const wholeMinute = Math.floor(board.minute + dt) > Math.floor(board.minute);
  board.minute += dt;

  while (board.nextIgnitionAt <= board.minute) {
    const p = randomIgnitionPoint(board);
    if (p) ignite(board, p, "scenario", "board");
    board.nextIgnitionAt = board.minute + between(board, level.ignitionEvery);
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

  const spots: LonLat[] = [];
  for (const fire of board.fires) {
    if (fire.status === "burning") {
      growFire(board, fire, dt);
      const work = onSceneWork(board, fire);
      const perimeter = firePerimeterM(fire);
      // Line cannot exceed the perimeter; flank line is outflanked as the perimeter grows.
      fire.lineM = Math.min(perimeter, fire.lineM + work.lineMPerMin * dt);
      if (work.count > 0 && fire.lineM >= perimeter && fire.rates.headFlameFeet <= work.holdsFt) {
        fire.status = "contained";
        fire.containedAt = board.minute;
        log(board, "contained", "board", `${fire.id} contained at ${fireAreaHa(fire).toFixed(1)} ha.`);
      } else if (
        fireAreaHa(fire) >= level.spotMinHa &&
        fire.rates.firelineIntensityBtuPerFootPerSecond >= SPOTTING_MIN_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND &&
        nextRandom(board) < level.spotChancePerMinute * dt
      ) {
        spots.push(downwindOf(fire, 300 + 900 * nextRandom(board), (nextRandom(board) - 0.5) * 600));
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
  for (const p of spots) ignite(board, p, "spot", "board");

  const kept: Fire[] = [];
  for (const fire of board.fires) {
    if (fire.status === "out" && fire.outAt !== null && board.minute - fire.outAt >= OUT_KEEP_MINUTES) {
      board.removedBurnedHa += fireAreaHa(fire);
    } else kept.push(fire);
  }
  board.fires = kept;

  const active = activeFires(board);
  for (const zone of board.zones) {
    if (active.some((f) => zone.ring.some((v) => fireCovers(f, v)))) {
      zone.touchedAt ??= board.minute;
      zone.lastFireAt = board.minute;
      // Fire cue with no order: the shadow share leaves on the zone's best route, if any.
      if (zone.orderedAt === null && zone.shadowAt === null && zone.overrunAt === null) {
        const best = board.routes.get(zone.id)?.[0] ?? null;
        if (best) {
          zone.shadowAt = board.minute;
          zone.shadowRoute = best;
          log(board, "zone", "board", `Fire reached ${zone.name} with no order: some households leave on their own, toward ${best.name}.`);
        }
      }
    }
    if (zone.overrunAt === null && active.some((f) => fireCovers(f, zone.core))) {
      zone.overrunAt = board.minute;
      zone.lastFireAt = board.minute;
      zone.caught = zone.households - departed(zone, board.minute);
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

/** Advance the clock by `minutes`, in steps of at most one minute. */
export function step(board: Board, minutes: number): void {
  let left = minutes;
  while (left > 1e-9) {
    const dt = Math.min(MAX_STEP_MINUTES, left);
    stepOnce(board, dt);
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
 * or null when they never catch it within FORECAST_MINUTES. Current spread rates and head
 * flame persist. `units[i]` describes arrival i; missing entries are Type 3 engines in the
 * fallback fuel.
 */
export function containedIn(fire: Fire, arrivals: number[], units: UnitWork[] = []): number | null {
  if (fire.status !== "burning") return fire.status === "contained" ? 0 : null;
  if (arrivals.length === 0) return null;
  const work = arrivals.map((_, i) => units[i] ?? { lineMPerMin: TEAM_LINE_M_PER_MIN, holdsFt: holdsFlameFeet("engine_t3") });
  let line = fire.lineM;
  for (let t = 1; t <= FORECAST_MINUTES; t += 1) {
    let holds = 0;
    for (let i = 0; i < arrivals.length; i += 1) {
      if (arrivals[i] < t) {
        line += work[i].lineMPerMin;
        holds = Math.max(holds, work[i].holdsFt);
      }
    }
    const perimeter = firePerimeterM(fire, t);
    line = Math.min(line, perimeter);
    if (holds > 0 && line >= perimeter && fire.rates.headFlameFeet <= holds) return t;
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
        fire,
        [...assigned, ...pick.map((p) => p.eta)],
        [...assignedWork, ...pick.map((p) => workOf(board, p.team, fire))],
      ),
    });
  }
  return out;
}

export interface ZoneForecast {
  /** Minutes until fire reaches the zone edge / core; 0 = there; null = not within FORECAST_MINUTES. */
  edgeEta: number | null;
  coreEta: number | null;
}

/** Fire ETAs at each zone at current rates; a fire stops spreading at its estimated containment. */
export function zoneForecasts(board: Board): Map<string, ZoneForecast> {
  const fires = activeFires(board).map((f) => {
    const stop = f.status === "contained" ? 0 : currentContainment(board, f);
    return { fire: f, limit: Math.min(stop ?? FORECAST_MINUTES, FORECAST_MINUTES) };
  });
  const eta = (p: LonLat): number | null => {
    let best: number | null = null;
    for (const { fire, limit } of fires) {
      const wait = waitMinutes(fire, p, best === null ? limit : Math.min(limit, best));
      if (wait !== null && (best === null || wait < best)) best = wait;
    }
    return best;
  };
  const out = new Map<string, ZoneForecast>();
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) {
      out.set(zone.id, { edgeEta: 0, coreEta: 0 });
      continue;
    }
    let edge: number | null = null;
    for (const v of zone.ring) {
      const e = eta(v);
      if (e !== null && (edge === null || e < edge)) edge = e;
      if (edge === 0) break;
    }
    const core = eta(zone.core);
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
    t.burnedHa += fireAreaHa(fire);
  }
  return t;
}
