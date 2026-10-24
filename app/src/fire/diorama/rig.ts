import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ViewInsets } from "./types";

const FOV = 30;
const DEG = Math.PI / 180;
/** Default composition: gently tilted 3/4 view from the south-southeast. */
const DEFAULT_POLAR = 50 * DEG;
const DEFAULT_AZIMUTH = 18 * DEG;
const POLAR_RANGE: [number, number] = [18 * DEG, 68 * DEG];
const AZIMUTH_SWING = 60 * DEG;
const IDLE_DELAY_MS = 4000;
const DRIFT_AMPLITUDE = 3 * DEG;
const RESET_DURATION_S = 1.4;
/** Overlay insets may cover at most this fraction of each viewport dimension. */
const MAX_INSET_FRACTION = 0.78;
/** Closest zoom as a fraction of the whole-board fit distance (areas are km wide). */
const MIN_DISTANCE_FRACTION = 0.05;
const MAX_DISTANCE_FRACTION = 1.45;
/** Orbit target may pan this far toward the board edge (fraction of the half-size). */
const PAN_LIMIT = 0.95;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Points to keep in view and the orbit target that composes them. */
export type Framing = { points: THREE.Vector3[]; target: THREE.Vector3 };

/**
 * Perspective camera + restrained OrbitControls, overlay-aware framing (`setViewOffset` so the
 * composition centre sits in the free rectangle), animated resets and an idle drift.
 * Adapted from the /diorama camera rig for a board of variable relief and a burn focus.
 */
