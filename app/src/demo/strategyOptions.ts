/**
 * Containment strategies the AI commander chooses among on the /live board, each with the
 * model's consequences. Pure: no React, network or LLM. See docs/response-model.md, "Strategy
 * chosen by the AI agent".
 *
 * The board is AI agent only: the commander (Claude, or a person through the same order) picks a
 * strategy per reported fire with `set_strategy`, and assigns units to it with `send_crew`
 * (position_id null for a perimeter strategy, the strategy's position_id for a line strategy).
 * The board then works the fire that way and never switches the strategy on its own.
 *
 * Strategies come from the existing response code, not a new model:
 * - perimeter strategies: the tactics of response/containment.ts (direct, parallel, indirect,
 *   structure, flank), worked by the perimeter race in demo/boardResponse.ts advanceContainment
 *   (Fried & Fried line race, Hauling-chart holding limits, seeded holding test).
 * - line strategies: the attack positions of demo/attack.ts (head_30 / head_60 across the head,
 *   flank_left / flank_right, zone_<id> protection at a zone edge), built as control lines in the
 *   fire solver (model.ts buildLines; the fire re-solves as the line grows).
 *
 * Consequences per option (all model output, see computeStrategyOptions):
 * - perimeter: the fewest of the nearest free units (on top of those already in direct attack on
 *   the fire) for which model.ts containedIn forecasts containment with that tactic within
 *   FORECAST_MINUTES, the minutes to containment, the burned area then (the solver's free-burn
 *   forecast at that minute) and the zones the fire reaches before it; or why it is not
 *   containable (crown fire, head flame above what the line holds, the line outrun).
 * - line: the fewest of the nearest free units (model.ts positionOptions) that finish the line
 *   before the forecast fire reaches it, line done / fire arrival minutes, the zones the line
 *   stands in front of. A line's effect on the fire is computed by the fire model once built, so
 *   no containment minute is forecast here (outcome "line_ahead").
 *
 * Cached per board: whole board minute, solver field and unit assignments.
 */

import { DEVELOPED_FUEL_CODE } from "../fire/spread";
import {
  HEAD_ATTACK_INEFFECTIVE_FT,
  PARALLEL_OFFSET_M,
  TACTIC_LABEL,
  buildsOn,
  lineNeededMeters,
  tacticHoldsFeet,
  type Tactic,
} from "../response/containment";
import { isReported, reachFraction, unreportedRefusal } from "./boardResponse";
import { areaAt } from "./fireField";
import {
  FORECAST_MINUTES,
  attackPositions,
  containedIn,
  fireReachesZone,
  logEvent,
  nearestFree,
  perimeterIn,
  positionEta,
  positionLineDone,
  positionDestKey,
  positionOptions,
  reachableFree,
  teamArrival,
  workOf,
  zoneCounts,
  type AttackPosition,
  type Board,
  type BoardEvent,
  type Fire,
  type Team,
} from "./model";
import { holdsFlameFeet, type DemoApparatusKind } from "./realism";

/**
 * Most free units considered per option (the n nearest, n = 1..this). A bound on work and on the
 * observation's size, not a sourced number: an option not containable with this many is reported
 * as not containable with the available units.
 */
export const MAX_STRATEGY_UNITS = 8;
/** Most free units listed for an option that does not contain (flank, or outrun): a display bound. */
export const NOT_CONTAINABLE_UNITS_SHOWN = 4;
/** Window over which a not-containable option's reason quotes the forecast perimeter growth, minutes (display only). */
export const GROWTH_WINDOW_MINUTES = 10;
/** Perimeter tactics offered on wildland fuel, and on developed ground (FBFM40 91). */
export const WILDLAND_TACTICS: readonly Tactic[] = ["direct", "parallel", "indirect", "flank"];
export const STRUCTURE_TACTICS: readonly Tactic[] = ["structure"];
/** Prefix of a line strategy id: "line:" + an attack position id ("line:flank_left"). */
export const LINE_STRATEGY_PREFIX = "line:";

