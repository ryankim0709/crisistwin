/**
 * Evacuation balance for the AI commander on the /live board (observation `evac_balance`,
 * demo/contracts.ts EvacBalanceObservation). Pure: no React, network or LLM; deterministic (the
 * only clock read is performance.now() for the computeMs diagnostic, never used by the algorithm).
 * Simulated model output.
 *
 * Decision. For each zone of decision_aids' evacuation schedule (decisionAids.ts
 * evacuationSchedule) with no order in effect (a scheduled order may be kept or moved), choose a
 * route option (destination) and a start: now, or one of EVAC_BALANCE_START_OFFSETS_STEPS x
 * PREDICT_STEP_MIN ahead, never past the plan's latest safe start, the route's own latest safe
 * start (core ETA - (EVAC_DEPARTURE_LEAD_MIN + free-flow drive) - EVAC_SAFETY_MARGIN_MIN) or
 * MAX_SCHEDULE_AHEAD_MINUTES; a zone already too late only starts now. Zones already leaving keep
 * their route and start (fixed, they still count); every other order in effect or scheduled is
 * background traffic.
 *
 * Objective J (person-equivalents, minimised):
 * - per zone: expected caught at the core ETA (decisionAids.ts expectedCaught, the board catch
 *   rule; households where persons are unknown) + persons per vehicle x vehicles departed before
 *   the core ETA but not yet past a route segment when the fire forecast reaches it + FIRE_CUT_PENALTY
 *   when the fire forecast reaches a route segment before EVAC_TARGET_DEPARTED_SHARE of the zone's
 *   traffic has passed it (predict.ts clearsAt);
 * - destinations: vehicles sent past a known capacity x the plan zones' average persons per vehicle
 *   (ASSUMPTION: a vehicle with nowhere to go counts as its occupants at risk);
 * - queues: QUEUE_WEIGHT_PERSON_PER_VEH_MIN x the vehicle-minutes queued on the segments.
 *
 * Traffic (predict.ts primitives): exponential departures (realism.ts DEPARTURE_MEAN_MINUTES,
 * ORDER_COMPLIANCE), every vehicle loads its whole route at once (traffic.ts static loading), each
 * segment is a point queue (traffic.ts: Vickrey 1969 bottleneck, Lindley recursion) at
 * PREDICT_STEP_MIN steps over PREDICT_WINDOW_MIN from the board's current queues; the route wait is
 * the largest queue delay on the route (traffic.ts). Only "contended" segments (a queue now, or a
 * possible step inflow above capacity) are queued; the others never queue. Fire: the free-burn
 * arrival field of the burning reported fires per route segment (predict.ts segmentFireArrivals).
 *
 * Search: the all-now baseline (decision_aids' destinations), then greedy in decision_aids' order
 * (latest safe start ascending), then up to MAX_IMPROVE_PASSES local-improvement passes, all on an
 * incremental evaluation (only the touched segments' queues and the zones on them are recomputed).
 *
 * Units: board minutes (absolute *Minute / start, durations *Min); vehicles; veh/h capacities;
 * persons (households where persons are unknown).
 */

import type { EvacBalanceObservation, EvacBalanceTotals } from "./contracts";
import { EVAC_DEPARTURE_LEAD_MIN, EVAC_SAFETY_MARGIN_MIN, EVAC_TARGET_DEPARTED_SHARE, expectedCaught, type ZoneEvacPlan } from "./decisionAids";
import { MAX_SCHEDULE_AHEAD_MINUTES, trafficPicture, vehiclesPerHousehold, withVehicle, type Board, type RouteOption, type ZoneState } from "./model";
import {
  PREDICT_STEP_MIN,
  PREDICT_WINDOW_MIN,
  clearsAt,
  cumulativeFreeFlow,
  currentOrderFlows,
  departedShareAfter,
  departureSteps,
  orderVehicles,
  pointQueue,
  reportedSources,
  segmentFireArrivals,
  stepOf,
  stepVc,
  timeGrid,
} from "./predict";
import { DEPARTURE_MEAN_MINUTES, ORDER_COMPLIANCE } from "./realism";

