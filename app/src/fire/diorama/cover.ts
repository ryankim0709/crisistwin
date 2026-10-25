import * as THREE from "three";
import { gableRoof, hash2, mergeAll, paint, place } from "../../diorama/scene/geometry";
import { PALETTE } from "../../diorama/scene/palette";
import type { BoardFrame } from "./board";
import type { BoardHome, ProjectedStreets } from "./streets";
import { BUSH_DENSITY, FALLBACK_CANOPY, FuelFamily, PINE_SHARE } from "./fuelStyle";

/** Instance caps (totals across kinds); dense or large grids are thinned uniformly. */
export const COVER_CAPS = { trees: 18_000, bushes: 7_000, houses: 6_000 } as const;
/**
 * Miniature scale of the /diorama tree shapes (≈9.7 units tall at scale 1). Trees are drawn
 * at a constant stylized size on the 600-unit board, loosely varied by canopy height.
 */
const TREE_SCALE = 0.27;
/** Cells with at least this canopy cover, or timber fuel classes, count as forest (closed canopy). */
const FOREST_COVER = 0.4;
/** Share of the tree cap the closed-canopy forest may use; the rest is for open ground. */
const FOREST_CAP_SHARE = 0.75;
const CLOSE_SKIP = new Set<FuelFamily>([
  FuelFamily.Water,
  FuelFamily.None,
  FuelFamily.Urban,
  FuelFamily.Barren,
  FuelFamily.Snow,
]);
const isTimber = (f: FuelFamily) =>
  f === FuelFamily.TimberUnderstory || f === FuelFamily.TimberLitter;
const BUSH_RADIUS = 0.55;
/** Base house footprint (world units) before neighbourhood spacing scales it up. */
const HOUSE = { w: 1.25, d: 0.95, h: 0.75, rise: 0.48, spacingX: 2.3, spacingZ: 2.7 } as const;
/** Every Nth house row in a neighbourhood is left empty as a street. */
const STREET_EVERY = 4;
/** Side of the square neighbourhoods that share one street-grid heading (world units). */
const NEIGHBOURHOOD = 56;
const NEIGHBOURHOOD_ANGLES = [0, 0, 0.14, -0.2, 0.35, -0.42, 0.62, 0.08] as const;
/** Houses on real streets: footprint width (ground metres) kept within a world-unit range. */
const STREET_HOUSE_METERS = 26;
const STREET_HOUSE_UNITS = { min: 0.5, max: 2.2 } as const;
const HOUSE_ROOFS = [0xc27a5a, 0x6f7b86, 0x8fa182] as const;

/**
 * Regional-scale tuning (see `BoardFrame.blockMix`): at tens of km per board a house or tree
 * is a sub-pixel speck, so trees become larger soft clumps (value-noise masses of
 * `CLUMP_UNITS` world units) and houses fewer, larger and jittered off their lattice rows.
 */
const CLUMP_UNITS = 16;
const REGIONAL = {
  treeScale: 1.5,
  treeCapCut: 0.15,
  bushScale: 1.2,
  bushCapCut: 0.6,
  houseSize: 1.0,
  houseJitter: 0.5,
  houseDrop: 0.2,
  treeSpread: 2.0,
} as const;