/** Shown to the agent as observation.inputs.strategy (what the options' numbers are and are not). */
/** A function, not a constant: model.ts imports this module back, so FORECAST_MINUTES is not set yet at load. */
export const strategyLabel = (): string =>
  `Strategy options are model output (demo/strategyOptions.ts): perimeter tactics (response/containment.ts) forecast with the Fried & Fried line race on the solver's perimeter, the Hauling-chart holding limits and the reachable share of the edge, for the fewest of the ${MAX_STRATEGY_UNITS} nearest free units that contain within ${FORECAST_MINUTES} min (ASSUMPTION: the unit bound); line options (attack_positions) by line production against the forecast fire arrival. Burned area at containment is the solver's free-burn forecast at that minute (ASSUMPTION: it ignores the line's own slowing of the fire, so it is an upper bound); aircraft line counts only as already dropped. A chosen strategy is kept until you change it; the board does not switch tactics by flame length on its own.`;

export type StrategyKind = "perimeter" | "line";
export type StrategyOutcome = "contained" | "not_containable" | "line_ahead";

/** One unit an option would send now: by expected arrival (minutes; road = its road leg is known). */
export interface StrategyUnit {
  team: Team;
  etaMin: number;
  road: boolean;
}

export interface StrategyOption {
  /** Tactic id ("direct", "parallel", "indirect", "structure", "flank") or "line:<position id>". */
  id: string;
  name: string;
  kind: StrategyKind;
  /** The perimeter tactic it sets (perimeter strategies), null for a line strategy. */
  tactic: Tactic | null;
  /** send_crew position_id for its units: the attack position (line strategies), null = direct attack at the fire. */
  positionId: string | null;
  /** What it works, plain language with the model's metres. */
  works: string;
  /** Line it needs: the tactic's line now (perimeter), or the line across the fire's path (line), metres. */
  lineM: number;
  /** Flame the line faces (head flame, or the flame at the position), ft, and what the finished line holds, ft (null = no flame test). */
  flameFt: number;
  holdsFlameFt: number | null;
  /** Units already on it (direct attack on the fire, or building this line). */
  assigned: Team[];
  /** Free units the model would send on top (nearest by expected arrival). */
  send: StrategyUnit[];
  /** Units by kind, assigned + send. */
  unitsNeeded: Partial<Record<DemoApparatusKind, number>>;
  outcome: StrategyOutcome;
  /** Minutes until contained (perimeter, outcome contained). */
  containedInMin: number | null;
  /** Line strategies: minutes until the line is finished with these units, until the forecast fire reaches its anchor, and whether the line is ready first. */
  lineDoneMin: number | null;
  fireReachesLineMin: number | null;
  lineReadyBeforeFire: boolean | null;
  /** Burned area (ha) at `burnedHaAt` (the solver's free-burn forecast), or null without a field. */
  burnedHa: number | null;
  burnedHaAt: string;
  /** Zones the fire reaches before containment (or within the forecast when not contained), and their households still home. */
  zonesReached: string[];
  householdsHomeInZonesReached: number;
  /** Zones a line strategy stands in front of (attack.ts protectsZones). */
  protectsZoneIds: string[];
  /** Why it does not contain with the available units (model reasons), or null. */
  notContainableBecause: string | null;
  /** Safety notes from the model (flame length bands, crown fire, line reached by fire first, reach). */
  safety: string[];
}

/** The strategy the commander chose for a fire, with the model's numbers when it was chosen. */
export interface ChosenStrategy {
  id: string;
  name: string;
  tactic: Tactic | null;
  positionId: string | null;
  /** Board minute chosen, by whom, and the commander's reason. */
  at: number;
  by: BoardEvent["actor"];
  reason: string;
  /** The option's consequences at that minute (model output), as one line, and the numbers behind it. */
  predictionText: string;
  outcome: StrategyOutcome;
  containedInMin: number | null;
  lineDoneMin: number | null;
  unitsText: string;
}

// ---- helpers ----

