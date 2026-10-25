/**
 * Firefighting at work on the /live 3D board (simulated; drawn under DemoBoardOverlay): a hose
 * line from each engine on a hose job to its work point with water flowing along it and a spray
 * arc onto the burning edge, the dug line a hand crew or dozer leaves behind (growing as it
 * works), blade dust at a working dozer, and steam where cells were just put out (fading over
 * firefightingWork.JUST_PUT_OUT_MINUTES board minutes). Reads firefightingWork.ts only; it never
 * changes the board.
 *
 * Legible at any zoom: line widths are screen pixels and particles, icons and arc lengths have a
 * screen-pixel minimum. Light: one LineMaterial pair for every hose, one Points cloud for all
 * spray (SPRAY_MAX), a capped sprite pool (PUFF_MAX), geometry rebuilt only when a hose's ends or a
 * trail change. Under prefers-reduced-motion no particle moves: a static water-drop icon marks
 * each hose's nozzle and put-out cells get a still steam puff. The scene stops ticking in a
 * hidden tab (FireDioramaScene.frame), so this does too.
 */

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BoardFrame } from "../fire/diorama/board";
import type { LonLat } from "../live/types";
import { JUST_PUT_OUT_MINUTES, type FirefightingWork, type JustPutOut } from "./firefightingWork";

/** Colours baked into the 3D board for the firefighting marks; the legend mirrors them. */
export const FIREFIGHTING_3D_COLORS = {
  /** Charged hose line (dashes flow toward the nozzle) over a white casing. */
  hose: "#1d7fd6",
  hoseCasing: "#ffffff",
  /** Water spray particles (mid blue: pale blue vanishes on the light ground). */
  water: "#2f8ff0",
  /** Dug hand line / dozer line behind a working crew (the attack lines' ink). */
  dugLine: "#3b2a1a",
  /** Steam over just-put-out ground, and dozer blade dust. */
  steam: "#f4f6f8",
  dust: "#c9a46a",
} as const;

/** Caps (performance): hoses drawn, spray particles per hose, sprites in the puff pool. */
const HOSE_MAX = 24;
const SPRAY_PER_HOSE = 14;
const SPRAY_MAX = HOSE_MAX * SPRAY_PER_HOSE;
const PUFF_MAX = 96;
const DUST_PER_DOZER = 3;
/** Screen-pixel minimums so the marks read at the whole-board framing. */
const SPRAY_ARC_MIN_PX = 26;
const SPRAY_DOT_PX = 6;
const PUFF_MIN_PX = 22;
const ICON_PX = 18;
/**
 * Vehicles are drawn about 20x life size (DemoBoardOverlay SIZES), so a crew working 40 m from its
 * engine would stand inside the truck: a work point closer than this to its vehicle is drawn this
 * far out, in the same direction (world units; display only, like the vehicles' size).
 */
export const VEHICLE_CLEAR_WORLD = 4.5;
/** Lifts above the ground, world units. */
const HOSE_LIFT = 0.7;
const DRAPE_STEP = 1.5;

type World = { x: number; y: number; z: number };

export interface FxContext {
  frame: BoardFrame;
  toWorld(point: LonLat): World | null;
  /** Where a unit's vehicle is drawn now (after fanning out at its spot), or null. */
  vehicleWorld(teamId: string): World | null;
}

type Hose = {
  key: string;
  casing: Line2;
  core: Line2;
  /** Nozzle (hose end, at the work point), unit direction toward the fire, board xz. */
  nozzle: { x: number; z: number };
  dir: { x: number; z: number };
  phase: number;
  icon: THREE.Sprite;
};

type Trail = { key: string; line: Line2 };

function dotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.55, "rgba(255,255,255,0.8)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function puffTexture(): THREE.CanvasTexture {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // A soft cool-grey rim under white blobs, so a puff reads on the pale ground too.
    const blob = (cx: number, cy: number, r: number, a: number, rim: boolean) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.55, `rgba(255,255,255,${a * 0.75})`);
      if (rim) g.addColorStop(0.8, `rgba(110,125,140,${a * 0.45})`);
      g.addColorStop(1, "rgba(110,125,140,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    };
    blob(48, 50, 44, 0.85, true);
    blob(36, 42, 22, 0.5, false);
    blob(60, 44, 20, 0.45, false);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Reduced-motion icon: a water drop with a white rim (shape, not only colour). */
function dropTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.beginPath();
    ctx.moveTo(32, 6);
    ctx.bezierCurveTo(46, 26, 52, 34, 52, 42);
    ctx.arc(32, 42, 20, 0, Math.PI, false);
    ctx.bezierCurveTo(12, 34, 18, 26, 32, 6);
    ctx.closePath();
    ctx.fillStyle = FIREFIGHTING_3D_COLORS.hose;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(25, 42, 6, Math.PI * 0.9, Math.PI * 1.5);
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Offset that moves a work point `at` out to VEHICLE_CLEAR_WORLD from its vehicle, along vehicle -> point (else `dir`). */
export function clearOfVehicle(vehicle: { x: number; z: number }, at: { x: number; z: number }, dir: { x: number; z: number } | null): { x: number; z: number } {
  const dx = at.x - vehicle.x;
  const dz = at.z - vehicle.z;
  const d = Math.hypot(dx, dz);
  if (d >= VEHICLE_CLEAR_WORLD) return { x: 0, z: 0 };
  const u = d > 0.3 ? { x: dx / d, z: dz / d } : dir ?? { x: 1, z: 0 };
  // The point drawn at vehicle + u * clear: move it by that minus where it is.
  return { x: vehicle.x + u.x * VEHICLE_CLEAR_WORLD - at.x, z: vehicle.z + u.z * VEHICLE_CLEAR_WORLD - at.z };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export class FirefightingFx {
  readonly group = new THREE.Group();
  private readonly casingMat: LineMaterial;
  private readonly coreMat: LineMaterial;
  private readonly trailMat: LineMaterial;
  private readonly sprayGeo = new THREE.BufferGeometry();
  private readonly sprayPos = new Float32Array(SPRAY_MAX * 3);
  private readonly spray: THREE.Points;
  private readonly puffTex = puffTexture();
  private readonly dropTex = dropTexture();
  private readonly dotTex = dotTexture();
  private readonly puffs: THREE.Sprite[] = [];
  private readonly steamColor = new THREE.Color(FIREFIGHTING_3D_COLORS.steam);
  private readonly dustColor = new THREE.Color(FIREFIGHTING_3D_COLORS.dust);
  private hoses = new Map<string, Hose>();
  private trails = new Map<string, Trail>();
  /** Dozers at work: lead point on the board (dust), and the put-out cells (steam). */
  private dozers: { x: number; z: number; phase: number }[] = [];
  private steam: { x: number; z: number; age: number; phase: number }[] = [];
  private ctx: FxContext | null = null;
  /** Per team: how far its drawn work is moved clear of its vehicle (board xz). */
  private shifts = new Map<string, { x: number; z: number }>();

  constructor() {
    this.group.name = "demo-firefighting-fx";
    // Drawn over the oversized houses and trees around the work (no depth test), so they read.
    const line = (color: string, width: number, dashed: boolean) =>
      new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, worldUnits: false, dashed, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.95, depthTest: false });
    this.casingMat = line(FIREFIGHTING_3D_COLORS.hoseCasing, 5, false);
    this.coreMat = line(FIREFIGHTING_3D_COLORS.hose, 2.6, true);
    this.trailMat = line(FIREFIGHTING_3D_COLORS.dugLine, 3.5, false);
    this.sprayGeo.setAttribute("position", new THREE.BufferAttribute(this.sprayPos, 3));
    this.sprayGeo.setDrawRange(0, 0);
    this.spray = new THREE.Points(
      this.sprayGeo,
      new THREE.PointsMaterial({
        color: FIREFIGHTING_3D_COLORS.water,
        size: SPRAY_DOT_PX,
        sizeAttenuation: false,
        map: this.dotTex,
        transparent: true,
        depthWrite: false,
        // Drawn over the (oversized) houses and trucks around the work so the water always reads.
        depthTest: false,
        opacity: 0.95,
      }),
    );
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 7;
    this.spray.name = "demo-hose-spray";
    this.group.add(this.spray);
    for (let i = 0; i < PUFF_MAX; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 }));
      sprite.visible = false;
      sprite.renderOrder = 6;
      this.puffs.push(sprite);
      this.group.add(sprite);
    }
  }

  /** The board's work for this update (firefightingWork / justPutOut at the board minute). */
  setWork(ctx: FxContext, work: readonly FirefightingWork[], putOut: readonly JustPutOut[]): void {
    this.ctx = ctx;
    const nextHoses = new Map<string, Hose>();
    const nextTrails = new Map<string, Trail>();
    this.dozers = [];
    this.shifts = new Map();
    for (const w of work) {
      const at = ctx.toWorld(w.lead);
      if (!at) continue;
      // inward is [east, north]; the board's z runs south.
      const len = Math.hypot(w.inward[0], w.inward[1]);
      let dir = len > 0 ? { x: w.inward[0] / len, z: -w.inward[1] / len } : null;
      const phase = hash(w.teamId);
      const truck = ctx.vehicleWorld(w.teamId) ?? ctx.toWorld(w.vehicle);
      const shift = truck ? clearOfVehicle(truck, at, dir) : { x: 0, z: 0 };
      this.shifts.set(w.teamId, shift);
      const lead = { x: at.x + shift.x, y: at.y, z: at.z + shift.z };
      if (w.tool === "hose" && nextHoses.size < HOSE_MAX) {
        if (!truck) continue;
        if (!dir) {
          const d = Math.hypot(lead.x - truck.x, lead.z - truck.z);
          dir = d > 1e-6 ? { x: (lead.x - truck.x) / d, z: (lead.z - truck.z) / d } : { x: 1, z: 0 };
        }
        const key = `${Math.round(truck.x * 2)},${Math.round(truck.z * 2)}>${Math.round(lead.x * 2)},${Math.round(lead.z * 2)}`;
        const old = this.hoses.get(w.teamId);
        let hose: Hose;
        if (old && old.key === key) {
          hose = old;
          this.hoses.delete(w.teamId);
        } else {
          if (old) this.dropHose(old);
          this.hoses.delete(w.teamId);
          const positions = this.drape(ctx.frame, truck, lead);
          const casing = this.lineOf(positions, this.casingMat, 6);
          const core = this.lineOf(positions, this.coreMat, 7);
          core.computeLineDistances();
          const icon = old?.icon ?? new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dropTex, transparent: true, depthWrite: false, depthTest: false }));
          icon.renderOrder = 9;
          icon.visible = false;
          this.group.add(casing, core, icon);
          hose = { key, casing, core, nozzle: { x: lead.x, z: lead.z }, dir, phase, icon };
        }
        hose.dir = dir;
        nextHoses.set(w.teamId, hose);
      }
      // The ground a hand crew or dozer has worked: its dug line, growing as it works.
      if ((w.tool === "hand" || w.tool === "dozer") && w.kind !== "line" && w.trail.length >= 2) {
        const key = w.trail.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
        const old = this.trails.get(w.teamId);
        if (old && old.key === key) {
          nextTrails.set(w.teamId, old);
          this.trails.delete(w.teamId);
        } else {
          if (old) this.dropLine(old.line);
          this.trails.delete(w.teamId);
          const positions: number[] = [];
          for (let k = 1; k < w.trail.length; k++) {
            const a0 = ctx.toWorld(w.trail[k - 1]);
            const b0 = ctx.toWorld(w.trail[k]);
            if (!a0 || !b0) continue;
            const a = { x: a0.x + shift.x, z: a0.z + shift.z };
            const b = { x: b0.x + shift.x, z: b0.z + shift.z };
            const seg = this.drape(ctx.frame, a, b);
            positions.push(...(positions.length ? seg.slice(3) : seg));
          }
          if (positions.length >= 6) {
            const line = this.lineOf(positions, this.trailMat, 5);
            this.group.add(line);
            nextTrails.set(w.teamId, { key, line });
          }
        }
      }
      if (w.tool === "dozer") this.dozers.push({ x: lead.x, z: lead.z, phase });
    }
    for (const hose of this.hoses.values()) this.dropHose(hose, true);
    for (const trail of this.trails.values()) this.dropLine(trail.line);
    this.hoses = nextHoses;
    this.trails = nextTrails;
    this.steam = [];
    for (const p of putOut) {
      const at = ctx.toWorld(p.at);
      if (at) this.steam.push({ x: at.x, z: at.z, age: p.age, phase: hash(`${p.at[0]},${p.at[1]}`) });
    }
  }

  /** How far a team's drawn work is moved clear of its vehicle (board xz; zero when it is clear already). */
  shiftOf(teamId: string): { x: number; z: number } {
    return this.shifts.get(teamId) ?? { x: 0, z: 0 };
  }

  /** Every frame: flow the hoses, move the spray, steam and dust. `wpp` = world units per CSS px. */
  tick(time: number, reducedMotion: boolean, wpp: number, width: number, height: number): void {
    for (const m of [this.casingMat, this.coreMat, this.trailMat]) m.resolution.set(width, height);
    const ctx = this.ctx;
    // Dashes in world units: keep them a few pixels long at any zoom; flow toward the nozzle.
    this.coreMat.dashSize = 7 * wpp;
    this.coreMat.gapSize = 5 * wpp;
    this.coreMat.dashOffset = reducedMotion ? 0 : -time * 30 * wpp;
    let nSpray = 0;
    let nPuff = 0;
    const puff = (x: number, y: number, z: number, scale: number, opacity: number, color: THREE.Color) => {
      if (nPuff >= PUFF_MAX || opacity <= 0.01) return;
      const s = this.puffs[nPuff++];
      s.visible = true;
      s.position.set(x, y, z);
      s.scale.setScalar(scale);
      s.material.opacity = opacity;
      s.material.color.copy(color);
    };
    if (ctx) {
      const frame = ctx.frame;
      const arc = Math.max(frame.cellWorld * 1.2, SPRAY_ARC_MIN_PX * wpp);
      for (const hose of this.hoses.values()) {
        const { nozzle, dir } = hose;
        const y0 = frame.surfaceAt(nozzle.x, nozzle.z) + HOSE_LIFT + 0.6;
        const ex = nozzle.x + dir.x * arc;
        const ez = nozzle.z + dir.z * arc;
        const y1 = frame.surfaceAt(ex, ez) + 0.3;
        hose.icon.visible = reducedMotion;
        if (reducedMotion) {
          hose.icon.position.set(nozzle.x + dir.x * arc * 0.35, y0 + ICON_PX * wpp * 0.7, nozzle.z + dir.z * arc * 0.35);
          hose.icon.scale.setScalar(ICON_PX * wpp);
          continue;
        }
        // Water arc: particles cycle from the nozzle to where it lands on the burning edge.
        const px = -dir.z;
        const pz = dir.x;
        for (let k = 0; k < SPRAY_PER_HOSE && nSpray < SPRAY_MAX; k++) {
          const u = (time * 1.3 + k / SPRAY_PER_HOSE + hose.phase) % 1;
          const spread = (((k * 7919) % 13) / 13 - 0.5) * 0.35 * arc * u;
          const x = nozzle.x + dir.x * arc * u + px * spread;
          const z = nozzle.z + dir.z * arc * u + pz * spread;
          const y = y0 + (y1 - y0) * u + 4 * arc * 0.32 * u * (1 - u);
          this.sprayPos.set([x, y, z], nSpray * 3);
          nSpray++;
        }
        // Mist where it lands.
        const c = (time * 0.7 + hose.phase) % 1;
        puff(ex, y1 + 0.5 + c * arc * 0.25, ez, Math.max(PUFF_MIN_PX * wpp * 0.8, arc * 0.35) * (0.6 + 0.6 * c), 0.55 * (1 - c), this.steamColor);
      }
      // Steam over cells just put out, fading as they cool (board minutes).
      for (const s of this.steam) {
        const fade = Math.max(0, 1 - s.age / JUST_PUT_OUT_MINUTES);
        const base = frame.surfaceAt(s.x, s.z) + 0.4;
        const size = Math.max(PUFF_MIN_PX * wpp, frame.cellWorld * 1.4);
        if (reducedMotion) {
          puff(s.x, base + size * 0.4, s.z, size, 0.9 * (0.35 + 0.65 * fade), this.steamColor);
          continue;
        }
        const c = (time * 0.45 + s.phase) % 1;
        puff(s.x, base + size * (0.3 + 1.4 * c), s.z, size * (0.7 + 0.8 * c), 0.95 * (0.35 + 0.65 * fade) * Math.sin(Math.PI * Math.min(1, c * 1.15)), this.steamColor);
      }
      // Blade dust at working dozers.
      if (!reducedMotion) {
        for (const d of this.dozers) {
          for (let k = 0; k < DUST_PER_DOZER; k++) {
            const c = (time * 0.9 + d.phase + k / DUST_PER_DOZER) % 1;
            const size = Math.max(PUFF_MIN_PX * wpp * 0.8, frame.cellWorld);
            const a = (d.phase + k) * 2.4;
            puff(d.x + Math.cos(a) * size * 0.4 * c, frame.surfaceAt(d.x, d.z) + size * (0.2 + 0.7 * c), d.z + Math.sin(a) * size * 0.4 * c, size * (0.6 + 0.7 * c), 0.6 * (1 - c), this.dustColor);
          }
        }
      }
    }
    for (let i = nPuff; i < PUFF_MAX; i++) if (this.puffs[i].visible) this.puffs[i].visible = false;
    this.sprayGeo.setDrawRange(0, nSpray);
    (this.sprayGeo.attributes.position as THREE.BufferAttribute).needsUpdate = nSpray > 0;
    this.spray.visible = nSpray > 0;
  }

  dispose(): void {
    for (const hose of this.hoses.values()) this.dropHose(hose, true);
    for (const trail of this.trails.values()) this.dropLine(trail.line);
    this.hoses.clear();
    this.trails.clear();
    for (const s of this.puffs) s.material.dispose();
    this.sprayGeo.dispose();
    (this.spray.material as THREE.Material).dispose();
    for (const m of [this.casingMat, this.coreMat, this.trailMat]) m.dispose();
    for (const t of [this.puffTex, this.dropTex, this.dotTex]) t.dispose();
    this.group.removeFromParent();
    this.ctx = null;
  }

  private drape(frame: BoardFrame, a: { x: number; z: number }, b: { x: number; z: number }): number[] {
    const out: number[] = [];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / DRAPE_STEP));
    for (let s = 0; s <= steps; s++) {
      const x = a.x + ((b.x - a.x) * s) / steps;
      const z = a.z + ((b.z - a.z) * s) / steps;
      out.push(x, frame.surfaceAt(x, z) + HOSE_LIFT, z);
    }
    return out;
  }

  private lineOf(positions: number[], material: LineMaterial, order: number): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, material);
    line.renderOrder = order;
    return line;
  }

  private dropLine(line: Line2): void {
    line.removeFromParent();
    line.geometry.dispose();
  }

  private dropHose(hose: Hose, withIcon = false): void {
    this.dropLine(hose.casing);
    this.dropLine(hose.core);
    if (withIcon) {
      hose.icon.removeFromParent();
      hose.icon.material.dispose();
    }
  }
}
