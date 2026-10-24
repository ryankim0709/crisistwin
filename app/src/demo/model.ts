/**
 * Command demo (/demo): a continuously running fire board on the Camp drill zones. Fires keep
 * starting, engine strike teams fight them and households evacuate, on a simulation clock
 * with no end state (24/7 monitoring). Pure: no React, network or LLM; seeded, so a seed and
 * the same orders replay the same run. See docs/adr/0047-command-demo.md.
 *
 * Model, deliberately simple and shown in the UI:
 * - A fire is a wind-driven ellipse growing from its ignition point at a constant head rate,
 *   with a fixed length-to-breadth ratio (scenario assumption); its back spreads at the rate
 *   the ratio implies. Every dimension grows linearly with burning time, so the shape at any
 *   time is the shape at one minute scaled about the ignition point.
 * - Containment race (as studio/initialAttack.ts and dispatch/fireAttack.ts): strike teams on
 *   scene build line; the fire is contained when the line built reaches its perimeter, stops
 *   growing, is mopped up for MOPUP_MINUTES and goes out, freeing its teams. A fire whose
 *   perimeter grows faster than its teams build line is never contained.
 * - Scheduled ignitions arrive at the fire-activity level's interval, forever; large burning
 *   fires throw spot fires downwind. At most MAX_ACTIVE_FIRES burn or smoulder at once.
 * - Households leave only on an evacuation order, uniformly over DEPARTURE_SPREAD_MINUTES
 *   (the dispatch engine's figure), then drive their route's free-flow time. Households still
 *   at home when fire reaches the zone core (its label point) are caught. Congestion is not
 *   modelled.
 * - A zone that was ordered out or overrun reopens (households back, order cleared) once no
 *   fire has touched it for REOPEN_MINUTES and none is forecast to; caught households stay in
 *   the running total. Fires that are out leave the board after OUT_KEEP_MINUTES; their area
 *   stays in the burned total.
 * - Teams travel in a straight line times ROAD_DETOUR_FACTOR at TEAM_SPEED_KPH after the
 *   dispatch engine's turnout time.
 *
 * Units: minutes are simulation minutes from T+0; distances metres; areas hectares on output.
 */

import { DEPARTURE_SPREAD_MINUTES, TURNOUT_SECONDS } from "../dispatch/engine";
import { ENGINE_LINE_METERS_PER_MINUTE } from "../dispatch/fireAttack";
import { ellipsePerimeter } from "../studio/initialAttack";
import type { LonLat } from "../live/types";

export { DEPARTURE_SPREAD_MINUTES };

/** Engines in one strike team (NWCG engine strike team). */
export const ENGINES_PER_TEAM = 5;
/** Line one strike team builds per minute: five engines at the engine rate. */
export const TEAM_LINE_M_PER_MIN = ENGINES_PER_TEAM * ENGINE_LINE_METERS_PER_MINUTE;
export const TEAM_COUNT = 6;
export const TEAM_SPEED_KPH = 50;
export const ROAD_DETOUR_FACTOR = 1.3;
/** Fire length-to-breadth ratio (scenario assumption: moderate wind). */
export const LENGTH_TO_BREADTH = 2.5;
/** Wind blows from this bearing (degrees from north); the Camp Fire's wind was from the NE. */
export const WIND_FROM_DEG = 45;
export const MOPUP_MINUTES = 10;
export const OUT_KEEP_MINUTES = 30;
export const REOPEN_MINUTES = 90;
/** Forecasts (zone fire ETAs, containment estimates) look this far ahead. */
export const FORECAST_MINUTES = 120;
/** A field report inside a fire, or one it reaches within this many minutes, joins that fire. */
export const REPORT_JOIN_MINUTES = 5;
export const MAX_ACTIVE_FIRES = 25;
const MAX_EVENTS = 200;
const MAX_SEEN_REPORTS = 1000;
const MAX_STEP_MINUTES = 1;
const METERS_PER_DEG = 111_320;
const SQUARE_METERS_PER_HECTARE = 10_000;
const ELLIPSE_POINTS = 40;
const ZONE_RING_POINTS = 40;
const STATION_COUNT = 3;

export type Activity = "quiet" | "active" | "severe";

export interface ActivityLevel {
  label: string;
  /** Head spread rate range, metres per minute. */
  headRate: [number, number];
  /** Minutes between scheduled ignitions. */
  ignitionEvery: [number, number];
  /** Burning fires at least this large can throw spot fires. */
  spotMinHa: number;
  spotChancePerMinute: number;
}

