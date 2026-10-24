import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Vec2 } from "../types";

/** Deterministic hash in [0, 1) for decorative variation (no Math.random in the scene). */
export function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Converts a geometry to non-indexed position/normal/color only (so differently built
 * pieces merge), paints it one colour and recomputes flat normals unless `smooth`.
 */
export function paint(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, smooth = false): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  }
  if (!smooth || !g.getAttribute("normal")) g.computeVertexNormals();
  const c = new THREE.Color(color);
  const count = g.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpScale = new THREE.Vector3(1, 1, 1);
const tmpPos = new THREE.Vector3();

/** Applies translation and yaw (radians about +y) in place and returns the geometry. */
export function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  tmpEuler.set(0, rotY, 0);
  tmpQuat.setFromEuler(tmpEuler);
  tmpPos.set(x, y, z);
  tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
  g.applyMatrix4(tmpMatrix);
  return g;
}

/** Painted box centred at (x, y, z) in local coordinates. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, rotY = 0) {
  return place(paint(new THREE.BoxGeometry(w, h, d), color), x, y, z, rotY);
}

/** Merges painted geometries and disposes the parts. */
export function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("Diorama scene: failed to merge geometries (attribute mismatch)");
  return merged;
}

/**
 * Gable roof slopes with the ridge along local x, eaves at y = 0, overhang `o`, plus the
 * triangular gable-end walls (wall colour) under the ridge. Slopes are single-sided; the
 * roof material should be double-sided so the underside of the overhang renders.
 */
export function gableRoof(w: number, d: number, rise: number, o: number, roofColor: THREE.ColorRepresentation, wallColor: THREE.ColorRepresentation) {
  const x0 = -w / 2 - o;
  const x1 = w / 2 + o;
  const z0 = -d / 2 - o;
  const z1 = d / 2 + o;
  const slopes = new THREE.BufferGeometry();
  // prettier-ignore
  slopes.setAttribute("position", new THREE.Float32BufferAttribute([
    x0, 0, z1, x1, 0, z1, x1, rise, 0,
    x0, 0, z1, x1, rise, 0, x0, rise, 0,
    x1, 0, z0, x0, 0, z0, x0, rise, 0,
    x1, 0, z0, x0, rise, 0, x1, rise, 0,
  ], 3));
  const hw = w / 2;
  const hd = d / 2;
  const gables = new THREE.BufferGeometry();
  // prettier-ignore
  gables.setAttribute("position", new THREE.Float32BufferAttribute([
    -hw, 0, -hd, -hw, 0, hd, -hw, rise, 0,
    hw, 0, hd, hw, 0, -hd, hw, rise, 0,
  ], 3));
  return [paint(slopes, roofColor), paint(gables, wallColor)];
}

/** Uniformly resamples a polyline every `step` units (keeps both ends). */
export function resample(points: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let d = step - carry;
    while (d < len) {
      const f = d / len;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
      d += step;
    }
    carry = len - (d - step);
  }
  const last = points[points.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last.x - prev.x, last.z - prev.z) > step * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/**
 * Ribbon draped along `points`: uv.x is distance along (world units), uv.y is 0..1 across.
 * Vertex y = `heightFn(x, z)`. Indexed with position/normal/uv.
 */
export function ribbon(points: Vec2[], width: number, heightFn: (x: number, z: number) => number, step = 2.5, across = 2): THREE.BufferGeometry {
  const pts = resample(points, step);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let distance = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    if (i > 0) distance += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    // Left = p + (tz, -tx)·w/2, right = p + (-tz, tx)·w/2 (y up, travelling along +t).
    for (let k = 0; k <= across; k++) {
      const f = k / across;
      const off = (0.5 - f) * width;
      const x = pts[i].x + tz * off;
      const z = pts[i].z - tx * off;
      positions.push(x, heightFn(x, z), z);
      uvs.push(distance, f);
    }
  }
  const row = across + 1;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k < across; k++) {
      const a = i * row + k;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Soft round sprite texture (white, radial alpha falloff). */
export function softDotTexture(size = 64, hardness = 0): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(Math.min(0.9, 0.35 + hardness), "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
