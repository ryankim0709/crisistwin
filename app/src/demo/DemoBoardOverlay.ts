/**
 * The /demo command board's units, stations and zones on the 3D diorama (a `BoardOverlay`,
 * fire/diorama/types.ts): stations as small firehouses with their names, each unit as a vehicle
 * block in its family's colour (as the Studio's CrewOverlay draws them) at its current board
 * position, with a dashed line along an en-route unit's road (or straight) line, and the outline
 * of each ordered, threatened or overrun zone draped on the ground with its tag. Draws the
 * simulated board only; it never changes it.
 */

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { BoardFrame } from "../fire/diorama/board";
import type { LabelLayer } from "../fire/diorama/labels";
import type { BoardOverlay } from "../fire/diorama/types";
import { lonLatToMercator } from "../fire/landscape";
import { LEVEL_COLOR } from "../live/CommandMap";
import type { LonLat } from "../live/types";
import { vehicleFamily, type VehicleFamily } from "../studio/apparatus";
import { CREW_COLORS } from "../studio/firelinePalette";
import { shortStationName } from "./format";
import { EVACUEE_MARKERS_MAX, distanceM, evacueeMarkers, lineBuiltExtent, teamPosition, type Board, type ZoneForecast } from "./model";

/** Colours baked into the 3D board (CSS cannot reach WebGL); the legend mirrors them. */
export const DEMO_3D_COLORS = {
  stationWall: 0xefe4d6,
  stationRoof: CREW_COLORS.engine,
  route: 0x6b5bd2,
  ordered: LEVEL_COLOR.evacuate_now,
  threatened: LEVEL_COLOR.be_ready,
  overrun: "#b3140c",
  /** Fire line ahead of a fire (boardMapLayers BOARD_COLOR.fireLine). */
  fireLine: "#3b2a1a",
  /** Evacuating vehicles (simulated, sampled), on their zone's road route. */
  evacuee: 0x1f6feb,
} as const;

/** Vehicle sizes, world units (exaggerated about 20x so they read on a 600-unit board, as CrewOverlay). */
const SIZES: Record<VehicleFamily, { length: number; height: number; width: number }> = {
  engine: { length: 4.8, height: 2.0, width: 2.1 },
  hand_crew: { length: 3.8, height: 2.6, width: 1.9 },
  dozer: { length: 3.2, height: 1.5, width: 3.2 },
};
const FAMILIES: readonly VehicleFamily[] = ["engine", "hand_crew", "dozer"];
const LIFT = 0.9;
const ZONE_LIFT = 0.6;
const DRAPE_STEP = 1.5;
/** Units at one spot fan out on a ring of this radius, world units. */
const PARK_RADIUS = 7;
/** Units closer than this share a spot (and a label), world units. */
const CLUSTER_WORLD = 3;
/** An available unit this close to its station is shown as parked there, metres. */
const AT_STATION_M = 60;
const STATION_SIZE = { width: 4, height: 2.6, depth: 3 };

type ZoneState = "overrun" | "ordered" | "threatened";
const ZONE_TAG: Record<ZoneState, string> = { overrun: "Overrun", ordered: "Leave now", threatened: "At risk" };

const LABEL_CSS = `
.fdx-dmunit { font-size: 10.5px; padding: 2px 8px; background: rgba(36, 30, 64, 0.88); color: #fff; border-color: rgba(20, 16, 40, 0.6); font-weight: 700; }
.fdx-dmstation { font-size: 10px; padding: 2px 7px; font-weight: 600; color: #3a3f45; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.fdx-dmzone { font-size: 10px; padding: 2px 7px; font-weight: 700; letter-spacing: 0.02em; }
.fdx-dmzone-overrun { color: #fff; background: rgba(122, 10, 5, 0.9); }
.fdx-dmzone-ordered { color: #7a0a05; }
.fdx-dmzone-threatened { color: #7a4b00; }
.fdx-compact .fdx-dmunit, .fdx-compact .fdx-dmstation, .fdx-compact .fdx-dmzone { font-size: 9px; padding: 1px 6px; }
`;

type Label = { obj: CSS2DObject; el: HTMLDivElement };
type World = { x: number; y: number; z: number };

function zoneState(zone: Board["zones"][number], forecast: ZoneForecast | undefined): ZoneState | null {
  if (zone.overrunAt !== null) return "overrun";
  if (zone.orderedAt !== null) return "ordered";
  if (forecast && forecast.edgeEta !== null) return "threatened";
  return null;
}

