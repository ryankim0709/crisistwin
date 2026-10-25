/**
 * Suppression on the command board's cells: which cells of the solver's arrival field
 * (fireField.ts) are still burning, and units putting burning cells out. Pure: no React, worker
 * or network. Read through demo/fireState.ts; the board (model.ts) calls `suppressionTick` once
 * per whole board minute and feeds the knocked-down edge to the solver. See
 * docs/response-model.md, "Cell fire state and suppression".
 *
 * How long a cell burns (`burnMinutes`): from its arrival (the solver's arrival is when the
 * front reaches the cell centre) until the front has left the cell and the fuel at the cell's
 * far side has finished flaming:
 *   D = g / (2 F) + t_r
 * - g / (2 F): half a cell (ground size g, m) at F, the speed the modelled front moved normal to
 *   itself at the cell, m/min. F = 1 / |grad t| of the solver's arrival field t (the eikonal
 *   relation), with grad t from upwind differences (only the 4-neighbours that burned earlier,
 *   the Godunov scheme of fast marching, Sethian 1996), so a neighbour that burned much later
 *   (behind a line, by another fire) does not stretch it. Geometry of the solver's cell-centre
 *   arrival convention, not a fitted value. (The normal speed, not the ellipse's ray rate R(theta)
 *   toward the gradient: for an elliptical Huygens front the normal speed is the ellipse's
 *   support function, several times R(theta) on the flanks of a wind-driven fire.) A cell with
 *   no earlier neighbour (an ignition or an ember-started spot) uses the solver's head rate.
 * - t_r: Anderson (1969) flaming residence time t_r = 384 / sigma minutes (sigma the particle
 *   surface-area-to-volume ratio, 1/ft), the relation Rothermel (1972) uses with the bed's
 *   characteristic sigma (fire/rothermel.ts residenceTimeMinutes). ASSUMPTION: applied per
 *   size class of the Scott & Burgan (2005) fuel model, a cell flames until its coarsest
 *   loaded class has (100-h sticks, sigma 30/ft: 12.8 min; 10-h, 109/ft: 3.5 min; grass and
 *   needles, 1500-3500/ft: 0.1-0.26 min).
 * - Not modelled: smouldering and glowing combustion of 1000-h logs and duff after flaming. The
 *   fuel models carry no 1000-h or duff load, so FOFEM / Burnup (Albini & Reinhardt) burnout
 *   cannot be computed from them; "burned out" means the modelled fuel has finished flaming.
 *   Developed ground (structure spread) has no fuel-model sigma, so it gets the crossing term
 *   only (structure burnout not modelled).
 *
 * Suppression, applied at whole board minutes (so a run does not depend on the clock's tick):
 * - Direct attack: a ground unit on scene for direct attack (no attack line) that is working
 *   (response/reach.ts: not out of reach, past its hike in) puts out burning EDGE cells of its
 *   fire (burning cells facing unburned ground the solver can spread into), nearest first from
 *   where it last worked, so it works along the edge. Engines (hose, or their crew on foot)
 *   work within their reach radius of where they parked (response/reach.ts: hose lay, crew
 *   within ENGINE_CREW_MAX_HIKE_M of its engine). Hand crews and dozers build progressive line
 *   (NWCG Fireline Handbook PMS 410-1, line construction: the crew or dozer advances along the
 *   edge from its anchor, the line behind it is its access): they are not tied to where they
 *   parked; a cell next to the last one they worked (PROGRESSIVE_STEP_CELLS) is part of building
 *   line, a farther one is reached first by walking there (Tobler 1993, reach.ts hikeMinutes;
 *   dozers at DOZER_WALK_KMH), at most HAND_CREW_MAX_HIKE_MINUTES / DOZER_MAX_WALK_MINUTES away,
 *   and a dozer works no cell steeper than the PMS 465 p.140 table (DOZER_MAX_SLOPE_PCT).
 *   It earns line metres at its sourced production rate on the fire's tactic
 *   (boardResponse.tacticLineRate: Broyles 2011 hand crews, PMS 465 p.164 engines, PMS 465 p.39
 *   engine crews on foot, PMS 465 p.140 dozers) and a cell costs the edge it secures: its open
 *   cell faces x g x pi/4 (fireField.ts LATTICE_PERIMETER_TO_SMOOTH, the board's perimeter
 *   measure), so the line built and the edge put out are the same metres the containment race
 *   counts. A cell is workable only where its flame is within what the unit holds: Byram (1959)
 *   L = L_head (F / R_head)^0.46 (fire/spread.ts BYRAM_FLAME_EXPONENT; intensity is proportional
 *   to the spread rate normal to the front, F above, and the solver's head flame L_head at
 *   R_head), against the Hauling chart (PMS 465 p.12: hand tools 4 ft, engines and
 *   dozers 8 ft; an engine crew on foot holds as hand tools) and the cell does not torch or crown.
 *   Only the direct, flank and structure tactics work the edge (parallel and indirect line is
 *   built away from it and holds by the containment race and attack lines).
 * - What a knocked-down cell does to the fire: it spreads no further (inert in the solver,
 *   fireField.ts inertCells: no spread, no embers) and the unburned ground around it becomes
 *   built line (solver control lines, holding the unit's flame limit), so the edge there stops
 *   advancing. The solver sees the knocked-down edge every KNOCKDOWN_RESOLVE_MINUTES (one
 *   re-solve, resuming from the burned ground).
 * - Mop-up: on a contained fire, the units kept for mop-up put out burning cells (interior
 *   too) within their reach at their direct-attack production rate, MOPUP_CELL_WIDTHS cell
 *   widths of line per cell (ASSUMPTION: no published mop-up production rate is in the model).
 *   Hand crews walk the black as above. The rest burns out on its own.
 * - Held edge (`heldEdge`, the board's containment share for edge tactics): of the fire's open
 *   edge (cell faces between its burned cells and unburned ground that can burn, the perimeter
 *   measure of fireField.ts), the faces the fire will not cross: the solver's forecast (with
 *   every attack line and knocked-down edge it has) never burns the ground beyond within its
 *   lookahead, or the burned cell was put out since that forecast (until the next re-solve, at
 *   most KNOCKDOWN_RESOLVE_MINUTES later). So line counts once it holds in the fire model, and
 *   line the fire outflanks or crosses stops counting. Off the board's edge: held only where the
 *   cell was put out.
 *
 * Units: minutes are board minutes; distances ground metres; flame feet; grid coordinates
 * column x east, row y south.
 */

