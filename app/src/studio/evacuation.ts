/**
 * Evacuation for Simulation Studio: the dispatch engine (dispatch/engine.ts) run under a fixed,
 * visible policy instead of the AI dispatcher, so a planner can close roads and bridges and see
 * what that does to the evacuation. The fire is the studio run's arrival field; closures never
 * change it. See docs/adr/0018-road-closures.md.
 *
 * Households leave on the engine's uniform departure spread, or, with `departureDelays`
 * (studio/householdBehavior.ts, seeded per home), each after its own delay; some stay home.
 *
 * Policy (deterministic; the only randomness is the seeded household draw):
 * - At `orderMinute` every zone the fire has not overrun is ordered to the exit it can reach
 *   fastest at free flow, avoiding closed edges and edges the fire reaches within the engine's
 *   routing lookahead.
 * - An optional plan (`EvacuationPlan`, built by studio/evacuationOptimizer.ts) changes only
 *   that first order: a planned zone goes to its planned exit when it is reachable then (else
 *   its fastest), and a zone planned to wait is staged behind its predecessor (the engine's
 *   staged waves) instead of being ordered at once. Everything after is the same policy.
 * - A zone with no reachable exit at that minute is "cut off": it is never ordered and its
 *   households stay home. Closures last the whole run and fire only blocks more edges over
 *   time, so a cut-off zone cannot become reachable again.
 * - When an ordered zone's route is cut by fire, it is re-ordered the same minute to its
 *   fastest reachable exit; with none left its departures stay held (engine behaviour).
 * - Firefighters overwhelmed by the fire (studio/crewHandoff.ts) join at their leave minute and
 *   go on evacuation support, which shortens a zone's departure spread while they are on scene.
 *   A crew whose road point the fire has already cut off from every zone still evacuating pulls
 *   back to the nearest node that can reach one.
 *   Every CREW_REVIEW_MINUTES an idle crew (just arrived from the fire, withdrawn, or in a zone
 *   that has cleared) goes to the ordered zone with the fewest crews, then the earliest fire
 *   contact, then the most households still at home, skipping zones the fire is about to reach.
 */

import { groundMeters, type DispatchArea } from "../dispatch/area";
import {
  DispatchEngine,
  UNIT_WITHDRAW_MARGIN_MINUTES,
  type Totals,
  type UnitState,
} from "../dispatch/engine";
import type { FireExposure } from "../dispatch/fireExposure";
import { routeTo, shortestPathTree } from "../dispatch/routing";
import { lonLatToMercator } from "../fire/landscape";
import type { EvacuationCrew } from "./crewHandoff";

/** Minutes after T+0 at which the evacuation order goes out. */
export const ORDER_MINUTE_CHOICES = [0, 15, 30, 60] as const;
export const DEFAULT_ORDER_MINUTE = 0;
/** Idle crews are given a zone this often, simulated minutes. */
export const CREW_REVIEW_MINUTES = 5;
/** Crews are not sent to a zone whose core the fire reaches within this many minutes. */
const CREW_ZONE_MARGIN_MINUTES = UNIT_WITHDRAW_MARGIN_MINUTES + 10;
/** Zones tried per idle crew before it waits for the next review. */
const CREW_ZONE_TRIES = 3;

/**
 * Per-zone choices that replace parts of the default policy (fastest open exit, every zone
 * ordered at `orderMinute`). Ids are the area's zone and exit ids. Built by
 * studio/evacuationOptimizer.ts; every outcome still comes from the engine.
 */
export interface EvacuationPlan {
  /**
   * Exit each listed zone is ordered to. Unlisted zones, and a listed exit that is unreachable
   * at order time, get their fastest open exit.
   */
  exits: Readonly<Record<string, string>>;
  /**
   * Waves: zone id → id of the zone whose households must be on the road before it leaves
   * (the engine's `stage_evacuation`). A zone whose predecessor is cut off is ordered directly.
   */
  after: Readonly<Record<string, string>>;
}

export interface EvacuationInputs {
  area: DispatchArea;
  exposure: FireExposure;
  horizonMinutes: number;
  /** Edge indices closed to traffic for the whole run. */
  closedEdges: ReadonlySet<number>;
  orderMinute: number;
  /** Firefighters who leave the fire to support the evacuation (none when omitted). */
  crews?: readonly EvacuationCrew[];
  /** Planned exits and waves; the default policy when omitted. */
  plan?: EvacuationPlan;
  /**
   * Minutes from a zone's order to each home leaving, Infinity for a household that stays
   * (studio/householdBehavior.ts); the engine's uniform departure spread when omitted.
   */
  departureDelays?: Float32Array;
}

