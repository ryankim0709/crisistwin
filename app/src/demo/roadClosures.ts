/**
 * Controller drill road closures on the simulated command board (docs/command-demo-realism.md
 * "Road closures"). Pure board logic: no React, network or LLM.
 *
 * The controller closes a drill road segment on the Live map (GET/POST/DELETE
 * /api/live/incidents/<id>/road-closures, live/useRoadClosures.ts). The routers honour it server
 * side: POST /api/demo/routes and /api/demo/crew_routes treat every closed segment as blocked and
 * echo the set they used (`closed_segment_ids`). This module brings the running board in line:
 *
 * - Units (applyClosureSet): a unit on the road (to a fire, home, moving up) whose road line
 *   AHEAD of it uses a newly closed segment stops where it is and waits for a new road leg from
 *   there (`pending`; the page fetches it, the clock holds as for any leg). This is its own path,
 *   not model.rerouteTeam: a closure is the controller's decision, not the fire cutting the road,
 *   so it does not count toward MAX_FIRE_CUT_REROUTES and has no backoff. A unit whose new leg
 *   has no road route is handled as any failed leg (model.travelLegFailed / returnFailed: logged,
 *   it stays or waits; never driven through). Cached legs over the closed road are dropped; a
 *   reopening drops every cached leg, no-route answer and class reach, so all are asked again.
 * - Zones (reconcileZones, on each routes answer that already honours every closure the board
 *   knows): a zone leaving (or scheduled) on a route over a closed segment that the new answer
 *   does not offer switches to the answer's best option. Cohorts already on the road whose line
 *   ahead of them uses the closure take that route instead (ASSUMPTION: from the closure minute,
 *   the new route's free-flow time, `eta_min`; the distance already driven is neither credited
 *   nor charged); cohorts already past it, or arrived, keep their arrival. With no route left
 *   the zone is held: its route is cleared, so households that leave wait at the zone and cohorts
 *   before the closure wait where they are (arrival unknown, Infinity) until a route opens; a
 *   scheduled order with no route is dropped (households stay home). Arrivals stay first in first
 *   out per zone and no household is added or lost (departures are untouched).
 *
 * "Uses a segment" is geometric (the route lines carry no drill segment ids): a line uses a closed
 * segment when it runs within USE_TOLERANCE_M of, and roughly along (USE_MAX_ANGLE_DEG), at least
 * two of three points inside the segment (25 / 50 / 75 % of its length; the midpoint only for a
 * segment shorter than SHORT_SEGMENT_M), so a road that only crosses it at an end does not count.
 * ASSUMPTION (no source): tolerances chosen for lines simplified at 25 m (app/backend/api/demo.py).
 * Deterministic for a board and a closure set.
 */

import type { LonLat } from "../live/types";
import {
  fallbackDriveMinutes,
  teamPosition,
  travelKey,
  type Board,
  type BoardEvent,
  type BoardEventRefs,
  type RouteOption,
  type Team,
  type ZoneState,
} from "./model";

/** One closure as the Live API returns it (docs/live-reports.md "Road closures"). */
export interface RoadClosure {
  segmentId: string;
  name: string;
  /** The segment's drill road line, WGS84 [lon, lat]. */
  line: LonLat[];
  /** Wall time it was closed (ISO), and the closing console's board minute (null = not sent). */
  closedAt: string | null;
  boardMinute: number | null;
  /** "controller" or "agent:<name>". */
  by: string;
}

export const USE_TOLERANCE_M = 30;
export const USE_MAX_ANGLE_DEG = 40;
export const SHORT_SEGMENT_M = 50;
const M_PER_DEG = 111_320;
const MAX_EVENTS = 200;

interface Sample {
  at: LonLat;
  /** Bearing of the segment there, degrees (0..180, direction ignored). */
  bearing: number;
}

interface Applied {
  closure: RoadClosure;
  /** Board minute this board applied it. */
  sinceMinute: number;
  samples: Sample[];
}

/**
 * One change of the closure set as this board applied it, with what it did (the AI commander's
 * urgent wake reads it, demo/closureWake.ts). `units` is filled by applyClosureSet, `zones` by the
 * reconcileZones runs after it (until the next change).
 */
