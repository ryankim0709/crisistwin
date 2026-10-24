/**
 * Real streets on the board: OpenStreetMap roads draped on the terrain as lit ribbons, and the
 * synthetic homes placed along residential streets (both from `GET /api/dispatch/area`, ADR
 * 0017), projected into board space for the cover layer. Presentation only: road widths are
 * exaggerated to stay readable at miniature scale, and homes are planning placeholders, not
 * observed buildings.
 */

import * as THREE from "three";
import { PALETTE } from "../../diorama/scene/palette";
import { lonLatToMercator } from "../landscape";
import type { BoardFrame } from "./board";
import type { BoardStreets } from "./types";

type Style = {
  /** Drawn width: true-ish ground metres, but never thinner than `minUnits` world units. */
  meters: number;
  minUnits: number;
  color: number;
  /** Pale kerb drawn under the road (major roads only), extra world units of width. */
  casing: number;
  /** Draw order; higher classes sit on top at junctions. */
  rank: number;
};

const MINOR: Style = {
  meters: 9,
  minUnits: 0.45,
  color: PALETTE.roadResidential,
  casing: 0,
  rank: 0,
};
const TERTIARY: Style = {
  meters: 11,
  minUnits: 0.6,
  color: PALETTE.roadResidential,
  casing: 0.18,
  rank: 1,
};
const SECONDARY: Style = {
  meters: 14,
  minUnits: 0.8,
  color: PALETTE.roadMain,
  casing: 0.22,
  rank: 2,
};
const PRIMARY: Style = {
  meters: 16,
  minUnits: 0.95,
  color: PALETTE.roadMain,
  casing: 0.26,
  rank: 3,
};
const MOTORWAY: Style = { meters: 24, minUnits: 1.35, color: 0x5d6570, casing: 0.3, rank: 4 };

const STYLE_BY_CLASS: Record<string, Style> = {
  motorway: MOTORWAY,
  motorway_link: SECONDARY,
  trunk: MOTORWAY,
  trunk_link: SECONDARY,
  primary: PRIMARY,
  primary_link: TERTIARY,
  secondary: SECONDARY,
  secondary_link: TERTIARY,
  tertiary: TERTIARY,
  tertiary_link: MINOR,
};
const CASING_COLOR = PALETTE.stone;

/** Road surfaces float this far above the ground (plus a hair per rank against z-fighting). */
const LIFT = 0.14;
const RANK_LIFT = 0.02;
/** Ribbons are resampled to at most this many world units per step so they follow relief. */
const DRAPE_STEP = 1.2;
/** Occupancy raster for "is there a road here" (world units per texel). */
const MASK_CELL = 0.5;
/** Keep trees this far (world units) clear of a road edge. */
const TREE_CLEARANCE = 0.35;
/** Bucket size (world units) for finding the street each home faces. */
const FACE_SEARCH = 3;

type Pt = { x: number; z: number };
type Road = { style: Style; width: number; pts: Pt[] };

export type BoardHome = { x: number; z: number; yaw: number; cell: number };

/** Streets projected onto one board. */
export class ProjectedStreets {
  readonly roads: Road[];
  readonly homes: BoardHome[];
  private readonly mask: Uint8Array;
  private readonly maskW: number;
  private readonly maskH: number;
  private readonly halfW: number;
  private readonly halfD: number;

