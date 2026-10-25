import * as THREE from "three";
import { PALETTE } from "../../diorama/scene/palette";
import { hash2 } from "../../diorama/scene/geometry";
import type { LandscapeGrid } from "../landscape";
import { FIELD_STRIPES, FuelFamily, GROUND_COLORS, OVERLAY_COLORS, fuelFamily } from "./fuelStyle";

/** Board width (world units) of the longer grid side, whatever the loaded radius. */
export const BOARD_SIZE = 600;
/** Cut-earth depth below the lowest terrain (world units). */
export const BASE_Y = -16;
/** Width of the dark base board's rim around the terrain (world units). */
export const BOARD_MARGIN = 12;
/** Terrain mesh resolution cap (segments along the longer side). */
const MAX_SEGMENTS = 224;
/**
 * Vertical exaggeration. The relief is first brought toward `TARGET_RELIEF_UNITS` within
 * [MIN, MAX], then capped so very steep areas stay plausible on a 600-unit board. It only
 * changes the drawing; the model's slope uses the true elevations.
 */
export const VERTICAL_EXAGGERATION = {
  min: 1.6,
  max: 2.5,
  targetReliefUnits: 80,
  maxReliefUnits: 150,
} as const;
/**
 * Regional boards (tens of km across) blend toward these: a smaller relief target so big
 * mountains (San Gorgonio 3.5 km next to a 100 m desert floor) stay at ~1.0-1.3x, a higher
 * ceiling so low coastal relief (Mt Diablo on a 100 km board) still reads, and a floor of 1x.
 */
export const REGIONAL_EXAGGERATION = {
  min: 1.3,
  max: 7,
  targetReliefUnits: 58,
  maxAboveMedianUnits: 70,
} as const;
/** Metres per world unit over which the board blends from local to regional tuning. */
export const REGIONAL_BLEND_METERS_PER_UNIT = [15, 100] as const;
/** Metres per world unit over which urban areas blend from houses to ivory blocks + streets. */
export const BLOCK_BLEND_METERS_PER_UNIT = [10, 30] as const;
/** Terrain under open water is pressed down this far so the flat water surface clips it. */
const WATER_DEPRESSION = 1.4;
/** Regional boards press water terrain down less, so shores are not tall steps. */
const REGIONAL_WATER_DEPRESSION = 0.4;

/**
 * Mapping between the landscape grid and the board. Cell (col, row) centre sits at
 * x = (col + 0.5 − width/2)·cellWorld, z = (row + 0.5 − height/2)·cellWorld (row 0 north, −z).
 */
export class BoardFrame {
  readonly grid: LandscapeGrid | null;
  readonly cols: number;
  readonly rows: number;
  /** World units per grid cell. */
  readonly cellWorld: number;
  readonly halfW: number;
  readonly halfD: number;
  /** Horizontal world units per ground metre. */
  readonly unitsPerMeter: number;
  readonly verticalExaggeration: number;
  /** Ground metres per world unit (board scale). */
  readonly metersPerUnit: number;
  /** 0 (local board, houses) .. 1 (regional board, blocks and clumps); see BLOCK_BLEND. */
  readonly blockMix: number;
  /** 0 .. 1 blend of the regional terrain tuning. */
  readonly regionalMix: number;
  readonly minElevation: number;
  /** Height-mesh vertex lattice. */
  readonly segX: number;
  readonly segZ: number;
  readonly heights: Float32Array;
  /** True where the vertex's nearest cell is open water; water surface level per vertex. */
  readonly waterLevel: Float32Array;
  readonly isWater: Uint8Array;
  /** Fraction (0..1) of open-water cells in the vertex's sampling box. */
  readonly waterFrac: Float32Array;
  readonly maxHeight: number;
  readonly families: Uint8Array;

  constructor(grid: LandscapeGrid | null) {
    this.grid = grid;
    this.cols = grid ? grid.width : 64;
    this.rows = grid ? grid.height : 64;
    this.cellWorld = BOARD_SIZE / Math.max(this.cols, this.rows);
    this.halfW = (this.cols * this.cellWorld) / 2;
    this.halfD = (this.rows * this.cellWorld) / 2;
    this.unitsPerMeter = grid ? this.cellWorld / grid.groundCellSizeMeters : 0.1;
    this.metersPerUnit = grid ? grid.groundCellSizeMeters / this.cellWorld : 10;
    this.blockMix = THREE.MathUtils.smoothstep(
      this.metersPerUnit,
      BLOCK_BLEND_METERS_PER_UNIT[0],
      BLOCK_BLEND_METERS_PER_UNIT[1],
    );
    this.regionalMix = THREE.MathUtils.smoothstep(
      this.metersPerUnit,
      REGIONAL_BLEND_METERS_PER_UNIT[0],
      REGIONAL_BLEND_METERS_PER_UNIT[1],
    );
    const n = this.cols * this.rows;
    this.families = new Uint8Array(n);
    if (grid) for (let i = 0; i < n; i++) this.families[i] = fuelFamily(grid.fuelCodes[i]);

    // Surface elevation: open water at max(elevation, 0) so bathymetry reads as sea level.
    const surface = new Float32Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const e = grid ? grid.elevationMeters[i] : 0;
      const s = this.families[i] === FuelFamily.Water ? Math.max(e, 0) : e;
      surface[i] = Number.isFinite(s) ? s : 0;
      lo = Math.min(lo, surface[i]);
      hi = Math.max(hi, surface[i]);
    }
    this.minElevation = lo;
    const trueRelief = Math.max(1e-3, (hi - lo) * this.unitsPerMeter);
    const ve = VERTICAL_EXAGGERATION;
    const rg = REGIONAL_EXAGGERATION;
    const mix = this.regionalMix;
    const target = THREE.MathUtils.lerp(ve.targetReliefUnits, rg.targetReliefUnits, mix);
    let exaggeration = THREE.MathUtils.clamp(
      target / trueRelief,
      THREE.MathUtils.lerp(ve.min, rg.min, mix),
      THREE.MathUtils.lerp(ve.max, rg.max, mix),
    );
    if (trueRelief * exaggeration > ve.maxReliefUnits)
      exaggeration = Math.max(1, ve.maxReliefUnits / trueRelief);
    if (mix > 0 && grid) {
      // Keep the tallest peak within ~70 units of the board's median surface (no spikes).
      const stride = Math.max(1, Math.floor(n / 20000));
      const sample: number[] = [];
      for (let i = 0; i < n; i += stride) sample.push(surface[i]);
      sample.sort((a, c) => a - c);
      const above = Math.max(1e-3, (hi - sample[sample.length >> 1]) * this.unitsPerMeter);
      const cap = THREE.MathUtils.lerp(1000, rg.maxAboveMedianUnits, mix) / above;
      exaggeration = Math.max(1, Math.min(exaggeration, cap));
    }
    this.verticalExaggeration = exaggeration;
    const vScale = this.unitsPerMeter * exaggeration;

