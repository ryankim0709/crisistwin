/**
 * Predictive (indirect) attack on the command board: where to put line ahead of a fire, read
 * from the fire solver's lookahead arrival field (fireField.ts), and the built line as the
 * solver's control lines (fire/spread.ts ControlLines). Pure: no React, worker or network.
 * See docs/command-demo-realism.md, "Predictive attack and control lines".
 *
 * Positions per burning fire (`planAttackPositions`), every one a cell of the solver's forecast:
 * - `head_<t>`: the fire's leading front cell at now + t minutes (fireField.fireGeometry at that
 *   minute: the burned cell farthest from the ignition that still faces unburned fuel), for t in
 *   HEAD_LEAD_MINUTES.
 * - `flank_left` / `flank_right`: the front cells at now + FLANK_LEAD_MINUTES farthest to the
 *   left / right of the fire's spread axis (ignition to forecast head), facing the direction of
 *   spread.
 * - `zone_<id>`: the cell where this fire first reaches a zone (structure protection), for the
 *   MAX_ZONE_POSITIONS zones it reaches first within FORECAST_LOOK_MINUTES.
 * Each position's line runs across the local spread direction (at a head the solver's direction
 * of maximum spread at that cell; elsewhere the arrival field's gradient), through the position,
 * as far each way as the forecast burns across that line within LINE_SIZING_MINUTES of the fire
 * reaching the position (so it ends where the fire's front would not reach in that time, or at
 * ground that carries no fire, a natural anchor), plus one cell, and
 * at most MAX_LINE_HALF_M each way.
 *
 * Units: minutes are board minutes (the solver's); metres ground metres; flame feet; bearings
 * degrees true, clockwise from north. Grid coordinates: column x east, row y south.
 */

import type { LandscapeGrid } from "../fire/landscape";
import { lonLatToMercator, mercatorToLonLat } from "../fire/landscape";
import { BYRAM_FLAME_EXPONENT, cellAt } from "../fire/spread";
import type { LonLat } from "../live/types";
import { countAtMost, fireGeometry, type FireSolveResult, type ZoneCells } from "./fireField";

/** Head positions: where the head is forecast this many minutes from now. ASSUMPTION (choice of look-ahead). */
export const HEAD_LEAD_MINUTES = [30, 60] as const;
/** Flank positions: the flanks' forecast front this many minutes from now. ASSUMPTION. */
export const FLANK_LEAD_MINUTES = 30;
/** A position the fire reaches sooner than this is not offered (a unit cannot get ahead of it). ASSUMPTION. */
export const POSITION_MIN_LEAD_MINUTES = 5;
/** Zone positions consider contacts within this many minutes (the board's forecast window). */
export const FORECAST_LOOK_MINUTES = 120;
/** At most this many zone-protection positions per fire, earliest contact first. */
export const MAX_ZONE_POSITIONS = 2;
/**
 * Line length: the line spans what the forecast burns across it within this many minutes of the
 * fire reaching the position. ASSUMPTION (how long the line has to stop the front passing it).
 */
export const LINE_SIZING_MINUTES = 60;
/** Cap on each half of a line, metres. ASSUMPTION (a line is a few unit-hours of work, not a perimeter). */
export const MAX_LINE_HALF_M = 750;
/** Cells either side of a cell used for the arrival-field gradient (local spread direction). */
export const GRADIENT_RADIUS_CELLS = 2;
/**
 * Built line enters the solver in chunks of this many metres (or when the line is finished):
 * the board re-solves, resuming from the burned ground, each time a chunk completes. ASSUMPTION
 * (a trade between solve count and how promptly the forecast sees new line).
 */
export const LINE_RESOLVE_CHUNK_M = 100;
/** Positions are re-planned from the field at most this often, board minutes (and on every new solve). */
export const POSITION_REPLAN_MINUTES = 10;

export type AttackKind = "head" | "flank_left" | "flank_right" | "zone";

