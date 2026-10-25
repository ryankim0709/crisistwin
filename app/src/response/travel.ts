/**
 * Responder travel on a road leg: slowed by evacuation traffic on the same roads (with or
 * against the outbound flow), varied by a seeded multiplier, and cut where fire has burned
 * across the road. Pure. See docs/response-model.md, "Travel".
 *
 * The leg itself (road line and free-flow drive minutes, per apparatus class with the road
 * access rules R01-R12) comes from POST /api/demo/crew_routes (livecore.inbound), which already
 * avoids roads inside the fire at request time. The board's own households are not in the live
 * traffic twin, so the congestion here is computed from the board's zone departures on their
 * evacuation routes, not read from the twin (docs/command-demo-realism.md, Congestion).
 *
 * Model (per 100 m of the leg):
 *   v_with    = outbound evacuation flow on the same road, travelling the responder's way, veh/h
 *   v_against = outbound flow on the same road, travelling the opposite way, veh/h
 *   factor    = 1 + 0.15 ((v_with + OPPOSING_FLOW_WEIGHT x v_against) / c)^4   (BPR, 1964)
 *   capped at CONGESTION_MAX_FACTOR; the leg's drive minutes are scaled by the length-weighted
 *   mean factor (free-flow minutes are taken as uniform along the leg, ASSUMPTION).
 */

import type { LonLat } from "../live/types";
import { lognormalFactor, type RngStream } from "./rng";

/** Bureau of Public Roads (1964) link performance function: t = t0 (1 + ALPHA (v/c)^BETA). */
export const BPR_ALPHA = 0.15;
export const BPR_BETA = 4;
/**
 * Capacity per direction of a two-lane highway, veh/h: HCM 2010 Chapter 15 (1,700 pc/h per
 * direction; as cited, not re-fetched). Applied to every evacuation route (ASSUMPTION: the
 * board's routes carry no lane counts; most drill exits are two-lane roads).
 */
export const CAPACITY_VEH_PER_HOUR = 1700;
/**
 * ASSUMPTION: an inbound responder against the outbound flow is slowed as if half the opposing
 * volume were in its own direction (oncoming queues spill into the opposing lane, vehicles
 * cannot pull over in a queue). No retrieved study quantifies this; sim/responders.py's CHP
 * contraflow rule (0.4 of free-flow speed under contraflow) is the nearest repo precedent.
 */
export const OPPOSING_FLOW_WEIGHT = 0.5;
/** Upper bound on the congestion factor: livecore/routing.py CONGESTION_MAX_FACTOR (a stopped edge counts as 10x free flow). */
export const CONGESTION_MAX_FACTOR = 10;
/**
 * Vehicles per evacuating household: 1.6, inside the sourced 1.52-1.82 (Wong et al. 2020, Table
 * 10; tools/people_behavior.json vehicles_per_evacuating_household) and the value sim/scenario.py uses.
 */
export const VEHICLES_PER_HOUSEHOLD = 1.6;
/** ASSUMPTION: a responder shares a road with an evacuation route when within this distance of it, metres. */
export const SHARED_ROAD_M = 60;
/**
 * ASSUMPTION: seeded travel-time variation, lognormal log-SD 0.2 (median 1, about +/-20%).
 * Shape after Budge, Ingolfsson & Zerom (2010, Management Science 56(4)), who found
 * emergency-vehicle travel times log-distributed around a distance-based median; the spread
 * here is not fitted to their data.
 */
export const TRAVEL_LOG_SD = 0.2;
/** ASSUMPTION: after fire cuts a unit's road, its straight-line fallback is this much longer until a new road leg arrives. */
export const REROUTE_DETOUR_FACTOR = 1.5;
/** ASSUMPTION: the last stretch of a leg (the unit walks or works in from the road) is not tested for fire cuts, metres. */
export const CUT_IGNORE_LAST_M = 300;

const METERS_PER_DEG = 111_320;
const SAMPLE_M = 100;
const CELL_M = 200;

export interface EvacuationFlow {
  /** The route line, origin (zone) to destination: the direction of the outbound flow. */
  line: readonly LonLat[];
  vehiclesPerHour: number;
}

interface FlowSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ux: number;
  uy: number;
  vph: number;
}

export interface FlowIndex {
  lat0: number;
  cells: Map<string, FlowSeg[]>;
  totalVph: number;
}

function project(lat0: number, p: LonLat): [number, number] {
  return [p[0] * METERS_PER_DEG * Math.cos((lat0 * Math.PI) / 180), p[1] * METERS_PER_DEG];
}

