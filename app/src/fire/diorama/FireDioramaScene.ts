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
  buildStateTexture,
  buildPlinth,
  buildTerrain,
  buildWater,
  createFireUniforms,
  emptyArrivalTexture,
  emptyStateTexture,
  setFireXform,
  type FireUniforms,
} from "./board";
import { CoverLayer } from "./cover";
import { FireSampler, FxLayer, burnWindowMinutes } from "./fx";
import { FuelFamily } from "./fuelStyle";
import { LabelLayer, type ClipOptions } from "./labels";
import { fetchStations, type MapStation } from "../../maps/stations";
import { StationMarkers } from "./stationMarkers";
import { REFERENCE_PLACES } from "./places";
import { ProjectedStreets, buildStreetMesh } from "./streets";
import { FireCameraRig, type Framing } from "./rig";
import type {
  BoardOverlay,
  BoardStreets,
  DioramaIgnition,
  DioramaRun,
  FireDioramaOptions,
  FireDioramaSceneApi,
  GeoPoint,
  GroundClickMode,
  LandscapeGrid,
  ViewInsets,
} from "./types";

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
const SCALE_STEPS = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
/** Screen-space footprint of the ignition pin (CSS px) that place labels keep clear of. */
const PIN_RECT_HALF_W_PX = 14;
const PIN_RECT_H_PX = 40;
const PIN_RECT_FOOT_PX = 8;
/** Height of an ignition's name pill above its pin's foot, in pin model units (head top is ~13.3). */
const PIN_LABEL_Y = 14.5;

/** Reference place labels need a board at least this wide (ground metres). */
const PLACE_LABEL_MIN_WIDTH_M = 4000;
/** Shadow map side (px): large on local boards, smaller where shadows cannot be resolved. */
const SHADOW_MAP = { local: 2048, regional: 1024 } as const;
/** A burn spanning more than this fraction of the board is framed as the whole board. */
const FOCUS_WHOLE_BOARD_FRACTION = 0.85;

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

/**
 * Software WebGL (SwiftShader in headless Chrome or with the GPU blocklisted, Mesa llvmpipe in
 * VMs). There the compositor reads every drawn frame back synchronously (GLES2 ReadPixels in
 * Commit), so a regional board blocked the page's main thread about 4 s per frame and starved
 * every fetch callback and React update (measured on /run, chrome-headless-shell, 30x30 km board).
 */