/** Sets a label's text only when it changed (labels are re-measured on change). */
function setText(label: Label, text: string): void {
  if (label.el.textContent !== text) label.el.textContent = text;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

export class DemoBoardOverlay implements BoardOverlay {
  private frame: BoardFrame | null = null;
  private labels: LabelLayer | null = null;
  private group: THREE.Group | null = null;
  private style: HTMLStyleElement | null = null;
  private board: Board | null = null;
  private forecasts: ReadonlyMap<string, ZoneForecast> = new Map();
  private readonly materials = new Set<LineMaterial>();
  /** Built parts, each rebuilt when its key changes. */
  private stations: { group: THREE.Group; labels: Map<string, Label> } | null = null;
  private stationKey = "";
  private units: { meshes: Map<VehicleFamily, THREE.InstancedMesh>; slot: number[] } | null = null;
  private unitKey = "";
  private routes: THREE.Group | null = null;
  private routeKey = "";
  private fireLines: THREE.Group | null = null;
  private fireLineKey = "";
  private zones: { group: THREE.Group; labels: Label[] } | null = null;
  private zoneKey = "";
  /** Evacuating vehicles: one instanced car per marker (model.evacueeMarkers). */
  private evacuees: THREE.InstancedMesh | null = null;
  private unitLabels: Label[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);

  attach(frame: BoardFrame, parent: THREE.Group, labels: LabelLayer): void {
    this.detach();
    if (!frame.grid) return;
    this.frame = frame;
    this.labels = labels;
    this.group = new THREE.Group();
    this.group.name = "demo-board-overlay";
    parent.add(this.group);
    this.style = document.createElement("style");
    this.style.textContent = LABEL_CSS;
    labels.renderer.domElement.appendChild(this.style);
    this.update();
  }

  detach(): void {
    if (!this.group) return;
    this.clearStations();
    this.clearUnits();
    this.clearRoutes();
    this.clearFireLines();
    this.clearZones();
    this.clearEvacuees();
    this.group.removeFromParent();
    this.group = null;
    this.style?.remove();
    this.style = null;
    this.frame = null;
    this.labels = null;
  }

  tick(_time: number, _dt: number, _reducedMotion: boolean, width: number, height: number): void {
    for (const material of this.materials) material.resolution.set(width, height);
  }

  /** The board as it is now (mutated in place by the page; call again after every change). */
  setBoard(board: Board | null, forecasts: ReadonlyMap<string, ZoneForecast>): void {
    this.board = board;
    this.forecasts = forecasts;
    this.update();
  }

  private update(): void {
    if (!this.group) return;
    const board = this.board;
    const stationKey = board ? board.stations.map((s) => `${s.id}@${s.location.join(",")}`).join("|") : "";
    if (stationKey !== this.stationKey || !this.stations) {
      this.stationKey = stationKey;
      this.buildStations();
    }
    const unitKey = board ? board.teams.map((t) => `${t.id}:${t.kind}`).join("|") : "";
    if (unitKey !== this.unitKey || !this.units) {
      this.unitKey = unitKey;
      this.buildUnits();
    }
    const routeKey = board
      ? board.teams
          .filter((t) => t.status === "en_route" && t.target)
          .map((t) => `${t.id}>${t.fireId}:${t.route?.length ?? 0}:${t.target!.join(",")}`)
          .join("|")
      : "";
    if (routeKey !== this.routeKey || !this.routes) {
      this.routeKey = routeKey;
      this.buildRoutes();
    }
    // Rebuilt as line is built (10 m steps), not every frame.
    const fireLineKey = board ? board.lines.map((l) => `${l.id}:${Math.round(l.builtM / 10)}`).join("|") : "";
    if (fireLineKey !== this.fireLineKey || !this.fireLines) {
      this.fireLineKey = fireLineKey;
      this.buildFireLines();
    }
    const zoneKey = board
      ? board.zones.map((z) => `${z.id}:${zoneState(z, this.forecasts.get(z.id)) ?? ""}`).join("|")
      : "";
    if (zoneKey !== this.zoneKey || !this.zones) {
      this.zoneKey = zoneKey;
      this.buildZones();
    }
    this.placeUnits();
    this.placeEvacuees();
  }

  // ---- geometry helpers ----

  private toWorld(point: LonLat): World | null {
    const frame = this.frame;
    if (!frame) return null;
    const [mx, my] = lonLatToMercator(point[0], point[1]);
    const p = frame.fromMercator(mx, my);
    if (!p || !frame.inside(p.x, p.z)) return null;
    return { x: p.x, y: frame.surfaceAt(p.x, p.z), z: p.z };
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

  private line(positions: number[], color: THREE.ColorRepresentation, width: number, dashed: boolean): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width,
      worldUnits: false,
      dashed,
      dashSize: 1.6,
      gapSize: 1.2,
      transparent: true,
      opacity: 0.95,
    });
    this.materials.add(material);
    const line = new Line2(geometry, material);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 3;
    return line;
  }

  private dropLines(group: THREE.Group): void {
    group.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      if (material instanceof LineMaterial) this.materials.delete(material);
    });
    group.removeFromParent();
    disposeObject(group);
  }

  // ---- stations ----

  private clearStations(): void {
    if (!this.stations) return;
    for (const label of this.stations.labels.values()) this.labels?.remove(label.obj);
    this.stations.group.removeFromParent();
    disposeObject(this.stations.group);
    this.stations = null;
  }

  private buildStations(): void {
    this.clearStations();
    const { group: parent, labels, board } = this;
    if (!parent || !labels) return;
    const group = new THREE.Group();
    group.name = "demo-stations";
    parent.add(group);
    const map = new Map<string, Label>();
    this.stations = { group, labels: map };
    const places = (board?.stations ?? []).flatMap((s) => {
      const at = this.toWorld(s.location);
      return at ? [{ station: s, at }] : [];
    });
    if (places.length === 0) return;
    const { width, height, depth } = STATION_SIZE;
    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(width, height, depth).translate(0, height / 2, 0),
      new THREE.MeshStandardMaterial({ color: DEMO_3D_COLORS.stationWall, roughness: 0.7 }),
      places.length,
    );
    const roofs = new THREE.InstancedMesh(
      new THREE.BoxGeometry(width + 0.4, 0.6, depth + 0.4).translate(0, height + 0.3, 0),
      new THREE.MeshStandardMaterial({ color: DEMO_3D_COLORS.stationRoof, roughness: 0.6 }),
      places.length,
    );
    walls.castShadow = roofs.castShadow = true;
    places.forEach(({ station, at }, i) => {
      this.matrix.makeTranslation(at.x, at.y, at.z);
      walls.setMatrixAt(i, this.matrix);
      roofs.setMatrixAt(i, this.matrix);
      const label = labels.add(group, "fdx-dmstation", new THREE.Vector3(at.x, at.y + height + 2.2, at.z), new THREE.Vector2(0.5, 1));
      label.el.textContent = shortStationName(station.name);
      label.el.title = station.name;
      map.set(station.id, label);
    });
    walls.instanceMatrix.needsUpdate = roofs.instanceMatrix.needsUpdate = true;
    group.add(walls, roofs);
  }

  // ---- units ----

  private clearUnits(): void {
    for (const label of this.unitLabels) this.labels?.remove(label.obj);
    this.unitLabels = [];
    if (!this.units) return;
    for (const mesh of this.units.meshes.values()) {
      mesh.removeFromParent();
      disposeObject(mesh);
    }
    this.units = null;
  }

  private buildUnits(): void {
    this.clearUnits();
    const { group, board } = this;
    if (!group) return;
    const counts = new Map<VehicleFamily, number>();
    const teams = board?.teams ?? [];
    const slot = teams.map((team) => {
      const family = vehicleFamily(team.kind);
      const index = counts.get(family) ?? 0;
      counts.set(family, index + 1);
      return index;
    });
    const meshes = new Map<VehicleFamily, THREE.InstancedMesh>();
    for (const family of FAMILIES) {
      const count = counts.get(family) ?? 0;
      if (count === 0) continue;
      const size = SIZES[family];
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(size.length, size.height, size.width).translate(0, size.height / 2, 0),
        new THREE.MeshStandardMaterial({ color: CREW_COLORS[family], roughness: 0.5 }),
        count,
      );
      mesh.castShadow = true;
      mesh.name = `demo-unit-${family}`;
      group.add(mesh);
      meshes.set(family, mesh);
    }
    this.units = { meshes, slot };
  }

  private unitLabel(index: number): Label | null {
    const { labels, group } = this;
    if (!labels || !group) return null;
    while (this.unitLabels.length <= index) {
      this.unitLabels.push(labels.add(group, "fdx-dmunit", new THREE.Vector3(), new THREE.Vector2(0.5, 1)));
    }
    return this.unitLabels[index];
  }

  /** Positions every unit for the board's current minute and labels each spot. */
  private placeUnits(): void {
    const { board, units, frame } = this;
    if (!units || !frame) return;
    const teams = board?.teams ?? [];
    // Group units by spot so parked units fan out and share one label.
    const spots: { at: World; members: number[] }[] = [];
    const where = teams.map((team, index) => {
      const at = board ? this.toWorld(teamPosition(board, team)) : null;
      if (!at) return null;
      const spot = spots.find((s) => Math.hypot(s.at.x - at.x, s.at.z - at.z) < CLUSTER_WORLD);
      if (spot) spot.members.push(index);
      else spots.push({ at, members: [index] });
      return at;
    });
    teams.forEach((team, index) => {
      const mesh = units.meshes.get(vehicleFamily(team.kind));
      if (!mesh) return;
      const at = where[index];
      if (!at) {
        mesh.setMatrixAt(units.slot[index], this.matrix.makeScale(0, 0, 0));
        return;
      }
      const spot = spots.find((s) => s.members.includes(index))!;
      let x = at.x;
      let z = at.z;
      let yaw = 0;
      if (spot.members.length > 1) {
        const angle = (spot.members.indexOf(index) / spot.members.length) * Math.PI * 2;
        x = spot.at.x + Math.cos(angle) * PARK_RADIUS;
        z = spot.at.z + Math.sin(angle) * PARK_RADIUS;
        yaw = -angle;
      } else if (team.status === "en_route" && team.target) {
        const ahead = this.toWorld(team.target);
        if (ahead) yaw = Math.atan2(-(ahead.z - at.z), ahead.x - at.x);
      }
      this.quat.setFromAxisAngle(this.up, yaw);
      this.matrix.compose(new THREE.Vector3(x, frame.surfaceAt(x, z), z), this.quat, this.one);
      mesh.setMatrixAt(units.slot[index], this.matrix);
    });
    for (const mesh of units.meshes.values()) mesh.instanceMatrix.needsUpdate = true;

    // Labels: free units parked at their station join the station's label; every other spot gets its own.
    const freeAt = new Map<string, string[]>();
    let used = 0;
    for (const spot of spots) {
      const members = spot.members.map((i) => teams[i]);
      const parked = board
        ? members.every((t) => {
            const station = board.stations.find((s) => s.id === t.station);
            return t.status === "available" && station && distanceM(t.position, station.location) < AT_STATION_M;
          })
        : false;
      if (parked) {
        for (const t of members) freeAt.set(t.station, [...(freeAt.get(t.station) ?? []), t.id]);
        continue;
      }
      const label = this.unitLabel(used);
      if (!label) continue;
      used += 1;
      const ids = members.map((t) => t.id).join(" ");
      const first = members[0];
      setText(
        label,
        first.status === "on_scene" && first.fireId
          ? `${first.fireId} · ${ids}`
          : first.status === "en_route" && first.fireId && members.length === 1
            ? `${ids} → ${first.fireId}`
            : `${ids}${members.every((t) => t.status === "available") ? " · free" : ""}`,
      );
      label.obj.position.set(spot.at.x, spot.at.y + (members.length > 1 ? 5 : 4), spot.at.z);
      label.obj.visible = true;
    }
    for (const label of this.unitLabels.slice(used)) label.obj.visible = false;
    if (this.stations && board) {
      for (const station of board.stations) {
        const label = this.stations.labels.get(station.id);
        if (!label) continue;
        const free = freeAt.get(station.id);
        const short = shortStationName(station.name);
        setText(label, free ? `${short} · ${free.join(" ")}` : short);
      }
    }
    this.labels?.invalidate();
  }

  // ---- en-route lines ----

  private clearRoutes(): void {
    if (!this.routes) return;
    this.dropLines(this.routes);
    this.routes = null;
  }

  private buildRoutes(): void {
    this.clearRoutes();
    const { group: parent, board } = this;
    if (!parent) return;
    const group = new THREE.Group();
    group.name = "demo-unit-routes";
    parent.add(group);
    this.routes = group;
    for (const team of board?.teams ?? []) {
      // Only road lines: a unit waiting for its road route has none yet.
      if (team.status !== "en_route" || !team.route || team.route.length < 2) continue;
      const positions = this.drape(team.route, LIFT);
      if (positions.length >= 6) group.add(this.line(positions, DEMO_3D_COLORS.route, 2, true));
    }
  }

  // ---- fire line at attack positions ----

  private clearFireLines(): void {
    if (!this.fireLines) return;
    this.dropLines(this.fireLines);
    this.fireLines = null;
  }

  /** Each attack line draped on the ground: planned dashed, built part solid and wider. */
  private buildFireLines(): void {
    this.clearFireLines();
    const { group: parent, board } = this;
    if (!parent) return;
    const group = new THREE.Group();
    group.name = "demo-fire-lines";
    parent.add(group);
    this.fireLines = group;
    for (const line of board?.lines ?? []) {
      const { point: p, a, b, aM, bM } = line.plan;
      const planned = this.drape([a, p, b], ZONE_LIFT);
      if (planned.length >= 6) group.add(this.line(planned, DEMO_3D_COLORS.fireLine, 2, true));
      if (line.builtM <= 0) continue;
      const ext = lineBuiltExtent(line);
      const at = (q: LonLat, f: number): LonLat => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
      const built = this.drape([at(a, aM > 0 ? ext.a / aM : 0), p, at(b, bM > 0 ? ext.b / bM : 0)], ZONE_LIFT + 0.2);
      if (built.length >= 6) group.add(this.line(built, DEMO_3D_COLORS.fireLine, 4, false));
    }
  }

  // ---- zones ----

  private clearZones(): void {
    if (!this.zones) return;
    for (const label of this.zones.labels) this.labels?.remove(label.obj);
    this.dropLines(this.zones.group);
    this.zones = null;
  }

  private buildZones(): void {
    this.clearZones();
    const { group: parent, labels, board } = this;
    if (!parent || !labels) return;
    const group = new THREE.Group();
    group.name = "demo-zones";
    parent.add(group);
    const zoneLabels: Label[] = [];
    this.zones = { group, labels: zoneLabels };
    for (const zone of board?.zones ?? []) {
      const state = zoneState(zone, this.forecasts.get(zone.id));
      if (!state || zone.ring.length < 3) continue;
      const positions = this.drape([...zone.ring, zone.ring[0]], ZONE_LIFT);
      if (positions.length >= 6) group.add(this.line(positions, DEMO_3D_COLORS[state], state === "overrun" ? 4 : 3, state === "threatened"));
      const core = this.toWorld(zone.core);
      if (core) {
        const label = labels.add(group, `fdx-dmzone fdx-dmzone-${state}`, new THREE.Vector3(core.x, core.y + 3, core.z), new THREE.Vector2(0.5, 1));
        label.el.textContent = `${ZONE_TAG[state]} · ${zone.name}`;
        zoneLabels.push(label);
      }
    }
  }

  // ---- evacuating vehicles (simulated traffic) ----

  private clearEvacuees(): void {
    if (!this.evacuees) return;
    this.evacuees.removeFromParent();
    disposeObject(this.evacuees);
    this.evacuees = null;
  }

  /**
   * Places one small car per evacuee marker on its zone's road line (the routes' road geometry,
   * sampled by model.evacueeMarkers), pointing along the road. Never a straight line between points.
   */
  private placeEvacuees(): void {
    const { group, board } = this;
    if (!group) return;
    if (!this.evacuees) {
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(2.4, 1.2, 1.3).translate(0, 0.6, 0),
        new THREE.MeshStandardMaterial({ color: DEMO_3D_COLORS.evacuee, roughness: 0.5 }),
        EVACUEE_MARKERS_MAX,
      );
      mesh.name = "demo-evacuees";
      mesh.count = 0;
      group.add(mesh);
      this.evacuees = mesh;
    }
    const mesh = this.evacuees;
    let n = 0;
    for (const m of board ? evacueeMarkers(board) : []) {
      const p = this.toWorld(m.at);
      if (!p || n >= EVACUEE_MARKERS_MAX) continue;
      // Bearing is degrees true; the board's x runs east and z south, the box's length along x.
      this.quat.setFromAxisAngle(this.up, Math.PI / 2 - (m.bearing * Math.PI) / 180);
      this.matrix.compose(new THREE.Vector3(p.x, p.y + 0.2, p.z), this.quat, this.one);
      mesh.setMatrixAt(n, this.matrix);
      n += 1;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }
}