export class FireCameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private board: Framing = { points: [new THREE.Vector3(-300, 0, -300), new THREE.Vector3(300, 0, 300)], target: new THREE.Vector3() };
  private half = { x: 300, z: 300 };
  private focus: Framing | null = null;
  private boardDistance = 1500;
  private viewport = { w: 16, h: 9 };
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private rawInsets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** True while the camera sits at (or animates to) a composed view, so refits follow it. */
  private atComposed = true;
  private interacting = false;
  private lastInteraction = 0;
  private driftAngle = 0;
  private driftRamp = 0;
  private reset: { from: THREE.Spherical; fromTarget: THREE.Vector3; to: THREE.Spherical; toTarget: THREE.Vector3; t: number } | null = null;
  private readonly onStart = () => {
    this.interacting = true;
    this.atComposed = false;
    this.reset = null;
    this.controls.enabled = true;
    this.driftRamp = 0;
    this.driftAngle = 0;
    this.lastInteraction = performance.now();
  };
  private readonly onEnd = () => {
    this.interacting = false;
    this.lastInteraction = performance.now();
  };

  constructor(domElement: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 2, 8000);
    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = false;
    this.controls.minPolarAngle = POLAR_RANGE[0];
    this.controls.maxPolarAngle = POLAR_RANGE[1];
    this.controls.minAzimuthAngle = DEFAULT_AZIMUTH - AZIMUTH_SWING;
    this.controls.maxAzimuthAngle = DEFAULT_AZIMUTH + AZIMUTH_SWING;
    this.controls.keys = { LEFT: "ArrowLeft", UP: "ArrowUp", RIGHT: "ArrowRight", BOTTOM: "ArrowDown" };
    this.controls.keyPanSpeed = 28;
    this.controls.listenToKeyEvents(domElement);
    this.controls.addEventListener("start", this.onStart);
    this.controls.addEventListener("end", this.onEnd);
    this.refit();
    this.snapTo(this.board);
  }

  /** New board extents (half sizes) and the points that frame it. */
  setBoard(halfX: number, halfZ: number, framing: Framing) {
    this.half = { x: halfX, z: halfZ };
    this.board = framing;
    this.focus = null;
    this.refit();
  }

  /** Viewport size in CSS px (call on resize). */
  setViewport(w: number, h: number) {
    this.viewport = { w: Math.max(1, w), h: Math.max(1, h) };
    this.refit();
  }

  setInsets(insets: ViewInsets) {
    this.rawInsets = { ...insets };
    this.refit();
  }

  /** Effective (clamped) overlay insets, CSS px. */
  get viewInsets(): ViewInsets {
    return this.insets;
  }

  /** Centre of the unobscured rectangle, CSS px. */
  freeCentre(): { x: number; y: number } {
    const { w, h } = this.viewport;
    const ins = this.insets;
    return { x: ins.left + (w - ins.left - ins.right) / 2, y: ins.top + (h - ins.top - ins.bottom) / 2 };
  }

  /**
   * Smallest distance at which all `framing.points` fit the free part of the viewport at the
   * default angles, looking at `framing.target`.
   */
  private computeFit(framing: Framing, lo: number): number {
    const { w, h } = this.viewport;
    const ins = this.insets;
    const freeW = w - ins.left - ins.right;
    const freeH = h - ins.top - ins.bottom;
    const portrait = Math.max(0, 1 - freeW / freeH);
    const mx = freeW * (0.03 - Math.min(0.14, portrait * 0.2));
    const my = freeH * 0.04;
    const probe = this.camera.clone();
    probe.near = 0.1;
    probe.far = 50000;
    probe.updateProjectionMatrix();
    const v = new THREE.Vector3();
    const s = new THREE.Spherical();
    const fits = (d: number) => {
      probe.position.setFromSpherical(s.set(d, DEFAULT_POLAR, DEFAULT_AZIMUTH)).add(framing.target);
      probe.lookAt(framing.target);
      probe.updateMatrixWorld();
      for (const p of framing.points) {
        v.copy(p).project(probe);
        if (v.z > 1) return false;
        const px = ((v.x + 1) / 2) * w;
        const py = ((1 - v.y) / 2) * h;
        if (px < ins.left + mx || px > w - ins.right - mx || py < ins.top + my || py > h - ins.bottom - my) return false;
      }
      return true;
    };
    let a = lo;
    let b = 12000;
    for (let i = 0; i < 32; i++) {
      const mid = (a + b) / 2;
      if (fits(mid)) b = mid;
      else a = mid;
    }
    return b;
  }

  private refit() {
    const { w, h } = this.viewport;
    const raw = this.rawInsets;
    const clampPair = (a: number, b: number, total: number): [number, number] => {
      const x = Number.isFinite(a) ? Math.max(0, a) : 0;
      const y = Number.isFinite(b) ? Math.max(0, b) : 0;
      const max = total * MAX_INSET_FRACTION;
      const k = x + y > max ? max / (x + y) : 1;
      return [x * k, y * k];
    };
    const [left, right] = clampPair(raw.left, raw.right, w);
    const [top, bottom] = clampPair(raw.top, raw.bottom, h);
    this.insets = { top, right, bottom, left };
    const c = this.freeCentre();
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, -(c.x - w / 2), -(c.y - h / 2), w, h);
    this.camera.updateProjectionMatrix();
    this.boardDistance = this.computeFit(this.board, 50);
    this.controls.minDistance = this.boardDistance * MIN_DISTANCE_FRACTION;
    this.controls.maxDistance = this.boardDistance * MAX_DISTANCE_FRACTION;
    this.camera.far = this.boardDistance * 4;
    this.camera.updateProjectionMatrix();
    const composed = this.focus ?? this.board;
    if (this.reset) {
      this.reset.to = this.spherical(composed);
      this.reset.toTarget.copy(composed.target);
    } else if (this.atComposed) this.snapTo(composed);
  }

  private spherical(framing: Framing) {
    const d = framing === this.board ? this.boardDistance : Math.max(this.controls.minDistance, this.computeFit(framing, 5));
    return new THREE.Spherical(Math.min(d, this.controls.maxDistance), DEFAULT_POLAR, DEFAULT_AZIMUTH);
  }

  private snapTo(framing: Framing) {
    this.controls.target.copy(framing.target);
    this.camera.position.setFromSpherical(this.spherical(framing)).add(framing.target);
    this.camera.lookAt(framing.target);
    this.controls.update();
  }

  /** Animate (or jump, with `instant`) to the whole board, or to `focus` when given. */
  resetView(focus: Framing | null, instant: boolean) {
    this.focus = focus;
    this.atComposed = true;
    this.driftAngle = 0;
    this.driftRamp = 0;
    const framing = focus ?? this.board;
    if (instant) {
      this.reset = null;
      this.controls.enabled = true;
      this.snapTo(framing);
      return;
    }
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const to = this.spherical(framing);
    while (to.theta - from.theta > Math.PI) to.theta -= Math.PI * 2;
    while (from.theta - to.theta > Math.PI) to.theta += Math.PI * 2;
    this.reset = { from, fromTarget: this.controls.target.clone(), to, toTarget: framing.target.clone(), t: 0 };
    this.controls.enabled = false;
  }

  /** Keyboard zoom: scales the orbit distance by `factor` within the zoom clamps. */
  zoomBy(factor: number) {
    if (this.reset) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(d);
    this.camera.position.copy(this.controls.target).add(offset);
    this.atComposed = false;
    this.lastInteraction = performance.now();
    this.controls.update();
  }

  /** Distance that frames the whole board at the default angles. */
  get fitDistance(): number {
    return this.boardDistance;
  }

  distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  tick(dt: number, now: number, reducedMotion: boolean) {
    if (this.reset) {
      const r = this.reset;
      r.t = Math.min(1, r.t + dt / RESET_DURATION_S);
      const e = easeInOutCubic(r.t);
      const s = new THREE.Spherical(
        THREE.MathUtils.lerp(r.from.radius, r.to.radius, e),
        THREE.MathUtils.lerp(r.from.phi, r.to.phi, e),
        THREE.MathUtils.lerp(r.from.theta, r.to.theta, e),
      );
      this.controls.target.lerpVectors(r.fromTarget, r.toTarget, e);
      this.camera.position.setFromSpherical(s).add(this.controls.target);
      this.camera.lookAt(this.controls.target);
      if (r.t >= 1) {
        this.reset = null;
        this.controls.enabled = true;
        this.lastInteraction = now;
        this.controls.update();
      }
    } else {
      this.controls.update();
      this.clampTarget();
      const idle = !reducedMotion && !this.interacting && now - this.lastInteraction > IDLE_DELAY_MS;
      if (idle) {
        this.driftRamp = Math.min(1, this.driftRamp + dt / 4);
        const angle = this.driftRamp * DRIFT_AMPLITUDE * Math.sin(now * 0.00012);
        const delta = angle - this.driftAngle;
        this.driftAngle = angle;
        if (delta !== 0) {
          const offset = this.camera.position.clone().sub(this.controls.target);
          offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), delta);
          this.camera.position.copy(this.controls.target).add(offset);
          this.camera.lookAt(this.controls.target);
        }
      } else {
        this.driftRamp = 0;
        this.driftAngle = 0;
      }
    }
    // Keep depth precision when zoomed in close.
    const near = Math.max(0.5, this.distance() * 0.02);
    if (Math.abs(near - this.camera.near) > near * 0.1) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Keeps the orbit target over the board (pan clamp). */
  private clampTarget() {
    const t = this.controls.target;
    const hx = this.half.x * PAN_LIMIT;
    const hz = this.half.z * PAN_LIMIT;
    const cx = THREE.MathUtils.clamp(t.x, -hx, hx);
    const cz = THREE.MathUtils.clamp(t.z, -hz, hz);
    const dx = cx - t.x;
    const dz = cz - t.z;
    if (dx !== 0 || dz !== 0) {
      t.set(cx, t.y, cz);
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
  }

  dispose() {
    this.controls.removeEventListener("start", this.onStart);
    this.controls.removeEventListener("end", this.onEnd);
    this.controls.stopListenToKeyEvents();
    this.controls.dispose();
  }
}