function isSoftwareWebgl(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}
/** Software WebGL: wait at least this long, and this many times the last frame's cost, between frames. */
const SOFTWARE_MIN_GAP_MS = 1000;
const SOFTWARE_GAP_FACTOR = 3;

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
  /** Road ribbons, when streets are loaded for this board. */
  streets: THREE.Mesh | null;
  framing: Framing;
  labels: CSS2DObject[];
  /** Arrival texture reduction (texels per cell side) the state texture must match. */
  fireFactor: number;
  /** Cover house positions as WGS84, built on first ask (null until then / after a cover rebuild). */
  houseGeo: GeoPoint[] | null;
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
  private run: DioramaRun | null = null;
  private appliedRun: DioramaRun | null = null;
  private t = 0;
  private renderedT = Number.NaN;
  private burnWindow = 0;
  /** Bumped when the run, ignition or wind change, so the label declutter pass reruns. */
  private labelStamp = 0;
  private ignitions: readonly DioramaIgnition[] = [];
  /** Name pills, one per labelled ignition, parented to that ignition's pin. */
  private readonly ignitionLabels: { obj: CSS2DObject; el: HTMLDivElement }[] = [];
  private wind = { from: 0, speed: 0 };
  private windVisible = true;
  private overlay = false;
  private clickMode: GroundClickMode = "origin";
  private overlayContent: BoardOverlay | null = null;
  private readonly stationMarkers = new StationMarkers();
  /** "auto" fetches the CAL FIRE stations around the board; "manual" draws what `setStations` was given. */
  private stationMode: "auto" | "manual" = "auto";
  private stationList: readonly MapStation[] = [];
  private stationSuffix = "";
  private stationAbort: AbortController | null = null;
  private coverHouses = true;
  /** Opt-in per-cell fire states (setCellStates); null = the arrival field decides. */
  private cellStates: Uint8Array | null = null;
  private streets: BoardStreets | null = null;
  private reducedMotion: boolean;
  private clickCallback: ((point: GeoPoint) => void) | null = null;
  private pointerDown: { x: number; y: number; id: number } | null = null;
  private time = 0;
  private lastFrame = performance.now();
  private disposed = false;
  private width = 1;
  private height = 1;
  /** Software WebGL: frames are throttled (see isSoftwareWebgl). */
  private readonly softwareGl: boolean;
  private softwareDrawnAt: number | null = null;
  private softwareNextAt = 0;

  constructor(container: HTMLElement, options: FireDioramaOptions) {
    if (!webglAvailable())
      throw new Error(
        "WebGL 2 is not available in this browser, so the 3D fire diorama cannot be shown.",
      );
    this.container = container;
    this.reducedMotion = options.reducedMotion;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.softwareGl = isSoftwareWebgl(this.renderer.getContext());
    // Shadows cost a second geometry pass; a software renderer skips them.
    this.renderer.shadowMap.enabled = !this.softwareGl;
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
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 58%, rgba(60,48,36,0.16) 100%)",
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
    this.windLabel = this.labels.add(
      this.scene,
      "fdx-wind",
      new THREE.Vector3(),
      new THREE.Vector2(0.5, 1),
    );

    this.rig = new FireCameraRig(canvas);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
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
    this.applyCoverHouses();
    this.overlayContent?.attach(this.board.frame, this.board.group, this.labels);
    if (this.stationMode === "auto") this.loadStations();
    else this.rebuildStations();
    this.lastBuildMs = performance.now() - start;
  }

  setRun(run: DioramaRun | null): void {
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
    this.setIgnitions(point ? [{ id: "origin", point, label: "" }] : []);
  }

  setIgnitions(ignitions: readonly DioramaIgnition[]): void {
    if (this.disposed) return;
    const same =
      ignitions.length === this.ignitions.length &&
      ignitions.every((a, i) => {
        const b = this.ignitions[i];
        return (
          a.id === b.id &&
          a.label === b.label &&
          a.point.latitude === b.point.latitude &&
          a.point.longitude === b.point.longitude
        );
      });
    if (same) return;
    this.ignitions = ignitions;
    this.placeMarkers();
  }

  setWind(fromDegrees: number, speedMph: number): void {
    if (this.disposed) return;
    if (
      this.windLabel.el.textContent &&
      fromDegrees === this.wind.from &&
      speedMph === this.wind.speed
    )
      return;
    this.wind = { from: fromDegrees, speed: speedMph };
    this.windLabel.el.textContent = `Wind ${Math.round(speedMph)} mph from ${compassPoint(fromDegrees)}`;
    this.placeMarkers();
  }

  setWindVisible(visible: boolean): void {
    if (this.disposed || visible === this.windVisible) return;
    this.windVisible = visible;
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

  setOverlay(overlay: BoardOverlay | null): void {
    if (this.disposed || overlay === this.overlayContent) return;
    if (this.board) this.overlayContent?.detach();
    this.overlayContent = overlay;
    if (this.board) overlay?.attach(this.board.frame, this.board.group, this.labels);
  }

  /** Draw these stations (instead of fetching them). `null` returns to the automatic fetch. */
  setStations(stations: readonly MapStation[] | null, suffix?: string): void {
    if (this.disposed) return;
    if (suffix !== undefined) this.stationSuffix = suffix;
    this.stationMode = stations ? "manual" : "auto";
    if (stations) {
      this.stationAbort?.abort();
      this.stationList = stations;
      this.rebuildStations();
    } else this.loadStations();
  }

  /** Text after each station name ("today's station" in the historical replay). */
  setStationSuffix(suffix: string): void {
    this.stationSuffix = suffix;
    this.rebuildStations();
  }

  private rebuildStations(): void {
    if (!this.board) return;
    this.stationMarkers.build(this.board.frame, this.board.group, this.labels, this.stationList, this.stationSuffix);
  }

  private loadStations(): void {
    this.stationAbort?.abort();
    this.stationList = [];
    this.rebuildStations();
    const grid = this.board?.frame.grid;
    if (this.stationMode !== "auto" || !grid) return;
    const ac = new AbortController();
    this.stationAbort = ac;
    const [lon, lat] = mercatorToLonLat(
      grid.originX + (this.board!.frame.cols * grid.cellSizeX) / 2,
      grid.originY + (this.board!.frame.rows * grid.cellSizeY) / 2,
    );
    void fetchStations(lon, lat, ac.signal).then((list) => {
      if (ac.signal.aborted || this.disposed || this.stationMode !== "auto") return;
      this.stationList = list;
      this.rebuildStations();
    });
  }

  setStreets(streets: BoardStreets | null): void {
    if (this.disposed || streets === this.streets) return;
    this.streets = streets;
    const board = this.board;
    if (!board || !board.frame.grid) return;
    // Rebuild only the cover and road layers; terrain, labels and camera stay.
    board.cover.group.removeFromParent();
    disposeTree(board.cover.group);
    if (board.streets) {
      board.streets.removeFromParent();
      disposeTree(board.streets);
    }
    const { cover, streets: mesh } = this.buildStreetLayers(board.frame, board.fire);
    board.cover = cover;
    board.streets = mesh;
    board.houseGeo = null;
    board.group.add(cover.group);
    if (mesh) board.group.add(mesh);
    this.applyCoverHouses();
    this.appliedRun = null;
    this.applyRun();
  }

  setCoverHouses(visible: boolean): void {
    if (this.disposed || visible === this.coverHouses) return;
    this.coverHouses = visible;
    this.applyCoverHouses();
  }

  focusOn(point: GeoPoint, radiusMeters: number): void {
    const board = this.board;
    if (this.disposed || !board || !board.frame.grid) return;
    const f = board.frame;
    const [mx, my] = lonLatToMercator(point.longitude, point.latitude);
    const c = f.fromMercator(mx, my);
    if (!c) return;
    const half = Math.max(MIN_FOCUS_SIZE / 2, radiusMeters * f.unitsPerMeter);
    const points: THREE.Vector3[] = [];
    let ySum = 0;
    const N = 3;
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const x = THREE.MathUtils.clamp(c.x - half + (a / (N - 1)) * 2 * half, -f.halfW, f.halfW);
        const z = THREE.MathUtils.clamp(c.z - half + (b / (N - 1)) * 2 * half, -f.halfD, f.halfD);
        const y = f.surfaceAt(x, z);
        ySum += y;
        points.push(new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + 6, z));
      }
    }
    this.rig.resetView(
      { points, target: new THREE.Vector3(c.x, ySum / (N * N), c.z) },
      this.reducedMotion,
    );
  }

  setCellStates(states: Uint8Array | null): void {
    if (this.disposed) return;
    const prev = this.cellStates;
    if (states === prev) return;
    if (
      states &&
      prev &&
      states.length === prev.length &&
      states.every((v, i) => v === prev[i])
    )
      return;
    this.cellStates = states ? states.slice() : null;
    this.applyStates();
  }

  houseLocations(): readonly GeoPoint[] {
    const board = this.board;
    if (!board || !board.frame.grid) return NO_HOUSES;
    if (!board.houseGeo) {
      const xz = board.cover.housePositions();
      const out: GeoPoint[] = [];
      for (let i = 0; i < xz.length; i += 2) {
        const merc = board.frame.toMercator(xz[i], xz[i + 1]);
        if (!merc) continue;
        const [longitude, latitude] = mercatorToLonLat(merc[0], merc[1]);
        out.push({ longitude, latitude });
      }
      board.houseGeo = out;
    }
    return board.houseGeo;
  }

  setHouseMarks(marks: Uint8Array | null): void {
    if (this.disposed) return;
    this.board?.cover.setHouseMarks(marks);
  }

  /** The cover layer names its house bodies and roofs; a page drawing its own homes hides them. */
  private applyCoverHouses() {
    for (const child of this.board?.cover.group.children ?? []) {
      if (child.name === "houses" || child.name === "roofs" || child.name === "house-checks")
        child.visible = this.coverHouses;
    }
  }

  /** Pushes the opt-in cell states (or their absence) to the ground shader, cover and flames. */
  private applyStates() {
    const board = this.board;
    if (!board) return;
    const frame = board.frame;
    const states =
      this.cellStates && frame.grid && this.cellStates.length === frame.cols * frame.rows
        ? this.cellStates
        : null;
    board.fire.uState.value.dispose();
    board.fire.uState.value = states
      ? buildStateTexture(frame, states, board.fireFactor)
      : emptyStateTexture();
    board.fire.uUseState.value = states ? 1 : 0;
    board.cover.setCellStates(states);
    this.sampler.setStates(states);
    this.labelStamp++;
    this.renderedT = Number.NaN;
    this.applyTime();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stationAbort?.abort();
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
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
    const textures: THREE.Texture[] = [ground, overlay];
    if (water.mask) textures.push(water.mask);
    this.setShadowQuality(frame.blockMix);
    const { cover, streets } = this.buildStreetLayers(frame, fire);
    group.add(cover.group);
    if (streets) group.add(streets);
    const labels: CSS2DObject[] = [];
    if (grid) {
      this.buildMapFurniture(frame, group, labels);
      this.buildPlaceLabels(frame, group, labels);
    }

    const points: THREE.Vector3[] = [];
    for (const x of [-frame.halfW, 0, frame.halfW]) {
      for (const z of [-frame.halfD, frame.halfD]) {
        points.push(
          new THREE.Vector3(x, BASE_Y - 3, z),
          new THREE.Vector3(x, frame.heightAt(x, z) + 6, z),
        );
      }
    }
    for (const z of [-frame.halfD, frame.halfD])
      points.push(new THREE.Vector3(0, BASE_Y - 3, z + Math.sign(z) * BOARD_MARGIN));
    const framing: Framing = { points, target: new THREE.Vector3(0, frame.maxHeight * 0.3, 0) };
    return {
      frame,
      group,
      terrain,
      water: water.mesh,
      waterUniforms: water.uniforms,
      fire,
      textures,
      cover,
      streets,
      framing,
      labels,
      fireFactor: 1,
      houseGeo: null,
    };
  }

  /** Cover (trees, bushes, houses) and, when streets are loaded, the road ribbons. */
  private buildStreetLayers(frame: BoardFrame, fire: FireUniforms) {
    const projected = frame.grid && this.streets ? new ProjectedStreets(frame, this.streets) : null;
    const streets = projected ? buildStreetMesh(frame, projected) : null;
    fire.uStreets.value = streets ? 0 : 1;
    return { cover: new CoverLayer(frame, projected), streets };
  }

  /** Scale bar on the base board rim, with a small label. */
  private buildMapFurniture(frame: BoardFrame, group: THREE.Group, labels: CSS2DObject[]) {
    if (!frame.grid) return;
    const ivory = new THREE.MeshStandardMaterial({
      color: PALETTE.ivory,
      roughness: 0.6,
      emissive: PALETTE.ivory,
      emissiveIntensity: 0.15,
    });
    const rimY = BASE_Y + 0.05;
    const rimZ = frame.halfD + BOARD_MARGIN / 2;
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
    const s = this.labels.add(
      group,
      "fdx-scale",
      new THREE.Vector3(x0 + len / 2, rimY, rimZ + 1.6),
      new THREE.Vector2(0.5, 0),
    );
    s.el.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    labels.push(s.obj);
  }

  /** Smaller shadow map on regional boards (their casters are sub-pixel and switched off). */
  private setShadowQuality(blockMix: number) {
    const size = blockMix > 0.6 ? SHADOW_MAP.regional : SHADOW_MAP.local;
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /**
   * Small reference labels (cities, peaks) for places inside the board. They come from a
   * hand-entered table (`places.ts`), not from the model or the loaded rasters.
   */
  private buildPlaceLabels(frame: BoardFrame, group: THREE.Group, labels: CSS2DObject[]) {
    const grid = frame.grid;
    if (!grid || grid.width * grid.groundCellSizeMeters < PLACE_LABEL_MIN_WIDTH_M) return;
    const ranked = [...REFERENCE_PLACES].sort((a, b) => a.rank - b.rank);
    for (const place of ranked) {
      const [mx, my] = lonLatToMercator(place.longitude, place.latitude);
      const p = frame.fromMercator(mx, my);
      if (!p) continue;
      const margin = frame.cellWorld * 2;
      if (Math.abs(p.x) > frame.halfW - margin || Math.abs(p.z) > frame.halfD - margin) continue;
      if (frame.families[frame.cellAt(p.x, p.z)] === FuelFamily.Water) continue; // never on open water
      labels.push(
        this.labels.addPlace(
          group,
          place.name,
          place.kind,
          new THREE.Vector3(p.x, frame.surfaceAt(p.x, p.z) + 1.5, p.z),
          frame.cellAt(p.x, p.z),
        ),
      );
    }
  }

  private disposeBoard(board: Board) {
    this.stationMarkers.dispose();
    this.overlayContent?.detach();
    for (const l of board.labels) this.labels.remove(l);
    board.group.removeFromParent();
    disposeTree(board.group);
    for (const t of board.textures) t.dispose();
    board.fire.uArrival.value.dispose();
    board.fire.uState.value.dispose();
  }

  private applyRun() {
    const board = this.board;
    if (!board) return;
    const frame = board.frame;
    const run =
      this.run && frame.grid && this.run.arrivalMinutes.length === frame.cols * frame.rows
        ? this.run
        : null;
    if (run === this.appliedRun && run !== null) return;
    this.appliedRun = run;
    this.labelStamp++;
    board.fire.uArrival.value.dispose();
    if (run) {
      const horizon = run.scenario.horizonMinutes;
      const window = burnWindowMinutes(
        frame.cols,
        frame.rows,
        run.arrivalMinutes,
        horizon,
        run.scenario.stepMinutes,
        MIN_BURN_WINDOW_MINUTES,
      );
      const { tex, factor } = buildArrivalTexture(frame, run.arrivalMinutes, horizon);
      board.fire.uArrival.value = tex;
      board.fire.uWindow.value = window;
      this.burnWindow = window;
      setFireXform(board.fire, frame, factor);
      board.fireFactor = factor;
      board.cover.setArrival(run.arrivalMinutes, horizon, window);
      this.sampler.setRun(frame, run.arrivalMinutes, horizon, window);
    } else {
      board.fire.uArrival.value = emptyArrivalTexture();
      setFireXform(board.fire, frame, 1);
      board.fireFactor = 1;
      board.cover.setArrival(null, 0, MIN_BURN_WINDOW_MINUTES);
      this.sampler.setRun(frame, null, 0, MIN_BURN_WINDOW_MINUTES);
    }
    // Re-applies the opt-in states on the new texel layout, then the time.
    this.applyStates();
  }

  private applyTime() {
    const board = this.board;
    if (!board || this.t === this.renderedT) return;
    this.renderedT = this.t;
    const t = this.appliedRun ? this.t : -1;
    board.fire.uSimT.value = t;
    board.cover.update(t);
    if (this.sampler.update(t))
      board.fire.uHeadRange.value.set(this.sampler.headRange.min, this.sampler.headRange.max);
  }

  /** Board positions of the ignitions, in order (null when off the board). */
  private ignitionWorlds(): ({ x: number; z: number } | null)[] {
    const board = this.board;
    if (!board) return [];
    return this.ignitions.map(({ point }) => {
      const [mx, my] = lonLatToMercator(point.longitude, point.latitude);
      return board.frame.fromMercator(mx, my);
    });
  }

  private placeMarkers() {
    const board = this.board;
    if (!board) return;
    const frame = board.frame;
    const worlds = this.ignitionWorlds();
    const p = worlds[0] ?? null;
    const pins = this.fx.setIgnitions(frame, worlds);
    this.placeIgnitionLabels(pins);
    const b = THREE.MathUtils.degToRad((this.wind.from + 180) % 360);
    const tx = Math.sin(b);
    const tz = -Math.cos(b);
    this.sampler.setWind(tx, tz);
    board.fire.uWindDir.value.set(tx, tz);
    this.fx.placeWind(frame, tx, tz, p && frame.inside(p.x, p.z) ? p : null);
    const show = !!frame.grid && this.windVisible;
    this.fx.windObject.visible = show;
    this.windLabel.obj.visible = show;
    this.windLabel.obj.position.copy(this.fx.windAnchor);
    this.labelStamp++;
    this.renderedT = Number.NaN;
    this.applyTime();
  }

  /** Name pills above each labelled pin; they scale with the pin, so they track it on zoom. */
  private placeIgnitionLabels(pins: (THREE.Object3D | null)[]) {
    let used = 0;
    this.ignitions.forEach((ignition, i) => {
      const pin = pins[i];
      if (!pin || !ignition.label) return;
      let label = this.ignitionLabels[used];
      if (!label) {
        label = this.labels.add(
          pin,
          "fdx-ignition",
          new THREE.Vector3(0, PIN_LABEL_Y, 0),
          new THREE.Vector2(0.5, 1),
        );
        this.ignitionLabels.push(label);
      } else if (label.obj.parent !== pin) {
        pin.add(label.obj);
      }
      label.el.textContent = ignition.label;
      label.obj.visible = true;
      used++;
    });
    for (const label of this.ignitionLabels.slice(used)) label.obj.visible = false;
    this.labels.invalidate();
  }

  /** Framing of the run's burned area by its horizon (null without a run). */
  private burnFraming(): Framing | null {
    const board = this.board;
    const box = this.appliedRun ? this.sampler.burnBox : null;
    if (!board || !box) return null;
    const f = board.frame;
    if (
      (box.maxX - box.minX) / (2 * f.halfW) > FOCUS_WHOLE_BOARD_FRACTION &&
      (box.maxZ - box.minZ) / (2 * f.halfD) > FOCUS_WHOLE_BOARD_FRACTION
    )
      return null;
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const pad = Math.max(10, 0.06 * Math.max(box.maxX - box.minX, box.maxZ - box.minZ));
    const hx = Math.max(MIN_FOCUS_SIZE, box.maxX - box.minX) / 2 + pad;
    const hz = Math.max(MIN_FOCUS_SIZE, box.maxZ - box.minZ) / 2 + pad;
    const points: THREE.Vector3[] = [];
    let ySum = 0;
    // 5×5 samples so a big burn's relief (ridges inside the box) stays in frame.
    const N = 5;
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const cxl = THREE.MathUtils.clamp(cx - hx + (a / (N - 1)) * 2 * hx, -f.halfW, f.halfW);
        const czl = THREE.MathUtils.clamp(cz - hz + (b / (N - 1)) * 2 * hz, -f.halfD, f.halfD);
        const y = f.surfaceAt(cxl, czl);
        ySum += y;
        points.push(new THREE.Vector3(cxl, y, czl), new THREE.Vector3(cxl, y + 8, czl));
      }
    }
    return { points, target: new THREE.Vector3(cx, ySum / (N * N), cz) };
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
    if (this.softwareGl) {
      // The first callback after a drawn frame comes once its readback finished: that gap is the frame's cost.
      if (this.softwareDrawnAt !== null) {
        const cost = now - this.softwareDrawnAt;
        this.softwareNextAt = now + Math.max(SOFTWARE_MIN_GAP_MS, cost * SOFTWARE_GAP_FACTOR);
        this.softwareDrawnAt = null;
      }
      if (now < this.softwareNextAt) return;
      this.softwareDrawnAt = now;
    }
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
    const worldPerPixel =
      (2 * d * Math.tan(THREE.MathUtils.degToRad(this.rig.camera.fov / 2))) / this.height;
    this.fx.tick(time, reduced, worldPerPixel);
    this.overlayContent?.tick(time, dt, reduced, this.width, this.height, {
      camera: this.rig.camera,
      distance: d,
      fit: this.rig.fitDistance,
    });
    this.windLabel.obj.position.copy(this.fx.windAnchor);
    this.stationMarkers.tick(d, this.rig.fitDistance);
    this.renderer.render(this.scene, this.rig.camera);
    this.labels.render(this.scene, this.rig.camera);
    this.labels.clip(
      this.rig.camera,
      this.width,
      this.height,
      this.rig.viewInsets,
      this.labelOptions(),
    );
  };

  private readonly pinTmp = new THREE.Vector3();

  /** Higher-priority rects and the burning test that place labels must yield to. */
  private labelOptions(): ClipOptions {
    const board = this.board;
    const opts: ClipOptions = { stamp: this.labelStamp, time: this.t };
    if (!board) return opts;
    opts.fixed = [];
    for (const p of this.ignitionWorlds()) {
      if (!p || !board.frame.inside(p.x, p.z)) continue;
      this.pinTmp.set(p.x, board.frame.surfaceAt(p.x, p.z), p.z).project(this.rig.camera);
      const x = ((this.pinTmp.x + 1) / 2) * this.width;
      const y = ((1 - this.pinTmp.y) / 2) * this.height;
      opts.fixed.push({
        left: x - PIN_RECT_HALF_W_PX,
        right: x + PIN_RECT_HALF_W_PX,
        top: y - PIN_RECT_H_PX,
        bottom: y + PIN_RECT_FOOT_PX,
      });
    }
    const run = this.appliedRun;
    if (run) {
      const arrival = run.arrivalMinutes;
      const { cols, rows } = board.frame;
      const window = this.burnWindow;
      const t = this.t;
      const states =
        this.cellStates && this.cellStates.length === cols * rows ? this.cellStates : null;
      // A cell counts as burning from its arrival until it has burned for `window` minutes (or
      // while its opt-in state is burning); a 3x3 neighbourhood keeps a label clear of the front's edge.
      opts.isBurning = (cell) => {
        const c0 = cell % cols;
        const r0 = Math.floor(cell / cols);
        for (let r = Math.max(0, r0 - 1); r <= Math.min(rows - 1, r0 + 1); r++) {
          for (let c = Math.max(0, c0 - 1); c <= Math.min(cols - 1, c0 + 1); c++) {
            if (states) {
              if (states[r * cols + c] === 1) return true;
              continue;
            }
            const a = arrival[r * cols + c];
            if (a <= t && t - a < window) return true;
          }
        }
        return false;
      };
    }
    return opts;
  }

  // ----------------------------------------------------------------------------- input

  private updateAria() {
    const action =
      this.clickMode === "wind"
        ? "set the direction the wind blows from toward the view centre"
        : "place the ignition at the view centre";
    this.renderer.domElement.setAttribute(
      "aria-label",
      `3D miniature of the loaded fuel and terrain landscape with the simulated fire. Press Enter to ${action}; arrow keys pan, plus and minus zoom; with a pointer, click the ground, drag to pan, right-drag or Ctrl-drag to rotate, scroll to zoom. Trees and houses are symbols for fuel classes, not observed objects.`,
    );
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pointerDown = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };

  /** Crosshair while hovering (click places), grabbing once a press travels past the click tolerance. */
  private readonly onPointerMove = (e: PointerEvent) => {
    const down = this.pointerDown;
    if (!down || down.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX)
      this.renderer.domElement.style.cursor = "grabbing";
  };

  private readonly onPointerCancel = () => {
    this.pointerDown = null;
    this.renderer.domElement.style.cursor = "crosshair";
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    this.renderer.domElement.style.cursor = "crosshair";
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

const NO_HOUSES: readonly GeoPoint[] = [];

/** Disposes geometries, materials and material textures under `root`. */
function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    const mats = mesh.material
      ? Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      : [];
    for (const m of mats) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      m.dispose();
    }
  });
  for (const t of textures) t.dispose();
}
