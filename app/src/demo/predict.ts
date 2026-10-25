/**
 * Next-state forecast for the AI commander on the /live board (observation `predicted`,
 * demo/contracts.ts PredictedObservation), and the forecast primitives the evacuation balance
 * (demo/evacBalance.ts) runs on. Pure: no React, network or LLM. Simulated model output.
 *
 * Fire. The solver's arrival field (fireField.ts) of the reported fires, in free burn (the line
 * built so far is in the field; a containment that has not happened is not assumed), as in
 * decisionAids.ts. Per zone: edge / core ETA and the share of its ground burned at now + 30 / 60 /
 * 120 min. Per road segment of a route: the earliest arrival on the route line's stretch for that
 * segment (the simplified route line split by the segments' length shares, sampled every half
 * cell). predictedFireRings contours the same field at the horizons for the 3D overlay.
 *
 * Traffic. The orders in effect and scheduled now proceed: each zone's exponential departure
 * curve (realism.ts DEPARTURE_MEAN_MINUTES, ORDER_COMPLIANCE) loads every segment of its route at
 * once (traffic.ts static loading), each segment is a point queue (traffic.ts, Vickrey 1969 /
 * Lindley recursion) at PREDICT_STEP_MIN steps over the solver's lookahead, starting from the
 * board's current queues. vc = departure demand / capacity. A segment clears when
 * EVAC_TARGET_DEPARTED_SHARE of each zone's complying vehicles have passed it: departure lead +
 * free-flow time to the segment's end + the route's queue delay then (moving time at free flow;
 * BPR adds at most 15% on flow that passes, traffic.ts). Danger: the fire forecast reaches the
 * segment before it clears; a destination is over capacity when its committed vehicles exceed
 * its known capacity.
 *
 * Units: board minutes (absolute *_minute / At, durations *Min); vehicles; veh/h capacities.
 */

import { cellAt, contourArrival } from "../fire/spread";
import type { LonLat } from "../live/types";
import { isReported } from "./boardResponse";
import type { PredictedObservation } from "./contracts";
import { EVAC_DEPARTURE_LEAD_MIN, EVAC_SCHEDULE_STEP_MIN, EVAC_TARGET_DEPARTED_SHARE } from "./decisionAids";
import { LOOKAHEAD_MINUTES, countAtMost } from "./fireField";
import { activeFires, thinRing, trafficPicture, vehiclesPerHousehold, withVehicle, type Board, type FireField, type RouteOption, type ZoneState } from "./model";
import { DEPARTURE_MEAN_MINUTES, ORDER_COMPLIANCE } from "./realism";
import type { RouteSegment } from "./traffic";

/** Forecast horizons, minutes from now. */
export const PREDICT_HORIZONS_MIN: readonly number[] = [30, 60, 120];
/** Traffic forecast step, minutes (the evacuation schedule's search step, decisionAids.ts). */
export const PREDICT_STEP_MIN = EVAC_SCHEDULE_STEP_MIN;
/** Traffic forecast window: the fire solver's lookahead (fireField.ts LOOKAHEAD_MINUTES). */
export const PREDICT_WINDOW_MIN = LOOKAHEAD_MINUTES;
/** Wire bounds (observation size). */
const MAX_ZONES = 25;
const MAX_SEGMENTS = 20;
const MAX_DESTINATIONS = 15;
const MAX_DANGERS = 10;
/** Most points per predicted ring, most rings per horizon (3D overlay). */
const RING_MAX_POINTS = 240;
const RINGS_MAX = 40;

export const PREDICT_LABEL = `Next-state forecast (model output, demo/predict.ts; simulated). Fire: the fire model's free-burn arrival field of the reported fires (line built so far included, containment not assumed): per zone edge/core ETA and percent of its ground burned at now + ${PREDICT_HORIZONS_MIN.join(" / ")} min; per road segment the minutes until fire reaches it. Traffic: the orders in effect and scheduled now proceed (exponential departures of mean ${DEPARTURE_MEAN_MINUTES} min, ${Math.round(ORDER_COMPLIANCE * 100)}% compliance, every vehicle loads its whole route, point queues per segment at ${PREDICT_STEP_MIN}-min steps over ${PREDICT_WINDOW_MIN} min): vc = demand / capacity at each horizon; clears_in_min = when ${Math.round(EVAC_TARGET_DEPARTED_SHARE * 100)}% of the committed vehicles have passed (ASSUMPTION: planning share). danger = fire reaches the segment before it clears.`;

