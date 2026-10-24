import * as THREE from "three";
import type { FireField, World } from "../types";
import { WATER_LEVEL, distanceToPolyline, heightAt } from "../world";
import { hash2, smoothstep } from "./geometry";
import { PALETTE } from "./palette";

/** Bottom of the model board's cut earth sides. */
export const BASE_Y = -18;
const GRID_STEP = 4;
/** Fire-field ignition times above this are treated as "never burns" on the GPU. */
const NEVER = 1.0e6;

export type FireUniforms = {
  uFire: { value: THREE.DataTexture };
  uFireGrid: { value: THREE.Vector4 };
  uFireSize: { value: THREE.Vector2 };
  uSimT: { value: number };
  uTime: { value: number };
  uHeldFrom: { value: number };
  /** Unit wind direction (x, z) and the downwind extent [min, max] of burning cells. */
  uWindDir: { value: THREE.Vector2 };
  uHeadRange: { value: THREE.Vector2 };
};

/** Packs the fire field into an RG float texture: R = ignition time, G = crew-held flag. */
export function createFireUniforms(fire: FireField, wind: { x: number; z: number }): FireUniforms {
  const data = new Float32Array(fire.cols * fire.rows * 2);
  for (let i = 0; i < fire.cols * fire.rows; i++) {
    const ign = fire.ignitionTime[i];
    data[i * 2] = Number.isFinite(ign) ? Math.min(ign, NEVER) : NEVER;
    data[i * 2 + 1] = fire.heldCells[i] ? 1 : 0;
  }
  const tex = new THREE.DataTexture(data, fire.cols, fire.rows, THREE.RGFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return {
    uFire: { value: tex },
    uFireGrid: { value: new THREE.Vector4(fire.originX, fire.originZ, fire.cellSize, fire.burnDuration) },
    uFireSize: { value: new THREE.Vector2(fire.cols, fire.rows) },
    uSimT: { value: 0 },
    uTime: { value: 0 },
    uHeldFrom: { value: Number.isFinite(fire.heldFrom) ? fire.heldFrom : NEVER },
    uWindDir: { value: new THREE.Vector2(wind.x, wind.z).normalize() },
    uHeadRange: { value: new THREE.Vector2(0, 1) },
  };
}

/**
 * Ground fire drawn inside the terrain material so it conforms exactly to the relief:
 * burned cells char to dark umber/ash, burning cells glow amber-coral with a brighter
 * fresh front (strongest at the downwind head, calmer on flanks and back), recently burned ground keeps faint embers, crew-held cells get a cool
 * striped "wet line" tint after `heldFrom`. Cells are blended bilinearly with a noise warp
 * so the front reads as an organic edge rather than grid squares.
 */
const FIRE_GLSL = /* glsl */ `
uniform sampler2D uFire;
uniform vec4 uFireGrid;
uniform vec2 uFireSize;
uniform float uSimT;
uniform float uTime;
uniform float uHeldFrom;
uniform vec2 uWindDir;
uniform vec2 uHeadRange;
varying vec2 vFireXZ;

float fHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// a: x burning, y burned, z fresh front, w held; ember: recently burned glow.
void fireCell(ivec2 c, out vec4 a, out float ember) {
  a = vec4(0.0);
  ember = 0.0;
  if (c.x < 0 || c.y < 0 || c.x >= int(uFireSize.x) || c.y >= int(uFireSize.y)) return;
  vec2 f = texelFetch(uFire, c, 0).rg;
  float burn = uFireGrid.w;
  float age = uSimT - f.r;
  float burning = (age >= 0.0 && age < burn) ? 1.0 : 0.0;
  float burned = age >= burn ? 1.0 : 0.0;
  a = vec4(burning, burned, burning * (1.0 - smoothstep(0.0, 0.45 * burn, age)), f.g);
  ember = burned * (1.0 - smoothstep(burn, burn * 3.0, age));
}

vec3 applyFire(inout vec3 base) {
  vec2 g = (vFireXZ - uFireGrid.xy) / uFireGrid.z - 0.5;
  g += (vec2(fNoise(vFireXZ * 0.09), fNoise(vFireXZ * 0.09 + 17.0)) - 0.5) * 0.9;
  vec2 b = floor(g);
  vec2 f = fract(g);
  ivec2 c = ivec2(b);
  vec4 a00; vec4 a10; vec4 a01; vec4 a11;
  float e00; float e10; float e01; float e11;
  fireCell(c, a00, e00);
  fireCell(c + ivec2(1, 0), a10, e10);
  fireCell(c + ivec2(0, 1), a01, e01);
  fireCell(c + ivec2(1, 1), a11, e11);
  vec4 a = mix(mix(a00, a10, f.x), mix(a01, a11, f.x), f.y);
  float ember = mix(mix(e00, e10, f.x), mix(e01, e11, f.x), f.y);

  float burning = smoothstep(0.3, 0.6, a.x);
  float burned = smoothstep(0.3, 0.7, a.y);
  float front = smoothstep(0.15, 0.6, a.z);
  float held = step(uHeldFrom, uSimT) * smoothstep(0.3, 0.7, a.w);

  float n = fNoise(vFireXZ * 0.35 + vec2(0.0, -uTime * 0.6));
  float n2 = fNoise(vFireXZ * 0.8 + vec2(uTime * 0.4, 3.0));
  vec3 charC = mix(vec3(0.035, 0.028, 0.024), vec3(0.15, 0.14, 0.13), fNoise(vFireXZ * 0.25));
  base = mix(base, charC, max(burned, burning) * 0.92);

  float stripe = step(0.5, fract((vFireXZ.x + vFireXZ.y) * 0.16));
  base = mix(base, vec3(0.24, 0.40, 0.50), held * (1.0 - burning) * (0.26 + 0.14 * stripe));

  // The flaming front is strongest at the downwind head and calmer on the flanks/back.
  float head = clamp((dot(vFireXZ, uWindDir) - uHeadRange.x) / max(uHeadRange.y - uHeadRange.x, 1.0), 0.0, 1.0);
  float headGain = 0.3 + 0.7 * smoothstep(0.35, 1.0, head);
  front *= headGain;
  burning *= 0.55 + 0.45 * headGain;
  vec3 coral = vec3(1.0, 0.2, 0.07);
  vec3 amber = vec3(1.0, 0.52, 0.1);
  vec3 em = mix(coral, amber, n) * burning * (0.55 + 0.6 * n2) * 1.3;
  em += mix(amber, vec3(1.0, 0.82, 0.42), n2) * front * 2.6;
  float sparks = smoothstep(0.78, 0.95, fNoise(vFireXZ * 1.3 + uTime * 0.05));
  em += amber * ember * sparks * (1.0 - burning) * 1.1;
  return em;
}
`;

function attachFireShader(material: THREE.MeshStandardMaterial, uniforms: FireUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFireXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFireXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FIRE_GLSL}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\nvec3 fireEmissive = applyFire(diffuseColor.rgb);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += fireEmissive;");
  };
  material.customProgramCacheKey = () => "diorama-terrain-fire";
}

