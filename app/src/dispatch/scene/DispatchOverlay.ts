/**
 * The dispatch simulation drawn on the fire diorama board (a `BoardOverlay`): every synthetic
 * home as a small house whose roof shows its household's state, active evacuation routes
 * draped on the terrain with a moving flow, vehicle groups on the road, exits, fire stations
 * and engines. It only draws engine state; it never changes the simulation. Positions are the
 * engine's; groups and engines glide between simulated minutes for readability only.
 */

import * as THREE from "three";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BoardFrame } from "../../fire/diorama/board";
import type { LabelLayer } from "../../fire/diorama/labels";
import type { BoardOverlay } from "../../fire/diorama/types";
import { lonLatToMercator } from "../../fire/landscape";
import type { DispatchArea, LonLat } from "../area";
import { HomeStatus, type DispatchEngine, type UnitState } from "../engine";
import type { FireExposure } from "../fireExposure";
import { routeCoords } from "../routing";

/** Drawn house footprint (ground metres), kept within a readable world-unit range. */
const HOUSE_METERS = 18;
const HOUSE_UNITS = { min: 0.55, max: 1.6 } as const;
/** Drawn vehicle and engine size, world units (exaggerated so they read on a 600-unit board). */
const CAR_UNITS = { length: 0.95, width: 0.5, height: 0.4 } as const;
const ENGINE_UNITS = { length: 2.4, width: 1.05, height: 1.0 } as const;
/** One drawn car per this many modelled vehicles in a group, at most CARS_PER_GROUP. */
const VEHICLES_PER_CAR = 6;
const CARS_PER_GROUP = 4;
const MAX_CARS = 5000;
/** Route lines: draped this far above the ground, subdivided to at most this length. */
const LINE_LIFT = 0.45;
const DRAPE_STEP_UNITS = 1.5;
const ROUTE_WIDTH_PX = 4;
const ROUTE_SELECTED_WIDTH_PX = 7;
const CLOSURE_WIDTH_PX = 6;
/** Closed roads: drawn above routes, in a colour no household state or exit uses. */
const CLOSURE_COLOR = 0x1a1a1a;
const FLOW_SPEED_UNITS_PER_S = 9;
/** Glide rate toward the latest simulated position (1/s). */
const GLIDE_RATE = 7;

/** Roof colour per household state (index = HomeStatus). */
export const HOME_COLORS: readonly number[] = [
  0xa7aca6, // idle: no order yet
  0xf2a33a, // ordered, getting ready at home
  0xf5d04a, // queued at the loading point
  0x2f8fd8, // driving out
  0x2e9f62, // safe: reached an exit
  0xd8432f, // caught by the modelled fire
];
/** Preview only: the fire reaches the home (no dispatch running). */
const FIRE_REACHED_COLOR = 0x4a3c36;
const WALL_COLOR = 0xe7e1d3;
const WALL_SELECTED_COLOR = 0xfffaf0;

/** Route colours per exit; no green, red or amber, which mean household states. */
export const EXIT_COLORS: readonly number[] = [
  0x2f6fde, 0x7b4fd6, 0x139aa8, 0xc2408f, 0x3f51b5, 0x8d5a2b, 0x55606e, 0x0f7c8c,
];

