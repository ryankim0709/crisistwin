import * as THREE from "three";
import type { FireField, Tree, TreeKind, World } from "../types";
import { heightAt } from "../world";
import { hash2, mergeAll, paint, place } from "./geometry";
import { PALETTE } from "./palette";

const TreeFire = { Unburned: 0, Burning: 1, Burned: 2 } as const;

function pineCanopy() {
  return mergeAll([
    place(paint(new THREE.ConeGeometry(2.8, 4.4, 7), 0xffffff), 0, 4.4, 0),
    place(paint(new THREE.ConeGeometry(2.2, 3.6, 7), 0xffffff), 0, 6.5, 0),
    place(paint(new THREE.ConeGeometry(1.5, 2.8, 7), 0xffffff), 0, 8.3, 0),
  ]);
}

function roundCanopy() {
  return mergeAll([
    place(paint(new THREE.IcosahedronGeometry(2.9, 0), 0xffffff), 0, 5.4, 0),
    place(paint(new THREE.IcosahedronGeometry(2.0, 0), 0xffffff), 1.3, 4.5, 0.9),
  ]);
}

function trunk(height: number) {
  return place(paint(new THREE.CylinderGeometry(0.35, 0.55, height, 5), 0xffffff), 0, height / 2, 0);
}

const HOT = new THREE.Color(PALETTE.amber);
const CORAL = new THREE.Color(PALETTE.coral);
const CHAR = new THREE.Color(PALETTE.char);
const TRUNK = new THREE.Color(PALETTE.trunk);
const TRUNK_CHAR = new THREE.Color(0x221d1a);

type Kind = {
  trees: Tree[];
  cell: Int32Array;
  green: THREE.Color[];
  base: THREE.Matrix4[];
  burnedCanopy: THREE.Matrix4[];
  canopy: THREE.InstancedMesh;
  trunk: THREE.InstancedMesh;
  state: Uint8Array;
};

/** Instanced pines and round trees whose canopies follow the fire field per cell. */
export class TreeLayer {
  readonly group = new THREE.Group();
  private readonly fire: FireField;
  private readonly kinds: Kind[] = [];
  private t = -1;
  private readonly tmp = new THREE.Color();

  constructor(world: World, fire: FireField) {
    this.fire = fire;
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    const geos: Record<TreeKind, { canopy: THREE.BufferGeometry; trunk: THREE.BufferGeometry; greens: readonly number[] }> = {
      pine: { canopy: pineCanopy(), trunk: trunk(2.6), greens: PALETTE.pineGreens },
      round: { canopy: roundCanopy(), trunk: trunk(3.6), greens: PALETTE.roundGreens },
    };
    for (const kind of ["pine", "round"] as TreeKind[]) {
      const trees = world.trees.filter((t) => t.kind === kind);
      const g = geos[kind];
      const canopy = new THREE.InstancedMesh(g.canopy, canopyMat, Math.max(1, trees.length));
      const trunkMesh = new THREE.InstancedMesh(g.trunk, trunkMat, Math.max(1, trees.length));
      canopy.count = trees.length;
      trunkMesh.count = trees.length;
      const k: Kind = {
        trees,
        cell: new Int32Array(trees.length),
        green: [],
        base: [],
        burnedCanopy: [],
        canopy,
        trunk: trunkMesh,
        state: new Uint8Array(trees.length),
      };
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      trees.forEach((tree, i) => {
        const col = Math.floor((tree.p.x - fire.originX) / fire.cellSize);
        const row = Math.floor((tree.p.z - fire.originZ) / fire.cellSize);
        k.cell[i] = col >= 0 && row >= 0 && col < fire.cols && row < fire.rows ? row * fire.cols + col : -1;
        const jitter = hash2(tree.p.x, tree.p.z);
        pos.set(tree.p.x, heightAt(tree.p.x, tree.p.z) - 0.3, tree.p.z);
        quat.setFromAxisAngle(up, jitter * Math.PI * 2);
        scale.setScalar(tree.scale);
        const m = new THREE.Matrix4().compose(pos, quat, scale);
        k.base.push(m);
        scale.set(tree.scale * 0.72, tree.scale * 0.8, tree.scale * 0.72);
        k.burnedCanopy.push(new THREE.Matrix4().compose(pos, quat, scale));
        canopy.setMatrixAt(i, m);
        trunkMesh.setMatrixAt(i, m);
        const green = new THREE.Color(g.greens[Math.floor(jitter * g.greens.length) % g.greens.length]).multiplyScalar(0.92 + hash2(tree.p.z, tree.p.x) * 0.16);
        k.green.push(green);
        canopy.setColorAt(i, green);
        trunkMesh.setColorAt(i, TRUNK);
      });
      for (const mesh of [canopy, trunkMesh]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
      }
      canopy.name = `${kind}-canopies`;
      trunkMesh.name = `${kind}-trunks`;
      this.kinds.push(k);
    }
  }

