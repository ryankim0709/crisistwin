/**
 * Fixed-step follow-the-leader traffic over precomputed vehicle paths.
 *
 * Every vehicle drives a chain of segments (see `routing.ts`). Each step, its speed is the
 * minimum of: the segment speed limit (with braking ahead of slower segments and the path
 * end), acceleration from its current speed, and a safe speed toward the nearest obstacle —
 * the vehicle ahead on the same directed lane (or the lanes it will enter next), a vehicle on
 * another lane that is closer to a shared merge point, or a stop line (bridge metering,
 * driveway waiting for a gap). Deceleration is not capped, so vehicles never close below the
 * standstill gap. This is a simple visual model, not a calibrated traffic simulation.
 */
import type { VehicleKind, VehicleStatus } from "../types";
import { pointAtDistance } from "../world";
import type { Lane, Seg } from "./routing";

export const SIM_DT = 0.05;

/** Standstill bumper-to-bumper gap and time headway of the follow-the-leader rule. */
export const MIN_GAP = 5;
const TIME_HEADWAY = 0.15;
const COMFORT_DECEL = 6;
/** How far ahead a vehicle looks for leaders and slower segments. */
const LOOKAHEAD = 70;
/** Vehicles within this distance of a node yield to whoever is closer to it. */
const MERGE_ZONE = 18;
/** Below this speed a vehicle held by an obstacle counts as queued. */
export const QUEUED_SPEED = 2;
/** Space a vehicle on the road must leave for a car pulling out of a driveway. */
const INSERT_AHEAD = 5;
const INSERT_BEHIND = 6;
const INSERT_REACTION_S = 1.4;
/** Engines move to the opposing lane while civilian cars are this close ahead / behind. */
const OVERTAKE_AHEAD = 22;
const OVERTAKE_BEHIND = 9;

export const STATUS_CODES: VehicleStatus[] = [
  "parked",
  "boarding",
  "driving",
  "queued",
  "sheltered",
  "at-station",
  "responding",
  "staged",
];
const CODE = Object.fromEntries(STATUS_CODES.map((s, i) => [s, i])) as Record<
  VehicleStatus,
  number
>;

export type VehiclePlan = {
  id: string;
  kind: VehicleKind;
  length: number;
  segs: Seg[];
  /** Civilians: residents start boarding at this time (Infinity if never). */
  boardFrom: number;
  /** When the vehicle starts moving (Infinity if it never leaves). */
  depart: number;
  restHeading: number;
  /** Vehicle top speed and multiplier on segment limits (engines run faster). */
  maxSpeed: number;
  limitFactor: number;
  accel: number;
  /** Path distance where the bridge starts, or Infinity. */
  bridgeS: number;
  /** Path distance at which the vehicle counts as arrived (civilians: entering the shelter lot). */
  arriveS: number;
};

export type Closure = { edgeId: string; t: number };

export type SimResult = {
  frames: number;
  n: number;
  x: Float32Array;
  z: Float32Array;
  heading: Float32Array;
  speed: Float32Array;
  status: Uint8Array;
  /** Time each vehicle passed `arriveS` (Infinity if it did not); a multiple of SIM_DT. */
  arrival: Float64Array;
  /** Frame index of `arrival` (Infinity if none). */
  arrivalFrame: Float64Array;
  /** Total seconds each vehicle spent queued. */
  queuedTime: Float64Array;
  /** Civilian vehicles queued within `BRIDGE_APPROACH` of the bridge, per frame. */
  nearBridgeQueued: Uint16Array;
  /** Times vehicles entered the bridge, ascending. */
  bridgeEntries: number[];
};