import { FUEL_MODELS, SAV_DEAD_100H, SAV_DEAD_10H } from "../fire/fuelModels";
import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";
import { BYRAM_FLAME_EXPONENT } from "../fire/spread";
import type { LonLat } from "../live/types";
import { DOZER_MAX_SLOPE_PCT, DOZER_MAX_WALK_MINUTES, HAND_CREW_MAX_HIKE_MINUTES, dozerWalkMinutes, hikeMinutes } from "../response/reach";
import { tacticLineRate } from "./boardResponse";
import { LATTICE_PERIMETER_TO_SMOOTH, countAtMost, type FireSolveResult } from "./fireField";
import { lineKey, logEvent, type Board, type Fire, type Team } from "./model";
import { holdsFlameFeet } from "./realism";

/** Anderson (1969) flaming residence time: t_r = 384 / sigma minutes, sigma in 1/ft (Rothermel 1972 uses it). */
export const ANDERSON_RESIDENCE_MINUTES_PER_FOOT = 384;
/**
 * ASSUMPTION (as attack.ts LINE_RESOLVE_CHUNK_M): the solver sees newly knocked-down edge every
 * this many board minutes (one re-solve each, resuming from the burned ground). A trade between
 * solve count and how promptly the forecast sees the knockdown.
 */
export const KNOCKDOWN_RESOLVE_MINUTES = 5;
/** ASSUMPTION (display cadence): the board logs each fire's knockdown and mop-up every this many board minutes. */
export const KNOCKDOWN_REPORT_MINUTES = 15;
/** ASSUMPTION: mop-up of one burning cell costs this many cell widths of line at the unit's direct-attack rate. */
export const MOPUP_CELL_WIDTHS = 1;
/** Tactics whose line is built at the burning edge itself (response/containment.ts). */
export const EDGE_TACTICS: ReadonlySet<string> = new Set(["direct", "flank", "structure"]);
/**
 * Geometry, not a fitted value: a cell within this many cell widths of the last one a
 * progressive unit worked (its 8-neighbours: a diagonal is sqrt 2 = 1.41) is the next stretch of
 * its line; moving along the line as it is built is part of the line production rate (Broyles
 * 2011 and PMS 465 rates are measured on line constructed while advancing). Farther cells are
 * walked to first (Tobler).
 */