export function exitColor(area: DispatchArea, exitId: string): number {
  const index = area.exits.findIndex((exit) => exit.id === exitId);
  return EXIT_COLORS[(index < 0 ? 0 : index) % EXIT_COLORS.length];
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

const LABEL_CSS = `
.fdx-dsp-zone { font-size: 11px; padding: 3px 9px; gap: 5px; }
.fdx-dsp-zone b { font-weight: 750; }
.fdx-dsp-zone--ordered { background: rgba(255, 246, 228, 0.95); border-color: rgba(242, 163, 58, 0.55); color: #6b4300; }
.fdx-dsp-zone--cleared { background: rgba(232, 247, 238, 0.95); border-color: rgba(46, 159, 98, 0.55); color: #1d5e3c; }
.fdx-dsp-zone--staged { background: rgba(232, 240, 252, 0.95); border-color: rgba(47, 111, 222, 0.5); color: #1d3f7a; }
.fdx-dsp-zone--overrun { background: rgba(253, 236, 233, 0.95); border-color: rgba(216, 67, 47, 0.55); color: #8f2414; }
.fdx-dsp-zone--selected { outline: 2px solid #142b27; outline-offset: 1px; }
.fdx-dsp-swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
.fdx-dsp-unit { font-size: 10.5px; padding: 2px 7px; background: #b3362b; color: #fff; border-color: #7f2018; }
.fdx-dsp-exit { font-size: 10.5px; padding: 2px 7px; gap: 4px; background: rgba(20, 43, 39, 0.88); color: #fff; border-color: rgba(0,0,0,0.2); }
.fdx-dsp-closed { font-size: 10.5px; padding: 2px 7px; background: #1a1a1a; color: #fff; border-color: #000; font-weight: 700; }
.fdx-compact .fdx-dsp-zone { font-size: 9.5px; padding: 2px 6px; }
`;

type Glide = { x: number; z: number; tx: number; tz: number; heading: number };
type CarGlide = Glide & { zone: number; vehicles: number; stuck: boolean };

type RouteLine = { key: string; base: Line2; flow: Line2; color: number };

export class DispatchOverlay implements BoardOverlay {
  private frame: BoardFrame | null = null;
  private labels: LabelLayer | null = null;
  private group: THREE.Group | null = null;
  private style: HTMLStyleElement | null = null;
  private area: DispatchArea | null = null;
  private exposure: FireExposure | null = null;
  private engine: DispatchEngine | null = null;
  private previewMinute = -1;
  private selectedZone: number | null = null;
  private closedEdges: ReadonlySet<number> = new Set();
  private closures: { line: Line2; label: CSS2DObject }[] = [];

  // Static (per area): homes, exits, stations.
  private walls: THREE.InstancedMesh | null = null;
  private roofs: THREE.InstancedMesh | null = null;
  /** Instance index per home, or −1 when the home is off the board. */
  private homeInstance = new Int32Array(0);
  private homeOfInstance = new Int32Array(0);
  private exitMarkers: { group: THREE.Group; label: CSS2DObject; el: HTMLDivElement }[] = [];

  // Dynamic.
  private cars: THREE.InstancedMesh | null = null;
  private carGlide = new Map<number, CarGlide>();
  private trucks: THREE.InstancedMesh | null = null;
  private unitGlide = new Map<string, Glide>();
  private unitLabels = new Map<string, { obj: CSS2DObject; el: HTMLDivElement }>();
  private unitPaths = new Map<string, Line2>();
  private routes = new Map<number, RouteLine>();
  private zoneLabels = new Map<number, { obj: CSS2DObject; el: HTMLDivElement; key: string }>();
  private readonly lineMaterials = new Set<LineMaterial>();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  // ------------------------------------------------------------------ BoardOverlay

  attach(frame: BoardFrame, parent: THREE.Group, labels: LabelLayer): void {
    this.detach();
    if (!frame.grid) return;
    this.frame = frame;
    this.labels = labels;
    this.group = new THREE.Group();
    this.group.name = "dispatch-overlay";
    parent.add(this.group);
    this.style = document.createElement("style");
    this.style.textContent = LABEL_CSS;
    labels.renderer.domElement.appendChild(this.style);
    this.buildStatic();
    this.buildClosures();
    this.refresh();
  }

  detach(): void {
    if (!this.group) return;
    for (const label of [...this.zoneLabels.values(), ...this.unitLabels.values()])
      this.labels?.remove(label.obj);
    for (const marker of this.exitMarkers) this.labels?.remove(marker.label);
    for (const closure of this.closures) this.labels?.remove(closure.label);
    this.closures = [];
    this.zoneLabels.clear();
    this.unitLabels.clear();
    this.exitMarkers = [];
    this.routes.clear();
    this.unitPaths.clear();
    this.carGlide.clear();
    this.unitGlide.clear();
    this.lineMaterials.clear();
    this.group.removeFromParent();
    disposeTree(this.group);
    this.group = null;
    this.walls = null;
    this.roofs = null;
    this.cars = null;
    this.trucks = null;
    this.style?.remove();
    this.style = null;
    this.frame = null;
    this.labels = null;
  }

  tick(_time: number, dt: number, reducedMotion: boolean, width: number, height: number): void {
    if (!this.frame) return;
    for (const material of this.lineMaterials) {
      material.resolution.set(width, height);
      if (material.dashed && !reducedMotion) material.dashOffset -= dt * FLOW_SPEED_UNITS_PER_S;
    }
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * GLIDE_RATE);
    this.drawCars(k);
    this.drawTrucks(k);
  }

  // ------------------------------------------------------------------ page API

  setArea(area: DispatchArea | null, exposure: FireExposure | null): void {
    if (area === this.area && exposure === this.exposure) return;
    const areaChanged = area !== this.area;
    this.area = area;
    this.exposure = exposure;
    if (areaChanged) {
      this.engine = null;
      if (this.frame && this.group && this.labels) {
        const { frame, labels } = this;
        const parent = this.group.parent as THREE.Group;
        this.detach();
        this.attach(frame, parent, labels);
        return;
      }
    }
    this.refresh();
  }

  /** Call after every engine step (or with null to show the area without a session). */
  setEngine(engine: DispatchEngine | null): void {
    this.engine = engine;
    this.refresh();
  }

  /** Preview clock (no session): homes the fire has reached turn dark. */
  setPreviewMinute(minute: number): void {
    const whole = Math.floor(minute);
    if (whole === this.previewMinute) return;
    this.previewMinute = whole;
    if (!this.engine) this.paintHomes();
  }

  /** Edges closed to traffic, drawn as dark bars labelled "Closed" or "Bridge out". */
  setClosedEdges(edges: ReadonlySet<number>): void {
    if (edges === this.closedEdges) return;
    this.closedEdges = edges;
    this.buildClosures();
  }

  setSelectedZone(zone: number | null): void {
    if (zone === this.selectedZone) return;
    this.selectedZone = zone;
    this.refresh();
  }

  // ------------------------------------------------------------------ geometry helpers

  private toWorld(point: LonLat): { x: number; z: number } | null {
    const frame = this.frame;
    if (!frame) return null;
    const [mx, my] = lonLatToMercator(point[0], point[1]);
    const p = frame.fromMercator(mx, my);
    return p && frame.inside(p.x, p.z) ? p : null;
  }

  /** Flat xyz positions of a polyline draped on the board (off-board vertices dropped). */
  private drape(coords: readonly LonLat[], lift: number): number[] {
    const frame = this.frame!;
    const out: number[] = [];
    let previous: { x: number; z: number } | null = null;
    for (const coord of coords) {
      const p = this.toWorld(coord);
      if (!p) {
        previous = null;
        continue;
      }
      if (previous) {
        const steps = Math.max(
          1,
          Math.ceil(Math.hypot(p.x - previous.x, p.z - previous.z) / DRAPE_STEP_UNITS),
        );
        for (let s = 1; s <= steps; s += 1) {
          const x = previous.x + ((p.x - previous.x) * s) / steps;
          const z = previous.z + ((p.z - previous.z) * s) / steps;
          out.push(x, frame.surfaceAt(x, z) + lift, z);
        }
      } else out.push(p.x, frame.surfaceAt(p.x, p.z) + lift, p.z);
      previous = p;
    }
    return out;
  }

  private line(positions: number[], color: number, widthPx: number, dashed: boolean): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color,
      linewidth: widthPx,
      worldUnits: false,
      dashed,
      dashSize: 1.2,
      gapSize: 2.2,
      transparent: dashed,
      opacity: dashed ? 0.9 : 1,
    });
    this.lineMaterials.add(material);
    const line = new Line2(geometry, material);
    if (dashed) line.computeLineDistances();
    line.renderOrder = dashed ? 3 : 2;
    return line;
  }

  private disposeLine(line: Line2) {
    line.removeFromParent();
    line.geometry.dispose();
    this.lineMaterials.delete(line.material);
    line.material.dispose();
  }

  // ------------------------------------------------------------------ static content

  private buildStatic() {
    const { frame, group, area } = this;
    if (!frame || !group || !area) return;
    const size = THREE.MathUtils.clamp(
      HOUSE_METERS * frame.unitsPerMeter,
      HOUSE_UNITS.min,
      HOUSE_UNITS.max,
    );

    // Homes: walls (neutral) and hip roofs (household state).
    const placed: { home: number; x: number; z: number; y: number; yaw: number }[] = [];
    this.homeInstance = new Int32Array(area.homes.length).fill(-1);
    area.homes.forEach((home, i) => {
      const p = this.toWorld(home.position);
      if (!p) return;
      const yaw = (hash(home.position[0], home.position[1]) * 4) | 0;
      this.homeInstance[i] = placed.length;
      placed.push({
        home: i,
        x: p.x,
        z: p.z,
        y: frame.heightAt(p.x, p.z),
        yaw: (yaw * Math.PI) / 2 + 0.3,
      });
    });
    this.homeOfInstance = Int32Array.from(placed, (p) => p.home);
    if (placed.length > 0) {
      const wallGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const roofGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1)
        .rotateY(Math.PI / 4)
        .translate(0, 0.5, 0);
      const walls = new THREE.InstancedMesh(
        wallGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true }),
        placed.length,
      );
      const roofs = new THREE.InstancedMesh(
        roofGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, flatShading: true }),
        placed.length,
      );
      walls.name = "dispatch-home-walls";
      roofs.name = "dispatch-home-roofs";
      const wallH = size * 0.55;
      const roofH = size * 0.5;
      placed.forEach((p, i) => {
        this.tmpQuat.setFromAxisAngle(this.up, p.yaw);
        this.tmpScale.set(size, wallH + 0.2, size * 0.85);
        this.tmpPos.set(p.x, p.y - 0.2, p.z);
        walls.setMatrixAt(i, this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale));
        this.tmpScale.set(size * 1.12, roofH, size * 0.97);
        this.tmpPos.set(p.x, p.y + wallH, p.z);
        roofs.setMatrixAt(i, this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale));
        walls.setColorAt(i, this.tmpColor.set(WALL_COLOR));
        roofs.setColorAt(i, this.tmpColor.set(HOME_COLORS[0]));
      });
      walls.castShadow = roofs.castShadow = frame.blockMix < 0.6;
      walls.receiveShadow = roofs.receiveShadow = true;
      group.add(walls, roofs);
      this.walls = walls;
      this.roofs = roofs;
    }

    // Exits: a dark post with a green sign; labelled only while a route uses them.
    const exitMat = new THREE.MeshStandardMaterial({ color: 0x1f6b4f, roughness: 0.6 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.7 });
    for (const exit of area.exits) {
      const p = this.toWorld(area.nodes[exit.node]);
      if (!p || !this.labels) continue;
      const y = frame.surfaceAt(p.x, p.z);
      const marker = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 6), postMat);
      post.position.y = 1.5;
      const sign = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.15), exitMat);
      sign.position.y = 3;
      marker.add(post, sign);
      marker.position.set(p.x, y, p.z);
      group.add(marker);
      const label = this.labels.add(
        group,
        "fdx-dsp-exit",
        new THREE.Vector3(p.x, y + 4, p.z),
        new THREE.Vector2(0.5, 1),
      );
      label.el.textContent = `⇥ ${exit.id}`;
      label.obj.visible = false;
      this.exitMarkers.push({ group: marker, label: label.obj, el: label.el });
    }

    // Stations: a small red hall with a pale roof band at the station's graph node.
    const hallMat = new THREE.MeshStandardMaterial({ color: 0xb3362b, roughness: 0.6 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.6 });
    for (const station of area.stations) {
      const p = this.toWorld(area.nodes[station.node]);
      if (!p) continue;
      const y = frame.heightAt(p.x, p.z);
      const hall = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 2), hallMat);
      hall.position.set(p.x, y + 0.6, p.z);
      const band = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.25, 2.1), bandMat);
      band.position.set(p.x, y + 1.4, p.z);
      hall.castShadow = band.castShadow = true;
      group.add(hall, band);
    }

    // Vehicles and engines (instanced, filled each frame).
    const carGeo = new THREE.BoxGeometry(
      CAR_UNITS.length,
      CAR_UNITS.height,
      CAR_UNITS.width,
    ).translate(0, CAR_UNITS.height / 2, 0);
    this.cars = new THREE.InstancedMesh(
      carGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
      MAX_CARS,
    );
    this.cars.count = 0;
    this.cars.name = "dispatch-cars";
    const truckGeo = new THREE.BoxGeometry(
      ENGINE_UNITS.length,
      ENGINE_UNITS.height,
      ENGINE_UNITS.width,
    ).translate(0, ENGINE_UNITS.height / 2, 0);
    const units = area.stations.reduce((sum, station) => sum + station.units.length, 0);
    this.trucks = new THREE.InstancedMesh(
      truckGeo,
      new THREE.MeshStandardMaterial({ color: 0xc8352a, roughness: 0.45, emissive: 0x3a0804 }),
      Math.max(1, units),
    );
    this.trucks.count = 0;
    this.trucks.name = "dispatch-engines";
    this.cars.castShadow = this.trucks.castShadow = true;
    group.add(this.cars, this.trucks);
  }

  private buildClosures() {
    for (const closure of this.closures) {
      this.disposeLine(closure.line);
      this.labels?.remove(closure.label);
    }
    this.closures = [];
    const { group, area, labels, frame } = this;
    if (!group || !area || !labels || !frame) return;
    for (const index of this.closedEdges) {
      const edge = area.edges[index];
      if (!edge) continue;
      const positions = this.drape(edge.coords, LINE_LIFT + 0.15);
      if (positions.length < 6) continue;
      const line = this.line(positions, CLOSURE_COLOR, CLOSURE_WIDTH_PX, false);
      line.renderOrder = 4;
      group.add(line);
      const mid = Math.floor(positions.length / 6) * 3;
      const label = labels.add(
        group,
        "fdx-dsp-closed",
        new THREE.Vector3(positions[mid], positions[mid + 1] + 2.5, positions[mid + 2]),
        new THREE.Vector2(0.5, 1),
      );
      label.el.textContent = edge.bridge ? "✕ Bridge out" : "✕ Closed";
      this.closures.push({ line, label: label.obj });
    }
  }

  // ------------------------------------------------------------------ dynamic content

  private refresh() {
    if (!this.frame || !this.group || !this.area) return;
    this.paintHomes();
    this.updateRoutes();
    this.updateZoneLabels();
    this.updateExits();
    this.updateVehicles();
    this.updateUnits();
  }

  private paintHomes() {
    const { walls, roofs, area } = this;
    if (!walls || !roofs || !area) return;
    const engine = this.engine;
    const arrival = this.exposure?.homeArrival;
    const minute = this.previewMinute;
    const selected = this.selectedZone;
    const roofColors = roofs.instanceColor!.array as Float32Array;
    const wallColors = walls.instanceColor!.array as Float32Array;
    const palette = HOME_COLORS.map((hex) => new THREE.Color(hex));
    const reached = new THREE.Color(FIRE_REACHED_COLOR);
    const wall = new THREE.Color(WALL_COLOR);
    const wallSelected = new THREE.Color(WALL_SELECTED_COLOR);
    for (let i = 0; i < this.homeOfInstance.length; i += 1) {
      const home = this.homeOfInstance[i];
      let color: THREE.Color;
      if (engine) color = palette[engine.homeStatus[home]];
      else if (arrival && minute >= 0 && arrival[home] <= minute) color = reached;
      else color = palette[HomeStatus.idle];
      roofColors[i * 3] = color.r;
      roofColors[i * 3 + 1] = color.g;
      roofColors[i * 3 + 2] = color.b;
      const w = selected !== null && area.homes[home].zone === selected ? wallSelected : wall;
      wallColors[i * 3] = w.r;
      wallColors[i * 3 + 1] = w.g;
      wallColors[i * 3 + 2] = w.b;
    }
    roofs.instanceColor!.needsUpdate = true;
    walls.instanceColor!.needsUpdate = true;
  }

  private updateRoutes() {
    const { group, area } = this;
    if (!group || !area) return;
    const active = this.engine?.activeRoutes() ?? [];
    const seen = new Set<number>();
    for (const { zone, exitId, route } of active) {
      seen.add(zone);
      const selected = zone === this.selectedZone;
      const first = route.steps[0]?.edge ?? -1;
      const last = route.steps[route.steps.length - 1]?.edge ?? -1;
      const key = `${exitId}:${route.steps.length}:${first}:${last}:${selected ? 1 : 0}`;
      const existing = this.routes.get(zone);
      if (existing?.key === key) continue;
      if (existing) {
        this.disposeLine(existing.base);
        this.disposeLine(existing.flow);
      }
      const positions = this.drape(routeCoords(area, route.steps), LINE_LIFT);
      if (positions.length < 6) {
        this.routes.delete(zone);
        continue;
      }
      const color = exitColor(area, exitId);
      const base = this.line(
        positions,
        color,
        selected ? ROUTE_SELECTED_WIDTH_PX : ROUTE_WIDTH_PX,
        false,
      );
      const flow = this.line(
        positions.map((v, i) => (i % 3 === 1 ? v + 0.05 : v)),
        0xffffff,
        selected ? 3 : 2,
        true,
      );
      group.add(base, flow);
      this.routes.set(zone, { key, base, flow, color });
    }
    for (const [zone, line] of this.routes) {
      if (seen.has(zone)) continue;
      this.disposeLine(line.base);
      this.disposeLine(line.flow);
      this.routes.delete(zone);
    }
  }

  private updateZoneLabels() {
    const { group, area, labels, frame } = this;
    if (!group || !area || !labels || !frame) return;
    const engine = this.engine;
    const wanted = new Map<number, { cls: string; html: string }>();
    area.zones.forEach((zone, index) => {
      const state = engine?.zones[index];
      const selected = index === this.selectedZone;
      const sel = selected ? " fdx-dsp-zone--selected" : "";
      if (state?.status === "cleared") {
        wanted.set(index, {
          cls: `fdx-dsp-zone fdx-dsp-zone--cleared${sel}`,
          html: `✓ <b>${zone.id}</b> clear · ${state.safe}/${zone.homes}`,
        });
      } else if (state?.status === "overrun") {
        wanted.set(index, {
          cls: `fdx-dsp-zone fdx-dsp-zone--overrun${sel}`,
          html: `✕ <b>${zone.id}</b> fire · ${state.safe}/${zone.homes} out`,
        });
      } else if (state?.status === "ordered") {
        const swatch = state.exitId
          ? `<span class="fdx-dsp-swatch" style="background:${cssColor(exitColor(area, state.exitId))}"></span>`
          : "";
        wanted.set(index, {
          cls: `fdx-dsp-zone fdx-dsp-zone--ordered${sel}`,
          html: `#${state.orderRank} <b>${zone.id}</b> ${swatch}→ ${state.exitId}${state.routeBlocked ? " ⚠" : ""} · ${state.safe}/${zone.homes}`,
        });
      } else if (state?.stage && engine) {
        wanted.set(index, {
          cls: `fdx-dsp-zone fdx-dsp-zone--staged${sel}`,
          html: `⏳ wave ${engine.waveOf(index) ?? "?"} <b>${zone.id}</b> after ${area.zones[state.stage.after].id}`,
        });
      } else if (selected) {
        wanted.set(index, {
          cls: `fdx-dsp-zone${sel}`,
          html: `<b>${zone.id}</b> · no order · ${zone.homes} homes`,
        });
      }
    });
    for (const [index, label] of this.zoneLabels) {
      if (wanted.has(index)) continue;
      labels.remove(label.obj);
      this.zoneLabels.delete(index);
    }
    for (const [index, { cls, html }] of wanted) {
      const key = `${cls}|${html}`;
      let label = this.zoneLabels.get(index);
      if (!label) {
        const p = this.toWorld(area.zones[index].centroid);
        if (!p) continue;
        const made = labels.add(
          group,
          "",
          new THREE.Vector3(p.x, frame.surfaceAt(p.x, p.z) + 3, p.z),
          new THREE.Vector2(0.5, 1),
        );
        label = { ...made, key: "" };
        this.zoneLabels.set(index, label);
      }
      if (label.key !== key) {
        label.el.className = `fdx-label ${cls}`;
        label.el.innerHTML = html;
        label.key = key;
      }
    }
  }

  private updateExits() {
    const area = this.area;
    if (!area) return;
    const inUse = new Set((this.engine?.activeRoutes() ?? []).map((route) => route.exitId));
    area.exits.forEach((exit, i) => {
      const marker = this.exitMarkers[i];
      if (marker) marker.label.visible = inUse.has(exit.id);
    });
  }

  private updateVehicles() {
    const engine = this.engine;
    const seen = new Set<number>();
    for (const group of engine?.vehicleGroups() ?? []) {
      const p = this.toWorld(group.position);
      if (!p) continue;
      const a = this.toWorld(group.ahead);
      const heading =
        a && (a.x !== p.x || a.z !== p.z) ? Math.atan2(-(a.z - p.z), a.x - p.x) : undefined;
      const glide = this.carGlide.get(group.id);
      if (glide) {
        glide.tx = p.x;
        glide.tz = p.z;
        glide.vehicles = group.vehicles;
        glide.stuck = group.stuck;
        if (heading !== undefined) glide.heading = heading;
      } else {
        this.carGlide.set(group.id, {
          x: p.x,
          z: p.z,
          tx: p.x,
          tz: p.z,
          heading: heading ?? 0,
          zone: group.zone,
          vehicles: group.vehicles,
          stuck: group.stuck,
        });
      }
      seen.add(group.id);
    }
    for (const id of this.carGlide.keys()) if (!seen.has(id)) this.carGlide.delete(id);
  }

  private drawCars(k: number) {
    const { cars, frame, engine, area } = this;
    if (!cars || !frame || !area) return;
    if (!engine) {
      cars.count = 0;
      return;
    }
    const white = new THREE.Color(0xffffff);
    let n = 0;
    for (const glide of this.carGlide.values()) {
      glide.x += (glide.tx - glide.x) * k;
      glide.z += (glide.tz - glide.z) * k;
      const count = Math.min(
        CARS_PER_GROUP,
        Math.max(1, Math.round(glide.vehicles / VEHICLES_PER_CAR)),
      );
      const exitId = engine.zones[glide.zone].exitId;
      this.tmpColor
        .set(glide.stuck ? 0xf2a33a : exitId ? exitColor(area, exitId) : 0x2f8fd8)
        .lerp(white, 0.15);
      this.tmpQuat.setFromAxisAngle(this.up, glide.heading);
      const dx = Math.cos(glide.heading);
      const dz = -Math.sin(glide.heading);
      for (let c = 0; c < count && n < MAX_CARS; c += 1) {
        const back = c * CAR_UNITS.length * 1.35;
        const x = glide.x - dx * back;
        const z = glide.z - dz * back;
        this.tmpPos.set(x, frame.surfaceAt(x, z) + 0.05, z);
        this.tmpScale.set(1, 1, 1);
        cars.setMatrixAt(n, this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale));
        cars.setColorAt(n, this.tmpColor);
        n += 1;
      }
    }
    cars.count = n;
    cars.instanceMatrix.needsUpdate = true;
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
  }

  private updateUnits() {
    const { engine, area, group, labels, frame } = this;
    if (!area || !group || !labels || !frame) return;
    const units: UnitState[] = engine?.units ?? [];
    const seen = new Set<string>();
    for (const unit of units) {
      seen.add(unit.id);
      const p = this.toWorld(engine!.unitPosition(unit));
      if (!p) continue;
      const path = engine!.unitPath(unit);
      let heading: number | undefined;
      if (path.length > 1) {
        const a = this.toWorld(path[Math.min(2, path.length - 1)]);
        if (a && (a.x !== p.x || a.z !== p.z)) heading = Math.atan2(-(a.z - p.z), a.x - p.x);
      }
      const glide = this.unitGlide.get(unit.id);
      if (glide) {
        glide.tx = p.x;
        glide.tz = p.z;
        if (heading !== undefined) glide.heading = heading;
      } else
        this.unitGlide.set(unit.id, { x: p.x, z: p.z, tx: p.x, tz: p.z, heading: heading ?? 0 });

      // Remaining path while driving (dashed red), rebuilt only when it changes length.
      const existing = this.unitPaths.get(unit.id);
      const pathKey = path.length;
      if (existing && (existing.userData.key !== pathKey || path.length < 2)) {
        this.disposeLine(existing);
        this.unitPaths.delete(unit.id);
      }
      if (path.length >= 2 && !this.unitPaths.has(unit.id)) {
        const positions = this.drape(path, LINE_LIFT + 0.1);
        if (positions.length >= 6) {
          const line = this.line(positions, 0xc8352a, 3, true);
          line.userData.key = pathKey;
          group.add(line);
          this.unitPaths.set(unit.id, line);
        }
      }

      // A label while the engine is away from its station.
      let label = this.unitLabels.get(unit.id);
      const away = unit.status !== "available";
      if (away && !label) {
        label = labels.add(group, "fdx-dsp-unit", new THREE.Vector3(), new THREE.Vector2(0.5, 1.2));
        this.unitLabels.set(unit.id, label);
      }
      if (label) {
        label.obj.visible = away;
        const text = `${unit.id}${unit.status === "on_scene" ? " · on scene" : unit.status === "stranded" ? " · cut off" : ""}`;
        if (label.el.textContent !== text) label.el.textContent = text;
      }
    }
    for (const id of [...this.unitGlide.keys()]) {
      if (seen.has(id)) continue;
      this.unitGlide.delete(id);
      const label = this.unitLabels.get(id);
      if (label) labels.remove(label.obj);
      this.unitLabels.delete(id);
      const path = this.unitPaths.get(id);
      if (path) this.disposeLine(path);
      this.unitPaths.delete(id);
    }
  }

  private drawTrucks(k: number) {
    const { trucks, frame } = this;
    if (!trucks || !frame) return;
    let n = 0;
    for (const [id, glide] of this.unitGlide) {
      glide.x += (glide.tx - glide.x) * k;
      glide.z += (glide.tz - glide.z) * k;
      const y = frame.surfaceAt(glide.x, glide.z);
      this.tmpQuat.setFromAxisAngle(this.up, glide.heading);
      this.tmpPos.set(glide.x, y + 0.05, glide.z);
      this.tmpScale.set(1, 1, 1);
      trucks.setMatrixAt(n, this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale));
      n += 1;
      const label = this.unitLabels.get(id);
      if (label) label.obj.position.set(glide.x, y + ENGINE_UNITS.height + 0.6, glide.z);
    }
    trucks.count = n;
    trucks.instanceMatrix.needsUpdate = true;
  }
}

/** Deterministic 0..1 hash of a coordinate pair. */
function hash(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
