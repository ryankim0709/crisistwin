/**
 * Firefighters driving in on the studio's 3D board (a `BoardOverlay`): each resource leaves its
 * fire station when the run's dispatch says so (studio/crewDispatch.ts), follows its road route,
 * and parks around the fire's road point. Engines, hand-crew buggies and dozers have different
 * shapes and colours; a dashed line shows each route while someone is on it, and a label at the
 * fire counts resources on scene. Draws the dispatch plan only; it never changes the model.
 */

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { LonLat } from "../dispatch/area";
import type { BoardFrame } from "../fire/diorama/board";
import type { LabelLayer } from "../fire/diorama/labels";
import type { BoardOverlay } from "../fire/diorama/types";
import { lonLatToMercator } from "../fire/landscape";
import { tripPosition, type CrewDispatch } from "./crewDispatch";
import { CREW_COLORS } from "./firelinePalette";
import type { ResourceKind } from "./firefighting";

/** Vehicle sizes, world units (exaggerated about 20x so they read on a 600-unit board). */
const SIZES: Record<ResourceKind, { length: number; height: number; width: number }> = {
  engine: { length: 4.8, height: 2.0, width: 2.1 },
  hand_crew: { length: 3.8, height: 2.6, width: 1.9 },
  dozer: { length: 3.2, height: 1.5, width: 3.2 },
};
const KINDS: readonly ResourceKind[] = ["engine", "hand_crew", "dozer"];
const LIFT = 0.9;
const DRAPE_STEP = 1.5;
/** Parked vehicles ring the fire's road point at this radius, world units. */
const PARK_RADIUS = 6;

const LABEL_CSS = `
.fdx-crew { font-size: 11px; padding: 3px 9px; background: #8f2414; color: #fff; border-color: #5e170c; font-weight: 700; }
.fdx-compact .fdx-crew { font-size: 9.5px; padding: 2px 6px; }
`;

export class CrewOverlay implements BoardOverlay {
  private frame: BoardFrame | null = null;
  private labels: LabelLayer | null = null;
  private group: THREE.Group | null = null;
  private style: HTMLStyleElement | null = null;
  private dispatch: CrewDispatch | null = null;
  private meshes = new Map<ResourceKind, THREE.InstancedMesh>();
  /** Instance index of each trip within its kind's mesh. */
  private slot: number[] = [];
  private routes: { line: Line2; base: Line2; trips: number[] }[] = [];
  private label: { obj: CSS2DObject; el: HTMLDivElement } | null = null;
  private minute = 0;
  private readonly materials = new Set<LineMaterial>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  attach(frame: BoardFrame, parent: THREE.Group, labels: LabelLayer): void {
    this.detach();
    if (!frame.grid) return;
    this.frame = frame;
    this.labels = labels;
    this.group = new THREE.Group();
    this.group.name = "crew-overlay";
    parent.add(this.group);
    this.style = document.createElement("style");
    this.style.textContent = LABEL_CSS;
    labels.renderer.domElement.appendChild(this.style);
    this.build();
  }

  detach(): void {
    if (!this.group) return;
    if (this.label) this.labels?.remove(this.label.obj);
    this.label = null;
    this.group.removeFromParent();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.group = null;
    this.meshes.clear();
    this.routes = [];
    this.materials.clear();
    this.style?.remove();
    this.style = null;
    this.frame = null;
    this.labels = null;
  }

  tick(_time: number, _dt: number, _reducedMotion: boolean, width: number, height: number): void {
    for (const material of this.materials) material.resolution.set(width, height);
  }

  setDispatch(dispatch: CrewDispatch | null): void {
    if (dispatch === this.dispatch) return;
    this.dispatch = dispatch;
    this.build();
  }

  /** Playback minute (continuous); vehicles move smoothly with it. */
  setMinute(minute: number): void {
    this.minute = minute;
    this.place();
  }

  private toWorld(point: LonLat): { x: number; y: number; z: number } | null {
    const frame = this.frame;
    if (!frame) return null;
    const [mx, my] = lonLatToMercator(point[0], point[1]);
    const p = frame.fromMercator(mx, my);
    if (!p || !frame.inside(p.x, p.z)) return null;
    return { x: p.x, y: frame.surfaceAt(p.x, p.z), z: p.z };
  }

  private drape(path: readonly LonLat[]): number[] {
    const frame = this.frame!;
    const out: number[] = [];
    let previous: { x: number; z: number } | null = null;
    for (const point of path) {
      const p = this.toWorld(point);
      if (!p) {
        previous = null;
        continue;
      }
      if (previous) {
        const steps = Math.max(
          1,
          Math.ceil(Math.hypot(p.x - previous.x, p.z - previous.z) / DRAPE_STEP),
        );
        for (let s = 1; s <= steps; s += 1) {
          const x = previous.x + ((p.x - previous.x) * s) / steps;
          const z = previous.z + ((p.z - previous.z) * s) / steps;
          out.push(x, frame.surfaceAt(x, z) + LIFT, z);
        }
      } else out.push(p.x, p.y + LIFT, p.z);
      previous = p;
    }
    return out;
  }