export const PROGRESSIVE_STEP_CELLS = 1.5;
/** Cells kept per unit for its work path (display only). */
const TRAIL_CELLS = 16;
const SQUARE_METERS_PER_HECTARE = 10_000;

export type WorkKind = "direct" | "mopup";

/** One unit's work on its fire's cells. */
export interface UnitCellWork {
  teamId: string;
  fireId: string;
  kind: WorkKind;
  /** Line metres earned and not yet spent on a cell. */
  budgetM: number;
  /** Cells it put out on this assignment, oldest first (last TRAIL_CELLS). */
  trail: number[];
  /** Cell it works now (-1 = none in reach) and the line metres that cell costs. */
  target: number;
  targetCostM: number;
  /** Board minute it last worked. */
  minute: number;
  /** Progressive units: cell it is walking to (-1 = none) and the walk minutes still to go (no line is built meanwhile). */
  walkTo?: number;
  walkLeftMin?: number;
}

/**
 * Whether a unit builds progressive line along the edge (not tied to where it parked): a hand
 * crew on foot or a dozer working (response/reach.ts modes hand_line / dozer). Engines and their
 * crews stay within reach of the engine.
 */
export function worksAlongEdge(team: Team): boolean {
  return (team.kind === "hand_crew_t1" && team.workMode === "hand_line") || (team.kind === "dozer_t2" && team.workMode === "dozer");
}

export interface FireSuppressionStats {
  /** Cells put out by direct attack / mop-up, all run, and as of the last feed report. */
  knockedCells: number;
  moppedCells: number;
  reportedKnocked: number;
  reportedMopped: number;
  /** Units that put cells out since the last report. */
  teams: string[];
}

export interface SuppressionState {
  /** Board minute each cell was put out by suppression (Infinity = not), row-major like the landscape. */
  extinguishedAt: Float32Array;
  /** Bumped whenever extinguishedAt changes (fireState.ts caches on it). */
  version: number;
  /** Last whole board minute applied. */
  minute: number;
  units: Map<string, UnitCellWork>;
  /** Built line around knocked-down cells (sparse): cell, minute it holds from, flame it holds (ft). */
  blockCells: number[];
  blockFrom: number[];
  blockHolds: number[];
  blocked: Uint8Array;
  /** Cells put out, in order (they are inert in the solver once committed). */
  inert: number[];
  /** Prefixes of blockCells and inert the solver has, and how many commits there were. */
  committedBlocks: number;
  committedInert: number;
  commits: number;
  /** Direct-attack knockdown not yet committed to the solver. */
  dirty: boolean;
  /** Burn duration per cell (D above), minutes; -1 where the field has no arrival. For `burnField`. */
  burnMinutes: Float32Array;
  burnField: FireSolveResult | null;
  maxBurnMinutes: number;
  fires: Map<string, FireSuppressionStats>;
}

export function createSuppressionState(cellCount: number): SuppressionState {
  return {
    extinguishedAt: new Float32Array(cellCount).fill(Number.POSITIVE_INFINITY),
    version: 0,
    minute: 0,
    units: new Map(),
    blockCells: [],
    blockFrom: [],
    blockHolds: [],
    blocked: new Uint8Array(cellCount),
    inert: [],
    committedBlocks: 0,
    committedInert: 0,
    commits: 0,
    dirty: false,
    burnMinutes: new Float32Array(cellCount).fill(-1),
    burnField: null,
    maxBurnMinutes: 0,
    fires: new Map(),
  };
}

// ---- burn duration ----

const residenceCache = new Map<number, number>();

/**
 * Anderson (1969) flaming residence of a fuel model's coarsest loaded class, minutes (see the
 * header: ASSUMPTION per class). 0 for codes with no fuel model (developed, non-burnable).
 */
export function particleResidenceMinutes(fuelCode: number): number {
  const hit = residenceCache.get(fuelCode);
  if (hit !== undefined) return hit;
  const m = FUEL_MODELS.get(fuelCode);
  let t = 0;
  if (m) {
    const classes: [number, number][] = [
      [m.load.dead1h, m.savDead1hPerFoot],
      [m.load.dead10h, SAV_DEAD_10H],
      [m.load.dead100h, SAV_DEAD_100H],
      [m.load.liveHerb, m.savLiveHerbPerFoot],
      [m.load.liveWoody, m.savLiveWoodyPerFoot],
    ];
    for (const [load, sav] of classes) if (load > 0 && sav > 0) t = Math.max(t, ANDERSON_RESIDENCE_MINUTES_PER_FOOT / sav);
  }
  residenceCache.set(fuelCode, t);
  return t;
}

