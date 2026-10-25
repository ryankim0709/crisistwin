import * as THREE from "three";
import { hash2, softDotTexture } from "../../diorama/scene/geometry";
import { PALETTE } from "../../diorama/scene/palette";
import type { BoardFrame } from "./board";

/** Sprite budget: glow + smoke together stay at or under 30. */
const GLOW_COUNT = 14;
const SMOKE_COUNT = 16;
const SMOKE_COUNT_REDUCED = 6;
const SMOKE_LIFE = 12;
/** Burning cells inspected per update (stride-sampled from the burning band). */
const SAMPLE_BUDGET = 480;
/** On-screen height of the ignition pin (CSS px); markers keep a constant screen size. */
const PIN_SCREEN_PX = 34;
/** Pin model height in marker units (stem + head). */
const PIN_UNITS = 13.3;
/** Wind glyph height above the local high ground, in marker units. */
const WIND_LIFT = 13;
/** Re-pick hot spots only when model time moves at least this much (minutes). */
const RESAMPLE_MINUTES = 0.5;

/**
 * Minutes a cell stays "burning" on screen: at least `minWindow` and two model steps, and
 * at least twice the time the front takes to cross one cell (median arrival difference of
 * neighbouring burned cells), so coarse cells and long steps still show a readable active
 * band. Capped at a quarter of the horizon.
 */
export function burnWindowMinutes(
  cols: number,
  rows: number,
  arrival: Float32Array,
  horizon: number,
  stepMinutes: number,
  minWindow: number,
): number {
  const base = Math.max(minWindow, 2 * stepMinutes);
  const stride = Math.max(1, Math.floor(Math.sqrt((cols * rows) / 20000)));
  const diffs: number[] = [];
  for (let r = 0; r < rows; r += stride) {
    for (let c = 0; c < cols - 1; c += stride) {
      const a = arrival[r * cols + c];
      const b = arrival[r * cols + c + 1];
      if (!(a <= horizon && b <= horizon)) continue;
      const d = Math.abs(a - b);
      if (d > 0) diffs.push(d);
    }
  }
  if (diffs.length < 8) return base;
  diffs.sort((x, y) => x - y);
  const crossing = diffs[diffs.length >> 1];
  return Math.min(Math.max(base, 2 * crossing), Math.max(base, horizon * 0.25));
}

export type HotSpot = { i: number; x: number; y: number; z: number; weight: number };

/**
 * Finds the burning band at time t cheaply: cells are pre-sorted by arrival, so the band
 * `t − window < arrival ≤ t` is a binary-searched slice. Hot spots weight fresh cells at the
 * downwind head and carry the glow and smoke.
 */
export class FireSampler {
  private frame: BoardFrame | null = null;
  private order = new Int32Array(0);
  private sorted = new Float32Array(0);
  private window = 20;
  private toward = { x: 0, z: 1 };
  private lastT = Number.NaN;
  /** Arrival per cell of the current run (freshness of a burning cell). */
  private arrival: Float32Array | null = null;
  /** Opt-in per-cell states (board.ts CELL_STATE): hot spots then come from the burning cells only. */
  private states: Uint8Array | null = null;
  hotSpots: HotSpot[] = [];
  readonly headRange = { min: 0, max: 1 };
  /** Bounding box (world x/z) of everything the run burns by its horizon, or null. */
  burnBox: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  /** World units per cell of the current board (for size scaling). */
  get cellWorld() {
    return this.frame ? this.frame.cellWorld : 1;
  }
  /** Burning-cell count at the last update. */
  burningCount = 0;