const tmp = new THREE.Color();

function terrainColor(world: World, x: number, z: number, h: number, jitter: number, out: THREE.Color) {
  const c = out.set(PALETTE.meadow);
  c.lerp(tmp.set(PALETTE.meadowLight), smoothstep(0.35, 0.9, hash2(Math.floor(x / 37), Math.floor(z / 31))) * 0.5);
  const north = smoothstep(-50, -120, z);
  const hill = smoothstep(8, 35, h);
  const fringe = Math.max(smoothstep(150, 200, z) * 0.7, smoothstep(-230, -300, x) * 0.6, x > 150 && (z < -20 || z > 120) ? 0.4 : 0);
  c.lerp(tmp.set(PALETTE.forest), Math.max(north * 0.85, hill * 0.6, fringe));
  c.lerp(tmp.set(PALETTE.deepForest), hill * north * 0.75);
  const rd = distanceToPolyline({ x, z }, world.river.points);
  const sand = 1 - smoothstep(world.river.halfWidth + 5, world.river.halfWidth + 15, rd);
  c.lerp(tmp.set(PALETTE.sand), sand * 0.85);
  if (h < WATER_LEVEL + 0.3) c.lerp(tmp.set(PALETTE.riverbed), 0.8);
  c.multiplyScalar(0.95 + jitter * 0.09);
  return c;
}

/** Faceted, vertex-coloured terrain slab with the fire overlay in its material. */
export function buildTerrain(world: World, fireUniforms: FireUniforms): THREE.Mesh {
  const nx = Math.round(world.width / GRID_STEP);
  const nz = Math.round(world.depth / GRID_STEP);
  const x0 = -world.width / 2;
  const z0 = -world.depth / 2;
  const sx = world.width / nx;
  const sz = world.depth / nz;
  const heights = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) heights[j * (nx + 1) + i] = heightAt(x0 + i * sx, z0 + j * sz);

  const positions = new Float32Array(nx * nz * 6 * 3);
  const colors = new Float32Array(nx * nz * 6 * 3);
  const color = new THREE.Color();
  let v = 0;
  const pushTri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, ai: number, bi: number, ci: number) => {
    const ha = heights[ai];
    const hb = heights[bi];
    const hc = heights[ci];
    const mx = (ax + bx + cx) / 3;
    const mz = (az + bz + cz) / 3;
    terrainColor(world, mx, mz, (ha + hb + hc) / 3, hash2(mx * 0.37, mz * 0.53), color);
    const verts: [number, number, number][] = [
      [ax, ha, az],
      [bx, hb, bz],
      [cx, hc, cz],
    ];
    for (const [px, py, pz] of verts) {
      positions[v * 3] = px;
      positions[v * 3 + 1] = py;
      positions[v * 3 + 2] = pz;
      colors[v * 3] = color.r;
      colors[v * 3 + 1] = color.g;
      colors[v * 3 + 2] = color.b;
      v++;
    }
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const xa = x0 + i * sx;
      const xb = xa + sx;
      const za = z0 + j * sz;
      const zb = za + sz;
      const i00 = j * (nx + 1) + i;
      const i10 = i00 + 1;
      const i01 = i00 + nx + 1;
      const i11 = i01 + 1;
      // Alternate the diagonal for a less regular faceting. Winding is CCW seen from above.
      if ((i + j) % 2 === 0) {
        pushTri(xa, za, xa, zb, xb, zb, i00, i01, i11);
        pushTri(xa, za, xb, zb, xb, za, i00, i11, i10);
      } else {
        pushTri(xa, za, xa, zb, xb, za, i00, i01, i10);
        pushTri(xb, za, xa, zb, xb, zb, i10, i01, i11);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, flatShading: true });
  attachFireShader(material, fireUniforms);
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = "terrain";
  return mesh;
}

