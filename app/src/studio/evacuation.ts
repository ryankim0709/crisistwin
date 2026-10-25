/**
 * Evacuation for Simulation Studio: the dispatch engine (dispatch/engine.ts) run under a fixed,
 * visible policy instead of the AI dispatcher, so a planner can close roads and bridges and see
 * what that does to the evacuation. The fire is the studio run's arrival field; closures never
 * change it. See docs/adr/0018-road-closures.md.
 *
 * Households leave on the engine's uniform departure spread, or, with `departureDelays`
 * (population/householdBehavior.ts, seeded per home), on their own triggers: the order, the fire
 * reaching their zone, or the fire coming close to the house; some stay home by choice.
 *
 * What the policy knows (`fireKnowledge`, studio/fireKnowledge.ts): only fires that have been
 * reported (ignition + the response/report.ts call-in delay), each with its predicted spread
 * from the run's arrival field. Before the first report it orders nobody (trigger mode). Without
 * `fireKnowledge` (hand-built inputs) it reads the full field: perfect foresight, not used by
 * the pages.
 *
 * Policy (deterministic; the only randomness is the seeded household draw). Two order modes.
 *
 * Threat-based triggers (default, `orderMinute` null). A fire does not by itself mean everyone
 * must leave: a zone is ordered only when the fire threatens it, after the evacuation trigger
 * of Cova, Dennison, Kim & Moritz (2005), "Setting wildfire evacuation trigger points using
 * fire spread modeling and GIS", Transactions in GIS 9(4):603-617 (also Dennison, Cova &
 * Moritz 2007, "WUIVAC: a wildland-urban interface evacuation trigger model applied in
 * strategic wildfire scenarios", Natural Hazards 41:181-199): order a population when the fire
 * is no farther away, in time, than the time it needs to get out plus a safety buffer. The
 * papers find that point by reverse fire spread from the community; here the fire's time to a
 * zone is read forward from the known fire's arrival field (`zoneContact` of the reported fires):
 * - "Leave now" (`order_evacuation`) once zoneContact − now ≤ time to clear = departure delay
 *   (`clearDepartureMinutes`, + WAKE_UP_MINUTES when the order would go out in sleeping hours)
 *   + free-flow drive to the zone's chosen exit (dispatch routing) + TRIGGER_SAFETY_BUFFER_MINUTES.
 * - "Get ready" (a warning; households stay home) once zoneContact − now ≤ time to clear +
 *   GET_READY_LEAD_MINUTES.
 * - A zone the known fire never reaches within the run gets no order and stays home (not
 *   threatened). Households there may still leave on their own fire cues (engine).
 * - Triggers are re-checked every TRIGGER_REVIEW_MINUTES; orders only escalate (none → get
 *   ready → leave now).
 *
 * Order everyone (manual override, `orderMinute` a number; the earlier policy): at
 * `orderMinute` every zone the fire has not overrun is ordered at once.
 *
 * Both modes:
 * - Exit choice. Among the exits a zone can reach (routes avoid closed edges and edges the fire
 *   reaches within the engine's routing lookahead), each is scored on the known fire:
 *   (1) safe: the route's time margin, the smallest (known fire arrival on an edge − time the
 *   zone's last leaving household clears that edge, departing after its time to clear and
 *   driving at free flow), is at least TRIGGER_SAFETY_BUFFER_MINUTES, and the known fire never
 *   reaches the exit's shelter within the run; (2) away: the exit's bearing from the zone is at
 *   least EXIT_AWAY_MIN_DEGREES off the bearing to the nearest burning known cell; then (3) the
 *   fastest. With no safe exit, the one with the largest margin. The reason text says which.
 *   Every TRIGGER_REVIEW_MINUTES an ordered zone with households still to leave is redirected
 *   when its exit is no longer safe and a safe one is reachable (a newly reported fire, or the
 *   fire heading for its shelter).
 * - An optional plan (`EvacuationPlan`, built by studio/evacuationOptimizer.ts) changes only a
 *   zone's first order: a planned zone goes to its planned exit when it is reachable and safe
 *   then (else the scored choice), and a zone planned to wait is staged behind its predecessor
 *   (the engine's staged waves) instead of being ordered at once. Everything after is the same.
 * - A zone with no reachable exit when its order would go out (the order minute, or its leave
 *   trigger) is "cut off": it is never ordered. Closures last the whole run and fire only
 *   blocks more edges over time, so it cannot become reachable again.
 * - When an ordered zone's route is cut by fire, it is re-ordered the same minute to its best
 *   reachable exit; with none left its departures stay held (engine behaviour).
 * - Firefighters overwhelmed by the fire (studio/crewHandoff.ts) join at their leave minute and
 *   go on evacuation support, which shortens a zone's departure spread while they are on scene.
 *   A crew whose road point the fire has already cut off from every zone still evacuating pulls
 *   back to the nearest node that can reach one.
 *   Every CREW_REVIEW_MINUTES an idle crew (just arrived from the fire, withdrawn, or in a zone
 *   that has cleared) goes to the ordered zone with the fewest crews, then the earliest fire
 *   contact, then the most households still at home, skipping zones the fire is about to reach.
 */