/** Whether the fire's head is on developed ground (FBFM40 91), as boardResponse.structureFront. */
export function onDevelopedGround(board: Board, fire: Fire): boolean {
  if (fire.rates.cell >= 0) return fire.rates.fuelCode === DEVELOPED_FUEL_CODE;
  return board.env.spread.ground.fuelCodeAt(fire.origin) === DEVELOPED_FUEL_CODE;
}

/**
 * The perimeter tactic the board works a fire with, or undefined for the rule-based choice
 * (response/containment.ts chooseTactic; only with autoDispatch, i.e. scripts):
 * - the commander's strategy when it set a tactic (set_strategy);
 * - otherwise, on the AI-only board, what a send_crew with position_id null means: direct attack,
 *   which on developed ground (FBFM40 91) is the structure attack (engines with water). This
 *   follows the fuel at the head; it is not a choice among strategies, and the board never picks
 *   parallel, indirect or flank by itself.
 */
export function commanderTactic(board: Board, fire: Fire): Tactic | undefined {
  const fr = board.response.fires.get(fire.id);
  if (fr?.strategy?.tactic) return fr.strategy.tactic;
  if (board.response.autoDispatch) return undefined;
  return onDevelopedGround(board, fire) ? "structure" : "direct";
}

const KIND_WORDS: Record<DemoApparatusKind, [string, string]> = {
  engine_t3: ["Type 3 engine", "Type 3 engines"],
  engine_t1: ["Type 1 engine", "Type 1 engines"],
  hand_crew_t1: ["hand crew", "hand crews"],
  dozer_t2: ["dozer", "dozers"],
};