/** One candidate line position, from the solver field. */
export interface AttackPlan {
  /** "head_30", "head_60", "flank_left", "flank_right" or "zone_<zone id>". */
  id: string;
  kind: AttackKind;
  /** Grid cell of the position (the line's anchor point: units drive here and build outward). */
  cell: number;
  point: LonLat;
  /** Line ends, WGS84; `aM` / `bM` metres from `point` to each end. */
  a: LonLat;
  b: LonLat;
  aM: number;
  bM: number;
  /** Forecast spread direction at the position (arrival gradient), degrees true. */
  spreadTowardDeg: number;
  /** Solver's directional rate toward that direction at the cell, m/min, and Byram flame there, ft. */
  spreadMPerMin: number;
  flameFt: number;
  /** The cell torches or crowns at the solver's weather: no ground line holds it. */
  crowning: boolean;
  fuelCode: number;
  slopePercent: number;
  /** Zones this line stands in front of (see `protectsZones`). */
  protectsZoneIds: string[];
}

interface Vec {
  x: number;
  y: number;
}

const xy = (grid: LandscapeGrid, cell: number): Vec => {
  const x = cell % grid.width;
  return { x, y: (cell - x) / grid.width };
};

/** WGS84 of a (fractional) grid position; cell centres sit on whole coordinates (landscape.ts). */
export function gridLonLat(grid: LandscapeGrid, p: Vec): LonLat {
  return mercatorToLonLat(grid.originX + p.x * grid.cellSizeX, grid.originY + p.y * grid.cellSizeY);
}

/** Compass bearing (degrees true) of a grid direction (x east, y south). */
function bearingOf(d: Vec): number {
  return ((((Math.atan2(d.x, -d.y) * 180) / Math.PI) % 360) + 360) % 360;
}

/**
 * Local spread direction at `cell`: the gradient of the arrival field (direction of increasing
 * arrival), a least-squares-style sum over cells within GRADIENT_RADIUS_CELLS that the fire
 * reaches within the horizon. Unit vector in grid coordinates, or null when undefined there.
 */
export function spreadDirection(grid: LandscapeGrid, arrival: Float32Array, cell: number): Vec | null {
  const { x, y } = xy(grid, cell);
  const a0 = arrival[cell];
  if (!Number.isFinite(a0)) return null;
  let gx = 0;
  let gy = 0;
  const r = GRADIENT_RADIUS_CELLS;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const an = arrival[ny * grid.width + nx];
      if (!Number.isFinite(an)) continue;
      const w = (an - a0) / (dx * dx + dy * dy);
      gx += w * dx;
      gy += w * dy;
    }
  }
  const n = Math.hypot(gx, gy);
  return n > 1e-9 ? { x: gx / n, y: gy / n } : null;
}

/**
 * Rate (m/min) and surface flame (ft) the solver's spread at `cell` has toward the bearing
 * `towardRad`: its elliptical directional rate (the inline formula of fire/spread.ts's relaxation,
 * R (1 - e) / (1 - e cos(theta - heading)), floored at the backing rate) and Byram's (1959)
 * flame-intensity scaling L_head (R_dir / R_head)^0.46 (spread.ts BYRAM_FLAME_EXPONENT), as the
 * solver judges a line breach.
 */
export function directionalBehaviour(field: FireSolveResult, cell: number, towardRad: number): { rate: number; flameFt: number } {
  const b = field.behaviour;
  const rate = b.headRateMetersPerMinute[cell];
  if (rate <= 0) return { rate: 0, flameFt: 0 };
  const e = b.eccentricity[cell];
  let toward = e > 0 ? (rate * (1 - e)) / (1 - e * Math.cos(towardRad - b.headingRadians[cell])) : rate;
  toward = Math.max(toward, b.minDirectionalRateMetersPerMinute[cell]);
  const flameFt = b.headFlameFeet[cell] * Math.pow(Math.min(1, toward / rate), BYRAM_FLAME_EXPONENT);
  return { rate: toward, flameFt };
}

