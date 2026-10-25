/**
 * The /demo command board's units, stations and zones on the 3D diorama (a `BoardOverlay`,
 * fire/diorama/types.ts): stations as small firehouses with their names, each unit as a vehicle
 * block in its family's colour (as the Studio's CrewOverlay draws them) at its current board
 * position, with a dashed line along an en-route (or, thinner, a returning) unit's road route
 * (only a road route: never a straight line to its target), each fire line ahead of a fire
 * (planned dashed, built solid), small cars for the sampled evacuating vehicles on their road
 * routes, and the outline of each ordered, threatened or overrun zone draped on the ground with
 * its tag. Draws the simulated board only; it never changes it.
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
import { crewWork, type CrewWork } from "./fireState";
import { EVACUEE_MARKERS_MAX, distanceM, evacueeMarkers, lineBuiltExtent, zoneOrderStatus, type Board, type ZoneForecast } from "./model";
import { allClearLabelShown } from "./allClear";
import { BoardMotion, teamSubjects } from "./unitMotion";
import { unitSpotLabel } from "./unitActivity";

/** Colours baked into the 3D board (CSS cannot reach WebGL); the legend mirrors them. */
export const DEMO_3D_COLORS = {
  stationWall: 0xefe4d6,
  stationRoof: CREW_COLORS.engine,
  route: 0x6b5bd2,
  ordered: LEVEL_COLOR.evacuate_now,
  threatened: LEVEL_COLOR.be_ready,
  overrun: "#b3140c",
  /** A zone whose evacuation order was lifted (all clear, demo/allClear.ts): neutral, thin (boardMapLayers BOARD_COLOR.allClear). */
  lifted: "#5b6470",
  /** Fire line ahead of a fire (boardMapLayers BOARD_COLOR.fireLine). */
  fireLine: "#3b2a1a",
  /** Evacuating vehicles (simulated, sampled), on their zone's road route. */
  evacuee: 0x1f6feb,
  /** Helmet of a firefighter figure (its body is in its unit's family colour). */
  crewHelmet: 0xffd23f,
} as const;

/** Firefighter figures per crew at work (fireState.crewWork), the cap on all of them, and their spacing along the work path. */
const CREW_FIGURES = 4;
const CREW_FIGURES_MAX = 240;
const CREW_SPACING_WORLD = 2.2;
/** How far figures step in toward the fire over the work (world units), and the size of their working bob. */
const CREW_INWARD_WORLD = 2.4;
const CREW_BOB_WORLD = 0.6;
/** Figure: body and helmet, world units (exaggerated like the vehicles). */
const FIGURE = { bodyRadius: 0.34, bodyHeight: 1.25, headRadius: 0.32 } as const;

type CrewPath = {
  points: { x: number; z: number }[];
  /** Cumulative length at each point, world units. */
  cum: number[];
  /** Displayed and target worked length (eased toward the target each frame). */
  shown: number;
  target: number;
  /** Unit inward direction on the board (x east, z south). */
  inward: { x: number; z: number };
  kind: CrewWork["kind"];
  color: THREE.Color;
  phase: number;
  /** Share of the path worked (0..1), for the inward step. */
  progress: number;
};

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
/** Spacing of units fanned out at one spot (unitMotion slot units), world units. */
const SPOT_SPACING_WORLD = 5.5;
/** An available unit this close to its station is shown as parked there, metres. */
const AT_STATION_M = 60;

type ZoneState = "overrun" | "ordered" | "threatened" | "lifted";
const ZONE_TAG: Record<ZoneState, string> = { overrun: "Overrun", ordered: "Leave now", threatened: "At risk", lifted: "All clear" };

const LABEL_CSS = `
.fdx-dmunit { font-size: 10.5px; padding: 2px 8px; background: rgba(36, 30, 64, 0.88); color: #fff; border-color: rgba(20, 16, 40, 0.6); font-weight: 700; }
.fdx-dmstation { font-size: 10px; padding: 2px 7px; font-weight: 600; color: #3a3f45; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.fdx-dmzone { font-size: 10px; padding: 2px 7px; font-weight: 700; letter-spacing: 0.02em; }
.fdx-dmzone-overrun { color: #fff; background: rgba(122, 10, 5, 0.9); }
.fdx-dmzone-ordered { color: #7a0a05; }
.fdx-dmzone-threatened { color: #7a4b00; }
.fdx-dmzone-lifted { color: #3a3f45; font-weight: 600; }
.fdx-compact .fdx-dmunit, .fdx-compact .fdx-dmstation, .fdx-compact .fdx-dmzone { font-size: 9px; padding: 1px 6px; }
/* Station name tags are hidden: the red firehouses mark stations; names are in the panels. */
.fdx-dmstation { display: none; }
`;