  setRun(frame: BoardFrame, arrival: Float32Array | null, horizon: number, window: number) {
    this.frame = frame;
    this.window = window;
    this.lastT = Number.NaN;
    this.hotSpots = [];
    this.burningCount = 0;
    this.burnBox = null;
    this.arrival = arrival;
    if (!arrival) {
      this.order = new Int32Array(0);
      this.sorted = new Float32Array(0);
      return;
    }
    const ids: number[] = [];
    let minC = Infinity;
    let maxC = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;
    for (let i = 0; i < arrival.length; i++) {
      if (!(arrival[i] <= horizon)) continue;
      ids.push(i);
      const c = i % frame.cols;
      const r = (i - c) / frame.cols;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
    // Counting sort by arrival time (fine buckets over the horizon): O(n) even for ~10^6 burned
    // cells; order inside a bucket (< horizon/4096 minutes) does not matter for the band slice.
    const buckets = 4096;
    const scale = (buckets - 1) / Math.max(1e-6, horizon);
    const start = new Int32Array(buckets + 1);
    for (const i of ids)
      start[Math.min(buckets - 1, Math.max(0, Math.floor(arrival[i] * scale))) + 1]++;
    for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
    this.order = new Int32Array(ids.length);
    this.sorted = new Float32Array(ids.length);
    for (const i of ids) {
      const slot = start[Math.min(buckets - 1, Math.max(0, Math.floor(arrival[i] * scale)))]++;
      this.order[slot] = i;
      this.sorted[slot] = arrival[i];
    }
    if (ids.length) {
      const cw = frame.cellWorld;
      this.burnBox = {
        minX: (minC - frame.cols / 2) * cw,
        maxX: (maxC + 1 - frame.cols / 2) * cw,
        minZ: (minR - frame.rows / 2) * cw,
        maxZ: (maxR + 1 - frame.rows / 2) * cw,
      };
    }
  }

  setWind(towardX: number, towardZ: number) {
    this.toward = { x: towardX, z: towardZ };
    this.lastT = Number.NaN;
  }

  /** Per-cell states (null = the arrival band decides what burns); forces a resample. */
  setStates(states: Uint8Array | null) {
    this.states = states;
    this.lastT = Number.NaN;
  }

  /** First index whose arrival is greater than `v`. */
  private upper(v: number) {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Returns true when hot spots / head range changed. */
  update(t: number): boolean {
    const f = this.frame;
    if (!f) return false;
    if (Math.abs(t - this.lastT) < RESAMPLE_MINUTES) return false;
    this.lastT = t;
    const cells: { i: number; x: number; z: number; age: number; p: number }[] = [];
    let minP = Infinity;
    let maxP = -Infinity;
    const centre = { x: 0, z: 0 };
    const push = (i: number, age: number) => {
      const c = i % f.cols;
      f.cellCentre(c, (i - c) / f.cols, centre);
      const p = centre.x * this.toward.x + centre.z * this.toward.z;
      minP = Math.min(minP, p);
      maxP = Math.max(maxP, p);
      cells.push({ i, x: centre.x, z: centre.z, age, p });
    };
    const states = this.states && this.states.length === f.cols * f.rows ? this.states : null;
    if (states) {
      // Only cells burning now; a cell that has burned past the window stays a (weaker) hot spot.
      const ids: number[] = [];
      for (let i = 0; i < states.length; i++) if (states[i] === 1) ids.push(i);
      this.burningCount = ids.length;
      const step = Math.max(1, Math.floor(ids.length / SAMPLE_BUDGET));
      for (let k = 0; k < ids.length; k += step) {
        const i = ids[k];
        const age = this.arrival ? t - this.arrival[i] : 0;
        push(i, Number.isFinite(age) ? Math.min(Math.max(0, age), this.window * 0.8) : 0);
      }
    } else {
      const a = this.upper(t - this.window);
      const b = this.upper(t);
      this.burningCount = Math.max(0, b - a);
      const step = Math.max(1, Math.floor((b - a) / SAMPLE_BUDGET));
      for (let k = a; k < b; k += step) push(this.order[k], t - this.sorted[k]);
    }
    if (cells.length === 0) {
      this.hotSpots = [];
      return true;
    }
    this.headRange.min = minP;
    this.headRange.max = maxP;
    const span = Math.max(f.cellWorld * 3, maxP - minP);
    const scored: { c: (typeof cells)[number]; weight: number; score: number }[] = [];
    for (const c of cells) {
      const head = (c.p - minP) / span;
      const fresh = 1 - c.age / this.window;
      const weight =
        Math.pow(Math.max(0, fresh), 0.7) *
        (0.15 + 0.85 * THREE.MathUtils.smoothstep(head, 0.3, 1));
      const score = weight * (0.3 + 0.7 * hash2(c.i * 0.61, 4.7));
      if (score > 0.03) scored.push({ c, weight, score });
    }
    scored.sort((x, y) => y.score - x.score);
    // Spread picks out: skip spots too close to an already chosen one.
    const minGap = Math.max(4, span * 0.04);
    const picks: HotSpot[] = [];
    for (const s of scored) {
      if (picks.length >= GLOW_COUNT) break;
      if (picks.some((p) => Math.hypot(p.x - s.c.x, p.z - s.c.z) < minGap)) continue;
      picks.push({ i: s.c.i, x: s.c.x, y: f.surfaceAt(s.c.x, s.c.z), z: s.c.z, weight: s.weight });
    }
    this.hotSpots = picks;
    return true;
  }
}

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

/**
 * Flame glow and smoke over hot spots, the ignition pin and the floating wind arrow.
 * Markers keep a readable size when zoomed in (scaled with camera distance).
 */
export class FxLayer {
  readonly group = new THREE.Group();
  /** World position the wind label is pinned to. */
  readonly windAnchor = new THREE.Vector3();
  private readonly sampler: FireSampler;
  private readonly dot = softDotTexture(64);
  private readonly puff = smokeTexture();
  private readonly smoke: SmokeParticle[] = [];
  private readonly glows: THREE.Sprite[] = [];
  /** Pristine pin, never in the scene; every shown pin is a clone sharing its geometry and materials. */
  private readonly pinTemplate = new THREE.Group();
  private readonly pins: THREE.Group[] = [];
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly wind = new THREE.Group();
  private readonly streaks: THREE.Mesh[] = [];
  private toward = new THREE.Vector2(0, 1);
  private windBase = new THREE.Vector3();
  private windFrame: BoardFrame | null = null;
  private windAround = { x: 0, z: 0 };
  private markerScale = 1;
  private worldPerPixel = 1;

  constructor(sampler: FireSampler) {
    this.sampler = sampler;
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const shade = hash2(i, 7.3);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.puff,
          color: new THREE.Color(PALETTE.smoke).multiplyScalar(0.8 + shade * 0.25),
          transparent: true,
          depthWrite: false,
          opacity: 0,
        }),
      );
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