export interface ClosureChange {
  /** 1, 2, ... per board (closureSeq). */
  seq: number;
  minute: number;
  closed: RoadClosure[];
  reopened: RoadClosure[];
  /** Units stopped for a new road leg: their arrival minute before the closure and where they drive ("to F2", "home"). */
  units: { teamId: string; wasArriveAt: number | null; to: string }[];
  /** Evacuating or scheduled zones whose route the board switched (to null: no open route left). */
  zones: { zoneId: string; scheduled: boolean; from: RouteOption | null; to: RouteOption | null }[];
}

interface ClosureState {
  /** Closed segment ids, sorted. */
  ids: string[];
  byId: Map<string, Applied>;
  /** A closure whose summary waits for the zones' reroute (logged by reconcileZones). */
  pending: { names: string[]; teamIds: string[]; by: string } | null;
  /** The last MAX_CHANGES changes, oldest first. */
  changes: ClosureChange[];
}

const STATE = new WeakMap<Board, ClosureState>();
const MAX_CHANGES = 20;

function stateOf(board: Board): ClosureState {
  let s = STATE.get(board);
  if (!s) {
    s = { ids: [], byId: new Map(), pending: null, changes: [] };
    STATE.set(board, s);
  }
  return s;
}

/** Sequence number of the board's latest closure change (0: none yet). */
export function closureSeq(board: Board): number {
  const c = STATE.get(board)?.changes;
  return c && c.length ? c[c.length - 1].seq : 0;
}

/** Closure changes after sequence number `seq`, oldest first. */
export function closureChangesSince(board: Board, seq: number): ClosureChange[] {
  return (STATE.get(board)?.changes ?? []).filter((c) => c.seq > seq);
}

/** Whether a road line (a route option's `line`) runs along a drill road segment's line (the module note's test). */
export function lineUsesRoad(line: readonly LonLat[], road: readonly LonLat[]): boolean {
  return usedAt(line, samplesOf(road)).length > 0;
}

/** Closed segment ids on this board, sorted. */
export function closedIds(board: Board): string[] {
  return STATE.get(board)?.ids ?? [];
}

/** A key that changes whenever the board's closure set does. */
export function closureKey(board: Board): string {
  return closedIds(board).join(",");
}

/** The closures in effect on this board, oldest first. */
export function boardClosures(board: Board): { closure: RoadClosure; sinceMinute: number }[] {
  const s = STATE.get(board);
  return s ? [...s.byId.values()].sort((a, b) => a.sinceMinute - b.sinceMinute || a.closure.segmentId.localeCompare(b.closure.segmentId)) : [];
}

/**
 * Whether a routing answer that used `answered` closed segments honours every closure the board
 * knows (a superset). An answer missing one was computed before the closure (or without the
 * store) and must not be used.
 */
export function answerCovers(board: Board, answered: readonly string[] | null | undefined): boolean {
  const ids = closedIds(board);
  if (ids.length === 0) return true;
  if (!answered) return false;
  const set = new Set(answered);
  return ids.every((id) => set.has(id));
}

/** The AI commander's view (observation `closed_roads`). */
export function closedRoadsObservation(board: Board): { segment_id: string; name: string; since_minute: number; by: string }[] {
  return boardClosures(board).map(({ closure, sinceMinute }) => ({
    segment_id: closure.segmentId,
    name: closure.name,
    since_minute: Math.round(sinceMinute),
    by: closure.by,
  }));
}

// ---- geometry ----

function xy(origin: LonLat, p: LonLat): [number, number] {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [(p[0] - origin[0]) * k * M_PER_DEG, (p[1] - origin[1]) * M_PER_DEG];
}

function bearingOf(a: LonLat, b: LonLat): number {
  const [x, y] = xy(a, b);
  const deg = (Math.atan2(x, y) * 180) / Math.PI;
  return ((deg % 180) + 180) % 180;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

function lengthM(line: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += Math.hypot(...xy(line[i - 1], line[i]));
  return total;
}

function pointAt(line: readonly LonLat[], share: number): Sample | null {
  if (line.length < 2) return null;
  const target = share * lengthM(line);
  let acc = 0;
  for (let i = 1; i < line.length; i += 1) {
    const l = Math.hypot(...xy(line[i - 1], line[i]));
    if (acc + l >= target || i === line.length - 1) {
      const f = l > 0 ? Math.min(1, Math.max(0, (target - acc) / l)) : 0;
      const a = line[i - 1];
      const b = line[i];
      return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing: bearingOf(a, b) };
    }
    acc += l;
  }
  return null;
}