// ---- fire ----

/** Solver sources of the reported fires: burning only (what still spreads), or any status (burned ground). */
export function reportedSources(board: Board, burningOnly: boolean): Set<number> {
  const field = board.solver.field;
  const out = new Set<number>();
  if (!field) return out;
  // Out fires stay solver sources: their ground counts as burned (as fireFootprint.ts draws it).
  for (const f of burningOnly ? activeFires(board) : board.fires) {
    const s = field.sourceIndex.get(f.id);
    if (s === undefined || !isReported(board, f)) continue;
    if (burningOnly && f.status !== "burning") continue;
    out.add(s);
  }
  return out;
}

function sourcesKey(sources: Set<number>): string {
  return [...sources].sort((a, b) => a - b).join(",");
}

const M_PER_DEG = 111_320;
const segmentFireCache = new WeakMap<RouteOption, { field: FireField; key: string; at: Float64Array }>();

/**
 * Earliest fire arrival (absolute board minute; Infinity = not within the solver's lookahead) on
 * each of the option's segments, from the burning reported fires `sources`. The route line is
 * split by the segments' length shares (the line is simplified, so a stretch is approximate) and
 * sampled every half cell. Cached per option, field and source set.
 */
export function segmentFireArrivals(board: Board, option: RouteOption, sources: Set<number>): Float64Array {
  const field = board.solver.field;
  const n = option.segments.length;
  const at = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  if (!field || n === 0 || option.line.length < 2 || sources.size === 0) return at;
  const key = sourcesKey(sources);
  const hit = segmentFireCache.get(option);
  if (hit && hit.field === field && hit.key === key) return hit.at;
  const grid = board.env.landscape;
  const line = option.line;
  const cum = [0];
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
    cum.push(cum[i - 1] + Math.hypot((x1 - x0) * k, y1 - y0) * M_PER_DEG);
  }
  const total = cum[cum.length - 1];
  // Segment ends as shares of the line.
  const segLen = option.segments.map((s) => Math.max(0, s.length_m));
  const segTotal = segLen.reduce((a, b) => a + b, 0);
  const ends: number[] = [];
  let acc = 0;
  for (let j = 0; j < n; j++) {
    acc += segTotal > 0 ? segLen[j] : 1;
    ends.push((acc / (segTotal > 0 ? segTotal : n)) * total);
  }
  const spacing = Math.max(5, grid.groundCellSizeMeters / 2);
  const arrival = field.arrivalMinutes;
  const owner = field.sourceIndexByCell;
  let j = 0;
  let i = 1;
  for (let d = 0; d <= total; d += spacing) {
    while (j < n - 1 && d > ends[j]) j++;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const span = cum[i] - cum[i - 1];
    const f = span > 0 ? (d - cum[i - 1]) / span : 0;
    const a = line[i - 1];
    const b = line[i];
    const c = cellAt(grid, { longitude: a[0] + (b[0] - a[0]) * f, latitude: a[1] + (b[1] - a[1]) * f });
    if (c < 0 || !sources.has(owner[c])) continue;
    if (arrival[c] < at[j]) at[j] = arrival[c];
  }
  segmentFireCache.set(option, { field, key, at });
  return at;
}

export interface ZoneReach {
  zone: ZoneState;
  /** Minutes from now until a burning reported fire reaches the zone edge / core (0 = there); null = not within the lookahead. */
  edgeEtaMin: number | null;
  coreEtaMin: number | null;
  /** Share (0..1) of the zone's cells burned by reported fires at now + each horizon. */
  burnedShare: number[];
}