/**
 * Upwind gradient of the arrival field at `cell`, minutes per cell (x east, y south): per axis,
 * the difference to the earlier of its two 4-neighbours when that one burned before the cell
 * (the Godunov upwind scheme of fast marching, Sethian 1996), else 0 on that axis. Null when no
 * 4-neighbour burned earlier (an ignition or ember-started cell).
 */
export function upwindGradient(grid: LandscapeGrid, arrival: Float32Array, cell: number): { x: number; y: number } | null {
  const { width, height } = grid;
  const x = cell % width;
  const y = (cell - x) / width;
  const a0 = arrival[cell];
  if (!Number.isFinite(a0)) return null;
  const at = (nx: number, ny: number) => (nx < 0 || ny < 0 || nx >= width || ny >= height ? Number.POSITIVE_INFINITY : arrival[ny * width + nx]);
  const w = at(x - 1, y);
  const e = at(x + 1, y);
  const n = at(x, y - 1);
  const s = at(x, y + 1);
  let any = false;
  let gx = 0;
  let gy = 0;
  if (Math.min(w, e) < a0) {
    any = true;
    gx = w <= e ? a0 - w : -(a0 - e);
  }
  if (Math.min(n, s) < a0) {
    any = true;
    gy = n <= s ? a0 - n : -(a0 - s);
  }
  return any ? { x: gx, y: gy } : null;
}

/** Unit direction of increasing arrival at `cell` (the local outward spread direction), grid coordinates, or null. */
export function outwardDirection(grid: LandscapeGrid, arrival: Float32Array, cell: number): { x: number; y: number } | null {
  const d = upwindGradient(grid, arrival, cell);
  const n = d ? Math.hypot(d.x, d.y) : 0;
  return d && n > 1e-9 ? { x: d.x / n, y: d.y / n } : null;
}

/**
 * Speed of the modelled front normal to itself at `cell`, m/min: g / |grad t| (eikonal), or the
 * solver's head rate where the upwind gradient is undefined or zero (cells ignited together).
 */
export function frontSpeed(field: FireSolveResult, grid: LandscapeGrid, cell: number): number {
  const d = upwindGradient(grid, field.arrivalMinutes, cell);
  const n = d ? Math.hypot(d.x, d.y) : 0;
  return n > 1e-9 ? grid.groundCellSizeMeters / n : field.behaviour.headRateMetersPerMinute[cell];
}

/**
 * Surface flame at `cell` on its front, feet: Byram (1959) L = L_head (F / R_head)^0.46 with F
 * the front's normal speed there (capped at the head rate) and the solver's head flame L_head.
 */
export function frontFlameFeet(field: FireSolveResult, grid: LandscapeGrid, cell: number): number {
  const head = field.behaviour.headRateMetersPerMinute[cell];
  const flame = field.behaviour.headFlameFeet[cell];
  if (!(head > 0)) return flame;
  return flame * Math.pow(Math.min(1, frontSpeed(field, grid, cell) / head), BYRAM_FLAME_EXPONENT);
}

/**
 * Burn durations for a newly installed field (model.ts applyFireSolve). Cells already burned at
 * the field's resume minute keep the duration they had (they burned under the earlier field), so
 * a re-solve never relights or puts out a cell.
 */
export function updateBurnDurations(board: Board): void {
  const st = board.suppression;
  const field = board.solver.field;
  if (!field || st.burnField === field) return;
  const grid = board.env.landscape;
  const g = grid.groundCellSizeMeters;
  const arrival = field.arrivalMinutes;
  const from = st.burnField ? field.fromMinute : null;
  const D = st.burnMinutes;
  let max = 0;
  for (let c = 0; c < arrival.length; c++) {
    const a = arrival[c];
    if (!(a <= field.horizonMinutes)) {
      D[c] = -1;
      continue;
    }
    if (!(from !== null && a <= from && D[c] >= 0)) {
      const speed = frontSpeed(field, grid, c);
      D[c] = (speed > 0 ? g / (2 * speed) : 0) + particleResidenceMinutes(grid.fuelCodes[c]);
    }
    if (D[c] > max) max = D[c];
  }
  st.burnField = field;
  st.maxBurnMinutes = max;
}

