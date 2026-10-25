/**
 * The /live command board's units, aircraft, safe areas and zones on the 3D diorama (a
 * `BoardOverlay`, fire/diorama/types.ts). Draws the simulated board only; it never changes it.
 *
 * - Ground units: a low-poly glyph per apparatus type (engine, water tender, dozer, crew carrier;
 *   apparatusGlyphs.ts) at its current board position. Trucks move only along their road legs
 *   (model.teamPosition along `team.route`, the per-access-class road route from
 *   POST /api/demo/crew_routes; unitMotion.ts smooths between board updates), with a dashed line
 *   along an en-route (or, thinner, a returning) unit's road route, never a straight line.
 * - Crews hiking in (unitActivity "hiking_in"): figures on foot from the parked vehicle to their
 *   work point (off-road walking, response/reach.ts), then the figures at work (fireState.crewWork).
 * - Aircraft (board.response.aircraft): helicopters with a spinning rotor, airtankers and the air
 *   attack / lead plane as fixed-wing glyphs, at altitude with a ground shadow, flying straight
 *   from their base (unitMotion.aircraftPoses); drop curtains on drop runs (retardant pink for
 *   airtankers, water blue for helicopters).
 * - Fire stations are the scene's shared red firehouse (fire/diorama/stationMarkers.ts via
 *   DemoDiorama setStations); this overlay draws no station hall of its own (no double halls).
 * - Safe areas (zone route destinations): flag, short label, fill gauge vs capacity (destinationMarkers.ts).
 * - Fire lines (planned dashed, built solid), evacuating vehicles on their road routes, the
 *   outline of each ordered, threatened or overrun zone with its tag.
 * - /run additions: `setFollowed` (a followed simulated person, their path and the part travelled)
 *   and `setPredictedFire` (dashed forecast perimeters at +30/+60/+120 min, labelled "forecast").
 */

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { BoardFrame } from "../fire/diorama/board";
import type { LabelLayer } from "../fire/diorama/labels";
import type { BoardOverlay, OverlayView } from "../fire/diorama/types";
import { lonLatToMercator, mercatorToLonLat } from "../fire/landscape";
import type { LonLat } from "../live/types";
import { OPEN_WATER_FUEL_CODE } from "../studio/aircraft";
import { vehicleFamily } from "../studio/apparatus";
import { CREW_COLORS } from "../studio/firelinePalette";
import {
  ROTOR_MAST_HEIGHT,
  airGlyphGeometry,
  airGlyphOf,
  dropCurtainGeometry,
  groundGlyphGeometry,
  groundGlyphOf,
  rotorGeometry,
  shadowGeometry,
  walkerGeometry,
  type AirGlyph,
  type GroundGlyph,
} from "./apparatusGlyphs";
import { APPARATUS_COLORS, DEMO_3D_COLORS, FOLLOW_COLORS } from "./board3dPalette";
import { DestinationMarkers, destinationMarks } from "./destinationMarkers";
import { fireOuterRings } from "./fireFootprint";
import { crewWork, type CrewWork } from "./fireState";
import { EVACUEE_MARKERS_MAX, distanceM, evacueeMarkers, lineBuiltExtent, type Board, type ZoneForecast } from "./model";
import { BoardMotion, aircraftPoses, offsetKm, teamSubjects, type AirPose } from "./unitMotion";
import { unitActivity, unitSpotLabel } from "./unitActivity";

export { DEMO_3D_COLORS } from "./board3dPalette";

/**
 * A simulated person followed from a phone (lead H1's app/src/live/followedPeople.ts defines the
 * canonical type; this is the structural shape the overlay reads). Coordinates [lon, lat].
 */
export interface FollowedPersonLike {
  personId: string;
  label: string;
  position: [number, number] | null;
  path: [number, number][];
  /** Share of `path` travelled, 0..1; null = unknown (the nearest path point to `position` is used). */
  progress: number | null;
  status: string;
  followers: number;
  destination: { name: string; coord: [number, number] } | null;
}

/** Predicted fire perimeters `minutes` ahead of the board clock (lead E's predict.ts), [lon, lat] rings. */
export interface PredictedFireRings {
  minutes: number;
  rings: [number, number][][];
}

