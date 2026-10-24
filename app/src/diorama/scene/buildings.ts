import * as THREE from "three";
import type { Building, SimSnapshot, World } from "../types";
import { heightAt } from "../world";
import { box, gableRoof, hash2, mergeAll, paint, place } from "./geometry";
import { PALETTE } from "./palette";

type Footing = { base: number; floor: number };

/** Lowest/highest ground under a (rotated) rectangle so the building never floats. */
function footing(b: Building, extraFront = 0, extraSide = 0): Footing {
  let lo = Infinity;
  let hi = -Infinity;
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const hw = b.w / 2 + extraSide;
  for (const lx of [-hw, 0, hw]) {
    for (const lz of [-b.d / 2, 0, b.d / 2, b.d / 2 + extraFront]) {
      // Local (lx, lz) rotated by yaw about +y.
      const h = heightAt(b.p.x + lx * c + lz * s, b.p.z - lx * s + lz * c);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  return { base: lo - 0.5, floor: hi + 0.15 };
}

function toWorld(parts: THREE.BufferGeometry[], b: Building, base: number) {
  for (const p of parts) place(p, b.p.x, base, b.p.z, b.rotation);
}

function homeParts(b: Building): { parts: THREE.BufferGeometry[]; top: number } {
  const { base, floor } = footing(b);
  const plinth = floor - base;
  const H = plinth + b.h;
  const wall = PALETTE.walls[Math.floor(hash2(b.p.x, b.p.z) * PALETTE.walls.length)];
  const roof = PALETTE.roofs[b.variant % PALETTE.roofs.length];
  const rise = b.d * 0.42;
  const parts: THREE.BufferGeometry[] = [box(b.w, H, b.d, 0, H / 2, 0, wall)];
  for (const g of gableRoof(b.w, b.d, rise, 0.7, roof, wall)) parts.push(place(g, 0, H, 0));
  const fy = plinth;
  parts.push(box(1.5, 2.5, 0.25, -b.w * 0.2, fy + 1.25, b.d / 2 + 0.1, PALETTE.door));
  parts.push(box(1.7, 1.3, 0.2, b.w * 0.22, fy + b.h * 0.55, b.d / 2 + 0.08, PALETTE.glass));
  parts.push(box(1.7, 1.3, 0.2, 0, fy + b.h * 0.55, -b.d / 2 - 0.08, PALETTE.glass));
  for (const side of [-1, 1])
    parts.push(box(0.2, 1.3, 1.6, side * (b.w / 2 + 0.08), fy + b.h * 0.55, 0, PALETTE.glass));
  if (hash2(b.p.z, b.p.x) > 0.45)
    parts.push(box(1, 2.6, 1, b.w * 0.27, H + rise * 0.55, -b.d * 0.18, PALETTE.chimney));
  toWorld(parts, b, base);
  return { parts, top: base + H + rise };
}

function shelterParts(b: Building): {
  parts: THREE.BufferGeometry[];
  top: number;
  flagPole: THREE.Vector3;
} {
  const apron = 16;
  const { base, floor } = footing(b, apron, 3);
  const plinth = floor - base;
  const H = plinth + b.h;
  const rise = b.d * 0.3;
  const wall = PALETTE.walls[2];
  const parts: THREE.BufferGeometry[] = [box(b.w, H, b.d, 0, H / 2, 0, wall)];
  for (const g of gableRoof(b.w, b.d, rise, 1, PALETTE.shelterRoof, wall))
    parts.push(place(g, 0, H, 0));
  // Cyan identity band, entrance portico, tall windows and a paved forecourt.
  parts.push(box(b.w + 0.35, 1, b.d + 0.35, 0, H - 1.7, 0, PALETTE.cyan));
  parts.push(
    box(b.w + 6, plinth + 0.2, apron, 0, (plinth + 0.2) / 2, b.d / 2 + apron / 2, PALETTE.concrete),
  );
  parts.push(box(13, 0.8, 6, 0, plinth + 6, b.d / 2 + 3, PALETTE.ivory));
  for (const x of [-5.6, -1.9, 1.9, 5.6]) {
    parts.push(
      place(
        paint(new THREE.CylinderGeometry(0.4, 0.4, 5.8, 8), PALETTE.ivory),
        x,
        plinth + 2.9,
        b.d / 2 + 5.4,
      ),
    );
  }
  parts.push(box(5.4, 3.8, 0.3, 0, plinth + 1.9, b.d / 2 + 0.12, PALETTE.glass));
  for (const x of [-15, -11, -7, 7, 11, 15])
    parts.push(box(1.8, 3.6, 0.2, x, plinth + 3.6, b.d / 2 + 0.08, PALETTE.glass));
  parts.push(
    place(
      paint(new THREE.CylinderGeometry(0.22, 0.28, 17, 6), PALETTE.ivory),
      b.w / 2 + 2.5,
      plinth + 8.5,
      b.d / 2 + 6,
    ),
  );
  toWorld(parts, b, base);
  const pole = new THREE.Vector3(b.w / 2 + 2.5, plinth + 16.6, b.d / 2 + 6).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    b.rotation,
  );
  pole.add(new THREE.Vector3(b.p.x, base, b.p.z));
  return { parts, top: base + H + rise, flagPole: pole };
}

function stationParts(b: Building): { parts: THREE.BufferGeometry[]; top: number } {
  const apron = 12;
  const { base, floor } = footing(b, apron, 2);
  const plinth = floor - base;
  const H = plinth + b.h;
  const wall = PALETTE.walls[0];
  const parts: THREE.BufferGeometry[] = [box(b.w, H, b.d, 0, H / 2, 0, wall)];
  parts.push(box(b.w + 0.35, 1.1, b.d + 0.35, 0, H - 0.3, 0, PALETTE.stationRed));
  parts.push(box(b.w - 1, 0.4, b.d - 1, 0, H + 0.05, 0, PALETTE.stationRoof));
  parts.push(box(b.w + 0.25, 0.6, b.d + 0.25, 0, plinth + 0.3, 0, PALETTE.stationRed));
  parts.push(
    box(b.w + 4, plinth + 0.2, apron, 0, (plinth + 0.2) / 2, b.d / 2 + apron / 2, PALETTE.concrete),
  );
  for (const x of [-7.2, 0, 7.2]) {
    parts.push(box(5.9, 5.6, 0.2, x, plinth + 2.8, b.d / 2 + 0.06, PALETTE.stationRed));
    parts.push(box(5.1, 5.0, 0.2, x, plinth + 2.5, b.d / 2 + 0.16, PALETTE.stationDoor));
    for (const y of [1.4, 2.6, 3.8])
      parts.push(box(5.1, 0.12, 0.08, x, plinth + y, b.d / 2 + 0.3, PALETTE.stationRoof));
  }
  // Hose-drying tower at the back corner.
  parts.push(box(5, 14, 5, b.w / 2 - 2.5, plinth + 7, -b.d / 2 + 2.5, wall));
  parts.push(box(5.6, 0.9, 5.6, b.w / 2 - 2.5, plinth + 14.4, -b.d / 2 + 2.5, PALETTE.stationRed));
  parts.push(box(0.2, 1.4, 1.4, b.w / 2 + 0.06, plinth + 10, -b.d / 2 + 2.5, PALETTE.glass));
  toWorld(parts, b, base);
  return { parts, top: base + Math.max(H, plinth + 14.8) };
}

const MARKER_ORDERED = new THREE.Color(PALETTE.cyanBright).multiplyScalar(1.15);
const MARKER_LEFT = new THREE.Color(PALETTE.cyan)
  .lerp(new THREE.Color(PALETTE.ivory), 0.55)
  .multiplyScalar(0.7);

/** Homes, shelter, fire station and the "ordered to leave" home markers. */
export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly homesMesh: THREE.Mesh;
  readonly shelterMesh: THREE.Mesh;
  readonly stationMesh: THREE.Mesh;
  /** World-space anchors for labels and `project()`. */
  readonly shelterAnchor = new THREE.Vector3();
  readonly stationAnchor = new THREE.Vector3();
  private readonly flag: THREE.Mesh;
  private readonly flagBase: Float32Array;
  private readonly markers: THREE.InstancedMesh;
  private readonly markerPos: THREE.Vector3[] = [];
  /** 0 hidden, 1 ordered and still home, 2 ordered and departed. */
  private readonly markerState: Uint8Array;
  private readonly householdIndex = new Map<string, number>();
  private readonly dummy = new THREE.Object3D();

  constructor(world: World) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      side: THREE.DoubleSide,
    });
    const homeTop = new Map<string, number>();
    const homeParts_: THREE.BufferGeometry[] = [];
    let shelter: ReturnType<typeof shelterParts> | null = null;
    let station: ReturnType<typeof stationParts> | null = null;
    const shelterB = world.buildings.find((b) => b.id === world.shelter.buildingId);
    const stationB = world.buildings.find((b) => b.id === world.station.buildingId);
    for (const b of world.buildings) {
      if (b === shelterB) shelter = shelterParts(b);
      else if (b === stationB) station = stationParts(b);
      else {
        const h = homeParts(b);
        homeParts_.push(...h.parts);
        homeTop.set(b.id, h.top);
      }
    }
    if (!shelter || !stationB || !shelterB || !station)
      throw new Error("Diorama scene: shelter or station building missing");

    this.homesMesh = new THREE.Mesh(mergeAll(homeParts_), material);
    this.shelterMesh = new THREE.Mesh(mergeAll(shelter.parts), material);
    this.stationMesh = new THREE.Mesh(mergeAll(station.parts), material);
    for (const m of [this.homesMesh, this.shelterMesh, this.stationMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.homesMesh.name = "homes";
    this.shelterMesh.name = "shelter";
    this.stationMesh.name = "station";
    this.shelterAnchor.set(shelterB.p.x, shelter.top + 1, shelterB.p.z);
    this.stationAnchor.set(stationB.p.x, station.top + 1, stationB.p.z);

    const flagGeo = new THREE.PlaneGeometry(6, 3.4, 10, 2);
    flagGeo.translate(3, -1.7, 0);
    this.flagBase = Float32Array.from(flagGeo.getAttribute("position").array as ArrayLike<number>);
    this.flag = new THREE.Mesh(
      flagGeo,
      new THREE.MeshStandardMaterial({
        color: PALETTE.cyan,
        roughness: 0.6,
        side: THREE.DoubleSide,
        emissive: PALETTE.cyan,
        emissiveIntensity: 0.25,
      }),
    );
    this.flag.position.copy(shelter.flagPole);
    this.flag.rotation.y = shelterB.rotation + Math.PI / 2;
    this.flag.castShadow = true;
    this.group.add(this.flag);

    const homes = new Map(world.buildings.map((b) => [b.id, b]));
    this.markers = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1.1, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      world.households.length,
    );
    this.markerState = new Uint8Array(world.households.length);
    world.households.forEach((hh, i) => {
      this.householdIndex.set(hh.id, i);
      const home = homes.get(hh.homeId);
      const top = homeTop.get(hh.homeId) ?? heightAt(hh.parking.x, hh.parking.z) + 10;
      this.markerPos.push(
        new THREE.Vector3(
          home ? home.p.x : hh.parking.x,
          top + 2.6,
          home ? home.p.z : hh.parking.z,
        ),
      );
      this.markers.setColorAt(i, MARKER_ORDERED);
    });
    this.markers.name = "ordered-markers";
    this.markers.frustumCulled = false;
    this.group.add(this.markers);
    this.composeMarkers(0, true);
  }

  update(snapshot: SimSnapshot) {
    const ordered = new Set(snapshot.orderedHouseholdIds);
    const departed = new Set<string>();
    for (const v of snapshot.vehicles) {
      if (v.householdId && v.status !== "parked" && v.status !== "boarding")
        departed.add(v.householdId);
    }
    const walking = new Set(snapshot.pedestrians.map((p) => p.householdId));
    for (const [id, i] of this.householdIndex) {
      const state = !ordered.has(id) ? 0 : departed.has(id) || walking.has(id) ? 2 : 1;
      if (state !== this.markerState[i]) {
        this.markerState[i] = state;
        this.markers.setColorAt(i, state === 2 ? MARKER_LEFT : MARKER_ORDERED);
        if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
      }
    }
  }

  private composeMarkers(time: number, reducedMotion: boolean) {
    const d = this.dummy;
    for (let i = 0; i < this.markerPos.length; i++) {
      const state = this.markerState[i];
      const p = this.markerPos[i];
      const bob = reducedMotion ? 0 : Math.sin(time * 1.6 + i * 0.7) * 0.35;
      d.position.set(p.x, p.y + bob, p.z);
      d.rotation.set(0, reducedMotion ? 0 : time * 0.8 + i, 0);
      d.scale.setScalar(state === 0 ? 0 : state === 2 ? 0.6 : 1);
      d.updateMatrix();
      this.markers.setMatrixAt(i, d.matrix);
    }
    this.markers.instanceMatrix.needsUpdate = true;
  }

  tick(time: number, reducedMotion: boolean) {
    this.composeMarkers(time, reducedMotion);
    const pos = this.flag.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = this.flagBase[i * 3];
      const wave = reducedMotion ? 0 : Math.sin(x * 0.9 - time * 3) * 0.35 * (x / 6);
      pos.setZ(i, this.flagBase[i * 3 + 2] + wave);
    }
    pos.needsUpdate = true;
  }
}