    const longest = Math.max(this.cols, this.rows);
    const seg = Math.min(MAX_SEGMENTS, longest);
    this.segX = Math.max(2, Math.round((seg * this.cols) / longest));
    this.segZ = Math.max(2, Math.round((seg * this.rows) / longest));
    // Sampling box of k×k cells per vertex (k ≥ 2 so a vertex on a cell corner sees all four).
    const k = Math.max(2, Math.round(this.cols / this.segX));
    const vx = this.segX + 1;
    this.heights = new Float32Array(vx * (this.segZ + 1));
    this.waterLevel = new Float32Array(this.heights.length);
    this.isWater = new Uint8Array(this.heights.length);
    this.waterFrac = new Float32Array(this.heights.length);
    const depression = THREE.MathUtils.lerp(
      WATER_DEPRESSION,
      REGIONAL_WATER_DEPRESSION,
      this.regionalMix,
    );
    let maxH = 0;
    for (let j = 0; j <= this.segZ; j++) {
      const gz = (j / this.segZ) * this.rows - 0.5;
      for (let i = 0; i <= this.segX; i++) {
        const gx = (i / this.segX) * this.cols - 0.5;
        const c0 = Math.round(gx - (k - 1) / 2);
        const r0 = Math.round(gz - (k - 1) / 2);
        let sumL = 0;
        let nL = 0;
        let sumW = 0;
        let nW = 0;
        for (let r = r0; r < r0 + k; r++) {
          const rr = Math.min(this.rows - 1, Math.max(0, r));
          for (let c = c0; c < c0 + k; c++) {
            const ci = rr * this.cols + Math.min(this.cols - 1, Math.max(0, c));
            if (this.families[ci] === FuelFamily.Water) {
              sumW += surface[ci];
              nW++;
            } else {
              sumL += surface[ci];
              nL++;
            }
          }
        }
        const f = nW / (nW + nL);
        const hLand = nL ? sumL / nL : sumW / nW;
        const hWater = nW ? sumW / nW : hLand;
        // Terrain eases from land height to pressed-down water height across the shore, so
        // the flat water surface meets it on a smooth line rather than a stepped one.
        const s = THREE.MathUtils.smoothstep(f, 0.25, 0.75);
        const h = (THREE.MathUtils.lerp(hLand, hWater, s) - lo) * vScale;
        const v = j * vx + i;
        this.waterFrac[v] = f;
        if (nW) this.waterLevel[v] = (hWater - lo) * vScale;
        if (f >= 0.5) this.isWater[v] = 1;
        this.heights[v] = h - depression * s;
        maxH = Math.max(maxH, h);
      }
    }
    this.maxHeight = maxH;
  }

  cellIndex(col: number, row: number) {
    return row * this.cols + col;
  }

  /** Grid cell under world (x, z), or −1 off the board. */
  cellAt(x: number, z: number): number {
    const col = Math.floor(x / this.cellWorld + this.cols / 2);
    const row = Math.floor(z / this.cellWorld + this.rows / 2);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  cellCentre(col: number, row: number, out: { x: number; z: number }) {
    out.x = (col + 0.5 - this.cols / 2) * this.cellWorld;
    out.z = (row + 0.5 - this.rows / 2) * this.cellWorld;
    return out;
  }

  /** Web Mercator coordinate of world (x, z) (continuous, cell centres at integer cells). */
  toMercator(x: number, z: number): [number, number] | null {
    const g = this.grid;
    if (!g) return null;
    const col = x / this.cellWorld + this.cols / 2 - 0.5;
    const row = z / this.cellWorld + this.rows / 2 - 0.5;
    return [g.originX + col * g.cellSizeX, g.originY + row * g.cellSizeY];
  }

  /** World (x, z) of a Web Mercator coordinate. */
  fromMercator(mx: number, my: number): { x: number; z: number } | null {
    const g = this.grid;
    if (!g) return null;
    const col = (mx - g.originX) / g.cellSizeX;
    const row = (my - g.originY) / g.cellSizeY;
    return {
      x: (col + 0.5 - this.cols / 2) * this.cellWorld,
      z: (row + 0.5 - this.rows / 2) * this.cellWorld,
    };
  }

  inside(x: number, z: number) {
    return Math.abs(x) <= this.halfW && Math.abs(z) <= this.halfD;
  }

  /** Terrain surface height at (x, z), exactly on the mesh triangles. */
  heightAt(x: number, z: number): number {
    const fx = THREE.MathUtils.clamp(
      ((x + this.halfW) / (2 * this.halfW)) * this.segX,
      0,
      this.segX - 1e-6,
    );
    const fz = THREE.MathUtils.clamp(
      ((z + this.halfD) / (2 * this.halfD)) * this.segZ,
      0,
      this.segZ - 1e-6,
    );
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const vx = this.segX + 1;
    const h00 = this.heights[j * vx + i];
    const h10 = this.heights[j * vx + i + 1];
    const h01 = this.heights[(j + 1) * vx + i];
    const h11 = this.heights[(j + 1) * vx + i + 1];
    // Diagonal from (0,0) to (1,1), matching the mesh index order.
    return u >= v
      ? h00 + (h10 - h00) * u + (h11 - h10) * v
      : h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** Height of whatever is visible at (x, z): water surface over water, else terrain. */
  surfaceAt(x: number, z: number): number {
    const t = this.heightAt(x, z);
    const fx = Math.round(
      THREE.MathUtils.clamp(((x + this.halfW) / (2 * this.halfW)) * this.segX, 0, this.segX),
    );
    const fz = Math.round(
      THREE.MathUtils.clamp(((z + this.halfD) / (2 * this.halfD)) * this.segZ, 0, this.segZ),
    );
    const v = fz * (this.segX + 1) + fx;
    return this.isWater[v] ? Math.max(t, this.waterLevel[v]) : t;
  }
}

// ---------------------------------------------------------------------------------------
// Ground textures

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

function putColor(data: Uint8Array, i: number, c: THREE.Color, alpha = 255) {
  // Colours are authored in sRGB; the texture is tagged sRGB so the GPU decodes it.
  data[i * 4] = Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255);
  data[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255);
  data[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255);
  data[i * 4 + 3] = alpha;
}

