/**
 * Controller drill road closures in the Live 3D diorama (the 3D twin of roadClosureLayer.ts):
 * each closed road is a thick dark line on a white casing draped on the ground, with striped
 * barricades and dark "X" badges along it and a "CLOSED (drill) · <name>" label, so it never
 * reads by colour alone; the road picked but not yet closed is a dashed selection-blue line with
 * its name. A `BoardOverlay` (fire/diorama/types.ts), composed with the board's own overlay.
 */

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BoardFrame } from "../fire/diorama/board";
import type { LabelLayer } from "../fire/diorama/labels";
import type { BoardOverlay, OverlayView } from "../fire/diorama/types";
import { lonLatToMercator } from "../fire/landscape";
import type { RoadClosure } from "../demo/roadClosures";
import { MAP_COLOR } from "./CommandMap";
import { markPoints } from "./roadClosureLayer";
import type { LonLat } from "./types";

/** Height over the ground, world units: above the street ribbons and the board's routes. */
const LIFT = 1.3;
/** Resampling step of a draped line, world units (as DemoBoardOverlay). */
const DRAPE_STEP = 1.5;
/** Barricade plank, world units (drawn larger than life so it reads; scaled up when zoomed out). */
const PLANK = { length: 3.2, height: 0.9, depth: 0.35, post: 0.9 } as const;
/** A barricade is drawn at least this long on screen, CSS px, and at most PLANK_SCALE_MAX times its size. */
const PLANK_MIN_PX = 16;
const PLANK_SCALE_MAX = 6;
const MAX_BARRICADES = 400;

const LABEL_CSS = `
.fdx-rc { font-size: 10.5px; padding: 2px 8px; font-weight: 800; letter-spacing: 0.02em; color: #fff; background: rgba(20, 24, 30, 0.92); border-color: #fff; }
.fdx-rc-x { font-size: 10px; padding: 0; width: 16px; height: 16px; justify-content: center; border-radius: 3px; font-weight: 800; color: #fff; background: rgba(20, 24, 30, 0.92); border: 1.5px solid #fff; }
.fdx-rc-pick { font-size: 10.5px; padding: 2px 8px; font-weight: 700; color: #0b3d75; border: 1.5px dashed #3d9bff; }
.fdx-compact .fdx-rc, .fdx-compact .fdx-rc-pick { font-size: 9.5px; padding: 1px 6px; }
.fdx-compact .fdx-rc-x { display: none; }
`;

type World = { x: number; y: number; z: number };
type Label = { obj: CSS2DObject; el: HTMLDivElement };

