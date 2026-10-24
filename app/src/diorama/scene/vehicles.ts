import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { SimSnapshot, VehicleKind, VehicleState } from "../types";
import { box, hash2, mergeAll, paint, place } from "./geometry";
import { PALETTE } from "./palette";
import type { SurfaceHeight } from "./roads";

/** Models are slightly over-scaled versus real cars so they read at diorama distance. */
function wheel(x: number, z: number, r = 0.5) {
  const g = paint(new THREE.CylinderGeometry(r, r, 0.45, 10), PALETTE.tyre);
  g.rotateZ(Math.PI / 2);
  return place(g, x, r, z);
}

function civilianGeometry() {
  return mergeAll([
    place(paint(new RoundedBoxGeometry(2.6, 1.15, 5.6, 2, 0.4), PALETTE.civilianBody, true), 0, 1.05, 0),
    place(paint(new RoundedBoxGeometry(2.2, 0.95, 3.0, 2, 0.35), PALETTE.civilianRoof, true), 0, 1.95, -0.35),
    box(1.9, 0.5, 0.12, 0, 1.95, 1.2, PALETTE.glass),
    ...[-1.8, 1.8].flatMap((z) => [wheel(-1.2, z), wheel(1.2, z)]),
  ]);
}

function engineGeometry() {
  const parts = [
    box(3.0, 2.3, 6.8, 0, 1.95, -1.3, PALETTE.engineRed),
    place(paint(new RoundedBoxGeometry(3.0, 2.7, 2.9, 2, 0.35), PALETTE.engineRed, true), 0, 2.05, 3.45),
    box(2.6, 0.9, 0.12, 0, 2.65, 4.92, PALETTE.glass),
    box(3.08, 0.34, 9.6, 0, 1.55, 0.1, PALETTE.engineStripe),
    box(0.16, 0.16, 6.6, -0.7, 3.25, -1.2, PALETTE.engineLadder),
    box(0.16, 0.16, 6.6, 0.7, 3.25, -1.2, PALETTE.engineLadder),
  ];
  for (let z = -4.2; z <= 1.8; z += 1.2) parts.push(box(1.4, 0.1, 0.12, 0, 3.25, z, PALETTE.engineLadder));
  for (const z of [-3.6, -2.2, 3.3]) parts.push(wheel(-1.35, z, 0.62), wheel(1.35, z, 0.62));
  return mergeAll(parts);
}

function brakeGeometry() {
  return mergeAll([box(0.55, 0.32, 0.14, -0.85, 1.15, -2.83, 0xffffff), box(0.55, 0.32, 0.14, 0.85, 1.15, -2.83, 0xffffff)]);
}

function lightBarGeometry() {
  return mergeAll([box(0.9, 0.38, 0.55, -0.55, 3.55, 3.3, 0xffffff), box(0.9, 0.38, 0.55, 0.55, 3.55, 3.3, 0xffffff)]);
}

const BRAKE = new THREE.Color(PALETTE.brake).multiplyScalar(1.6);
const BLUE = new THREE.Color(PALETTE.emergencyBlue);

type Fleet = {
  kind: VehicleKind;
  body: THREE.InstancedMesh;
  accent: THREE.InstancedMesh;
  capacity: number;
  ids: string[];
};

