/**
 * What is on fire on the command board now, per landscape cell: unburned, burning, burned out
 * or put out by suppression. Read API for the map, the 3D board and the observation; the
 * rules and rates are in demo/suppression.ts (docs/response-model.md, "Cell fire state and
 * suppression"). Pure: no React, map library or network. Simulated: every state is a model
 * output (the solver's arrival field, Anderson 1969 residence time, sourced line production).
 *
 * A cell (row-major on board.env.landscape) at board minute t, with arrival a (fireField.ts),
 * burn duration D (suppression.ts burnMinutes) and suppression minute e:
 * - unburned: the fire has not reached it (a > t);
 * - extinguished: put out by suppression by t (e <= t), before it burned out;
 * - burning: a <= t < a + D;
 * - burned_out: t >= a + D (its modelled fuel has finished flaming).
 * Deterministic for a board state: the same seed, Studio fires and orders give the same states
 * at a board minute whatever the playback speed (suppression is applied at whole minutes).
 *
 * Coordinates WGS84 [lon, lat]; directions local metres [east, north]; areas hectares.
 */

import type { MultiPolygon, Position } from "geojson";
import { contourArrival } from "../fire/spread";
import type { LandscapeGrid } from "../fire/landscape";
import { countAtMost } from "./fireField";
import { cellLonLat, type Board, type Fire } from "./model";
import { spreadDirection } from "./attack";
import { outwardDirection } from "./suppression";

export type CellFireState = "unburned" | "burning" | "burned_out" | "extinguished";
export const CELL_STATE_CODE: Record<CellFireState, number> = { unburned: 0, burning: 1, burned_out: 2, extinguished: 3 };

const SQUARE_METERS_PER_HECTARE = 10_000;
const UNBURNED = CELL_STATE_CODE.unburned;
const BURNING = CELL_STATE_CODE.burning;
const BURNED_OUT = CELL_STATE_CODE.burned_out;
const EXTINGUISHED = CELL_STATE_CODE.extinguished;

/** State code of one cell at `minute` (CELL_STATE_CODE). */
export function cellStateCode(board: Board, cell: number, minute = board.minute): number {
  const field = board.solver.field;
  if (!field) return UNBURNED;
  const a = field.arrivalMinutes[cell];
  if (!(a <= minute)) return UNBURNED;
  const st = board.suppression;
  if (st.extinguishedAt[cell] <= minute) return EXTINGUISHED;
  const d = st.burnMinutes[cell];
  return d >= 0 && minute < a + d ? BURNING : BURNED_OUT;
}

interface StateCache {
  field: unknown;
  minute: number;
  version: number;
  codes: Uint8Array;
  box: Record<number, { minX: number; maxX: number; minY: number; maxY: number } | null>;
}
const stateCache = new WeakMap<Board, StateCache>();

function states(board: Board): StateCache {
  const field = board.solver.field;
  const hit = stateCache.get(board);
  if (hit && hit.field === field && hit.minute === board.minute && hit.version === board.suppression.version) return hit;
  const grid = board.env.landscape;
  const n = grid.width * grid.height;
  const codes = new Uint8Array(n);
  const box: StateCache["box"] = { [BURNING]: null, [BURNED_OUT]: null, [EXTINGUISHED]: null };
  if (field) {
    const t = board.minute;
    const arrival = field.arrivalMinutes;
    const ext = board.suppression.extinguishedAt;
    const D = board.suppression.burnMinutes;
    for (let c = 0; c < n; c++) {
      const a = arrival[c];
      if (!(a <= t)) continue;
      const code = ext[c] <= t ? EXTINGUISHED : D[c] >= 0 && t < a + D[c] ? BURNING : BURNED_OUT;
      codes[c] = code;
      const x = c % grid.width;
      const y = (c - x) / grid.width;
      const b = box[code];
      if (!b) box[code] = { minX: x, maxX: x, minY: y, maxY: y };
      else {
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        if (y > b.maxY) b.maxY = y;
      }
    }
  }
  const out: StateCache = { field, minute: board.minute, version: board.suppression.version, codes, box };
  stateCache.set(board, out);
  return out;
}

/**
 * Per landscape cell (board.env.landscape grid, row-major), as CELL_STATE_CODE, at board.minute.
 * Cached per field, minute and suppression version: the same array is returned until one of them
 * changes, then a new one (so identity tells a caller the states changed). Do not mutate it.
 */
export function fireCellStates(board: Board): Uint8Array {
  return states(board).codes;
}

const scratchByGrid = new WeakMap<LandscapeGrid, Float64Array>();
const polygonCache = new WeakMap<Board, { field: unknown; minute: number; version: number; value: FireStatePolygons }>();

export type FireStatePolygons = Record<Exclude<CellFireState, "unburned">, MultiPolygon>;

/**
 * Polygons (WGS84 [lon, lat] rings, outer ring first in each polygon, then holes) per state for
 * the 2D map, at board.minute, contoured with the solver's own marching squares
 * (fire/spread.ts contourArrival) over the cells in that state. Only burning, burned_out and
 * extinguished.
 */