function makeTexture(data: Uint8Array, w: number, h: number, mipmaps: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mipmaps;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Miniature ground tones (one texel per cell) and the fuel-family overlay tint. The ground
 * texture's alpha channel carries the urban mask (255 on urban cells) for the terrain
 * shader's block/street layer; the terrain material is opaque, so it is never blended.
 */
export function buildGroundTextures(frame: BoardFrame): {
  ground: THREE.DataTexture;
  overlay: THREE.DataTexture;
} {
  const { cols, rows, families, grid } = frame;
  const ground = new Uint8Array(cols * rows * 4);
  const overlay = new Uint8Array(cols * rows * 4);
  const forest = new THREE.Color(PALETTE.deepForest);
  // Unloaded board: a blank, unpainted model base.
  const empty = new THREE.Color(0xd8d2bf);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const fam = families[i] as FuelFamily;
      if (!grid) {
        tmpA.copy(empty).multiplyScalar(0.97 + hash2(c, r) * 0.05);
        putColor(ground, i, tmpA, 0);
        putColor(overlay, i, tmpA);
        continue;
      }
      if (fam === FuelFamily.Agriculture) {
        // Fields: blocks of furrows with a per-block heading.
        const bc = Math.floor(c / 14);
        const br = Math.floor(r / 14);
        const hb = hash2(bc * 1.7, br * 2.3);
        const angle = hb < 0.4 ? 0 : hb < 0.8 ? Math.PI / 2 : Math.PI / 4;
        const s = Math.floor((c * Math.cos(angle) + r * Math.sin(angle)) / 1.6);
        const base = Math.floor(hb * 7) % 2;
        tmpA.set(FIELD_STRIPES[(base * 2 + (s & 1)) % FIELD_STRIPES.length]);
      } else {
        tmpA.set(GROUND_COLORS[fam]);
        // Soft low-frequency mottling plus a little per-cell grain.
        const mottle = hash2(Math.floor(c / 9) * 0.71, Math.floor(r / 9) * 1.37);
        tmpA.multiplyScalar(0.95 + mottle * 0.08 + (hash2(c * 0.37, r * 0.53) - 0.5) * 0.04);
        const cover = grid.canopyCoverFraction[i] || 0;
        if (cover > 0 && fam !== FuelFamily.Urban && fam !== FuelFamily.Water)
          tmpA.lerp(forest, Math.min(0.35, cover * 0.4));
      }
      putColor(ground, i, tmpA, fam === FuelFamily.Urban ? 255 : 0);
      tmpB.set(OVERLAY_COLORS[fam]);
      putColor(overlay, i, tmpB);
    }
  }
  return {
    ground: makeTexture(ground, cols, rows, true),
    overlay: makeTexture(overlay, cols, rows, true),
  };
}

// ---------------------------------------------------------------------------------------
// Fire field on the GPU

/** Arrival times above this are "never burns" on the GPU. */
export const NEVER = 1.0e6;
/** Largest arrival texture side; bigger grids are reduced by taking the earliest arrival. */
const MAX_FIRE_TEXTURE = 1024;

export type FireUniforms = {
  uArrival: { value: THREE.DataTexture };
  uArrivalSize: { value: THREE.Vector2 };
  /** world (x, z) → arrival texel coordinate (cell centres at integers): (sx, ox, sz, oz). */
  uXform: { value: THREE.Vector4 };
  uSimT: { value: number };
  /** Minutes a cell keeps flaming after arrival. */
  uWindow: { value: number };
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uHeadRange: { value: THREE.Vector2 };
  uOverlayTex: { value: THREE.Texture };
  uOverlay: { value: number };
  /** Cell size in world units (for the organic edge warp scale). */
  uCell: { value: number };
  /** Block/street layer strength (0 = none) and world units per ground metre. */
  uBlock: { value: number };
  /** Strength of the procedural street grid (0 when real streets are drawn). */
  uStreets: { value: number };
  uUnitsPerMeter: { value: number };
  /** Slope shading strength (0..1) and board max height (world units). */
  uRelief: { value: number };
  uMaxH: { value: number };
  /**
   * Opt-in per-cell fire states (`FireDioramaSceneApi.setCellStates`): codes 0 unburned,
   * 1 burning, 2 burned out, 3 extinguished, same texel layout as `uArrival`. Used only while
   * `uUseState` is 1; otherwise the arrival field and burn window decide (the default).
   */
  uState: { value: THREE.DataTexture };
  uUseState: { value: number };
};