function samplesOf(line: readonly LonLat[]): Sample[] {
  const shares = lengthM(line) < SHORT_SEGMENT_M ? [0.5] : [0.25, 0.5, 0.75];
  return shares.flatMap((s) => pointAt(line, s) ?? []);
}

/** Shares (0..1 by length) along `line` where it runs on the closure's sample points; [] when it does not use it. */
function usedAt(line: readonly LonLat[], samples: Sample[]): number[] {
  if (line.length < 2 || samples.length === 0) return [];
  const origin = line[0];
  const pts = line.map((p) => xy(origin, p));
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [];
  const shares: number[] = [];
  for (const s of samples) {
    const [px, py] = xy(origin, s.at);
    let best = Infinity;
    let bestShare = 0;
    let bestBearing = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d < best) {
        best = d;
        bestShare = (cum[i - 1] + t * Math.sqrt(l2)) / total;
        bestBearing = ((((Math.atan2(dx, dy) * 180) / Math.PI) % 180) + 180) % 180;
      }
    }
    if (best <= USE_TOLERANCE_M && angleDiff(bestBearing, s.bearing) <= USE_MAX_ANGLE_DEG) shares.push(bestShare);
  }
  const needed = samples.length === 1 ? 1 : 2;
  return shares.length >= needed ? shares : [];
}

const hitCache = new WeakMap<readonly LonLat[], Map<string, number[]>>();

function usedAtCached(line: readonly LonLat[], applied: Applied): number[] {
  let m = hitCache.get(line);
  if (!m) {
    m = new Map();
    hitCache.set(line, m);
  }
  const hit = m.get(applied.closure.segmentId);
  if (hit) return hit;
  const shares = usedAt(line, applied.samples);
  m.set(applied.closure.segmentId, shares);
  return shares;
}

/** The closures `line` uses beyond share `from` (0..1) of its length. */
function closuresAhead(line: readonly LonLat[] | null, closures: Iterable<Applied>, from: number): Applied[] {
  if (!line || line.length < 2) return [];
  const out: Applied[] = [];
  for (const c of closures) if (usedAtCached(line, c).some((s) => s > from + 1e-6)) out.push(c);
  return out;
}

// ---- board events ----

function log(board: Board, text: string, refs: BoardEventRefs, actor: BoardEvent["actor"] = "you"): void {
  board.events.unshift({ minute: Math.round(board.minute), kind: "board", actor, text, refs });
  if (board.events.length > MAX_EVENTS) board.events.length = MAX_EVENTS;
}

const byLabel = (by: string) => (by === "controller" ? "controller" : by.replace(/^agent:/, "agent "));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- units ----

const onTheRoad = (t: Team) => t.status === "en_route" || t.status === "returning" || t.status === "moving_up";

/** Share of its road line a moving unit has covered (0 before it rolls). */
function shareNow(board: Board, team: Team): number {
  if (team.rollAt === null || team.arriveAt === null) return 0;
  const span = team.arriveAt - team.rollAt;
  return span > 0 ? Math.min(1, Math.max(0, (board.minute - team.rollAt) / span)) : board.minute >= team.rollAt ? 1 : 0;
}

/** Stops a unit where it is and waits for a new road leg from there to the same target (see the module note). */
function rerouteForClosure(board: Board, team: Team): void {
  if (!team.target) return;
  const here = teamPosition(board, team);
  const destKey = team.legKey?.split("|")[2] ?? team.lineId ?? team.fireId ?? "";
  if (team.legKey) board.travel.delete(team.legKey);
  const key = travelKey(team, here, destKey, team.target);
  board.travel.delete(key);
  board.noRoute.delete(key);
  const rollAt = Math.max(board.minute, team.rollAt ?? board.minute);
  team.position = here;
  team.rollAt = rollAt;
  team.route = null;
  team.travel = "pending";
  team.legKey = key;
  team.rerouteAt = null;
  team.arriveAt = rollAt + fallbackDriveMinutes(here, team.target) * team.travelFactor;
}