import { groundMeters, type DispatchArea, type LonLat } from "../dispatch/area";
import {
  DEFAULT_CHECK_INTERVAL_MINUTES,
  DEPARTURE_SPREAD_MINUTES,
  DispatchEngine,
  FORECAST_LOOKAHEAD_MINUTES,
  UNIT_WITHDRAW_MARGIN_MINUTES,
  type Totals,
  type UnitState,
} from "../dispatch/engine";
import type { FireExposure } from "../dispatch/fireExposure";
import { edgeSeconds, evacueeTree, routeTo, type Route } from "../dispatch/routing";
import { lonLatToMercator } from "../fire/landscape";
import { WAKE_UP_MINUTES, type HouseholdBehavior } from "../population/householdBehavior";
import type { EvacuationCrew } from "./crewHandoff";
import {
  bearingDifference,
  knownArrivalAt,
  knownFireAt,
  mercatorBearing,
  nearestKnownFire,
  type FireKnowledge,
  type KnownFire,
} from "./fireKnowledge";

/** Manual override: minutes after T+0 at which every zone is ordered ("Order everyone at"). */
export const ORDER_MINUTE_CHOICES = [0, 15, 30, 60] as const;
/** Null: threat-based trigger orders (Cova et al. 2005); a number orders everyone then. */
export const DEFAULT_ORDER_MINUTE: number | null = null;

/**
 * Trigger re-check interval, simulated minutes. ASSUMPTION (no source): the dispatch engine's
 * default check interval, so the policy reviews as often as the AI dispatcher would.
 */
export const TRIGGER_REVIEW_MINUTES = DEFAULT_CHECK_INTERVAL_MINUTES;
/**
 * Safety buffer added to a zone's time to clear, minutes; also the smallest route time margin
 * that counts an exit as safe. ASSUMPTION: Cova et al. (2005) and Dennison et al. (2007) add a
 * safety margin to the evacuation time when setting a trigger but leave its size to the
 * incident; 15 min is a placeholder, not a published value.
 */
export const TRIGGER_SAFETY_BUFFER_MINUTES = 15;
/**
 * "Get ready" lead beyond the leave trigger, minutes. ASSUMPTION (no published lead): the
 * staged warning of Li, Cova & Dennison (2015), "A household-level approach to staging wildfire
 * evacuation warnings using trigger modeling", Computers, Environment and Urban Systems
 * 54:56-67, sized to the engine's FORECAST_LOOKAHEAD_MINUTES "threatened" window (60 min).
 */
export const GET_READY_LEAD_MINUTES = FORECAST_LOOKAHEAD_MINUTES;
/**
 * Share of a zone's households leaving on the order that must be gone for it to count as
 * clear, used to read the departure delay off the household delays. ASSUMPTION (no source):
 * 0.9. The slowest 10% are not planned for by the trigger; they leave on their fire cues
 * (population/householdBehavior.ts). The delays themselves are sourced.
 */
export const CLEAR_DELAY_QUANTILE = 0.9;
/**
 * An exit counts as "away from the fire" when its bearing from the zone is at least this far
 * off the bearing to the nearest burning (known) cell. ASSUMPTION: 90 degrees, the half-plane
 * facing away from the fire; a geometric rule, not a published value.
 */
