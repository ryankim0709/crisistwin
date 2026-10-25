/**
 * Low-poly glyph geometries for the /live command board's 3D view: ground apparatus, aircraft,
 * the helicopter rotor, drop curtain, ground shadow and a hiking firefighter. Pure geometry
 * builders with no scene state: each returns ONE merged BufferGeometry with a per-vertex `color`
 * attribute baked from the board palette (board3dPalette.ts), so a single InstancedMesh with
 * `MeshStandardMaterial({ vertexColors: true })` draws a whole glyph kind.
 *
 * Conventions: length along +x (nose or front at +x), up +y, origin at ground centre (y = 0 at the
 * wheels, tracks or belly), sizes in board world units. Vehicles and aircraft are exaggerated
 * (about 20x) so they read on a 600-unit board. Shapes are stylised silhouettes (an engine with a
 * cab and light bar, a tender with a tank, a dozer with a blade, an S-2T-like airtanker, an
 * OV-10-like lead plane), not CAD models of a particular unit.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { APPARATUS_COLORS as C, DEMO_3D_COLORS } from "./board3dPalette";

type Part = THREE.BufferGeometry;

/* ---------- part helpers (every part ends up non-indexed with position, normal, color) ---------- */

/** Bake a flat colour into a part and make it mergeable (non-indexed, no uv). */
function paint(geo: Part, color: number): Part {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  flat.deleteAttribute("uv");
  const count = flat.getAttribute("position").count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return flat;
}