/**
 * Brings the board to the closure set `list` (the Live API's current closures). Units whose road
 * ahead uses a newly closed segment reroute; cached legs are dropped (see the module note); one
 * event per change (a closure's summary waits for the zones' reroute when any zone is leaving or
 * scheduled). Returns whether anything changed.
 */
export function applyClosureSet(board: Board, list: readonly RoadClosure[]): boolean {
  const s = stateOf(board);
  const next = new Map(list.map((c) => [c.segmentId, c]));
  const added = list.filter((c) => !s.byId.has(c.segmentId));
  const removed = [...s.byId.values()].filter((a) => !next.has(a.closure.segmentId));
  if (added.length === 0 && removed.length === 0) return false;

  const fresh: Applied[] = added.map((closure) => ({ closure, sinceMinute: board.minute, samples: samplesOf(closure.line) }));
  for (const a of fresh) s.byId.set(a.closure.segmentId, a);
  for (const a of removed) s.byId.delete(a.closure.segmentId);
  s.ids = [...s.byId.keys()].sort();
  const change: ClosureChange = {
    seq: closureSeq(board) + 1,
    minute: board.minute,
    closed: added,
    reopened: removed.map((a) => a.closure),
    units: [],
    zones: [],
  };
  s.changes.push(change);
  if (s.changes.length > MAX_CHANGES) s.changes.splice(0, s.changes.length - MAX_CHANGES);

  if (removed.length) {
    // Roads open again: every cached leg, no-route answer and reach note may now be beaten.
    board.travel.clear();
    board.noRoute.clear();
    board.classReach.clear();
    const names = removed.map((a) => a.closure.name);
    log(board, `Road reopened (drill, by ${byLabel(removed[0].closure.by)}): ${names.join(", ")}. Routes are recomputed with it open.`, {
      action: "road_reopened",
      label: names.join(", "),
    });
  }
  if (fresh.length === 0) return true;

  const rerouted: string[] = [];
  for (const team of board.teams) {
    if (!onTheRoad(team) || !team.route || team.travel === "pending") continue;
    if (closuresAhead(team.route, fresh, shareNow(board, team)).length === 0) continue;
    const to = team.status === "returning" ? "home" : team.status === "moving_up" ? `to cover ${team.coverStation ?? "a station"}` : `to ${team.fireId ?? "its target"}`;
    change.units.push({ teamId: team.id, wasArriveAt: team.arriveAt, to });
    rerouteForClosure(board, team);
    rerouted.push(team.id);
  }
  for (const [key, leg] of [...board.travel]) if (closuresAhead(leg.line, fresh, 0).length) board.travel.delete(key);
  // A class that reached a target may have done so over the closed road; failures still hold.
  for (const [key, entry] of [...board.classReach]) if (entry.reached) board.classReach.delete(key);

  const names = fresh.map((a) => a.closure.name);
  const zonesMoving = board.zones.some((z) => z.overrunAt === null && (z.orderedAt !== null || z.pendingOrder !== null));
  const pending = s.pending ?? { names: [], teamIds: [], by: fresh[0].closure.by };
  pending.names.push(...names.filter((n) => !pending.names.includes(n)));
  pending.teamIds.push(...rerouted.filter((id) => !pending.teamIds.includes(id)));
  if (zonesMoving) s.pending = pending;
  else {
    s.pending = null;
    logClosed(board, pending, 0);
  }
  return true;
}

function logClosed(board: Board, p: NonNullable<ClosureState["pending"]>, zones: number): void {
  const units = p.teamIds.length ? `${plural(p.teamIds.length, "unit")} (${p.teamIds.join(", ")})` : "no units";
  log(
    board,
    `Road closed (drill, by ${byLabel(p.by)}): ${p.names.join(", ")}. No unit or evacuating household uses it; ${units} and ${plural(zones, "zone")} rerouted.`,
    { action: "road_closed", label: p.names.join(", "), teamIds: [...p.teamIds], count: zones },
  );
}

// ---- zones ----

function usesClosure(route: RouteOption | null, closures: Applied[]): boolean {
  return !!route && closuresAhead(route.line, closures, 0).length > 0;
}