export interface EvacuationSummary {
  /** Area totals at the end of each simulated minute, index = minute (0..horizon). */
  totalsByMinute: Totals[];
  final: Totals;
  /** Zones (and their homes) with no reachable exit when the order went out. */
  cutOffZones: number;
  cutOffHomes: number;
  /** Indices of the cut-off zones. */
  cutOffZoneIndices: number[];
  /** Per zone, the minute it first got an order over the full run, or null if never ordered. */
  zoneOrderMinutes: (number | null)[];
  /** Minute the last ordered zone cleared, or null if some zone had not by the horizon. */
  allClearMinute: number | null;
  /**
   * Household-hours spent ordered but not yet at an exit (at home, queued or driving),
   * including households staged to leave in a later wave (told to get ready, still at home).
   */
  householdHoursEvacuating: number;
  /** Households of zones still waiting for their wave at the horizon (0 without waves). */
  stagedHomes: number;
}

/** What the policy did with a zone at the order minute. */
export interface InitialOrder {
  /** Exit it was ordered (or staged) to. */
  exitId: string;
  /** Zone index it was staged behind, or null when ordered directly. */
  after: number | null;
}

export class EvacuationPolicyRun {
  readonly inputs: EvacuationInputs;
  readonly engine: DispatchEngine;
  /** Zone indices the policy found no exit for. */
  readonly cutOff = new Set<number>();
  /** Zone index → what it was told at the order minute (cut-off zones are absent). */
  readonly initialOrders = new Map<number, InitialOrder>();
  private ordered = false;
  /** Ordered zones whose route was cut and that have no exit left; not searched again. */
  private stranded = new Set<number>();
  /** Crew units by id once they have left the fire. */
  private crewUnits = new Map<string, UnitState>();

