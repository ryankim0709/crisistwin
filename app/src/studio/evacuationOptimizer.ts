/**
 * Evacuation strategy search for Simulation Studio: given the planner's closures, the fire run,
 * crews and order minute, try other exits and staged waves for the zones and keep the plan the
 * dispatch engine scores best. Every candidate is a full engine run (studio/evacuation.ts); the
 * search only proposes plans, it never estimates an outcome. Pure and deterministic (no
 * randomness, clock or network), so it can run in a Web Worker on structured-cloned inputs.
 * See docs/adr/0027-evacuation-optimizer.md.
 *
 * Search, bounded by `maxEvaluations` engine runs (the baseline included):
 * 1. Baseline: the default policy (every zone to its fastest open exit at the order minute).
 * 2. Exit rebalancing, greedy coordinate descent. Candidate zones are those whose route at
 *    order time crosses an over-subscribed edge (zones' departure flows into it exceed its
 *    capacity, so they would split it) or an edge the fire reaches by the horizon, and that
 *    have another reachable exit. Earliest fire contact first. Each candidate tries its other
 *    exits among the EXIT_OPTIONS_PER_ZONE fastest reachable; the best is kept if it beats the
 *    current plan. At most two passes, within two thirds of the budget when waves may follow.
 * 3. Waves: from the best plan so far, a zone (latest fire contact first; zones outside the
 *    fire path first of all) is staged behind the earliest-contact zone that reaches the fire
 *    sooner and shares an over-subscribed edge with it; kept if it beats the current plan.
 * Objective: `compareSummaries`. Moves are only kept when strictly better.
 */

import { DEPARTURE_SPREAD_MINUTES, EXIT_OPTIONS_PER_ZONE } from "../dispatch/engine";
import { routeTo, shortestPathTree } from "../dispatch/routing";
import {
  runEvacuation,
  type EvacuationInputs,
  type EvacuationPlan,
  type EvacuationSummary,
  type InitialOrder,
} from "./evacuation";

/** Engine runs one optimisation may spend, the baseline included. */
export const DEFAULT_MAX_EVALUATIONS = 80;
/** Household-hours closer than this count as equal. */
const HOURS_EPSILON = 1e-6;
/** An edge is over-subscribed when the flows routed over it exceed its capacity by this. */
const PRESSURE_EPSILON = 1e-9;
/** Exit-rebalancing passes over the candidate zones. */
const EXIT_PASSES = 2;
/** Share of the budget after the baseline the exit phase may use when waves may follow. */
const EXIT_BUDGET_SHARE = 2 / 3;
const SECONDS_PER_MINUTE = 60;

/** One evaluated strategy: a plan and the engine's summary of it. */
export interface StrategyCandidate {
  id: string;
  /** Short name for a table row, e.g. "Fastest exit" or "Rebalanced exits + waves". */
  label: string;
  /** One sentence on what the strategy changes. */
  description: string;
  plan: EvacuationPlan;
  summary: EvacuationSummary;
}

/** A zone whose exit or wave in the best plan differs from the fastest-exit policy. */
export interface ZonePlanChange {
  zoneId: string;
  zoneName: string;
  homes: number;
  /** Exit the default policy orders it to at order time; null when it has none (cut off). */
  fastestExitId: string | null;
  /** Exit in the best plan. */
  exitId: string | null;
  /** Zone it waits behind in the best plan, or null. */
  afterZoneId: string | null;
}

export interface EvacuationOptimization {
  /** The default policy (fastest open exit) under the same closures and order minute. */
  baseline: StrategyCandidate;
  /** Best by `compareSummaries`; the baseline when nothing beat it. */
  best: StrategyCandidate;
  /**
   * Strategies kept for display (at most four), best first: the baseline, the rebalanced
   * exits and the plan with waves when the search adopted them, and the best change it tried
   * but rejected.
   */
  tried: StrategyCandidate[];
  changes: ZonePlanChange[];
  /** Engine runs spent. */
  evaluations: number;
  /** True when `best` is strictly better than `baseline`. */
  improved: boolean;
}