/** Instanced civilian cars and fire engines, plus pedestrian figures. */
export class VehicleLayer {
  readonly group = new THREE.Group();
  private readonly surfaceHeight: SurfaceHeight;
  private readonly bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05 });
  private readonly accentMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private readonly geos: Record<VehicleKind, { body: THREE.BufferGeometry; accent: THREE.BufferGeometry }>;
  private readonly fleets: Record<VehicleKind, Fleet>;
  private pedestrians: THREE.InstancedMesh;
  private pedestrianCapacity: number;
  /** Eased 0..1 visibility per vehicle id (sheltered cars shrink away gently). */
  private readonly vis = new Map<string, number>();
  private snapshot: SimSnapshot | null = null;
  private readonly dummy = new THREE.Object3D();
  private readonly tmpColor = new THREE.Color();

  constructor(surfaceHeight: SurfaceHeight, initialCivilians: number) {
    this.surfaceHeight = surfaceHeight;
    this.geos = {
      civilian: { body: civilianGeometry(), accent: brakeGeometry() },
      engine: { body: engineGeometry(), accent: lightBarGeometry() },
    };
    this.fleets = {
      civilian: this.createFleet("civilian", Math.max(8, initialCivilians + 8)),
      engine: this.createFleet("engine", 8),
    };
    this.pedestrianCapacity = 64;
    this.pedestrians = this.createPedestrians(this.pedestrianCapacity);
  }

  private createFleet(kind: VehicleKind, capacity: number): Fleet {
    const body = new THREE.InstancedMesh(this.geos[kind].body, this.bodyMaterial, capacity);
    const accent = new THREE.InstancedMesh(this.geos[kind].accent, this.accentMaterial, capacity);
    body.count = 0;
    accent.count = 0;
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;
    accent.frustumCulled = false;
    accent.setColorAt(0, BLUE);
    body.name = `${kind}-vehicles`;
    this.group.add(body, accent);
    return { kind, body, accent, capacity, ids: [] };
  }

  private ensureCapacity(kind: VehicleKind, needed: number) {
    const fleet = this.fleets[kind];
    if (needed <= fleet.capacity) return;
    this.group.remove(fleet.body, fleet.accent);
    fleet.body.dispose();
    fleet.accent.dispose();
    this.fleets[kind] = this.createFleet(kind, Math.ceil(needed * 1.5));
  }

  private createPedestrians(capacity: number) {
    const geo = mergeAll([
      place(paint(new THREE.CapsuleGeometry(0.55, 1.2, 3, 8), PALETTE.pedestrian, true), 0, 1.15, 0),
      place(paint(new THREE.SphereGeometry(0.42, 8, 6), PALETTE.civilianBody, true), 0, 2.45, 0),
    ]);
    const mesh = new THREE.InstancedMesh(geo, this.bodyMaterial, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.name = "pedestrians";
    this.group.add(mesh);
    return mesh;
  }

  setSnapshot(snapshot: SimSnapshot) {
    this.snapshot = snapshot;
    let civ = 0;
    let eng = 0;
    for (const v of snapshot.vehicles) {
      if (v.kind === "civilian") civ++;
      else eng++;
    }
    this.ensureCapacity("civilian", civ);
    this.ensureCapacity("engine", eng);
    if (snapshot.pedestrians.length > this.pedestrianCapacity) {
      this.group.remove(this.pedestrians);
      this.pedestrians.dispose();
      this.pedestrianCapacity = Math.ceil(snapshot.pedestrians.length * 1.5);
      this.pedestrians = this.createPedestrians(this.pedestrianCapacity);
    }
  }

  /** Eased visibility of a vehicle (0 hidden … 1 shown). */
  visibility(id: string): number {
    return this.vis.get(id) ?? 0;
  }

  /** Current render position of a vehicle, or null if unknown/hidden. */
  positionOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.snapshot?.vehicles.find((x) => x.id === id);
    if (!v || this.visibility(id) < 0.2) return null;
    return out.set(v.p.x, this.surfaceHeight(v.p.x, v.p.z) + (v.kind === "engine" ? 3 : 2), v.p.z);
  }

  /** Visible vehicles for screen-space picking. */
  pickables(): VehicleState[] {
    return this.snapshot ? this.snapshot.vehicles.filter((v) => this.visibility(v.id) > 0.5) : [];
  }

  tick(time: number, dt: number, reducedMotion: boolean) {
    const snap = this.snapshot;
    if (!snap) return;
    const d = this.dummy;
    const ease = Math.min(1, dt * 4);
    const civ = this.fleets.civilian;
    const eng = this.fleets.engine;
    civ.ids = [];
    eng.ids = [];
    let ci = 0;
    let ei = 0;
    for (const v of snap.vehicles) {
      const target = v.visible ? 1 : 0;
      const prev = this.vis.get(v.id);
      const s = prev === undefined ? target : prev + (target - prev) * (reducedMotion ? 1 : ease);
      this.vis.set(v.id, s);
      const fleet = v.kind === "civilian" ? civ : eng;
      const index = v.kind === "civilian" ? ci++ : ei++;
      fleet.ids.push(v.id);
      d.position.set(v.p.x, this.surfaceHeight(v.p.x, v.p.z), v.p.z);
      d.rotation.set(0, v.heading, 0);
      d.scale.setScalar(s < 0.02 ? 0 : s);
      d.updateMatrix();
      fleet.body.setMatrixAt(index, d.matrix);
      fleet.accent.setMatrixAt(index, d.matrix);
      if (v.kind === "civilian") {
        // Queued cars show a soft brake-light glow; otherwise dim tail lights.
        this.tmpColor.copy(BRAKE).multiplyScalar(v.status === "queued" ? 1 : 0.16);
        fleet.accent.setColorAt(index, this.tmpColor);
      } else {
        const active = v.status === "responding" || v.status === "staged";
        // Gentle alternating pulse, not a strobe.
        const pulse = !active ? 0.15 : reducedMotion ? 1 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * 4.2 + index * Math.PI));
        this.tmpColor.copy(BLUE).multiplyScalar(pulse * 1.6);
        fleet.accent.setColorAt(index, this.tmpColor);
      }
    }
    for (const [fleet, count] of [
      [civ, ci],
      [eng, ei],
    ] as const) {
      fleet.body.count = count;
      fleet.accent.count = count;
      fleet.body.instanceMatrix.needsUpdate = true;
      fleet.accent.instanceMatrix.needsUpdate = true;
      if (fleet.accent.instanceColor) fleet.accent.instanceColor.needsUpdate = true;
    }

    const peds = snap.pedestrians;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const bob = reducedMotion ? 0 : Math.abs(Math.sin(time * 9 + hash2(i, 3) * 6)) * 0.25;
      d.position.set(p.p.x, this.surfaceHeight(p.p.x, p.p.z) + bob, p.p.z);
      d.rotation.set(0, p.heading, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.pedestrians.setMatrixAt(i, d.matrix);
    }
    this.pedestrians.count = peds.length;
    this.pedestrians.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const g of Object.values(this.geos)) {
      g.body.dispose();
      g.accent.dispose();
    }
  }
}
