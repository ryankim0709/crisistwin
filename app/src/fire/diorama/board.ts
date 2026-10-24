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
export const VERTICAL_EXAGGERATION = { min: 1.6, max: 2.5, targetReliefUnits: 80, maxReliefUnits: 150 } as const;
/** Terrain under open water is pressed down this far so the flat water surface clips it. */
const WATER_DEPRESSION = 1.4;

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
  readonly minElevation: number;
  /** Height-mesh vertex lattice. */
  readonly segX: number;
  readonly segZ: number;
  readonly heights: Float32Array;
  /** True where the vertex's nearest cell is open water; water surface level per vertex. */
  readonly waterLevel: Float32Array;
  readonly isWater: Uint8Array;
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
    let exaggeration = THREE.MathUtils.clamp(ve.targetReliefUnits / trueRelief, ve.min, ve.max);
    if (trueRelief * exaggeration > ve.maxReliefUnits) exaggeration = Math.max(1, ve.maxReliefUnits / trueRelief);
    this.verticalExaggeration = exaggeration;
    const vScale = this.unitsPerMeter * exaggeration;

    const longest = Math.max(this.cols, this.rows);
    const seg = Math.min(MAX_SEGMENTS, longest);
    this.segX = Math.max(2, Math.round((seg * this.cols) / longest));
    this.segZ = Math.max(2, Math.round((seg * this.rows) / longest));
    const k = Math.max(1, Math.round(this.cols / this.segX));
    const vx = this.segX + 1;
    this.heights = new Float32Array(vx * (this.segZ + 1));
    this.waterLevel = new Float32Array(this.heights.length);
    this.isWater = new Uint8Array(this.heights.length);
    let maxH = 0;
    for (let j = 0; j <= this.segZ; j++) {
      const gz = (j / this.segZ) * this.rows - 0.5;
      for (let i = 0; i <= this.segX; i++) {
        const gx = (i / this.segX) * this.cols - 0.5;
        // Box average of the k×k cells around the vertex (k = cells per segment).
        const c0 = Math.round(gx - (k - 1) / 2);
        const r0 = Math.round(gz - (k - 1) / 2);
        let sum = 0;
        let count = 0;
        for (let r = r0; r < r0 + k; r++) {
          const rr = Math.min(this.rows - 1, Math.max(0, r));
          for (let c = c0; c < c0 + k; c++) {
            const cc = Math.min(this.cols - 1, Math.max(0, c));
            sum += surface[rr * this.cols + cc];
            count++;
          }
        }
        const h = (sum / count - lo) * vScale;
        const near = this.cellIndex(Math.min(this.cols - 1, Math.max(0, Math.round(gx))), Math.min(this.rows - 1, Math.max(0, Math.round(gz))));
        const v = j * vx + i;
        if (this.families[near] === FuelFamily.Water) {
          this.isWater[v] = 1;
          this.waterLevel[v] = h;
          this.heights[v] = h - WATER_DEPRESSION;
        } else {
          this.heights[v] = h;
        }
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
    return { x: (col + 0.5 - this.cols / 2) * this.cellWorld, z: (row + 0.5 - this.rows / 2) * this.cellWorld };
  }

  inside(x: number, z: number) {
    return Math.abs(x) <= this.halfW && Math.abs(z) <= this.halfD;
  }

  /** Terrain surface height at (x, z), exactly on the mesh triangles. */
  heightAt(x: number, z: number): number {
    const fx = THREE.MathUtils.clamp(((x + this.halfW) / (2 * this.halfW)) * this.segX, 0, this.segX - 1e-6);
    const fz = THREE.MathUtils.clamp(((z + this.halfD) / (2 * this.halfD)) * this.segZ, 0, this.segZ - 1e-6);
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
    return u >= v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** Height of whatever is visible at (x, z): water surface over water, else terrain. */
  surfaceAt(x: number, z: number): number {
    const t = this.heightAt(x, z);
    const fx = Math.round(THREE.MathUtils.clamp(((x + this.halfW) / (2 * this.halfW)) * this.segX, 0, this.segX));
    const fz = Math.round(THREE.MathUtils.clamp(((z + this.halfD) / (2 * this.halfD)) * this.segZ, 0, this.segZ));
    const v = fz * (this.segX + 1) + fx;
    return this.isWater[v] ? Math.max(t, this.waterLevel[v]) : t;
  }
}

// ---------------------------------------------------------------------------------------
// Ground textures

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

function putColor(data: Uint8Array, i: number, c: THREE.Color) {
  // Colours are authored in sRGB; the texture is tagged sRGB so the GPU decodes it.
  data[i * 4] = Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255);
  data[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255);
  data[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255);
  data[i * 4 + 3] = 255;
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

/** Miniature ground tones (one texel per cell) and the fuel-family overlay tint. */
export function buildGroundTextures(frame: BoardFrame): { ground: THREE.DataTexture; overlay: THREE.DataTexture } {
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
        putColor(ground, i, tmpA);
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
        if (cover > 0 && fam !== FuelFamily.Urban && fam !== FuelFamily.Water) tmpA.lerp(forest, Math.min(0.35, cover * 0.4));
      }
      putColor(ground, i, tmpA);
      tmpB.set(OVERLAY_COLORS[fam]);
      putColor(overlay, i, tmpB);
    }
  }
  return { ground: makeTexture(ground, cols, rows, true), overlay: makeTexture(overlay, cols, rows, true) };
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
};