/**
 * Metres from `p` along unit direction `w` (grid coordinates) over which the forecast reaches
 * the line within LINE_SIZING_MINUTES of reaching `p`: stepped half a cell at a time, stopping at
 * the first cell the fire does not reach by then, ground that carries no fire, or the grid edge.
 */
function crossSectionM(grid: LandscapeGrid, field: FireSolveResult, p: Vec, w: Vec, untilMinute: number): number {
  const g = grid.groundCellSizeMeters;
  const maxSteps = Math.ceil((MAX_LINE_HALF_M / g) * 2);
  let reach = 0;
  for (let k = 1; k <= maxSteps; k++) {
    const x = Math.round(p.x + (w.x * k) / 2);
    const y = Math.round(p.y + (w.y * k) / 2);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) break;
    const c = y * grid.width + x;
    if (field.behaviour.headRateMetersPerMinute[c] <= 0 || !(field.arrivalMinutes[c] <= untilMinute)) break;
    reach = (k / 2) * g;
  }
  // One cell past the last reached cell, so the line closes the front there.
  return Math.min(MAX_LINE_HALF_M, reach + g);
}

/**
 * Zones a line at `plan` stands in front of: the zones this source first reaches later than the
 * position, at a first-contact point ahead of the line (along the spread direction) and within
 * its span across. A geometric reading of the forecast, not a re-solve with the line.
 */
function protectsZones(
  grid: LandscapeGrid,
  field: FireSolveResult,
  source: number,
  p: Vec,
  d: Vec,
  aCells: number,
  bCells: number,
  contacts: { zoneId: string; cell: number; arrival: number }[],
): string[] {
  const w = { x: -d.y, y: d.x };
  const atP = field.arrivalMinutes[p.y * grid.width + p.x];
  const out: string[] = [];
  for (const c of contacts) {
    if (!(c.arrival > atP) || field.sourceIndexByCell[c.cell] !== source) continue;
    const q = xy(grid, c.cell);
    const ahead = (q.x - p.x) * d.x + (q.y - p.y) * d.y;
    const across = (q.x - p.x) * w.x + (q.y - p.y) * w.y;
    if (ahead > 0 && across >= -aCells && across <= bCells) out.push(c.zoneId);
  }
  return out;
}

/** Front cells of `source` at `minute`: burned by then and facing passable ground still unburned. */
function frontCells(field: FireSolveResult, grid: LandscapeGrid, source: number, minute: number): number[] {
  const cells = field.cellsBySource[source];
  const n = countAtMost(field.arrivalBySource[source], minute);
  const { width, height } = grid;
  const arrival = field.arrivalMinutes;
  const passable = field.behaviour.headRateMetersPerMinute;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const x = c % width;
    const y = (c - x) / width;
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
      const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const m = ny * width + nx;
      if (passable[m] > 0 && !(arrival[m] <= minute)) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}

/**
 * Candidate line positions for one burning fire (solver source `source`, ignition cell
 * `originCell`) as the field forecasts it from `minute`. Positions the fire reaches within
 * POSITION_MIN_LEAD_MINUTES, or not at all, are left out. Deterministic for a field and minute.
 */