  private build(): void {
    const { group, labels, dispatch } = this;
    if (!group || !labels) return;
    for (const child of [...group.children]) {
      child.removeFromParent();
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    }
    if (this.label) labels.remove(this.label.obj);
    this.label = null;
    this.meshes.clear();
    this.routes = [];
    this.materials.clear();
    if (!dispatch || dispatch.trips.length === 0) return;

    // Vehicles: one instanced mesh per kind.
    const counts = new Map<ResourceKind, number>();
    this.slot = dispatch.trips.map((trip) => {
      const index = counts.get(trip.kind) ?? 0;
      counts.set(trip.kind, index + 1);
      return index;
    });
    for (const kind of KINDS) {
      const count = counts.get(kind) ?? 0;
      if (count === 0) continue;
      const size = SIZES[kind];
      const geometry = new THREE.BoxGeometry(size.length, size.height, size.width).translate(
        0,
        size.height / 2,
        0,
      );
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: CREW_COLORS[kind], roughness: 0.5 }),
        count,
      );
      mesh.castShadow = true;
      mesh.name = `crew-${kind}`;
      group.add(mesh);
      this.meshes.set(kind, mesh);
    }

    // Routes: one dashed line per distinct path (trips from one station share it).
    const byPath = new Map<CrewDispatch["trips"][number]["path"], number[]>();
    dispatch.trips.forEach((trip, index) => {
      const list = byPath.get(trip.path) ?? [];
      list.push(index);
      byPath.set(trip.path, list);
    });
    for (const [path, trips] of byPath) {
      const positions = this.drape(path);
      if (positions.length < 6) continue;
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({
        color: 0xffffff,
        linewidth: 2,
        worldUnits: false,
        dashed: true,
        dashSize: 1.4,
        gapSize: 1.2,
        transparent: true,
        opacity: 0.9,
      });
      this.materials.add(material);
      const line = new Line2(geometry, material);
      line.computeLineDistances();
      line.renderOrder = 4;
      const baseMaterial = new LineMaterial({
        color: CREW_COLORS.route,
        linewidth: 5,
        worldUnits: false,
      });
      this.materials.add(baseMaterial);
      const base = new Line2(geometry, baseMaterial);
      base.renderOrder = 3;
      group.add(base, line);
      this.routes.push({ line, base, trips });
    }

    const road = this.toWorld(dispatch.roadPoint);
    if (road) {
      this.label = labels.add(
        group,
        "fdx-crew",
        new THREE.Vector3(road.x, road.y + 5, road.z),
        new THREE.Vector2(0.5, 1),
      );
    }
    this.place();
  }

  private place(): void {
    const { dispatch } = this;
    if (!dispatch || this.meshes.size === 0) return;
    const minute = this.minute;
    const road = this.toWorld(dispatch.roadPoint);
    let onScene = 0;
    dispatch.trips.forEach((trip, index) => {
      const mesh = this.meshes.get(trip.kind);
      if (!mesh) return;
      let at: { x: number; y: number; z: number } | null;
      let yaw = 0;
      if (minute >= trip.arriveMinute) onScene += 1;
      if (minute >= trip.atRoadMinute && road) {
        const angle = (index / dispatch.trips.length) * Math.PI * 2;
        const x = road.x + Math.cos(angle) * PARK_RADIUS;
        const z = road.z + Math.sin(angle) * PARK_RADIUS;
        at = { x, y: this.frame!.surfaceAt(x, z), z };
        yaw = -angle;
      } else {
        const position = tripPosition(trip, minute);
        at = this.toWorld(position.at);
        const ahead = this.toWorld(position.ahead);
        if (at && ahead) yaw = Math.atan2(-(ahead.z - at.z), ahead.x - at.x);
      }
      if (!at) {
        mesh.setMatrixAt(this.slot[index], this.matrix.makeScale(0, 0, 0));
        return;
      }
      this.quat.setFromAxisAngle(this.up, yaw);
      this.matrix.compose(
        new THREE.Vector3(at.x, at.y, at.z),
        this.quat,
        new THREE.Vector3(1, 1, 1),
      );
      mesh.setMatrixAt(this.slot[index], this.matrix);
    });
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
    for (const route of this.routes) {
      route.line.visible = route.base.visible = route.trips.some((index) => {
        const trip = dispatch.trips[index];
        return minute >= dispatch.reportMinute && minute < trip.atRoadMinute;
      });
    }
    if (this.label) {
      const total = dispatch.trips.length;
      const hiking = dispatch.trips.filter(
        (trip) => minute >= trip.atRoadMinute && minute < trip.arriveMinute,
      ).length;
      this.label.el.textContent =
        minute < dispatch.reportMinute
          ? "Not yet reported"
          : `🚒 ${onScene}/${total} at the fire${hiking > 0 ? ` · ${hiking} walking in` : ""}`;
    }
  }
}