/** Distance before the bridge that counts as its approach for the bottleneck marker. */
export const BRIDGE_APPROACH = 170;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function simulate(
  plans: VehiclePlan[],
  lanes: Lane[],
  opts: { duration: number; bridgeInterval: number; closures: Closure[] },
): SimResult {
  const n = plans.length;
  const frames = Math.round(opts.duration / SIM_DT) + 1;
  const x = new Float32Array(frames * n);
  const z = new Float32Array(frames * n);
  const heading = new Float32Array(frames * n);
  const speed = new Float32Array(frames * n);
  const status = new Uint8Array(frames * n);
  const arrival = new Float64Array(n).fill(Infinity);
  const arrivalFrame = new Float64Array(n).fill(Infinity);
  const queuedTime = new Float64Array(n);
  const nearBridgeQueued = new Uint16Array(frames);
  const bridgeEntries: number[] = [];

  const s = new Float64Array(n);
  const v = new Float64Array(n);
  const segIdx = new Int32Array(n);
  const moving = new Uint8Array(n);
  const done = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const laneX = new Float64Array(n);
  const total = plans.map((p) => p.segs[p.segs.length - 1].s0 + p.segs[p.segs.length - 1].len);
  // Smoothed lateral offset and heading for display.
  const offX = new Float64Array(n);
  const offZ = new Float64Array(n);
  const hd = Float64Array.from(plans.map((p) => p.restHeading));
  const closeAt = new Map(opts.closures.map((c) => [c.edgeId, c.t]));

  const laneOcc: number[][] = lanes.map(() => []);
  const mergeOcc: number[][] = lanes.map(() => []);
  let lastBridge = -Infinity;
  const vNew = new Float64Array(n);
  const overtaking = new Uint8Array(n);
  const lastSeg = new Int32Array(n);
  const lastX = new Float64Array(n);
  const lastZ = new Float64Array(n);

  const segOf = (i: number) => plans[i].segs[segIdx[i]];
  const nextSeg = (i: number): Seg | undefined => plans[i].segs[segIdx[i] + 1];

  for (let k = 0; k < frames; k++) {
    const t = k * SIM_DT;

    // 1. Record the state at time t.
    let nearQueued = 0;
    for (let i = 0; i < n; i++) {
      const plan = plans[i];
      const seg = segOf(i);
      const at = pointAtDistance(seg.points, s[i] - seg.s0);
      let ox = 0;
      let oz = 0;
      if (moving[i] && !done[i] && seg.offset > 0) {
        // Right of travel for heading h is (-cos h, sin h); engines pass stopped traffic on the left.
        const side = overtaking[i] ? -1 : 1;
        ox = -Math.cos(at.heading) * seg.offset * side;
        oz = Math.sin(at.heading) * seg.offset * side;
      }
      if (segIdx[i] !== lastSeg[i]) {
        // Keep the drawn position continuous across segment changes, then ease to the lane.
        const step = v[i] * SIM_DT;
        offX[i] = lastX[i] + Math.sin(at.heading) * step - at.p.x;
        offZ[i] = lastZ[i] + Math.cos(at.heading) * step - at.p.z;
        lastSeg[i] = segIdx[i];
      }
      offX[i] += (ox - offX[i]) * 0.2;
      offZ[i] += (oz - offZ[i]) * 0.2;
      if (moving[i] && !done[i] && v[i] > 0.05) hd[i] += wrapAngle(at.heading - hd[i]) * 0.3;
      const f = k * n + i;
      x[f] = at.p.x + offX[i];
      z[f] = at.p.z + offZ[i];
      lastX[i] = x[f];
      lastZ[i] = z[f];
      heading[f] = wrapAngle(hd[i]);
      speed[f] = moving[i] && !done[i] ? v[i] : 0;
      let st: VehicleStatus;
      if (plan.kind === "civilian") {
        if (arrivalFrame[i] <= k) st = "sheltered";
        else if (moving[i]) st = blocked[i] && v[i] < QUEUED_SPEED ? "queued" : "driving";
        else st = t >= plan.boardFrom ? "boarding" : "parked";
      } else {
        st = done[i] ? "staged" : moving[i] ? "responding" : "at-station";
      }
      status[f] = CODE[st];
      if (st === "queued") {
        if (k > 0) queuedTime[i] += SIM_DT;
        const toBridge = plan.bridgeS - s[i];
        if (toBridge >= 0 && toBridge <= BRIDGE_APPROACH) nearQueued++;
      }
      // Invariant: nobody is on an edge once it is closed.
      if (moving[i] && !done[i] && seg.edgeId !== null) {
        const ct = closeAt.get(seg.edgeId);
        if (ct !== undefined && t >= ct)
          throw new Error(`${plan.id} is on closed edge ${seg.edgeId} at t=${t.toFixed(2)}`);
      }
    }
    nearBridgeQueued[k] = nearQueued;
    if (k === frames - 1) break;

    // 2. Lane occupancy and merge candidates from the state at time t.
    for (const list of laneOcc) list.length = 0;
    for (const list of mergeOcc) list.length = 0;
    for (let i = 0; i < n; i++) {
      if (!moving[i] || done[i]) continue;
      const seg = segOf(i);
      if (seg.lane < 0) continue;
      laneX[i] = seg.laneStart + (s[i] - seg.s0);
      laneOcc[seg.lane].push(i);
      const nx = nextSeg(i);
      if (nx && nx.lane >= 0 && seg.s0 + seg.len - s[i] < MERGE_ZONE) mergeOcc[nx.lane].push(i);
    }

    // Engines with civilian traffic alongside on their lane drive in the opposing lane.
    for (let i = 0; i < n; i++) {
      overtaking[i] = 0;
      if (plans[i].kind !== "engine" || !moving[i] || done[i] || segOf(i).lane < 0) continue;
      for (const j of laneOcc[segOf(i).lane]) {
        const d = laneX[j] - laneX[i];
        if (plans[j].kind === "civilian" && d > -OVERTAKE_BEHIND && d < OVERTAKE_AHEAD)
          overtaking[i] = 1;
      }
    }

    // 3. New speeds.
    for (let i = 0; i < n; i++) {
      const plan = plans[i];
      if (done[i]) continue;
      if (!moving[i]) {
        if (t + 1e-9 < plan.depart) continue;
        moving[i] = 1;
      }
      const seg = segOf(i);
      const remainingSeg = seg.s0 + seg.len - s[i];
      const limitOf = (sg: Seg) => Math.min(plan.maxSpeed, sg.limit * plan.limitFactor);
      let vMax = limitOf(seg);
      // Brake ahead of slower segments and the end of the path.
      let ahead = remainingSeg;
      for (let m = segIdx[i] + 1; m < plan.segs.length && ahead < LOOKAHEAD; m++) {
        const sg = plan.segs[m];
        vMax = Math.min(vMax, Math.sqrt(limitOf(sg) ** 2 + 2 * COMFORT_DECEL * ahead));
        ahead += sg.len;
      }
      vMax = Math.min(vMax, Math.sqrt(2 * COMFORT_DECEL * Math.max(0, total[i] - s[i])) + 0.3);

      // Nearest obstacle as (bumper gap, its speed, standstill gap).
      let gap = Infinity;
      let gapSpeed = 0;
      let gapMin = MIN_GAP;
      const consider = (g: number, sp: number, minGap: number) => {
        if (g - minGap < gap - gapMin) {
          gap = g;
          gapSpeed = sp;
          gapMin = minGap;
        }
      };
      // Leaders on this lane and the next lanes of the path.
      let acc = 0;
      for (let m = segIdx[i]; m < plan.segs.length && acc < LOOKAHEAD; m++) {
        const sg = plan.segs[m];
        if (sg.lane >= 0) {
          const from = m === segIdx[i] ? laneX[i] : sg.laneStart;
          const base = m === segIdx[i] ? 0 : acc - sg.laneStart;
          let found = false;
          for (const j of laneOcc[sg.lane]) {
            if (j === i || (plan.kind === "engine" && plans[j].kind === "civilian")) continue;
            const xj = laneX[j];
            if (xj < from || (xj === from && j > i) || xj > sg.laneStart + sg.len + plans[j].length)
              continue;
            const d =
              (m === segIdx[i] ? xj - from : base + xj) - (plan.length + plans[j].length) / 2;
            consider(d, v[j], MIN_GAP);
            found = true;
          }
          if (found) break;
        }
        acc += m === segIdx[i] ? remainingSeg : sg.len;
      }
      const nx = nextSeg(i);
      if (nx && nx.lane >= 0 && seg.lane >= 0 && remainingSeg < MERGE_ZONE) {
        // Yield to vehicles from other lanes that are closer to the shared merge point.
        for (const j of mergeOcc[nx.lane]) {
          if (j === i || segOf(j).lane === seg.lane) continue;
          if (plan.kind === "engine" && plans[j].kind === "civilian") continue;
          const rj = segOf(j).s0 + segOf(j).len - s[j];
          if (rj < remainingSeg || (rj === remainingSeg && j < i)) {
            consider(remainingSeg - rj - (plan.length + plans[j].length) / 2, v[j], MIN_GAP);
          }
        }
        // Bridge metering: one vehicle onto the single-lane bridge per interval. The stop line
        // only applies if the gate would still be closed when this vehicle reaches it.
        const opensIn = lastBridge + opts.bridgeInterval - t;
        if (nx.bridge && opensIn > 0 && opensIn > remainingSeg / Math.max(v[i], 0.5) - SIM_DT) {
          consider(remainingSeg - plan.length / 2, 0, 0.3);
        }
      }
      if (
        nx &&
        nx.lane >= 0 &&
        seg.lane < 0 &&
        remainingSeg < 4 &&
        !insertionClear(i, nx, plans, laneOcc, laneX, v)
      ) {
        consider(remainingSeg, 0, 0.05);
      }

      let vSafe = Infinity;
      if (gap < Infinity) {
        const room = Math.max(0, gap - gapMin);
        vSafe = Math.min(
          room / TIME_HEADWAY,
          Math.sqrt(gapSpeed * gapSpeed + 2 * COMFORT_DECEL * room),
        );
      }
      const vFree = Math.min(vMax, v[i] + plan.accel * SIM_DT);
      vNew[i] = Math.max(0, Math.min(vFree, vSafe));
      blocked[i] = vSafe < vFree ? 1 : 0;
    }

    // 4. Move, handling segment changes (bridge metering and driveway gaps are re-checked).
    const tNext = t + SIM_DT;
    for (let i = 0; i < n; i++) {
      if (!moving[i] || done[i]) continue;
      const plan = plans[i];
      v[i] = vNew[i];
      s[i] += v[i] * SIM_DT;
      for (;;) {
        const seg = segOf(i);
        const end = seg.s0 + seg.len;
        if (s[i] < end) break;
        const nx = nextSeg(i);
        if (!nx) {
          s[i] = end;
          v[i] = 0;
          done[i] = 1;
          break;
        }
        if (nx.bridge && tNext - lastBridge < opts.bridgeInterval) {
          s[i] = end - 1e-3;
          v[i] = 0;
          blocked[i] = 1;
          break;
        }
        if (nx.lane >= 0 && seg.lane < 0 && !insertionClear(i, nx, plans, laneOcc, laneX, v)) {
          s[i] = end - 1e-3;
          v[i] = 0;
          blocked[i] = 1;
          break;
        }
        segIdx[i]++;
        if (nx.bridge) {
          lastBridge = tNext;
          bridgeEntries.push(tNext);
        }
        if (nx.lane >= 0 && seg.lane < 0) {
          // Claim the gap now so another car pulling out this step sees it.
          laneX[i] = nx.laneStart;
          laneOcc[nx.lane].push(i);
        }
      }
      if (arrivalFrame[i] === Infinity && (done[i] || s[i] >= plan.arriveS)) {
        arrivalFrame[i] = k + 1;
        arrival[i] = (k + 1) * SIM_DT;
      }
    }
  }

  return {
    frames,
    n,
    x,
    z,
    heading,
    speed,
    status,
    arrival,
    arrivalFrame,
    queuedTime,
    nearBridgeQueued,
    bridgeEntries,
  };
}

function insertionClear(
  i: number,
  nx: Seg,
  plans: VehiclePlan[],
  laneOcc: number[][],
  laneX: Float64Array,
  v: Float64Array,
): boolean {
  const x0 = nx.laneStart;
  for (const j of laneOcc[nx.lane]) {
    if (j === i) continue;
    const half = (plans[i].length + plans[j].length) / 2;
    const d = laneX[j] - x0;
    if (d > -(half + INSERT_BEHIND + v[j] * INSERT_REACTION_S) && d < half + INSERT_AHEAD)
      return false;
  }
  return true;
}

export const statusAt = (code: number): VehicleStatus => STATUS_CODES[code];
