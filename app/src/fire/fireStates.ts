/**
 * Legible fire states per landscape cell, shared by every simulated-fire view (the command board on
 * /live and /run, the Simulation Studio on /simulation and /dispatch, and the fire model on /fire):
 * flaming by flame-length band or crown fire, smouldering, burned out, put out. Pure: no React,
 * three.js, worker or network. The codes are fire/diorama/cellStates.ts CELL_STATE, which the 3D
 * diorama draws (FireDioramaSceneApi.setCellStates) and the 2D maps colour with FIRE_STATE_COLORS.
 *
 * Simulated only. Never classify an observed or hindcast perimeter with this (AGENTS.md: keep
 * simulated and observed data distinct); /replay and the historical dioramas do not use it.
 *
 * The rules (demo/fireVisualState.ts applies them to the board; Studio and /fire to their runs):
 * - Flaming: arrival a <= t < a + D. D = g / (2 F) + t_r: half a cell crossing (ground size g) at
 *   F, the front's normal speed from the arrival field (eikonal, upwind differences, Sethian 1996),
 *   plus Anderson (1969) flaming residence t_r = 384 / sigma min of the fuel's coarsest loaded
 *   class (sigma surface-area-to-volume, 1/ft; ASSUMPTION per class, see demo/suppression.ts).
 * - Flame length per flaming cell: Byram (1959) L = L_head (F / R_head)^0.46 from the solver's head
 *   flame and rate at the cell, banded by the Hauling chart (PMS 465 p.12, Fig. 2, after Andrews &
 *   Rothermel 1982; response/containment.ts haulingBand): < 4 ft hand crews hold, 4-8 ft engines
 *   and dozers, 8-11 ft serious control problems, > 11 ft crowning, spotting, major runs.
 * - Crown fire: the solver's crown type at the cell (1 passive / torching, 2 active).
 * - Smouldering: past a + D for SMOULDER_WINDOW_MINUTES (ASSUMPTION), glow fading linearly.
 * - Burned out: past that. Put out: the cell's extinguished minute <= t (when the caller has one).
 * - Contained / out (per owning fire, when the caller has them): a contained fire draws no flames
 *   (its still-burning cells show as residual heat); an out fire has no glow at all.
 *
 * Units: minutes on the caller's clock (the same as the arrival field); flame feet; rates metres
 * per minute; grid column x east, row y south.
 */

import { CELL_CODE_MASK, CELL_CONTAINED_BIT, CELL_STATE } from "./diorama/cellStates";
import { FUEL_MODELS, SAV_DEAD_100H, SAV_DEAD_10H } from "./fuelModels";
import type { LandscapeGrid } from "./landscape";
import type { MultiPolygon, Position } from "geojson";
import { BYRAM_FLAME_EXPONENT, compassPoint, contourArrival, type CellBehaviour } from "./spread";
import { haulingBand } from "../response/containment";

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