/** What the page can call on the board's 3D view (DemoDiorama onOverlay / props). */
export interface DemoOverlayApi {
  setFollowed(people: readonly FollowedPersonLike[]): void;
  setPredictedFire(rings: readonly PredictedFireRings[]): void;
}

/** Firefighter figures per crew at work (fireState.crewWork), the cap on all of them, and their spacing along the work path. */
const CREW_FIGURES = 4;
const CREW_FIGURES_MAX = 240;
const CREW_SPACING_WORLD = 2.2;
/** How far figures step in toward the fire over the work (world units), and the size of their working bob. */
const CREW_INWARD_WORLD = 2.4;
const CREW_BOB_WORLD = 0.6;
/** Figure: body and helmet, world units (exaggerated like the vehicles). */
const FIGURE = { bodyRadius: 0.34, bodyHeight: 1.25, headRadius: 0.32 } as const;
/** Figures drawn walking per crew hiking in, their spacing (world units) and the cap on all of them. */
const HIKERS_PER_CREW = 4;
const HIKER_SPACING_WORLD = 1.6;
const HIKERS_MAX = 160;

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

/** A crew walking in from its parked vehicle to its work point between two board minutes. */
type Hike = { teamId: string; from: LonLat; to: LonLat; t0: number; t1: number };

const GROUND_GLYPHS: readonly GroundGlyph[] = ["engine", "tender", "dozer", "crew_carrier"];
const AIR_GLYPHS: readonly AirGlyph[] = ["helicopter", "airtanker", "air_attack"];
const LIFT = 0.9;
const ZONE_LIFT = 0.6;
const DRAPE_STEP = 1.5;
/** Spacing of units fanned out at one spot (unitMotion slot units), world units. */
const SPOT_SPACING_WORLD = 5.5;
/** An available unit this close to its station is shown as parked there, metres. */
const AT_STATION_M = 60;
/**
 * Aircraft height on the board: metres above ground x the board's scale x its relief
 * exaggeration x AIR_HEIGHT_EXAGGERATION, plus a clearance so a glyph drawn ~20x too large never
 * sinks into the ground. Display scale only (like the vehicle sizes).
 */
const AIR_HEIGHT_EXAGGERATION = 2.5;
const AIR_CLEARANCE_WORLD = 3;
/** Rotor turn rate, radians per second of animation (display only; frozen under reduced motion). */
const ROTOR_RAD_PER_S = 18;
/** A fire's drop point and a helicopter's dip site are re-read this often, board minutes. */
const DROP_POINT_EVERY_MIN = 5;
/** Forecast perimeter dash pattern and line widths (px), soonest first. */
const FORECAST_WIDTHS = [2.5, 2, 1.6];

type ZoneState = "overrun" | "ordered" | "threatened";
const ZONE_TAG: Record<ZoneState, string> = { overrun: "Overrun", ordered: "Leave now", threatened: "At risk" };

const AIR_PHASE_TEXT: Record<AirPose["phase"], string> = {
  parked: "at base",
  taking_off: "taking off",
  transit: "flying",
  drop_run: "drop run",
  dropping: "dropping",
  orbit: "over the fire",
  dip: "filling bucket",
  reloading: "reloading at base",
  returning: "flying back to base",
  holding: "holding over the fire",
};