/** Cell fire state codes understood by the terrain shader and the cover (setCellStates). */
export const CELL_STATE = { unburned: 0, burning: 1, burnedOut: 2, extinguished: 3 } as const;
/**
 * Approximate on-screen colours of put-out (extinguished) ground in the terrain shader (lit,
 * sRGB), for legend swatches: the slate fill, its pale hatch and the dashed cool outline.
 */
export const EXTINGUISHED_LEGEND = { fill: "#7d8c99", hatch: "#d0dde8", edge: "#cce6ff" } as const;
/** When several cells share a texel, the most telling state wins: burning, then put out, then burned out. */
const STATE_RANK = [0, 3, 1, 2] as const;

export function emptyArrivalTexture(): THREE.DataTexture {
  return arrivalTexture(new Float32Array([NEVER]), 1, 1);
}

function stateTexture(data: Uint8Array, w: number, h: number) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export function emptyStateTexture(): THREE.DataTexture {
  return stateTexture(new Uint8Array([0]), 1, 1);
}

/**
 * Packs per-cell state codes (row-major, CELL_STATE) into a texture laid out like the
 * arrival texture reduced by `factor`; the most telling state of a texel's cells wins.
 */
export function buildStateTexture(
  frame: BoardFrame,
  states: Uint8Array,
  factor: number,
): THREE.DataTexture {
  const w = Math.ceil(frame.cols / factor);
  const h = Math.ceil(frame.rows / factor);
  const data = new Uint8Array(w * h);
  if (factor === 1) {
    for (let i = 0; i < data.length; i++) data[i] = states[i] <= 3 ? states[i] : 0;
  } else {
    for (let r = 0; r < frame.rows; r++) {
      const tr = Math.floor(r / factor);
      for (let c = 0; c < frame.cols; c++) {
        const s = states[r * frame.cols + c];
        if (!s || s > 3) continue;
        const ti = tr * w + Math.floor(c / factor);
        if (STATE_RANK[s] > STATE_RANK[data[ti]]) data[ti] = s;
      }
    }
  }
  return stateTexture(data, w, h);
}

function arrivalTexture(data: Float32Array, w: number, h: number) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Packs `arrivalMinutes` (row-major, Infinity = never) into a float texture; arrivals past
 * `horizon` count as never, matching the model's frames.
 */
export function buildArrivalTexture(
  frame: BoardFrame,
  arrival: Float32Array,
  horizon: number,
): { tex: THREE.DataTexture; factor: number } {
  const factor = Math.max(1, Math.ceil(Math.max(frame.cols, frame.rows) / MAX_FIRE_TEXTURE));
  const w = Math.ceil(frame.cols / factor);
  const h = Math.ceil(frame.rows / factor);
  const data = new Float32Array(w * h).fill(NEVER);
  for (let r = 0; r < frame.rows; r++) {
    const tr = Math.floor(r / factor);
    for (let c = 0; c < frame.cols; c++) {
      const a = arrival[r * frame.cols + c];
      if (!(a <= horizon)) continue;
      const ti = tr * w + Math.floor(c / factor);
      if (a < data[ti]) data[ti] = a;
    }
  }
  return { tex: arrivalTexture(data, w, h), factor };
}

export function createFireUniforms(frame: BoardFrame, overlay: THREE.Texture): FireUniforms {
  const u: FireUniforms = {
    uArrival: { value: emptyArrivalTexture() },
    uArrivalSize: { value: new THREE.Vector2(1, 1) },
    uXform: { value: new THREE.Vector4() },
    uSimT: { value: -1 },
    uWindow: { value: 20 },
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0, 1) },
    uHeadRange: { value: new THREE.Vector2(0, 1) },
    uOverlayTex: { value: overlay },
    uOverlay: { value: 0 },
    uCell: { value: frame.cellWorld },
    uBlock: { value: frame.grid ? frame.blockMix : 0 },
    uStreets: { value: 1 },
    uUnitsPerMeter: { value: frame.unitsPerMeter },
    uRelief: { value: frame.grid ? 0.35 + 0.65 * frame.regionalMix : 0 },
    uMaxH: { value: Math.max(1, frame.maxHeight) },
    uState: { value: emptyStateTexture() },
    uUseState: { value: 0 },
  };
  setFireXform(u, frame, 1);
  return u;
}

export function setFireXform(u: FireUniforms, frame: BoardFrame, factor: number) {
  const s = 1 / (frame.cellWorld * factor);
  u.uXform.value.set(s, frame.cols / 2 / factor - 0.5, s, frame.rows / 2 / factor - 0.5);
  u.uArrivalSize.value.set(Math.ceil(frame.cols / factor), Math.ceil(frame.rows / factor));
  u.uCell.value = frame.cellWorld * factor;
}

/**
 * Fire drawn inside the terrain material so it conforms to the relief: burned cells char
 * to umber/ash, burning cells glow amber-coral (brightest at the fresh front and at the
 * downwind head), and a crisp warm-ivory line marks the current perimeter (where arrival
 * crosses t). Cell states are blended bilinearly with a small noise warp so the edge reads
 * organic rather than as grid squares. The fuel overlay tint is mixed in underneath.
 */