export const EXIT_AWAY_MIN_DEGREES = 90;
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
   * or unsafe at order time, get the scored choice.
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
  /** The full modelled fire: what residents see and what catches them. */
  exposure: FireExposure;
  horizonMinutes: number;
  /** Edge indices closed to traffic for the whole run. */
  closedEdges: ReadonlySet<number>;
  /**
   * Manual override: minute every zone is ordered ("Order everyone at T+…"). Null: threat-based
   * trigger orders per zone (the default).
   */
  orderMinute: number | null;
  /** Firefighters who leave the fire to support the evacuation (none when omitted). */
  crews?: readonly EvacuationCrew[];
  /** Planned exits and waves; the default policy when omitted. */
  plan?: EvacuationPlan;
  /**
   * Per-household behaviour (population/householdBehavior.ts: order and cue delays, staying
   * by choice); the engine's uniform departure spread when omitted.
   */
  departureDelays?: HouseholdBehavior;
  /**
   * The run's fires and their report minutes: the policy acts only on reported fires. Omitted:
   * perfect foresight of the full field (hand-built inputs only).
   */
  fireKnowledge?: FireKnowledge;
  /** T+0 as UTC epoch ms, for sleeping hours (households and night orders); none: always day. */
  startEpochMs?: number;
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
  /** Per zone, the minute it was first told to get ready (trigger mode), or null. */
  zoneWarnMinutes: (number | null)[];
  /** Zones (and their homes) never warned, ordered nor cut off over the run: not threatened. */
  unthreatenedZones: number;
  unthreatenedHomes: number;
  /** Minute the first fire was reported to the policy, or null (none, or no fire knowledge). */
  firstReportMinute?: number | null;
}

/**
 * Minutes from a zone's order until CLEAR_DELAY_QUANTILE of its households leaving on the order
 * have left: that quantile of the finite per-household order delays
 * (population/householdBehavior.ts), or of the engine's uniform 0..DEPARTURE_SPREAD_MINUTES
 * spread without them.
 */
export function clearDepartureMinutes(departureDelays?: HouseholdBehavior): number {
  if (!departureDelays) return DEPARTURE_SPREAD_MINUTES * CLEAR_DELAY_QUANTILE;
  const finite = Array.from(departureDelays.orderDelayMinutes)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  return finite[Math.min(finite.length - 1, Math.floor(CLEAR_DELAY_QUANTILE * finite.length))];
}

/** What the policy did with a zone at its first order. */
export interface InitialOrder {
  /** Exit it was ordered (or staged) to. */
  exitId: string;
  /** Zone index it was staged behind, or null when ordered directly. */
  after: number | null;
}

/** One reachable exit as the policy scored it. */
interface ExitChoice {
  id: string;
  /** Free-flow drive from the zone's loading node, seconds. */
  seconds: number;
  /** Smallest known-fire time margin along the route, minutes (Infinity: none reaches it). */
  marginMinutes: number;
  /** The known fire reaches the exit's shelter within the run. */
  shelterBurns: boolean;
  safe: boolean;
  /** Degrees between the exit's bearing and the fire's, or null when no fire burns yet. */
  offFireDegrees: number | null;
  away: boolean;
}

export class EvacuationPolicyRun {
  readonly inputs: EvacuationInputs;
  readonly engine: DispatchEngine;
  /** Zone indices the policy found no exit for. */
  readonly cutOff = new Set<number>();
  /** Zone index → what it was told at its first order (cut-off zones are absent). */
  readonly initialOrders = new Map<number, InitialOrder>();
  /** Trigger mode: zone index → minute it was told to get ready. */
  readonly warned = new Map<number, number>();
  /**
   * Zones not (yet) warned, ordered nor cut off: in trigger mode, still home because the fire
   * does not threaten them. Emptied in "order everyone" mode once the order is out.
   */
  readonly quiet = new Set<number>();
  /** Departure part of every zone's time to clear, minutes (day; see `clearMinutesAt`). */
  readonly clearDepartMinutes: number;
  /** Minute the first fire was reported to the policy, or null so far. */
  firstReportMinute: number | null = null;
  /** Per zone, free-flow drive to its fastest exit avoiding closures only, minutes. */
  private driveFloorMinutes: Float64Array | null = null;
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
    if (inputs.departureDelays) this.engine.setHouseholdBehavior(inputs.departureDelays);
    this.engine.setClock(inputs.startEpochMs ?? null);
    this.clearDepartMinutes = clearDepartureMinutes(inputs.departureDelays);
    for (const zone of this.engine.zones) this.quiet.add(zone.index);
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
   * The fire the policy knows now: reported fires only (studio/fireKnowledge.ts), or the full
   * field without fire knowledge; null while nothing has been reported.
   */
  private known(): { exposure: FireExposure; fire: KnownFire | null } | null {
    const { fireKnowledge, area, exposure } = this.inputs;
    if (!fireKnowledge) return { exposure, fire: null };
    const fire = knownFireAt(fireKnowledge, area, this.engine.minute);
    if (!fire) return null;
    if (this.firstReportMinute === null) this.firstReportMinute = this.engine.minute;
    return { exposure: fire.exposure, fire };
  }