/** Smooth value noise (0..1) on a lattice of `size` world units. */
function valueNoise(x: number, z: number, size: number) {
  const fx = x / size;
  const fz = z / size;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = hash2(ix * 1.13, iz * 0.87);
  const b = hash2((ix + 1) * 1.13, iz * 0.87);
  const c = hash2(ix * 1.13, (iz + 1) * 0.87);
  const d = hash2((ix + 1) * 1.13, (iz + 1) * 0.87);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

const State = { Unburned: 0, Burning: 1, Burned: 2 } as const;

const HOT = new THREE.Color(PALETTE.amber);
const CORAL = new THREE.Color(PALETTE.coral);
const CHAR = new THREE.Color(PALETTE.char);

type Part = {
  mesh: THREE.InstancedMesh;
  /** Unburned colour per instance (rgb). */
  base: Float32Array;
  burned: THREE.Color;
  /** Burning instances glow and flicker on this part. */
  glows: boolean;
};

/**
 * Instances standing on grid cells whose look follows the fire arrival field: burning →
 * flickering amber-coral glow, burned → charred and shrunk by the `burnScale` constructor argument.
 */
class FireInstances {
  readonly count: number;
  private readonly cells: Int32Array;
  private readonly matrices: Float32Array;
  private readonly parts: Part[];
  private arrival: Float32Array;
  private readonly state: Uint8Array;
  private burning: number[] = [];
  private window = 20;
  private t = -Infinity;
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Matrix4();
  private readonly c = new THREE.Color();

  constructor(cells: Int32Array, matrices: Float32Array, parts: Part[], burnScale: THREE.Vector3) {
    this.count = cells.length;
    this.cells = cells;
    this.matrices = matrices;
    this.parts = parts;
    this.arrival = new Float32Array(this.count).fill(Infinity);
    this.state = new Uint8Array(this.count);
    this.s.makeScale(burnScale.x, burnScale.y, burnScale.z);
    for (const p of parts) {
      for (let i = 0; i < this.count; i++) {
        this.m.fromArray(matrices, i * 16);
        p.mesh.setMatrixAt(i, this.m);
        this.c.fromArray(p.base, i * 3);
        p.mesh.setColorAt(i, this.c);
      }
      p.mesh.count = this.count;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
      p.mesh.computeBoundingSphere();
      p.mesh.computeBoundingBox();
    }
  }

  /** Per-instance arrival (minutes; Infinity = never), clamped to the run horizon. */
  setArrival(arrival: Float32Array | null, horizon: number, window: number) {
    this.window = window;
    for (let i = 0; i < this.count; i++) {
      const a = arrival ? arrival[this.cells[i]] : Infinity;
      this.arrival[i] = a <= horizon ? a : Infinity;
    }
    this.t = Number.NaN;
  }

  update(t: number) {
    if (t === this.t) return;
    this.t = t;
    this.burning = [];
    let matrixDirty = false;
    let colorDirty = false;
    for (let i = 0; i < this.count; i++) {
      const age = t - this.arrival[i];
      const state = !(age >= 0) ? State.Unburned : age < this.window ? State.Burning : State.Burned;
      if (state === State.Burning) this.burning.push(i);
      const prev = this.state[i];
      if (state === prev) continue;
      this.state[i] = state;
      if ((state === State.Burned) !== (prev === State.Burned)) {
        this.m.fromArray(this.matrices, i * 16);
        if (state === State.Burned) this.m.multiply(this.s);
        for (const p of this.parts) p.mesh.setMatrixAt(i, this.m);
        matrixDirty = true;
      }
      for (const p of this.parts) {
        if (state === State.Burned) p.mesh.setColorAt(i, p.burned);
        else if (state === State.Unburned || !p.glows)
          p.mesh.setColorAt(
            i,
            this.c.fromArray(p.base, i * 3).lerp(CHAR, state === State.Burning ? 0.55 : 0),
          );
      }
      colorDirty = true;
    }
    for (const p of this.parts) {
      if (matrixDirty) p.mesh.instanceMatrix.needsUpdate = true;
      if (colorDirty && p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
    this.flicker(0, true);
  }

  /** Burning glow: values above 1 so tone mapping reads it as light; cools toward char. */
  flicker(time: number, reducedMotion: boolean) {
    if (this.burning.length === 0) return;
    const c = this.c;
    for (const p of this.parts) {
      if (!p.glows) continue;
      for (const i of this.burning) {
        const f = Math.min(1, Math.max(0, (this.t - this.arrival[i]) / this.window));
        const wobble = reducedMotion
          ? 0.5
          : 0.5 + 0.5 * Math.sin(time * 9 + i * 1.7) * Math.sin(time * 5.3 + i * 0.6);
        c.copy(CORAL).lerp(HOT, wobble);
        c.multiplyScalar((1 - f) * (1.15 + wobble * 0.55)).lerp(CHAR, f * f);
        p.mesh.setColorAt(i, c);
      }
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }
}

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
  return place(
    paint(new THREE.CylinderGeometry(0.35, 0.55, height, 5), 0xffffff),
    0,
    height / 2,
    0,
  );
}

function bushShape() {
  return mergeAll([
    place(paint(new THREE.IcosahedronGeometry(1, 0), 0xffffff), 0, 0.55, 0),
    place(paint(new THREE.IcosahedronGeometry(0.7, 0), 0xffffff), 0.75, 0.4, 0.3),
  ]);
}

/** Unit house body (1×1×1, base at y = 0) and a unit gable roof (eaves at y = 0, rise 1). */
function houseShapes() {
  const body = place(paint(new THREE.BoxGeometry(1, 1, 1), 0xffffff), 0, 0.5, 0);
  const roof = mergeAll(gableRoof(1, 1, 1, 0.09, 0xffffff, 0xffffff));
  return { body, roof };
}

type Placement = { cells: number[]; m: number[]; colorsA: number[]; colorsB: number[] };
const newPlacement = (): Placement => ({ cells: [], m: [], colorsA: [], colorsB: [] });

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const tmpColor = new THREE.Color();

function pushInstance(
  p: Placement,
  cell: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number,
) {
  tmpPos.set(x, y, z);
  tmpQuat.setFromAxisAngle(UP, yaw);
  tmpScale.set(sx, sy, sz);
  tmpMat.compose(tmpPos, tmpQuat, tmpScale);
  p.cells.push(cell);
  for (const v of tmpMat.elements) p.m.push(v);
}

function pushColor(arr: number[], hex: number, jitter: number) {
  tmpColor.set(hex).multiplyScalar(jitter);
  arr.push(tmpColor.r, tmpColor.g, tmpColor.b);
}

/** Trees, bushes and houses standing for the fuel classes (stylized, deterministic). */
export class CoverLayer {
  readonly group = new THREE.Group();
  private readonly sets: FireInstances[] = [];
  readonly counts = { trees: 0, bushes: 0, houses: 0 };
  /** Whether instances cast shadows (off on regional boards where they are sub-pixel). */
  private shadows = true;

  /** With `streets`, trees keep off the roads and houses stand along residential streets. */
  constructor(frame: BoardFrame, streets: ProjectedStreets | null = null) {
    const grid = frame.grid;
    if (!grid) return;
    const { cols, rows, families, cellWorld } = frame;
    const cover = grid.canopyCoverFraction;
    const heightM = grid.canopyHeightMeters;
    const useCanopy = grid.canopyComplete;
    const n = cols * rows;
    const blend = frame.blockMix;
    this.shadows = blend < 0.6;
    const treeCap = Math.round(COVER_CAPS.trees * (1 - REGIONAL.treeCapCut * blend));
    const bushCap = Math.round(COVER_CAPS.bushes * (1 - REGIONAL.bushCapCut * blend));

    // --- Trees and bushes: one candidate slot each per cell, thinned to the caps.
    const treeP = new Float32Array(n);
    const forest = new Uint8Array(n);
    const bushP = new Float32Array(n);
    let treeSum = 0;
    let bushSum = 0;
    for (let i = 0; i < n; i++) {
      const fam = families[i] as FuelFamily;
      if (fam === FuelFamily.Water || fam === FuelFamily.None) continue;
      const cc = useCanopy ? cover[i] || 0 : FALLBACK_CANOPY[fam];
      let t = Math.min(1, cc) * (fam === FuelFamily.Urban ? 0.4 : 1);
      if (isTimber(fam) || (cc >= FOREST_COVER && fam !== FuelFamily.Urban)) forest[i] = 1;
      if (blend > 0 && t > 0) {
        // Forest masses: modulate density by smooth noise so trees gather into soft clumps.
        const c = i % cols;
        const x = (c + 0.5 - cols / 2) * cellWorld;
        const z = ((i - c) / cols + 0.5 - rows / 2) * cellWorld;
        const clump =
          0.1 + 1.9 * THREE.MathUtils.smoothstep(valueNoise(x, z, CLUMP_UNITS), 0.3, 0.7);
        t = Math.min(1, t * THREE.MathUtils.lerp(1, clump, blend));
      }
      treeP[i] = t;
      treeSum += t;
      const b = BUSH_DENSITY[fam] * (1 - Math.min(1, cc) * 0.5);
      bushP[i] = b;
      bushSum += b;
    }
    // Close small holes: a vegetated cell mostly ringed by forest is forest too.
    const closed = forest.slice();
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (forest[i]) continue;
        const fam = families[i] as FuelFamily;
        if (CLOSE_SKIP.has(fam)) continue;
        let k = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && forest[i + dr * cols + dc]) k++;
        if (k >= 6) closed[i] = 1;
      }
    }
    forest.set(closed);
    let forestCells = 0;
    for (let i = 0; i < n; i++) if (forest[i]) forestCells++;
    // Everything outside forest keeps the original sampling and thinning.
    const treeThin = Math.min(1, treeCap / Math.max(1, treeSum));
    const bushThin = Math.min(1, bushCap / Math.max(1, bushSum));
    const pines = newPlacement();
    const rounds = newPlacement();
    const bushes = newPlacement();
    const centre = { x: 0, z: 0 };
    const addTree = (i: number, c: number, r: number, x: number, z: number) => {
      const fam = families[i] as FuelFamily;
      // Stands: conifer share varies smoothly by block so pines cluster.
      const stand =
        blend < 0.01
          ? hash2(Math.floor(c / 11) * 3.1, Math.floor(r / 11) * 1.7)
          : hash2(Math.floor(x / 24) * 3.1, Math.floor(z / 24) * 1.7);
      const tall = useCanopy ? THREE.MathUtils.clamp((heightM[i] || 0) / 30, 0, 1.2) : 0.5;
      const pine =
        hash2(c * 2.3, r * 0.37) < PINE_SHARE[fam] * (0.5 + stand) + (tall > 0.8 ? 0.15 : 0);
      const jitter = hash2(x, z);
      const s =
        TREE_SCALE *
        (1 + (REGIONAL.treeScale - 1) * blend) *
        (0.7 + 0.5 * Math.min(1, tall)) *
        (0.85 + 0.3 * jitter);
      const p = pine ? pines : rounds;
      pushInstance(p, i, x, frame.heightAt(x, z) - 0.1, z, jitter * Math.PI * 2, s, s, s);
      const greens = pine ? PALETTE.pineGreens : PALETTE.roundGreens;
      pushColor(
        p.colorsA,
        greens[Math.floor(jitter * greens.length) % greens.length],
        0.92 + hash2(z, x) * 0.16,
      );
      pushColor(p.colorsB, PALETTE.trunk, 1);
    };
    // Closed canopy: one jittered tree per spacing-sized block of forest, the spacing set by
    // the tree's crown width, or wider when the forest budget needs it (even, never cut off).
    const forestCap = Math.round(treeCap * FOREST_CAP_SHARE);
    const crown = 5.8 * TREE_SCALE * (1 + (REGIONAL.treeScale - 1) * blend) * 0.95;
    const spacing = Math.max(
      crown * 0.75,
      Math.sqrt((forestCells * cellWorld * cellWorld) / Math.max(1, forestCap)),
    );
    let nonForestTrees = 0;
    for (let bz = -frame.halfD; bz < frame.halfD; bz += spacing) {
      for (let bx = -frame.halfW; bx < frame.halfW; bx += spacing) {
        const bi = Math.round(bx / spacing + 1000) * 7.31 + Math.round(bz / spacing + 1000) * 1.77;
        const x = bx + hash2(bi, 0.37) * spacing;
        const z = bz + hash2(0.91, bi) * spacing;
        if (!frame.inside(x, z)) continue;
        const at = frame.cellAt(x, z);
        if (at < 0 || !forest[at]) continue;
        if (streets?.onRoad(x, z)) continue;
        addTree(at, at % cols, Math.floor(at / cols), x, z);
      }
    }
    const forestTrees = pines.cells.length + rounds.cells.length;
    const nonForestCap = Math.max(Math.round(treeCap * 0.2), treeCap - forestTrees);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (
          !forest[i] &&
          treeP[i] > 0 &&
          nonForestTrees < nonForestCap &&
          hash2(c * 0.913, r * 1.171) < treeP[i] * treeThin
        ) {
          frame.cellCentre(c, r, centre);
          const spread = cellWorld * 0.8 + blend * REGIONAL.treeSpread;
          const x = centre.x + (hash2(c, r * 1.3) - 0.5) * spread;
          const z = centre.z + (hash2(r * 0.7, c * 1.9) - 0.5) * spread;
          if (blend > 0 && !frame.inside(x, z)) continue;
          if (blend > 0) {
            const at = frame.cellAt(x, z);
            if (at < 0 || families[at] === FuelFamily.Water) continue;
          }
          if (streets?.onRoad(x, z)) continue;
          addTree(i, c, r, x, z);
          nonForestTrees++;
        }
        if (
          bushP[i] > 0 &&
          bushes.cells.length < bushCap &&
          hash2(c * 1.37 + 5.1, r * 0.79) < bushP[i] * bushThin
        ) {
          frame.cellCentre(c, r, centre);
          const x = centre.x + (hash2(c * 1.1, r * 2.9) - 0.5) * cellWorld * 0.9;
          const z = centre.z + (hash2(r * 3.3, c * 0.6) - 0.5) * cellWorld * 0.9;
          if (streets?.onRoad(x, z)) continue;
          const j = hash2(x * 1.3, z * 0.7);
          const s = BUSH_RADIUS * (1 + (REGIONAL.bushScale - 1) * blend) * (0.7 + 0.6 * j);
          pushInstance(bushes, i, x, frame.heightAt(x, z) - 0.08, z, j * 6.28, s, s * 0.7, s);
          pushColor(bushes.colorsA, j < 0.5 ? 0x7d8552 : 0x8b8d58, 0.9 + hash2(z, x * 2) * 0.18);
        }
      }
    }
    this.counts.trees = pines.cells.length + rounds.cells.length;
    this.counts.bushes = bushes.cells.length;

    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      flatShading: true,
    });
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      flatShading: true,
    });
    const trunkChar = new THREE.Color(0x221d1a);
    const kinds: [Placement, THREE.BufferGeometry, THREE.BufferGeometry, string][] = [
      [pines, pineCanopy(), trunk(2.6), "pine"],
      [rounds, roundCanopy(), trunk(3.6), "round"],
    ];
    for (const [p, canopyGeo, trunkGeo, name] of kinds) {
      if (p.cells.length === 0) {
        canopyGeo.dispose();
        trunkGeo.dispose();
        continue;
      }
      const canopy = this.instanced(canopyGeo, canopyMat, p.cells.length, `${name}-canopies`);
      const trunkMesh = this.instanced(trunkGeo, trunkMat, p.cells.length, `${name}-trunks`);
      this.sets.push(
        new FireInstances(
          Int32Array.from(p.cells),
          Float32Array.from(p.m),
          [
            { mesh: canopy, base: Float32Array.from(p.colorsA), burned: CHAR, glows: true },
            {
              mesh: trunkMesh,
              base: Float32Array.from(p.colorsB),
              burned: trunkChar,
              glows: false,
            },
          ],
          new THREE.Vector3(0.72, 0.78, 0.72),
        ),
      );
    }
    if (bushes.cells.length) {
      const bushMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.9,
        flatShading: true,
      });
      const mesh = this.instanced(bushShape(), bushMat, bushes.cells.length, "bushes");
      this.sets.push(
        new FireInstances(
          Int32Array.from(bushes.cells),
          Float32Array.from(bushes.m),
          [{ mesh, base: Float32Array.from(bushes.colorsA), burned: CHAR, glows: true }],
          new THREE.Vector3(0.7, 0.45, 0.7),
        ),
      );
    }

    if (streets && streets.homes.length > 0) this.buildStreetHouses(frame, streets.homes);
    else this.buildHouses(frame);
  }

  /** One house per synthetic home, set back from its street and facing it. */
  private buildStreetHouses(frame: BoardFrame, homes: readonly BoardHome[]) {
    const size = THREE.MathUtils.clamp(
      STREET_HOUSE_METERS * frame.unitsPerMeter,
      STREET_HOUSE_UNITS.min,
      STREET_HOUSE_UNITS.max,
    );
    const p = newPlacement();
    const roofTops: number[] = [];
    for (const home of homes) {
      const { x, z, yaw, cell } = home;
      const j = hash2(x * 0.53, z * 0.91);
      const w = size * (0.85 + 0.3 * hash2(z, x));
      const d = size * 0.75 * (0.85 + 0.25 * j);
      const ht = size * 0.5 * (0.9 + 0.35 * hash2(x * 2.1, z));
      const hw = Math.max(w, d) / 2;
      const corners = [
        frame.heightAt(x - hw, z - hw),
        frame.heightAt(x + hw, z - hw),
        frame.heightAt(x - hw, z + hw),
        frame.heightAt(x + hw, z + hw),
      ];
      const ground = Math.min(...corners);
      const top = Math.max(...corners);
      pushInstance(p, cell, x, ground - 0.15, z, yaw, w, ht + (top - ground) + 0.15, d);
      pushColor(
        p.colorsA,
        PALETTE.walls[Math.floor(j * PALETTE.walls.length) % PALETTE.walls.length],
        1,
      );
      pushColor(
        p.colorsB,
        HOUSE_ROOFS[Math.floor(hash2(x, z * 3.1) * HOUSE_ROOFS.length)],
        0.95 + 0.1 * j,
      );
      roofTops.push(top + ht, size * 0.38);
    }
    this.addHouses(p, roofTops);
  }

  /**
   * Houses on a rotated street lattice per neighbourhood, kept only where the lattice point
   * falls in an urban (91) cell. Spacing (and house size, a little) grows so the expected
   * count meets the cap instead of thinning neighbourhoods into scattered dots.
   */
  private buildHouses(frame: BoardFrame) {
    const { families, cols, rows, cellWorld, halfW, halfD } = frame;
    let urban = 0;
    for (let i = 0; i < families.length; i++) if (families[i] === FuelFamily.Urban) urban++;
    if (urban === 0) return;
    const area = urban * cellWorld * cellWorld;
    const perHouse = HOUSE.spacingX * HOUSE.spacingZ * (STREET_EVERY / (STREET_EVERY - 1));
    const grow = Math.max(1, Math.sqrt(area / perHouse / (COVER_CAPS.houses * 0.92)));
    const sx = HOUSE.spacingX * Math.max(grow, 1 + REGIONAL.houseSize * frame.blockMix);
    const sz = HOUSE.spacingZ * Math.max(grow, 1 + REGIONAL.houseSize * frame.blockMix);
    const blend = frame.blockMix;
    // Regional boards: houses stay a few pixels wide, so size has a floor; spacing follows size.
    const size = Math.max(Math.min(grow, 1.7), 1 + REGIONAL.houseSize * blend);
    const p = newPlacement();
    /** Roof eave height and rise per placed house, parallel to `p`. */
    const roofTops: number[] = [];
    const nbx = Math.ceil((2 * halfW) / NEIGHBOURHOOD);
    const nbz = Math.ceil((2 * halfD) / NEIGHBOURHOOD);
    for (let bz = 0; bz < nbz && p.cells.length < COVER_CAPS.houses; bz++) {
      for (let bx = 0; bx < nbx && p.cells.length < COVER_CAPS.houses; bx++) {
        const x0 = -halfW + bx * NEIGHBOURHOOD;
        const z0 = -halfD + bz * NEIGHBOURHOOD;
        // Skip neighbourhoods without urban cells quickly (sample the block's cells sparsely).
        const cA = Math.floor((x0 + halfW) / cellWorld);
        const rA = Math.floor((z0 + halfD) / cellWorld);
        const span = Math.ceil(NEIGHBOURHOOD / cellWorld);
        let any = false;
        const step = Math.max(1, Math.floor(span / 12));
        for (let r = rA; r < Math.min(rows, rA + span) && !any; r += step) {
          for (let c = cA; c < Math.min(cols, cA + span); c += step)
            if (families[r * cols + c] === FuelFamily.Urban) any = true;
        }
        if (!any) continue;
        const h = hash2(bx * 1.31 + 0.2, bz * 0.77 + 9.1);
        const angle =
          NEIGHBOURHOOD_ANGLES[
            Math.floor(h * NEIGHBOURHOOD_ANGLES.length) % NEIGHBOURHOOD_ANGLES.length
          ];
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const cx = x0 + NEIGHBOURHOOD / 2;
        const cz = z0 + NEIGHBOURHOOD / 2;
        const reach = Math.ceil((NEIGHBOURHOOD * 0.75) / Math.min(sx, sz));
        // Lattice anchored on a board-wide phase so neighbouring blocks with the same heading line up.
        for (let v = -reach; v <= reach; v++) {
          if ((((v + Math.round(cz / sz)) % STREET_EVERY) + STREET_EVERY) % STREET_EVERY === 0)
            continue;
          for (let u = -reach; u <= reach; u++) {
            const lx = u * sx + (v % 2 ? sx * 0.12 : 0);
            const lz = v * sz;
            const jx =
              blend > 0
                ? (hash2(u * 1.7 + bx * 13.1, v * 2.3 + bz * 7.7) - 0.5) *
                  sx *
                  REGIONAL.houseJitter *
                  blend
                : 0;
            const jz =
              blend > 0
                ? (hash2(u * 2.9 + bz * 5.3, v * 1.1 + bx * 3.9) - 0.5) *
                  sz *
                  REGIONAL.houseJitter *
                  blend
                : 0;
            const x = cx + (lx + jx) * ca + (lz + jz) * sa;
            const z = cz - (lx + jx) * sa + (lz + jz) * ca;
            if (x < x0 || x >= x0 + NEIGHBOURHOOD || z < z0 || z >= z0 + NEIGHBOURHOOD) continue;
            if (Math.abs(x) > halfW - 0.8 || Math.abs(z) > halfD - 0.8) continue;
            const cell = frame.cellAt(x, z);
            if (cell < 0 || families[cell] !== FuelFamily.Urban) continue;
            if (p.cells.length >= COVER_CAPS.houses) break;
            const j = hash2(x * 0.53, z * 0.91);
            if (j < 0.06 + REGIONAL.houseDrop * blend) continue; // the odd empty lot
            const w = HOUSE.w * size * (0.85 + 0.3 * hash2(z, x));
            const d = HOUSE.d * size * (0.85 + 0.25 * j);
            const ht = HOUSE.h * size * (0.9 + 0.35 * hash2(x * 2.1, z));
            const hw = Math.max(w, d) / 2;
            const ground = Math.min(
              frame.heightAt(x - hw, z - hw),
              frame.heightAt(x + hw, z - hw),
              frame.heightAt(x - hw, z + hw),
              frame.heightAt(x + hw, z + hw),
            );
            const top = Math.max(
              frame.heightAt(x - hw, z - hw),
              frame.heightAt(x + hw, z - hw),
              frame.heightAt(x - hw, z + hw),
              frame.heightAt(x + hw, z + hw),
            );
            const yaw = angle + (j > 0.5 ? 0 : Math.PI / 2) * (hash2(u, v + bx) > 0.8 ? 1 : 0);
            // Body tall enough to meet the uphill ground; roof above it.
            pushInstance(p, cell, x, ground - 0.15, z, yaw, w, ht + (top - ground) + 0.15, d);
            const roofIdx = Math.floor(hash2(x, z * 3.1) * 3);
            pushColor(
              p.colorsA,
              PALETTE.walls[Math.floor(j * PALETTE.walls.length) % PALETTE.walls.length],
              1,
            );
            pushColor(p.colorsB, HOUSE_ROOFS[roofIdx], 0.95 + 0.1 * j);
            roofTops.push(top + ht, HOUSE.rise * size);
          }
        }
      }
    }
    this.addHouses(p, roofTops);
  }

  /** House bodies and roofs (eave height and rise per house in `roofTops`) that burn. */
  private addHouses(p: Placement, roofTops: number[]) {
    if (p.cells.length === 0) return;
    this.counts.houses = p.cells.length;
    const shapes = houseShapes();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      flatShading: true,
    });
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const bodies = this.instanced(shapes.body, mat, p.cells.length, "houses");
    const roofs = this.instanced(shapes.roof, roofMat, p.cells.length, "roofs");
    // Roofs need their own matrices (offset up, unit rise scaled), so they get a second set.
    const roofM = new Float32Array(p.m.length);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (let i = 0; i < p.cells.length; i++) {
      tmpMat.fromArray(p.m, i * 16).decompose(pos, quat, scl);
      pos.y = roofTops[i * 2];
      scl.y = roofTops[i * 2 + 1];
      tmpMat.compose(pos, quat, scl).toArray(roofM, i * 16);
    }
    const cells = Int32Array.from(p.cells);
    const burnedWall = new THREE.Color(0x4f4842);
    this.sets.push(
      new FireInstances(
        cells,
        Float32Array.from(p.m),
        [{ mesh: bodies, base: Float32Array.from(p.colorsA), burned: burnedWall, glows: false }],
        new THREE.Vector3(1, 1, 1),
      ),
      new FireInstances(
        cells,
        roofM,
        [{ mesh: roofs, base: Float32Array.from(p.colorsB), burned: CHAR, glows: true }],
        new THREE.Vector3(1, 0.5, 1),
      ),
    );
  }

  private instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  setArrival(arrival: Float32Array | null, horizon: number, window: number) {
    for (const s of this.sets) s.setArrival(arrival, horizon, window);
  }

  update(t: number) {
    for (const s of this.sets) s.update(t);
  }

  flicker(time: number, reducedMotion: boolean) {
    for (const s of this.sets) s.flicker(time, reducedMotion);
  }
}