/** Zones (not overrun) a reported fire reaches within the last horizon or has burned in, soonest first. */
export function zoneReach(board: Board, horizons: readonly number[] = PREDICT_HORIZONS_MIN): ZoneReach[] {
  const field = board.solver.field;
  if (!field) return [];
  const burning = reportedSources(board, true);
  const any = reportedSources(board, false);
  if (any.size === 0) return [];
  const now = board.minute;
  const last = now + Math.max(...horizons);
  const out: ZoneReach[] = [];
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) continue;
    const za = field.zones.get(zone.id);
    const cells = board.solver.zoneCells.get(zone.id);
    if (!za || !cells || cells.cells.length === 0) continue;
    let first = Number.POSITIVE_INFINITY;
    for (const s of any) first = Math.min(first, za.earliestBySource[s]);
    if (!(first <= last)) continue;
    let edge = Number.POSITIVE_INFINITY;
    for (const s of burning) edge = Math.min(edge, za.earliestBySource[s]);
    const core = burning.has(za.coreSource) ? za.coreArrival : Number.POSITIVE_INFINITY;
    const counts = horizons.map(() => 0);
    for (const c of cells.cells) {
      if (!any.has(field.sourceIndexByCell[c])) continue;
      const a = field.arrivalMinutes[c];
      for (let h = 0; h < horizons.length; h++) if (a <= now + horizons[h]) counts[h]++;
    }
    const eta = (t: number) => (Number.isFinite(t) ? Math.max(0, t - now) : null);
    out.push({ zone, edgeEtaMin: eta(edge), coreEtaMin: eta(core), burnedShare: counts.map((k) => k / cells.cells.length) });
  }
  out.sort((a, b) => (a.edgeEtaMin ?? Infinity) - (b.edgeEtaMin ?? Infinity) || a.zone.id.localeCompare(b.zone.id));
  return out;
}

const ringScratch = new WeakMap<FireField, Float64Array>();
const ringCache = new WeakMap<FireField, { key: string; rings: LonLat[][][] }>();

/**
 * Predicted fire outlines for the 3D overlay: per entry of `minutes` (minutes AHEAD of
 * board.minute, e.g. [30, 60, 120]), the outer rings ([lon, lat], closed) of the ground the
 * reported fires have burned by then in the solver's free-burn field, largest first. Simulated.
 * [] per horizon before the first solve. Cached per field, whole minute and source set.
 */
export function predictedFireRings(board: Board, minutes: readonly number[]): LonLat[][][] {
  const field = board.solver.field;
  if (!field || minutes.length === 0) return minutes.map(() => []);
  const sources = reportedSources(board, false);
  const now = Math.floor(board.minute);
  const key = `${now}|${minutes.join(",")}|${sourcesKey(sources)}`;
  const hit = ringCache.get(field);
  if (hit && hit.key === key) return hit.rings;
  const grid = board.env.landscape;
  let scratch = ringScratch.get(field);
  if (!scratch) {
    scratch = new Float64Array(grid.width * grid.height).fill(Number.POSITIVE_INFINITY);
    ringScratch.set(field, scratch);
  }
  const until = now + Math.max(...minutes);
  const filled: number[] = [];
  let minX = grid.width, maxX = -1, minY = grid.height, maxY = -1;
  for (const s of sources) {
    const cells = field.cellsBySource[s];
    const n = countAtMost(field.arrivalBySource[s], until);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      const x = c % grid.width;
      const y = (c - x) / grid.width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      scratch[c] = field.arrivalMinutes[c];
      filled.push(c);
    }
  }
  const rings: LonLat[][][] = minutes.map((m) => {
    if (filled.length === 0) return [];
    return contourArrival(grid, scratch!, now + m, { minX, maxX, minY, maxY })
      .map((p) => p.geometry.coordinates[0])
      .sort((a, b) => b.length - a.length)
      .slice(0, RINGS_MAX)
      .map((ring) => {
        const open = thinRing(ring.map((q) => [q[0], q[1]] as LonLat), RING_MAX_POINTS);
        return open.length >= 3 ? [...open, open[0]] : [];
      })
      .filter((r) => r.length >= 4);
  });
  for (const c of filled) scratch[c] = Number.POSITIVE_INFINITY;
  ringCache.set(field, { key, rings });
  return rings;
}

// ---- traffic primitives (shared with evacBalance.ts) ----

/** The forecast's time steps: step k covers [t0 + k step, t0 + (k + 1) step). */
export interface TimeGrid {
  t0: number;
  step: number;
  steps: number;
}