  /** Departure part of the time to clear for an order going out now (+ wake-up at night). */
  private clearMinutesNow(): number {
    const night = this.inputs.departureDelays && this.engine.asleepAt(this.engine.minute);
    return this.clearDepartMinutes + (night ? WAKE_UP_MINUTES : 0);
  }

  /**
   * `preferred` when it is reachable and safe from the zone's loading node right now, else the
   * scored best reachable exit (see the module comment), or null.
   */
  private bestExit(zone: number, preferred?: string): string | null {
    return this.bestRoute(zone, preferred)?.id ?? null;
  }

  /** Every exit reachable from the zone now, scored on the known fire. */
  private scoreExits(zone: number): ExitChoice[] {
    const { area, fireKnowledge, horizonMinutes } = this.inputs;
    const now = this.engine.minute;
    const tree = evacueeTree(area, area.zones[zone].node, this.engine.blockedAt(now));
    const known = this.known();
    const departMinute = now + this.clearMinutesNow();
    const nearest =
      known?.fire ? nearestKnownFire(known.fire, area.zones[zone].centroid, now) : null;
    const [zx, zy] = lonLatToMercator(area.zones[zone].centroid[0], area.zones[zone].centroid[1]);
    const choices: ExitChoice[] = [];
    for (const exit of area.exits) {
      const route = routeTo(area, tree, exit.node);
      if (!route) continue;
      const marginMinutes = known ? routeMarginMinutes(area, route, known.exposure, departMinute) : Infinity;
      const shelterBurns =
        !!known?.fire &&
        !!fireKnowledge &&
        !!exit.destination &&
        knownArrivalAt(fireKnowledge, known.fire, exit.destination.location) <= horizonMinutes;
      const [ex, ey] = lonLatToMercator(area.nodes[exit.node][0], area.nodes[exit.node][1]);
      const offFireDegrees = nearest
        ? bearingDifference(mercatorBearing(zx, zy, ex, ey), nearest.bearingDegrees)
        : null;
      choices.push({
        id: exit.id,
        seconds: route.seconds,
        marginMinutes,
        shelterBurns,
        safe: marginMinutes >= TRIGGER_SAFETY_BUFFER_MINUTES && !shelterBurns,
        offFireDegrees,
        away: offFireDegrees === null || offFireDegrees >= EXIT_AWAY_MIN_DEGREES,
      });
    }
    return choices;
  }

  /** As `bestExit`, with the chosen route's free-flow drive time (seconds) and a reason. */
  private bestRoute(
    zone: number,
    preferred?: string,
  ): { id: string; seconds: number; note: string } | null {
    const choices = this.scoreExits(zone);
    if (preferred !== undefined) {
      const planned = choices.find((choice) => choice.id === preferred);
      if (planned && planned.safe) return { ...planned, note: "planned exit" };
    }
    const best = pickExit(choices);
    return best ? { id: best.id, seconds: best.seconds, note: exitNote(best) } : null;
  }

  /**
   * Per zone, free-flow minutes to its fastest exit with closures only (0 when none). Fire only
   * removes roads, so this is a lower bound on the drive at any minute.
   */
  private driveFloor(): Float64Array {
    if (this.driveFloorMinutes) return this.driveFloorMinutes;
    const { area, closedEdges } = this.inputs;
    const floor = new Float64Array(area.zones.length);
    const blocked = (edge: number) => closedEdges.has(edge);
    area.zones.forEach((zone, index) => {
      const tree = evacueeTree(area, zone.node, blocked);
      let best = Infinity;
      for (const exit of area.exits) {
        const route = routeTo(area, tree, exit.node);
        if (route) best = Math.min(best, route.seconds / 60);
      }
      floor[index] = Number.isFinite(best) ? best : 0;
    });
    this.driveFloorMinutes = floor;
    return floor;
  }

