import * as THREE from "three";
import type { RoadEdge, RoadKind, Vec2, World } from "../types";
import { WATER_LEVEL, heightAt, polylineLength, pointAtDistance } from "../world";
import { box, mergeAll, paint, ribbon } from "./geometry";
import { PALETTE } from "./palette";

export const ROAD_WIDTH: Record<RoadKind, number> = { main: 7, residential: 5.5, "fire-road": 4, bridge: 6.2 };
/** Vertical lift above the terrain per road kind (distinct values avoid z-fighting at junctions). */
const ROAD_LIFT: Record<RoadKind, number> = { main: 0.34, residential: 0.3, "fire-road": 0.26, bridge: 0.34 };
const ROAD_COLOR: Record<RoadKind, number> = {
  main: PALETTE.roadMain,
  residential: PALETTE.roadResidential,
  "fire-road": PALETTE.roadFire,
  bridge: PALETTE.roadMain,
};
const DECK_THICKNESS = 1.3;
/** The route hint follows the main evacuation corridor from town to the shelter. */
const ROUTE_EDGE_IDS = ["M1-M2", "M2-M3", "M3-M4", "M4-BW", "BW-BE", "BE-E1", "E1-SH"];
export const BRIDGE_NAME = "Mill Creek Bridge";

/**
 * Road-surface height: on the bridge span this is the arched deck, elsewhere the terrain
 * plus the road lift. Vehicles, pedestrians and road decals use it for their y.
 */
export type SurfaceHeight = (x: number, z: number) => number;

export type BridgeProfile = {
  a: Vec2;
  b: Vec2;
  length: number;
  /** Deck top height at fraction s ∈ [0, 1] from `a` to `b`. */
  deckY: (s: number) => number;
  midpoint: THREE.Vector3;
};

export function createBridgeProfile(world: World): BridgeProfile {
  const edge = world.edges.find((e) => e.id === world.bridgeEdgeId);
  if (!edge) throw new Error(`Diorama scene: bridge edge ${world.bridgeEdgeId} not found`);
  const a = edge.points[0];
  const b = edge.points[edge.points.length - 1];
  const ya = heightAt(a.x, a.z) + ROAD_LIFT.main;
  const yb = heightAt(b.x, b.z) + ROAD_LIFT.main;
  // Constant clearance above the water at mid-span, with a gentle arch.
  const rise = Math.max(1.2, WATER_LEVEL + 3.8 - (ya + yb) / 2);
  const deckY = (s: number) => ya + (yb - ya) * s + rise * Math.sin(Math.PI * Math.min(1, Math.max(0, s)));
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return { a, b, length, deckY, midpoint: new THREE.Vector3((a.x + b.x) / 2, deckY(0.5), (a.z + b.z) / 2) };
}

export function createSurfaceHeight(bridge: BridgeProfile): SurfaceHeight {
  const dx = (bridge.b.x - bridge.a.x) / bridge.length;
  const dz = (bridge.b.z - bridge.a.z) / bridge.length;
  const halfWidth = ROAD_WIDTH.bridge / 2 + 1.5;
  return (x, z) => {
    const rx = x - bridge.a.x;
    const rz = z - bridge.a.z;
    const along = rx * dx + rz * dz;
    const lateral = Math.abs(rx * dz - rz * dx);
    if (along >= 0 && along <= bridge.length && lateral <= halfWidth) return bridge.deckY(along / bridge.length);
    return heightAt(x, z) + ROAD_LIFT.main;
  };
}

const terrainLift = (lift: number) => (x: number, z: number) => heightAt(x, z) + lift;

function roadMaterial() {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Junction discs draped on the terrain so road ends join cleanly. */
function junctionDisc(p: Vec2, radius: number, lift: number, color: number) {
  const g = new THREE.CircleGeometry(radius, 20);
  g.rotateX(-Math.PI / 2);
  g.translate(p.x, 0, p.z);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) + lift);
  return paint(g, color, true);
}