/** Merge parts into one geometry and dispose the temporaries. */
function merge(parts: Part[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("apparatusGlyphs: geometry merge failed");
  return merged;
}

/** Axis-aligned box by extents. */
function box(color: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Part {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return paint(g, color);
}

interface CylOpts {
  open?: boolean;
  thetaStart?: number;
  thetaLength?: number;
  /** Cross-section squash (after the cylinder is laid along its axis). */
  sy?: number;
  sz?: number;
}

/** Cylinder or cone along x from x0 (radius r0) to x1 (radius r1), axis at (y, z). */
function cylX(color: number, x0: number, x1: number, y: number, z: number, r0: number, r1: number, seg: number, o: CylOpts = {}): Part {
  const g = new THREE.CylinderGeometry(r1, r0, x1 - x0, seg, 1, o.open ?? false, o.thetaStart ?? 0, o.thetaLength ?? Math.PI * 2);
  g.rotateZ(-Math.PI / 2);
  if (o.sy !== undefined || o.sz !== undefined) g.scale(1, o.sy ?? 1, o.sz ?? 1);
  g.translate((x0 + x1) / 2, y, z);
  return paint(g, color);
}

/** Cylinder with its axis along z (a wheel) from z0 to z1, centred at (x, y). */
function cylZ(color: number, z0: number, z1: number, x: number, y: number, r: number, seg: number): Part {
  const g = new THREE.CylinderGeometry(r, r, z1 - z0, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return paint(g, color);
}

/** Upright cylinder or cone from y0 (radius r0) to y1 (radius r1) at (x, z). */
function cylY(color: number, y0: number, y1: number, x: number, z: number, r0: number, r1: number, seg: number): Part {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg);
  g.translate(x, (y0 + y1) / 2, z);
  return paint(g, color);
}

function ellipsoid(color: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, ws: number, hs: number): Part {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(cx, cy, cz);
  return paint(g, color);
}

/** Wheels at each x, on both sides at z = ±zc, radius r, width w. */
function wheels(xs: number[], zc: number, w: number, r: number, seg: number): Part[] {
  const out: Part[] = [];
  for (const x of xs) {
    out.push(cylZ(C.steel, zc - w / 2, zc + w / 2, x, r, r, seg));
    out.push(cylZ(C.steel, -zc - w / 2, -zc + w / 2, x, r, r, seg));
  }
  return out;
}

/* ---------- ground apparatus ---------- */

export type GroundGlyph = "engine" | "tender" | "dozer" | "crew_carrier";

/** Glyph for a unit kind ("engine_t1", "tender_t2", "dozer_t1", "hand_crew_t2", ...). */
export function groundGlyphOf(kind: string): GroundGlyph {
  if (kind.startsWith("tender")) return "tender";
  if (kind.startsWith("dozer")) return "dozer";
  if (kind.startsWith("hand_crew")) return "crew_carrier";
  return "engine";
}

/** Type 1-6 engine, about 4.8 long: red body, white-roofed cab with a glass band, four wheels, light bar. */
function engineParts(): Part[] {
  return [
    box(C.steel, -2.4, 2.4, 0.4, 0.6, -0.85, 0.85),
    box(C.engine, -2.4, 0.7, 0.55, 1.75, -1.0, 1.0),
    box(C.white, -2.35, 0.7, 1.0, 1.12, -1.01, 1.01),
    box(C.steel, -2.1, 0.4, 1.75, 1.9, -0.7, 0.7),
    box(C.engine, 0.7, 2.4, 0.6, 2.0, -1.05, 1.05),
    box(C.white, 0.7, 2.4, 2.0, 2.12, -1.05, 1.05),
    box(C.glass, 1.95, 2.42, 1.25, 1.85, -0.9, 0.9),
    box(C.glass, 1.0, 1.9, 1.3, 1.85, -1.07, 1.07),
    box(C.aircraftRed, 1.3, 1.7, 2.12, 2.3, -0.7, 0.7),
    ...wheels([-1.5, 1.6], 0.95, 0.36, 0.45, 10),
  ];
}

/** Water tender, about 5.8 long: engine-style cab and a long horizontal tank in the darker tender red. */
function tenderParts(): Part[] {
  return [
    box(C.steel, -2.9, 2.9, 0.4, 0.7, -0.85, 0.85),
    box(C.engine, 1.4, 2.9, 0.6, 2.0, -1.05, 1.05),
    box(C.white, 1.4, 2.9, 2.0, 2.12, -1.05, 1.05),
    box(C.glass, 2.45, 2.92, 1.25, 1.85, -0.9, 0.9),
    box(C.glass, 1.5, 2.4, 1.3, 1.85, -1.07, 1.07),
    box(C.aircraftRed, 1.8, 2.2, 2.12, 2.3, -0.7, 0.7),
    cylX(C.tender, -2.8, 1.3, 1.55, 0, 0.92, 0.92, 12),
    cylX(C.white, -1.7, -1.5, 1.55, 0, 0.94, 0.94, 12, { open: true }),
    cylX(C.white, 0.1, 0.3, 1.55, 0, 0.94, 0.94, 12, { open: true }),
    ...wheels([1.9, -0.8, -2.0], 0.95, 0.36, 0.45, 8),
  ];
}

/** Bulldozer, about 3.2 long and 3.2 wide with the blade: yellow body, steel tracks, wide blade, cab cage. */
function dozerParts(): Part[] {
  const parts: Part[] = [
    box(C.steel, -1.5, 1.3, 0, 0.85, 1.0, 1.6),
    box(C.steel, -1.5, 1.3, 0, 0.85, -1.6, -1.0),
    box(C.dozer, -1.1, 1.0, 0.45, 1.0, -1.0, 1.0),
    box(C.dozer, 0.1, 1.25, 1.0, 1.4, -0.55, 0.55),
    cylY(C.steel, 1.4, 1.9, 0.95, 0.35, 0.09, 0.09, 6),
    box(C.steel, -1.0, 0.0, 1.75, 1.85, -0.75, 0.75),
    box(C.steel, 1.0, 1.5, 0.4, 0.8, -0.5, 0.5),
    box(C.steel, 1.45, 1.7, 0.15, 1.15, -1.6, 1.6),
  ];
  for (const x of [-0.95, -0.05]) {
    for (const z of [-0.65, 0.65]) parts.push(box(C.steel, x - 0.05, x + 0.05, 1.0, 1.75, z - 0.05, z + 0.05));
  }
  return parts;
}

/** Crew carrier ("buggy"), about 4.2 long: long green box, a row of dark windows each side, four wheels. */
function crewCarrierParts(): Part[] {
  const parts: Part[] = [
    box(C.hand_crew, -2.1, 2.1, 0.5, 1.2, -0.95, 0.95),
    box(C.hand_crew, -2.1, 1.0, 1.2, 2.0, -0.95, 0.95),
    box(C.white, -2.1, 1.0, 2.0, 2.1, -0.97, 0.97),
    box(C.glass, 1.0, 1.06, 1.3, 1.9, -0.8, 0.8),
    box(C.steel, 2.0, 2.15, 0.45, 0.8, -0.9, 0.9),
    ...wheels([-1.35, 1.35], 0.95, 0.36, 0.45, 10),
  ];
  for (const x of [-1.85, -1.1, -0.35, 0.4]) {
    parts.push(box(C.glass, x, x + 0.55, 1.45, 1.85, 0.93, 0.97));
    parts.push(box(C.glass, x, x + 0.55, 1.45, 1.85, -0.97, -0.93));
  }
  return parts;
}

export function groundGlyphGeometry(glyph: GroundGlyph): THREE.BufferGeometry {
  switch (glyph) {
    case "tender":
      return merge(tenderParts());
    case "dozer":
      return merge(dozerParts());
    case "crew_carrier":
      return merge(crewCarrierParts());
    default:
      return merge(engineParts());
  }
}

/* ---------- aircraft ---------- */

export type AirGlyph = "helicopter" | "airtanker" | "air_attack";

/** Glyph for an aircraft kind ("helicopter_*", "air_attack", "airtanker_*"). */
export function airGlyphOf(kind: string): AirGlyph {
  if (kind.startsWith("helicopter")) return "helicopter";
  if (kind.startsWith("air_attack")) return "air_attack";
  return "airtanker";
}

/** y of the mast top on the helicopter geometry: the caller puts the rotor here. */
export const ROTOR_MAST_HEIGHT = 2.9;

/** Helicopter, about 6 long, without its main rotor: red fuselage and glass nose, tail boom and fin, skids, mast stub. */
function helicopterParts(): Part[] {
  const parts: Part[] = [
    ellipsoid(C.aircraftRed, 0.4, 1.55, 0, 1.7, 0.95, 0.85, 8, 6),
    ellipsoid(C.glass, 1.3, 1.7, 0, 0.75, 0.55, 0.78, 8, 5),
    cylX(C.aircraftRed, -4.0, -0.9, 1.7, 0, 0.14, 0.42, 8),
    box(C.aircraftRed, -4.1, -3.55, 1.5, 2.8, -0.06, 0.06),
    box(C.white, -3.9, -3.5, 1.65, 1.72, -0.7, 0.7),
    cylZ(C.steel, 0.1, 0.16, -4.0, 2.4, 0.45, 8),
    cylY(C.steel, 2.4, ROTOR_MAST_HEIGHT, 0.4, 0, 0.14, 0.14, 6),
  ];
  for (const z of [-0.75, 0.75]) {
    parts.push(cylX(C.steel, -1.2, 1.9, 0.1, z, 0.07, 0.07, 6));
    for (const x of [-0.5, 1.0]) parts.push(box(C.steel, x - 0.05, x + 0.05, 0.1, 1.1, z - 0.04, z + 0.04));
  }
  return parts;
}

/** Twin-engine high-wing airtanker (S-2T-like), about 9 long and 11 span: red fuselage with a white top. */
function airtankerParts(): Part[] {
  const parts: Part[] = [
    cylX(C.aircraftRed, -2.2, 3.0, 0.85, 0, 0.8, 0.8, 10),
    cylX(C.aircraftRed, -4.8, -2.2, 0.85, 0, 0.3, 0.8, 10),
    cylX(C.aircraftRed, 3.0, 4.3, 0.85, 0, 0.8, 0.45, 10),
    cylX(C.white, -2.2, 3.0, 0.85, 0, 0.82, 0.82, 5, { open: true, thetaStart: Math.PI, thetaLength: Math.PI }),
    box(C.white, -0.5, 1.2, 1.55, 1.75, -4.9, 4.9),
    box(C.aircraftRed, -0.5, 1.2, 1.55, 1.75, 4.9, 5.5),
    box(C.aircraftRed, -0.5, 1.2, 1.55, 1.75, -5.5, -4.9),
    box(C.white, -4.7, -3.7, 1.0, 1.1, -2.0, 2.0),
    box(C.aircraftRed, -4.8, -3.8, 0.9, 2.6, -0.07, 0.07),
  ];
  for (const z of [-2.4, 2.4]) {
    parts.push(cylX(C.aircraftRed, -0.7, 1.6, 1.6, z, 0.38, 0.38, 8));
    parts.push(cylX(C.steel, 1.6, 2.0, 1.6, z, 0.3, 0, 8));
  }
  return parts;
}

/** Lead plane (OV-10-like), about 6 long and 7 span: white pod, twin booms, orange band and tail plane. */
function airAttackParts(): Part[] {
  const parts: Part[] = [
    ellipsoid(C.airAttack, 0.6, 0.6, 0, 1.9, 0.55, 0.5, 8, 5),
    ellipsoid(C.glass, 1.4, 0.95, 0, 0.7, 0.35, 0.4, 6, 4),
    cylX(C.airAttackBand, 0.0, 0.5, 0.6, 0, 0.57, 0.57, 10, { open: true, sz: 0.88 }),
    box(C.airAttack, 0.1, 1.3, 1.0, 1.14, -2.8, 2.8),
    box(C.airAttackBand, 0.1, 1.3, 1.0, 1.14, 2.8, 3.5),
    box(C.airAttackBand, 0.1, 1.3, 1.0, 1.14, -3.5, -2.8),
    box(C.airAttackBand, -3.6, -3.1, 1.9, 1.98, -1.9, 1.9),
  ];
  for (const z of [-1.5, 1.5]) {
    parts.push(cylX(C.airAttack, -0.2, 1.6, 0.95, z, 0.3, 0.3, 8));
    parts.push(cylX(C.steel, 1.6, 2.0, 0.95, z, 0.24, 0, 8));
    parts.push(cylX(C.airAttack, -3.6, -0.2, 0.95, z, 0.12, 0.2, 6));
    parts.push(box(C.airAttack, -3.7, -3.0, 0.8, 2.0, z - 0.06, z + 0.06));
  }
  return parts;
}

export function airGlyphGeometry(glyph: AirGlyph): THREE.BufferGeometry {
  switch (glyph) {
    case "helicopter":
      return merge(helicopterParts());
    case "air_attack":
      return merge(airAttackParts());
    default:
      return merge(airtankerParts());
  }
}

/**
 * Main rotor: a thin disc plus two crossed blades, centred on its own origin. The caller places it
 * at (mast x, ROTOR_MAST_HEIGHT) and spins it about y; give it a translucent material.
 */
export function rotorGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(3.6, 3.6, 0.06, 16), C.rotor),
    box(C.steel, -3.6, 3.6, 0.03, 0.08, -0.12, 0.12),
    box(C.steel, -0.12, 0.12, 0.03, 0.08, -3.6, 3.6),
    cylY(C.steel, -0.05, 0.12, 0, 0, 0.18, 0.18, 6),
  ]);
}

/** Open downward-widening curtain hanging below y = 0 (retardant or water drop); the caller colours it. */
export function dropCurtainGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.6, 3.0, 8, 12, 1, true);
  g.translate(0, -4, 0);
  return g;
}

/** Flat disc on the ground (normal +y), for the shadow under an aircraft at altitude. */
export function shadowGeometry(radius: number): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(radius, 16);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Hiking firefighter, about 1.9 tall facing +x: body in the crew colour, yellow helmet, a hand tool. */
export function walkerGeometry(): THREE.BufferGeometry {
  const tool = new THREE.BoxGeometry(0.06, 1.5, 0.06);
  tool.rotateZ(-0.35);
  tool.translate(0.1, 1.0, 0.42);
  const toolHead = new THREE.BoxGeometry(0.4, 0.1, 0.08);
  toolHead.rotateZ(-0.35);
  toolHead.translate(0.38, 1.72, 0.42);
  return merge([
    cylY(C.hand_crew, 0, 1.5, 0, 0, 0.26, 0.32, 8),
    ellipsoid(DEMO_3D_COLORS.crewHelmet, 0, 1.68, 0, 0.3, 0.24, 0.3, 8, 6),
    paint(tool, C.steel),
    paint(toolHead, C.steel),
  ]);
}