  /**
   * Trigger mode (Cova et al. 2005): warn or order each zone whose known fire arrival is within
   * its time to clear (+ the get-ready lead). Orders only escalate. Nothing before the first
   * fire is reported.
   */
  private applyTriggers(): void {
    const { engine } = this;
    const { area, plan } = this.inputs;
    const known = this.known();
    if (!known) return;
    const minute = engine.minute;
    const floor = this.driveFloor();
    const zoneIndex = plan ? new Map(area.zones.map((zone, index) => [zone.id, index])) : null;
    const fixedMinutes = this.clearMinutesNow() + TRIGGER_SAFETY_BUFFER_MINUTES;
    for (const zone of engine.zones) {
      if (zone.status !== "no_order" || zone.stage !== null || this.cutOff.has(zone.index)) {
        this.quiet.delete(zone.index);
        continue;
      }
      const leadMinutes = known.exposure.zoneContact[zone.index] - minute;
      if (!Number.isFinite(leadMinutes)) continue; // the known fire never reaches it in this run
      if (leadMinutes > fixedMinutes + floor[zone.index] + GET_READY_LEAD_MINUTES) continue;
      const id = area.zones[zone.index].id;
      const route = this.bestRoute(zone.index, plan?.exits[id]);
      const clearMinutes = fixedMinutes + (route ? route.seconds / 60 : floor[zone.index]);
      if (leadMinutes > clearMinutes + GET_READY_LEAD_MINUTES) continue;
      this.quiet.delete(zone.index);
      if (leadMinutes > clearMinutes) {
        if (!this.warned.has(zone.index)) this.warned.set(zone.index, minute);
        continue;
      }
      if (!route) {
        this.cutOff.add(zone.index);
        continue;
      }
      const afterId = plan?.after[id];
      const after = afterId === undefined ? undefined : zoneIndex?.get(afterId);
      if (after !== undefined && after !== zone.index) {
        const before = engine.zones[after];
        const ready = before.status === "ordered" || before.stage !== null;
        if (ready && this.stage(zone.index, route.id, after)) {
          this.initialOrders.set(zone.index, { exitId: route.id, after });
          continue;
        }
      }
      this.order(
        zone.index,
        route.id,
        plan
          ? `Studio plan: fire within the zone's evacuation trigger; ${route.note}.`
          : `Studio policy: fire within the zone's evacuation trigger; ${route.note}.`,
      );
      this.initialOrders.set(zone.index, { exitId: route.id, after: null });
    }
  }

  private order(zone: number, exitId: string, reason: string): void {
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
    const { orderMinute } = this.inputs;
    if (orderMinute === null) {
      if (engine.minute % TRIGGER_REVIEW_MINUTES === 0) {
        this.applyTriggers();
        this.redirectUnsafe();
      }
      this.reroute();
      return;
    }
    if (engine.minute < orderMinute) return;
    if (!this.ordered) {
      this.ordered = true;
      this.quiet.clear();
      if (this.inputs.plan) {
        this.applyPlan(this.inputs.plan);
        return;
      }
      for (const zone of engine.zones) {
        if (zone.status !== "no_order") continue;
        const best = this.bestRoute(zone.index);
        if (best) {
          this.order(zone.index, best.id, `Studio policy: ${best.note}.`);
          this.initialOrders.set(zone.index, { exitId: best.id, after: null });
        } else this.cutOff.add(zone.index);
      }
      return;
    }
    if (engine.minute % TRIGGER_REVIEW_MINUTES === 0) this.redirectUnsafe();
    this.reroute();
  }

  /** Re-order each ordered zone whose route the fire cut to its best exit still open. */
  private reroute(): void {
    const { engine } = this;
    for (const zone of engine.zones) {
      if (zone.status !== "ordered" || !zone.routeBlocked || this.stranded.has(zone.index))
        continue;
      const best = this.bestRoute(zone.index);
      if (best) this.order(zone.index, best.id, `Studio policy: route cut; ${best.note}.`);
      else this.stranded.add(zone.index);
    }
  }