type Label = { obj: CSS2DObject; el: HTMLDivElement };
type World = { x: number; y: number; z: number };

function zoneState(zone: Board["zones"][number], forecast: ZoneForecast | undefined, minute: number): ZoneState | null {
  // All clear (demo/allClear.ts): the "Leave now" sign goes; a neutral label for a while, then
  // nothing, unless a fire is forecast to reach the zone again (as boardMapLayers zoneMapState).
  if (zoneOrderStatus(zone, minute) === "lifted") {
    if (forecast && forecast.edgeEta !== null && forecast.edgeEta > 0) return "threatened";
    return allClearLabelShown(zone, minute) ? "lifted" : null;
  }
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
  /** Firefighter figures (body + helmet) for the crews at work, and what they walk along. */
  private crewMeshes: { body: THREE.InstancedMesh; helmet: THREE.InstancedMesh } | null = null;
  private crewPaths = new Map<string, CrewPath>();
  /** Unit labels by group lead (or unit) id, kept per id so a label never jumps to another unit. */
  private unitLabels = new Map<string, Label>();
  /** What each unit label says and how high it floats; rebuilt on board updates. */
  private labelPlan: { lead: string; text: string; lift: number }[] = [];
  /** Units drawn smoothly between board updates (unitMotion.ts); `moving` while frames still change them. */
  private readonly motion = new BoardMotion();
  private unitsMoving = false;
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
    this.clearCrews();
    this.group.removeFromParent();
    this.group = null;
    this.style?.remove();
    this.style = null;
    this.frame = null;
    this.labels = null;
  }

  tick(time: number, dt: number, reducedMotion: boolean, width: number, height: number): void {
    for (const material of this.materials) material.resolution.set(width, height);
    this.motion.setReducedMotion(reducedMotion);
    if (this.unitsMoving) this.unitsMoving = this.placeUnits(performance.now());
    this.placeCrews(time, dt, reducedMotion);
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
          .filter((t) => (t.status === "en_route" || t.status === "returning") && t.target)
          .map((t) => `${t.id}>${t.fireId ?? "home"}:${t.route?.length ?? 0}:${t.target!.join(",")}`)
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
      ? board.zones.map((z) => `${z.id}:${zoneState(z, this.forecasts.get(z.id), board.minute) ?? ""}`).join("|")
      : "";
    if (zoneKey !== this.zoneKey || !this.zones) {
      this.zoneKey = zoneKey;
      this.buildZones();
    }
    const now = performance.now();
    this.motion.sample(board, board ? teamSubjects(board) : [], now);
    this.motion.frame(now);
    this.planUnitLabels();
    this.unitsMoving = this.placeUnits(now);
    this.labels?.invalidate();
    this.placeEvacuees();
    this.updateCrews();
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
    void board; // station markers are the scene's shared marker (setStations), not drawn here
  }

  // ---- units ----

  private clearUnits(): void {
    for (const label of this.unitLabels.values()) this.labels?.remove(label.obj);
    this.unitLabels.clear();
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

  private unitLabel(id: string): Label | null {
    const { labels, group } = this;
    if (!labels || !group) return null;
    let label = this.unitLabels.get(id);
    if (!label) {
      label = labels.add(group, "fdx-dmunit", new THREE.Vector3(), new THREE.Vector2(0.5, 1));
      this.unitLabels.set(id, label);
    }
    return label;
  }

  /**
   * Label texts for the board update: one per group of units at one spot (unitMotion groups) at
   * its lead, one per lone unit; free units parked at their station join the station's label.
   */
  private planUnitLabels(): void {
    const { board, motion } = this;
    const teams = board?.teams ?? [];
    const byId = new Map(teams.map((t) => [t.id, t]));
    const plan: { lead: string; text: string; lift: number }[] = [];
    const done = new Set<string>();
    const freeAt = new Map<string, string[]>();
    for (const team of teams) {
      const d = motion.get(team.id);
      if (!d) continue;
      const lead = d.group?.lead ?? team.id;
      if (done.has(lead)) continue;
      done.add(lead);
      const members = (d.group?.ids ?? [team.id]).map((id) => byId.get(id)!).filter(Boolean);
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
      const ids = members.map((t) => t.id).join(" ");
      const first = members[0];
      // What the units here are doing and how far from their fire (unitActivity.ts), so a unit
      // standing away from the fire says why ("building S1-F1 head_60 line 830 m ahead of the head").
      const text = board
        ? unitSpotLabel(board, members)
        : first.status === "on_scene" && first.fireId
          ? `${first.fireId} · ${ids}`
          : first.status === "en_route" && first.fireId && members.length === 1
            ? `${ids} → ${first.fireId}`
            : `${ids}${members.every((t) => t.status === "available") ? " · free" : ""}`;
      plan.push({ lead, text, lift: members.length > 1 ? 5 : 4 });
    }
    this.labelPlan = plan;
    const keep = new Set(plan.map((p) => p.lead));
    for (const [id, label] of this.unitLabels) {
      if (keep.has(id)) continue;
      this.labels?.remove(label.obj);
      this.unitLabels.delete(id);
    }
    for (const p of plan) {
      const label = this.unitLabel(p.lead);
      if (label) setText(label, p.text);
    }
    if (this.stations && board) {
      for (const station of board.stations) {
        const label = this.stations.labels.get(station.id);
        if (!label) continue;
        const free = freeAt.get(station.id);
        setText(label, free ? `${station.name} · ${free.join(" ")} free` : station.name);
      }
    }
  }

  /**
   * Positions every unit where unitMotion draws it now (along its road between board updates,
   * facing along the road, fanned out from others at its spot) and moves the labels with them.
   * Returns whether anything is still moving.
   */
  private placeUnits(now: number): boolean {
    const { board, units, frame, motion } = this;
    if (!units || !frame) return false;
    const changing = motion.frame(now);
    const teams = board?.teams ?? [];
    teams.forEach((team, index) => {
      const mesh = units.meshes.get(vehicleFamily(team.kind));
      if (!mesh) return;
      const d = motion.get(team.id);
      const at = d ? this.toWorld(d.at) : null;
      if (!d || !at) {
        mesh.setMatrixAt(units.slot[index], this.matrix.makeScale(0, 0, 0));
        return;
      }
      // Slots are [east, north]; the board's x runs east and z south.
      const x = at.x + d.offset[0] * SPOT_SPACING_WORLD;
      const z = at.z - d.offset[1] * SPOT_SPACING_WORLD;
      // Heading is degrees true; the box's length lies along x.
      const yaw = d.heading === null ? 0 : Math.PI / 2 - (d.heading * Math.PI) / 180;
      this.quat.setFromAxisAngle(this.up, yaw);
      this.matrix.compose(new THREE.Vector3(x, frame.surfaceAt(x, z), z), this.quat, this.one);
      mesh.setMatrixAt(units.slot[index], this.matrix);
    });
    for (const mesh of units.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
    for (const p of this.labelPlan) {
      const label = this.unitLabels.get(p.lead);
      const d = motion.get(p.lead);
      const at = d ? this.toWorld(d.at) : null;
      if (!label) continue;
      label.obj.visible = at !== null;
      if (at) label.obj.position.set(at.x, at.y + p.lift, at.z);
    }
    return changing;
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
      // Only road lines: a unit waiting for its road route has none yet. Returning units too (their road home).
      if ((team.status !== "en_route" && team.status !== "returning") || !team.route || team.route.length < 2) continue;
      const positions = this.drape(team.route, LIFT);
      if (positions.length >= 6) group.add(this.line(positions, DEMO_3D_COLORS.route, team.status === "returning" ? 1 : 2, true));
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
      const state = zoneState(zone, this.forecasts.get(zone.id), board!.minute);
      if (!state || zone.ring.length < 3) continue;
      const positions = this.drape([...zone.ring, zone.ring[0]], ZONE_LIFT);
      if (positions.length >= 6) {
        group.add(this.line(positions, DEMO_3D_COLORS[state], state === "overrun" ? 4 : state === "lifted" ? 1.5 : 3, state === "threatened" || state === "lifted"));
      }
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
        // Smaller than any unit and shadowless, so traffic stays in the background of the board.
        new THREE.BoxGeometry(1.8, 0.9, 1.0).translate(0, 0.45, 0),
        new THREE.MeshStandardMaterial({ color: DEMO_3D_COLORS.evacuee, roughness: 0.7, transparent: true, opacity: 0.85 }),
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

  // ---- firefighters at work (simulated) ----

  private clearCrews(): void {
    this.crewPaths.clear();
    if (!this.crewMeshes) return;
    for (const mesh of [this.crewMeshes.body, this.crewMeshes.helmet]) {
      mesh.removeFromParent();
      disposeObject(mesh);
    }
    this.crewMeshes = null;
  }

  /**
   * Reads the crews' work for the board minute (fireState.crewWork): each crew's path on the
   * board, how far along it they have worked and which way is in toward the fire. Figures ease to
   * the new progress in `placeCrews` each frame.
   */
  private updateCrews(): void {
    const { group, board } = this;
    if (!group) return;
    const work: CrewWork[] = board ? crewWork(board) : [];
    const next = new Map<string, CrewPath>();
    for (const w of work) {
      const points: { x: number; z: number }[] = [];
      const cum: number[] = [];
      for (const p of w.path) {
        const at = this.toWorld(p);
        if (!at) continue;
        const last = points[points.length - 1];
        cum.push(last ? cum[cum.length - 1] + Math.hypot(at.x - last.x, at.z - last.z) : 0);
        points.push({ x: at.x, z: at.z });
      }
      if (points.length === 0) continue;
      const key = `${w.teamId}>${w.fireId}`;
      const total = cum[cum.length - 1];
      const progress = Math.min(1, Math.max(0, w.progress));
      const previous = this.crewPaths.get(key);
      const team = board?.teams.find((t) => t.id === w.teamId);
      const len = Math.hypot(w.inward[0], w.inward[1]);
      next.set(key, {
        points,
        cum,
        // A new crew appears at its current spot; a known one keeps easing from where it is drawn.
        shown: previous ? Math.min(previous.shown, total) : progress * total,
        target: progress * total,
        // inward is [east, north]; the board's z runs south.
        inward: len > 0 ? { x: w.inward[0] / len, z: -w.inward[1] / len } : { x: 0, z: 0 },
        kind: w.kind,
        color: new THREE.Color(CREW_COLORS[team ? vehicleFamily(team.kind) : "hand_crew"]),
        phase: previous?.phase ?? (hashString(key) % 628) / 100,
        progress,
      });
    }
    this.crewPaths = next;
    if (next.size > 0 && !this.crewMeshes) {
      const body = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(FIGURE.bodyRadius * 0.8, FIGURE.bodyRadius, FIGURE.bodyHeight, 6).translate(0, FIGURE.bodyHeight / 2, 0),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
        CREW_FIGURES_MAX,
      );
      const helmet = new THREE.InstancedMesh(
        new THREE.SphereGeometry(FIGURE.headRadius, 8, 6).translate(0, FIGURE.bodyHeight + FIGURE.headRadius * 0.8, 0),
        new THREE.MeshStandardMaterial({ color: DEMO_3D_COLORS.crewHelmet, roughness: 0.5 }),
        CREW_FIGURES_MAX,
      );
      body.name = "demo-crew-figures";
      helmet.name = "demo-crew-helmets";
      body.count = helmet.count = 0;
      body.frustumCulled = helmet.frustumCulled = false;
      group.add(body, helmet);
      this.crewMeshes = { body, helmet };
    }
  }

  /** Point at worked length `s` along the path. */
  private along(path: CrewPath, s: number): { x: number; z: number } {
    const { points, cum } = path;
    if (points.length === 1 || s <= 0) return points[0];
    for (let k = 1; k < points.length; k++) {
      if (cum[k] >= s) {
        const f = (s - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]);
        return { x: points[k - 1].x + (points[k].x - points[k - 1].x) * f, z: points[k - 1].z + (points[k].z - points[k - 1].z) * f };
      }
    }
    return points[points.length - 1];
  }

  /**
   * A few figures per crew in its unit's colour: the lead at the worked point, the rest behind it
   * along the path, stepping in toward the fire as the work progresses and bobbing as they work
   * (direct and mop-up crews swing in and out at the edge). Static under reduced motion.
   */
  private placeCrews(time: number, dt: number, reducedMotion: boolean): void {
    const meshes = this.crewMeshes;
    const frame = this.frame;
    if (!meshes || !frame) return;
    let n = 0;
    for (const path of this.crewPaths.values()) {
      path.shown = reducedMotion ? path.target : path.shown + (path.target - path.shown) * Math.min(1, dt * 2.5);
      for (let k = 0; k < CREW_FIGURES && n < CREW_FIGURES_MAX; k++) {
        const at = this.along(path, path.shown - k * CREW_SPACING_WORLD);
        const swing =
          reducedMotion || path.kind === "line" ? 0.5 : 0.5 + 0.5 * Math.sin(time * (path.kind === "mopup" ? 1.4 : 2.6) + path.phase + k * 1.7);
        const step = CREW_INWARD_WORLD * (0.25 + 0.75 * path.progress) * (path.kind === "line" ? 0.4 : 1) + CREW_BOB_WORLD * swing;
        const x = at.x + path.inward.x * step;
        const z = at.z + path.inward.z * step;
        const hop = reducedMotion ? 0 : Math.abs(Math.sin(time * 5 + path.phase + k)) * 0.18;
        this.quat.setFromAxisAngle(this.up, Math.atan2(path.inward.x, path.inward.z));
        this.matrix.compose(new THREE.Vector3(x, frame.surfaceAt(x, z) + hop, z), this.quat, this.one);
        meshes.body.setMatrixAt(n, this.matrix);
        meshes.helmet.setMatrixAt(n, this.matrix);
        meshes.body.setColorAt(n, path.color);
        n += 1;
      }
    }
    meshes.body.count = meshes.helmet.count = n;
    meshes.body.instanceMatrix.needsUpdate = meshes.helmet.instanceMatrix.needsUpdate = true;
    if (meshes.body.instanceColor) meshes.body.instanceColor.needsUpdate = true;
  }
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