/** Anderson (1969) flaming residence time: t_r = 384 / sigma minutes, sigma in 1/ft (Rothermel 1972 uses it). */
export const ANDERSON_RESIDENCE_MINUTES_PER_FOOT = 384;

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
export function upwindGradient(grid: Pick<LandscapeGrid, "width" | "height">, arrival: ArrayLike<number>, cell: number): { x: number; y: number } | null {
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

/**
 * Speed of the modelled front normal to itself at `cell`, m/min: g / |grad t| (eikonal), or the
 * head rate where the upwind gradient is undefined or zero (cells ignited together); 0 when there
 * is no head rate either.
 */
export function frontSpeedAt(
  grid: Pick<LandscapeGrid, "width" | "height" | "groundCellSizeMeters">,
  arrival: ArrayLike<number>,
  headRate: ArrayLike<number> | null,
  cell: number,
): number {
  const d = upwindGradient(grid, arrival, cell);
  const n = d ? Math.hypot(d.x, d.y) : 0;
  return n > 1e-9 ? grid.groundCellSizeMeters / n : (headRate?.[cell] ?? 0);
}

/**
 * Surface flame at `cell` on its front, feet: Byram (1959) L = L_head (F / R_head)^0.46 with F
 * the front's normal speed there (capped at the head rate) and the solver's head flame L_head.
 */
export function frontFlameFeetAt(
  grid: Pick<LandscapeGrid, "width" | "height" | "groundCellSizeMeters">,
  arrival: ArrayLike<number>,
  behaviour: Pick<CellBehaviour, "headRateMetersPerMinute" | "headFlameFeet">,
  cell: number,
): number {
  const head = behaviour.headRateMetersPerMinute[cell];
  const flame = behaviour.headFlameFeet[cell];
  if (!(head > 0)) return flame;
  return flame * Math.pow(Math.min(1, frontSpeedAt(grid, arrival, behaviour.headRateMetersPerMinute, cell) / head), BYRAM_FLAME_EXPONENT);
}

/**
 * Minutes each reached cell flames, D = g / (2 F) + t_r (header), -1 where fire never arrives within
 * `horizonMinutes`. For a whole run; the board keeps its own (demo/suppression.ts updateBurnDurations,
 * which also holds durations across re-solves).
 */
export function burnMinutesField(
  grid: LandscapeGrid,
  arrival: ArrayLike<number>,
  headRate: ArrayLike<number> | null,
  horizonMinutes = Number.POSITIVE_INFINITY,
): Float32Array {
  const n = grid.width * grid.height;
  const D = new Float32Array(n).fill(-1);
  const g = grid.groundCellSizeMeters;
  for (let c = 0; c < n; c++) {
    const a = arrival[c];
    if (!(a <= horizonMinutes) || !Number.isFinite(a)) continue;
    const speed = frontSpeedAt(grid, arrival, headRate, c);
    D[c] = (speed > 0 ? g / (2 * speed) : 0) + particleResidenceMinutes(grid.fuelCodes[c]);
  }
  return D;
}

/** Code of a flaming cell from its front flame and crown type (Hauling chart band); `burning` when the flame is unknown. */
export function flamingCode(flameFeet: number, crownType: number): number {
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

/** Everything the per-cell classification reads. */
export interface CellStateInput {
  grid: LandscapeGrid;
  /** Arrival per cell on the caller's clock (Infinity where fire never arrives). */
  arrivalMinutes: ArrayLike<number>;
  /** Minutes each cell flames (burnMinutesField), -1 unknown (treated as 0). */
  burnMinutes: ArrayLike<number>;
  /**
   * The solver's per-cell behaviour, for flame bands and crown fire; null (a run without it) draws
   * flaming cells as CELL_STATE.burning (unclassified).
   */
  behaviour: Pick<CellBehaviour, "headRateMetersPerMinute" | "headFlameFeet" | "crownType"> | null;
  /** Front flame per cell, feet, precomputed (frontFlameFeetAt); omitted, computed per flaming cell. */
  flameFeet?: ArrayLike<number> | null;
  /** Per cell, minute a crew put it out (Infinity never); null when the model puts no cell out. */
  extinguishedAt?: ArrayLike<number> | null;
  /** Owning fire per cell (-1 none) and, per owner, the minute it is contained / out; null = never. */
  owner?: ArrayLike<number> | null;
  containedFrom?: ArrayLike<number> | null;
  outFrom?: ArrayLike<number> | null;
}

/** Per-owner tallies at the minute (index = owner); arrays sized by the caller. */
export interface CellStateCounts {
  flaming: Int32Array;
  crowning: Int32Array;
  smouldering: Int32Array;
  maxFlameFeet: Float64Array;
}

export function cellStateCounts(owners: number): CellStateCounts {
  return { flaming: new Int32Array(owners), crowning: new Int32Array(owners), smouldering: new Int32Array(owners), maxFlameFeet: new Float64Array(owners) };
}

/**
 * Fills `codes` (CELL_STATE, CELL_CONTAINED_BIT on a contained or out fire's cells) and `heat`
 * (0-255 smoulder glow) for `minute`, and the per-owner `counts` when given. Both arrays are
 * cleared first and must be width x height long.
 */
export function classifyCellStates(input: CellStateInput, minute: number, codes: Uint8Array, heat: Uint8Array, counts?: CellStateCounts | null): void {
  const { grid, arrivalMinutes: arrival, burnMinutes: D, behaviour } = input;
  const n = grid.width * grid.height;
  codes.fill(0);
  heat.fill(0);
  if (arrival.length !== n) return;
  const owner = input.owner ?? null;
  const containedFrom = input.containedFrom ?? null;
  const outFrom = input.outFrom ?? null;
  const ext = input.extinguishedAt ?? null;
  const crown = behaviour?.crownType ?? null;
  for (let c = 0; c < n; c++) {
    const a = arrival[c];
    if (!(a <= minute)) continue;
    const s = owner ? owner[c] : -1;
    const contained = s >= 0 && !!containedFrom && containedFrom[s] <= minute;
    const out = s >= 0 && !!outFrom && outFrom[s] <= minute;
    const bit = contained ? CELL_CONTAINED_BIT : 0;
    if (ext && ext[c] <= minute) {
      codes[c] = CELL_STATE.extinguished | bit;
      continue;
    }
    const flameEnd = a + (D[c] >= 0 ? D[c] : 0);
    if (minute < flameEnd && !out) {
      if (contained) {
        // Contained: no flames drawn; the model's remaining burning cells show as residual heat.
        codes[c] = CELL_STATE.smouldering | bit;
        heat[c] = 255;
        if (counts && s >= 0) counts.smouldering[s]++;
        continue;
      }
      const flame = input.flameFeet ? input.flameFeet[c] : behaviour ? frontFlameFeetAt(grid, arrival, behaviour, c) : -1;
      const code = flamingCode(flame, crown ? crown[c] : 0);
      codes[c] = code;
      if (counts && s >= 0) {
        counts.flaming[s]++;
        if (code === CELL_STATE.crown) counts.crowning[s]++;
        if (flame > counts.maxFlameFeet[s]) counts.maxFlameFeet[s] = flame;
      }
      continue;
    }
    const since = minute - flameEnd;
    if (!out && since < SMOULDER_WINDOW_MINUTES) {
      codes[c] = CELL_STATE.smouldering | bit;
      heat[c] = Math.max(1, Math.round(255 * (1 - since / SMOULDER_WINDOW_MINUTES)));
      if (counts && s >= 0) counts.smouldering[s]++;
      continue;
    }
    codes[c] = CELL_STATE.burnedOut | bit;
  }
}

/** "~9 ft" (whole feet; under 1 ft "under 1 ft"). */
export function flameFeetWords(ft: number): string {
  return ft < 1 ? "under 1 ft" : `~${Math.round(ft)} ft`;
}

/**
 * Plain words for a flaming fire's head: "Crown fire", "Creeping", "Low flames", "Burning
 * moderately", "Burning hard", "Burning extremely hard" (Hauling chart band of the head flame;
 * creeping per CREEPING_MAX_RATE_M_PER_MIN).
 */
export function flamingHeadWords(headFlameFeet: number, headMetersPerMinute: number, crowning: boolean): string {
  if (crowning) return "Crown fire";
  const band = haulingBand(Math.max(0, headFlameFeet));
  return band === "hand_tools"
    ? headMetersPerMinute <= CREEPING_MAX_RATE_M_PER_MIN
      ? "Creeping"
      : "Low flames"
    : band === "machines"
      ? "Burning moderately"
      : band === "indirect_only"
        ? "Burning hard"
        : "Burning extremely hard";
}

/**
 * "Burning hard · flames ~9 ft · 65 m/min toward W" (rate and heading optional): a flaming fire's
 * label from model numbers only.
 */
export function flamingFireWords(headFlameFeet: number, headMetersPerMinute: number, crowning: boolean, headingDegrees: number | null): string {
  const flame = Math.max(0, headFlameFeet);
  const parts = [flamingHeadWords(flame, headMetersPerMinute, crowning), crowning ? `surface flames ${flameFeetWords(flame)}` : `flames ${flameFeetWords(flame)}`];
  if (headMetersPerMinute > 0 && headingDegrees !== null && Number.isFinite(headingDegrees))
    parts.push(`${headMetersPerMinute < 10 ? headMetersPerMinute.toFixed(1) : Math.round(headMetersPerMinute)} m/min toward ${compassPoint(headingDegrees)}`);
  return parts.join(" · ");
}

/**
 * Words for a fire with no crews on it, from its cells at the minute (counts of one owner): still
 * flaming, smouldering with no open flame, or burned out on its own (nothing left burning in the
 * model). A fire crews put out or contained has its own wording at the caller.
 */
export function unattendedFireState(flamingCells: number, smoulderingCells: number): "flaming" | "smouldering" | "burned_out" {
  if (flamingCells > 0) return "flaming";
  return smoulderingCells > 0 ? "smouldering" : "burned_out";
}

export const UNATTENDED_FIRE_WORDS: Record<ReturnType<typeof unattendedFireState>, string> = {
  flaming: "Burning",
  smouldering: "Smouldering · no open flame",
  burned_out: "Burned out on its own · no crews",
};

/** A whole run's cell states at any minute (Studio, /fire): see createRunCellStates. */
export interface RunCellStates {
  /** Codes and heat at `minute` (two alternating buffers: keep at most the latest two results). */
  at(minute: number, counts?: CellStateCounts | null): { codes: Uint8Array; heat: Uint8Array };
  /** Owners (fires) in `owner`, for sizing cellStateCounts; 0 without owners. */
  owners: number;
}

/**
 * Precomputes a run's burn durations and front flames once (both depend only on the arrival
 * field and the solver's behaviour), so `at(minute)` is one pass of comparisons: cheap enough to
 * call on every scrubbed minute. `arrivalMinutes` and `minute` share one clock.
 */
export function createRunCellStates(
  input: Omit<CellStateInput, "burnMinutes" | "flameFeet"> & { horizonMinutes?: number; owners?: number },
): RunCellStates {
  const { grid, arrivalMinutes, behaviour } = input;
  const n = grid.width * grid.height;
  const burnMinutes = burnMinutesField(grid, arrivalMinutes, behaviour?.headRateMetersPerMinute ?? null, input.horizonMinutes);
  let flameFeet: Float32Array | null = null;
  if (behaviour && arrivalMinutes.length === n) {
    flameFeet = new Float32Array(n).fill(-1);
    for (let c = 0; c < n; c++) if (burnMinutes[c] >= 0) flameFeet[c] = frontFlameFeetAt(grid, arrivalMinutes, behaviour, c);
  }
  const full: CellStateInput = { ...input, burnMinutes, flameFeet };
  const codes = [new Uint8Array(n), new Uint8Array(n)];
  const heat = [new Uint8Array(n), new Uint8Array(n)];
  let next = 0;
  return {
    owners: input.owners ?? 0,
    at(minute, counts) {
      const i = next;
      next = 1 - i;
      classifyCellStates(full, minute, codes[i], heat[i], counts);
      return { codes: codes[i], heat: heat[i] };
    },
  };
}

/** 2D map groups of cell codes (the 3D codes merged where a map would not tell them apart). */
export type MapFireState = "flame_low" | "flame_moderate" | "flame_high" | "flame_extreme" | "crown" | "burning" | "smouldering" | "burned_out" | "extinguished";

/** Map group of a cell byte (CELL_CONTAINED_BIT ignored), or null for unburned. */
export function mapFireStateOf(byte: number): MapFireState | null {
  switch (byte & CELL_CODE_MASK) {
    case CELL_STATE.flameLow:
      return "flame_low";
    case CELL_STATE.flameModerate:
      return "flame_moderate";
    case CELL_STATE.flameHigh:
      return "flame_high";
    case CELL_STATE.flameExtreme:
      return "flame_extreme";
    case CELL_STATE.crown:
      return "crown";
    case CELL_STATE.burning:
      return "burning";
    case CELL_STATE.smouldering:
      return "smouldering";
    case CELL_STATE.burnedOut:
      return "burned_out";
    case CELL_STATE.extinguished:
      return "extinguished";
    default:
      return null;
  }
}

/** Drawing order of the map states, coolest first (hotter states draw on top). */
export const MAP_FIRE_STATE_ORDER: readonly MapFireState[] = ["burned_out", "extinguished", "smouldering", "burning", "flame_low", "flame_moderate", "flame_high", "flame_extreme", "crown"];
const polygonScratch = new WeakMap<LandscapeGrid, Float64Array>();

/**
 * Polygons (WGS84 [lon, lat]; outer ring first, then holes) per map state, contoured with the
 * solver's own marching squares (fire/spread.ts contourArrival) over the cells in that state, in
 * MAP_FIRE_STATE_ORDER. For the 2D maps: features with a `state` property feed one fill layer
 * coloured by MAP_FIRE_STATE_COLOR. States with no cells are omitted. O(cells) plus the contours;
 * call it once per whole minute, not per animation frame.
 */
export function cellStatePolygons(grid: LandscapeGrid, codes: Uint8Array): { state: MapFireState; geometry: MultiPolygon }[] {
  const n = grid.width * grid.height;
  if (codes.length !== n) return [];
  const boxes = new Map<MapFireState, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (let c = 0; c < n; c++) {
    if (codes[c] === 0) continue;
    const st = mapFireStateOf(codes[c]);
    if (!st) continue;
    const x = c % grid.width;
    const y = (c - x) / grid.width;
    const b = boxes.get(st);
    if (!b) boxes.set(st, { minX: x, maxX: x, minY: y, maxY: y });
    else {
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    }
  }
  let scratch = polygonScratch.get(grid);
  if (!scratch || scratch.length !== n) {
    scratch = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
    polygonScratch.set(grid, scratch);
  }
  const out: { state: MapFireState; geometry: MultiPolygon }[] = [];
  for (const st of MAP_FIRE_STATE_ORDER) {
    const box = boxes.get(st);
    if (!box) continue;
    const cells: number[] = [];
    for (let y = box.minY; y <= box.maxY; y++)
      for (let x = box.minX; x <= box.maxX; x++) {
        const c = y * grid.width + x;
        if (codes[c] !== 0 && mapFireStateOf(codes[c]) === st) {
          scratch[c] = 0;
          cells.push(c);
        }
      }
    const polygons = contourArrival(grid, scratch, 0, box);
    for (const c of cells) scratch[c] = Number.POSITIVE_INFINITY;
    out.push({ state: st, geometry: { type: "MultiPolygon", coordinates: polygons.map((p) => p.geometry.coordinates as Position[][]) } });
  }
  return out;
}

/**
 * CSS colour of each map state: fire/diorama/cellStates.ts FIRE_STATE_COLORS (and
 * EXTINGUISHED_LEGEND.fill for put out), so the 2D maps match the 3D board. "burning"
 * (unclassified flame) uses the 4-8 ft hue.
 */
export const MAP_FIRE_STATE_COLOR: Record<MapFireState, string> = {
  flame_low: "#c0281a",
  flame_moderate: "#f26a1b",
  flame_high: "#ffb01f",
  flame_extreme: "#ffe27a",
  crown: "#fff6d8",
  burning: "#f26a1b",
  smouldering: "#d2401a",
  burned_out: "#4a4644",
  extinguished: "#7d8c99",
};

/** Plain-words legend label of each map state (simulated). */
export const MAP_FIRE_STATE_LABEL: Record<MapFireState, string> = {
  flame_low: "Flames under 4 ft (simulated): hand crews can hold it (Hauling chart, PMS 465)",
  flame_moderate: "Flames 4 to 8 ft (simulated): engines and dozers",
  flame_high: "Flames 8 to 11 ft (simulated): serious control problems",
  flame_extreme: "Flames over 11 ft (simulated): head not attackable",
  crown: "Crown fire (simulated): torching or crowning",
  burning: "Burning (simulated)",
  smouldering: `Smouldering (simulated): up to ${SMOULDER_WINDOW_MINUTES} min after flaming ends (assumption)`,
  burned_out: "Burned out (simulated)",
  extinguished: "Put out by crews (simulated)",
};