export function fireStatePolygons(board: Board): FireStatePolygons {
  const field = board.solver.field;
  const hit = polygonCache.get(board);
  if (hit && hit.field === field && hit.minute === board.minute && hit.version === board.suppression.version) return hit.value;
  const s = states(board);
  const grid = board.env.landscape;
  let scratch = scratchByGrid.get(grid);
  if (!scratch) {
    scratch = new Float64Array(grid.width * grid.height).fill(Number.POSITIVE_INFINITY);
    scratchByGrid.set(grid, scratch);
  }
  const of = (code: number): MultiPolygon => {
    const box = s.box[code];
    if (!box) return { type: "MultiPolygon", coordinates: [] };
    const cells: number[] = [];
    for (let y = box.minY; y <= box.maxY; y++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        const c = y * grid.width + x;
        if (s.codes[c] === code) {
          scratch![c] = 0;
          cells.push(c);
        }
      }
    }
    const polygons = contourArrival(grid, scratch!, 0, box);
    for (const c of cells) scratch![c] = Number.POSITIVE_INFINITY;
    return { type: "MultiPolygon", coordinates: polygons.map((p) => p.geometry.coordinates as Position[][]) };
  };
  const value: FireStatePolygons = { burning: of(BURNING), burned_out: of(BURNED_OUT), extinguished: of(EXTINGUISHED) };
  polygonCache.set(board, { field, minute: board.minute, version: board.suppression.version, value });
  return value;
}

/** One fire's ground by state at board.minute, hectares (0s when it is not a solver source). */
export interface FireStateAreas {
  burningHa: number;
  burnedOutHa: number;
  extinguishedHa: number;
}

export function fireStateAreas(board: Board, fire: Fire): FireStateAreas {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return { burningHa: 0, burnedOutHa: 0, extinguishedHa: 0 };
  const codes = states(board).codes;
  const cells = field.cellsBySource[s];
  const n = countAtMost(field.arrivalBySource[s], board.minute);
  let burning = 0;
  let out = 0;
  let ext = 0;
  for (let i = 0; i < n; i++) {
    const code = codes[cells[i]];
    if (code === BURNING) burning++;
    else if (code === EXTINGUISHED) ext++;
    else if (code === BURNED_OUT) out++;
  }
  const ha = board.env.landscape.groundCellSizeMeters ** 2 / SQUARE_METERS_PER_HECTARE;
  return { burningHa: burning * ha, burnedOutHa: out * ha, extinguishedHa: ext * ha };
}

// ---- crews at work (animation) ----

/**
 * A unit working a fire's edge now: the path along the edge segment it works (WGS84), how far
 * along it is (0..1), and the inward direction (unit vector, local metres [east, north]) the
 * put-out edge moves.
 * - direct: knocking down the burning edge (suppression.ts): the cells it put out on this
 *   assignment, oldest first, then the cell it works now; progress = its line toward that cell.
 * - mopup: putting out burning cells inside a contained fire (same path rule).
 * - line: building an attack line (model.ts AttackLine): path end a, anchor, end b; progress =
 *   built / length; inward = against the forecast spread at the position.
 */
export interface CrewWork {
  teamId: string;
  fireId: string;
  kind: "direct" | "line" | "mopup";
  path: [number, number][];
  progress: number;
  inward: [number, number];
}

const crewCache = new WeakMap<Board, { minute: number; version: number; value: CrewWork[] }>();

export function crewWork(board: Board): CrewWork[] {
  const hit = crewCache.get(board);
  // Line building moves every step; the cell work changes at whole minutes (version).
  if (hit && hit.minute === board.minute && hit.version === board.suppression.version) return hit.value;
  const grid = board.env.landscape;
  const field = board.solver.field;
  const out: CrewWork[] = [];
  const byId = new Map(board.teams.map((t) => [t.id, t]));
  for (const w of [...board.suppression.units.values()].sort((a, b) => a.teamId.localeCompare(b.teamId))) {
    const team = byId.get(w.teamId);
    if (!team || team.status !== "on_scene" || team.fireId !== w.fireId) continue;
    const cells = w.target >= 0 && w.trail.at(-1) !== w.target ? [...w.trail, w.target] : [...w.trail];
    if (cells.length === 0) continue;
    const path = cells.map((c) => cellLonLat(grid, c) as [number, number]);
    if (path.length === 1) path.unshift(team.position as [number, number]);
    const part = w.target >= 0 && w.targetCostM > 0 ? Math.min(1, w.budgetM / w.targetCostM) : 1;
    const steps = path.length - 1;
    const progress = w.target >= 0 && cells.at(-1) === w.target ? (steps - 1 + part) / steps : 1;
    const at = w.target >= 0 ? w.target : cells[cells.length - 1];
    // Smooth local direction for drawing (attack.ts radius-2 arrival gradient), else the upwind one.
    const d = field ? (spreadDirection(grid, field.arrivalMinutes, at) ?? outwardDirection(grid, field.arrivalMinutes, at)) : null;
    // Grid y is south: outward [east, north] = [d.x, -d.y]; inward is its opposite.
    const inward: [number, number] = d ? [-d.x, d.y] : [0, 0];
    out.push({ teamId: w.teamId, fireId: w.fireId, kind: w.kind, path, progress: Math.max(0, Math.min(1, progress)), inward });
  }
  for (const line of board.lines) {
    if (line.completedAt !== null) continue;
    const crew = board.teams.filter((t) => t.lineId === line.id && t.status === "on_scene").sort((a, b) => a.id.localeCompare(b.id));
    if (crew.length === 0) continue;
    const th = (line.plan.spreadTowardDeg * Math.PI) / 180;
    const inward: [number, number] = [-Math.sin(th), -Math.cos(th)];
    const path: [number, number][] = [line.plan.a, line.plan.point, line.plan.b].map((p) => [p[0], p[1]]);
    const progress = line.lengthM > 0 ? Math.min(1, line.builtM / line.lengthM) : 1;
    for (const t of crew) out.push({ teamId: t.id, fireId: line.fireId, kind: "line", path, progress, inward });
  }
  crewCache.set(board, { minute: board.minute, version: board.suppression.version, value: out });
  return out;
}