export function planAttackPositions(
  field: FireSolveResult,
  grid: LandscapeGrid,
  source: number,
  originCell: number,
  minute: number,
  zones: ReadonlyMap<string, ZoneCells>,
): AttackPlan[] {
  const arrival = field.arrivalMinutes;
  const owner = field.sourceIndexByCell;
  const g = grid.groundCellSizeMeters;
  const origin = originCell >= 0 ? xy(grid, originCell) : null;
  const horizon = field.horizonMinutes;

  // First contact of this fire with each zone (within the forecast window, still ahead).
  const contacts: { zoneId: string; cell: number; arrival: number }[] = [];
  for (const [zoneId, z] of zones) {
    let best = -1;
    for (const c of z.cells) if (owner[c] === source && (best < 0 || arrival[c] < arrival[best])) best = c;
    if (best >= 0 && arrival[best] - minute <= FORECAST_LOOK_MINUTES) contacts.push({ zoneId, cell: best, arrival: arrival[best] });
  }
  contacts.sort((p, q) => p.arrival - q.arrival || p.zoneId.localeCompare(q.zoneId));

  const plans: AttackPlan[] = [];
  const used = new Set<number>();
  const add = (id: string, kind: AttackKind, cell: number, fallback: Vec | null) => {
    if (cell < 0 || used.has(cell)) return;
    if (owner[cell] !== source || !(arrival[cell] - minute >= POSITION_MIN_LEAD_MINUTES)) return;
    const p = xy(grid, cell);
    // A head runs along the solver's direction of maximum spread at its cell (Rothermel wind and
    // slope vectors); elsewhere the front moves along the arrival field's gradient, which near an
    // ember-started island or a finger is a local feature, so heads do not use it.
    const h = field.behaviour.headingRadians[cell];
    const heading = field.behaviour.headRateMetersPerMinute[cell] > 0 ? { x: Math.sin(h), y: -Math.cos(h) } : null;
    let d = kind === "head" ? (heading ?? spreadDirection(grid, arrival, cell)) : (spreadDirection(grid, arrival, cell) ?? fallback);
    if (!d && origin && (p.x !== origin.x || p.y !== origin.y)) {
      const n = Math.hypot(p.x - origin.x, p.y - origin.y);
      d = { x: (p.x - origin.x) / n, y: (p.y - origin.y) / n };
    }
    if (!d) d = { x: Math.sin(h), y: -Math.cos(h) };
    // The line runs across the spread: w is d turned 90° (right of the spread direction is +w).
    const w = { x: -d.y, y: d.x };
    const until = Math.min(horizon, arrival[cell] + LINE_SIZING_MINUTES);
    const aM = crossSectionM(grid, field, p, { x: -w.x, y: -w.y }, until);
    const bM = crossSectionM(grid, field, p, w, until);
    const toward = Math.atan2(d.x, -d.y);
    const { rate, flameFt } = directionalBehaviour(field, cell, toward);
    used.add(cell);
    plans.push({
      id,
      kind,
      cell,
      point: gridLonLat(grid, p),
      a: gridLonLat(grid, { x: p.x - (w.x * aM) / g, y: p.y - (w.y * aM) / g }),
      b: gridLonLat(grid, { x: p.x + (w.x * bM) / g, y: p.y + (w.y * bM) / g }),
      aM,
      bM,
      spreadTowardDeg: bearingOf(d),
      spreadMPerMin: rate,
      flameFt,
      crowning: field.behaviour.crownType[cell] !== 0,
      fuelCode: grid.fuelCodes[cell],
      slopePercent: grid.slopeTangent[cell] * 100,
      protectsZoneIds:
        kind === "zone"
          ? [id.slice("zone_".length)]
          : protectsZones(grid, field, source, p, d, aM / g, bM / g, contacts),
    });
  };

  // Heads.
  let axis: Vec | null = null;
  for (const t of HEAD_LEAD_MINUTES) {
    if (minute + t > horizon) continue;
    const front = fireGeometry(field, grid, source, originCell, minute + t).front;
    if (front.cell < 0) continue;
    if (origin && !axis) {
      const p = xy(grid, front.cell);
      const n = Math.hypot(p.x - origin.x, p.y - origin.y);
      if (n > 0) axis = { x: (p.x - origin.x) / n, y: (p.y - origin.y) / n };
    }
    add(`head_${t}`, "head", front.cell, null);
  }

  // Flanks: extreme front cells across the spread axis at now + FLANK_LEAD_MINUTES.
  if (origin && axis && minute + FLANK_LEAD_MINUTES <= horizon) {
    const right = { x: -axis.y, y: axis.x };
    let left = -1, leftV = Infinity, rightC = -1, rightV = -Infinity;
    for (const c of frontCells(field, grid, source, minute + FLANK_LEAD_MINUTES)) {
      if (!(arrival[c] - minute >= POSITION_MIN_LEAD_MINUTES)) continue;
      const p = xy(grid, c);
      const v = (p.x - origin.x) * right.x + (p.y - origin.y) * right.y;
      if (v < leftV || (v === leftV && c < left)) [left, leftV] = [c, v];
      if (v > rightV || (v === rightV && c < rightC)) [rightC, rightV] = [c, v];
    }
    // Facing out from the axis when the field gives no gradient there.
    if (leftV < 0) add("flank_left", "flank_left", left, { x: -right.x, y: -right.y });
    if (rightV > 0) add("flank_right", "flank_right", rightC, right);
  }

  // Structure protection at the zones it reaches first.
  for (const c of contacts.slice(0, MAX_ZONE_POSITIONS)) add(`zone_${c.zoneId}`, "zone", c.cell, null);
  return plans;
}

