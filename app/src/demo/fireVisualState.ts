/**
 * What each part of each fire on the command board looks like at a board minute: flaming (by
 * flame-length band, or crown fire), smouldering, burned out, or put out by crews; each fire's
 * status and a plain-words label; each attack line's state. Pure: no React, three.js or network.
 * A function of (solver field, minute, suppression state, attack lines, fire statuses) only, so
 * it draws any minute the field covers, past or present (timeline scrubbing): the entry point is
 * `fireVisualAt(board, minute)`; `fireVisualFrom(input, minute)` is the same without a Board.
 *
 * Every state is a model output or a labelled display assumption:
 * - Flaming: arrival a <= t < a + D, D the suppression engine's burn duration (demo/suppression.ts
 *   burnMinutes: half a cell crossing at the front's normal speed plus Anderson (1969) flaming
 *   residence t_r = 384 / sigma min, sigma the fuel's surface-area-to-volume ratio, 1/ft).
 * - Flame length per flaming cell: the surface flame on the front there in the board's current
 *   solver field (suppression.ts frontFlameFeet: Byram 1959, L = L_head (F / R_head)^0.46, F the
 *   front's normal speed from the arrival field, L_head and R_head the solver's head flame and
 *   rate at the cell; the flame the suppression engine tests a unit against), banded by the
 *   Hauling chart (PMS 465 p.12, Fig. 2, after Andrews & Rothermel 1982; response/containment.ts
 *   haulingBand): < 4 ft hand crews hold, 4-8 ft engines and dozers, 8-11 ft serious control
 *   problems (aircraft, indirect), > 11 ft crowning, spotting, major runs.
 * - Crown fire: the solver classifies the cell's head fire as torching or crowning (CellBehaviour
 *   crownType 1 passive, 2 active) in the current field.
 * - Smouldering: past a + D, for SMOULDER_WINDOW_MINUTES (ASSUMPTION, below), glow fading linearly.
 * - Burned out: past that. Put out: suppression.ts extinguishedAt <= t.
 * - Contained / out: the fire's containedAt / outAt <= t. A contained fire draws no flames: cells
 *   the model still has burning inside its line are drawn as residual heat (smouldering glow);
 *   an out fire (closed by crews, by hand, or burned out on its own: any Fire.closedBy) has
 *   nothing burning in the model and no glow.
 * - Fire label: the head of the fire at the minute (Fire.rates at the board minute,
 *   fireField.fireGeometry at any other): head flame, crown flag, head rate and heading.
 *
 * Known limits: flame and crown come from the current field (the board's latest solve), so after a
 * wind or moisture change a scrubbed past minute shows the new behaviour on cells that burned
 * before it. Line under construction before the board minute is read from each raster cell's
 * build minute (AttackLine.builtAt); a line dropped from the board (MAX_LINES) is not drawn at past
 * minutes. Cells of fires that already left the board (OUT_KEEP_MINUTES) have no fire status.
 *
 * Units: minutes are board minutes; flame feet; rates metres per minute; bearings degrees true.
 */

import { CELL_CONTAINED_BIT, CELL_STATE } from "../fire/diorama/cellStates";
import type { LandscapeGrid } from "../fire/landscape";
import { compassPoint } from "../fire/spread";
import { haulingBand } from "../response/containment";
import { builtExtent } from "./attack";
import { NO_FRONT, fireGeometry, type FrontBehaviour } from "./fireField";
import type { AttackLine, Board, Fire, FireField } from "./model";
import { frontFlameFeet, type SuppressionState } from "./suppression";

/**
 * ASSUMPTION (display only, no source): minutes a cell glows as smouldering embers after its
 * modelled fuel has finished flaming. The fuel models carry no 1000-h or duff load, so post-frontal
 * smouldering cannot be computed (demo/suppression.ts header, "Not modelled"); this window only
 * shows recently burned ground apart from long-cold ground.
 */
export const SMOULDER_WINDOW_MINUTES = 60;
/**
 * ASSUMPTION (label wording only): a fire with low flames (< 4 ft) whose head spreads at most this
 * fast is called "creeping" (NWCG Glossary: "burning with a low flame and spreading slowly"; the
 * glossary gives no number).
 */
export const CREEPING_MAX_RATE_M_PER_MIN = 2;

export type FireStatusAt = "not_started" | "burning" | "contained" | "out";