/** Whether `cell` is burning at `minute`: ignited, within its burn duration, not put out. */
export function cellBurningAt(board: Board, cell: number, minute: number): boolean {
  const field = board.solver.field;
  if (!field) return false;
  const a = field.arrivalMinutes[cell];
  if (!(a <= minute)) return false;
  if (board.suppression.extinguishedAt[cell] <= minute) return false;
  return minute < a + board.suppression.burnMinutes[cell];
}

/** A fire's burning cells at `minute` (solver source `s`), in arrival order. */
export function burningCellsOf(board: Board, s: number, minute: number): number[] {
  const field = board.solver.field;
  if (!field) return [];
  const st = board.suppression;
  const cells = field.cellsBySource[s];
  const arr = field.arrivalBySource[s];
  const end = countAtMost(arr, minute);
  const out: number[] = [];
  for (let i = countAtMost(arr, minute - st.maxBurnMinutes - 1e-6); i < end; i++) {
    const c = cells[i];
    if (st.extinguishedAt[c] <= minute) continue;
    if (minute < arr[i] + st.burnMinutes[c]) out.push(c);
  }
  return out;
}

// ---- suppression ----

/** Grid position (fractional) of a WGS84 point. */
function gridXY(grid: LandscapeGrid, p: LonLat): { x: number; y: number } {
  const [mx, my] = lonLatToMercator(p[0], p[1]);
  return { x: (mx - grid.originX) / grid.cellSizeX, y: (my - grid.originY) / grid.cellSizeY };
}

/** Longest flame, ft, the unit's work holds: an engine crew on foot holds as hand tools (Hauling chart, PMS 465 p.12). */
export function workHoldsFeet(team: Team): number {
  if (team.workMode === "hand_line" && (team.kind === "engine_t3" || team.kind === "engine_t1")) return holdsFlameFeet("hand_crew_t1");
  return holdsFlameFeet(team.kind);
}

/** Faces of `cell` toward unburned (at `minute`) ground the solver can spread into. */
function openFaces(board: Board, cell: number, minute: number): number {
  const field = board.solver.field!;
  const { width, height } = board.env.landscape;
  const x = cell % width;
  const y = (cell - x) / width;
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
    const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const m = ny * width + nx;
    if (field.behaviour.headRateMetersPerMinute[m] > 0 && !(field.arrivalMinutes[m] <= minute)) n++;
  }
  return n;
}

function statsOf(board: Board, fireId: string): FireSuppressionStats {
  let s = board.suppression.fires.get(fireId);
  if (!s) {
    s = { knockedCells: 0, moppedCells: 0, reportedKnocked: 0, reportedMopped: 0, teams: [] };
    board.suppression.fires.set(fireId, s);
  }
  return s;
}

/** Puts `cell` out at `minute`; direct attack also builds line on the unburned ground around it (holding `holdsFt`). */
function extinguish(board: Board, cell: number, minute: number, kind: WorkKind | "manual", holdsFt: number): void {
  const st = board.suppression;
  st.extinguishedAt[cell] = minute;
  st.version += 1;
  st.inert.push(cell);
  if (kind !== "direct") return;
  st.dirty = true;
  const field = board.solver.field!;
  const { width, height } = board.env.landscape;
  const x = cell % width;
  const y = (cell - x) / width;
  // 8-neighbours: the solver's diagonal step passes over no cell (fire/spread.ts buildBarrierPath).
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (st.blocked[n] || !(field.behaviour.headRateMetersPerMinute[n] > 0) || field.arrivalMinutes[n] <= minute) continue;
      st.blocked[n] = 1;
      st.blockCells.push(n);
      st.blockFrom.push(minute);
      st.blockHolds.push(holdsFt);
    }
  }
}