/** ASSUMPTION (planning weight, not sourced): person-equivalents per zone whose route the fire forecast cuts before clearance; large enough to make the rule effectively hard. */
export const FIRE_CUT_PENALTY = 10_000;
/** ASSUMPTION (planning weight, not sourced): 10 vehicle-hours of queueing weigh as one person at risk. */
export const QUEUE_WEIGHT_PERSON_PER_VEH_MIN = 1 / 600;
/** Local-improvement passes after the greedy placement (a compute bound, not a model parameter). */
export const MAX_IMPROVE_PASSES = 3;
/** Start offsets tried, in PREDICT_STEP_MIN steps from now (0..240 min; a board rule for the aid, not sourced). */
export const EVAC_BALANCE_START_OFFSETS_STEPS: readonly number[] = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
/** A local move is kept only when it lowers J by more than this (person-equivalents; float noise guard). */
const IMPROVE_EPS = 1e-6;
/** Wire bound on the `why` text. */
const WHY_MAX_CHARS = 220;

export const EVAC_BALANCE_LABEL = `Evacuation balance (model output, demo/evacBalance.ts; simulated). For each zone of decision_aids' evacuation schedule with no order in effect: a destination (its route options) and a start (now or ${EVAC_BALANCE_START_OFFSETS_STEPS.slice(1).map((m) => m * PREDICT_STEP_MIN).join("/")} min ahead, never past its latest safe start or the route's own: core ETA - (${EVAC_DEPARTURE_LEAD_MIN} min departure lead + free-flow drive) - ${EVAC_SAFETY_MARGIN_MIN} min) minimising person-equivalents: expected caught at the core ETA (board catch rule; households where persons are unknown) + persons in vehicles not yet past a route segment when the fire forecast reaches it + ${FIRE_CUT_PENALTY} per zone whose route the fire forecast cuts before ${Math.round(EVAC_TARGET_DEPARTED_SHARE * 100)}% of its traffic passes (ASSUMPTION) + vehicles sent past a destination's capacity x average persons per vehicle (ASSUMPTION) + 1 per ${Math.round(1 / QUEUE_WEIGHT_PERSON_PER_VEH_MIN / 60)} vehicle-hours queued (ASSUMPTION). Traffic as in predicted: exponential departures (mean ${DEPARTURE_MEAN_MINUTES} min, ${Math.round(ORDER_COMPLIANCE * 100)}% compliance), whole-route loading, point queues at ${PREDICT_STEP_MIN}-min steps over ${PREDICT_WINDOW_MIN} min. Greedy by latest safe start, then up to ${MAX_IMPROVE_PASSES} local-improvement passes. Zones leaving keep their route. all_now: the same zones all ordered now to decision_aids' destinations.`;

type BalanceZone = EvacBalanceObservation["zones"][number];

export interface EvacBalanceResult {
  /** One per plan zone, in plans order, wire-shaped (rounded). */
  zones: BalanceZone[];
  totals: EvacBalanceTotals;
  /** The same zones all ordered now to decision_aids' destinations (plan.option), for comparison. */
  allNow: EvacBalanceTotals;
  /** Diagnostic only (wall time of the search), never on the wire. */
  computeMs: number;
}

interface OptData {
  option: RouteOption;
  /** Global segment index per route segment, travel order. */
  seg: Int32Array;
  /** Global indices of the route's contended segments (deduped). */
  cont: Int32Array;
  /** Free-flow minutes from the zone to the end of each route segment. */
  cumFFMin: Float64Array;
  /** Absolute minute the fire forecast reaches each route segment (Infinity = not within the lookahead). */
  fireAtMinute: Float64Array;
  /** Local indices of the segments with a finite fire arrival. */
  fireLocal: Int32Array;
  dest: number;
}

interface Cand {
  opt: number;
  /** Absolute start minute (grid-aligned, or the fixed zone's orderedAt). */
  start: number;
  /** Offset in steps (-1 for a fixed zone). */
  m: number;
  /** First step with departures. */
  k0: number;
  /** Departures per step per vehicle of the order (multiply by V). */
  unit: Float64Array;
  caughtHouseholds: number;
  caughtPeople: number | null;
  /** caughtPeople ?? caughtHouseholds. */
  caught: number;
}