/** "3 Type 3 engines, 1 hand crew" ("no units" when empty). */
export function unitsNeededText(counts: Partial<Record<DemoApparatusKind, number>>): string {
  const parts = (Object.keys(KIND_WORDS) as DemoApparatusKind[])
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${counts[k]} ${KIND_WORDS[k][counts[k] === 1 ? 0 : 1]}`);
  return parts.join(", ") || "no units";
}

function countKinds(teams: readonly Team[]): Partial<Record<DemoApparatusKind, number>> {
  const out: Partial<Record<DemoApparatusKind, number>> = {};
  for (const t of teams) out[t.kind] = (out[t.kind] ?? 0) + 1;
  return out;
}

const POSITION_NAME: Record<AttackPosition["kind"], string> = {
  head: "Line across the head",
  flank_left: "Line on the left flank",
  flank_right: "Line on the right flank",
  zone: "Protection line at",
};

function lineName(board: Board, p: AttackPosition): string {
  if (p.kind === "head") return `${POSITION_NAME.head} (forecast +${p.id.slice("head_".length)} min)`;
  if (p.kind === "zone") {
    const zoneId = p.protectsZoneIds[0] ?? p.id.slice("zone_".length);
    return `${POSITION_NAME.zone} ${board.zones.find((z) => z.id === zoneId)?.name ?? zoneId}`;
  }
  return POSITION_NAME[p.kind];
}

const TACTIC_WORKS: Record<Tactic, string> = {
  direct: "Line on the burning edge, anchored at the heel",
  parallel: `Line set back about ${PARALLEL_OFFSET_M} m from the edge with burnout`,
  indirect: "Line on the perimeter the fire is forecast to reach 30 to 120 min ahead, finished before it gets there",
  structure: "Engines with water on the developed ground (no flame-length limit)",
  flank: "Flank line from the heel; the head is left until it lays down, engines protect what it threatens (protection not modelled)",
};

/** Hauling chart notes for a head flame (PMS 465 p.12; the limits as response/containment.ts). */
function flameNotes(flameFt: number, crowning: boolean): string[] {
  const out: string[] = [];
  if (crowning) out.push("Crown fire at the head: no ground line holds it");
  if (flameFt > HEAD_ATTACK_INEFFECTIVE_FT) out.push(`Head flame ${flameFt.toFixed(1)} ft: control at the head is ineffective above ${HEAD_ATTACK_INEFFECTIVE_FT} ft (PMS 465 Hauling chart)`);
  else if (flameFt > holdsFlameFeet("engine_t3")) out.push(`Head flame ${flameFt.toFixed(1)} ft: above the ${holdsFlameFeet("engine_t3")} ft engines and dozers hold in direct attack`);
  else if (flameFt > holdsFlameFeet("hand_crew_t1")) out.push(`Head flame ${flameFt.toFixed(1)} ft: above the ${holdsFlameFeet("hand_crew_t1")} ft hand crews hold; direct attack needs an engine or dozer`);
  return out;
}

/** Zones (reported-scope) the fire reaches within `limit` minutes, and their households home now. */
function zonesWithin(board: Board, fire: Fire, limit: number): { ids: string[]; home: number } {
  const ids: string[] = [];
  let home = 0;
  for (const zone of board.zones) {
    if (!fireReachesZone(board, fire, zone, limit)) continue;
    ids.push(zone.id);
    home += zoneCounts(zone, board.minute).home;
  }
  return { ids, home };
}

/** Burned area (ha) of the fire `t` minutes from now in the solver's forecast (free burn), or null. */
function burnedHaIn(board: Board, fire: Fire, t: number): number | null {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return null;
  return Math.round((areaAt(field, board.env.landscape, s, board.minute + t) / 10_000) * 10) / 10;
}

// ---- options ----

function perimeterOption(board: Board, fire: Fire, tactic: Tactic, free: StrategyUnit[], assigned: Team[]): StrategyOption {
  const candidates = free.filter((c) => buildsOn(c.team.kind, tactic));
  const arrivals = assigned.map((t) => teamArrival(board, t, fire));
  const works = assigned.map((t) => workOf(board, t, fire));
  const flame = fire.rates.headFlameFeet;
  let send: StrategyUnit[] = [];
  let contained: number | null = null;
  const maxN = Math.min(MAX_STRATEGY_UNITS, candidates.length);
  for (let n = assigned.length > 0 ? 0 : 1; n <= maxN; n += 1) {
    const pick = candidates.slice(0, n);
    const t = containedIn(
      board,
      fire,
      [...arrivals, ...pick.map((p) => p.etaMin)],
      [...works, ...pick.map((p) => workOf(board, p.team, fire))],
      tactic,
    );
    if (t !== null) {
      send = pick;
      contained = t;
      break;
    }
  }
  const considered = candidates.slice(0, maxN);
  const holdsAll = Math.max(0, ...[...assigned.map((t) => t.kind), ...considered.map((c) => c.team.kind)].map(holdsFlameFeet));
  let why: string | null = null;
  if (contained === null) {
    send = considered.slice(0, tactic === "flank" ? NOT_CONTAINABLE_UNITS_SHOWN : maxN);
    // Perimeter growth over the next GROWTH_WINDOW_MINUTES of the solver's forecast (the one-minute figure reads 0 between solver samples).
    const growth = (perimeterIn(board, fire, GROWTH_WINDOW_MINUTES) - fire.perimeterM) / GROWTH_WINDOW_MINUTES;
    const rate = [...works, ...considered.map((c) => workOf(board, c.team, fire))].reduce((s, u) => s + u.lineMPerMin, 0);
    if (tactic === "flank") why = "Flank and protect does not contain the fire: the head is left until it lays down";
    else if (fire.rates.crowning && tactic !== "structure") why = "Crown fire at the head: no ground line holds it";
    else if (tactic === "direct" && holdsAll < flame) why = `Head flame ${flame.toFixed(1)} ft is above the ${holdsAll} ft the available units' line holds in direct attack`;
    else if ((tactic === "parallel" || tactic === "indirect") && flame > HEAD_ATTACK_INEFFECTIVE_FT) why = `Head flame ${flame.toFixed(1)} ft is above the ${HEAD_ATTACK_INEFFECTIVE_FT} ft a ${tactic} line holds`;
    else if (assigned.length === 0 && considered.length === 0) why = "No free unit that builds this line can reach the fire";
    else
      why = `The ${assigned.length ? `${assigned.length} assigned and ` : ""}${considered.length} nearest free units do not catch it within ${FORECAST_MINUTES} min (line about ${rate.toFixed(1)} m/min at the direct rate; perimeter growing ${growth.toFixed(1)} m/min now)`;
  }
  const team = [...assigned, ...send.map((s) => s.team)];
  const zones = zonesWithin(board, fire, contained ?? FORECAST_MINUTES);
  const safety = flameNotes(flame, fire.rates.crowning);
  const reach = reachFraction(board, fire);
  if (reach !== null && reach < 0.995) safety.push(`Only ${Math.round(reach * 100)}% of the edge is within reach of the ground units on scene`);
  if (tactic === "structure") safety.push("Structure attack: no Hauling-chart flame test (ASSUMPTION, as response/containment.ts)");
  const holds = tactic === "direct" ? (team.length ? Math.max(...team.map((t) => holdsFlameFeet(t.kind))) : 0) : tacticHoldsFeet(tactic, 0);
  return {
    id: tactic,
    name: TACTIC_LABEL[tactic],
    kind: "perimeter",
    tactic,
    positionId: null,
    works: TACTIC_WORKS[tactic],
    lineM: Math.round(lineNeededMeters(tactic === "indirect" ? "parallel" : tactic, fire.perimeterM, null)),
    flameFt: flame,
    holdsFlameFt: Number.isFinite(holds) ? holds : null,
    assigned,
    send,
    unitsNeeded: countKinds(team),
    outcome: contained === null ? "not_containable" : "contained",
    containedInMin: contained,
    lineDoneMin: null,
    fireReachesLineMin: null,
    lineReadyBeforeFire: null,
    burnedHa: burnedHaIn(board, fire, contained ?? FORECAST_MINUTES),
    burnedHaAt: contained === null ? `+${FORECAST_MINUTES} min, still burning (free-burn forecast)` : "containment (free-burn forecast to that minute)",
    zonesReached: zones.ids,
    householdsHomeInZonesReached: zones.home,
    protectsZoneIds: [],
    notContainableBecause: why,
    safety,
  };
}