export function timeGrid(board: Board): TimeGrid {
  return { t0: Math.round(board.minute), step: PREDICT_STEP_MIN, steps: Math.ceil(PREDICT_WINDOW_MIN / PREDICT_STEP_MIN) };
}

/** Share of a zone's complying vehicles gone `u` minutes after its order took effect (exponential curve). */
export function departedShareAfter(u: number): number {
  return u <= 0 ? 0 : 1 - Math.exp(-u / DEPARTURE_MEAN_MINUTES);
}

/** Vehicles an evacuation order of the zone puts on the road in all (ORDER_COMPLIANCE x households with a vehicle x vehicles per household). */
export function orderVehicles(zone: ZoneState): number {
  return withVehicle(zone) * ORDER_COMPLIANCE * vehiclesPerHousehold(zone);
}

/** Vehicles departing in each step of `grid` for an order of `vehicles` that took (or takes) effect at `start`. */
export function departureSteps(vehicles: number, start: number, grid: TimeGrid): Float64Array {
  const out = new Float64Array(grid.steps);
  for (let k = 0; k < grid.steps; k++) {
    const a = grid.t0 + k * grid.step - start;
    out[k] = vehicles * (departedShareAfter(a + grid.step) - departedShareAfter(a));
  }
  return out;
}

/** Point queue (vehicles at the end of each step): Lindley recursion from `q0` at the segment's capacity. */
export function pointQueue(inflow: Float64Array, capacityVehH: number, q0: number, grid: TimeGrid, out = new Float64Array(grid.steps)): Float64Array {
  const cap = (Math.max(0, capacityVehH) / 60) * grid.step;
  let q = q0;
  for (let k = 0; k < grid.steps; k++) {
    q = Math.max(0, q + inflow[k] - cap);
    out[k] = q;
  }
  return out;
}

/** Free-flow minutes from the zone to the end of each segment of the route. */
export function cumulativeFreeFlow(segments: readonly RouteSegment[]): Float64Array {
  const out = new Float64Array(segments.length);
  let acc = 0;
  segments.forEach((s, j) => {
    acc += s.free_flow_min;
    out[j] = acc;
  });
  return out;
}

/** Step index of absolute minute `t` (may be out of range). */
export function stepOf(grid: TimeGrid, t: number): number {
  return Math.floor((t - grid.t0) / grid.step);
}

/** Minute EVAC_TARGET_DEPARTED_SHARE of the complying vehicles have passed the end of segment j: lead + free flow there + the route's queue delay then. */
export function clearsAt(start: number, cumFreeFlowMin: number, wait: Float64Array, grid: TimeGrid): number {
  const t = start + EVAC_DEPARTURE_LEAD_MIN;
  const k = stepOf(grid, t);
  // Share reached before the window: still clears no earlier than the queue standing now discharges.
  if (k < 0) return wait[0] > 0 ? Math.max(t, grid.t0) + cumFreeFlowMin + wait[0] : t + cumFreeFlowMin;
  return t + cumFreeFlowMin + wait[Math.min(k, grid.steps - 1)];
}

// ---- current orders forecast ----

export interface OrderFlow {
  zone: ZoneState;
  route: RouteOption;
  start: number;
  scheduled: boolean;
  dep: Float64Array;
}

/** The orders in effect (zones leaving) and scheduled now, not overrun, with their departures per step. */
export function currentOrderFlows(board: Board, grid: TimeGrid): OrderFlow[] {
  const out: OrderFlow[] = [];
  for (const zone of board.zones) {
    if (zone.overrunAt !== null) continue;
    if (zone.orderedAt !== null && zone.route) {
      out.push({ zone, route: zone.route, start: zone.orderedAt, scheduled: false, dep: departureSteps(orderVehicles(zone), zone.orderedAt, grid) });
    } else if (zone.pendingOrder) {
      const p = zone.pendingOrder;
      out.push({ zone, route: p.route, start: p.startMinute, scheduled: true, dep: departureSteps(orderVehicles(zone), p.startMinute, grid) });
    }
  }
  return out;
}