/** One fire at the minute, from the cells it owns in the solver field. */
export interface FireVisual {
  fireId: string;
  status: FireStatusAt;
  /** Cells flaming (not contained), crowning among them, and smouldering / residual heat. */
  flamingCells: number;
  crownCells: number;
  smoulderingCells: number;
  /** Longest surface flame on its flaming front, feet (0 when none). */
  maxFlameFeet: number;
  /** Head of the fire at the minute (Fire.rates at the board minute, else fireField.fireGeometry). */
  front: FrontBehaviour;
  /** How an out fire was closed (Fire.closedBy as text: "teams", "manual", "burned_out", ...), else null. */
  closedBy: string | null;
  /** Plain words from the numbers above, e.g. "Burning hard · flames ~9 ft · 65 m/min toward W". */
  words: string;
}

export type LineStateAt = "planned" | "building" | "built" | "held" | "crossed";

export const LINE_STATE_LABEL: Record<LineStateAt, string> = {
  planned: "Line planned",
  building: "Line being built",
  built: "Line built",
  held: "Line held",
  crossed: "Line crossed",
};

/** One attack line at the minute. */
export interface LineVisual {
  id: string;
  fireId: string;
  line: AttackLine;
  /** Metres built by the minute, and how far that reaches each way from the anchor. */
  builtM: number;
  extentAM: number;
  extentBM: number;
  /** Finished by the minute. */
  complete: boolean;
  /**
   * crossed: a built cell burned after it was built (the fire got past it). held: a built cell is
   * unburned with burned ground beside it (the fire is against it and stopped). Otherwise built /
   * building / planned by how much is built.
   */
  state: LineStateAt;
  heldCells: number;
  crossedCells: number;
}

export interface FireVisualState {
  minute: number;
  /**
   * Per landscape cell (row-major, the board's landscape): a CELL_STATE code, with
   * CELL_CONTAINED_BIT set when the cell's fire is contained or out. For
   * FireDioramaSceneApi.setCellStates. Do not mutate.
   */
  codes: Uint8Array;
  /** Per cell, 0-255: the smouldering glow left (255 just after flaming, 0 at the window's end). */
  heat: Uint8Array;
  fires: Map<string, FireVisual>;
  lines: LineVisual[];
}

/** Everything the classification reads; `fireVisualInput(board)` builds it from a board. */
export interface FireVisualInput {
  grid: LandscapeGrid;
  field: FireField | null;
  suppression: Pick<SuppressionState, "extinguishedAt" | "burnMinutes" | "version">;
  lines: readonly AttackLine[];
  fires: readonly Fire[];
  /** The minute the lines' builtM / completedAt and the fires' rates describe (the board's own minute). */
  boardMinute: number;
}

export function fireVisualInput(board: Board): FireVisualInput {
  return {
    grid: board.env.landscape,
    field: board.solver.field,
    suppression: board.suppression,
    lines: board.lines,
    fires: board.fires,
    boardMinute: board.minute,
  };
}

/** A fire's status at `minute` from its recorded transitions. */
export function fireStatusAt(fire: Fire, minute: number): FireStatusAt {
  if (fire.outAt !== null && fire.outAt <= minute) return "out";
  if (fire.containedAt !== null && fire.containedAt <= minute) return "contained";
  if (fire.ignitedAt > minute) return "not_started";
  return "burning";
}

/** "Out · put out by crews" for any Fire.closedBy (values this file does not know read as words). */
function outWords(closedBy: string | null): string {
  if (!closedBy) return "Out";
  if (closedBy === "teams") return "Out · put out by crews";
  if (closedBy === "manual") return "Out · closed by hand";
  return `Out · ${closedBy.replace(/_/g, " ")}`;
}

/** "~9 ft" (whole feet; under 1 ft "under 1 ft"). */
function feet(ft: number): string {
  return ft < 1 ? "under 1 ft" : `~${Math.round(ft)} ft`;
}

/** Label words for a fire at the minute, from model numbers only. */
export function fireWords(v: Omit<FireVisual, "words">): string {
  if (v.status === "out") return outWords(v.closedBy);
  if (v.status === "contained") return v.smoulderingCells > 0 ? "Contained · heat left inside the line" : "Contained";
  if (v.status === "not_started") return "Not started";
  if (v.flamingCells === 0) return v.smoulderingCells > 0 ? "Smouldering · no open flame" : "No open flame";
  // The head of the fire decides the words, as the board's tactics do (containment.ts).
  const rate = v.front.headMetersPerMinute;
  const flame = Math.max(0, v.front.headFlameFeet);
  const crown = v.front.crowning || v.crownCells > 0;
  let head: string;
  if (crown) head = "Crown fire";
  else {
    const band = haulingBand(flame);
    head =
      band === "hand_tools"
        ? rate <= CREEPING_MAX_RATE_M_PER_MIN
          ? "Creeping"
          : "Low flames"
        : band === "machines"
          ? "Burning moderately"
          : band === "indirect_only"
            ? "Burning hard"
            : "Burning extremely hard";
  }
  const parts = [head, crown ? `surface flames ${feet(flame)}` : `flames ${feet(flame)}`];
  if (rate > 0) parts.push(`${rate < 10 ? rate.toFixed(1) : Math.round(rate)} m/min toward ${compassPoint(v.front.headingDegrees)}`);
  return parts.join(" · ");
}