  /**
   * Redirect ordered zones with households still to leave whose exit is no longer safe on the
   * known fire (its route margin or its shelter), when a safe exit is reachable.
   */
  private redirectUnsafe(): void {
    const { engine } = this;
    for (const zone of engine.zones) {
      if (zone.status !== "ordered" || zone.routeBlocked || !zone.exitId) continue;
      if (leavingAtHome(engine, zone.index) + zone.queued === 0) continue;
      const choices = this.scoreExits(zone.index);
      const current = choices.find((choice) => choice.id === zone.exitId);
      if (!current || current.safe) continue;
      const best = pickExit(choices);
      if (!best || !best.safe || best.id === zone.exitId) continue;
      this.order(
        zone.index,
        best.id,
        `Studio policy: ${zone.exitId} is no longer safe (${exitNote(current)}); ${exitNote(best)}.`,
      );
    }
  }
}

/**
 * The smallest time margin along a route, minutes: per edge, the known fire's arrival on it
 * minus the minute a household leaving at `departMinute` has driven it at free flow.
 */
export function routeMarginMinutes(
  area: DispatchArea,
  route: Route,
  exposure: FireExposure,
  departMinute: number,
): number {
  let clock = departMinute;
  let margin = Infinity;
  for (const step of route.steps) {
    clock += edgeSeconds(area, step.edge) / 60;
    margin = Math.min(margin, exposure.edgeArrival[step.edge] - clock);
  }
  return margin;
}

/** Safe first, then away from the fire, then fastest; with no safe exit, the largest margin. */
function pickExit(choices: readonly ExitChoice[]): ExitChoice | null {
  let best: ExitChoice | null = null;
  for (const choice of choices) {
    if (!best) {
      best = choice;
      continue;
    }
    if (choice.safe !== best.safe) {
      if (choice.safe) best = choice;
      continue;
    }
    if (!choice.safe) {
      if (choice.marginMinutes > best.marginMinutes) best = choice;
      continue;
    }
    if (choice.away !== best.away) {
      if (choice.away) best = choice;
      continue;
    }
    if (choice.seconds < best.seconds) best = choice;
  }
  return best;
}

/** Plain-language reason for an exit choice. */
function exitNote(choice: ExitChoice): string {
  const minutes = Math.round(choice.seconds / 60);
  if (!choice.safe) {
    if (choice.shelterBurns) return `the fire is forecast to reach its shelter (${minutes} min drive)`;
    return Number.isFinite(choice.marginMinutes)
      ? `no exit is safe; ${choice.id} keeps the most time ahead of the fire (${Math.round(choice.marginMinutes)} min)`
      : `no exit is safe; ${choice.id}`;
  }
  const dir =
    choice.offFireDegrees === null
      ? "no fire burning yet"
      : choice.away
        ? `away from the fire (${Math.round(choice.offFireDegrees)}° off its bearing)`
        : `no safe exit leads away from the fire (${Math.round(choice.offFireDegrees)}° off its bearing)`;
  const margin = Number.isFinite(choice.marginMinutes)
    ? `${Math.round(choice.marginMinutes)} min ahead of the fire on the route`
    : "fire not forecast on the route";
  return `${dir}, ${margin}, ${minutes} min drive`;
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
  let unthreatenedHomes = 0;
  for (const zone of run.quiet) unthreatenedHomes += area.zones[zone].homes;
  const firstOrderMinute = inputs.orderMinute ?? 0;
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
      firstOrderMinute,
      ...orderedZones.map((zone) => zone.clearedMinute ?? firstOrderMinute),
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
      zoneWarnMinutes: zones.map((zone) => run.warned.get(zone.index) ?? null),
      unthreatenedZones: run.quiet.size,
      unthreatenedHomes,
      firstReportMinute: run.firstReportMinute,
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

  /** Zones the policy found no exit for when their order would have gone out. */
  get cutOff(): ReadonlySet<number> {
    return this.run.cutOff;
  }

  /** Zones not warned, ordered nor cut off so far (trigger mode: not threatened). */
  get quiet(): ReadonlySet<number> {
    return this.run.quiet;
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
  point: LonLat,
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