export interface SegmentForecast {
  segment: RouteSegment;
  inflow: Float64Array;
  queue: Float64Array;
  flows: OrderFlow[];
  /** Absolute minute fire reaches it (Infinity = not within the lookahead). */
  fireAt: number;
  /** Absolute minute its committed traffic clears; null = nobody committed. */
  clearsAt: number | null;
}

export interface TrafficForecast {
  grid: TimeGrid;
  flows: OrderFlow[];
  segments: Map<string, SegmentForecast>;
  /** Per destination id: name, capacity (veh, null = unknown) and committed vehicles. */
  destinations: Map<string, { name: string; capacityVeh: number | null; committedVeh: number }>;
}

/** Loads, queues, fire arrival and clearance of every segment of the current and scheduled orders. */
export function forecastTraffic(board: Board, routes: ReadonlyMap<string, RouteOption[]>): TrafficForecast {
  const grid = timeGrid(board);
  const flows = currentOrderFlows(board, grid);
  const burning = reportedSources(board, true);
  const segments = new Map<string, SegmentForecast>();
  const fireOf = new Map<OrderFlow, Float64Array>();
  for (const f of flows) {
    const fire = segmentFireArrivals(board, f.route, burning);
    fireOf.set(f, fire);
    f.route.segments.forEach((s, j) => {
      let e = segments.get(s.id);
      if (!e) {
        e = { segment: s, inflow: new Float64Array(grid.steps), queue: new Float64Array(grid.steps), flows: [], fireAt: Number.POSITIVE_INFINITY, clearsAt: null };
        segments.set(s.id, e);
      }
      if (!e.flows.includes(f)) {
        e.flows.push(f);
        for (let k = 0; k < grid.steps; k++) e.inflow[k] += f.dep[k];
      }
      e.fireAt = Math.min(e.fireAt, fire[j]);
    });
  }
  for (const [id, e] of segments) pointQueue(e.inflow, e.segment.capacity_veh_h, board.traffic.queue.get(id) ?? 0, grid, e.queue);
  // Route wait per flow (largest queue delay on its route, traffic.ts), then clearance per segment.
  for (const f of flows) {
    const wait = new Float64Array(grid.steps);
    for (const s of f.route.segments) {
      const e = segments.get(s.id)!;
      const perMin = s.capacity_veh_h / 60;
      for (let k = 0; k < grid.steps; k++) wait[k] = Math.max(wait[k], perMin > 0 ? e.queue[k] / perMin : 0);
    }
    const cum = cumulativeFreeFlow(f.route.segments);
    f.route.segments.forEach((s, j) => {
      const e = segments.get(s.id)!;
      const t = clearsAt(f.start, cum[j], wait, grid);
      e.clearsAt = e.clearsAt === null ? t : Math.max(e.clearsAt, t);
    });
  }
  // Destinations: whatever the board's routes offer, plus the current orders' destinations.
  const destinations: TrafficForecast["destinations"] = new Map();
  const addDest = (o: RouteOption) => {
    const d = destinations.get(o.destination_id);
    if (!d) destinations.set(o.destination_id, { name: o.name, capacityVeh: o.destination_capacity_veh, committedVeh: 0 });
    else if (d.capacityVeh === null && o.destination_capacity_veh !== null) d.capacityVeh = o.destination_capacity_veh;
  };
  for (const options of routes.values()) options.forEach(addDest);
  const picture = trafficPicture(board);
  for (const z of picture.zones.values()) addDest(z.route);
  for (const f of flows) {
    addDest(f.route);
    const d = destinations.get(f.route.destination_id)!;
    if (f.scheduled) d.committedVeh += orderVehicles(f.zone);
    else {
      const z = picture.zones.get(f.zone.id);
      d.committedVeh += z ? z.committed - z.onRoad : 0;
    }
  }
  for (const [id, veh] of picture.byDestination) {
    const d = destinations.get(id);
    if (d) d.committedVeh += veh;
  }
  return { grid, flows, segments, destinations };
}

