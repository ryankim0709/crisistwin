import * as THREE from "three";
import type { CrewState, FireField, World } from "../types";
import { heightAt } from "../world";
import { hash2, softDotTexture } from "./geometry";
import { PALETTE } from "./palette";
import type { SurfaceHeight } from "./roads";

export type BurningCell = { i: number; x: number; y: number; z: number; age: number };

/** A burning cell chosen to carry flame glow / smoke, with a 0..1 weight. */
export type HotSpot = BurningCell & { weight: number };

const HOTSPOT_COUNT = 32;

/**
 * Lists burning cells at simulation time `t` and picks "hot spots": actually burning
 * cells weighted toward the fresh, downwind head of the fire (fading on the flanks and
 * back), with deterministic per-cell variation so they do not line the perimeter evenly.
 */
export class FireSampler {
  private readonly fire: FireField;
  private readonly heights: Float32Array;
  private readonly toward: { x: number; z: number };
  burning: BurningCell[] = [];
  hotSpots: HotSpot[] = [];
  /** Downwind extent (projection on the wind direction) of the burning cells. */
  readonly headRange = { min: 0, max: 1 };
  private t = -1;

  constructor(fire: FireField, wind: World["wind"]) {
    this.fire = fire;
    const len = Math.hypot(wind.toward.x, wind.toward.z) || 1;
    this.toward = { x: wind.toward.x / len, z: wind.toward.z / len };
    this.heights = new Float32Array(fire.cols * fire.rows);
    for (let r = 0; r < fire.rows; r++) {
      for (let c = 0; c < fire.cols; c++) {
        const x = fire.originX + (c + 0.5) * fire.cellSize;
        const z = fire.originZ + (r + 0.5) * fire.cellSize;
        this.heights[r * fire.cols + c] = heightAt(x, z);
      }
    }
  }

  update(t: number): boolean {
    if (t === this.t) return false;
    this.t = t;
    const f = this.fire;
    this.burning = [];
    let minP = Infinity;
    let maxP = -Infinity;
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        const i = r * f.cols + c;
        const age = t - f.ignitionTime[i];
        if (!(age >= 0 && age < f.burnDuration)) continue;
        const cell = {
          i,
          x: f.originX + (c + 0.5) * f.cellSize,
          y: this.heights[i],
          z: f.originZ + (r + 0.5) * f.cellSize,
          age,
        };
        this.burning.push(cell);
        const p = cell.x * this.toward.x + cell.z * this.toward.z;
        minP = Math.min(minP, p);
        maxP = Math.max(maxP, p);
      }
    }
    if (this.burning.length) {
      this.headRange.min = minP;
      this.headRange.max = maxP;
    }
    const span = Math.max(f.cellSize * 2, maxP - minP);
    const scored: { cell: BurningCell; weight: number; score: number }[] = [];
    for (const cell of this.burning) {
      const head = (cell.x * this.toward.x + cell.z * this.toward.z - minP) / span;
      const fresh = 1 - cell.age / f.burnDuration;
      const weight = Math.pow(fresh, 0.7) * (0.12 + 0.88 * smooth(0.3, 1, head));
      const score = weight * (0.3 + 0.7 * hash2(cell.i * 0.61, 4.7));
      if (score > 0.03) scored.push({ cell, weight, score });
    }
    scored.sort((a, b) => b.score - a.score);
    this.hotSpots = scored.slice(0, HOTSPOT_COUNT).map(({ cell, weight }) => ({ ...cell, weight }));
    return true;
  }
}