  /** Recomputes per-tree fire state for simulation time `t`. */
  update(t: number) {
    if (t === this.t) return;
    this.t = t;
    const { ignitionTime, burnDuration } = this.fire;
    for (const k of this.kinds) {
      let matrixDirty = false;
      let colorDirty = false;
      for (let i = 0; i < k.trees.length; i++) {
        const cell = k.cell[i];
        const ign = cell >= 0 ? ignitionTime[cell] : Infinity;
        const age = t - ign;
        const state = age < 0 || !Number.isFinite(age) ? TreeFire.Unburned : age < burnDuration ? TreeFire.Burning : TreeFire.Burned;
        if (state === k.state[i] && state !== TreeFire.Burning) continue;
        if ((state === TreeFire.Burned) !== (k.state[i] === TreeFire.Burned)) {
          k.canopy.setMatrixAt(i, state === TreeFire.Burned ? k.burnedCanopy[i] : k.base[i]);
          matrixDirty = true;
        }
        if (state !== k.state[i]) {
          k.trunk.setColorAt(i, state === TreeFire.Burned ? TRUNK_CHAR : TRUNK);
          colorDirty = true;
        }
        k.state[i] = state;
        if (state === TreeFire.Unburned) k.canopy.setColorAt(i, k.green[i]);
        else if (state === TreeFire.Burned) k.canopy.setColorAt(i, CHAR);
        colorDirty = true;
      }
      if (matrixDirty) k.canopy.instanceMatrix.needsUpdate = true;
      if (colorDirty) {
        if (k.canopy.instanceColor) k.canopy.instanceColor.needsUpdate = true;
        if (k.trunk.instanceColor) k.trunk.instanceColor.needsUpdate = true;
      }
    }
    this.flicker(0, true);
  }

  /**
   * Burning canopies: hot amber-coral, values above 1 so tone mapping reads them as glowing,
   * cooling toward char as the cell burns out. Flickers unless reduced motion.
   */
  flicker(time: number, reducedMotion: boolean) {
    const { ignitionTime, burnDuration } = this.fire;
    const c = this.tmp;
    for (const k of this.kinds) {
      let any = false;
      for (let i = 0; i < k.trees.length; i++) {
        if (k.state[i] !== TreeFire.Burning) continue;
        any = true;
        const f = Math.min(1, Math.max(0, (this.t - ignitionTime[k.cell[i]]) / burnDuration));
        const wobble = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 9 + i * 1.7) * Math.sin(time * 5.3 + i * 0.6);
        c.copy(CORAL).lerp(HOT, wobble);
        const glow = (1 - f) * (2.4 + wobble * 1.2);
        c.multiplyScalar(glow).lerp(CHAR, f * f);
        k.canopy.setColorAt(i, c);
      }
      if (any && k.canopy.instanceColor) k.canopy.instanceColor.needsUpdate = true;
    }
  }
}