/** Cut earth sides of the model board (soil strata) plus the dark base board. */
export function buildPlinth(world: World): THREE.Group {
  const group = new THREE.Group();
  const hw = world.width / 2;
  const hd = world.depth / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  const quad = (ax: number, az: number, bx: number, bz: number, ya0: number, ya1: number, yb0: number, yb1: number, col: number) => {
    c.set(col);
    positions.push(ax, ya0, az, bx, yb0, bz, bx, yb1, bz, ax, ya0, az, bx, yb1, bz, ax, ya1, az);
    for (let k = 0; k < 6; k++) colors.push(c.r, c.g, c.b);
  };
  const sides: [number, number, number, number][] = [
    [-hw, -hd, hw, -hd],
    [hw, -hd, hw, hd],
    [hw, hd, -hw, hd],
    [-hw, hd, -hw, -hd],
  ];
  const levels = (top: number) => {
    const l1 = top - 2.2;
    const l2 = Math.min(-7, l1 - 1.5);
    const l3 = Math.min(-12.5, l2 - 1.5);
    return [top, l1, l2, l3, BASE_Y];
  };
  const bandColors = [PALETTE.soilDark, PALETTE.soil, PALETTE.clay, PALETTE.soil];
  for (const [ax, az, bx, bz] of sides) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.round(len / GRID_STEP);
    for (let i = 0; i < n; i++) {
      const pax = ax + ((bx - ax) * i) / n;
      const paz = az + ((bz - az) * i) / n;
      const pbx = ax + ((bx - ax) * (i + 1)) / n;
      const pbz = az + ((bz - az) * (i + 1)) / n;
      const ha = heightAt(pax, paz);
      const hb = heightAt(pbx, pbz);
      const la = levels(ha);
      const lb = levels(hb);
      for (let k = 0; k < 4; k++) quad(pax, paz, pbx, pbz, la[k + 1], la[k], lb[k + 1], lb[k], bandColors[k]);
      // Resin "water" where the river meets the cut edge.
      if (ha < WATER_LEVEL || hb < WATER_LEVEL) {
        quad(pax, paz, pbx, pbz, Math.min(ha, WATER_LEVEL), WATER_LEVEL, Math.min(hb, WATER_LEVEL), WATER_LEVEL, PALETTE.waterSide);
      }
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
    new THREE.BoxGeometry(world.width + 14, 3, world.depth + 14),
    new THREE.MeshStandardMaterial({ color: PALETTE.board, roughness: 0.7, metalness: 0.05 }),
  );
  board.position.y = BASE_Y - 1.5;
  board.receiveShadow = true;
  group.add(board);
  return group;
}

const WATER_VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
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
varying vec2 vUv;
varying vec3 vWorld;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float across = abs(vUv.y - 0.5) * 2.0;
  vec3 col = mix(uDeep, uShallow, smoothstep(0.05, 0.75, across));
  float n = wNoise(vec2(vUv.x * 0.12 - uTime * 0.5, vUv.y * 7.0)) * wNoise(vec2(vWorld.x * 0.11 + uTime * 0.08, vWorld.z * 0.07 - uTime * 0.25));
  col += uGlint * smoothstep(0.42, 0.8, n) * 0.4;
  gl_FragColor = vec4(col, 0.9);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Water ribbon at WATER_LEVEL; the terrain clips its banks into a natural shoreline. */
export function buildWater(world: World): { mesh: THREE.Mesh; uniforms: { uTime: { value: number } } } {
  const curve = new THREE.CatmullRomCurve3(world.river.points.map((p) => new THREE.Vector3(p.x, 0, p.z)));
  const length = curve.getLength();
  const n = Math.ceil(length / 3);
  const half = world.river.halfWidth + 16;
  const hw = world.width / 2;
  const hd = world.depth / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    for (const side of [1, -1]) {
      const x = THREE.MathUtils.clamp(p.x + t.z * half * side, -hw, hw);
      const z = THREE.MathUtils.clamp(p.z - t.x * half * side, -hd, hd);
      positions.push(x, WATER_LEVEL, z);
      uvs.push(u * length, side > 0 ? 0 : 1);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
      uShallow: { value: new THREE.Color(PALETTE.waterShallow) },
      uGlint: { value: new THREE.Color(PALETTE.waterGlint) },
    },
  ]);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    fog: true,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = false;
  mesh.name = "river";
  return { mesh, uniforms: uniforms as unknown as { uTime: { value: number } } };
}