const smooth = (a: number, b: number, v: number) => {
  const k = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** Very soft, slightly lumpy puff for smoke sprites. */
function smokeTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const blob = (cx: number, cy: number, r: number, a: number) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.45, `rgba(255,255,255,${a * 0.45})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    };
    blob(64, 64, 62, 0.75);
    blob(48, 56, 34, 0.35);
    blob(80, 70, 30, 0.3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type SmokeParticle = {
  sprite: THREE.Sprite;
  cycle: number;
  origin: THREE.Vector3;
  offset: number;
  shade: number;
};

const SMOKE_LIFE = 11;
const SMOKE_COUNT = 30;
const SMOKE_COUNT_REDUCED = 10;
const GLOW_COUNT = 32;
const SPRAY_PARTICLES = 28;
const MAX_CREWS = 8;

/** Smoke, flame glow, ignition marker, wind glyph and hose spray. */
export class EffectsLayer {
  readonly group = new THREE.Group();
  readonly windAnchor = new THREE.Vector3();
  private readonly world: World;
  private readonly fire: FireField;
  private readonly surfaceHeight: SurfaceHeight;
  private readonly dot: THREE.CanvasTexture;
  private readonly puff: THREE.CanvasTexture;
  private readonly smoke: SmokeParticle[] = [];
  private readonly glows: THREE.Sprite[] = [];
  private readonly ignition = new THREE.Group();
  private readonly ignitionRing: THREE.Mesh;
  private readonly wind = new THREE.Group();
  private readonly windStreaks: THREE.Mesh[] = [];
  private readonly spray: THREE.Points;
  private readonly sprayMist: THREE.Sprite[] = [];
  private crews: CrewState[] = [];
  private simT = 0;
  private sampler: FireSampler;

  constructor(world: World, fire: FireField, surfaceHeight: SurfaceHeight, sampler: FireSampler) {
    this.world = world;
    this.fire = fire;
    this.surfaceHeight = surfaceHeight;
    this.sampler = sampler;
    this.dot = softDotTexture(64);
    this.puff = smokeTexture();

    for (let i = 0; i < SMOKE_COUNT; i++) {
      const shade = hash2(i, 7.3);
      const material = new THREE.SpriteMaterial({
        map: this.puff,
        color: new THREE.Color(PALETTE.smoke).multiplyScalar(0.78 + shade * 0.25),
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 5;
      this.smoke.push({
        sprite,
        cycle: -1,
        origin: new THREE.Vector3(),
        offset: (i / SMOKE_COUNT) * SMOKE_LIFE,
        shade,
      });
      this.group.add(sprite);
    }

    for (let i = 0; i < GLOW_COUNT; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.dot,
          color: i % 3 === 0 ? PALETTE.coral : PALETTE.amber,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
          toneMapped: false,
        }),
      );
      sprite.visible = false;
      sprite.renderOrder = 4;
      this.glows.push(sprite);
      this.group.add(sprite);
    }

    // Ignition marker: pulsing amber ring and a faint vertical beam for the first seconds.
    const ig = world.ignition;
    const igY = heightAt(ig.x, ig.z);
    const ringGeo = new THREE.RingGeometry(5, 6.2, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ignitionRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: PALETTE.amber,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.ignitionRing.position.set(ig.x, igY + 1, ig.z);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 1.4, 34, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: PALETTE.amber,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    beam.position.set(ig.x, igY + 17, ig.z);
    this.ignition.add(this.ignitionRing, beam);
    this.ignition.renderOrder = 4;
    this.group.add(this.ignition);

    this.buildWind();

    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(MAX_CREWS * SPRAY_PARTICLES * 3), 3),
    );
    sprayGeo.setDrawRange(0, 0);
    this.spray = new THREE.Points(
      sprayGeo,
      new THREE.PointsMaterial({
        map: this.dot,
        color: PALETTE.waterSpray,
        size: 1.6,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 5;
    this.group.add(this.spray);
    for (let i = 0; i < MAX_CREWS; i++) {
      const mist = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.dot,
          color: PALETTE.waterSpray,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      mist.visible = false;
      this.sprayMist.push(mist);
      this.group.add(mist);
    }
  }

  private buildWind() {
    const w = this.world.wind;
    const dir = new THREE.Vector2(w.toward.x, w.toward.z).normalize();
    // Upwind of the ignition, floating above the hills.
    const px = this.world.ignition.x - dir.x * 34 + dir.y * 26;
    const pz = this.world.ignition.z - dir.y * 34 - dir.x * 26;
    const clampedX = THREE.MathUtils.clamp(
      px,
      -this.world.width / 2 + 20,
      this.world.width / 2 - 20,
    );
    const clampedZ = THREE.MathUtils.clamp(
      pz,
      -this.world.depth / 2 + 16,
      this.world.depth / 2 - 16,
    );
    const y = heightAt(clampedX, clampedZ) + 22;
    this.wind.position.set(clampedX, y, clampedZ);
    this.wind.rotation.y = Math.atan2(dir.x, dir.y);
    const mat = new THREE.MeshStandardMaterial({
      color: PALETTE.ivory,
      emissive: PALETTE.ivory,
      emissiveIntensity: 0.35,
      roughness: 0.5,
      transparent: true,
      opacity: 0.92,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 20, 8), mat);
    shaft.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(1.7, 4.4, 12), mat);
    head.rotation.x = Math.PI / 2;
    head.position.z = 12.2;
    this.wind.add(shaft, head);
    for (const [x, len] of [
      [-3.6, 10],
      [3.6, 12],
    ] as const) {
      const streak = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, len, 6),
        new THREE.MeshStandardMaterial({
          color: PALETTE.ivory,
          emissive: PALETTE.ivory,
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.7,
        }),
      );
      streak.rotation.x = Math.PI / 2;
      streak.position.set(x, -0.6, -2);
      this.windStreaks.push(streak);
      this.wind.add(streak);
    }
    this.wind.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.windAnchor.set(clampedX, y + 6, clampedZ);
    this.group.add(this.wind);
  }

  setSimTime(t: number) {
    this.simT = t;
  }

  setCrews(crews: CrewState[]) {
    this.crews = crews;
  }

  tick(time: number, reducedMotion: boolean) {
    this.tickSmoke(time, reducedMotion);
    this.tickGlow(time, reducedMotion);
    this.tickIgnition(time, reducedMotion);
    this.tickWind(time, reducedMotion);
    this.tickSpray(time, reducedMotion);
  }

  /**
   * Soft, large, low-opacity puffs rising from hot spots at the head and leaning downwind
   * into a plume. Reduced motion: fewer, frozen puffs.
   */
  private tickSmoke(time: number, reducedMotion: boolean) {
    const spots = this.sampler.hotSpots.length ? this.sampler.hotSpots : this.sampler.burning;
    const toward = this.world.wind.toward;
    const active = reducedMotion ? SMOKE_COUNT_REDUCED : SMOKE_COUNT;
    for (let i = 0; i < this.smoke.length; i++) {
      const p = this.smoke[i];
      if (i >= active || spots.length === 0) {
        p.sprite.visible = false;
        p.cycle = -1;
        continue;
      }
      // Reduced motion: frozen, evenly spread ages; respawn only if the source stopped burning.
      const clock = reducedMotion ? p.offset : time + p.offset;
      const cycle = Math.floor(clock / SMOKE_LIFE);
      const age = clock - cycle * SMOKE_LIFE;
      if (cycle !== p.cycle || (reducedMotion && !this.stillBurning(p.origin))) {
        p.cycle = cycle;
        // Favour the strongest spots (list is sorted by score).
        const pick = Math.pow(hash2(i * 3.1, cycle * 1.7), 1.6);
        const src = spots[Math.min(spots.length - 1, Math.floor(pick * spots.length))];
        p.origin.set(src.x, src.y, src.z);
      }
      const u = age / SMOKE_LIFE;
      // Accelerating downwind lean as the puff rises.
      const drift = age * 4 + age * age * 0.32;
      const sway = Math.sin(i * 2.3 + age * 0.5) * (2 + u * 6);
      p.sprite.position.set(
        p.origin.x + toward.x * drift - toward.z * sway,
        p.origin.y + 5 + age * 3 - u * u * 6,
        p.origin.z + toward.z * drift + toward.x * sway,
      );
      p.sprite.scale.setScalar(14 + u * 46);
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 0.8);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.3 * env * (0.75 + p.shade * 0.5);
      p.sprite.visible = true;
    }
  }

  private stillBurning(o: THREE.Vector3): boolean {
    const f = this.fire;
    const c = Math.floor((o.x - f.originX) / f.cellSize);
    const r = Math.floor((o.z - f.originZ) / f.cellSize);
    if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return false;
    const age = this.simT - f.ignitionTime[r * f.cols + c];
    return age >= 0 && age < f.burnDuration;
  }

  /**
   * Additive flame glow on hot spots (burning cells weighted to the head). Size, intensity,
   * position jitter and flicker phase/rate vary per cell, so the glow pools at the head and
   * thins out along the flanks instead of outlining the burn.
   */
  private tickGlow(time: number, reducedMotion: boolean) {
    const spots = this.sampler.hotSpots;
    const cs = this.fire.cellSize;
    for (let i = 0; i < this.glows.length; i++) {
      const s = this.glows[i];
      const spot = spots[i];
      if (!spot) {
        s.visible = false;
        continue;
      }
      const h1 = hash2(spot.i * 0.37, 1.3);
      const h2 = hash2(spot.i * 0.73, 8.1);
      const h3 = hash2(spot.i * 1.19, 3.7);
      const rate = 4 + h2 * 6;
      const flick = reducedMotion
        ? 0.8
        : 0.6 +
          0.4 * Math.sin(time * rate + h1 * 6.28) * Math.sin(time * (rate * 0.43) + h3 * 6.28);
      s.position.set(
        spot.x + (h1 - 0.5) * cs * 0.8,
        spot.y + 1.6 + h3 * 1.6,
        spot.z + (h2 - 0.5) * cs * 0.8,
      );
      s.scale.setScalar(cs * (1.1 + h3 * 1.7) * (0.6 + 0.4 * spot.weight));
      (s.material as THREE.SpriteMaterial).opacity = 0.5 * flick * spot.weight * (0.55 + 0.45 * h2);
      s.visible = true;
    }
  }

  private tickIgnition(time: number, reducedMotion: boolean) {
    // Visible at the very start of the run, fading out by 10 s of simulation time.
    const fade = 1 - THREE.MathUtils.smoothstep(this.simT, 6, 10);
    this.ignition.visible = fade > 0.01;
    if (!this.ignition.visible) return;
    const phase = reducedMotion ? 0.3 : (time * 0.7) % 1;
    this.ignitionRing.scale.setScalar(1 + phase * 1.6);
    (this.ignitionRing.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - phase) * fade;
    const beam = this.ignition.children[1] as THREE.Mesh;
    (beam.material as THREE.MeshBasicMaterial).opacity = 0.3 * fade;
  }

  private tickWind(time: number, reducedMotion: boolean) {
    if (reducedMotion) {
      this.wind.position.y = this.windAnchor.y - 6;
      return;
    }
    this.wind.position.y = this.windAnchor.y - 6 + Math.sin(time * 0.9) * 0.6;
    this.windStreaks.forEach((s, i) => {
      const phase = (time * 0.45 + i * 0.5) % 1;
      s.position.z = -6 + phase * 10;
      (s.material as THREE.MeshStandardMaterial).opacity = 0.75 * Math.sin(Math.PI * phase);
    });
  }

  private tickSpray(time: number, reducedMotion: boolean) {
    const attr = this.spray.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let n = 0;
    let crewIndex = 0;
    for (const crew of this.crews) {
      if (!crew.spraying || crewIndex >= MAX_CREWS) continue;
      const y0 = this.surfaceHeight(crew.from.x, crew.from.z) + 3.4;
      const y1 = heightAt(crew.target.x, crew.target.z) + 0.6;
      const dist = Math.hypot(crew.target.x - crew.from.x, crew.target.z - crew.from.z);
      const apex = Math.max(y0, y1) + Math.min(14, 2 + dist * 0.28);
      for (let k = 0; k < SPRAY_PARTICLES; k++) {
        const u = reducedMotion ? k / SPRAY_PARTICLES : (k / SPRAY_PARTICLES + time * 0.9) % 1;
        const jitter = (hash2(k, crewIndex) - 0.5) * 0.9 * u;
        // Quadratic Bézier from nozzle over the apex to the aim point.
        const a = (1 - u) * (1 - u);
        const b = 2 * u * (1 - u);
        const c = u * u;
        const mx = (crew.from.x + crew.target.x) / 2;
        const mz = (crew.from.z + crew.target.z) / 2;
        arr[n * 3] = a * crew.from.x + b * mx + c * crew.target.x + jitter;
        arr[n * 3 + 1] = a * y0 + b * (2 * apex - (y0 + y1) / 2) + c * y1;
        arr[n * 3 + 2] = a * crew.from.z + b * mz + c * crew.target.z - jitter;
        n++;
      }
      const mist = this.sprayMist[crewIndex];
      mist.visible = true;
      mist.position.set(crew.target.x, y1 + 1.5, crew.target.z);
      const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 2.4 + crewIndex);
      mist.scale.setScalar(7 + pulse * 3);
      (mist.material as THREE.SpriteMaterial).opacity = 0.28 + pulse * 0.12;
      crewIndex++;
    }
    for (let i = crewIndex; i < this.sprayMist.length; i++) this.sprayMist[i].visible = false;
    attr.needsUpdate = true;
    this.spray.geometry.setDrawRange(0, n);
    this.spray.visible = n > 0;
  }

  dispose() {
    this.dot.dispose();
    this.puff.dispose();
  }
}