// ---- line on the grid ----

/** A line rasterised: its cells, each with the built length at which it is finished. */
export interface LineCells {
  cells: Int32Array;
  /** Metres of line built (from the anchor point outward, both ways) when this cell is done; ascending. */
  needM: Float32Array;
}

/**
 * Built metres needed to reach `o` metres along one side when the other side is `other` metres
 * long: crews build outward from the anchor both ways at once, then finish the longer side.
 */
export function needMetres(o: number, other: number): number {
  return o + Math.min(o, other);
}

/** How far each side reaches after `builtM` metres (inverse of needMetres). */
export function builtExtent(builtM: number, aM: number, bM: number): { a: number; b: number } {
  const short = Math.min(aM, bM);
  if (builtM <= 2 * short) return { a: Math.min(aM, builtM / 2), b: Math.min(bM, builtM / 2) };
  const r = Math.min(Math.max(aM, bM), builtM - short);
  return aM <= bM ? { a: aM, b: r } : { a: r, b: bM };
}

/**
 * Cells of the line `a`-`p`-`b` as a 4-connected chain (a diagonal step adds the cell beside it),
 * so the solver's 8-neighbour and longer steps cannot slip between its cells (fire/spread.ts
 * buildBarrierPath checks the cells a step passes over; a diagonal neighbour step passes none).
 */
export function rasterLine(grid: LandscapeGrid, p: LonLat, a: LonLat, b: LonLat, aM: number, bM: number): LineCells {
  const pc = cellAt(grid, { longitude: p[0], latitude: p[1] });
  if (pc < 0) return { cells: new Int32Array(0), needM: new Float32Array(0) };
  const P = xy(grid, pc);
  const need = new Map<number, number>();
  const mark = (q: Vec, n: number) => {
    if (q.x < 0 || q.y < 0 || q.x >= grid.width || q.y >= grid.height) return;
    const c = q.y * grid.width + q.x;
    const old = need.get(c);
    if (old === undefined || n < old) need.set(c, n);
  };
  const side = (end: LonLat, len: number, other: number) => {
    if (len <= 0) return;
    // Fractional grid position of the end (it may lie off the grid; those cells are skipped).
    const [mx, my] = lonLatToMercator(end[0], end[1]);
    const E = { x: (mx - grid.originX) / grid.cellSizeX, y: (my - grid.originY) / grid.cellSizeY };
    const steps = Math.max(1, Math.ceil(Math.hypot(E.x - P.x, E.y - P.y) * 4));
    let prev: Vec | null = null;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const q = { x: Math.round(P.x + (E.x - P.x) * f), y: Math.round(P.y + (E.y - P.y) * f) };
      const n = needMetres(f * len, other);
      if (prev && prev.x !== q.x && prev.y !== q.y) mark({ x: q.x, y: prev.y }, n);
      if (!prev || prev.x !== q.x || prev.y !== q.y) mark(q, n);
      prev = q;
    }
  };
  side(a, aM, bM);
  side(b, bM, aM);
  need.set(pc, 0);
  const entries = [...need.entries()].sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  return { cells: Int32Array.from(entries.map((e) => e[0])), needM: Float32Array.from(entries.map((e) => e[1])) };
}