export interface OptimizeOptions {
  /** At least 1 (the baseline is always run). */
  maxEvaluations?: number;
  /**
   * Called after each engine run. `total` is an upper bound on the runs this search will make;
   * it can shrink once a phase knows how many moves it has.
   */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Objective ordering: negative when `a` is better than `b`. Lexicographic: fewer households
 * caught, then more reached an exit, then fewer household-hours evacuating, then an earlier
 * all-clear (null = not by horizon, worst).
 */
export function compareSummaries(a: EvacuationSummary, b: EvacuationSummary): number {
  if (a.final.caught !== b.final.caught) return a.final.caught - b.final.caught;
  if (a.final.safe !== b.final.safe) return b.final.safe - a.final.safe;
  const hours = a.householdHoursEvacuating - b.householdHoursEvacuating;
  if (Math.abs(hours) > HOURS_EPSILON) return hours;
  if (a.allClearMinute === b.allClearMinute) return 0;
  if (a.allClearMinute === null) return 1;
  if (b.allClearMinute === null) return -1;
  return a.allClearMinute - b.allClearMinute;
}

/** One reachable exit of a zone at the order minute. */
interface ExitOption {
  exitId: string;
  edges: number[];
  /** Vehicles per minute the zone can push onto this route: min(departures, bottleneck). */
  flow: number;
  /** The route crosses an edge the fire reaches by the horizon. */
  fireOnRoute: boolean;
}

interface Evaluated {
  plan: EvacuationPlan;
  summary: EvacuationSummary;
  initial: Map<number, InitialOrder>;
}

interface Move {
  zone: number;
  exitId?: string;
  after?: number;
}

function planKey(plan: EvacuationPlan): string {
  const exits = Object.keys(plan.exits)
    .sort()
    .map((zone) => `${zone}>${plan.exits[zone]}`);
  const after = Object.keys(plan.after)
    .sort()
    .map((zone) => `${zone}<${plan.after[zone]}`);
  return `${exits.join(",")}|${after.join(",")}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Search exits and waves for the inputs' closures and fire; deterministic. */
export function optimizeEvacuation(
  inputs: EvacuationInputs,
  options: OptimizeOptions = {},
): EvacuationOptimization {
  const max = Math.max(1, Math.floor(options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS));
  const { area, exposure, horizonMinutes, orderMinute } = inputs;
  const zones = area.zones;
  const contact = (zone: number) => exposure.zoneContact[zone];
  /** Earliest fire contact first (never-reached zones last), then zone index. */
  const byContact = (a: number, b: number) =>
    contact(a) === contact(b) ? a - b : contact(a) < contact(b) ? -1 : 1;
  let evaluations = 0;
  let total = max;
  /** Every evaluated plan by key, in evaluation order, with the move that produced it. */
  const cache = new Map<string, Evaluated>();
  const moveOf = new Map<Evaluated, Move>();
  const exitName = new Map(area.exits.map((exit) => [exit.id, exit.name]));

  // 1. Baseline: no plan. An empty plan behaves identically, so it shares the cache entry.
  const emptyPlan: EvacuationPlan = { exits: {}, after: {} };
  const baselineRun = runEvacuation({ ...inputs, plan: undefined });
  evaluations += 1;
  const baseline: Evaluated = {
    plan: emptyPlan,
    summary: baselineRun.summary,
    initial: baselineRun.run.initialOrders,
  };
  cache.set(planKey(emptyPlan), baseline);
  options.onProgress?.(evaluations, total);

  // Exit options at the order minute, fastest first: the same routing the policy uses.
  const blocked = baselineRun.run.engine.blockedAt(orderMinute);
  const exitOptions: ExitOption[][] = zones.map((zone, index) => {
    if (!baseline.initial.has(index)) return [];
    const tree = shortestPathTree(area, zone.node, blocked);
    const departures = zone.vehicles / DEPARTURE_SPREAD_MINUTES;
    return area.exits
      .map((exit) => ({ exit, route: routeTo(area, tree, exit.node) }))
      .filter((option) => option.route !== null)
      .sort((a, b) => a.route!.seconds - b.route!.seconds)
      .slice(0, EXIT_OPTIONS_PER_ZONE)
      .map(({ exit, route }) => ({
        exitId: exit.id,
        edges: route!.steps.map((step) => step.edge),
        flow: Math.min(departures, route!.bottleneckVph / SECONDS_PER_MINUTE),
        fireOnRoute: route!.steps.some((step) => exposure.edgeArrival[step.edge] <= horizonMinutes),
      }));
  });

  /** Each ordered zone's route under `state`, and the edges whose summed flow exceeds capacity. */
  const traffic = (state: Evaluated) => {
    const routeOf = new Map<number, ExitOption>();
    const load = new Map<number, number>();
    for (const [zone, initial] of state.initial) {
      const option = exitOptions[zone].find((candidate) => candidate.exitId === initial.exitId);
      if (!option) continue;
      routeOf.set(zone, option);
      for (const edge of option.edges) load.set(edge, (load.get(edge) ?? 0) + option.flow);
    }
    const pressured = (edge: number) =>
      (load.get(edge) ?? 0) >
      (area.edges[edge].capacityVph / SECONDS_PER_MINUTE) * (1 + PRESSURE_EPSILON);
    return { routeOf, pressured };
  };

  const withMove = (plan: EvacuationPlan, move: Move): EvacuationPlan => {
    const id = zones[move.zone].id;
    const exits = { ...plan.exits };
    const after = { ...plan.after };
    if (move.exitId !== undefined) {
      if (move.exitId === exitOptions[move.zone][0]?.exitId) delete exits[id];
      else exits[id] = move.exitId;
    }
    if (move.after !== undefined) after[id] = zones[move.after].id;
    return { exits, after };
  };

  /** The plan with `move` applied, run unless known; null when `limit` runs are spent. */
  const evaluate = (base: EvacuationPlan, move: Move, limit: number): Evaluated | null => {
    const plan = withMove(base, move);
    const key = planKey(plan);
    const known = cache.get(key);
    if (known) return known;
    if (evaluations >= limit) return null;
    const { run, summary } = runEvacuation({ ...inputs, plan });
    evaluations += 1;
    const result = { plan, summary, initial: run.initialOrders };
    cache.set(key, result);
    moveOf.set(result, move);
    options.onProgress?.(evaluations, Math.max(evaluations, total));
    return result;
  };

  let best = baseline;
  let exitsAdopted: Evaluated | null = null;
  let wavesAdopted: Evaluated | null = null;

  /** Zones that could stage behind another under `state`, each with its predecessor. */
  const waveMoves = (state: Evaluated): Move[] => {
    const { routeOf, pressured } = traffic(state);
    // Latest fire contact first (zones the fire never reaches first of all).
    const ordered = [...routeOf.keys()].sort((a, b) =>
      contact(a) === contact(b) ? a - b : -byContact(a, b),
    );
    const moves: Move[] = [];
    for (const zone of ordered) {
      if (state.initial.get(zone)?.after !== null) continue;
      const shared = new Set(routeOf.get(zone)!.edges.filter(pressured));
      if (shared.size === 0) continue;
      let predecessor: number | null = null;
      for (const [other, option] of routeOf) {
        if (other === zone || !(contact(other) < contact(zone))) continue;
        if (!option.edges.some((edge) => shared.has(edge))) continue;
        if (predecessor === null || byContact(other, predecessor) < 0) predecessor = other;
      }
      if (predecessor !== null) moves.push({ zone, after: predecessor });
    }
    return moves;
  };

  // 2. Exit rebalancing.
  const waveReserve = Math.min(
    Math.floor((max - 1) * (1 - EXIT_BUDGET_SHARE)),
    waveMoves(baseline).length,
  );
  const exitLimit = max - waveReserve;
  for (let pass = 0; pass < EXIT_PASSES && evaluations < exitLimit; pass += 1) {
    const { routeOf, pressured } = traffic(best);
    const candidates = [...routeOf.entries()]
      .filter(
        ([zone, option]) =>
          exitOptions[zone].length > 1 && (option.fireOnRoute || option.edges.some(pressured)),
      )
      .map(([zone]) => zone)
      .sort(byContact);
    let improvedPass = false;
    for (const zone of candidates) {
      const current = best.initial.get(zone)?.exitId;
      let zoneBest: Evaluated | null = null;
      for (const option of exitOptions[zone]) {
        if (option.exitId === current) continue;
        const state = evaluate(best.plan, { zone, exitId: option.exitId }, exitLimit);
        if (!state) break;
        if (!zoneBest || compareSummaries(state.summary, zoneBest.summary) < 0) zoneBest = state;
      }
      if (zoneBest && compareSummaries(zoneBest.summary, best.summary) < 0) {
        best = zoneBest;
        exitsAdopted = best;
        improvedPass = true;
      }
      if (evaluations >= exitLimit) break;
    }
    if (!improvedPass) break;
  }

  // 3. Waves on top of the best exits.
  const waves = waveMoves(best);
  total = Math.min(total, evaluations + waves.length);
  for (const move of waves) {
    if (evaluations >= max) break;
    // Staging behind a zone that (transitively) waits for this one would make a loop.
    const after = { ...best.plan.after };
    let cursor: string | undefined = zones[move.after!].id;
    let loop = false;
    for (let i = 0; cursor !== undefined && i <= zones.length; i += 1) {
      if (cursor === zones[move.zone].id) loop = true;
      cursor = after[cursor];
    }
    if (loop || after[zones[move.zone].id] !== undefined) continue;
    const state = evaluate(best.plan, move, max);
    if (!state) break;
    if (compareSummaries(state.summary, best.summary) < 0) {
      best = state;
      wavesAdopted = best;
    }
  }

  // The best plan tried but not adopted (first evaluated wins ties), for display.
  let rejected: Evaluated | null = null;
  for (const state of cache.values()) {
    if (state === baseline || state === best || state === exitsAdopted || state === wavesAdopted)
      continue;
    if (!rejected || compareSummaries(state.summary, rejected.summary) < 0) rejected = state;
  }

  // Results.
  const strategy = (
    id: string,
    label: string,
    description: string,
    state: Evaluated,
  ): StrategyCandidate => ({ id, label, description, plan: state.plan, summary: state.summary });

  const exitChanges = (state: Evaluated) =>
    [...state.initial].filter(
      ([zone, initial]) => initial.exitId !== baseline.initial.get(zone)?.exitId,
    ).length;
  const waveChanges = (state: Evaluated) =>
    [...state.initial.values()].filter((initial) => initial.after !== null).length;

  const baselineCandidate = strategy(
    "baseline",
    "Fastest exit (current policy)",
    `Every zone ordered at T+${orderMinute} to its fastest open exit, avoiding closures and fire.`,
    baseline,
  );
  const tried: StrategyCandidate[] = [baselineCandidate];
  if (exitsAdopted) {
    const moved = exitChanges(exitsAdopted);
    tried.push(
      strategy(
        "exits",
        "Rebalanced exits",
        `${plural(moved, "zone is", "zones are")} sent to another reachable exit to take traffic off a shared or fire-exposed road.`,
        exitsAdopted,
      ),
    );
  }
  if (wavesAdopted) {
    const moved = exitChanges(wavesAdopted);
    const staged = waveChanges(wavesAdopted);
    const waits = `${plural(staged, "zone waits", "zones wait")} for a zone the fire reaches sooner to be on the road before leaving`;
    tried.push(
      strategy(
        "waves",
        moved > 0 ? "Rebalanced exits + waves" : "Staged waves",
        moved > 0
          ? `${plural(moved, "zone is", "zones are")} sent to another exit, and ${waits}.`
          : `Fastest exits, but ${waits}.`,
        wavesAdopted,
      ),
    );
  }
  if (rejected) {
    const move = moveOf.get(rejected)!;
    const zone = zones[move.zone].name;
    const what =
      move.after !== undefined
        ? `${zone} waiting for ${zones[move.after].name}`
        : `${zone} sent to ${exitName.get(move.exitId ?? "") ?? move.exitId}`;
    tried.push(
      strategy(
        "rejected",
        "Best rejected change",
        `${what}: tried, but the engine scored it no better than the plan it was tried on.`,
        rejected,
      ),
    );
  }
  tried.sort((a, b) => compareSummaries(a.summary, b.summary)); // stable: ties keep this order

  const bestCandidate =
    tried.find((candidate) => candidate.plan === best.plan) ?? baselineCandidate;

  const changes: ZonePlanChange[] = [];
  zones.forEach((zone, index) => {
    const before = baseline.initial.get(index);
    const after = best.initial.get(index);
    const afterZone = after?.after ?? null;
    const exitId = after?.exitId ?? null;
    const fastestExitId = before?.exitId ?? null;
    if (exitId === fastestExitId && afterZone === null) return;
    changes.push({
      zoneId: zone.id,
      zoneName: zone.name,
      homes: zone.homes,
      fastestExitId,
      exitId,
      afterZoneId: afterZone === null ? null : zones[afterZone].id,
    });
  });

  return {
    baseline: baselineCandidate,
    best: bestCandidate,
    tried,
    changes,
    evaluations,
    improved: best !== baseline,
  };
}