function lineOption(board: Board, fire: Fire, pos: AttackPosition): StrategyOption | null {
  const fireEta = positionEta(board, pos);
  if (fireEta === 0) return null; // fire already there: not offered (applyOrder refuses it too)
  const assigned = pos.line ? board.teams.filter((t) => t.lineId === pos.line!.id) : [];
  const assignedDone = positionLineDone(board, pos);
  const ready = (done: number | null) => done !== null && (fireEta === null || done <= fireEta);
  const opts = positionOptions(board, fire, pos, NOT_CONTAINABLE_UNITS_SHOWN);
  let send: StrategyUnit[] = [];
  let done: number | null = assignedDone;
  if (!ready(assignedDone)) {
    const pick = opts.find((o) => ready(o.lineDoneMin)) ?? opts[opts.length - 1];
    if (pick) {
      // The same nearest units positionOptions picked (model.ts reachableFree), each with its own arrival.
      const free = new Map(reachableFree(board, positionDestKey(fire, pos), pos.point).map((r) => [r.team.id, r]));
      send = pick.teams.flatMap((id) => {
        const r = free.get(id);
        return r ? [{ team: r.team, etaMin: r.eta, road: r.road }] : [];
      });
      done = pick.lineDoneMin;
    }
  }
  const team = [...assigned, ...send.map((s) => s.team)];
  const holds = team.length ? Math.max(...team.map((t) => holdsFlameFeet(t.kind))) : 0;
  const safety: string[] = [];
  if (pos.crowning) safety.push("Crown fire forecast at the position: the line will not hold it");
  if (team.length && pos.flameFt > holds) safety.push(`Flame facing the line ${pos.flameFt.toFixed(1)} ft is above the ${holds} ft these units' line holds: it can be breached`);
  if (send.length && fireEta !== null && send.some((s) => s.etaMin >= fireEta)) safety.push("Fire is forecast at the position before some of these units arrive");
  if (team.length && !ready(done)) safety.push(done === null ? "Line not finished within 6 h with these units" : "Line not finished before the fire reaches it");
  const zones = zonesWithin(board, fire, fireEta ?? FORECAST_MINUTES);
  return {
    id: `${LINE_STRATEGY_PREFIX}${pos.id}`,
    name: lineName(board, pos),
    kind: "line",
    tactic: null,
    positionId: pos.id,
    works: `${pos.id}: ${Math.round(pos.aM + pos.bM)} m of line across the fire's forecast path (control line in the fire model)`,
    lineM: Math.round(pos.aM + pos.bM),
    flameFt: pos.flameFt,
    holdsFlameFt: team.length ? holds : null,
    assigned,
    send,
    unitsNeeded: countKinds(team),
    outcome: "line_ahead",
    containedInMin: null,
    lineDoneMin: done,
    fireReachesLineMin: fireEta,
    lineReadyBeforeFire: team.length ? ready(done) : null,
    burnedHa: fireEta === null ? null : burnedHaIn(board, fire, fireEta),
    burnedHaAt: "when the fire reaches the line (free-burn forecast)",
    zonesReached: zones.ids,
    householdsHomeInZonesReached: zones.home,
    protectsZoneIds: pos.protectsZoneIds,
    notContainableBecause: null,
    safety,
  };
}

