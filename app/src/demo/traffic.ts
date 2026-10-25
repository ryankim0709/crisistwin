/**
 * Evacuation traffic on the command board: the maths only. Pure: no React, network or LLM, and
 * no board state (the board glue is model.ts "evacuation traffic").
 *
 * Model (docs/command-demo-realism.md "Evacuation traffic"):
 * - Each zone route from POST /api/demo/routes lists its road segments (runs of directed drill
 *   edges with one capacity; app/backend/api/demo.py route_segments). Capacity is the drill
 *   bundle's veh/h over all lanes of one direction: lanes x the assumed per-lane capacity of the
 *   road class (Camp: sim/traffic.py _HIGHWAY_DEFAULTS, e.g. residential 600, tertiary 1000,
 *   secondary 1200, primary 1600, motorway 2000 veh/h/lane; Studio drill packages:
 *   app/backend/api/dispatch_area.py CAPACITY_PER_LANE_VPH, 600-1900 veh/h/lane).
 * - Every whole simulation minute, the vehicles that left each zone in that minute load every
 *   segment of the zone's route at once (a static, flow-based assignment: a vehicle counts on its
 *   whole route when it departs, not where it is). A segment's volume is the sum of those
 *   departure flows, veh/h.
 * - Moving traffic on a segment follows the BPR volume-delay function (Bureau of Public Roads,
 *   Traffic Assignment Manual, 1964): t = t0 x (1 + BPR_ALPHA x (v / c)^BPR_BETA), with the
 *   standard alpha 0.15 and beta 4, on the flow that can pass (v at most c, so at most +15%),
 *   capped at CONGESTION_MAX_FACTOR x t0 (livecore/routing.py) as a guard.
 * - Demand above capacity queues: each segment is a deterministic point ("vertical") queue
 *   (Vickrey 1969 bottleneck model), q(t) = max(0, q(t-1) + inflow(t) - capacity), the Lindley
 *   recursion over the zones' departure curves. BPR alone, multiplying a short segment's free-flow
 *   time, cannot express a queue; measured on Camp, two 1,700-vehicle zones sharing a
 *   1,200 veh/h link: +0.2 min from BPR alone against a peak queue of several hundred vehicles.
 *   The wait is the largest queue delay (queue / capacity) on the route: with the static loading
 *   every segment sees the full inflow, so summing queues in series would count one jam twice.
 * - A cohort's arrival = its departure minute + moving time + that wait at that minute; arrivals
 *   are first-in first-out per zone (a later cohort never arrives before an earlier one).
 *
 * Units: minutes are simulation minutes; flows and capacities vehicles per hour; lengths metres.
 */

import type { LonLat } from "../live/types";

/** BPR coefficients (Bureau of Public Roads 1964): the standard alpha and beta. */
export const BPR_ALPHA = 0.15;
export const BPR_BETA = 4;
/** Upper bound of the delay factor (livecore/routing.py CONGESTION_MAX_FACTOR). */
export const CONGESTION_MAX_FACTOR = 10;
/** The traffic step: departures are loaded and timed once per whole simulation minute. */
export const TRAFFIC_STEP_MINUTES = 1;

/** One road segment of a zone route (POST /api/demo/routes `segments`). */
export interface RouteSegment {
  /** First directed drill edge id of the run; unique within one routes answer. */
  id: string;
  /** Road name, or its OSM class when unnamed. */
  name: string;
  length_m: number;
  lanes: number;
  /** One direction, all lanes, veh/h (assumed per-lane capacity x lanes). */
  capacity_veh_h: number;
  free_flow_min: number;
}

/** t / t0 on a segment carrying `flowVehH` with capacity `capacityVehH` (BPR, capped). */
export function bprFactor(flowVehH: number, capacityVehH: number): number {
  if (!(flowVehH > 0)) return 1;
  if (!(capacityVehH > 0)) return CONGESTION_MAX_FACTOR;
  return Math.min(CONGESTION_MAX_FACTOR, 1 + BPR_ALPHA * (flowVehH / capacityVehH) ** BPR_BETA);
}

