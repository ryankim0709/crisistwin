/**
 * Evacuation for Simulation Studio: the dispatch engine (dispatch/engine.ts) run under a fixed,
 * visible policy instead of the AI dispatcher, so a planner can close roads and bridges and see
 * what that does to the evacuation. The fire is the studio run's arrival field; closures never
 * change it. See docs/adr/0018-road-closures.md.
 *
 * Policy (deterministic, no randomness):
 * - At `orderMinute` every zone the fire has not overrun is ordered to the exit it can reach
 *   fastest at free flow, avoiding closed edges and edges the fire reaches within the engine's
 *   routing lookahead.
 * - A zone with no reachable exit at that minute is "cut off": it is never ordered and its
 *   households stay home. Closures last the whole run and fire only blocks more edges over
 *   time, so a cut-off zone cannot become reachable again.
 * - When an ordered zone's route is cut by fire, it is re-ordered the same minute to its
 *   fastest reachable exit; with none left its departures stay held (engine behaviour).
 */

import type { DispatchArea } from "../dispatch/area";
import { DispatchEngine, type Totals } from "../dispatch/engine";
import type { FireExposure } from "../dispatch/fireExposure";
import { routeTo, shortestPathTree } from "../dispatch/routing";
import { lonLatToMercator } from "../fire/landscape";

/** Minutes after T+0 at which the evacuation order goes out. */
export const ORDER_MINUTE_CHOICES = [0, 15, 30, 60] as const;
export const DEFAULT_ORDER_MINUTE = 0;

export interface EvacuationInputs {
  area: DispatchArea;
  exposure: FireExposure;
  horizonMinutes: number;
  /** Edge indices closed to traffic for the whole run. */
  closedEdges: ReadonlySet<number>;
  orderMinute: number;
}

export interface EvacuationSummary {
  /** Area totals at the end of each simulated minute, index = minute (0..horizon). */
  totalsByMinute: Totals[];
  final: Totals;
  /** Zones (and their homes) with no reachable exit when the order went out. */
  cutOffZones: number;
  cutOffHomes: number;
  /** Minute the last ordered zone cleared, or null if some zone had not by the horizon. */
  allClearMinute: number | null;
  /** Household-hours spent ordered but not yet at an exit (at home, queued or driving). */
  householdHoursEvacuating: number;
}

export class EvacuationPolicyRun {
  readonly inputs: EvacuationInputs;
  readonly engine: DispatchEngine;
  /** Zone indices the policy found no exit for. */
  readonly cutOff = new Set<number>();
  private ordered = false;
  /** Ordered zones whose route was cut and that have no exit left; not searched again. */
  private stranded = new Set<number>();

  constructor(inputs: EvacuationInputs) {
    this.inputs = inputs;
    this.engine = new DispatchEngine(
      inputs.area,
      inputs.exposure,
      inputs.horizonMinutes,
      [],
      inputs.closedEdges,
    );
    this.applyPolicy();
  }

  get minute(): number {
    return this.engine.minute;
  }

  get finished(): boolean {
    return this.engine.finished;
  }

  step(): void {
    this.engine.step();
    this.applyPolicy();
  }

  /** Fastest exit reachable from the zone's loading node right now, or null. */
  private bestExit(zone: number): string | null {
    const { area } = this.inputs;
    const tree = shortestPathTree(
      area,
      area.zones[zone].node,
      this.engine.blockedAt(this.engine.minute),
    );
    let best: { id: string; seconds: number } | null = null;
    for (const exit of area.exits) {
      const route = routeTo(area, tree, exit.node);
      if (route && (!best || route.seconds < best.seconds))
        best = { id: exit.id, seconds: route.seconds };
    }
    return best?.id ?? null;
  }

  private order(zone: number, exitId: string): void {
    this.engine.applyOrders([
      {
        type: "order_evacuation",
        zone_id: this.inputs.area.zones[zone].id,
        exit_id: exitId,
        reason: "Studio policy: fastest open exit.",
      },
    ]);
  }