/** Units working `fire`'s cells at `minute` (on scene for it, not on an attack line, in reach, past any hike in), by id. */
function workersOf(board: Board, fire: Fire, minute: number): Team[] {
  return board.teams
    .filter(
      (t) =>
        t.fireId === fire.id &&
        t.lineId === null &&
        t.status === "on_scene" &&
        t.workMode !== null &&
        t.workMode !== "out_of_reach" &&
        // Indirect: holding the road it parked on, not working the fire's cells (response/reach.ts).
        t.workMode !== "indirect" &&
        (t.workStartAt === null || t.workStartAt < minute),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One whole board minute of suppression (the interval minute - 1 .. minute), called by
 * model.ts stepOnce when the clock lands on `minute`. Deterministic: units in id order, cells
 * nearest first with ties by cell index.
 */
export function suppressionTick(board: Board, minute: number): void {
  const st = board.suppression;
  if (minute <= st.minute) return;
  st.minute = minute;
  const field = board.solver.field;
  if (!field) return;
  const grid = board.env.landscape;
  const g = grid.groundCellSizeMeters;
  const working = new Set<string>();
  for (const fire of board.fires) {
    if (fire.status === "out") continue;
    const s = field.sourceIndex.get(fire.id);
    if (s === undefined) continue;
    const fr = board.response.fires.get(fire.id);
    const kind: WorkKind | null = fire.status === "contained" ? "mopup" : fr && EDGE_TACTICS.has(fr.tactic) ? "direct" : null;
    if (!kind || !fr) continue;
    const teams = workersOf(board, fire, minute);
    if (teams.length === 0) continue;
    const burning = burningCellsOf(board, s, minute);
    // Candidate cells: the burning edge (direct; with its outward flame and crowning), or every burning cell (mop-up).
    const cand: { c: number; x: number; y: number; flameFt: number }[] = [];
    for (const c of burning) {
      if (kind === "direct" && (openFaces(board, c, minute) === 0 || field.behaviour.crownType[c] !== 0)) continue;
      const x = c % grid.width;
      cand.push({ c, x, y: (c - x) / grid.width, flameFt: kind === "direct" ? frontFlameFeet(field, grid, c) : 0 });
    }
    const tactic = kind === "mopup" ? "direct" : fr.tactic;
    for (const team of teams) {
      working.add(team.id);
      let w = st.units.get(team.id);
      if (!w || w.fireId !== fire.id || w.kind !== kind) {
        w = { teamId: team.id, fireId: fire.id, kind, budgetM: 0, trail: [], target: -1, targetCostM: 0, minute };
        st.units.set(team.id, w);
      }
      w.minute = minute;
      let workedMin = Math.max(0, Math.min(1, minute - Math.max(minute - 1, team.workStartAt ?? Number.NEGATIVE_INFINITY)));
      const progressive = worksAlongEdge(team);
      if (progressive && (w.walkLeftMin ?? 0) > 0) {
        // Walking to the next stretch of edge (no line built meanwhile).
        const walked = Math.min(workedMin, w.walkLeftMin!);
        w.walkLeftMin! -= walked;
        workedMin -= walked;
        if (w.walkLeftMin! > 1e-9) continue;
      }
      const rate = tacticLineRate(board, fire, [team], tactic);
      if (rate <= 0 || workedMin <= 0) continue;
      w.budgetM += rate * workedMin;
      const holds = workHoldsFeet(team);
      const home = gridXY(grid, team.position);
      const reachCells = team.reachM / g;
      const reach2 = reachCells * reachCells;
      const dozer = team.kind === "dozer_t2";
      for (;;) {
        // Where it stands: the cell it walked to, else the last cell it put out, else where it parked.
        const last = progressive && (w.walkTo ?? -1) >= 0 ? w.walkTo! : w.trail.length ? w.trail[w.trail.length - 1] : -1;
        const from = last >= 0 ? { x: last % grid.width, y: Math.floor(last / grid.width) } : home;
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < cand.length; i++) {
          const q = cand[i];
          if (st.extinguishedAt[q.c] <= minute) continue;
          if (kind === "direct" && q.flameFt > holds) continue;
          // Engines work within reach of where they parked; hand crews and dozers anywhere on the edge (progressive line).
          if (!progressive && (q.x - home.x) ** 2 + (q.y - home.y) ** 2 > reach2) continue;
          // PMS 465 p.140: dozers work up to DOZER_MAX_SLOPE_PCT.
          if (dozer && grid.slopeTangent[q.c] * 100 > DOZER_MAX_SLOPE_PCT) continue;
          const d = (q.x - from.x) ** 2 + (q.y - from.y) ** 2;
          if (d < bestD || (d === bestD && q.c < cand[best].c)) {
            bestD = d;
            best = i;
          }
        }
        if (best < 0) {
          // Nothing within reach it can work: no line is banked.
          w.target = -1;
          w.targetCostM = 0;
          w.budgetM = 0;
          break;
        }
        const c = cand[best].c;
        const cost = kind === "direct" ? Math.max(1, openFaces(board, c, minute)) * g * LATTICE_PERIMETER_TO_SMOOTH : MOPUP_CELL_WIDTHS * g;
        w.target = c;
        w.targetCostM = cost;
        if (progressive) {
          // The first cell within its reach of where it parked is where its hike in ended (workStartAt); later
          // cells beyond the next stretch of its line are walked to first.
          const hopCells = Math.sqrt(bestD);
          const firstInReach = last < 0 && bestD <= reach2;
          if (!firstInReach && hopCells > PROGRESSIVE_STEP_CELLS) {
            const fromCell = last >= 0 ? last : Math.round(home.y) * grid.width + Math.round(home.x);
            const rise = fromCell >= 0 && fromCell < grid.elevationMeters.length ? grid.elevationMeters[c] - grid.elevationMeters[fromCell] : 0;
            const walk = dozer ? dozerWalkMinutes(hopCells * g) : hikeMinutes(hopCells * g, rise);
            w.budgetM = 0;
            if (walk > (dozer ? DOZER_MAX_WALK_MINUTES : HAND_CREW_MAX_HIKE_MINUTES)) {
              w.target = -1;
              w.targetCostM = 0;
            } else {
              w.walkTo = c;
              w.walkLeftMin = walk;
            }
            break;
          }
        }
        if (w.budgetM + 1e-9 < cost) break;
        w.budgetM -= cost;
        extinguish(board, c, minute, kind, holds);
        w.walkTo = -1;
        w.trail.push(c);
        if (w.trail.length > TRAIL_CELLS) w.trail.shift();
        const stats = statsOf(board, fire.id);
        if (kind === "direct") stats.knockedCells += 1;
        else stats.moppedCells += 1;
        if (!stats.teams.includes(team.id)) stats.teams.push(team.id);
      }
    }
  }
  for (const id of [...st.units.keys()]) if (!working.has(id)) st.units.delete(id);

  // The knocked-down edge enters the solver in batches (KNOCKDOWN_RESOLVE_MINUTES).
  if (st.dirty && minute % KNOCKDOWN_RESOLVE_MINUTES === 0) {
    st.committedBlocks = st.blockCells.length;
    st.committedInert = st.inert.length;
    st.commits += 1;
    st.dirty = false;
  }
  if (minute % KNOCKDOWN_REPORT_MINUTES === 0) reportKnockdown(board);
}

/**
 * Feed lines: each fire's knockdown and mop-up since the last report (simulated). Every
 * KNOCKDOWN_REPORT_MINUTES, and for one fire (`only`) when it is contained or goes out
 * (model.ts), so its tally comes before that line.
 */
export function reportKnockdown(board: Board, only?: string): void {
  const cellHa = board.env.landscape.groundCellSizeMeters ** 2 / SQUARE_METERS_PER_HECTARE;
  for (const [fireId, s] of board.suppression.fires) {
    if (only !== undefined && fireId !== only) continue;
    const knocked = s.knockedCells - s.reportedKnocked;
    const mopped = s.moppedCells - s.reportedMopped;
    if (knocked <= 0 && mopped <= 0) continue;
    const teams = [...s.teams].sort();
    s.reportedKnocked = s.knockedCells;
    s.reportedMopped = s.moppedCells;
    s.teams = [];
    if (knocked > 0) {
      const ha = knocked * cellHa;
      logEvent(board, "team", "board", `${fireId}: crews knocked down ${ha.toFixed(1)} ha of burning edge (${teams.join(", ")}); that edge stops advancing.`, {
        action: "knocked_down",
        fireId,
        areaHa: ha,
        teamIds: teams,
      });
    }
    if (mopped > 0) {
      const ha = mopped * cellHa;
      logEvent(board, "team", "board", `${fireId}: mop-up put out ${ha.toFixed(1)} ha still burning inside the line (${teams.join(", ")}).`, {
        action: "mopped_up",
        fireId,
        areaHa: ha,
        teamIds: teams,
      });
    }
  }
}

/** Closing a fire by hand puts its burning cells out now (model.ts closeFire). */
export function extinguishFire(board: Board, fire: Fire): void {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return;
  for (const c of burningCellsOf(board, s, board.minute)) extinguish(board, c, board.minute, "manual", 0);
}

/** A fire's open edge and the part of it that holds (see the header, "Held edge"), metres (the perimeter measure, faces x g x pi/4). */
export interface HeldEdge {
  openM: number;
  heldM: number;
  /** heldM / openM (1 when the fire has no open edge). */
  share: number;
}

const heldCache = new WeakMap<Board, { field: unknown; minute: number; version: number; byFire: Map<string, HeldEdge> }>();

/** `fire`'s open edge at board.minute and how much of it holds (null when it is not a solver source). */
export function heldEdge(board: Board, fire: Fire): HeldEdge | null {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return null;
  const st = board.suppression;
  let cache = heldCache.get(board);
  if (!cache || cache.field !== field || cache.minute !== board.minute || cache.version !== st.version) {
    cache = { field, minute: board.minute, version: st.version, byFire: new Map() };
    heldCache.set(board, cache);
  }
  const hit = cache.byFire.get(fire.id);
  if (hit) return hit;
  const { width, height } = board.env.landscape;
  const t = board.minute;
  const arrival = field.arrivalMinutes;
  const passable = field.behaviour.headRateMetersPerMinute;
  const cells = field.cellsBySource[s];
  const n = countAtMost(field.arrivalBySource[s], t);
  // Knocked-down cells the field does not include yet (committed every KNOCKDOWN_RESOLVE_MINUTES, then re-solved)
  // count as held until the forecast says otherwise.
  const stale = field.lineKey !== lineKey(board);
  const pending = new Set(st.inert.slice(st.committedInert));
  let open = 0;
  let held = 0;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const put = st.extinguishedAt[c] <= t;
    const out = put && (stale || pending.has(c));
    const x = c % width;
    const y = (c - x) / width;
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
      const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        // Off the board: open (fireField.ts counts it), held only where the cell was put out.
        open++;
        if (put) held++;
        continue;
      }
      const m = ny * width + nx;
      if (!(passable[m] > 0) || arrival[m] <= t) continue;
      open++;
      // The forecast never burns the ground beyond (within its lookahead), or knocked down and not yet in the forecast.
      if (out || !(arrival[m] <= field.horizonMinutes)) held++;
    }
  }
  const metersPerFace = board.env.landscape.groundCellSizeMeters * LATTICE_PERIMETER_TO_SMOOTH;
  const value: HeldEdge = { openM: open * metersPerFace, heldM: held * metersPerFace, share: open > 0 ? held / open : 1 };
  cache.byFire.set(fire.id, value);
  return value;
}