/** Code of a flaming cell from its front flame and crown type (Hauling chart band). */
function flamingCode(flameFeet: number, crownType: number): number {
  if (crownType !== 0) return CELL_STATE.crown;
  if (!(flameFeet >= 0)) return CELL_STATE.burning;
  const band = haulingBand(flameFeet);
  return band === "hand_tools"
    ? CELL_STATE.flameLow
    : band === "machines"
      ? CELL_STATE.flameModerate
      : band === "indirect_only"
        ? CELL_STATE.flameHigh
        : CELL_STATE.flameExtreme;
}

/** Line state at `minute` (pure; see LineVisual). */
export function lineVisualAt(line: AttackLine, input: Pick<FireVisualInput, "grid" | "field" | "boardMinute">, minute: number): LineVisual {
  const { raster, builtAt } = line;
  let builtM = 0;
  if (minute >= input.boardMinute) builtM = line.builtM;
  else for (let k = 0; k < raster.needM.length; k++) if (builtAt[k] <= minute && raster.needM[k] > builtM) builtM = raster.needM[k];
  const complete = line.completedAt !== null && line.completedAt <= minute;
  if (complete) builtM = line.lengthM;
  let held = 0;
  let crossed = 0;
  const arrival = input.field?.arrivalMinutes ?? null;
  if (arrival) {
    const { width, height } = input.grid;
    for (let k = 0; k < raster.cells.length; k++) {
      const b = builtAt[k];
      if (!(b <= minute)) continue;
      const c = raster.cells[k];
      const a = arrival[c];
      if (a <= minute) {
        if (a >= b) crossed++;
        continue;
      }
      const x = c % width;
      const y = (c - x) / width;
      if (
        (x > 0 && arrival[c - 1] <= minute) ||
        (x < width - 1 && arrival[c + 1] <= minute) ||
        (y > 0 && arrival[c - width] <= minute) ||
        (y < height - 1 && arrival[c + width] <= minute)
      )
        held++;
    }
  }
  const ext = builtExtent(builtM, line.plan.aM, line.plan.bM);
  const state: LineStateAt = crossed > 0 ? "crossed" : held > 0 ? "held" : complete ? "built" : builtM > 0 ? "building" : "planned";
  return { id: line.id, fireId: line.fireId, line, builtM, extentAM: ext.a, extentBM: ext.b, complete, state, heldCells: held, crossedCells: crossed };
}

/** Two output buffers per grid, alternated, so a new state has a new identity without churning memory. */
const buffers = new WeakMap<LandscapeGrid, { codes: Uint8Array[]; heat: Uint8Array[]; next: number }>();

function outputBuffers(grid: LandscapeGrid): { codes: Uint8Array; heat: Uint8Array } {
  const n = grid.width * grid.height;
  let b = buffers.get(grid);
  if (!b || b.codes[0].length !== n) {
    b = { codes: [new Uint8Array(n), new Uint8Array(n)], heat: [new Uint8Array(n), new Uint8Array(n)], next: 0 };
    buffers.set(grid, b);
  }
  const i = b.next;
  b.next = 1 - i;
  return { codes: b.codes[i], heat: b.heat[i] };
}

/**
 * The board's fire as drawn at `minute` (see the header). Pure in its inputs; the result's arrays
 * come from a pair of buffers per grid, so a caller must not keep more than the latest two.
 */