/** Diagonal ink / white stripes for the barricade planks (shape, not colour alone). */
function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = MAP_COLOR.casing;
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = MAP_COLOR.ink;
  for (let x = -16; x < 80; x += 16) {
    g.beginPath();
    g.moveTo(x, 16);
    g.lineTo(x + 8, 0);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 8, 16);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RoadClosureOverlay implements BoardOverlay {
  private frame: BoardFrame | null = null;
  private labels: LabelLayer | null = null;
  private group: THREE.Group | null = null;
  private style: HTMLStyleElement | null = null;
  private closures: readonly RoadClosure[] = [];
  private pick: { line: LonLat[]; name: string } | null = null;
  private readonly materials = new Set<LineMaterial>();
  private content: { group: THREE.Group; labels: Label[] } | null = null;
  private barricades: { mesh: THREE.InstancedMesh; spots: { x: number; y: number; z: number; angle: number }[]; scale: number } | null = null;
  private key = "";
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  attach(frame: BoardFrame, parent: THREE.Group, labels: LabelLayer): void {
    this.detach();
    if (!frame.grid) return;
    this.frame = frame;
    this.labels = labels;
    this.group = new THREE.Group();
    this.group.name = "live-road-closures";
    parent.add(this.group);
    this.style = document.createElement("style");
    this.style.textContent = LABEL_CSS;
    labels.renderer.domElement.appendChild(this.style);
    this.key = "";
    this.rebuild();
  }

  detach(): void {
    if (!this.group) return;
    this.clear();
    this.group.removeFromParent();
    this.group = null;
    this.style?.remove();
    this.style = null;
    this.frame = null;
    this.labels = null;
  }

  tick(_time: number, _dt: number, _reducedMotion: boolean, width: number, height: number, view?: OverlayView): void {
    for (const material of this.materials) material.resolution.set(width, height);
    const b = this.barricades;
    if (!b || !view) return;
    // World units per CSS px at the orbit target (as DemoBoardOverlay's crews).
    const wpp = (2 * view.distance * Math.tan(THREE.MathUtils.degToRad(view.camera.fov / 2))) / Math.max(1, height);
    const scale = THREE.MathUtils.clamp((PLANK_MIN_PX * wpp) / PLANK.length, 1, PLANK_SCALE_MAX);
    if (Math.abs(scale - b.scale) / b.scale < 0.05) return;
    b.scale = scale;
    this.placeBarricades();
  }

  /** The closed roads and the picked (not yet closed) road; cheap to call with the same values. */
  update(closures: readonly RoadClosure[], pick: { line: LonLat[]; name: string } | null): void {
    this.closures = closures;
    this.pick = pick;
    this.rebuild();
  }

  // ---- build ----

  private rebuild(): void {
    if (!this.group) return;
    const key = JSON.stringify([this.closures.map((c) => [c.segmentId, c.name, c.line.length]), this.pick ? [this.pick.name, this.pick.line] : null]);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const labels = this.labels!;
    const group = new THREE.Group();
    this.group.add(group);
    const made: Label[] = [];
    const spots: { x: number; y: number; z: number; angle: number }[] = [];
    for (const c of this.closures) {
      const positions = this.drape(c.line, LIFT);
      if (positions.length < 6) continue;
      group.add(this.line(positions, MAP_COLOR.casing, 11, false, 4));
      group.add(this.line(positions, MAP_COLOR.ink, 7, false, 5));
      const pts = markPoints(c.line);
      for (const p of pts) {
        const w = this.toWorld(p);
        if (!w) continue;
        const angle = this.crossAngle(c.line, p);
        if (spots.length < MAX_BARRICADES) spots.push({ ...w, angle });
        const x = labels.add(group, "fdx-rc-x", new THREE.Vector3(w.x, w.y + LIFT + 0.4, w.z), new THREE.Vector2(0.5, 0.5));
        x.el.textContent = "X";
        made.push(x);
      }
      const mid = this.toWorld(pts[Math.floor(pts.length / 2)] ?? c.line[0]);
      if (mid) {
        const label = labels.add(group, "fdx-rc", new THREE.Vector3(mid.x, mid.y + LIFT + 3, mid.z), new THREE.Vector2(0.5, 1));
        label.el.textContent = `CLOSED (drill) · ${c.name}`;
        made.push(label);
      }
    }
    if (this.pick) {
      const positions = this.drape(this.pick.line, LIFT + 0.2);
      if (positions.length >= 6) {
        group.add(this.line(positions, MAP_COLOR.casing, 9, false, 6));
        group.add(this.line(positions, MAP_COLOR.selection, 5, true, 7));
        const pts = markPoints(this.pick.line);
        const mid = this.toWorld(pts[Math.floor(pts.length / 2)] ?? this.pick.line[0]);
        if (mid) {
          const label = labels.add(group, "fdx-rc-pick", new THREE.Vector3(mid.x, mid.y + LIFT + 3, mid.z), new THREE.Vector2(0.5, 1));
          label.el.textContent = `Selected: ${this.pick.name}`;
          made.push(label);
        }
      }
    }
    this.content = { group, labels: made };
    if (spots.length) {
      const geometry = this.barricadeGeometry();
      const material = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.7 });
      const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
      mesh.castShadow = true;
      mesh.renderOrder = 5;
      group.add(mesh);
      this.barricades = { mesh, spots, scale: 1 };
      this.placeBarricades();
    }
    labels.invalidate();
  }

  private clear(): void {
    const c = this.content;
    if (!c) return;
    for (const label of c.labels) this.labels?.remove(label.obj);
    c.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      for (const m of material ? (Array.isArray(material) ? material : [material]) : []) {
        if (m instanceof LineMaterial) this.materials.delete(m);
        const map = (m as THREE.MeshStandardMaterial).map;
        map?.dispose();
        m.dispose();
      }
    });
    c.group.removeFromParent();
    this.content = null;
    this.barricades = null;
  }

  /** A plank on two posts, centred on the origin, long along x, standing on y = 0. */
  private barricadeGeometry(): THREE.BufferGeometry {
    const plank = new THREE.BoxGeometry(PLANK.length, PLANK.height, PLANK.depth);
    plank.translate(0, PLANK.post + PLANK.height / 2, 0);
    const parts = [plank];
    for (const x of [-PLANK.length * 0.38, PLANK.length * 0.38]) {
      const post = new THREE.BoxGeometry(0.22, PLANK.post + PLANK.height, 0.22);
      post.translate(x, (PLANK.post + PLANK.height) / 2, 0);
      parts.push(post);
    }
    const merged = mergeGeometries(parts) ?? plank.clone();
    for (const p of parts) p.dispose();
    return merged;
  }

  private placeBarricades(): void {
    const b = this.barricades;
    if (!b) return;
    const s = new THREE.Vector3(b.scale, b.scale, b.scale);
    b.spots.forEach((spot, i) => {
      this.quat.setFromAxisAngle(this.up, spot.angle);
      this.matrix.compose(new THREE.Vector3(spot.x, spot.y + 0.1, spot.z), this.quat, s);
      b.mesh.setMatrixAt(i, this.matrix);
    });
    b.mesh.instanceMatrix.needsUpdate = true;
    b.mesh.computeBoundingSphere();
  }

  // ---- geometry helpers ----

  private toWorld(point: LonLat | undefined): World | null {
    const frame = this.frame;
    if (!frame || !point) return null;
    const [mx, my] = lonLatToMercator(point[0], point[1]);
    const p = frame.fromMercator(mx, my);
    if (!p || !frame.inside(p.x, p.z)) return null;
    return { x: p.x, y: frame.surfaceAt(p.x, p.z), z: p.z };
  }

  /** Rotation about +y that lays a plank (long along x) across the road at `at`. */
  private crossAngle(line: LonLat[], at: LonLat): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i + 1 < line.length; i += 1) {
      const mx = (line[i][0] + line[i + 1][0]) / 2 - at[0];
      const my = (line[i][1] + line[i + 1][1]) / 2 - at[1];
      const d = mx * mx + my * my;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const a = this.toWorld(line[best]);
    const b = this.toWorld(line[best + 1] ?? line[best]);
    if (!a || !b) return 0;
    // The plank's long axis (x) perpendicular to the road direction (dx, dz) on the ground.
    return -Math.atan2(b.z - a.z, b.x - a.x) + Math.PI / 2;
  }

  /** The polyline on the ground, resampled every DRAPE_STEP; parts off the board are dropped. */
  private drape(path: readonly LonLat[], lift: number): number[] {
    const frame = this.frame!;
    const out: number[] = [];
    let previous: World | null = null;
    for (const point of path) {
      const p = this.toWorld(point);
      if (!p) {
        previous = null;
        continue;
      }
      if (previous) {
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - previous.x, p.z - previous.z) / DRAPE_STEP));
        for (let s = 1; s <= steps; s += 1) {
          const x = previous.x + ((p.x - previous.x) * s) / steps;
          const z = previous.z + ((p.z - previous.z) * s) / steps;
          out.push(x, frame.surfaceAt(x, z) + lift, z);
        }
      } else out.push(p.x, p.y + lift, p.z);
      previous = p;
    }
    return out;
  }

  private line(positions: number[], color: string, width: number, dashed: boolean, order: number): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width,
      worldUnits: false,
      dashed,
      dashSize: 1.6,
      gapSize: 1.1,
      transparent: true,
      opacity: 0.97,
    });
    this.materials.add(material);
    const line = new Line2(geometry, material);
    if (dashed) line.computeLineDistances();
    line.renderOrder = order;
    return line;
  }
}