/** Minutes to discharge `queueVeh` vehicles at `capacityVehH`. */
export function queueDelayMinutes(queueVeh: number, capacityVehH: number): number {
  if (!(queueVeh > 0)) return 0;
  return capacityVehH > 0 ? (queueVeh / capacityVehH) * 60 : Infinity;
}

/**
 * Congested minutes over `segments`: BPR on each segment's passing flow (`flowOf`, veh/h, at
 * most its capacity) plus the largest queue delay on the route (`queueOf`, vehicles), or
 * `fallbackMin` when the route has no segments (an older routes answer).
 */
export function congestedMinutes(
  segments: readonly RouteSegment[],
  flowOf: (segment: RouteSegment) => number,
  fallbackMin: number,
  queueOf: (segment: RouteSegment) => number = () => 0,
): number {
  if (segments.length === 0) return fallbackMin;
  let moving = 0;
  let wait = 0;
  for (const s of segments) {
    moving += s.free_flow_min * bprFactor(Math.min(flowOf(s), s.capacity_veh_h), s.capacity_veh_h);
    wait = Math.max(wait, queueDelayMinutes(queueOf(s), s.capacity_veh_h));
  }
  return moving + wait;
}

/** Free-flow minutes over `segments` (`fallbackMin` without segments). */
export function freeFlowMinutes(segments: readonly RouteSegment[], fallbackMin: number): number {
  return segments.length === 0 ? fallbackMin : segments.reduce((sum, s) => sum + s.free_flow_min, 0);
}

/**
 * Departed households of one zone, sampled at each whole minute their count grew. Index k is a
 * cohort: departed[k] - departed[k-1] households reached the road at `at[k]` on `route[k]`'s
 * line and arrive at `arriveAt[k]` (non-decreasing).
 */
export interface Trips {
  at: number[];
  departed: number[];
  arriveAt: number[];
  line: LonLat[][];
}

export function emptyTrips(): Trips {
  return { at: [], departed: [], arriveAt: [], line: [] };
}

/** Households of `trips` that have arrived by `minute`. */
export function arrivedBy(trips: Trips, minute: number): number {
  let lo = 0;
  let hi = trips.arriveAt.length; // first index arriving after minute
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trips.arriveAt[mid] <= minute) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : trips.departed[lo - 1];
}

/** Records a cohort; FIFO: it arrives no earlier than the cohort before it. */
export function recordCohort(trips: Trips, at: number, departedTotal: number, travelMin: number, line: LonLat[]): void {
  const last = trips.arriveAt.length ? trips.arriveAt[trips.arriveAt.length - 1] : -Infinity;
  trips.at.push(at);
  trips.departed.push(departedTotal);
  trips.arriveAt.push(Math.max(last, at + travelMin));
  trips.line.push(line);
}

// ---- positions along a road line (vehicle markers) ----

const lengthsCache = new WeakMap<LonLat[], number[]>();
const M_PER_DEG = 111_320;

/** Cumulative metres along `line` (equirectangular; cached per line). */
function cumulative(line: LonLat[]): number[] {
  const hit = lengthsCache.get(line);
  if (hit) return hit;
  const out = [0];
  for (let i = 1; i < line.length; i += 1) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
    out.push(out[i - 1] + Math.hypot((x1 - x0) * k, y1 - y0) * M_PER_DEG);
  }
  lengthsCache.set(line, out);
  return out;
}

/** The point a share `t` (0..1) of the way along the road line, and the bearing there (degrees true). */
export function alongLine(line: LonLat[], t: number): { at: LonLat; bearing: number } | null {
  if (line.length < 2) return null;
  const cum = cumulative(line);
  const total = cum[cum.length - 1];
  const target = Math.min(1, Math.max(0, t)) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i += 1;
  const a = line[i - 1];
  const b = line[i];
  const span = cum[i] - cum[i - 1];
  const f = span > 0 ? (target - cum[i - 1]) / span : 0;
  const at: LonLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const k = Math.cos((a[1] * Math.PI) / 180);
  const bearing = ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
  return { at, bearing };
}