interface ZoneVar {
  plan: ZoneEvacPlan;
  zone: ZoneState;
  fixed: boolean;
  /** Vehicles the order puts on the road. */
  vehicles: number;
  /** Persons per vehicle (households per vehicle where persons are unknown). */
  personsPerVehicle: number;
  coreAbsMinute: number;
  /** Steps with midpoint before the core ETA. */
  kEnd: number;
  opts: OptData[];
  cands: Cand[];
  cur: number;
  term: number;
  exposedVehicles: number;
  cut: boolean;
  cutLocal: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const clip = (s: string) => (s.length <= WHY_MAX_CHARS ? s : `${s.slice(0, WHY_MAX_CHARS - 3)}...`);

function emptyTotals(): EvacBalanceTotals {
  return { expected_caught_people: 0, expected_caught_households: 0, exposed_vehicles: 0, queue_vehicle_hours: 0, peak_vc: 0, zones_fire_cuts_route: 0, destinations_over_capacity: 0 };
}

/** Persons per vehicle of the zone's order (households per vehicle when persons are unknown). */
function personsPerVehicle(zone: ZoneState): number {
  const vph = vehiclesPerHousehold(zone);
  if (zone.occupants === null) return 1 / vph;
  const veh = withVehicle(zone) * vph;
  return veh > 0 ? Math.max(0, zone.occupants - (zone.needsTransportOccupants ?? 0)) / veh : 0;
}

export function evacBalance(board: Board, routes: ReadonlyMap<string, RouteOption[]>, plans: readonly ZoneEvacPlan[]): EvacBalanceResult {
  // Warning-only zones must not become evacuation orders through the balancing plan.
  plans = plans.filter((plan) => plan.tier === "order" || plan.action === "leaving");
  const t0Clock = performance.now();
  if (plans.length === 0) return { zones: [], totals: emptyTotals(), allNow: emptyTotals(), computeMs: 0 };
  const grid = timeGrid(board);
  const { t0, step } = grid;
  const S = grid.steps;
  const nowMinute = board.minute;
  const sources = reportedSources(board, true);
  const picture = trafficPicture(board);
  const flows = currentOrderFlows(board, grid);
  const planIds = new Set(plans.map((p) => p.zone.id));
  const background = flows.filter((f) => !planIds.has(f.zone.id));

  // base[k]: share of an order's complying vehicles departing in step k after a grid-aligned start (realism.ts curve).
  const base = new Float64Array(S);
  for (let k = 0; k < S; k++) base[k] = departedShareAfter((k + 1) * step) - departedShareAfter(k * step);
  const shifted = new Map<number, Float64Array>();
  const unitAt = (m: number): Float64Array => {
    let u = shifted.get(m);
    if (!u) {
      u = new Float64Array(S);
      for (let k = m; k < S; k++) u[k] = base[k - m];
      shifted.set(m, u);
    }
    return u;
  };

  // ---- segments ----
  const segIndex = new Map<string, number>();
  const segCapVehH: number[] = [];
  const segName: string[] = [];
  const segQ0Veh: number[] = [];
  const segBg: Float64Array[] = [];
  const segBgZones: string[][] = [];
  const segOf = (s: RouteOption["segments"][number]): number => {
    let j = segIndex.get(s.id);
    if (j === undefined) {
      j = segCapVehH.length;
      segIndex.set(s.id, j);
      segCapVehH.push(Math.max(0, s.capacity_veh_h));
      segName.push(s.name);
      segQ0Veh.push(board.traffic.queue.get(s.id) ?? 0);
      segBg.push(new Float64Array(S));
      segBgZones.push([]);
    }
    return j;
  };
  // ---- destinations ----
  const destIndex = new Map<string, number>();
  const destCapVeh: (number | null)[] = [];
  const destName: string[] = [];
  const destOf = (o: RouteOption): number => {
    let d = destIndex.get(o.destination_id);
    if (d === undefined) {
      d = destCapVeh.length;
      destIndex.set(o.destination_id, d);
      destCapVeh.push(o.destination_capacity_veh);
      destName.push(o.name);
    } else if (destCapVeh[d] === null && o.destination_capacity_veh !== null) destCapVeh[d] = o.destination_capacity_veh;
    return d;
  };

  // Background traffic (orders in effect or scheduled of zones not in the plans).
  for (const f of background) {
    destOf(f.route);
    const seen = new Set<number>();
    for (const s of f.route.segments) {
      const j = segOf(s);
      if (seen.has(j)) continue;
      seen.add(j);
      const b = segBg[j];
      for (let k = 0; k < S; k++) b[k] += f.dep[k];
      segBgZones[j].push(f.zone.id);
    }
  }

  // Plan zones: fixed (leaving), variable (no order in effect), or without a route.
  const Z: ZoneVar[] = [];
  const zoneOfPlan: (number | "no_route" | "leaving_no_route")[] = [];
  for (const plan of plans) {
    const zone = plan.zone;
    const coreAbsMinute = nowMinute + plan.etaMin;
    const fixed = zone.orderedAt !== null;
    const options = fixed ? (zone.route ? [zone.route] : []) : (routes.get(zone.id) ?? []);
    if (options.length === 0) {
      zoneOfPlan.push(fixed ? "leaving_no_route" : "no_route");
      continue;
    }
    const opts: OptData[] = options.map((option) => {
      const seg = Int32Array.from(option.segments.map(segOf));
      const fireAtMinute = segmentFireArrivals(board, option, sources);
      const fireLocal: number[] = [];
      for (let j = 0; j < fireAtMinute.length; j++) if (Number.isFinite(fireAtMinute[j])) fireLocal.push(j);
      return { option, seg, cont: new Int32Array(0), cumFFMin: cumulativeFreeFlow(option.segments), fireAtMinute, fireLocal: Int32Array.from(fireLocal), dest: destOf(option) };
    });
    const kEnd = Math.max(0, Math.min(S, Math.ceil((coreAbsMinute - t0) / step - 0.5)));
    zoneOfPlan.push(Z.length);
    Z.push({ plan, zone, fixed, vehicles: orderVehicles(zone), personsPerVehicle: personsPerVehicle(zone), coreAbsMinute, kEnd, opts, cands: [], cur: -1, term: 0, exposedVehicles: 0, cut: false, cutLocal: -1 });
  }
  const nSeg = segCapVehH.length;
  const nZ = Z.length;
  const nDest = destCapVeh.length;

  // Contended segments: a queue now, or background peak + every plan zone that may use it at its peak step > capacity per step.
  const segStamp = new Int32Array(nSeg);
  let stamp = 0;
  const peakDemand = new Float64Array(nSeg);
  for (let j = 0; j < nSeg; j++) for (let k = 0; k < S; k++) if (segBg[j][k] > peakDemand[j]) peakDemand[j] = segBg[j][k];
  for (const z of Z) {
    stamp++;
    for (const o of z.opts) {
      for (const j of o.seg) {
        if (segStamp[j] === stamp) continue;
        segStamp[j] = stamp;
        peakDemand[j] += z.vehicles * base[0];
      }
    }
  }
  const contended = new Uint8Array(nSeg);
  for (let j = 0; j < nSeg; j++) contended[j] = segQ0Veh[j] > 0 || peakDemand[j] > (segCapVehH[j] / 60) * step ? 1 : 0;
  const segZones: number[][] = Array.from({ length: nSeg }, () => []);
  Z.forEach((z, i) => {
    stamp++;
    for (const o of z.opts) {
      const cont: number[] = [];
      const seenHere = new Set<number>();
      for (const j of o.seg) {
        if (!contended[j] || seenHere.has(j)) continue;
        seenHere.add(j);
        cont.push(j);
        if (segStamp[j] !== stamp) {
          segStamp[j] = stamp;
          segZones[j].push(i);
        }
      }
      o.cont = Int32Array.from(cont);
    }
  });

  // Candidates.
  for (const z of Z) {
    const { plan, zone } = z;
    const caughtOf = (start: number) => {
      const e = expectedCaught(zone, start, z.coreAbsMinute);
      return { caughtHouseholds: e.households, caughtPeople: e.people, caught: e.people ?? e.households };
    };
    if (z.fixed) {
      const start = zone.orderedAt!;
      z.cands.push({ opt: 0, start, m: -1, k0: 0, unit: departureSteps(1, start, grid), ...caughtOf(start) });
      continue;
    }
    const first = Math.max(0, z.opts.findIndex((o) => o.option.destination_id === plan.option?.destination_id));
    const order = [first, ...z.opts.map((_, i) => i).filter((i) => i !== first)];
    const limitOf = (o: OptData) => {
      const ffMin = o.cumFFMin.length > 0 ? o.cumFFMin[o.cumFFMin.length - 1] : o.option.eta_min;
      const optLatest = z.coreAbsMinute - (EVAC_DEPARTURE_LEAD_MIN + ffMin) - EVAC_SAFETY_MARGIN_MIN;
      return Math.min(plan.latestSafeStartMinute, optLatest, t0 + MAX_SCHEDULE_AHEAD_MINUTES);
    };
    const allowed = (m: number, limit: number) => m === 0 || (!plan.tooLate && m > 0 && m < S && t0 + m * step <= limit);
    const pending = zone.pendingOrder;
    for (const oi of order) {
      const o = z.opts[oi];
      const limit = limitOf(o);
      const offsets = [...EVAC_BALANCE_START_OFFSETS_STEPS];
      if (pending && pending.route.destination_id === o.option.destination_id) {
        const mp = Math.round((pending.startMinute - t0) / step);
        if (!offsets.includes(mp)) offsets.push(mp);
      }
      offsets.sort((a, b) => a - b);
      for (const m of offsets) {
        if (!allowed(m, limit)) continue;
        const start = t0 + m * step;
        z.cands.push({ opt: oi, start, m, k0: m, unit: unitAt(m), ...caughtOf(start) });
      }
    }
  }

  // ---- state ----
  const inflow: (Float64Array | null)[] = new Array(nSeg).fill(null);
  const queue: (Float64Array | null)[] = new Array(nSeg).fill(null);
  const segQSum = new Float64Array(nSeg);
  let queueSum = 0; // vehicle-steps queued over contended segments
  for (let j = 0; j < nSeg; j++) {
    if (!contended[j]) continue;
    inflow[j] = Float64Array.from(segBg[j]);
    queue[j] = pointQueue(inflow[j]!, segCapVehH[j], segQ0Veh[j], grid);
    let s = 0;
    for (let k = 0; k < S; k++) s += queue[j]![k];
    segQSum[j] = s;
    queueSum += s;
  }
  const destLoadVeh = new Float64Array(nDest);
  const addLoad = (id: string, veh: number) => {
    const d = destIndex.get(id);
    if (d !== undefined) destLoadVeh[d] += veh;
  };
  for (const [id, veh] of picture.byDestination) addLoad(id, veh);
  for (const z of picture.zones.values()) addLoad(z.route.destination_id, z.committed - z.onRoad);
  for (const f of background) if (f.scheduled) addLoad(f.route.destination_id, orderVehicles(f.zone));
  const destOv = new Float64Array(nDest);
  let overflowSum = 0;
  const overflowOf = (d: number) => {
    const cap = destCapVeh[d];
    return cap === null ? 0 : Math.max(0, destLoadVeh[d] - cap);
  };
  for (let d = 0; d < nDest; d++) {
    destOv[d] = overflowOf(d);
    overflowSum += destOv[d];
  }
  let vehSum = 0;
  let personSum = 0;
  for (const z of Z) {
    vehSum += z.vehicles;
    personSum += z.vehicles * z.personsPerVehicle;
  }
  /** Vehicle-weighted persons per vehicle of the plan zones (destination overflow weight). */
  const avgPersonsPerVehicle = vehSum > 0 ? personSum / vehSum : 1;
  let zoneTermSum = 0;
  const J = () => zoneTermSum + avgPersonsPerVehicle * overflowSum + QUEUE_WEIGHT_PERSON_PER_VEH_MIN * queueSum * step;

  const wait = new Float64Array(S);
  const evalZone = (z: ZoneVar): void => {
    const c = z.cands[z.cur];
    const o = z.opts[c.opt];
    let exposed = 0;
    let cutLocal = -1;
    const u = c.unit;
    if (o.fireLocal.length > 0 && o.cont.length > 0) {
      // The route wait (largest queue delay, traffic.ts) is read only at the steps that can be
      // exposed and at the clearance step (predict.ts clearsAt), so only those are computed.
      const kc = stepOf(grid, c.start + EVAC_DEPARTURE_LEAD_MIN);
      const lo = Math.max(0, Math.min(c.k0, kc));
      const hi = Math.min(S, Math.max(z.kEnd, kc + 1));
      wait.fill(0, lo, hi);
      for (let a = 0; a < o.cont.length; a++) {
        const j = o.cont[a];
        const perMin = segCapVehH[j] / 60;
        if (!(perMin > 0)) continue; // as predict.ts forecastTraffic: no delay figure on a zero-capacity segment
        const q = queue[j]!;
        for (let k = lo; k < hi; k++) {
          const w = q[k] / perMin;
          if (w > wait[k]) wait[k] = w;
        }
      }
    } else wait.fill(0);
    for (let a = 0; a < o.fireLocal.length; a++) {
      const jl = o.fireLocal[a];
      const fire = o.fireAtMinute[jl];
      const ff = o.cumFFMin[jl];
      let s = 0;
      for (let k = c.k0; k < z.kEnd; k++) if (t0 + (k + 0.5) * step + ff + wait[k] >= fire) s += u[k];
      if (s > exposed) exposed = s;
      if (clearsAt(c.start, ff, wait, grid) > fire && (cutLocal < 0 || fire < o.fireAtMinute[cutLocal])) cutLocal = jl;
    }
    z.exposedVehicles = exposed * z.vehicles;
    z.cut = cutLocal >= 0;
    z.cutLocal = cutLocal;
    z.term = c.caught + z.personsPerVehicle * z.exposedVehicles + (z.cut ? FIRE_CUT_PENALTY : 0);
  };

  const zoneStamp = new Int32Array(nZ);
  const touched = new Int32Array(nSeg);
  let nTouched = 0;
  const applyFlow = (z: ZoneVar, ci: number, sign: number): number => {
    const c = z.cands[ci];
    const o = z.opts[c.opt];
    const amt = sign * z.vehicles;
    const u = c.unit;
    for (let a = 0; a < o.cont.length; a++) {
      const j = o.cont[a];
      const f = inflow[j]!;
      for (let k = c.k0; k < S; k++) f[k] += amt * u[k];
      if (segStamp[j] !== stamp) {
        segStamp[j] = stamp;
        touched[nTouched++] = j;
      }
    }
    // A fixed zone's vehicles are already in the destination base load (trafficPicture).
    if (!z.fixed) destLoadVeh[o.dest] += amt;
    return o.dest;
  };
  const refreshDest = (d: number) => {
    const ov = overflowOf(d);
    overflowSum += ov - destOv[d];
    destOv[d] = ov;
  };
  /** Assign candidate ci (-1 = unassigned) to zone i, updating queues, affected zone terms, destination loads and J. */
  const setCandidate = (i: number, ci: number): void => {
    const z = Z[i];
    const old = z.cur;
    if (old === ci) return;
    stamp++;
    nTouched = 0;
    let dOld = -1;
    let dNew = -1;
    if (old >= 0) {
      dOld = applyFlow(z, old, -1);
      zoneTermSum -= z.term;
      z.term = 0;
    }
    if (ci >= 0) dNew = applyFlow(z, ci, 1);
    z.cur = ci;
    for (let a = 0; a < nTouched; a++) {
      const j = touched[a];
      const q = pointQueue(inflow[j]!, segCapVehH[j], segQ0Veh[j], grid, queue[j]!);
      let s = 0;
      for (let k = 0; k < S; k++) s += q[k];
      queueSum += s - segQSum[j];
      segQSum[j] = s;
    }
    zoneStamp[i] = stamp;
    if (ci >= 0) {
      evalZone(z);
      zoneTermSum += z.term;
    }
    for (let a = 0; a < nTouched; a++) {
      const list = segZones[touched[a]];
      for (let b = 0; b < list.length; b++) {
        const zi = list[b];
        if (zoneStamp[zi] === stamp) continue;
        zoneStamp[zi] = stamp;
        const zz = Z[zi];
        if (zz.cur < 0) continue;
        // A zone's term depends on queues only through its route wait at fire-reached segments.
        const oz = zz.opts[zz.cands[zz.cur].opt];
        if (oz.fireLocal.length === 0) continue;
        const cont = oz.cont;
        let hit = false;
        for (let e = 0; e < cont.length && !hit; e++) hit = segStamp[cont[e]] === stamp;
        if (!hit) continue;
        zoneTermSum -= zz.term;
        evalZone(zz);
        zoneTermSum += zz.term;
      }
    }
    if (dOld >= 0) refreshDest(dOld);
    if (dNew >= 0 && dNew !== dOld) refreshDest(dNew);
  };

  // ---- totals ----
  const noRouteCaught = plans.map((pl) => expectedCaught(pl.zone, pl.zone.orderedAt ?? t0, nowMinute + pl.etaMin));
  /** Full inflow (contended or not) of every segment under the current assignment. */
  const fullInflow = (): Float64Array[] => {
    const out = segBg.map((b) => Float64Array.from(b));
    for (const z of Z) {
      if (z.cur < 0) continue;
      const c = z.cands[z.cur];
      stamp++;
      for (const j of z.opts[c.opt].seg) {
        if (segStamp[j] === stamp) continue;
        segStamp[j] = stamp;
        const f = out[j];
        for (let k = c.k0; k < S; k++) f[k] += z.vehicles * c.unit[k];
      }
    }
    return out;
  };
  const totalsNow = (full: Float64Array[], caughtOverride?: Map<number, { households: number; people: number | null }>): EvacBalanceTotals => {
    const t = emptyTotals();
    let peopleKnown = true;
    let people = 0;
    plans.forEach((_plan, pi) => {
      const zi = zoneOfPlan[pi];
      let caught: { households: number; people: number | null };
      if (typeof zi !== "number") caught = noRouteCaught[pi];
      else {
        const z = Z[zi];
        const c = z.cands[z.cur];
        caught = caughtOverride?.get(zi) ?? { households: c.caughtHouseholds, people: c.caughtPeople };
        t.exposed_vehicles += z.exposedVehicles;
        if (z.cut) t.zones_fire_cuts_route++;
        stamp++;
        for (const j of z.opts[c.opt].seg) {
          if (segStamp[j] === stamp) continue;
          segStamp[j] = stamp;
          for (let k = 0; k < S; k++) t.peak_vc = Math.max(t.peak_vc, stepVc(full[j], segCapVehH[j], grid, k));
        }
      }
      t.expected_caught_households += caught.households;
      if (caught.people === null) peopleKnown = false;
      else people += caught.people;
    });
    t.expected_caught_people = peopleKnown ? people : null;
    t.exposed_vehicles = Math.round(t.exposed_vehicles);
    t.queue_vehicle_hours = r1((queueSum * step) / 60);
    t.peak_vc = r2(t.peak_vc);
    for (let d = 0; d < nDest; d++) if (destOv[d] > 1e-9) t.destinations_over_capacity++;
    return t;
  };

  // ---- search ----
  const variables: number[] = [];
  Z.forEach((z, i) => {
    if (z.fixed) setCandidate(i, 0);
    else variables.push(i);
  });
  // (1) all now, to decision_aids' destinations.
  for (const i of variables) {
    const z = Z[i];
    const oi = Math.max(0, z.opts.findIndex((o) => o.option.destination_id === z.plan.option?.destination_id));
    setCandidate(i, z.cands.findIndex((c) => c.opt === oi && c.m === 0));
  }
  const allNow = totalsNow(fullInflow());
  // (2) greedy by margin.
  for (const i of variables) setCandidate(i, -1);
  for (const i of variables) {
    const z = Z[i];
    let best = 0;
    let bestJ = Infinity;
    for (let c = 0; c < z.cands.length; c++) {
      setCandidate(i, c);
      const j = J();
      if (j < bestJ) {
        bestJ = j;
        best = c;
      }
    }
    setCandidate(i, best);
  }
  // (3) local improvement.
  for (let pass = 0; pass < MAX_IMPROVE_PASSES; pass++) {
    let changed = false;
    for (const i of variables) {
      const z = Z[i];
      if (z.cands.length < 2) continue;
      const cur = z.cur;
      let best = cur;
      let bestJ = J();
      for (let c = 0; c < z.cands.length; c++) {
        if (c === cur) continue;
        setCandidate(i, c);
        const j = J();
        if (j < bestJ - IMPROVE_EPS) {
          bestJ = j;
          best = c;
        }
      }
      setCandidate(i, best);
      if (best !== cur) changed = true;
    }
    if (!changed) break;
  }

  // Destination reason per variable zone: the best other option at the same start (evaluated, then restored).
  const destWhy = new Map<number, string>();
  for (const i of variables) {
    const z = Z[i];
    const cur = z.cur;
    const c = z.cands[cur];
    const curJ = J();
    const curCut = z.cut;
    let alt = -1;
    let altJ = Infinity;
    let altCut = false;
    let altOver = false;
    for (let a = 0; a < z.cands.length; a++) {
      const ca = z.cands[a];
      if (ca.opt === c.opt || ca.start !== c.start) continue;
      setCandidate(i, a);
      const j = J();
      if (j < altJ) {
        altJ = j;
        alt = a;
        altCut = z.cut;
        const d = z.opts[ca.opt].dest;
        altOver = d !== z.opts[c.opt].dest && destOv[d] > 1e-9;
      }
    }
    setCandidate(i, cur);
    if (alt < 0) continue;
    const altName = z.opts[z.cands[alt].opt].option.name;
    const curName = z.opts[c.opt].option.name;
    const reason =
      altCut && !curCut
        ? `the fire forecast cuts ${altName} first`
        : altOver
          ? `${altName} is over capacity`
          : altJ - curJ > 0
            ? `${altName} adds ${r1(altJ - curJ)} person-equivalents (queue/exposure)`
            : `${altName} is no better`;
    destWhy.set(i, `to ${curName}: ${reason}`);
  }

  // ---- output ----
  const full = fullInflow();
  const caughtOut = new Map<number, { households: number; people: number | null }>();
  const zones: BalanceZone[] = plans.map((plan, pi) => {
    const zone = plan.zone;
    const zi = zoneOfPlan[pi];
    if (typeof zi !== "number") {
      const caught = noRouteCaught[pi];
      const leaving = zi === "leaving_no_route";
      return {
        zone_id: zone.id,
        action: leaving ? "leaving" : "order_now",
        destination_id: null,
        start_minute: Math.round(leaving ? zone.orderedAt! : t0),
        peak_vc: 0,
        worst_segment: null,
        expected_caught_households: caught.households,
        expected_caught_people: caught.people,
        exposed_vehicles: 0,
        fire_cuts_route: false,
        why: "no open route",
      };
    }
    const z = Z[zi];
    const c = z.cands[z.cur];
    const o = z.opts[c.opt];
    const kStart = Math.max(0, stepOf(grid, c.start));
    let peak = 0;
    let worst = -1;
    for (const j of o.seg) {
      for (let k = kStart; k < S; k++) {
        const v = stepVc(full[j], segCapVehH[j], grid, k);
        if (v > peak) {
          peak = v;
          worst = j;
        }
      }
    }
    const pending = zone.pendingOrder;
    let action: BalanceZone["action"];
    let start = c.start;
    if (z.fixed) action = "leaving";
    else if (pending && pending.route.destination_id === o.option.destination_id && Math.abs(c.start - pending.startMinute) <= step) {
      action = "keep";
      start = pending.startMinute;
    } else if (c.m === 0) action = "order_now";
    else action = pending ? "reschedule" : "schedule";
    const caught = start === c.start ? { households: c.caughtHouseholds, people: c.caughtPeople } : expectedCaught(zone, start, z.coreAbsMinute);
    caughtOut.set(zi, caught);

    const parts: string[] = [];
    if (z.fixed) parts.push(`leaving since minute ${Math.round(c.start)} to ${o.option.name}`);
    else if (plan.tooLate) parts.push("too late for a safe start: order now");
    else if (c.m === 0) parts.push(`start now: fire core in ${Math.round(plan.etaMin)} min`);
    else {
      // The route's most loaded contended segment and who else is on it.
      let hj = -1;
      let hv = -1;
      for (const j of o.cont) {
        for (let k = kStart; k < S; k++) {
          const v = stepVc(full[j], segCapVehH[j], grid, k);
          if (v > hv) {
            hv = v;
            hj = j;
          }
        }
      }
      if (hj >= 0) {
        const beside: string[] = [];
        for (const other of segZones[hj]) {
          if (other === zi || Z[other].cur < 0) continue;
          if (Z[other].opts[Z[other].cands[Z[other].cur].opt].cont.includes(hj)) beside.push(Z[other].zone.id);
        }
        for (const id of segBgZones[hj]) beside.push(id);
        const list = beside.slice(0, 3).join(", ") + (beside.length > 3 ? ` +${beside.length - 3}` : "");
        const beside_ = list ? ` beside zones ${list}` : "";
        parts.push(
          hv <= 1
            ? `held to minute ${Math.round(start)} so ${segName[hj]} stays under ${Math.round(segCapVehH[hj])} veh/h${beside_}; latest safe start ${plan.latestSafeStartMinute}`
            : `held to minute ${Math.round(start)} to cut the queue on ${segName[hj]} (${Math.round(segCapVehH[hj])} veh/h, peak v/c ${r2(hv)})${beside_}; latest safe start ${plan.latestSafeStartMinute}`,
        );
      } else parts.push(`held to minute ${Math.round(start)} (lower expected loss than now); latest safe start ${plan.latestSafeStartMinute}`);
    }
    const dw = destWhy.get(zi);
    if (dw) parts.push(dw);
    if (z.cut) parts.unshift(`fire forecast reaches ${segName[o.seg[z.cutLocal]]} in ${Math.max(0, Math.round(o.fireAtMinute[z.cutLocal] - nowMinute))} min, before ${Math.round(EVAC_TARGET_DEPARTED_SHARE * 100)}% of its traffic passes`);
    return {
      zone_id: zone.id,
      action,
      destination_id: o.option.destination_id,
      start_minute: Math.round(start),
      peak_vc: r2(peak),
      worst_segment: worst >= 0 ? segName[worst] : null,
      expected_caught_households: caught.households,
      expected_caught_people: caught.people,
      exposed_vehicles: Math.round(z.exposedVehicles),
      fire_cuts_route: z.cut,
      why: clip(parts.join("; ")),
    };
  });
  const totals = totalsNow(full, caughtOut);
  return { zones, totals, allNow, computeMs: performance.now() - t0Clock };
}

/** The observation's `evac_balance` block; undefined when there is no plan. */
export function evacBalanceObservation(board: Board, routes: ReadonlyMap<string, RouteOption[]>, plans: readonly ZoneEvacPlan[]): EvacBalanceObservation | undefined {
  if (plans.length === 0) return undefined;
  const r = evacBalance(board, routes, plans);
  return { method: EVAC_BALANCE_LABEL, zones: r.zones, totals: r.totals, all_now: r.allNow };
}