  private applyPolicy(): void {
    const { engine } = this;
    if (engine.minute < this.inputs.orderMinute) return;
    if (!this.ordered) {
      this.ordered = true;
      for (const zone of engine.zones) {
        if (zone.status !== "no_order") continue;
        const exitId = this.bestExit(zone.index);
        if (exitId) this.order(zone.index, exitId);
        else this.cutOff.add(zone.index);
      }
      return;
    }
    for (const zone of engine.zones) {
      if (zone.status !== "ordered" || !zone.routeBlocked || this.stranded.has(zone.index))
        continue;
      const exitId = this.bestExit(zone.index);
      if (exitId) this.order(zone.index, exitId);
      else this.stranded.add(zone.index);
    }
  }
}

/** Run the policy to the horizon and summarise it. */
export function simulateEvacuation(inputs: EvacuationInputs): EvacuationSummary {
  const run = new EvacuationPolicyRun(inputs);
  const totalsByMinute: Totals[] = [run.engine.totals()];
  let evacuatingMinutes = 0;
  while (!run.finished) {
    run.step();
    const totals = run.engine.totals();
    totalsByMinute.push(totals);
    evacuatingMinutes += totals.waiting + totals.onRoad;
  }
  const { area } = inputs;
  const zones = run.engine.zones;
  let cutOffHomes = 0;
  for (const zone of run.cutOff) cutOffHomes += area.zones[zone].homes;
  let allClearMinute: number | null = null;
  const orderedZones = zones.filter((zone) => zone.orderRank !== null);
  if (orderedZones.length > 0 && orderedZones.every((zone) => zone.status !== "ordered")) {
    allClearMinute = Math.max(
      inputs.orderMinute,
      ...orderedZones.map((zone) => zone.clearedMinute ?? inputs.orderMinute),
    );
  }
  return {
    totalsByMinute,
    final: totalsByMinute[totalsByMinute.length - 1],
    cutOffZones: run.cutOff.size,
    cutOffHomes,
    allClearMinute,
    householdHoursEvacuating: evacuatingMinutes / 60,
  };
}

/**
 * The policy run positioned at a playback minute, for drawing. Moving forward steps the engine;
 * moving back replays from T+0 (the run is deterministic, so the replay is identical).
 */
export class EvacuationPlayer {
  private run: EvacuationPolicyRun;

  constructor(readonly inputs: EvacuationInputs) {
    this.run = new EvacuationPolicyRun(inputs);
  }

  get engine(): DispatchEngine {
    return this.run.engine;
  }

  /** Position at whole minute `minute`; true when the engine state changed. */
  syncTo(minute: number): boolean {
    const target = Math.max(0, Math.min(this.inputs.horizonMinutes, Math.floor(minute)));
    if (target === this.run.minute) return false;
    if (target < this.run.minute) this.run = new EvacuationPolicyRun(this.inputs);
    while (this.run.minute < target && !this.run.finished) this.run.step();
    return true;
  }
}

/** A click farther than this from every road selects none, ground metres. */
export const ROAD_PICK_METERS = 120;

/**
 * Index of the edge whose polyline passes closest to `point` (WGS84 [lon, lat]), within
 * `maxMeters` of ground, or null. Distances are Web Mercator scaled by cos(latitude).
 */
export function nearestEdge(
  area: DispatchArea,
  point: readonly [number, number],
  maxMeters = ROAD_PICK_METERS,
): number | null {
  const [px, py] = lonLatToMercator(point[0], point[1]);
  const scale = Math.cos((point[1] * Math.PI) / 180);
  let best: number | null = null;
  let bestMeters = maxMeters;
  for (const edge of area.edges) {
    let [ax, ay] = lonLatToMercator(edge.coords[0][0], edge.coords[0][1]);
    for (let i = 1; i < edge.coords.length; i += 1) {
      const [bx, by] = lonLatToMercator(edge.coords[i][0], edge.coords[i][1]);
      const dx = bx - ax;
      const dy = by - ay;
      const length2 = dx * dx + dy * dy;
      const t =
        length2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
      const meters = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * scale;
      if (meters < bestMeters) {
        bestMeters = meters;
        best = edge.index;
      }
      ax = bx;
      ay = by;
    }
  }
  return best;
}