const FIRE_GLSL = /* glsl */ `
uniform sampler2D uArrival;
uniform vec2 uArrivalSize;
uniform vec4 uXform;
uniform float uSimT;
uniform float uWindow;
uniform float uTime;
uniform vec2 uWindDir;
uniform vec2 uHeadRange;
uniform sampler2D uOverlayTex;
uniform float uOverlay;
uniform float uCell;
uniform float uBlock;
uniform float uStreets;
uniform float uUnitsPerMeter;
uniform float uRelief;
uniform float uMaxH;
uniform sampler2D uState;
uniform float uUseState;
varying vec2 vFireXZ;
varying float vFireY;

// Opt-in cell state code (0 unburned, 1 burning, 2 burned out, 3 extinguished; see uState).
float stateCode(ivec2 c) { return floor(texelFetch(uState, c, 0).r * 255.0 + 0.5); }
bool inField(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < int(uArrivalSize.x) && c.y < int(uArrivalSize.y); }
float extCell(ivec2 c) {
  if (uUseState < 0.5 || !inField(c)) return 0.0;
  return stateCode(c) > 2.5 ? 1.0 : 0.0;
}

float fHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Urban areas on regional boards: warm ivory blocks with a faint street grid, drawn per pixel
// so it fades out (instead of aliasing) once a block is only a few pixels wide.
const vec3 URBAN_IVORY = vec3(0.80, 0.72, 0.55);
const vec3 URBAN_STREET = vec3(0.49, 0.39, 0.27);
// Lawn-and-garden tone for town ground when real streets (not the procedural grid) are drawn.
const vec3 URBAN_GARDEN = vec3(0.64, 0.66, 0.43);
vec3 applyUrban(vec3 base, float mask, vec2 pxU2) {
  float m = mask * uBlock;
  if (m < 0.01) return base;
  float pxU = max(pxU2.x, pxU2.y);
  // Real blocks (~150 m) when they are several pixels wide, else coarser arterial cells.
  float blockU = max(150.0 * uUnitsPerMeter, 7.0);
  // Street-grid heading changes per ~4 km district, like real neighbourhood grids.
  vec2 district = floor(vFireXZ / (4000.0 * uUnitsPerMeter));
  float pick = floor(fHash(district + 3.7) * 6.0);
  float ang = pick < 1.0 ? 0.0 : pick < 2.0 ? 0.14 : pick < 3.0 ? -0.2 : pick < 4.0 ? 0.35 : pick < 5.0 ? -0.42 : 0.62;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 p = vec2(ca * vFireXZ.x + sa * vFireXZ.y, -sa * vFireXZ.x + ca * vFireXZ.y);
  vec2 cell = p / blockU;
  vec2 f = fract(cell);
  vec2 dl = min(f, 1.0 - f) * blockU;
  float d = min(dl.x, dl.y);
  float fade = 1.0 - smoothstep(0.1, 0.22, pxU / blockU);
  float w = max(20.0 * uUnitsPerMeter, pxU * 0.9);
  float line = (1.0 - smoothstep(w * 0.5, w * 1.5, d)) * fade * uStreets;
  float tone = (fHash(floor(cell) + district * 7.0) - 0.5) * 0.07 * fade * uStreets;
  vec3 c = mix(base, mix(URBAN_GARDEN, URBAN_IVORY, uStreets) + tone, m * 0.8);
  return mix(c, URBAN_STREET, line * 0.55 * m);
}

// Slope shading from the facet normal: steep and north-facing slopes go darker sage, gentle
// high ground (ridgelines, summits) a little lighter, so ranges read at the oblique view.
vec3 applyRelief(vec3 base) {
  vec3 p = vec3(vFireXZ.x, vFireY, vFireXZ.y);
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  if (n.y < 0.0) n = -n;
  float steep = smoothstep(0.08, 0.55, 1.0 - n.y);
  float north = clamp(-n.z * 0.5 + 0.5, 0.0, 1.0);
  float high = smoothstep(0.35, 1.0, vFireY / uMaxH);
  vec3 sage = base * vec3(0.55, 0.66, 0.5);
  vec3 c = mix(base, sage, steep * (0.35 + 0.5 * north) * uRelief);
  c *= 1.0 + 0.16 * high * (1.0 - steep) * uRelief;
  return c;
}

// x arrived (burning or burned), y burning, z fresh front, w recently-burned ember.
vec4 fireCell(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uArrivalSize.x) || c.y >= int(uArrivalSize.y)) return vec4(0.0);
  float arr = texelFetch(uArrival, c, 0).r;
  float age = uSimT - arr;
  if (uUseState > 0.5) {
    // States decide; the arrival only freshens the front (fresh = arrived within the window).
    float s = stateCode(c);
    if (s < 0.5) return vec4(0.0);
    float lit = s < 1.5 ? 1.0 : 0.0;
    float hot = lit * (1.0 - smoothstep(0.0, 0.22 * uWindow, max(age, 0.0)));
    float glowing = (s > 1.5 && s < 2.5) ? 1.0 - smoothstep(uWindow, uWindow * 3.0, age) : 0.0;
    return vec4(1.0, lit, hot, glowing);
  }
  if (age < 0.0) return vec4(0.0);
  float burning = age < uWindow ? 1.0 : 0.0;
  float fresh = burning * (1.0 - smoothstep(0.0, 0.22 * uWindow, age));
  float ember = (1.0 - burning) * (1.0 - smoothstep(uWindow, uWindow * 3.0, age));
  return vec4(1.0, burning, fresh, ember);
}

// Normalised age in [-1, 1]: -1 not yet (a window or more ahead), 0 arriving, 1 a window past.
float ageCell(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uArrivalSize.x) || c.y >= int(uArrivalSize.y)) return -1.0;
  return clamp((uSimT - texelFetch(uArrival, c, 0).r) / uWindow, -1.0, 1.0);
}
float ageAt(vec2 g) {
  vec2 b = floor(g);
  vec2 f = fract(g);
  ivec2 c = ivec2(b);
  return mix(mix(ageCell(c), ageCell(c + ivec2(1, 0)), f.x), mix(ageCell(c + ivec2(0, 1)), ageCell(c + ivec2(1, 1)), f.x), f.y);
}

float arrivedCell(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uArrivalSize.x) || c.y >= int(uArrivalSize.y)) return 0.0;
  if (uUseState > 0.5) return stateCode(c) > 0.5 ? 1.0 : 0.0;
  return texelFetch(uArrival, c, 0).r <= uSimT ? 1.0 : 0.0;
}
float arrivedAt(vec2 g) {
  vec2 b = floor(g);
  vec2 f = fract(g);
  ivec2 c = ivec2(b);
  return mix(mix(arrivedCell(c), arrivedCell(c + ivec2(1, 0)), f.x), mix(arrivedCell(c + ivec2(0, 1)), arrivedCell(c + ivec2(1, 1)), f.x), f.y);
}

vec3 applyFire(inout vec3 base) {
  vec2 g = vec2(vFireXZ.x * uXform.x + uXform.y, vFireXZ.y * uXform.z + uXform.w);
  vec2 q = vFireXZ / uCell;
  g += (vec2(fNoise(q * 0.45), fNoise(q * 0.45 + 17.0)) - 0.5) * 0.7;
  vec2 b = floor(g);
  vec2 f = fract(g);
  ivec2 c = ivec2(b);
  vec4 a = mix(mix(fireCell(c), fireCell(c + ivec2(1, 0)), f.x), mix(fireCell(c + ivec2(0, 1)), fireCell(c + ivec2(1, 1)), f.x), f.y);

  vec2 texPerPx = fwidth(g);
  float px = max(texPerPx.x, texPerPx.y);
  // Cells larger than a pixel: interpolate arrival *times* rather than on/off flags, so the
  // char edge, burning band and perimeter follow the true front instead of the cell lattice.
  float age = ageAt(g);
  float ageW = max(fwidth(age), 1e-3);
  float arrived = smoothstep(0.3, 0.7, a.x);
  float burning = smoothstep(0.3, 0.6, a.y);
  float front = smoothstep(0.15, 0.6, a.z);
  bool byState = uUseState > 0.5;
  if (px <= 0.45 && !byState) {
    float onset = smoothstep(-ageW, ageW, age);
    arrived = onset;
    burning = onset * (1.0 - smoothstep(0.82, 1.0, age));
    front = onset * (1.0 - smoothstep(0.0, 0.22, age));
  }

  float n = fNoise(q * 0.6 + vec2(0.0, -uTime * 0.6));
  float n2 = fNoise(q * 1.3 + vec2(uTime * 0.4, 3.0));
  vec3 charC = mix(vec3(0.022, 0.018, 0.016), vec3(0.085, 0.075, 0.068), fNoise(q * 0.35));
  base = mix(base, charC, arrived * 0.94);

  // Extinguished (put out) ground, opt-in states only: cool wet slate with pale diagonal hatch,
  // no glow, no embers, and a dashed cool outline below; burned-out ground stays plain char.
  float extRaw = 0.0;
  float hatchPeriod = 1.0;
  if (byState) {
    extRaw = mix(mix(extCell(c), extCell(c + ivec2(1, 0)), f.x), mix(extCell(c + ivec2(0, 1)), extCell(c + ivec2(1, 1)), f.x), f.y);
    float ext = smoothstep(0.3, 0.7, extRaw);
    vec2 pxW = fwidth(vFireXZ);
    float pw = max(pxW.x, pxW.y);
    hatchPeriod = max(uCell * 1.6, pw * 7.0);
    float d = abs(fract((vFireXZ.x + vFireXZ.y) / hatchPeriod) - 0.5) * hatchPeriod;
    float hw = hatchPeriod * 0.16;
    float hatch = 1.0 - smoothstep(hw - pw, hw + pw, d);
    vec3 wet = vec3(0.24, 0.30, 0.36);
    vec3 stripeC = vec3(0.66, 0.76, 0.84);
    base = mix(base, mix(wet, stripeC, hatch * 0.85), ext * 0.95);
    burning *= 1.0 - ext;
    front *= 1.0 - ext;
    a.w *= 1.0 - ext;
  }

  float head = clamp((dot(vFireXZ, uWindDir) - uHeadRange.x) / max(uHeadRange.y - uHeadRange.x, 1.0), 0.0, 1.0);
  float headGain = 0.35 + 0.65 * smoothstep(0.3, 1.0, head);
  front *= headGain;
  burning *= 0.6 + 0.4 * headGain;
  vec3 coral = vec3(1.0, 0.24, 0.08);
  vec3 amber = vec3(1.0, 0.55, 0.12);
  base = mix(base, vec3(0.06, 0.012, 0.006), burning * 0.85);
  vec3 em = mix(coral, amber, n * 0.8) * burning * (0.3 + 0.45 * n2) * 0.6;
  em += mix(amber, vec3(1.0, 0.7, 0.28), n2) * front * 0.8;
  float sparks = smoothstep(0.8, 0.96, fNoise(q * 2.1 + uTime * 0.05));
  em += amber * a.w * sparks * (1.0 - burning) * 0.9;

  // Current perimeter: where arrival crosses t, a constant ~1.5 px wide. When cells
  // are smaller than a pixel the field is pre-smoothed over the pixel footprint so the line
  // traces the fire's outline instead of aliasing into a wash over every small gap.
  float field = a.x;
  float line;
  if (px > 0.45 || byState) {
    float o = px * 0.9;
    field = (a.x + arrivedAt(g + vec2(o, 0.0)) + arrivedAt(g - vec2(o, 0.0)) + arrivedAt(g + vec2(0.0, o)) + arrivedAt(g - vec2(0.0, o))) * 0.2;
    float d = abs(field - 0.5);
    float w = max(fwidth(field), 1e-4);
    line = (1.0 - smoothstep(w * 0.6, w * 1.6, d)) * step(0.02, field) * step(field, 0.98);
  } else {
    // Isoline of the interpolated age field, a constant ~1.5 px wide.
    float d = abs(age);
    line = (1.0 - smoothstep(ageW * 0.6, ageW * 1.6, d)) * step(-0.98, age);
  }
  line *= 1.0 - smoothstep(2.5, 5.0, px);
  vec3 lineC = vec3(1.0, 0.82, 0.55);
  float cool = 0.0;
  if (byState) {
    // The edge of put-out ground: a cool, dashed, unlit outline instead of the warm perimeter.
    cool = smoothstep(0.05, 0.35, extRaw);
    float dash = step(0.45, fract((vFireXZ.x - vFireXZ.y) / (hatchPeriod * 1.3)));
    line *= mix(1.0, dash, cool);
    lineC = mix(lineC, vec3(0.80, 0.90, 1.0), cool);
  }
  base = mix(base, lineC, line * 0.85);
  em += lineC * line * 0.55 * (1.0 - cool);
  return em;
}
`;