/** Free units that can reach the fire's anchor by road, nearest by expected arrival (model.ts nearestFree). */
function freeUnits(board: Board, fire: Fire): StrategyUnit[] {
  return nearestFree(board, fire).map((r) => ({ team: r.team, etaMin: r.eta, road: r.road }));
}

interface Cache {
  field: unknown;
  minute: number;
  sig: string;
  byFire: Map<string, StrategyOption[]>;
}
const caches = new WeakMap<Board, Cache>();

function signature(board: Board): string {
  const units = board.teams.map((t) => `${t.id}:${t.status}:${t.fireId ?? ""}:${t.lineId ?? ""}`).join(",");
  const strategies = [...board.response.fires].map(([id, fr]) => `${id}=${fr.strategy?.id ?? ""}/${fr.tactic}`).join(",");
  return `${units}|${strategies}|${board.lines.length}`;
}

/**
 * The strategy options of a reported, burning fire (empty otherwise), cached per whole board
 * minute, solver field and unit assignments.
 */
export function computeStrategyOptions(board: Board, fire: Fire): StrategyOption[] {
  const fr = board.response.fires.get(fire.id);
  // Report rule (boardResponse.ts): nothing for a fire dispatch does not have yet.
  if (!fr || fire.status !== "burning" || !isReported(board, fire)) return [];
  const minute = Math.floor(board.minute + 1e-6);
  const sig = signature(board);
  let cache = caches.get(board);
  if (!cache || cache.field !== board.solver.field || cache.minute !== minute || cache.sig !== sig) {
    cache = { field: board.solver.field, minute, sig, byFire: new Map() };
    caches.set(board, cache);
  }
  const hit = cache.byFire.get(fire.id);
  if (hit) return hit;
  const free = freeUnits(board, fire);
  const assigned = board.teams.filter((t) => t.fireId === fire.id && t.lineId === null);
  const tactics = onDevelopedGround(board, fire) ? STRUCTURE_TACTICS : WILDLAND_TACTICS;
  const options: StrategyOption[] = tactics.map((t) => perimeterOption(board, fire, t, free, assigned));
  if (fire.noSpread === null) {
    for (const pos of attackPositions(board, fire)) {
      const o = lineOption(board, fire, pos);
      if (o) options.push(o);
    }
  }
  cache.byFire.set(fire.id, options);
  return options;
}