const cellKey = (x: number, y: number) => `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;

/** A spatial index of the outbound flows (segments bucketed into 200 m cells). */
export function buildFlowIndex(flows: readonly EvacuationFlow[], lat0: number): FlowIndex {
  const cells = new Map<string, FlowSeg[]>();
  let totalVph = 0;
  for (const flow of flows) {
    if (flow.vehiclesPerHour <= 0 || flow.line.length < 2) continue;
    totalVph += flow.vehiclesPerHour;
    for (let i = 1; i < flow.line.length; i += 1) {
      const [ax, ay] = project(lat0, flow.line[i - 1]);
      const [bx, by] = project(lat0, flow.line[i]);
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      const seg: FlowSeg = { ax, ay, bx, by, ux: (bx - ax) / len, uy: (by - ay) / len, vph: flow.vehiclesPerHour };
      const steps = Math.ceil(len / (CELL_M / 2));
      const keys = new Set<string>();
      for (let s = 0; s <= steps; s += 1) {
        const x = ax + ((bx - ax) * s) / steps;
        const y = ay + ((by - ay) * s) / steps;
        for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) keys.add(cellKey(x + dx * CELL_M, y + dy * CELL_M));
      }
      for (const k of keys) {
        const list = cells.get(k);
        if (list) list.push(seg);
        else cells.set(k, [seg]);
      }
    }
  }
  return { lat0, cells, totalVph };
}

function distToSeg(px: number, py: number, s: FlowSeg): number {
  const vx = s.bx - s.ax;
  const vy = s.by - s.ay;
  const t = Math.max(0, Math.min(1, ((px - s.ax) * vx + (py - s.ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (s.ax + t * vx), py - (s.ay + t * vy));
}

export function bprFactor(volumeToCapacity: number): number {
  return Math.min(CONGESTION_MAX_FACTOR, 1 + BPR_ALPHA * Math.pow(Math.max(0, volumeToCapacity), BPR_BETA));
}

export interface CongestionResult {
  /** Multiplier on the leg's free-flow drive minutes (>= 1). */
  multiplier: number;
  /** Share of the leg's length shared with an outbound flow in the responder's direction / against it. */
  withShare: number;
  againstShare: number;
  /** Highest effective v/c met along the leg. */
  peakVolumeToCapacity: number;
}

const FREE: CongestionResult = { multiplier: 1, withShare: 0, againstShare: 0, peakVolumeToCapacity: 0 };

/** The congestion multiplier for a responder driving `line` (from start to end) through `index`. */
export function congestionOnLeg(index: FlowIndex | null, line: readonly LonLat[]): CongestionResult {
  if (!index || index.totalVph <= 0 || line.length < 2) return FREE;
  let total = 0;
  let weighted = 0;
  let withLen = 0;
  let againstLen = 0;
  let peak = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [ax, ay] = project(index.lat0, line[i - 1]);
    const [bx, by] = project(index.lat0, line[i]);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const n = Math.max(1, Math.round(len / SAMPLE_M));
    const piece = len / n;
    for (let s = 0; s < n; s += 1) {
      const x = ax + ux * piece * (s + 0.5);
      const y = ay + uy * piece * (s + 0.5);
      let vWith = 0;
      let vAgainst = 0;
      const segs = index.cells.get(cellKey(x, y));
      if (segs) {
        for (const seg of segs) {
          if (distToSeg(x, y, seg) > SHARED_ROAD_M) continue;
          const dot = ux * seg.ux + uy * seg.uy;
          if (dot > 0.5) vWith += seg.vph;
          else if (dot < -0.5) vAgainst += seg.vph;
        }
      }
      const vc = (vWith + OPPOSING_FLOW_WEIGHT * vAgainst) / CAPACITY_VEH_PER_HOUR;
      peak = Math.max(peak, vc);
      weighted += bprFactor(vc) * piece;
      total += piece;
      if (vWith > 0) withLen += piece;
      if (vAgainst > 0) againstLen += piece;
    }
  }
  if (total <= 0) return FREE;
  return { multiplier: weighted / total, withShare: withLen / total, againstShare: againstLen / total, peakVolumeToCapacity: peak };
}

/** A seeded travel-time multiplier (median 1). */
export function travelVariation(rng: RngStream): number {
  return lognormalFactor(rng, TRAVEL_LOG_SD);
}

/**
 * Whether fire has cut the rest of a road line: sample it every 100 m from fraction `fromU` of
 * its length to CUT_IGNORE_LAST_M before its end, and return the first sampled point where
 * `burned` is true (or null).
 */
export function routeCutAt(line: readonly LonLat[], fromU: number, burned: (p: LonLat) => boolean): LonLat | null {
  if (line.length < 2) return null;
  const lat0 = line[0][1];
  const pts = line.map((p) => project(lat0, p));
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = lens.reduce((a, b) => a + b, 0);
  const end = total - CUT_IGNORE_LAST_M;
  let d = Math.max(0, fromU) * total;
  while (d < end) {
    let left = d;
    let i = 0;
    while (i < lens.length - 1 && left > lens[i]) left -= lens[i++];
    const f = lens[i] > 0 ? Math.min(1, left / lens[i]) : 0;
    const p: LonLat = [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f];
    if (burned(p)) return p;
    d += SAMPLE_M;
  }
  return null;
}