export const ACTIVITY: Record<Activity, ActivityLevel> = {
  quiet: { label: "Quiet", headRate: [8, 16], ignitionEvery: [25, 45], spotMinHa: 60, spotChancePerMinute: 0.01 },
  active: { label: "Active", headRate: [12, 24], ignitionEvery: [12, 20], spotMinHa: 40, spotChancePerMinute: 0.02 },
  severe: { label: "Severe", headRate: [18, 32], ignitionEvery: [6, 12], spotMinHa: 25, spotChancePerMinute: 0.04 },
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
  /** Head spread rate, m/min. */
  headRate: number;
  /** Minutes of free growth so far (stops when contained). */
  tau: number;
  /** Line built, metres. */
  lineM: number;
  status: FireStatus;
  containedAt: number | null;
  outAt: number | null;
  closedBy: "teams" | "manual" | null;
}

export type TeamStatus = "available" | "en_route" | "on_scene";

export interface Team {
  id: string;
  station: string;
  /** Where the team is, or where it set off from while en route. */
  position: LonLat;
  status: TeamStatus;
  fireId: string | null;
  departAt: number | null;
  arriveAt: number | null;
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
  /** Largest outer ring, thinned; fire contact is tested on these vertices. */
  ring: LonLat[];
  core: LonLat;
  orderedAt: number | null;
  route: RouteOption | null;
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

/** Unit vector the wind blows toward (x east, y north). */
const DOWNWIND: [number, number] = (() => {
  const toward = ((WIND_FROM_DEG + 180) * Math.PI) / 180;
  return [Math.sin(toward), Math.cos(toward)];
})();

/** Back spread rate over head rate implied by the length-to-breadth ratio. */
export const BACK_RATIO = (() => {
  const r = Math.sqrt(LENGTH_TO_BREADTH ** 2 - 1);
  return (LENGTH_TO_BREADTH - r) / (LENGTH_TO_BREADTH + r);
})();

/** Ellipse per minute of burning: semi-axes and centre offset downwind, metres. */
function unitEllipse(headRate: number): { a: number; b: number; c: number } {
  const back = headRate * BACK_RATIO;
  const a = (headRate + back) / 2;
  return { a, b: a / LENGTH_TO_BREADTH, c: (headRate - back) / 2 };
}

export function fireAreaHa(fire: Pick<Fire, "headRate" | "tau">): number {
  const { a, b } = unitEllipse(fire.headRate);
  return (Math.PI * a * b * fire.tau ** 2) / SQUARE_METERS_PER_HECTARE;
}

export function firePerimeterM(headRate: number, tau: number): number {
  return ellipsePerimeter(fireAreaHa({ headRate, tau }) * SQUARE_METERS_PER_HECTARE, LENGTH_TO_BREADTH);
}

/** Perimeter growth while burning, metres per minute (constant: the shape scales linearly). */
export function perimeterGrowth(headRate: number): number {
  return firePerimeterM(headRate, 1);
}

/**
 * Burning minutes after which the fire's ellipse covers `p` (0 at the ignition point).
 * Solves ((x - c t) / (a t))^2 + (y / (b t))^2 = 1 for t, x downwind and y across.
 */
export function arrivalTau(fire: Pick<Fire, "origin" | "headRate">, p: LonLat): number {
  const [ex, ny] = toLocal(fire.origin, p);
  const x = ex * DOWNWIND[0] + ny * DOWNWIND[1];
  const y = -ex * DOWNWIND[1] + ny * DOWNWIND[0];
  const { a, b, c } = unitEllipse(fire.headRate);
  const qa = (c * c) / (a * a) - 1;
  const qb = (-2 * x * c) / (a * a);
  const qc = (x * x) / (a * a) + (y * y) / (b * b);
  if (qc === 0) return 0;
  return (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
}

/** Closed outline of the fire at its current size. */
export function fireRing(fire: Fire, points = ELLIPSE_POINTS): LonLat[] {
  const { a, b, c } = unitEllipse(fire.headRate);
  const t = Math.max(fire.tau, 0.5);
  const ring: LonLat[] = [];
  for (let i = 0; i < points; i += 1) {
    const th = (2 * Math.PI * i) / points;
    const x = (c + a * Math.cos(th)) * t;
    const y = b * Math.sin(th) * t;
    ring.push(fromLocal(fire.origin, [x * DOWNWIND[0] - y * DOWNWIND[1], x * DOWNWIND[1] + y * DOWNWIND[0]]));
  }
  ring.push(ring[0]);
  return ring;
}

/** Ignition point of a spot fire `dist` metres downwind of the head, offset `side` across. */
function downwindOf(fire: Fire, dist: number, side: number): LonLat {
  const along = fire.headRate * fire.tau + dist;
  return fromLocal(fire.origin, [along * DOWNWIND[0] - side * DOWNWIND[1], along * DOWNWIND[1] + side * DOWNWIND[0]]);
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
 * Synthetic stations: `count` zone cores spread across the area by farthest-point sampling,
 * starting from the zone with the most households. Not real fire stations.
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
  return chosen.map((z, i) => ({ id: `S${i + 1}`, name: `Station ${i + 1}`, location: z.core }));
}

export function createBoard(zones: BaseZone[], activity: Activity, seed: number): Board {
  const stations = pickStations(zones, STATION_COUNT);
  const board: Board = {
    seed,
    activity,
    minute: 0,
    rng: seed >>> 0,
    nextIgnitionAt: 0,
    fireCount: 0,
    fires: [],
    teams: Array.from({ length: TEAM_COUNT }, (_, i) => {
      const station = stations[i % Math.max(1, stations.length)];
      return {
        id: `T${i + 1}`,
        station: station?.id ?? "",
        position: station?.location ?? zones[0]?.core ?? [0, 0],
        status: "available" as TeamStatus,
        fireId: null,
        departAt: null,
        arriveAt: null,
      };
    }),
    stations,
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      households: Math.max(0, Math.round(z.households)),
      ring: thinRing(z.ring),
      core: z.core,
      orderedAt: null,
      route: null,
      touchedAt: null,
      overrunAt: null,
      lastFireAt: null,
      caught: 0,
    })),
    seenReports: [],
    events: [],
    caughtTotal: 0,
    firesOutTotal: 0,
    removedBurnedHa: 0,
  };
  log(board, "board", "board", `Monitoring started, ${ACTIVITY[activity].label.toLowerCase()} fire activity, seed ${seed}. ${TEAM_COUNT} strike teams ready.`);
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