function buildBridge(bridge: BridgeProfile): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 24;
  const dx = (bridge.b.x - bridge.a.x) / bridge.length;
  const dz = (bridge.b.z - bridge.a.z) / bridge.length;
  // Left normal (tz, -tx) as in `ribbon`.
  const nx = dz;
  const nz = -dx;
  const hw = ROAD_WIDTH.bridge / 2;
  const at = (s: number, off: number, dy = 0) =>
    new THREE.Vector3(bridge.a.x + dx * bridge.length * s + nx * off, bridge.deckY(s) + dy, bridge.a.z + dz * bridge.length * s + nz * off);
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  const quad = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, col: number) => {
    c.set(col);
    for (const p of [p0, p1, p2, p0, p2, p3]) {
      positions.push(p.x, p.y, p.z);
      colors.push(c.r, c.g, c.b);
    }
  };
  for (let i = 0; i < n; i++) {
    const s0 = i / n;
    const s1 = (i + 1) / n;
    // Deck top, stone fascia on both sides, underside.
    quad(at(s0, hw), at(s0, -hw), at(s1, -hw), at(s1, hw), PALETTE.roadMain);
    quad(at(s0, hw + 0.4, -DECK_THICKNESS), at(s0, hw + 0.4, 0.15), at(s1, hw + 0.4, 0.15), at(s1, hw + 0.4, -DECK_THICKNESS), PALETTE.stone);
    quad(at(s0, -hw - 0.4, 0.15), at(s0, -hw - 0.4, -DECK_THICKNESS), at(s1, -hw - 0.4, -DECK_THICKNESS), at(s1, -hw - 0.4, 0.15), PALETTE.stone);
    quad(at(s0, -hw - 0.4, -DECK_THICKNESS), at(s0, hw + 0.4, -DECK_THICKNESS), at(s1, hw + 0.4, -DECK_THICKNESS), at(s1, -hw - 0.4, -DECK_THICKNESS), PALETTE.stone);
    // Kerb tops so the deck edge reads as a stone parapet base.
    quad(at(s0, hw + 0.4, 0.15), at(s0, hw, 0.15), at(s1, hw, 0.15), at(s1, hw + 0.4, 0.15), PALETTE.stone);
    quad(at(s0, -hw, 0.15), at(s0, -hw - 0.4, 0.15), at(s1, -hw - 0.4, 0.15), at(s1, -hw, 0.15), PALETTE.stone);
    // Top rails as thin flat strips.
    for (const side of [1, -1]) {
      const off = side * (hw + 0.2);
      quad(at(s0, off + 0.15, 1.35), at(s0, off - 0.15, 1.35), at(s1, off - 0.15, 1.35), at(s1, off + 0.15, 1.35), PALETTE.railing);
      quad(at(s0, off + 0.15 * side, 1.1), at(s0, off + 0.15 * side, 1.35), at(s1, off + 0.15 * side, 1.35), at(s1, off + 0.15 * side, 1.1), PALETTE.railing);
    }
  }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  deck.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  deck.computeVertexNormals();
  parts.push(deck);

  const yaw = Math.atan2(dx, dz);
  const posts = Math.round(bridge.length / 3);
  for (let i = 0; i <= posts; i++) {
    const s = i / posts;
    for (const side of [1, -1]) {
      const p = at(s, side * (hw + 0.2), 0.7);
      parts.push(box(0.35, 1.3, 0.35, p.x, p.y, p.z, PALETTE.railing, yaw));
    }
  }
  for (const s of [0.36, 0.64]) {
    const top = bridge.deckY(s) - DECK_THICKNESS;
    const bottom = WATER_LEVEL - 1.6;
    const p = at(s, 0);
    parts.push(box(ROAD_WIDTH.bridge + 1.6, top - bottom, 1.8, p.x, (top + bottom) / 2, p.z, PALETTE.stone, yaw));
  }
  for (const s of [0, 1]) {
    const p = at(s, 0);
    const top = bridge.deckY(s) - 0.2;
    parts.push(box(ROAD_WIDTH.bridge + 2.4, 4, 3, p.x, top - 2, p.z, PALETTE.stone, yaw));
  }
  return mergeAll(parts);
}