/** Re-times one zone's cohorts on the road ahead of a closure (or held ones) on `route`; returns how many changed. */
function rerouteCohorts(board: Board, zone: ZoneState, route: RouteOption | null, closures: Applied[]): number {
  const t = zone.trips;
  const now = board.minute;
  // A new route that itself reads as using a closure is a geometric false positive (the router
  // never offers one): then only held cohorts move, so nobody is re-timed on every answer.
  const trusted = !usesClosure(route, closures);
  let changed = 0;
  for (let k = 0; k < t.arriveAt.length; k += 1) {
    const arrive = t.arriveAt[k];
    if (arrive <= now) continue;
    let move = arrive === Infinity;
    if (!move && trusted && t.line[k] !== route?.line) {
      const span = arrive - t.at[k];
      const progress = span > 0 ? Math.min(1, Math.max(0, (now - t.at[k]) / span)) : 1;
      move = closuresAhead(t.line[k], closures, progress).length > 0;
    }
    if (!move) continue;
    if (route) {
      t.arriveAt[k] = now + route.eta_min;
      t.line[k] = route.line;
      t.dest[k] = route.destination_id;
      changed += 1;
    } else if (arrive !== Infinity) {
      t.arriveAt[k] = Infinity;
      changed += 1;
    }
  }
  // First in first out per zone (traffic.recordCohort's rule), so arrivals stay sorted.
  for (let k = 1; k < t.arriveAt.length; k += 1) if (t.arriveAt[k] < t.arriveAt[k - 1]) t.arriveAt[k] = t.arriveAt[k - 1];
  return changed;
}

/**
 * After a routes answer that honours every closure the board knows (answerCovers) has been set
 * (model.setRoutes): zones leaving or scheduled on a route over a closed road switch to the best
 * open option, or are held when there is none; cohorts ahead of a closure follow (module note).
 * Held zones get the best option once one exists. Idempotent; returns whether anything changed.
 */
export function reconcileZones(board: Board, routes: ReadonlyMap<string, RouteOption[]>): boolean {
  const s = stateOf(board);
  const closures = [...s.byId.values()];
  let changed = false;
  let zonesRerouted = 0;
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) continue;
    const options = routes.get(zone.id) ?? [];
    let touched = false;
    const wasRoute = zone.orderedAt !== null ? zone.route : (zone.pendingOrder?.route ?? null);
    const wasScheduled = zone.orderedAt === null && zone.pendingOrder !== null;
    if (zone.orderedAt !== null) {
      const held = zone.route === null;
      if (held || (usesClosure(zone.route, closures) && !options.includes(zone.route!))) {
        const pick = options[0] ?? null;
        if (pick) {
          zone.route = pick;
          touched = true;
          if (held) {
            log(board, `${zone.name}: a route is open again; held households leave toward ${pick.name} (${pick.eta_min} min drive).`, {
              action: "evacuation_redirected",
              zoneId: zone.id,
              destinationId: pick.destination_id,
              etaMin: pick.eta_min,
            }, "board");
          }
        } else if (!held) {
          zone.route = null;
          touched = true;
          log(board, `${zone.name}: no open route around the closed road; households leaving wait at the zone until a route opens.`, {
            action: "no_route_closure",
            zoneId: zone.id,
          }, "board");
        }
      }
      if (rerouteCohorts(board, zone, zone.route, closures) > 0) touched = true;
    } else if (zone.pendingOrder && usesClosure(zone.pendingOrder.route, closures) && !options.includes(zone.pendingOrder.route)) {
      const pick = options[0] ?? null;
      touched = true;
      if (pick) zone.pendingOrder.route = pick;
      else {
        zone.pendingOrder = null;
        log(board, `${zone.name}: no open route around the closed road; its scheduled evacuation is dropped and households stay home.`, {
          action: "no_route_closure",
          zoneId: zone.id,
        }, "board");
      }
    }
    if (touched) {
      changed = true;
      zonesRerouted += 1;
      const nowRoute = zone.orderedAt !== null ? zone.route : (zone.pendingOrder?.route ?? null);
      const last = s.changes[s.changes.length - 1];
      if (last && nowRoute !== wasRoute) last.zones.push({ zoneId: zone.id, scheduled: wasScheduled, from: wasRoute, to: nowRoute });
    }
  }
  if (s.pending) {
    logClosed(board, s.pending, zonesRerouted);
    s.pending = null;
    changed = true;
  }
  return changed;
}