/** "contained in ~45 min with 3 Type 3 engines" / "line done in ~20 min, before the fire (35 min), with ..." / "not containable with available units: ...". */
export function predictionText(o: StrategyOption): string {
  const units = unitsNeededText(o.unitsNeeded);
  if (o.outcome === "contained") return `contained in ~${Math.round(o.containedInMin ?? 0)} min with ${units}`;
  if (o.outcome === "line_ahead") {
    if (o.lineDoneMin === null) return `line not finished within 6 h with ${units}`;
    const fire = o.fireReachesLineMin === null ? "the fire is not forecast there" : `${o.lineReadyBeforeFire ? "before" : "after"} the fire reaches it (${Math.round(o.fireReachesLineMin)} min)`;
    return `line done in ~${Math.round(o.lineDoneMin)} min, ${fire}, with ${units}`;
  }
  return `not containable with available units: ${(o.notContainableBecause ?? "").replace(/^./, (c) => c.toLowerCase())}`;
}

// ---- the order ----

export interface SetStrategyOrder {
  type: "set_strategy";
  fire_id: string;
  strategy_id: string;
  reason?: string;
}

/**
 * set_strategy: the commander's containment strategy for a fire (model.ts applyOrder). Refuses an
 * unknown or unreported fire (unreportedRefusal), a fire not burning, and a strategy id that is
 * not one of the fire's options now. A perimeter strategy sets the tactic the board works the
 * fire with (and replans an indirect line); a line strategy names the attack position its units
 * go to. Units are assigned with send_crew. Returns null or why it was refused.
 */
export function applyStrategyOrder(board: Board, order: SetStrategyOrder, actor: BoardEvent["actor"]): string | null {
  const fire = board.fires.find((f) => f.id === order.fire_id);
  if (!fire) return actor === "agent" ? `Unknown fire ${order.fire_id}: no reported fire has that id.` : `Unknown fire ${order.fire_id}.`;
  const unreported = unreportedRefusal(board, fire, actor);
  if (unreported) return unreported;
  if (fire.status !== "burning") return `${fire.id} is not burning.`;
  const fr = board.response.fires.get(fire.id);
  if (!fr) return `${fire.id} has no response record.`;
  const options = computeStrategyOptions(board, fire);
  const option = options.find((o) => o.id === order.strategy_id);
  if (!option) return `Unknown strategy ${order.strategy_id} for ${fire.id}; its options now: ${options.map((o) => o.id).join(", ") || "none"}.`;
  if (fr.strategy?.id === option.id) return `${fire.id} already has strategy ${option.id}.`;
  const previous = fr.strategy;
  const prediction = predictionText(option);
  fr.strategy = {
    id: option.id,
    name: option.name,
    tactic: option.tactic,
    positionId: option.positionId,
    at: board.minute,
    by: actor,
    reason: order.reason ?? "",
    predictionText: prediction,
    outcome: option.outcome,
    containedInMin: option.containedInMin,
    lineDoneMin: option.lineDoneMin,
    unitsText: unitsNeededText(option.unitsNeeded),
  };
  if (option.tactic && option.tactic !== fr.tactic) {
    fr.tactic = option.tactic;
    fr.target = null; // an indirect line is planned on the next review
  }
  fr.tacticAt = -Infinity; // review now (plans the indirect target with the units assigned)
  const send = option.send.map((s) => s.team.id);
  logEvent(
    board,
    "team",
    actor,
    `${fire.id}: strategy ${option.name.charAt(0).toLowerCase() + option.name.slice(1)}${previous ? ` (was ${previous.name.toLowerCase()})` : ""}${order.reason ? `: ${order.reason}` : ""}. Model: ${prediction}${option.burnedHa !== null ? `; ${option.burnedHa} ha burned at ${option.burnedHaAt}` : ""}.${send.length ? ` Units for it: ${send.join(", ")}${option.positionId ? ` (send_crew position ${option.positionId})` : " (send_crew, direct)"}.` : ""}`,
    { action: "strategy_set", fireId: fire.id, label: option.name, positionId: option.positionId ?? undefined, etaMin: option.containedInMin ?? option.lineDoneMin ?? undefined },
  );
  return null;
}