export function ignite(
  board: Board,
  origin: LonLat,
  source: FireSource,
  actor: BoardEvent["actor"],
  reportId?: string,
): Fire | null {
  if (activeFires(board).length >= MAX_ACTIVE_FIRES) return null;
  board.fireCount += 1;
  const fire: Fire = {
    id: `F${board.fireCount}`,
    source,
    reportIds: reportId ? [reportId] : [],
    origin,
    ignitedAt: board.minute,
    headRate: Math.round(between(board, ACTIVITY[board.activity].headRate)),
    tau: 0,
    lineM: 0,
    status: "burning",
    containedAt: null,
    outAt: null,
    closedBy: null,
  };
  board.fires.push(fire);
  const zone = zoneAt(board, origin);
  log(board, "ignition", actor, `${SOURCE_TEXT[source]}: ${fire.id}${zone ? ` in ${zone.name}` : ""}, head ${fire.headRate} m/min.`);
  return fire;
}

/** A random point inside a random zone (between its core and one of its vertices). */
function randomIgnitionPoint(board: Board): LonLat | null {
  if (board.zones.length === 0) return null;
  const zone = board.zones[Math.floor(nextRandom(board) * board.zones.length)];
  const vertex = zone.ring[Math.floor(nextRandom(board) * zone.ring.length)];
  if (!vertex) return zone.core;
  const u = 0.15 + 0.6 * nextRandom(board);
  return [zone.core[0] + (vertex[0] - zone.core[0]) * u, zone.core[1] + (vertex[1] - zone.core[1]) * u];
}

/**
 * Turns a fire_seen field report into a fire, or joins it to the fire already there (inside
 * it, or reached within REPORT_JOIN_MINUTES). Each report is used once.
 */
export function addReportFire(board: Board, reportId: string, coord: LonLat): Fire | null {
  if (board.seenReports.includes(reportId)) return null;
  board.seenReports.push(reportId);
  if (board.seenReports.length > MAX_SEEN_REPORTS) board.seenReports.shift();
  const near = activeFires(board).find((f) => arrivalTau(f, coord) <= f.tau + REPORT_JOIN_MINUTES);
  if (near) {
    near.reportIds.push(reportId);
    log(board, "ignition", "board", `Field report joined to ${near.id}.`);
    return null;
  }
  return ignite(board, coord, "field_report", "board", reportId);
}

// ---- teams ----