export function attachFireShader(material: THREE.MeshStandardMaterial, uniforms: FireUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec2 vFireXZ;\nvarying float vFireY;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFireXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\nvFireY = transformed.y;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FIRE_GLSL}`)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb = applyUrban(diffuseColor.rgb, diffuseColor.a, fwidth(vFireXZ));\ndiffuseColor.rgb = applyRelief(diffuseColor.rgb);\ndiffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uOverlayTex, vMapUv).rgb, uOverlay * 0.88);\nvec3 fireEmissive = applyFire(diffuseColor.rgb);",
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += fireEmissive;",
      );
  };
  material.customProgramCacheKey = () => "fire-diorama-terrain";
}

// ---------------------------------------------------------------------------------------
// Meshes

/** Faceted terrain with the ground texture, fuel overlay and fire in its material. */
export function buildTerrain(
  frame: BoardFrame,
  ground: THREE.Texture,
  uniforms: FireUniforms,
): THREE.Mesh {
  const { segX, segZ, halfW, halfD, heights } = frame;
  const vx = segX + 1;
  const count = vx * (segZ + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let j = 0; j <= segZ; j++) {
    for (let i = 0; i <= segX; i++) {
      const v = j * vx + i;
      positions[v * 3] = -halfW + (i / segX) * 2 * halfW;
      positions[v * 3 + 1] = heights[v];
      positions[v * 3 + 2] = -halfD + (j / segZ) * 2 * halfD;
      uvs[v * 2] = i / segX;
      uvs[v * 2 + 1] = j / segZ;
    }
  }
  const index = new Uint32Array(segX * segZ * 6);
  let k = 0;
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * vx + i;
      const b = a + 1;
      const c = a + vx;
      const d = c + 1;
      // CCW seen from above, diagonal a–d (BoardFrame.heightAt relies on this).
      index[k++] = a;
      index[k++] = c;
      index[k++] = d;
      index[k++] = a;
      index[k++] = d;
      index[k++] = b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    map: ground,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });
  attachFireShader(material, uniforms);
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = "terrain";
  return mesh;
}

/** Cut earth sides of the board (soil strata) plus the dark base board. */
export function buildPlinth(frame: BoardFrame): THREE.Group {
  const group = new THREE.Group();
  const { segX, segZ, halfW, halfD } = frame;
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  const quad = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    ya0: number,
    ya1: number,
    yb0: number,
    yb1: number,
    col: number,
  ) => {
    c.set(col);
    positions.push(ax, ya0, az, bx, yb0, bz, bx, yb1, bz, ax, ya0, az, bx, yb1, bz, ax, ya1, az);
    for (let n = 0; n < 6; n++) colors.push(c.r, c.g, c.b);
  };
  const levels = (top: number) => {
    const l1 = top - 2.4;
    const l2 = Math.min(-6, l1 - 1.8);
    const l3 = Math.min(-11, l2 - 1.8);
    return [top, l1, l2, l3, BASE_Y];
  };
  const bands = [PALETTE.soilDark, PALETTE.soil, PALETTE.clay, PALETTE.soil];
  const vx = segX + 1;
  // Each side walks the edge vertices of the height lattice.
  const sides: { n: number; at: (s: number) => [number, number, number, number] }[] = [
    {
      n: segX,
      at: (s) => [
        -halfW + (s / segX) * 2 * halfW,
        -halfD,
        frame.heights[s],
        frame.waterLevel[s] * frame.isWater[s],
      ],
    },
    {
      n: segZ,
      at: (s) => [
        halfW,
        -halfD + (s / segZ) * 2 * halfD,
        frame.heights[s * vx + segX],
        frame.waterLevel[s * vx + segX] * frame.isWater[s * vx + segX],
      ],
    },
    {
      n: segX,
      at: (s) => [
        halfW - (s / segX) * 2 * halfW,
        halfD,
        frame.heights[segZ * vx + segX - s],
        frame.waterLevel[segZ * vx + segX - s] * frame.isWater[segZ * vx + segX - s],
      ],
    },
    {
      n: segZ,
      at: (s) => [
        -halfW,
        halfD - (s / segZ) * 2 * halfD,
        frame.heights[(segZ - s) * vx],
        frame.waterLevel[(segZ - s) * vx] * frame.isWater[(segZ - s) * vx],
      ],
    },
  ];
  for (const side of sides) {
    for (let s = 0; s < side.n; s++) {
      const [ax, az, ha, wa] = side.at(s);
      const [bx, bz, hb, wb] = side.at(s + 1);
      const la = levels(ha);
      const lb = levels(hb);
      for (let n = 0; n < 4; n++)
        quad(ax, az, bx, bz, la[n + 1], la[n], lb[n + 1], lb[n], bands[n]);
      // Resin "water" where open water meets the cut edge.
      if (wa > ha || wb > hb)
        quad(ax, az, bx, bz, ha, Math.max(wa, ha), hb, Math.max(wb, hb), PALETTE.waterSide);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const sidesMesh = new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
      flatShading: true,
    }),
  );
  sidesMesh.receiveShadow = true;
  group.add(sidesMesh);

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(2 * halfW + 2 * BOARD_MARGIN, 3, 2 * halfD + 2 * BOARD_MARGIN),
    new THREE.MeshStandardMaterial({ color: PALETTE.board, roughness: 0.7, metalness: 0.05 }),
  );
  board.position.y = BASE_Y - 1.5;
  board.receiveShadow = true;
  group.add(board);
  return group;
}

const WATER_VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * Calm water. A smooth open-water mask (one texel per cell, bilinear) decides where the
 * surface exists, so shores are soft contours instead of stepped quads; blurred mask mips
 * give a shallow-to-deep gradient away from the shore. Glints fade out with pixel size.
 */
const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uGlint;
uniform sampler2D uMask;
uniform vec4 uBoard;
uniform vec2 uBias;
#include <fog_pars_fragment>
varying vec3 vWorld;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 uv = (vWorld.xz - uBoard.xy) / uBoard.zw;
  float m = texture2D(uMask, uv).r;
  float w = max(fwidth(m), 0.02);
  float cover = smoothstep(0.5 - w - 0.1, 0.5 + w + 0.1, m);
  if (cover < 0.01) discard;
  float near = texture2D(uMask, uv, uBias.x).r;
  float far = texture2D(uMask, uv, uBias.y).r;
  float shallow = 1.0 - smoothstep(0.55, 0.98, near);
  float depth = smoothstep(0.6, 1.0, far);
  float tone = wNoise(vWorld.xz * 0.02);
  vec3 col = mix(uShallow, uDeep, clamp(0.25 + 0.55 * depth + 0.2 * tone, 0.0, 1.0));
  col = mix(col, uShallow * 1.12, shallow * 0.55);
  float px = max(fwidth(vWorld.x), fwidth(vWorld.z));
  float calm = 1.0 - smoothstep(0.5, 1.4, px);
  float n = wNoise(vec2(vWorld.x * 0.16 - uTime * 0.35, vWorld.z * 0.5)) * wNoise(vec2(vWorld.x * 0.09 + uTime * 0.06, vWorld.z * 0.12 - uTime * 0.2));
  col += uGlint * smoothstep(0.45, 0.85, n) * 0.2 * calm;
  // Faint sky sheen toward grazing angles.
  vec3 view = normalize(cameraPosition - vWorld);
  col = mix(col, uGlint, pow(1.0 - clamp(view.y, 0.0, 1.0), 4.0) * 0.18);
  gl_FragColor = vec4(col, 0.93 * cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Open-water mask texture (255 on water cells), mipmapped for the shore gradient. */
function buildWaterMask(frame: BoardFrame): THREE.DataTexture {
  const { cols, rows, families } = frame;
  const data = new Uint8Array(cols * rows);
  for (let i = 0; i < data.length; i++) data[i] = families[i] === FuelFamily.Water ? 255 : 0;
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Flat water quads over every lattice cell touching open water (98), at the local water level
 * (sea level for the Bay and ocean). The mask in the shader cuts the shoreline; the terrain
 * under water is pressed down so it never pokes through.
 */
export function buildWater(frame: BoardFrame): {
  mesh: THREE.Mesh | null;
  uniforms: { uTime: { value: number } };
  mask: THREE.Texture | null;
} {
  const { segX, segZ, halfW, halfD, waterFrac, waterLevel } = frame;
  const vx = segX + 1;
  const positions: number[] = [];
  const px = (i: number) => -halfW + (i / segX) * 2 * halfW;
  const pz = (j: number) => -halfD + (j / segZ) * 2 * halfD;
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const ids = [j * vx + i, j * vx + i + 1, (j + 1) * vx + i, (j + 1) * vx + i + 1];
      let level = Infinity;
      for (const id of ids) if (waterFrac[id] > 0) level = Math.min(level, waterLevel[id]);
      if (!Number.isFinite(level)) continue;
      const y = level + 0.15;
      const x0 = px(i);
      const x1 = px(i + 1);
      const z0 = pz(j);
      const z1 = pz(j + 1);
      positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    }
  }
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
      uShallow: { value: new THREE.Color(PALETTE.waterShallow) },
      uGlint: { value: new THREE.Color(PALETTE.waterGlint) },
      uMask: { value: null },
      uBoard: { value: new THREE.Vector4(-halfW, -halfD, 2 * halfW, 2 * halfD) },
      uBias: { value: new THREE.Vector2(0, 0) },
    },
  ]) as unknown as { uTime: { value: number } };
  if (positions.length === 0) return { mesh: null, uniforms, mask: null };
  const mask = buildWaterMask(frame);
  const u = uniforms as unknown as Record<string, { value: unknown }>;
  u.uMask.value = mask;
  // Mip bias so the shore gradient spans ~6 and ~30 world units whatever the cell size.
  (u.uBias.value as THREE.Vector2).set(
    THREE.MathUtils.clamp(Math.log2(6 / frame.cellWorld), 0, 6),
    THREE.MathUtils.clamp(Math.log2(30 / frame.cellWorld), 0, 8),
  );
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    fog: true,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.name = "water";
  mesh.renderOrder = 1;
  return { mesh, uniforms, mask };
}