/** Demand / capacity of a segment in step k. */
export function stepVc(inflow: Float64Array, capacityVehH: number, grid: TimeGrid, k: number): number {
  const cap = (capacityVehH / 60) * grid.step;
  if (k < 0 || k >= inflow.length) return 0;
  return cap > 0 ? inflow[k] / cap : inflow[k] > 0 ? Infinity : 0;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The observation's `predicted` block (bounded; null when no reported fire and no order). */
export function predictedObservation(board: Board, routes: ReadonlyMap<string, RouteOption[]>): PredictedObservation | undefined {
  const reach = zoneReach(board);
  const traffic = forecastTraffic(board, routes);
  if (reach.length === 0 && traffic.flows.length === 0) return undefined;
  const { grid } = traffic;
  const now = board.minute;
  const horizonStep = (h: number) => stepOf(grid, now + h);
  const lastStep = Math.min(grid.steps - 1, horizonStep(Math.max(...PREDICT_HORIZONS_MIN)));
  const dangers: string[] = [];
  const segs = [...traffic.segments.entries()].map(([id, e]) => {
    const s = e.segment;
    const perMin = s.capacity_veh_h / 60;
    let peakVc = 0;
    for (let k = 0; k <= lastStep; k++) peakVc = Math.max(peakVc, stepVc(e.inflow, s.capacity_veh_h, grid, k));
    let peakQ = 0;
    for (let k = 0; k < grid.steps; k++) peakQ = Math.max(peakQ, e.queue[k]);
    const fireEta = Number.isFinite(e.fireAt) ? Math.max(0, Math.round(e.fireAt - now)) : null;
    const clears = e.clearsAt === null ? null : Math.max(0, Math.round(e.clearsAt - now));
    const danger = fireEta !== null && clears !== null && clears > fireEta;
    if (danger) dangers.push(`Road ${s.name} (${id}): fire forecast reaches it in ${fireEta} min, before the traffic of ${e.flows.map((f) => f.zone.id).join(", ")} clears it (${clears} min).`);
    return {
      segment_id: id,
      name: s.name,
      capacity_veh_h: s.capacity_veh_h,
      zone_ids: e.flows.map((f) => f.zone.id),
      vc: PREDICT_HORIZONS_MIN.map((h) => r2(stepVc(e.inflow, s.capacity_veh_h, grid, horizonStep(h)))),
      peak_vc: r2(peakVc),
      peak_queue_vehicles: Math.round(peakQ),
      queue_delay_min: PREDICT_HORIZONS_MIN.map((h) => {
        // queue[k] is the queue at the end of step k, so now + h is the end of step k - 1.
        const k = Math.min(grid.steps, horizonStep(h)) - 1;
        return k >= 0 && perMin > 0 ? r1(e.queue[k] / perMin) : 0;
      }),
      fire_eta_min: fireEta,
      clears_in_min: clears,
      danger,
    };
  });
  segs.sort((a, b) => Number(b.danger) - Number(a.danger) || b.peak_vc - a.peak_vc || b.peak_queue_vehicles - a.peak_queue_vehicles);
  const destinations = [...traffic.destinations.entries()]
    .filter(([, d]) => d.committedVeh > 0.5)
    .map(([id, d]) => {
      const over = d.capacityVeh !== null && d.committedVeh > d.capacityVeh;
      if (over) dangers.push(`Destination ${d.name} (${id}): ${Math.round(d.committedVeh)} vehicles committed, capacity ${d.capacityVeh}.`);
      return { destination_id: id, name: d.name, capacity_veh: d.capacityVeh, committed_vehicles: Math.round(d.committedVeh), over_capacity: over };
    })
    .sort((a, b) => Number(b.over_capacity) - Number(a.over_capacity) || b.committed_vehicles - a.committed_vehicles);
  return {
    method: PREDICT_LABEL,
    horizons_min: [...PREDICT_HORIZONS_MIN],
    zones: reach.slice(0, MAX_ZONES).map((r) => ({
      zone_id: r.zone.id,
      edge_eta_min: r.edgeEtaMin === null ? null : Math.round(r.edgeEtaMin),
      core_eta_min: r.coreEtaMin === null ? null : Math.round(r.coreEtaMin),
      burned_pct: r.burnedShare.map((x) => Math.round(x * 100)),
    })),
    segments: segs.slice(0, MAX_SEGMENTS),
    destinations: destinations.slice(0, MAX_DESTINATIONS),
    dangers: dangers.slice(0, MAX_DANGERS),
  };
}