const ROUTE_VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Chevrons flowing toward the shelter plus a faint continuous underglow. */
const ROUTE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uOpacity;
#include <fog_pars_fragment>
varying vec2 vUv;
void main() {
  float across = abs(vUv.y - 0.5) * 2.0;
  float chevron = fract((vUv.x - uTime * 9.0) / 9.0 + across * 0.22);
  float mark = smoothstep(0.0, 0.06, chevron) * (1.0 - smoothstep(0.24, 0.32, chevron));
  float edge = 1.0 - smoothstep(0.7, 1.0, across);
  float alpha = (0.16 + 0.62 * mark) * edge * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const CLOSURE_FRAG = /* glsl */ `
uniform vec3 uColor;
#include <fog_pars_fragment>
varying vec2 vUv;
void main() {
  float stripe = step(0.5, fract((vUv.x + vUv.y * 6.0) / 3.2));
  vec3 col = mix(uColor, vec3(0.97, 0.94, 0.88), stripe * 0.85);
  gl_FragColor = vec4(col, 0.72);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function decalMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    vertexShader: ROUTE_VERT,
    fragmentShader,
    fog: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

function chevronGeometry(): THREE.ShapeGeometry {
  // A "V" pointing toward -y in shape space, i.e. +z after rotateX(-π/2).
  const s = new THREE.Shape();
  s.moveTo(0, -1);
  s.lineTo(2, 1);
  s.lineTo(2, 2);
  s.lineTo(0, 0);
  s.lineTo(-2, 2);
  s.lineTo(-2, 1);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Roads, the bridge, the evacuation-route hint, closures and the bottleneck marker. */
export class RoadLayer {
  readonly group = new THREE.Group();
  readonly bridgeMesh: THREE.Mesh;
  readonly bridge: BridgeProfile;
  readonly surfaceHeight: SurfaceHeight;
  private readonly world: World;
  private readonly routeMaterial: THREE.ShaderMaterial;
  private readonly closureMaterial: THREE.ShaderMaterial;
  private readonly closures = new Map<string, THREE.Group>();
  private readonly bottleneck = new THREE.Group();
  private readonly rings: THREE.Mesh[] = [];
  private readonly chevrons: THREE.Mesh[] = [];
  private bottleneckLevel = 0;
  private bottleneckTarget = 0;

  constructor(world: World) {
    this.world = world;
    this.bridge = createBridgeProfile(world);
    this.surfaceHeight = createSurfaceHeight(this.bridge);

    const roadParts: THREE.BufferGeometry[] = [];
    const dashParts: THREE.BufferGeometry[] = [];
    for (const e of world.edges) {
      if (e.id === world.bridgeEdgeId) continue;
      roadParts.push(paint(ribbon(e.points, ROAD_WIDTH[e.kind], terrainLift(ROAD_LIFT[e.kind]), 2.5, 2), ROAD_COLOR[e.kind], true));
      if (e.kind === "main") dashParts.push(...this.centreDashes(e));
    }
    for (const node of world.nodes) {
      const incident = world.edges.filter((e) => (e.from === node.id || e.to === node.id) && e.kind !== "bridge");
      if (incident.length === 0) continue;
      const widest = incident.reduce((w, e) => (ROAD_WIDTH[e.kind] > ROAD_WIDTH[w.kind] ? e : w));
      roadParts.push(junctionDisc(node.p, ROAD_WIDTH[widest.kind] / 2, ROAD_LIFT[widest.kind] + 0.015, ROAD_COLOR[widest.kind]));
    }
    const roads = new THREE.Mesh(mergeAll(roadParts), roadMaterial());
    roads.receiveShadow = true;
    roads.name = "roads";
    this.group.add(roads);
    if (dashParts.length) {
      const dashMat = roadMaterial();
      dashMat.polygonOffsetFactor = -3;
      dashMat.polygonOffsetUnits = -3;
      const dashes = new THREE.Mesh(mergeAll(dashParts), dashMat);
      dashes.receiveShadow = true;
      this.group.add(dashes);
    }

    const bridgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    this.bridgeMesh = new THREE.Mesh(buildBridge(this.bridge), bridgeMat);
    this.bridgeMesh.castShadow = true;
    this.bridgeMesh.receiveShadow = true;
    this.bridgeMesh.name = "bridge";
    this.group.add(this.bridgeMesh);

    this.routeMaterial = decalMaterial(ROUTE_FRAG, {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(PALETTE.cyanBright) },
      uOpacity: { value: 1 },
    });
    const routePoints: Vec2[] = [];
    for (const id of ROUTE_EDGE_IDS) {
      const e = world.edges.find((edge) => edge.id === id);
      if (!e) continue;
      routePoints.push(...(routePoints.length ? e.points.slice(1) : e.points));
    }
    if (routePoints.length > 1) {
      const route = new THREE.Mesh(
        ribbon(routePoints, 2.2, (x, z) => this.surfaceHeight(x, z) + 0.12, 2, 1),
        this.routeMaterial,
      );
      route.renderOrder = 2;
      route.name = "route-hint";
      this.group.add(route);
    }

    this.closureMaterial = decalMaterial(CLOSURE_FRAG, { uColor: { value: new THREE.Color(PALETTE.closure) } });
    this.buildBottleneck();
    this.group.add(this.bottleneck);
  }

  private centreDashes(e: RoadEdge): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    const len = polylineLength(e.points);
    for (let d = 6; d + 3.2 < len - 6; d += 9) {
      const pts = [0, 1.6, 3.2].map((k) => pointAtDistance(e.points, d + k).p);
      out.push(paint(ribbon(pts, 0.35, terrainLift(ROAD_LIFT.main + 0.05), 1.6, 1), PALETTE.roadDash, true));
    }
    return out;
  }

  private buildBottleneck() {
    const approach = this.world.edges.find((e) => e.to === this.bridgeNodeWest() && e.kind !== "bridge");
    const ringGeo = new THREE.RingGeometry(8.2, 9.4, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const anchor = approach ? pointAtDistance(approach.points, polylineLength(approach.points) - 10).p : this.bridge.a;
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: PALETTE.coral, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }),
      );
      ring.position.set(anchor.x, this.surfaceHeight(anchor.x, anchor.z) + 0.5, anchor.z);
      ring.renderOrder = 3;
      this.rings.push(ring);
      this.bottleneck.add(ring);
    }
    if (approach) {
      const geo = chevronGeometry();
      const len = polylineLength(approach.points);
      for (let i = 0; i < 4; i++) {
        const { p, heading } = pointAtDistance(approach.points, len - 8 - i * 8);
        const m = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color: PALETTE.coral, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }),
        );
        m.position.set(p.x, this.surfaceHeight(p.x, p.z) + 0.45, p.z);
        m.rotation.y = heading;
        m.scale.setScalar(0.9);
        m.renderOrder = 3;
        this.chevrons.push(m);
        this.bottleneck.add(m);
      }
    }
    this.bottleneck.visible = false;
  }

  private bridgeNodeWest(): string {
    const e = this.world.edges.find((edge) => edge.id === this.world.bridgeEdgeId);
    return e ? e.from : "";
  }

  setBottleneck(active: boolean) {
    this.bottleneckTarget = active ? 1 : 0;
  }

  setClosed(ids: string[]) {
    const closed = new Set(ids);
    for (const id of closed) {
      if (!this.closures.has(id)) {
        const g = this.buildClosure(id);
        if (g) this.closures.set(id, g);
      }
    }
    for (const [id, g] of this.closures) g.visible = closed.has(id);
  }

  private buildClosure(id: string): THREE.Group | null {
    const e = this.world.edges.find((edge) => edge.id === id);
    if (!e) return null;
    const group = new THREE.Group();
    group.name = `closure-${id}`;
    const width = ROAD_WIDTH[e.kind] + 0.6;
    const overlay = new THREE.Mesh(ribbon(e.points, width, (x, z) => this.surfaceHeight(x, z) + 0.1, 2.5, 1), this.closureMaterial);
    overlay.renderOrder = 2;
    group.add(overlay);
    const len = polylineLength(e.points);
    const parts: THREE.BufferGeometry[] = [];
    for (const d of [Math.min(5, len * 0.2), Math.max(len - 5, len * 0.8)]) {
      const { p, heading } = pointAtDistance(e.points, d);
      const y = this.surfaceHeight(p.x, p.z);
      const span = ROAD_WIDTH[e.kind] * 0.85;
      const seg = span / 5;
      // Red/white striped barrier board on two legs, across the road.
      for (let k = 0; k < 5; k++) {
        const off = -span / 2 + seg * (k + 0.5);
        parts.push(
          box(seg, 0.9, 0.35, p.x + Math.cos(heading) * off, y + 1.5, p.z - Math.sin(heading) * off, k % 2 ? PALETTE.ivory : PALETTE.closure, heading),
        );
      }
      for (const side of [-1, 1]) {
        const off = side * span * 0.4;
        parts.push(box(0.25, 1.2, 0.25, p.x + Math.cos(heading) * off, y + 0.6, p.z - Math.sin(heading) * off, PALETTE.ivory, heading));
      }
    }
    const barriers = new THREE.Mesh(mergeAll(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    barriers.castShadow = true;
    group.add(barriers);
    this.group.add(group);
    return group;
  }

  tick(time: number, dt: number, reducedMotion: boolean) {
    this.routeMaterial.uniforms.uTime.value = time;
    const k = Math.min(1, dt * 3);
    this.bottleneckLevel += (this.bottleneckTarget - this.bottleneckLevel) * k;
    const level = this.bottleneckLevel;
    this.bottleneck.visible = level > 0.01;
    if (!this.bottleneck.visible) return;
    this.rings.forEach((ring, i) => {
      const mat = ring.material as THREE.MeshBasicMaterial;
      if (reducedMotion) {
        ring.scale.setScalar(1 + i * 0.25);
        mat.opacity = (i === 0 ? 0.7 : 0.35) * level;
        return;
      }
      const phase = (time * 0.55 + i * 0.5) % 1;
      ring.scale.setScalar(0.8 + phase * 0.7);
      mat.opacity = 0.75 * (1 - phase) * level;
    });
    this.chevrons.forEach((m, i) => {
      const mat = m.material as THREE.MeshBasicMaterial;
      // Lights run toward the bridge (index 0 is nearest the bridge).
      const wave = reducedMotion ? 1 : 0.45 + 0.55 * Math.max(0, Math.sin(time * 3.2 + i * 0.9));
      mat.opacity = 0.85 * wave * level;
    });
  }
}
