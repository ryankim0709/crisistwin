import * as THREE from "three";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { PALETTE } from "../../diorama/scene/palette";
import { lonLatToMercator, mercatorToLonLat } from "../landscape";
import { compassPoint } from "../spread";
import {
  BASE_Y,
  BOARD_MARGIN,
  BOARD_SIZE,
  BoardFrame,
  buildArrivalTexture,
  buildGroundTextures,
  buildPlinth,
  buildTerrain,
  buildWater,
  createFireUniforms,
  emptyArrivalTexture,
  setFireXform,
  type FireUniforms,
} from "./board";
import { CoverLayer } from "./cover";
import { FireSampler, FxLayer } from "./fx";
import { LabelLayer } from "./labels";
import { FireCameraRig, type Framing } from "./rig";
import type { FireDioramaOptions, FireDioramaSceneApi, FireRun, GeoPoint, GroundClickMode, LandscapeGrid, ViewInsets } from "./types";

/** Pointer travel (CSS px) above which a press is a drag, not a click. */
const CLICK_TOLERANCE_PX = 5;
const MAX_PIXEL_RATIO = 2;
/** Distance factor per +/- key press. */
const KEY_ZOOM_STEP = 1.25;
const COMPACT_WIDTH_PX = 600;
/** Minimum flaming window (model minutes); at least two model steps otherwise. */
const MIN_BURN_WINDOW_MINUTES = 20;
/** Smallest burn focus box side (world units) so a young fire is not over-zoomed. */
const MIN_FOCUS_SIZE = 70;
/** Candidate ground lengths for the scale bar (metres). */
const SCALE_STEPS = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

function backgroundTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#f3eee4");
    g.addColorStop(0.55, "#e8dfcf");
    g.addColorStop(1, "#d6cab4");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

/** Everything built for one loaded landscape (rebuilt on `setLandscape`). */
type Board = {
  frame: BoardFrame;
  group: THREE.Group;
  terrain: THREE.Mesh;
  water: THREE.Mesh | null;
  waterUniforms: { uTime: { value: number } };
  fire: FireUniforms;
  textures: THREE.Texture[];
  cover: CoverLayer;
  framing: Framing;
  labels: CSS2DObject[];
};

/**
 * three.js miniature of the loaded LANDFIRE landscape with the model's fire arrival field
 * (docs/adr/0011). The page owns model time and calls the setters; this class owns the
 * render loop, resize handling, camera and ground picking. The container must be
 * positioned and sized by the page; the scene appends a canvas, a label layer (`fdx-`
 * classes) and a vignette, and removes them in `dispose()`.
 */