export function emptyArrivalTexture(): THREE.DataTexture {
  return arrivalTexture(new Float32Array([NEVER]), 1, 1);
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
export function buildArrivalTexture(frame: BoardFrame, arrival: Float32Array, horizon: number): { tex: THREE.DataTexture; factor: number } {
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
varying vec2 vFireXZ;

float fHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// x arrived (burning or burned), y burning, z fresh front, w recently-burned ember.
vec4 fireCell(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uArrivalSize.x) || c.y >= int(uArrivalSize.y)) return vec4(0.0);
  float arr = texelFetch(uArrival, c, 0).r;
  float age = uSimT - arr;
  if (age < 0.0) return vec4(0.0);
  float burning = age < uWindow ? 1.0 : 0.0;
  float fresh = burning * (1.0 - smoothstep(0.0, 0.22 * uWindow, age));
  float ember = (1.0 - burning) * (1.0 - smoothstep(uWindow, uWindow * 3.0, age));
  return vec4(1.0, burning, fresh, ember);
}

float arrivedCell(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uArrivalSize.x) || c.y >= int(uArrivalSize.y)) return 0.0;
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

  float arrived = smoothstep(0.3, 0.7, a.x);
  float burning = smoothstep(0.3, 0.6, a.y);
  float front = smoothstep(0.15, 0.6, a.z);

  float n = fNoise(q * 0.6 + vec2(0.0, -uTime * 0.6));
  float n2 = fNoise(q * 1.3 + vec2(uTime * 0.4, 3.0));
  vec3 charC = mix(vec3(0.022, 0.018, 0.016), vec3(0.085, 0.075, 0.068), fNoise(q * 0.35));
  base = mix(base, charC, arrived * 0.94);

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

  // Current perimeter: the 0.5 isoline of "arrived", a constant ~1.5 px wide. When cells
  // are smaller than a pixel the field is pre-smoothed over the pixel footprint so the line
  // traces the fire's outline instead of aliasing into a wash over every small gap.
  vec2 texPerPx = fwidth(g);
  float px = max(texPerPx.x, texPerPx.y);
  float field = a.x;
  if (px > 0.45) {
    float o = px * 0.9;
    field = (a.x + arrivedAt(g + vec2(o, 0.0)) + arrivedAt(g - vec2(o, 0.0)) + arrivedAt(g + vec2(0.0, o)) + arrivedAt(g - vec2(0.0, o))) * 0.2;
  }
  float d = abs(field - 0.5);
  float w = max(fwidth(field), 1e-4);
  float line = (1.0 - smoothstep(w * 0.6, w * 1.6, d)) * step(0.02, field) * step(field, 0.98);
  line *= 1.0 - smoothstep(2.5, 5.0, px);
  vec3 lineC = vec3(1.0, 0.82, 0.55);
  base = mix(base, lineC, line * 0.85);
  em += lineC * line * 0.55;
  return em;
}
`;

export function attachFireShader(material: THREE.MeshStandardMaterial, uniforms: FireUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFireXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFireXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FIRE_GLSL}`)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uOverlayTex, vMapUv).rgb, uOverlay * 0.88);\nvec3 fireEmissive = applyFire(diffuseColor.rgb);",
      )
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += fireEmissive;");
  };
  material.customProgramCacheKey = () => "fire-diorama-terrain";
}

