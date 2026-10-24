import * as THREE from "three";
import type { FireField, PickTarget, SimSnapshot, World } from "../types";
import { BuildingLayer } from "./buildings";
import { CameraRig, type ViewInsets } from "./camera";
import { EffectsLayer, FireSampler } from "./effects";
import { LabelLayer } from "./labels";
import { PALETTE } from "./palette";
import { BRIDGE_NAME, ROAD_WIDTH, RoadLayer } from "./roads";
import {
  buildPlinth,
  buildTerrain,
  buildWater,
  createFireUniforms,
  type FireUniforms,
} from "./terrain";
import { TreeLayer } from "./trees";
import { VehicleLayer } from "./vehicles";

export type DioramaSceneOptions = { reducedMotion: boolean };
export type { ViewInsets };

/** Pointer travel (CSS px) above which a press is treated as a drag, not a click. */
const CLICK_TOLERANCE_PX = 5;
/** Screen-space radius (CSS px) for picking small vehicles. */
const VEHICLE_PICK_RADIUS_PX = 18;
const MAX_PIXEL_RATIO = 2;
/** Containers narrower than this get compact labels. */
const COMPACT_WIDTH_PX = 600;
/** Leader-line lengths (CSS px) between a label pill and the point it names. */
const LABEL_STEM_PX = 34;
const BRIDGE_STEM_PX = 62;

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

/**
 * three.js renderer for the fictional evacuation diorama (see docs/adr/0010).
 * The page owns simulation time and calls `update(snapshot)`; this class owns the render
 * loop, resize handling, camera and picking. The container must be positioned (relative/
 * absolute) and have an explicit size; the scene appends a canvas, a label layer and a
 * vignette overlay to it and removes them in `dispose()`.
 */