/** Units that put out cells of `fireId` (or walked to its next stretch) in the last suppression minute, by id. */
export function unitsWorking(board: Board, fireId: string): string[] {
  const st = board.suppression;
  return [...st.units.values()].filter((w) => w.fireId === fireId && w.minute === st.minute && (w.target >= 0 || (w.walkLeftMin ?? 0) > 0)).map((w) => w.teamId).sort();
}

/** Burning cells of `fire` at `minute` (0 when it is not a solver source). */
export function burningCellCount(board: Board, fire: Fire, minute = board.minute): number {
  const s = board.solver.field?.sourceIndex.get(fire.id);
  return s === undefined ? 0 : burningCellsOf(board, s, minute).length;
}

// ---- what the solver takes ----

/** Part of model.ts lineKey: which knocked-down edge the solver has. */
export function knockdownKey(board: Board): string {
  return board.suppression.commits > 0 ? `kd:${board.suppression.commits}` : "";
}

/** Committed knocked-down edge as built-line cells (model.ts builtLineCells merges them). */
export function knockdownLineCells(board: Board): { cells: number[]; minutes: number[]; holds: number[] } {
  const st = board.suppression;
  const n = st.committedBlocks;
  return { cells: st.blockCells.slice(0, n), minutes: st.blockFrom.slice(0, n), holds: st.blockHolds.slice(0, n) };
}

/** Committed put-out cells for the solver's inert list (fireField.ts FireSolveRequest.inertCells), or null. */
export function inertCellsForSolve(board: Board): Int32Array | null {
  const st = board.suppression;
  return st.committedInert > 0 ? Int32Array.from(st.inert.slice(0, st.committedInert)) : null;
}

/** Whether the solver has knocked-down edge of `fireId` (model.ts heldByLine: line around the fire). */
export function hasKnockdown(board: Board, fireId: string): boolean {
  return (board.suppression.fires.get(fireId)?.knockedCells ?? 0) > 0 && board.suppression.commits > 0;
}