export function travelMinutes(from: LonLat, to: LonLat): number {
  const meters = distanceM(from, to) * ROAD_DETOUR_FACTOR;
  return TURNOUT_SECONDS / 60 + meters / ((TEAM_SPEED_KPH * 1000) / 60);
}

/** Where a team is now (en route: along the straight line to its fire). */
export function teamPosition(board: Board, team: Team): LonLat {
  if (team.status !== "en_route" || team.departAt === null || team.arriveAt === null) return team.position;
  const fire = board.fires.find((f) => f.id === team.fireId);
  if (!fire) return team.position;
  const span = team.arriveAt - team.departAt;
  const u = span > 0 ? Math.min(1, Math.max(0, (board.minute - team.departAt) / span)) : 1;
  return [team.position[0] + (fire.origin[0] - team.position[0]) * u, team.position[1] + (fire.origin[1] - team.position[1]) * u];
}

function release(board: Board, team: Team): void {
  team.position = teamPosition(board, team);
  team.status = "available";
  team.fireId = null;
  team.departAt = team.arriveAt = null;
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
    if (!team) return `Unknown team ${order.crew_id}.`;
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
    team.position = from;
    team.status = "en_route";
    team.fireId = fire.id;
    team.departAt = board.minute;
    team.arriveAt = board.minute + travelMinutes(from, fire.origin);
    log(board, "team", actor, `${team.id} sent to ${fire.id}, on scene in ${Math.ceil(team.arriveAt - board.minute)} min.`);
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

/** Puts a fire out by hand; its teams are freed. */
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

export function departed(zone: ZoneState, minute: number): number {
  if (zone.orderedAt === null) return 0;
  const end = zone.overrunAt !== null ? Math.min(minute, zone.overrunAt) : minute;
  const share = Math.min(1, Math.max(0, (end - zone.orderedAt) / DEPARTURE_SPREAD_MINUTES));
  return Math.floor(zone.households * share);
}

export interface ZoneCounts {
  home: number;
  enRoute: number;
  out: number;
  caught: number;
}

export function zoneCounts(zone: ZoneState, minute: number): ZoneCounts {
  const left = departed(zone, minute);
  const drive = zone.route?.eta_min ?? 0;
  const out = departed(zone, minute - drive);
  return { home: Math.max(0, zone.households - left - zone.caught), enRoute: left - out, out, caught: zone.caught };
}

// ---- stepping ----

function reopenZones(board: Board): void {
  let forecast: Map<string, ZoneForecast> | null = null;
  for (const zone of board.zones) {
    if (zone.orderedAt === null && zone.overrunAt === null) continue;
    const quietSince = Math.max(zone.lastFireAt ?? -Infinity, zone.orderedAt ?? -Infinity);
    if (board.minute - quietSince < REOPEN_MINUTES) continue;
    forecast ??= zoneForecasts(board);
    if (forecast.get(zone.id)?.edgeEta !== null) continue;
    zone.orderedAt = zone.overrunAt = zone.touchedAt = zone.lastFireAt = null;
    zone.route = null;
    zone.caught = 0;
    log(board, "zone", "board", `${zone.name} reopened: no fire near for ${REOPEN_MINUTES} min, households back home.`);
  }
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
      team.position = fire.origin;
      team.status = "on_scene";
      team.departAt = team.arriveAt = null;
    } else release(board, team);
  }

  const spots: LonLat[] = [];
  for (const fire of board.fires) {
    if (fire.status === "burning") {
      fire.tau += dt;
      const onScene = board.teams.filter((t) => t.fireId === fire.id && t.status === "on_scene").length;
      fire.lineM += onScene * TEAM_LINE_M_PER_MIN * dt;
      if (onScene > 0 && fire.lineM >= firePerimeterM(fire.headRate, fire.tau)) {
        fire.status = "contained";
        fire.containedAt = board.minute;
        log(board, "contained", "board", `${fire.id} contained at ${fireAreaHa(fire).toFixed(1)} ha.`);
      } else if (fireAreaHa(fire) >= level.spotMinHa && nextRandom(board) < level.spotChancePerMinute * dt) {
        spots.push(downwindOf(fire, 300 + 900 * nextRandom(board), (nextRandom(board) - 0.5) * 600));
      }
    } else if (fire.status === "contained" && fire.containedAt !== null && board.minute - fire.containedAt >= MOPUP_MINUTES) {
      fire.status = "out";
      fire.outAt = board.minute;
      fire.closedBy = "teams";
      board.firesOutTotal += 1;
      for (const team of board.teams) if (team.fireId === fire.id) release(board, team);
      log(board, "out", "board", `${fire.id} is out; its teams are free.`);
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
    if (active.some((f) => zone.ring.some((v) => arrivalTau(f, v) <= f.tau))) {
      zone.touchedAt ??= board.minute;
      zone.lastFireAt = board.minute;
    }
    if (zone.overrunAt === null && active.some((f) => arrivalTau(f, zone.core) <= f.tau)) {
      zone.overrunAt = board.minute;
      zone.lastFireAt = board.minute;
      zone.caught = zone.households - departed(zone, board.minute);
      board.caughtTotal += zone.caught;
      log(
        board,
        "overrun",
        "board",
        `Fire reached the core of ${zone.name}${zone.caught ? `: ${zone.caught.toLocaleString("en-US")} households still home` : ""}.`,
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

/**
 * Minutes until teams arriving at `arrivals` (minutes from now, 0 = on scene) contain `fire`,
 * or null when they never catch it within FORECAST_MINUTES.
 */
export function containedIn(fire: Fire, arrivals: number[]): number | null {
  if (fire.status !== "burning") return fire.status === "contained" ? 0 : null;
  if (arrivals.length === 0) return null;
  let line = fire.lineM;
  for (let t = 1; t <= FORECAST_MINUTES; t += 1) {
    line += arrivals.filter((a) => a < t).length * TEAM_LINE_M_PER_MIN;
    if (line >= firePerimeterM(fire.headRate, fire.tau + t)) return t;
  }
  return null;
}

function teamArrival(board: Board, team: Team, fire: Fire): number {
  if (team.fireId === fire.id) {
    return team.status === "on_scene" ? 0 : Math.max(0, (team.arriveAt ?? board.minute) - board.minute);
  }
  return travelMinutes(teamPosition(board, team), fire.origin);
}

/** Containment estimate with the teams already assigned. */
export function currentContainment(board: Board, fire: Fire): number | null {
  return containedIn(
    fire,
    board.teams.filter((t) => t.fireId === fire.id).map((t) => teamArrival(board, t, fire)),
  );
}

export interface ContainOption {
  teams: string[];
  contained_in_min: number | null;
}

/** Sending the n nearest free teams (n = 1..max) on top of those already assigned. */
export function containOptions(board: Board, fire: Fire, max = 4): ContainOption[] {
  if (fire.status !== "burning") return [];
  const assigned = board.teams.filter((t) => t.fireId === fire.id).map((t) => teamArrival(board, t, fire));
  const free = board.teams
    .filter((t) => t.status === "available")
    .map((t) => ({ id: t.id, eta: teamArrival(board, t, fire) }))
    .sort((a, b) => a.eta - b.eta);
  const out: ContainOption[] = [];
  for (let n = 1; n <= Math.min(max, free.length); n += 1) {
    const pick = free.slice(0, n);
    out.push({ teams: pick.map((p) => p.id), contained_in_min: containedIn(fire, [...assigned, ...pick.map((p) => p.eta)]) });
  }
  return out;
}

export interface ZoneForecast {
  /** Minutes until fire reaches the zone edge / core; 0 = there; null = not within FORECAST_MINUTES. */
  edgeEta: number | null;
  coreEta: number | null;
}

/** Fire ETAs at each zone; a fire stops spreading at its estimated containment. */
export function zoneForecasts(board: Board): Map<string, ZoneForecast> {
  const fires = activeFires(board).map((f) => {
    const stop = f.status === "contained" ? 0 : currentContainment(board, f);
    return { fire: f, limit: Math.min(stop ?? FORECAST_MINUTES, FORECAST_MINUTES) };
  });
  const eta = (p: LonLat): number | null => {
    let best: number | null = null;
    for (const { fire, limit } of fires) {
      const wait = Math.max(0, arrivalTau(fire, p) - fire.tau);
      if (wait <= limit && (best === null || wait < best)) best = wait;
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
  burning: number;
  contained: number;
  firesOutTotal: number;
  burnedHa: number;
}

export function totals(board: Board): Totals {
  const t: Totals = {
    households: 0,
    home: 0,
    enRoute: 0,
    out: 0,
    caught: 0,
    caughtTotal: board.caughtTotal,
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
  }
  for (const fire of board.fires) {
    if (fire.status === "burning") t.burning += 1;
    else if (fire.status === "contained") t.contained += 1;
    t.burnedHa += fireAreaHa(fire);
  }
  return t;
}