export class DioramaScene {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly labels: LabelLayer;
  private readonly vignette: HTMLDivElement;
  private readonly fireUniforms: FireUniforms;
  private readonly waterUniforms: { uTime: { value: number } };
  private readonly roads: RoadLayer;
  private readonly buildings: BuildingLayer;
  private readonly trees: TreeLayer;
  private readonly vehicles: VehicleLayer;
  private readonly sampler: FireSampler;
  private readonly effects: EffectsLayer;
  private readonly sun: THREE.DirectionalLight;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly backgroundTex: THREE.CanvasTexture;
  private reducedMotion: boolean;
  private pickCallback: ((target: PickTarget | null) => void) | null = null;
  private time = 0;
  private lastFrame = performance.now();
  private pointerDown: { x: number; y: number; id: number } | null = null;
  private disposed = false;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement, world: World, fire: FireField, opts: DioramaSceneOptions) {
    this.container = container;
    this.reducedMotion = opts.reducedMotion;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
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
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "3D miniature of the fictional town Larkspur Hollow showing wildfire spread, evacuation traffic to the shelter and fire crews. Synthetic data.",
    );
    container.appendChild(canvas);

    this.labels = new LabelLayer(container);
    this.labels.setReducedMotion(this.reducedMotion);
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

    // Scene, atmosphere and lights.
    this.backgroundTex = backgroundTexture();
    this.scene.background = this.backgroundTex;
    this.scene.fog = new THREE.Fog(PALETTE.haze, 800, 2400);
    this.scene.add(new THREE.HemisphereLight(PALETTE.skyLight, PALETTE.groundLight, 2.0));
    this.sun = new THREE.DirectionalLight(PALETTE.sun, 2.8);
    this.sun.position.set(-260, 380, 120);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    const extent = Math.hypot(world.width, world.depth) / 2 + 10;
    sc.left = -extent;
    sc.right = extent;
    sc.top = extent;
    sc.bottom = -extent;
    sc.near = 50;
    sc.far = 1100;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);

    // Content.
    this.fireUniforms = createFireUniforms(fire, world.wind.toward);
    this.scene.add(buildTerrain(world, this.fireUniforms));
    this.scene.add(buildPlinth(world));
    const water = buildWater(world);
    this.waterUniforms = water.uniforms;
    this.scene.add(water.mesh);
    this.roads = new RoadLayer(world);
    this.scene.add(this.roads.group);
    this.buildings = new BuildingLayer(world);
    this.scene.add(this.buildings.group);
    this.trees = new TreeLayer(world, fire);
    this.scene.add(this.trees.group);
    this.vehicles = new VehicleLayer(this.roads.surfaceHeight, world.households.length);
    this.scene.add(this.vehicles.group);
    this.sampler = new FireSampler(fire, world.wind);
    this.effects = new EffectsLayer(world, fire, this.roads.surfaceHeight, this.sampler);
    this.scene.add(this.effects.group);

    // Labels float above what they name on a thin stem; the bridge label hangs off the
    // north (upstream) railing so the deck and the queue on its approach stay visible.
    this.labels.add(
      this.scene,
      "shelter",
      world.shelter.label,
      this.buildings.shelterAnchor,
      LABEL_STEM_PX,
    );
    this.labels.add(
      this.scene,
      "station",
      world.station.label,
      this.buildings.stationAnchor,
      LABEL_STEM_PX,
    );
    const br = this.roads.bridge;
    const north = new THREE.Vector3(br.b.z - br.a.z, 0, -(br.b.x - br.a.x)).normalize();
    if (north.z > 0) north.negate();
    const bridgeAnchor = br.midpoint
      .clone()
      .addScaledVector(north, ROAD_WIDTH.bridge / 2 + 0.8)
      .add(new THREE.Vector3(0, 1.6, 0));
    this.labels.add(this.scene, "bridge", BRIDGE_NAME, bridgeAnchor, BRIDGE_STEM_PX, 0.14);
    this.labels.add(this.scene, "wind", `Wind · ${world.wind.label}`, this.effects.windAnchor);

    this.rig = new CameraRig(world, canvas);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Applies a simulation snapshot (call whenever simulation time changes). */
  update(snapshot: SimSnapshot): void {
    if (this.disposed) return;
    const t = snapshot.t;
    this.fireUniforms.uSimT.value = t;
    this.trees.update(t);
    if (this.sampler.update(t))
      this.fireUniforms.uHeadRange.value.set(
        this.sampler.headRange.min,
        this.sampler.headRange.max,
      );
    this.effects.setSimTime(t);
    this.effects.setCrews(snapshot.crews);
    this.roads.setClosed(snapshot.closedEdgeIds);
    this.roads.setBottleneck(snapshot.bottleneckActive);
    this.labels.setBottleneck(snapshot.bottleneckActive);
    this.buildings.update(snapshot);
    this.vehicles.setSnapshot(snapshot);
  }

  /** Animates back to the composed default view (instant with reduced motion). */
  resetView(): void {
    this.rig.resetView(this.reducedMotion);
  }

  onPick(cb: (target: PickTarget | null) => void): void {
    this.pickCallback = cb;
  }

  /** CSS px of the target's current position within the container, or null if not on screen. */
  project(target: PickTarget): { x: number; y: number } | null {
    const p = new THREE.Vector3();
    switch (target.kind) {
      case "vehicle":
        if (!this.vehicles.positionOf(target.id, p)) return null;
        break;
      case "shelter":
        p.copy(this.buildings.shelterAnchor);
        break;
      case "station":
        p.copy(this.buildings.stationAnchor);
        break;
      case "bridge":
        p.copy(this.roads.bridge.midpoint).y += 2;
        break;
    }
    const camera = this.rig.camera;
    const view = p.clone().applyMatrix4(camera.matrixWorldInverse);
    if (view.z >= 0) return null;
    p.project(camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  /**
   * CSS px of the container occluded by overlay UI on each side. The default view (and
   * resetView) frames the whole board inside the remaining rectangle, shifting the
   * projection centre with setViewOffset so orbiting still pivots on the board centre.
   */
  setViewInsets(insets: ViewInsets): void {
    if (this.disposed) return;
    this.rig.setInsets(insets);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    this.labels.setReducedMotion(value);
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
    this.rig.dispose();
    this.labels.dispose();
    this.effects.dispose();
    this.vehicles.dispose();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
      const mats = mesh.material
        ? Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        : [];
      for (const m of mats) {
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) textures.add(value);
        if (m instanceof THREE.ShaderMaterial) {
          for (const u of Object.values(m.uniforms))
            if (u.value instanceof THREE.Texture) textures.add(u.value);
        }
        m.dispose();
      }
    });
    textures.add(this.fireUniforms.uFire.value);
    textures.add(this.backgroundTex);
    for (const t of textures) t.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.vignette.remove();
    this.pickCallback = null;
  }

  private resize() {
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.rig.setViewport(w, h);
    this.labels.setCompact(w < COMPACT_WIDTH_PX);
  }

  private readonly frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (document.hidden) return;
    if (!this.reducedMotion) this.time += dt;
    const time = this.time;
    const reduced = this.reducedMotion;

    this.fireUniforms.uTime.value = time;
    this.waterUniforms.uTime.value = time;
    this.rig.tick(dt, now, reduced);
    const d = this.rig.distance();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 0.85;
    fog.far = d * 3.4;

    this.roads.tick(time, dt, reduced);
    this.buildings.tick(time, reduced);
    this.trees.flicker(time, reduced);
    this.vehicles.tick(time, dt, reduced);
    this.effects.tick(time, reduced);

    this.renderer.render(this.scene, this.rig.camera);
    this.labels.render(this.scene, this.rig.camera);
  };

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
    const target = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    this.pickCallback?.(target);
  };

  /** Vehicles are picked in screen space (generous radius); buildings/bridge by raycast. */
  private pick(x: number, y: number): PickTarget | null {
    const camera = this.rig.camera;
    let best: { id: string; d: number } | null = null;
    const p = new THREE.Vector3();
    for (const v of this.vehicles.pickables()) {
      if (!this.vehicles.positionOf(v.id, p)) continue;
      const view = p.clone().applyMatrix4(camera.matrixWorldInverse);
      if (view.z >= 0) continue;
      p.project(camera);
      const sx = ((p.x + 1) / 2) * this.width;
      const sy = ((1 - p.y) / 2) * this.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d <= VEHICLE_PICK_RADIUS_PX && (!best || d < best.d)) best = { id: v.id, d };
    }
    if (best) return { kind: "vehicle", id: best.id };

    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, camera);
    const candidates: THREE.Object3D[] = [
      this.buildings.shelterMesh,
      this.buildings.stationMesh,
      this.roads.bridgeMesh,
      this.buildings.homesMesh,
    ];
    const terrain = this.scene.getObjectByName("terrain");
    if (terrain) candidates.push(terrain);
    const hit = this.raycaster.intersectObjects(candidates, false)[0];
    if (!hit) return null;
    if (hit.object === this.buildings.shelterMesh) return { kind: "shelter" };
    if (hit.object === this.buildings.stationMesh) return { kind: "station" };
    if (hit.object === this.roads.bridgeMesh) return { kind: "bridge" };
    return null;
  }
}