    // Ignition pin: ivory stem, coral head, pulsing ring on the ground.
    const ivory = new THREE.MeshStandardMaterial({ color: PALETTE.ivory, roughness: 0.5 });
    const coral = new THREE.MeshStandardMaterial({
      color: PALETTE.coral,
      roughness: 0.45,
      emissive: PALETTE.coral,
      emissiveIntensity: 0.35,
    });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 10, 8), ivory);
    stem.position.y = 5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.9, 16, 12), coral);
    head.position.y = 11.4;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.3, 6, 24), ivory);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 11.4;
    const ringGeo = new THREE.RingGeometry(2.6, 3.3, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.ivory,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeo, this.ringMaterial);
    ring.name = "ring";
    ring.position.y = 0.4;
    const foot = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 20).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: PALETTE.coral, toneMapped: false }),
    );
    foot.position.y = 0.3;
    for (const m of [stem, head, collar]) m.castShadow = true;
    this.pinTemplate.add(stem, head, collar, ring, foot);
    this.pinTemplate.renderOrder = 6;

    // Wind glyph: shaft + head along local +z, with two drifting streaks.
    const mat = new THREE.MeshStandardMaterial({
      color: PALETTE.ivory,
      emissive: PALETTE.ivory,
      emissiveIntensity: 0.35,
      roughness: 0.5,
      transparent: true,
      opacity: 0.94,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 26, 8), mat);
    shaft.rotation.x = Math.PI / 2;
    const arrowHead = new THREE.Mesh(new THREE.ConeGeometry(2.3, 6, 12), mat);
    arrowHead.rotation.x = Math.PI / 2;
    arrowHead.position.z = 15.8;
    this.wind.add(shaft, arrowHead);
    for (const [x, len] of [
      [-4.6, 12],
      [4.6, 15],
    ] as const) {
      const streak = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, len, 6),
        new THREE.MeshStandardMaterial({
          color: PALETTE.ivory,
          emissive: PALETTE.ivory,
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.7,
        }),
      );
      streak.rotation.x = Math.PI / 2;
      streak.position.set(x, -0.8, -2);
      this.streaks.push(streak);
      this.wind.add(streak);
    }
    this.wind.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.group.add(this.wind);
  }

  /** Places the pin (or hides it with `null`). */
  setIgnition(frame: BoardFrame, p: { x: number; z: number } | null) {
    this.setIgnitions(frame, [p]);
  }

  /**
   * One pin per point, in order; points that are null or off the board get no pin. Returns
   * each point's pin group (null when hidden) so callers can attach labels to it.
   */
  setIgnitions(
    frame: BoardFrame,
    points: readonly ({ x: number; z: number } | null)[],
  ): (THREE.Group | null)[] {
    while (this.pins.length < points.length) {
      const pin = this.pinTemplate.clone();
      pin.scale.setScalar(this.markerScale);
      this.pins.push(pin);
      this.group.add(pin);
    }
    this.pins.forEach((pin, i) => {
      const p = points[i];
      pin.visible = !!p && frame.inside(p.x, p.z);
      if (p && pin.visible) pin.position.set(p.x, frame.surfaceAt(p.x, p.z), p.z);
    });
    return points.map((_, i) => (this.pins[i].visible ? this.pins[i] : null));
  }

  /**
   * Wind glyph floats upwind of the ignition (or of the board centre) pointing where the
   * wind blows TOWARD. `towardX/Z` is a unit vector in scene axes (north = −z).
   */
  placeWind(
    frame: BoardFrame,
    towardX: number,
    towardZ: number,
    around: { x: number; z: number } | null,
  ) {
    this.toward.set(towardX, towardZ);
    this.windFrame = frame;
    this.windAround = around ? { ...around } : { x: 0, z: 0 };
    this.wind.rotation.y = Math.atan2(towardX, towardZ);
    this.layoutWind();
  }

  /** Upwind and to the side of the ignition by a marker-scaled offset, over local high ground. */
  private layoutWind() {
    const frame = this.windFrame;
    if (!frame) return;
    const k = this.markerScale;
    const tx = this.toward.x;
    const tz = this.toward.y;
    const c = this.windAround;
    const margin = Math.min(frame.halfW, frame.halfD) * 0.1;
    const px = THREE.MathUtils.clamp(
      c.x - tx * 26 * k + tz * 14 * k,
      -frame.halfW + margin,
      frame.halfW - margin,
    );
    const pz = THREE.MathUtils.clamp(
      c.z - tz * 26 * k - tx * 14 * k,
      -frame.halfD + margin,
      frame.halfD - margin,
    );
    // Re-sample the ground only when the glyph moved noticeably (it follows zoom).
    if (Math.hypot(px - this.windBase.x, pz - this.windBase.z) > 0.5 * k || this.windBase.y === 0) {
      let ground = 0;
      const r = 8 * k;
      for (const [dx, dz] of [
        [0, 0],
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ] as const)
        ground = Math.max(ground, frame.surfaceAt(px + dx, pz + dz));
      this.windBase.set(px, ground, pz);
    }
    this.wind.position.x = this.windBase.x;
    this.wind.position.z = this.windBase.z;
    this.windAnchor.set(this.windBase.x, this.windBase.y + (WIND_LIFT + 5) * k, this.windBase.z);
  }

  get windObject() {
    return this.wind;
  }

  /** `worldPerPixel` = world units per CSS px at the orbit target. */
  tick(time: number, reducedMotion: boolean, worldPerPixel: number) {
    this.worldPerPixel = worldPerPixel;
    this.markerScale = (worldPerPixel * PIN_SCREEN_PX) / PIN_UNITS;
    for (const pin of this.pins) pin.scale.setScalar(this.markerScale);
    this.wind.scale.setScalar(this.markerScale);
    this.layoutWind();
    this.tickSmoke(time, reducedMotion);
    this.tickGlow(time, reducedMotion);
    const phase = reducedMotion ? 0.35 : (time * 0.6) % 1;
    for (const pin of this.pins) pin.getObjectByName("ring")?.scale.setScalar(1 + phase * 1.4);
    this.ringMaterial.opacity = 0.85 * (1 - phase);
    const bob = reducedMotion ? 0 : Math.sin(time * 0.9) * 0.8;
    this.wind.position.y = this.windBase.y + (WIND_LIFT + bob) * this.markerScale;
    this.windAnchor.y = this.windBase.y + (WIND_LIFT + 5) * this.markerScale;
    this.streaks.forEach((s, i) => {
      const ph = reducedMotion ? 0.5 : (time * 0.45 + i * 0.5) % 1;
      s.position.z = -8 + ph * 13;
      (s.material as THREE.MeshStandardMaterial).opacity = 0.75 * Math.sin(Math.PI * ph);
    });
  }

  /** Soft low-opacity puffs rising from hot spots and leaning downwind into a plume. */
  private tickSmoke(time: number, reducedMotion: boolean) {
    const spots = this.sampler.hotSpots;
    const active = reducedMotion ? SMOKE_COUNT_REDUCED : SMOKE_COUNT;
    const tx = this.toward.x;
    const tz = this.toward.y;
    // Bigger fires make taller, broader plumes, within limits.
    // Cell-size aware: the band's ground footprint (not its cell count) sets the plume.
    const size = THREE.MathUtils.clamp(
      Math.sqrt((this.sampler.burningCount * this.sampler.cellWorld) / 1.5) * 0.35,
      6,
      22,
    );
    for (let i = 0; i < this.smoke.length; i++) {
      const p = this.smoke[i];
      if (i >= active || spots.length === 0) {
        p.sprite.visible = false;
        p.cycle = -1;
        continue;
      }
      const clock = reducedMotion ? p.offset : time + p.offset;
      const cycle = Math.floor(clock / SMOKE_LIFE);
      const age = clock - cycle * SMOKE_LIFE;
      if (cycle !== p.cycle) {
        p.cycle = cycle;
        const pick = Math.pow(hash2(i * 3.1, cycle * 1.7), 1.6);
        const src = spots[Math.min(spots.length - 1, Math.floor(pick * spots.length))];
        p.origin.set(src.x, src.y, src.z);
      }
      const u = age / SMOKE_LIFE;
      const drift = (age * 4.5 + age * age * 0.35) * (size / 14);
      const sway = Math.sin(i * 2.3 + age * 0.5) * (2 + u * 7);
      p.sprite.position.set(
        p.origin.x + tx * drift - tz * sway,
        p.origin.y + 4 + age * 3.2 - u * u * 6,
        p.origin.z + tz * drift + tx * sway,
      );
      p.sprite.scale.setScalar(size * (0.8 + u * 3));
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 0.8);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.28 * env * (0.75 + p.shade * 0.5);
      p.sprite.visible = true;
    }
  }

  private tickGlow(time: number, reducedMotion: boolean) {
    const spots = this.sampler.hotSpots;
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
        : 0.6 + 0.4 * Math.sin(time * rate + h1 * 6.28) * Math.sin(time * rate * 0.43 + h3 * 6.28);
      s.position.set(spot.x, spot.y + 1.5 + h3 * 1.5, spot.z);
      s.scale.setScalar((5 + h3 * 7) * (0.6 + 0.4 * spot.weight));
      s.scale.setScalar(Math.max(s.scale.x, this.worldPerPixel * 8, this.sampler.cellWorld * 1.5));
      (s.material as THREE.SpriteMaterial).opacity =
        0.45 * flick * spot.weight * (0.55 + 0.45 * h2);
      s.visible = true;
    }
  }

  dispose() {
    this.dot.dispose();
    this.puff.dispose();
    // The template is outside the scene graph, so the scene's own disposal never reaches it.
    this.pinTemplate.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}