export function fireVisualFrom(input: FireVisualInput, minute: number): FireVisualState {
  const { grid, field, suppression: st } = input;
  const n = grid.width * grid.height;
  const { codes, heat } = outputBuffers(grid);
  codes.fill(0);
  heat.fill(0);

  // Per solver source: the minute its fire stops flaming (contained or out) and goes dark (out).
  const sourceCount = field?.sources.length ?? 0;
  const containedFrom = new Float64Array(sourceCount).fill(Number.POSITIVE_INFINITY);
  const outFrom = new Float64Array(sourceCount).fill(Number.POSITIVE_INFINITY);
  if (field) {
    for (const fire of input.fires) {
      const s = field.sourceIndex.get(fire.id);
      if (s === undefined) continue;
      if (fire.outAt !== null) outFrom[s] = fire.outAt;
      containedFrom[s] = Math.min(fire.containedAt ?? Number.POSITIVE_INFINITY, fire.outAt ?? Number.POSITIVE_INFINITY);
    }
  }
  const flaming = new Int32Array(sourceCount);
  const crowning = new Int32Array(sourceCount);
  const smouldering = new Int32Array(sourceCount);
  const maxFlame = new Float64Array(sourceCount);

  if (field && field.arrivalMinutes.length === n) {
    const arrival = field.arrivalMinutes;
    const owner = field.sourceIndexByCell;
    const ext = st.extinguishedAt;
    const D = st.burnMinutes;
    const crown = field.behaviour.crownType;
    for (let c = 0; c < n; c++) {
      const a = arrival[c];
      if (!(a <= minute)) continue;
      const s = owner[c];
      const contained = s >= 0 && containedFrom[s] <= minute;
      const out = s >= 0 && outFrom[s] <= minute;
      const bit = contained ? CELL_CONTAINED_BIT : 0;
      if (ext[c] <= minute) {
        codes[c] = CELL_STATE.extinguished | bit;
        continue;
      }
      const flameEnd = a + (D[c] >= 0 ? D[c] : 0);
      if (minute < flameEnd && !out) {
        if (contained) {
          // Contained: no flames drawn; the model's remaining burning cells show as residual heat.
          codes[c] = CELL_STATE.smouldering | bit;
          heat[c] = 255;
          if (s >= 0) smouldering[s]++;
          continue;
        }
        const flame = frontFlameFeet(field, grid, c);
        const code = flamingCode(flame, crown[c]);
        codes[c] = code;
        if (s >= 0) {
          flaming[s]++;
          if (code === CELL_STATE.crown) crowning[s]++;
          if (flame > maxFlame[s]) maxFlame[s] = flame;
        }
        continue;
      }
      const since = minute - flameEnd;
      if (!out && since < SMOULDER_WINDOW_MINUTES) {
        codes[c] = CELL_STATE.smouldering | bit;
        heat[c] = Math.max(1, Math.round(255 * (1 - since / SMOULDER_WINDOW_MINUTES)));
        if (s >= 0) smouldering[s]++;
        continue;
      }
      codes[c] = CELL_STATE.burnedOut | bit;
    }
  }

  const fires = new Map<string, FireVisual>();
  for (const fire of input.fires) {
    const status = fireStatusAt(fire, minute);
    const s = field?.sourceIndex.get(fire.id);
    let front: FrontBehaviour = NO_FRONT;
    if (status === "burning") {
      // The board's own reading at its minute; the same computation at any other minute.
      if (minute === input.boardMinute) front = fire.rates;
      else if (field && s !== undefined) front = fireGeometry(field, grid, s, field.originCells[s], Math.floor(minute)).front;
    }
    const v: Omit<FireVisual, "words"> = {
      fireId: fire.id,
      status,
      flamingCells: s === undefined ? 0 : flaming[s],
      crownCells: s === undefined ? 0 : crowning[s],
      smoulderingCells: s === undefined ? 0 : smouldering[s],
      maxFlameFeet: s === undefined ? 0 : maxFlame[s],
      front,
      closedBy: status === "out" && fire.closedBy ? String(fire.closedBy) : null,
    };
    fires.set(fire.id, { ...v, words: fireWords(v) });
  }
  const lines = input.lines.map((line) => lineVisualAt(line, input, minute));
  return { minute, codes, heat, fires, lines };
}

interface VisualCache {
  field: unknown;
  minute: number;
  boardMinute: number;
  version: number;
  key: string;
  value: FireVisualState;
}
const cache = new WeakMap<Board, VisualCache>();

/** What changes the lines' and fires' part of the picture (the board is mutated in place). */
function boardKey(board: Board): string {
  let key = "";
  for (const f of board.fires)
    key += `${f.id}:${f.status}:${f.containedAt}:${f.outAt}:${String(f.closedBy)}:${f.rates.cell}:${f.rates.headFlameFeet}:${f.rates.headMetersPerMinute}|`;
  for (const l of board.lines) key += `${l.id}:${l.builtM.toFixed(1)}:${l.completedAt}|`;
  return key;
}

/**
 * The scrub-ready entry point: the board's fire as drawn at `minute` (default the board's own
 * minute). Cached per field, minute, suppression version and fire/line state, so calling it on
 * every render is cheap; a new result (new identity) means the picture changed.
 */
export function fireVisualAt(board: Board, minute = board.minute): FireVisualState {
  const field = board.solver.field;
  const key = boardKey(board);
  const hit = cache.get(board);
  if (
    hit &&
    hit.field === field &&
    hit.minute === minute &&
    hit.boardMinute === board.minute &&
    hit.version === board.suppression.version &&
    hit.key === key
  )
    return hit.value;
  const value = fireVisualFrom(fireVisualInput(board), minute);
  cache.set(board, { field, minute, boardMinute: board.minute, version: board.suppression.version, key, value });
  return value;
}
