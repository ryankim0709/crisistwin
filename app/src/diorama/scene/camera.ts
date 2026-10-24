import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { World } from "../types";
import { heightAt } from "../world";
import { BASE_Y } from "./terrain";

const FOV = 30;
const DEG = Math.PI / 180;
/** Default composition: gently tilted 3/4 view from the south-southeast. */
const DEFAULT_POLAR = 52 * DEG;
const DEFAULT_AZIMUTH = 20 * DEG;
const POLAR_RANGE: [number, number] = [25 * DEG, 65 * DEG];
const AZIMUTH_SWING = 50 * DEG;
const TARGET_Y = 4;
const IDLE_DELAY_MS = 3500;
const DRIFT_AMPLITUDE = 3.2 * DEG;
const RESET_DURATION_S = 1.4;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Perspective camera + restrained OrbitControls, framing, reset animation and idle drift. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly world: World;
  private readonly fitPoints: THREE.Vector3[] = [];
  private readonly defaultTarget = new THREE.Vector3(0, TARGET_Y, 0);
  private fitDistance = 900;
  private atDefault = true;
  private interacting = false;
  private lastInteraction = 0;
  private driftAngle = 0;
  private driftRamp = 0;
  private reset: { from: THREE.Spherical; fromTarget: THREE.Vector3; to: THREE.Spherical; t: number } | null = null;
  private readonly onStart = () => {
    this.interacting = true;
    this.atDefault = false;
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

  constructor(world: World, domElement: HTMLElement) {
    this.world = world;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 2, 5000);
    const hw = world.width / 2;
    const hd = world.depth / 2;
    for (const x of [-hw, 0, hw]) {
      for (const z of [-hd, hd]) {
        this.fitPoints.push(new THREE.Vector3(x, BASE_Y - 3, z), new THREE.Vector3(x, heightAt(x, z) + 12, z));
      }
    }
    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.target.copy(this.defaultTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.panSpeed = 0.7;
    this.controls.screenSpacePanning = false;
    this.controls.minPolarAngle = POLAR_RANGE[0];
    this.controls.maxPolarAngle = POLAR_RANGE[1];
    this.controls.minAzimuthAngle = DEFAULT_AZIMUTH - AZIMUTH_SWING;
    this.controls.maxAzimuthAngle = DEFAULT_AZIMUTH + AZIMUTH_SWING;
    this.controls.addEventListener("start", this.onStart);
    this.controls.addEventListener("end", this.onEnd);
    this.setAspect(16 / 9);
    this.snapToDefault();
  }

  /** Smallest distance at which the whole board fits the frame at the default angles. */
  private computeFit(aspect: number): number {
    const cam = new THREE.PerspectiveCamera(FOV, aspect, 1, 10000);
    const fits = (d: number) => {
      cam.position.setFromSpherical(new THREE.Spherical(d, DEFAULT_POLAR, DEFAULT_AZIMUTH)).add(this.defaultTarget);
      cam.lookAt(this.defaultTarget);
      cam.updateMatrixWorld();
      const v = new THREE.Vector3();
      for (const p of this.fitPoints) {
        v.copy(p).project(cam);
        if (Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.9 || v.z > 1) return false;
      }
      return true;
    };
    let lo = 100;
    let hi = 8000;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.fitDistance = this.computeFit(aspect);
    this.controls.minDistance = this.fitDistance * 0.22;
    this.controls.maxDistance = this.fitDistance * 1.35;
    this.camera.near = Math.max(1, this.fitDistance * 0.01);
    this.camera.far = this.fitDistance * 4;
    this.camera.updateProjectionMatrix();
    if (this.atDefault && !this.reset) this.snapToDefault();
  }

  private defaultSpherical() {
    return new THREE.Spherical(this.fitDistance, DEFAULT_POLAR, DEFAULT_AZIMUTH);
  }

  private snapToDefault() {
    this.controls.target.copy(this.defaultTarget);
    this.camera.position.setFromSpherical(this.defaultSpherical()).add(this.defaultTarget);
    this.camera.lookAt(this.defaultTarget);
    this.controls.update();
  }

  resetView(instant: boolean) {
    this.atDefault = true;
    this.driftAngle = 0;
    this.driftRamp = 0;
    if (instant) {
      this.reset = null;
      this.controls.enabled = true;
      this.snapToDefault();
      return;
    }
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const to = this.defaultSpherical();
    // Take the short way round in azimuth.
    while (to.theta - from.theta > Math.PI) to.theta -= Math.PI * 2;
    while (from.theta - to.theta > Math.PI) to.theta += Math.PI * 2;
    this.reset = { from, fromTarget: this.controls.target.clone(), to, t: 0 };
    this.controls.enabled = false;
  }

  /** Distance from camera to orbit target (used to scale fog). */
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
      this.controls.target.lerpVectors(r.fromTarget, this.defaultTarget, e);
      this.camera.position.setFromSpherical(s).add(this.controls.target);
      this.camera.lookAt(this.controls.target);
      if (r.t >= 1) {
        this.reset = null;
        this.controls.enabled = true;
        this.lastInteraction = now;
        this.controls.update();
      }
      return;
    }

    this.controls.update();
    this.clampTarget();

    // Slow "breathing" sway around the target once the viewer has been idle for a while.
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

  /** Keeps the orbit target over the board (pan clamp) at a fixed height. */
  private clampTarget() {
    const t = this.controls.target;
    const hx = this.world.width * 0.42;
    const hz = this.world.depth * 0.42;
    const cx = THREE.MathUtils.clamp(t.x, -hx, hx);
    const cz = THREE.MathUtils.clamp(t.z, -hz, hz);
    const dx = cx - t.x;
    const dy = TARGET_Y - t.y;
    const dz = cz - t.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      t.set(cx, TARGET_Y, cz);
      this.camera.position.x += dx;
      this.camera.position.y += dy;
      this.camera.position.z += dz;
    }
  }

  dispose() {
    this.controls.removeEventListener("start", this.onStart);
    this.controls.removeEventListener("end", this.onEnd);
    this.controls.dispose();
  }
}