const LABEL_CSS = `
.fdx-dmunit { font-size: 10.5px; padding: 2px 8px; background: rgba(36, 30, 64, 0.88); color: #fff; border-color: rgba(20, 16, 40, 0.6); font-weight: 700; }
.fdx-dmair { font-size: 10px; padding: 1px 7px; background: rgba(255, 255, 255, 0.92); color: #3a3f45; font-weight: 700; }
.fdx-dmzone { font-size: 10px; padding: 2px 7px; font-weight: 700; letter-spacing: 0.02em; }
.fdx-dmzone-overrun { color: #fff; background: rgba(122, 10, 5, 0.9); }
.fdx-dmzone-ordered { color: #7a0a05; }
.fdx-dmzone-threatened { color: #7a4b00; }
.fdx-dmfollow { font-size: 10.5px; padding: 2px 8px; background: rgba(150, 20, 110, 0.92); color: #fff; font-weight: 700; }
.fdx-dmforecast { font-size: 9.5px; padding: 1px 6px; font-weight: 700; color: #7a0a05; border-style: dashed; }
.fdx-compact .fdx-dmunit, .fdx-compact .fdx-dmzone, .fdx-compact .fdx-dmair, .fdx-compact .fdx-dmfollow, .fdx-compact .fdx-dmforecast { font-size: 9px; padding: 1px 6px; }
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

/** The part of `path` up to share `k` (0..1) of its length. */
function pathUpTo(path: readonly LonLat[], k: number): LonLat[] {
  if (path.length < 2) return [...path];
  const legs = path.slice(1).map((p, i) => distanceM(path[i], p));
  const total = legs.reduce((a, b) => a + b, 0);
  const goal = Math.min(1, Math.max(0, k)) * total;
  const out: LonLat[] = [path[0]];
  let acc = 0;
  for (let i = 0; i < legs.length; i++) {
    if (acc + legs[i] >= goal) {
      const f = legs[i] > 0 ? (goal - acc) / legs[i] : 0;
      out.push([path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f]);
      return out;
    }
    acc += legs[i];
    out.push(path[i + 1]);
  }
  return out;
}

/** Share of `path` up to its point nearest to `p` (by vertex). */
function shareAtNearest(path: readonly LonLat[], p: LonLat): number {
  if (path.length < 2) return 0;
  let best = 0;
  let bestM = Infinity;
  path.forEach((q, i) => {
    const m = distanceM(p, q);
    if (m < bestM) {
      bestM = m;
      best = i;
    }
  });
  let total = 0;
  let upTo = 0;
  for (let i = 1; i < path.length; i++) {
    const m = distanceM(path[i - 1], path[i]);
    total += m;
    if (i <= best) upTo += m;
  }
  return total > 0 ? upTo / total : 0;
}

export class DemoBoardOverlay implements BoardOverlay, DemoOverlayApi {
  private frame: BoardFrame | null = null;
  private labels: LabelLayer | null = null;
  private group: THREE.Group | null = null;
  private style: HTMLStyleElement | null = null;
  private board: Board | null = null;
  private forecasts: ReadonlyMap<string, ZoneForecast> = new Map();
  private readonly materials = new Set<LineMaterial>();
  /** Built parts, each rebuilt when its key changes. */
  private units: { meshes: Map<GroundGlyph, THREE.InstancedMesh>; slot: number[] } | null = null;
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
  /** Crews on foot walking in to their work (unitActivity hiking_in). */
  private hikes: Hike[] = [];
  private hikers: THREE.InstancedMesh | null = null;
  /** Aircraft glyphs, rotors, ground shadows and drop curtains. */
  private air: {
    meshes: Map<AirGlyph, THREE.InstancedMesh>;
    rotor: THREE.InstancedMesh;
    shadow: THREE.InstancedMesh;
    curtain: THREE.InstancedMesh;
  } | null = null;
  private airLabels = new Map<string, Label>();
  private readonly airSeen = new Map<string, LonLat>();
  private readonly dropPoints = new Map<string, { minute: number; at: LonLat | null }>();
  private readonly dipPoints = new Map<string, LonLat>();
  /** Safe-area destinations (flag, label, fill gauge). */
  private readonly destinations = new DestinationMarkers();
  /** Followed people and predicted perimeters (/run). */
  private followedPeople: readonly FollowedPersonLike[] = [];
  private followed: { group: THREE.Group; labels: Label[] } | null = null;
  private predicted: readonly PredictedFireRings[] = [];
  private forecast: { group: THREE.Group; labels: Label[] } | null = null;
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
  private readonly scaleV = new THREE.Vector3();
  private readonly posV = new THREE.Vector3();
  private readonly colorTmp = new THREE.Color();

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
    this.dipPoints.clear();
    this.dropPoints.clear();
    this.update();
    this.buildFollowed();
    this.buildForecast();
  }

  detach(): void {
    if (!this.group) return;
    this.clearUnits();
    this.clearRoutes();
    this.clearFireLines();
    this.clearZones();
    this.clearEvacuees();
    this.clearCrews();
    this.clearHikers();
    this.clearAir();
    this.clearFollowed();
    this.clearForecast();
    this.destinations.dispose();
    this.group.removeFromParent();
    this.group = null;
    this.style?.remove();
    this.style = null;
    this.frame = null;
    this.labels = null;
  }

  tick(time: number, dt: number, reducedMotion: boolean, width: number, height: number, view?: OverlayView): void {
    for (const material of this.materials) material.resolution.set(width, height);
    this.motion.setReducedMotion(reducedMotion);
    const flying = (this.board?.response.aircraft.length ?? 0) > 0 || this.hikes.length > 0;
    if (this.unitsMoving || flying) this.unitsMoving = this.placeUnits(performance.now());
    this.placeCrews(time, dt, reducedMotion);
    this.placeHikers(time, reducedMotion);
    this.placeAircraft(time);
    if (view) this.destinations.tick(view.distance, view.fit);
  }

  /** The board as it is now (mutated in place by the page; call again after every change). */
  setBoard(board: Board | null, forecasts: ReadonlyMap<string, ZoneForecast>): void {
    if (board !== this.board) {
      this.airSeen.clear();
      this.dropPoints.clear();
      this.dipPoints.clear();
    }
    this.board = board;
    this.forecasts = forecasts;
    this.update();
  }

  /** People followed from phones (/run): a highlighted marker, their whole path (dashed) and the part travelled (solid). */
  setFollowed(people: readonly FollowedPersonLike[]): void {
    this.followedPeople = people;
    this.buildFollowed();
  }

  /** Predicted fire perimeters ahead of the board clock (/run): dashed, labelled "forecast +N min". */
  setPredictedFire(rings: readonly PredictedFireRings[]): void {
    this.predicted = rings;
    this.buildForecast();
  }

  private update(): void {
    if (!this.group) return;
    const board = this.board;
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
      ? board.zones.map((z) => `${z.id}:${zoneState(z, this.forecasts.get(z.id)) ?? ""}`).join("|")
      : "";
    if (zoneKey !== this.zoneKey || !this.zones) {
      this.zoneKey = zoneKey;
      this.buildZones();
    }
    const now = performance.now();
    this.motion.sample(board, board ? teamSubjects(board) : [], now);
    this.motion.frame(now);
    this.planUnitLabels();
    this.planHikes();
    this.unitsMoving = this.placeUnits(now);
    this.labels?.invalidate();
    this.placeEvacuees();
    this.updateCrews();
    if (this.frame && this.labels) this.destinations.update(this.frame, this.group, this.labels, board ? destinationMarks(board) : []);
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

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group!.add(mesh);
    return mesh;
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

  /** One instanced glyph per apparatus type (engine, water tender, dozer, crew carrier). */
  private buildUnits(): void {
    this.clearUnits();
    const { group, board } = this;
    if (!group) return;
    const counts = new Map<GroundGlyph, number>();
    const teams = board?.teams ?? [];
    const slot = teams.map((team) => {
      const glyph = groundGlyphOf(team.kind);
      const index = counts.get(glyph) ?? 0;
      counts.set(glyph, index + 1);
      return index;
    });
    const meshes = new Map<GroundGlyph, THREE.InstancedMesh>();
    for (const glyph of GROUND_GLYPHS) {
      const count = counts.get(glyph) ?? 0;
      if (count === 0) continue;
      const mesh = new THREE.InstancedMesh(groundGlyphGeometry(glyph), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), count);
      mesh.castShadow = true;
      mesh.name = `demo-unit-${glyph}`;
      group.add(mesh);
      meshes.set(glyph, mesh);
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
   * its lead, one per lone unit; free units parked at their station carry no label (the red
   * firehouse marks the station; names are in the panels).
   */
  private planUnitLabels(): void {
    const { board, motion } = this;
    const teams = board?.teams ?? [];
    const byId = new Map(teams.map((t) => [t.id, t]));
    const plan: { lead: string; text: string; lift: number }[] = [];
    const done = new Set<string>();
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
      if (parked) continue;
      // What the units here are doing and how far from their fire (unitActivity.ts), so a unit
      // standing away from the fire says why ("building S1-F1 head_60 line 830 m ahead of the head").
      const text = board ? unitSpotLabel(board, members) : members.map((t) => t.id).join(" ");
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
      const mesh = units.meshes.get(groundGlyphOf(team.kind));
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
      // Heading is degrees true; the glyph's length lies along +x.
      const yaw = d.heading === null ? 0 : Math.PI / 2 - (d.heading * Math.PI) / 180;
      this.quat.setFromAxisAngle(this.up, yaw);
      this.matrix.compose(this.posV.set(x, frame.surfaceAt(x, z), z), this.quat, this.one);
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

  // ---- crews hiking in on foot ----

  private clearHikers(): void {
    this.hikes = [];
    if (!this.hikers) return;
    this.hikers.removeFromParent();
    disposeObject(this.hikers);
    this.hikers = null;
  }

  /** Crews parked at the end of their road leg and walking to their work (not dozers: they walk in on their own tracks, drawn parked). */
  private planHikes(): void {
    const board = this.board;
    const hikes: Hike[] = [];
    for (const team of board?.teams ?? []) {
      if (team.status !== "on_scene" || team.workStartAt === null || team.workStartAt <= board!.minute) continue;
      if (vehicleFamily(team.kind) === "dozer") continue;
      const activity = unitActivity(board!, team);
      if (activity.kind !== "hiking_in" || !activity.workPoint) continue;
      const t0 = Math.min(team.arriveAt ?? board!.minute, board!.minute);
      hikes.push({ teamId: team.id, from: team.position, to: activity.workPoint, t0, t1: team.workStartAt });
    }
    this.hikes = hikes;
    if (hikes.length > 0 && !this.hikers && this.group) {
      this.hikers = this.instanced(walkerGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), HIKERS_MAX, "demo-hikers");
    }
  }

  /** Figures strung out along the walk from the parked vehicle toward the work point, by the share of the hike done. */
  private placeHikers(time: number, reducedMotion: boolean): void {
    const mesh = this.hikers;
    const frame = this.frame;
    if (!mesh || !frame) return;
    const minute = this.motion.minute;
    let n = 0;
    for (const h of this.hikes) {
      const a = this.toWorld(h.from);
      const b = this.toWorld(h.to);
      if (!a || !b) continue;
      const k = h.t1 > h.t0 ? Math.min(1, Math.max(0, (minute - h.t0) / (h.t1 - h.t0))) : 1;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const yaw = Math.atan2(-dz, dx);
      this.quat.setFromAxisAngle(this.up, yaw);
      for (let i = 0; i < HIKERS_PER_CREW && n < HIKERS_MAX; i++) {
        const s = Math.max(0, k * len - i * HIKER_SPACING_WORLD);
        const x = a.x + (dx / len) * s + (i % 2 ? 0.5 : -0.5) * (dz / len);
        const z = a.z + (dz / len) * s - (i % 2 ? 0.5 : -0.5) * (dx / len);
        const hop = reducedMotion ? 0 : Math.abs(Math.sin(time * 6 + i * 1.3)) * 0.15;
        this.matrix.compose(this.posV.set(x, frame.surfaceAt(x, z) + hop, z), this.quat, this.one);
        mesh.setMatrixAt(n, this.matrix);
        n += 1;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ---- aircraft ----

  private clearAir(): void {
    for (const label of this.airLabels.values()) this.labels?.remove(label.obj);
    this.airLabels.clear();
    if (!this.air) return;
    for (const mesh of [...this.air.meshes.values(), this.air.rotor, this.air.shadow, this.air.curtain]) {
      mesh.removeFromParent();
      disposeObject(mesh);
    }
    this.air = null;
  }

  private ensureAir(count: number): NonNullable<DemoBoardOverlay["air"]> | null {
    if (!this.group) return null;
    if (this.air && this.air.rotor.instanceMatrix.count >= count) return this.air;
    this.clearAir();
    const cap = Math.max(8, count);
    const meshes = new Map<AirGlyph, THREE.InstancedMesh>();
    for (const glyph of AIR_GLYPHS) {
      const mesh = this.instanced(airGlyphGeometry(glyph), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 }), cap, `demo-air-${glyph}`);
      mesh.castShadow = true;
      meshes.set(glyph, mesh);
    }
    const rotor = this.instanced(rotorGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }), cap, "demo-air-rotor");
    const shadow = this.instanced(
      shadowGeometry(2.6),
      new THREE.MeshBasicMaterial({ color: APPARATUS_COLORS.shadow, transparent: true, opacity: 0.28, depthWrite: false }),
      cap,
      "demo-air-shadow",
    );
    const curtain = this.instanced(
      dropCurtainGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
      cap,
      "demo-air-drop",
    );
    this.air = { meshes, rotor, shadow, curtain };
    return this.air;
  }

  /** The fire's drop target: the perimeter point farthest from its origin (the head), re-read every few board minutes. */
  private dropPoint(fireId: string): LonLat | null {
    const board = this.board;
    if (!board) return null;
    const cached = this.dropPoints.get(fireId);
    const bucket = Math.floor(board.minute / DROP_POINT_EVERY_MIN);
    if (cached && cached.minute === bucket) return cached.at;
    const fire = board.fires.find((f) => f.id === fireId);
    let at: LonLat | null = fire ? fire.origin : null;
    if (fire) {
      let best = -1;
      for (const ring of fireOuterRings(board, fire)) {
        for (const p of ring) {
          const m = distanceM(fire.origin, p);
          if (m > best) {
            best = m;
            at = p;
          }
        }
      }
    }
    this.dropPoints.set(fireId, { minute: bucket, at });
    return at;
  }

  /**
   * A helicopter's dip site: the nearest open-water cell (LANDFIRE FBFM40 98) on the board's
   * landscape to the drop point, as boardResponse's dipKm measures; without one, a point `dipKm`
   * behind the fire (away from the head; ASSUMPTION, display only: the model then uses its
   * assumed dip distance and has no site).
   */
  private dipPoint(fireId: string, drop: LonLat, dipKm: number): LonLat {
    const cached = this.dipPoints.get(fireId);
    if (cached) return cached;
    const board = this.board;
    const grid = board?.env.landscape;
    let at: LonLat | null = null;
    if (grid) {
      const [x, y] = lonLatToMercator(drop[0], drop[1]);
      const cx = (x - grid.originX) / grid.cellSizeX;
      const cy = (y - grid.originY) / grid.cellSizeY;
      let best = Infinity;
      let bi = -1;
      for (let i = 0; i < grid.fuelCodes.length; i += 1) {
        if (grid.fuelCodes[i] !== OPEN_WATER_FUEL_CODE) continue;
        const c = i % grid.width;
        const r = (i - c) / grid.width;
        const d = Math.hypot(c - cx, r - cy);
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      if (bi >= 0) {
        const c = bi % grid.width;
        const r = (bi - c) / grid.width;
        at = mercatorToLonLat(grid.originX + (c + 0.5) * grid.cellSizeX, grid.originY + (r + 0.5) * grid.cellSizeY);
      }
    }
    if (!at) {
      const fire = board?.fires.find((f) => f.id === fireId);
      const away = fire ? (Math.atan2(fire.origin[0] - drop[0], fire.origin[1] - drop[1]) * 180) / Math.PI : 180;
      at = offsetKm(drop, (away + 360) % 360, dipKm);
    }
    this.dipPoints.set(fireId, at);
    return at;
  }

  /** Every frame: aircraft at the smoothed display minute (straight lines; rotors spin unless reduced motion froze `time`). */
  private placeAircraft(time: number): void {
    const { board, frame } = this;
    if (!frame) return;
    const poses = board
      ? aircraftPoses(
          board,
          this.motion.minute,
          (id) => this.dropPoint(id),
          (id, drop, km) => this.dipPoint(id, drop, km),
          this.airSeen,
        )
      : [];
    if (poses.length === 0 && !this.air) return;
    const air = this.ensureAir(poses.length);
    if (!air) return;
    const counts = new Map<AirGlyph, number>();
    let rotors = 0;
    let shadows = 0;
    let curtains = 0;
    const heightScale = frame.unitsPerMeter * Math.max(1, frame.verticalExaggeration) * AIR_HEIGHT_EXAGGERATION;
    const keep = new Set<string>();
    for (const p of poses) {
      const ground = this.toWorld(p.at);
      if (!ground) continue;
      const glyph = airGlyphOf(p.kind);
      const mesh = air.meshes.get(glyph)!;
      const i = counts.get(glyph) ?? 0;
      counts.set(glyph, i + 1);
      const y = ground.y + (p.airborne ? AIR_CLEARANCE_WORLD + p.altitudeM * heightScale : 0);
      const yaw = p.heading === null ? 0 : Math.PI / 2 - (p.heading * Math.PI) / 180;
      this.quat.setFromAxisAngle(this.up, yaw);
      this.matrix.compose(this.posV.set(ground.x, y, ground.z), this.quat, this.one);
      mesh.setMatrixAt(i, this.matrix);
      if (glyph === "helicopter" && p.airborne) {
        // Rotor on the mast (x 0.4 along the body), spinning about y.
        const mast = new THREE.Vector3(0.4, ROTOR_MAST_HEIGHT, 0).applyQuaternion(this.quat);
        this.quat.setFromAxisAngle(this.up, yaw + time * ROTOR_RAD_PER_S);
        this.matrix.compose(this.posV.set(ground.x + mast.x, y + mast.y, ground.z + mast.z), this.quat, this.one);
        air.rotor.setMatrixAt(rotors++, this.matrix);
      }
      if (p.airborne) {
        this.matrix.compose(this.posV.set(ground.x, ground.y + 0.15, ground.z), this.quat.identity(), this.one);
        air.shadow.setMatrixAt(shadows++, this.matrix);
      }
      if (p.phase === "dropping" && p.airborne) {
        // Curtain from the aircraft's belly to the ground (geometry hangs 8 units below y = 0).
        const h = Math.max(1, y - ground.y);
        this.matrix.compose(this.posV.set(ground.x, y, ground.z), this.quat.identity(), this.scaleV.set(1, h / 8, 1));
        air.curtain.setMatrixAt(curtains, this.matrix);
        air.curtain.setColorAt(curtains, this.colorTmp.set(glyph === "helicopter" ? APPARATUS_COLORS.water : APPARATUS_COLORS.retardant));
        curtains += 1;
      }
      // A label for aircraft in the air: id, type and what it is doing.
      if (p.airborne && this.labels && this.group) {
        keep.add(p.id);
        let label = this.airLabels.get(p.id);
        if (!label) {
          label = this.labels.add(this.group, "fdx-dmair", new THREE.Vector3(), new THREE.Vector2(0.5, 1));
          this.airLabels.set(p.id, label);
        }
        setText(label, `${p.id} · ${AIR_PHASE_TEXT[p.phase]}${p.fireId && p.phase !== "returning" ? ` ${p.fireId}` : ""}`);
        label.obj.position.set(ground.x, y + 3.5, ground.z);
      }
    }
    for (const glyph of AIR_GLYPHS) {
      const mesh = air.meshes.get(glyph)!;
      mesh.count = counts.get(glyph) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    air.rotor.count = rotors;
    air.shadow.count = shadows;
    air.curtain.count = curtains;
    air.rotor.instanceMatrix.needsUpdate = air.shadow.instanceMatrix.needsUpdate = air.curtain.instanceMatrix.needsUpdate = true;
    if (air.curtain.instanceColor) air.curtain.instanceColor.needsUpdate = true;
    for (const [id, label] of this.airLabels) {
      if (keep.has(id)) continue;
      this.labels?.remove(label.obj);
      this.airLabels.delete(id);
    }
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

  // ---- followed people (/run) ----

  private clearFollowed(): void {
    if (!this.followed) return;
    for (const label of this.followed.labels) this.labels?.remove(label.obj);
    this.dropLines(this.followed.group);
    this.followed = null;
  }

  /** Each followed person: whole path dashed, travelled part solid and darker, a pin with a white ground ring, and a label. */
  private buildFollowed(): void {
    this.clearFollowed();
    const { group: parent, labels } = this;
    if (!parent || !labels || this.followedPeople.length === 0) return;
    const group = new THREE.Group();
    group.name = "demo-followed";
    parent.add(group);
    const followLabels: Label[] = [];
    this.followed = { group, labels: followLabels };
    const pinMat = new THREE.MeshStandardMaterial({ color: FOLLOW_COLORS.person, roughness: 0.4, emissive: FOLLOW_COLORS.person, emissiveIntensity: 0.25 });
    const ringMat = new THREE.MeshBasicMaterial({ color: FOLLOW_COLORS.personRing, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    for (const person of this.followedPeople) {
      const path = person.path.map((p) => [p[0], p[1]] as LonLat);
      if (path.length >= 2) {
        const whole = this.drape(path, LIFT + 0.3);
        if (whole.length >= 6) group.add(this.line(whole, FOLLOW_COLORS.path, 2, true));
        const share = person.progress ?? (person.position ? shareAtNearest(path, person.position) : 0);
        const done = this.drape(pathUpTo(path, share), LIFT + 0.4);
        if (done.length >= 6) group.add(this.line(done, FOLLOW_COLORS.travelled, 4, false));
      }
      const at = person.position ? this.toWorld(person.position) : null;
      if (!at) continue;
      const pin = new THREE.Group();
      pin.position.set(at.x, at.y, at.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4, 6).translate(0, 2, 0), pinMat);
      const head = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 10).translate(0, 4.6, 0), pinMat);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.3, 24).rotateX(-Math.PI / 2).translate(0, 0.25, 0), ringMat);
      pin.add(pole, head, ring);
      group.add(pin);
      const label = labels.add(group, "fdx-dmfollow", new THREE.Vector3(at.x, at.y + 6.5, at.z), new THREE.Vector2(0.5, 1));
      const who = person.followers > 0 ? ` · ${person.followers} following` : "";
      const to = person.destination ? ` → ${person.destination.name}` : "";
      label.el.textContent = `${person.label} (simulated) · ${person.status}${to}${who}`;
      followLabels.push(label);
    }
    labels.invalidate();
  }

  // ---- predicted fire perimeters (/run) ----

  private clearForecast(): void {
    if (!this.forecast) return;
    for (const label of this.forecast.labels) this.labels?.remove(label.obj);
    this.dropLines(this.forecast.group);
    this.forecast = null;
  }

  /** Dashed perimeters per forecast horizon (soonest darkest and widest), labelled "forecast +N min" at the ring's northernmost point. */
  private buildForecast(): void {
    this.clearForecast();
    const { group: parent, labels } = this;
    if (!parent || !labels || this.predicted.length === 0) return;
    const group = new THREE.Group();
    group.name = "demo-forecast";
    parent.add(group);
    const forecastLabels: Label[] = [];
    this.forecast = { group, labels: forecastLabels };
    const sorted = [...this.predicted].sort((a, b) => a.minutes - b.minutes);
    sorted.forEach((horizon, index) => {
      const color = FOLLOW_COLORS.forecast[Math.min(index, FOLLOW_COLORS.forecast.length - 1)];
      const width = FORECAST_WIDTHS[Math.min(index, FORECAST_WIDTHS.length - 1)];
      let top: LonLat | null = null;
      for (const ring of horizon.rings) {
        if (ring.length < 3) continue;
        const closed = ring.map((p) => [p[0], p[1]] as LonLat);
        const positions = this.drape([...closed, closed[0]], ZONE_LIFT + 0.4 + index * 0.1);
        if (positions.length >= 6) group.add(this.line(positions, color, width, true));
        for (const p of closed) if (!top || p[1] > top[1]) top = p;
      }
      const at = top ? this.toWorld(top) : null;
      if (at) {
        const label = labels.add(group, "fdx-dmforecast", new THREE.Vector3(at.x, at.y + 2, at.z), new THREE.Vector2(0.5, 1));
        label.el.textContent = `forecast +${Math.round(horizon.minutes)} min`;
        forecastLabels.push(label);
      }
    });
    labels.invalidate();
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
      this.matrix.compose(this.posV.set(p.x, p.y + 0.2, p.z), this.quat, this.one);
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
        this.matrix.compose(this.posV.set(x, frame.surfaceAt(x, z) + hop, z), this.quat, this.one);
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