  constructor(frame: BoardFrame, streets: BoardStreets) {
    this.halfW = frame.halfW;
    this.halfD = frame.halfD;
    this.maskW = Math.ceil((2 * frame.halfW) / MASK_CELL);
    this.maskH = Math.ceil((2 * frame.halfD) / MASK_CELL);
    this.mask = new Uint8Array(this.maskW * this.maskH);

    const toWorld = (lon: number, lat: number): Pt | null => {
      const [mx, my] = lonLatToMercator(lon, lat);
      const p = frame.fromMercator(mx, my);
      return p && frame.inside(p.x, p.z) ? p : null;
    };

    this.roads = [];
    for (const edge of streets.edges) {
      const style = STYLE_BY_CLASS[edge.roadClass] ?? MINOR;
      const width = Math.max(style.meters * frame.unitsPerMeter, style.minUnits);
      // Split where the line leaves the board.
      let run: Pt[] = [];
      for (const [lon, lat] of edge.coords) {
        const p = toWorld(lon, lat);
        if (p) run.push(p);
        else {
          if (run.length > 1) this.roads.push({ style, width, pts: run });
          run = [];
        }
      }
      if (run.length > 1) this.roads.push({ style, width, pts: run });
    }
    this.roads.sort((a, b) => a.style.rank - b.style.rank);
    for (const road of this.roads) this.rasterize(road.pts, road.width / 2 + road.style.casing);

    // Segment buckets, to turn each home to face its street.
    const bucket = new Map<number, [Pt, Pt][]>();
    const key = (bx: number, bz: number) => bx * 65_536 + bz;
    for (const road of this.roads) {
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1];
        const b = road.pts[i];
        const x0 = Math.floor(Math.min(a.x, b.x) / FACE_SEARCH);
        const x1 = Math.floor(Math.max(a.x, b.x) / FACE_SEARCH);
        const z0 = Math.floor(Math.min(a.z, b.z) / FACE_SEARCH);
        const z1 = Math.floor(Math.max(a.z, b.z) / FACE_SEARCH);
        for (let bx = x0; bx <= x1; bx++) {
          for (let bz = z0; bz <= z1; bz++) {
            const k = key(bx, bz);
            const list = bucket.get(k);
            if (list) list.push([a, b]);
            else bucket.set(k, [[a, b]]);
          }
        }
      }
    }

    this.homes = [];
    for (const home of streets.homes) {
      const p = toWorld(home.position[0], home.position[1]);
      if (!p) continue;
      const cell = frame.cellAt(p.x, p.z);
      if (cell < 0) continue;
      let best = Infinity;
      let yaw = 0;
      const bx = Math.floor(p.x / FACE_SEARCH);
      const bz = Math.floor(p.z / FACE_SEARCH);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const [a, b] of bucket.get(key(bx + dx, bz + dz)) ?? []) {
            const d = segmentDistance(p, a, b);
            if (d < best) {
              best = d;
              yaw = -Math.atan2(b.z - a.z, b.x - a.x);
            }
          }
        }
      }
      this.homes.push({ x: p.x, z: p.z, yaw, cell });
    }
  }

  /** True when (x, z) lies on or within a tree's clearance of a drawn road. */
  onRoad(x: number, z: number): boolean {
    const c = Math.floor((x + this.halfW) / MASK_CELL);
    const r = Math.floor((z + this.halfD) / MASK_CELL);
    if (c < 0 || r < 0 || c >= this.maskW || r >= this.maskH) return false;
    return this.mask[r * this.maskW + c] === 1;
  }

  private rasterize(pts: Pt[], halfWidth: number) {
    const reach = halfWidth + TREE_CLEARANCE;
    const step = MASK_CELL * 0.5;
    const span = Math.ceil(reach / MASK_CELL);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s <= n; s++) {
        const x = a.x + ((b.x - a.x) * s) / n;
        const z = a.z + ((b.z - a.z) * s) / n;
        const c0 = Math.floor((x + this.halfW) / MASK_CELL);
        const r0 = Math.floor((z + this.halfD) / MASK_CELL);
        for (let dr = -span; dr <= span; dr++) {
          const r = r0 + dr;
          if (r < 0 || r >= this.maskH) continue;
          for (let dc = -span; dc <= span; dc++) {
            const c = c0 + dc;
            if (c < 0 || c >= this.maskW) continue;
            if ((dc * dc + dr * dr) * MASK_CELL * MASK_CELL <= reach * reach)
              this.mask[r * this.maskW + c] = 1;
          }
        }
      }
    }
  }
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len2 = vx * vx + vz * vz;
  const t =
    len2 > 0 ? THREE.MathUtils.clamp(((p.x - a.x) * vx + (p.z - a.z) * vz) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

/** One merged, vertex-coloured mesh of every road ribbon (casings under the road surfaces). */
export function buildStreetMesh(frame: BoardFrame, streets: ProjectedStreets): THREE.Mesh | null {
  if (streets.roads.length === 0) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();

  const ribbon = (pts: Pt[], width: number, lift: number, hex: number) => {
    const line = resample(pts, DRAPE_STEP);
    if (line.length < 2) return;
    color.set(hex);
    const base = positions.length / 3;
    for (let i = 0; i < line.length; i++) {
      const prev = line[Math.max(0, i - 1)];
      const next = line[Math.min(line.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      for (const side of [0.5, -0.5]) {
        const x = line[i].x + tz * side * width;
        const z = line[i].z - tx * side * width;
        positions.push(x, frame.surfaceAt(x, z) + lift, z);
        colors.push(color.r, color.g, color.b);
      }
    }
    for (let i = 0; i < line.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    // Round-ish end caps so junctions close: a small disc at each end.
    for (const end of [line[0], line[line.length - 1]]) disc(end, width / 2, lift, hex);
  };

  const disc = (p: Pt, radius: number, lift: number, hex: number) => {
    const segments = 10;
    color.set(hex);
    const centre = positions.length / 3;
    positions.push(p.x, frame.surfaceAt(p.x, p.z) + lift, p.z);
    colors.push(color.r, color.g, color.b);
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      const x = p.x + Math.cos(a) * radius;
      const z = p.z + Math.sin(a) * radius;
      positions.push(x, frame.surfaceAt(x, z) + lift, z);
      colors.push(color.r, color.g, color.b);
    }
    for (let k = 0; k < segments; k++)
      indices.push(centre, centre + 1 + ((k + 1) % segments), centre + 1 + k);
  };

  for (const road of streets.roads) {
    if (road.style.casing > 0)
      ribbon(road.pts, road.width + road.style.casing * 2, LIFT, CASING_COLOR);
  }
  for (const road of streets.roads)
    ribbon(road.pts, road.width, LIFT + RANK_LIFT * (road.style.rank + 1), road.style.color);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "streets";
  mesh.receiveShadow = true;
  return mesh;
}

function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let s = 1; s <= n; s++)
      out.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
  }
  return out;
}