export class FireDioramaScene implements FireDioramaSceneApi {
  /** Time (ms) the last `setLandscape` took to build the board. */
  lastBuildMs = 0;
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: FireCameraRig;
  private readonly labels: LabelLayer;
  private readonly vignette: HTMLDivElement;
  private readonly sun: THREE.DirectionalLight;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly backgroundTex: THREE.CanvasTexture;
  private readonly sampler = new FireSampler();
  private readonly fx: FxLayer;
  private readonly windLabel: { obj: THREE.Object3D; el: HTMLDivElement };
  private board: Board | null = null;
  private grid: LandscapeGrid | null | undefined = undefined;
  private run: FireRun | null = null;
  private appliedRun: FireRun | null = null;
  private t = 0;
  private renderedT = Number.NaN;
  private ignition: GeoPoint | null = null;
  private wind = { from: 0, speed: 0 };
  private overlay = false;
  private clickMode: GroundClickMode = "origin";
  private reducedMotion: boolean;
  private clickCallback: ((point: GeoPoint) => void) | null = null;
  private pointerDown: { x: number; y: number; id: number } | null = null;
  private time = 0;
  private lastFrame = performance.now();
  private disposed = false;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement, options: FireDioramaOptions) {
    if (!webglAvailable()) throw new Error("WebGL 2 is not available in this browser, so the 3D fire diorama cannot be shown.");
    this.container = container;
    this.reducedMotion = options.reducedMotion;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "crosshair";
    canvas.tabIndex = 0;
    canvas.classList.add("fdx-canvas");
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-roledescription", "3D landscape");
    this.updateAria();
    container.appendChild(canvas);

    this.labels = new LabelLayer(container);
    this.vignette = document.createElement("div");
    this.vignette.setAttribute("aria-hidden", "true");
    Object.assign(this.vignette.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      background: "radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 58%, rgba(60,48,36,0.16) 100%)",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.vignette);

    this.backgroundTex = backgroundTexture();
    this.scene.background = this.backgroundTex;
    this.scene.fog = new THREE.Fog(PALETTE.haze, 1200, 4000);
    this.scene.add(new THREE.HemisphereLight(PALETTE.skyLight, PALETTE.groundLight, 2.0));
    this.sun = new THREE.DirectionalLight(PALETTE.sun, 2.8);
    this.sun.position.set(-330, 560, 170);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    const extent = (BOARD_SIZE * Math.SQRT2) / 2 + BOARD_MARGIN + 10;
    sc.left = -extent;
    sc.right = extent;
    sc.top = extent;
    sc.bottom = -extent;
    sc.near = 100;
    sc.far = 1500;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.4;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);

    this.fx = new FxLayer(this.sampler);
    this.scene.add(this.fx.group);
    this.windLabel = this.labels.add(this.scene, "fdx-wind", new THREE.Vector3(), new THREE.Vector2(0.5, 1));

    this.rig = new FireCameraRig(canvas);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("keydown", this.onKeyDown);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setLandscape(null);
    this.setWind(0, 0);
    this.renderer.setAnimationLoop(this.frame);
  }

  // ----------------------------------------------------------------------------- API

  setLandscape(grid: LandscapeGrid | null): void {
    if (this.disposed || grid === this.grid) return;
    this.grid = grid;
    const start = performance.now();
    if (this.board) this.disposeBoard(this.board);
    this.board = this.buildBoard(grid);
    this.scene.add(this.board.group);
    this.rig.setBoard(this.board.frame.halfW, this.board.frame.halfD, this.board.framing);
    this.appliedRun = null;
    this.applyRun();
    this.placeMarkers();
    this.setFuelOverlay(this.overlay, true);
    this.lastBuildMs = performance.now() - start;
  }

  setRun(run: FireRun | null): void {
    if (this.disposed || run === this.run) return;
    this.run = run;
    this.applyRun();
  }

  setTime(minutes: number): void {
    if (this.disposed || !Number.isFinite(minutes)) return;
    this.t = minutes;
    this.applyTime();
  }

  setIgnition(point: GeoPoint | null): void {
    if (this.disposed) return;
    if (point === this.ignition || (point && this.ignition && point.latitude === this.ignition.latitude && point.longitude === this.ignition.longitude)) return;
    this.ignition = point;
    this.placeMarkers();
  }

  setWind(fromDegrees: number, speedMph: number): void {
    if (this.disposed) return;
    if (this.windLabel.el.textContent && fromDegrees === this.wind.from && speedMph === this.wind.speed) return;
    this.wind = { from: fromDegrees, speed: speedMph };
    this.windLabel.el.textContent = `Wind ${Math.round(speedMph)} mph from ${compassPoint(fromDegrees)}`;
    this.placeMarkers();
  }

  setFuelOverlay(visible: boolean, force = false): void {
    if (this.disposed || (visible === this.overlay && !force)) return;
    this.overlay = visible;
    if (this.board) this.board.fire.uOverlay.value = visible && this.board.frame.grid ? 1 : 0;
  }

  setClickMode(mode: GroundClickMode): void {
    this.clickMode = mode;
    this.updateAria();
  }

  onGroundClick(cb: (point: GeoPoint) => void): void {
    this.clickCallback = cb;
  }

  setViewInsets(insets: ViewInsets): void {
    if (this.disposed) return;
    this.rig.setInsets(insets);
  }

  resetView(focusFire = false): void {
    if (this.disposed) return;
    this.rig.resetView(focusFire ? this.burnFraming() : null, this.reducedMotion);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("keydown", this.onKeyDown);
    if (this.board) this.disposeBoard(this.board);
    this.board = null;
    this.rig.dispose();
    this.labels.dispose();
    this.fx.dispose();
    disposeTree(this.scene);
    this.backgroundTex.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.vignette.remove();
    this.clickCallback = null;
  }

  // ----------------------------------------------------------------------------- board

  private buildBoard(grid: LandscapeGrid | null): Board {
    const frame = new BoardFrame(grid);
    const group = new THREE.Group();
    group.name = "board";
    const { ground, overlay } = buildGroundTextures(frame);
    const fire = createFireUniforms(frame, overlay);
    const terrain = buildTerrain(frame, ground, fire);
    group.add(terrain, buildPlinth(frame));
    const water = buildWater(frame);
    if (water.mesh) group.add(water.mesh);
    const cover = new CoverLayer(frame);
    group.add(cover.group);
    const labels: CSS2DObject[] = [];
    if (grid) this.buildMapFurniture(frame, group, labels);

    const points: THREE.Vector3[] = [];
    for (const x of [-frame.halfW, 0, frame.halfW]) {
      for (const z of [-frame.halfD, frame.halfD]) {
        points.push(new THREE.Vector3(x, BASE_Y - 3, z), new THREE.Vector3(x, frame.heightAt(x, z) + 6, z));
      }
    }
    for (const z of [-frame.halfD, frame.halfD]) points.push(new THREE.Vector3(0, BASE_Y - 3, z + Math.sign(z) * BOARD_MARGIN));
    const framing: Framing = { points, target: new THREE.Vector3(0, frame.maxHeight * 0.3, 0) };
    return { frame, group, terrain, water: water.mesh, waterUniforms: water.uniforms, fire, textures: [ground, overlay], cover, framing, labels };
  }

  /** North arrow and scale bar on the base board rim, each with a small label. */
  private buildMapFurniture(frame: BoardFrame, group: THREE.Group, labels: CSS2DObject[]) {
    const ivory = new THREE.MeshStandardMaterial({ color: PALETTE.ivory, roughness: 0.6, emissive: PALETTE.ivory, emissiveIntensity: 0.15 });
    const rimY = BASE_Y + 0.05;
    const rimZ = frame.halfD + BOARD_MARGIN / 2;

    const arrow = new THREE.Shape();
    arrow.moveTo(0, 3.4);
    arrow.lineTo(2.4, -2.4);
    arrow.lineTo(0, -1.2);
    arrow.lineTo(-2.4, -2.4);
    arrow.closePath();
    const north = new THREE.Mesh(new THREE.ShapeGeometry(arrow).rotateX(-Math.PI / 2), ivory);
    north.position.set(0, rimY + 0.02, -frame.halfD - BOARD_MARGIN / 2);
    group.add(north);
    const n = this.labels.add(group, "fdx-north", new THREE.Vector3(0, rimY + 1, -frame.halfD - BOARD_MARGIN / 2 - 3.5), new THREE.Vector2(0.5, 1));
    n.el.textContent = "N";
    labels.push(n.obj);

    if (!frame.grid) return;
    const groundWidth = frame.cols * frame.grid.groundCellSizeMeters;
    const target = groundWidth * 0.18;
    const meters = SCALE_STEPS.reduce((best, s) => (s <= target ? s : best), SCALE_STEPS[0]);
    const len = meters * frame.unitsPerMeter;
    const x0 = -frame.halfW + 6;
    const dark = new THREE.MeshStandardMaterial({ color: 0x24221f, roughness: 0.7 });
    // Alternating ivory/dark halves, like a printed scale bar.
    for (let k = 0; k < 2; k++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len / 2, 0.5, 1.6), k === 0 ? ivory : dark);
      seg.position.set(x0 + len / 4 + (k * len) / 2, rimY + 0.25, rimZ);
      group.add(seg);
    }
    const outline = new THREE.Mesh(new THREE.BoxGeometry(len + 0.6, 0.3, 2.2), ivory);
    outline.position.set(x0 + len / 2, rimY + 0.1, rimZ);
    group.add(outline);
    const s = this.labels.add(group, "fdx-scale", new THREE.Vector3(x0 + len / 2, rimY, rimZ + 1.6), new THREE.Vector2(0.5, 0));
    s.el.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    labels.push(s.obj);
  }

  private disposeBoard(board: Board) {
    for (const l of board.labels) this.labels.remove(l);
    board.group.removeFromParent();
    disposeTree(board.group);
    for (const t of board.textures) t.dispose();
    board.fire.uArrival.value.dispose();
  }

  private applyRun() {
    const board = this.board;
    if (!board) return;
    const frame = board.frame;
    const run = this.run && frame.grid && this.run.arrivalMinutes.length === frame.cols * frame.rows ? this.run : null;
    if (run === this.appliedRun && run !== null) return;
    this.appliedRun = run;
    board.fire.uArrival.value.dispose();
    if (run) {
      const horizon = run.scenario.horizonMinutes;
      const window = Math.max(MIN_BURN_WINDOW_MINUTES, 2 * run.scenario.stepMinutes);
      const { tex, factor } = buildArrivalTexture(frame, run.arrivalMinutes, horizon);
      board.fire.uArrival.value = tex;
      board.fire.uWindow.value = window;
      setFireXform(board.fire, frame, factor);
      board.cover.setArrival(run.arrivalMinutes, horizon, window);
      this.sampler.setRun(frame, run.arrivalMinutes, horizon, window);
    } else {
      board.fire.uArrival.value = emptyArrivalTexture();
      setFireXform(board.fire, frame, 1);
      board.cover.setArrival(null, 0, MIN_BURN_WINDOW_MINUTES);
      this.sampler.setRun(frame, null, 0, MIN_BURN_WINDOW_MINUTES);
    }
    this.renderedT = Number.NaN;
    this.applyTime();
  }

  private applyTime() {
    const board = this.board;
    if (!board || this.t === this.renderedT) return;
    this.renderedT = this.t;
    const t = this.appliedRun ? this.t : -1;
    board.fire.uSimT.value = t;
    board.cover.update(t);
    if (this.sampler.update(t)) board.fire.uHeadRange.value.set(this.sampler.headRange.min, this.sampler.headRange.max);
  }

  private ignitionWorld(): { x: number; z: number } | null {
    const board = this.board;
    if (!board || !this.ignition) return null;
    const [mx, my] = lonLatToMercator(this.ignition.longitude, this.ignition.latitude);
    return board.frame.fromMercator(mx, my);
  }

  private placeMarkers() {
    const board = this.board;
    if (!board) return;
    const frame = board.frame;
    const p = this.ignitionWorld();
    this.fx.setIgnition(frame, p);
    const b = THREE.MathUtils.degToRad((this.wind.from + 180) % 360);
    const tx = Math.sin(b);
    const tz = -Math.cos(b);
    this.sampler.setWind(tx, tz);
    board.fire.uWindDir.value.set(tx, tz);
    this.fx.placeWind(frame, tx, tz, p && frame.inside(p.x, p.z) ? p : null);
    const show = !!frame.grid;
    this.fx.windObject.visible = show;
    this.windLabel.obj.visible = show;
    this.windLabel.obj.position.copy(this.fx.windAnchor);
    this.renderedT = Number.NaN;
    this.applyTime();
  }

  /** Framing of the run's burned area by its horizon (null without a run). */
  private burnFraming(): Framing | null {
    const board = this.board;
    const box = this.appliedRun ? this.sampler.burnBox : null;
    if (!board || !box) return null;
    const f = board.frame;
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const hx = Math.max(MIN_FOCUS_SIZE, box.maxX - box.minX) / 2 + 10;
    const hz = Math.max(MIN_FOCUS_SIZE, box.maxZ - box.minZ) / 2 + 10;
    const points: THREE.Vector3[] = [];
    let ySum = 0;
    for (const x of [cx - hx, cx, cx + hx]) {
      for (const z of [cz - hz, cz, cz + hz]) {
        const cxl = THREE.MathUtils.clamp(x, -f.halfW, f.halfW);
        const czl = THREE.MathUtils.clamp(z, -f.halfD, f.halfD);
        const y = f.surfaceAt(cxl, czl);
        ySum += y;
        points.push(new THREE.Vector3(cxl, y, czl), new THREE.Vector3(cxl, y + 8, czl));
      }
    }
    return { points, target: new THREE.Vector3(cx, ySum / 9, cz) };
  }

  // ----------------------------------------------------------------------------- loop

  private resize() {
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.labels.setCompact(w < COMPACT_WIDTH_PX);
    this.rig.setViewport(w, h);
  }

  private readonly frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (document.hidden || this.width < 2 || this.height < 2) return;
    if (!this.reducedMotion) this.time += dt;
    const time = this.time;
    const reduced = this.reducedMotion;
    this.rig.tick(dt, now, reduced);
    const d = this.rig.distance();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 0.9;
    fog.far = d * 3.6;
    const board = this.board;
    if (board) {
      board.fire.uTime.value = time;
      board.waterUniforms.uTime.value = time;
      board.cover.flicker(time, reduced);
    }
    const worldPerPixel = (2 * d * Math.tan(THREE.MathUtils.degToRad(this.rig.camera.fov / 2))) / this.height;
    this.fx.tick(time, reduced, worldPerPixel);
    this.windLabel.obj.position.copy(this.fx.windAnchor);
    this.renderer.render(this.scene, this.rig.camera);
    this.labels.render(this.scene, this.rig.camera);
    this.labels.clip(this.rig.camera, this.width, this.height, this.rig.viewInsets);
  };

  // ----------------------------------------------------------------------------- input

  private updateAria() {
    const action = this.clickMode === "wind" ? "set the direction the wind blows from toward the view centre" : "place the ignition at the view centre";
    this.renderer.domElement.setAttribute(
      "aria-label",
      `3D miniature of the loaded fuel and terrain landscape with the simulated fire. Press Enter to ${action}; arrow keys pan, plus and minus zoom; click the ground with a pointer. Trees and houses are symbols for fuel classes, not observed objects.`,
    );
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pointerDown = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };

  private readonly onPointerCancel = () => {
    this.pointerDown = null;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || down.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.clickAt(e.clientX - rect.left, e.clientY - rect.top);
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const c = this.rig.freeCentre();
      this.clickAt(c.x, c.y);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      this.rig.zoomBy(1 / KEY_ZOOM_STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      this.rig.zoomBy(KEY_ZOOM_STEP);
    }
  };

  /** Raycasts the board at CSS px (x, y) and reports the geographic point when on it. */
  private clickAt(x: number, y: number) {
    const board = this.board;
    if (!board || !board.frame.grid || !this.clickCallback) return;
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const targets: THREE.Object3D[] = [board.terrain];
    if (board.water) targets.push(board.water);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit || !board.frame.inside(hit.point.x, hit.point.z)) return;
    const merc = board.frame.toMercator(hit.point.x, hit.point.z);
    if (!merc) return;
    const [longitude, latitude] = mercatorToLonLat(merc[0], merc[1]);
    this.clickCallback({ latitude, longitude });
  }
}

/** Disposes geometries, materials and material textures under `root`. */
function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      m.dispose();
    }
  });
  for (const t of textures) t.dispose();
}