  constructor(inputs: EvacuationInputs) {
    this.inputs = inputs;
    this.engine = new DispatchEngine(
      inputs.area,
      inputs.exposure,
      inputs.horizonMinutes,
      [],
      inputs.closedEdges,
    );
    if (inputs.departureDelays) this.engine.setDepartureDelays(inputs.departureDelays);
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

  /**
   * `preferred` when it is reachable from the zone's loading node right now, else the fastest
   * exit reachable now, or null.
   */
  private bestExit(zone: number, preferred?: string): string | null {
    const { area } = this.inputs;
    const tree = shortestPathTree(
      area,
      area.zones[zone].node,
      this.engine.blockedAt(this.engine.minute),
    );
    if (preferred !== undefined) {
      const exit = area.exits.find((candidate) => candidate.id === preferred);
      if (exit && routeTo(area, tree, exit.node)) return preferred;
    }
    let best: { id: string; seconds: number } | null = null;
    for (const exit of area.exits) {
      const route = routeTo(area, tree, exit.node);
      if (route && (!best || route.seconds < best.seconds))
        best = { id: exit.id, seconds: route.seconds };
    }
    return best?.id ?? null;
  }

  private order(zone: number, exitId: string, reason = "Studio policy: fastest open exit."): void {
    this.engine.applyOrders([
      {
        type: "order_evacuation",
        zone_id: this.inputs.area.zones[zone].id,
        exit_id: exitId,
        reason,
      },
    ]);
  }

  /** Stage a zone behind another; false when the engine rejects it. */
  private stage(zone: number, exitId: string, after: number): boolean {
    const { zones } = this.inputs.area;
    const [outcome] = this.engine.applyOrders([
      {
        type: "stage_evacuation",
        zone_id: zones[zone].id,
        exit_id: exitId,
        after_zone_id: zones[after].id,
        reason: "Studio plan: leave in a later wave.",
      },
    ]);
    return outcome.accepted;
  }

  /**
   * The first order under a plan. Zones are ordered in index order (as without a plan), then
   * planned waves are staged once their predecessor is ordered or staged. A wave whose
   * predecessor is cut off, overrun, part of a loop, or that the engine will not stage is
   * ordered directly.
   */
  private applyPlan(plan: EvacuationPlan): void {
    const { engine } = this;
    const { zones } = this.inputs.area;
    const zoneIndex = new Map(zones.map((zone, index) => [zone.id, index]));
    const waves = new Map<number, { exitId: string; after: number }>();
    for (const zone of engine.zones) {
      if (zone.status !== "no_order") continue;
      const id = zones[zone.index].id;
      const exitId = this.bestExit(zone.index, plan.exits[id]);
      if (!exitId) {
        this.cutOff.add(zone.index);
        continue;
      }
      const afterId = plan.after[id];
      const after = afterId === undefined ? undefined : zoneIndex.get(afterId);
      if (after !== undefined && after !== zone.index) {
        waves.set(zone.index, { exitId, after });
        continue;
      }
      this.order(zone.index, exitId, "Studio plan: planned exit.");
      this.initialOrders.set(zone.index, { exitId, after: null });
    }
    // Stage in dependency order: a wave waits until its predecessor has been placed.
    while (waves.size > 0) {
      let placed = false;
      for (const [index, wave] of waves) {
        if (waves.has(wave.after)) continue;
        waves.delete(index);
        placed = true;
        const before = engine.zones[wave.after];
        const ready = before.status === "ordered" || before.stage !== null;
        if (ready && this.stage(index, wave.exitId, wave.after)) {
          this.initialOrders.set(index, { exitId: wave.exitId, after: wave.after });
        } else {
          this.order(index, wave.exitId, "Studio plan: planned exit.");
          this.initialOrders.set(index, { exitId: wave.exitId, after: null });
        }
      }
      if (placed) continue;
      // Only loops are left: order them directly.
      for (const [index, wave] of waves) {
        this.order(index, wave.exitId, "Studio plan: planned exit.");
        this.initialOrders.set(index, { exitId: wave.exitId, after: null });
      }
      waves.clear();
    }
  }

  private applyPolicy(): void {
    this.applyOrderPolicy();
    this.assignCrews();
  }

  /** Crews that left the fire and have nothing useful to do. */
  private idleCrews(): UnitState[] {
    const { engine } = this;
    const idle: UnitState[] = [];
    for (const crew of this.inputs.crews ?? []) {
      if (engine.minute < crew.leaveMinute) continue;
      let unit = this.crewUnits.get(crew.id);
      if (!unit) {
        unit = engine.addUnit(crew.id, "studio-crew", this.pullBackNode(crew.node), crew.homeNode);
        this.crewUnits.set(crew.id, unit);
      }
      const done =
        unit.status === "on_scene" &&
        unit.zone !== null &&
        (engine.zones[unit.zone].status !== "ordered" || leavingAtHome(engine, unit.zone) === 0);
      if (unit.status === "available" || unit.status === "returning" || done) idle.push(unit);
    }
    return idle;
  }

  /**
   * Where a crew leaving the fire starts: its road point when a zone still evacuating can be
   * reached from there avoiding fire and closures; otherwise the nearest node that can (it pulls
   * back to open roads first).
   */
  private pullBackNode(node: number): number {
    const { area } = this.inputs;
    const blocked = this.engine.blockedAt(this.engine.minute);
    // Nodes that can drive to such a zone: a search from their loading nodes along open arcs,
    // reversed.
    const into: number[][] = area.nodes.map(() => []);
    area.outgoing.forEach((arcs, from) => {
      for (const arc of arcs) if (!blocked(arc.edge)) into[arc.head].push(from);
    });
    const reaches = new Uint8Array(area.nodes.length);
    const queue = this.engine.zones
      .filter((zone) => zone.status !== "cleared" && zone.status !== "overrun")
      .map((zone) => area.zones[zone.index].node);
    for (const start of queue) reaches[start] = 1;
    for (let i = 0; i < queue.length; i += 1) {
      for (const from of into[queue[i]]) {
        if (!reaches[from]) {
          reaches[from] = 1;
          queue.push(from);
        }
      }
    }
    if (reaches[node]) return node;
    let best = node;
    let bestMeters = Infinity;
    area.nodes.forEach((point, candidate) => {
      if (!reaches[candidate]) return;
      const meters = groundMeters(point, area.nodes[node]);
      if (meters < bestMeters) {
        best = candidate;
        bestMeters = meters;
      }
    });
    return best;
  }

  private assignCrews(): void {
    const { engine } = this;
    const crews = this.inputs.crews ?? [];
    if (crews.length === 0) return;
    const fresh = crews.some((crew) => crew.leaveMinute === engine.minute);
    if (!fresh && engine.minute % CREW_REVIEW_MINUTES !== 0) return;
    const idle = this.idleCrews();
    if (idle.length === 0) return;
    const { zoneContact, zoneCore } = engine.exposure;
    const helpers = new Map<number, number>();
    for (const unit of engine.units) {
      if (unit.task === "evacuation_support" && unit.zone !== null && !idle.includes(unit)) {
        helpers.set(unit.zone, (helpers.get(unit.zone) ?? 0) + 1);
      }
    }
    for (const unit of idle) {
      const candidates = engine.zones
        .filter(
          (zone) =>
            zone.status === "ordered" &&
            leavingAtHome(engine, zone.index) > 0 &&
            zone.index !== unit.zone &&
            zoneCore[zone.index] > engine.minute + CREW_ZONE_MARGIN_MINUTES,
        )
        .sort(
          (a, b) =>
            (helpers.get(a.index) ?? 0) - (helpers.get(b.index) ?? 0) ||
            zoneContact[a.index] - zoneContact[b.index] ||
            leavingAtHome(engine, b.index) - leavingAtHome(engine, a.index) ||
            a.index - b.index,
        )
        .slice(0, CREW_ZONE_TRIES);
      for (const zone of candidates) {
        const [outcome] = engine.applyOrders([
          {
            type: "dispatch_unit",
            unit_id: unit.id,
            zone_id: this.inputs.area.zones[zone.index].id,
            task: "evacuation_support",
            reason: "Studio policy: crews overwhelmed by the fire help the evacuation.",
          },
        ]);
        if (outcome.accepted) {
          helpers.set(zone.index, (helpers.get(zone.index) ?? 0) + 1);
          break;
        }
      }
    }
  }

  private applyOrderPolicy(): void {
    const { engine } = this;
    if (engine.minute < this.inputs.orderMinute) return;
    if (!this.ordered) {
      this.ordered = true;
      if (this.inputs.plan) {
        this.applyPlan(this.inputs.plan);
        return;
      }
      for (const zone of engine.zones) {
        if (zone.status !== "no_order") continue;
        const exitId = this.bestExit(zone.index);
        if (exitId) {
          this.order(zone.index, exitId);
          this.initialOrders.set(zone.index, { exitId, after: null });
        } else this.cutOff.add(zone.index);
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

/** Households of a zone still at home that will leave (those staying home excluded). */
function leavingAtHome(engine: DispatchEngine, zone: number): number {
  return engine.zones[zone].atHome - engine.stayingHomes(zone);
}

/** Households of zones waiting for their wave (staged, no order yet). */
function stagedAtHome(run: EvacuationPolicyRun): number {
  let homes = 0;
  for (const zone of run.engine.zones) if (zone.stage) homes += zone.atHome;
  return homes;
}

/** Run the policy to the horizon and summarise it. */
export function simulateEvacuation(inputs: EvacuationInputs): EvacuationSummary {
  return runEvacuation(inputs).summary;
}

/** Run the policy to the horizon; the summary plus the finished run (for its first orders). */
export function runEvacuation(inputs: EvacuationInputs): {
  run: EvacuationPolicyRun;
  summary: EvacuationSummary;
} {
  const run = new EvacuationPolicyRun(inputs);
  const totalsByMinute: Totals[] = [run.engine.totals()];
  const zoneOrderMinutes: (number | null)[] = run.engine.zones.map(() => null);
  const noteOrders = () =>
    run.engine.zones.forEach((zone, i) => {
      if (zoneOrderMinutes[i] === null) zoneOrderMinutes[i] = zone.orderedMinute;
    });
  noteOrders();
  let evacuatingMinutes = 0;
  while (!run.finished) {
    run.step();
    noteOrders();
    const totals = run.engine.totals();
    totalsByMinute.push(totals);
    evacuatingMinutes += totals.waiting + totals.onRoad + stagedAtHome(run);
  }
  const { area } = inputs;
  const zones = run.engine.zones;
  let cutOffHomes = 0;
  for (const zone of run.cutOff) cutOffHomes += area.zones[zone].homes;
  let allClearMinute: number | null = null;
  const orderedZones = zones.filter((zone) => zone.orderRank !== null);
  // A planned wave that never got its order (still staged, or no exit left at release) has
  // households at home: not all clear.
  const wavesLeft = [...run.initialOrders].some(
    ([index, initial]) => initial.after !== null && zones[index].status === "no_order",
  );
  if (
    orderedZones.length > 0 &&
    !wavesLeft &&
    orderedZones.every((zone) => zone.status !== "ordered")
  ) {
    allClearMinute = Math.max(
      inputs.orderMinute,
      ...orderedZones.map((zone) => zone.clearedMinute ?? inputs.orderMinute),
    );
  }
  return {
    run,
    summary: {
      totalsByMinute,
      final: totalsByMinute[totalsByMinute.length - 1],
      cutOffZones: run.cutOff.size,
      cutOffHomes,
      cutOffZoneIndices: [...run.cutOff],
      zoneOrderMinutes,
      allClearMinute,
      householdHoursEvacuating: evacuatingMinutes / 60,
      stagedHomes: stagedAtHome(run),
    },
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

  /** Zones the policy found no exit for at the order minute. */
  get cutOff(): ReadonlySet<number> {
    return this.run.cutOff;
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