// ---------------------------------------------------------------------------------------
// Meshes

/** Faceted terrain with the ground texture, fuel overlay and fire in its material. */
export function buildTerrain(frame: BoardFrame, ground: THREE.Texture, uniforms: FireUniforms): THREE.Mesh {
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
  const material = new THREE.MeshStandardMaterial({ map: ground, roughness: 0.96, metalness: 0, flatShading: true });
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
  const quad = (ax: number, az: number, bx: number, bz: number, ya0: number, ya1: number, yb0: number, yb1: number, col: number) => {
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
    { n: segX, at: (s) => [-halfW + (s / segX) * 2 * halfW, -halfD, frame.heights[s], frame.waterLevel[s] * frame.isWater[s]] },
    { n: segZ, at: (s) => [halfW, -halfD + (s / segZ) * 2 * halfD, frame.heights[s * vx + segX], frame.waterLevel[s * vx + segX] * frame.isWater[s * vx + segX]] },
    { n: segX, at: (s) => [halfW - (s / segX) * 2 * halfW, halfD, frame.heights[segZ * vx + segX - s], frame.waterLevel[segZ * vx + segX - s] * frame.isWater[segZ * vx + segX - s]] },
    { n: segZ, at: (s) => [-halfW, halfD - (s / segZ) * 2 * halfD, frame.heights[(segZ - s) * vx], frame.waterLevel[(segZ - s) * vx] * frame.isWater[(segZ - s) * vx]] },
  ];
  for (const side of sides) {
    for (let s = 0; s < side.n; s++) {
      const [ax, az, ha, wa] = side.at(s);
      const [bx, bz, hb, wb] = side.at(s + 1);
      const la = levels(ha);
      const lb = levels(hb);
      for (let n = 0; n < 4; n++) quad(ax, az, bx, bz, la[n + 1], la[n], lb[n + 1], lb[n], bands[n]);
      // Resin "water" where open water meets the cut edge.
      if (wa > ha || wb > hb) quad(ax, az, bx, bz, ha, Math.max(wa, ha), hb, Math.max(wb, hb), PALETTE.waterSide);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const sidesMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, flatShading: true }));
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

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uGlint;
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
  float m = wNoise(vWorld.xz * 0.02);
  vec3 col = mix(uDeep, uShallow, 0.35 + 0.4 * m);
  float n = wNoise(vec2(vWorld.x * 0.16 - uTime * 0.35, vWorld.z * 0.5)) * wNoise(vec2(vWorld.x * 0.09 + uTime * 0.06, vWorld.z * 0.12 - uTime * 0.2));
  col += uGlint * smoothstep(0.42, 0.8, n) * 0.35;
  gl_FragColor = vec4(col, 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Flat water quads at the local surface level of open-water (98) vertices; the pressed-down
 * terrain beneath and the higher shore around clip it into a natural shoreline.
 */
export function buildWater(frame: BoardFrame): { mesh: THREE.Mesh | null; uniforms: { uTime: { value: number } } } {
  const { segX, segZ, halfW, halfD, isWater, waterLevel } = frame;
  const vx = segX + 1;
  const positions: number[] = [];
  const px = (i: number) => -halfW + (i / segX) * 2 * halfW;
  const pz = (j: number) => -halfD + (j / segZ) * 2 * halfD;
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const ids = [j * vx + i, j * vx + i + 1, (j + 1) * vx + i, (j + 1) * vx + i + 1];
      let level = Infinity;
      for (const id of ids) if (isWater[id]) level = Math.min(level, waterLevel[id]);
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
    },
  ]) as unknown as { uTime: { value: number } };
  if (positions.length === 0) return { mesh: null, uniforms };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    fog: true,
    transparent: true,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.name = "water";
  mesh.renderOrder = 1;
  return { mesh, uniforms };
}
