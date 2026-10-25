/**
 * The replay's evacuation zones on the 3D diorama (a `BoardOverlay`, fire/diorama/types.ts): the
 * outline of each zone under an evacuation order or warning at the replay clock, draped on the
 * terrain. Zones with no order or warning are not drawn. Reads the replay bundle's own zones and
 * order/warning events; it never changes them.
 */

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BoardFrame } from "../fire/diorama/board";
import type { LabelLayer } from "../fire/diorama/labels";
import type { BoardOverlay } from "../fire/diorama/types";
import { lonLatToMercator } from "../fire/landscape";
import type { LngLat, Zone } from "./types";

/** Colours baked into the 3D board (CSS cannot reach WebGL); the legend mirrors them. */
export const REPLAY_3D_COLORS = {
  ordered: "#d1342a",
  warned: "#c77700",
} as const;

export type ReplayZoneState = "ordered" | "warned";

const ZONE_LIFT = 0.6;
const DRAPE_STEP = 1.5;

/** Outer rings of a zone (one per polygon). */
function outerRings(zone: Zone): LngLat[][] {
  const g = zone.geometry;
  return g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((poly) => poly[0]);
}

export class ReplayBoardOverlay implements BoardOverlay {
  private frame: BoardFrame | null = null;
  private group: THREE.Group | null = null;
  private zones: readonly Zone[] = [];
  private states: ReadonlyMap<string, ReplayZoneState> = new Map();
  private key = "";
  private lines: THREE.Group | null = null;
  private readonly materials = new Set<LineMaterial>();

  attach(frame: BoardFrame, parent: THREE.Group, _labels: LabelLayer): void {
    this.detach();
    if (!frame.grid) return;
    this.frame = frame;
    this.group = new THREE.Group();
    this.group.name = "replay-board-overlay";
    parent.add(this.group);
    this.key = "";
    this.rebuild();
  }

  detach(): void {
    this.clearLines();
    this.group?.removeFromParent();
    this.group = null;
    this.frame = null;
  }

  tick(_time: number, _dt: number, _reducedMotion: boolean, width: number, height: number): void {
    for (const material of this.materials) material.resolution.set(width, height);
  }

  /** Zones and their order/warning state at the replay clock; call again whenever it changes. */
  setZones(zones: readonly Zone[], states: ReadonlyMap<string, ReplayZoneState>): void {
    this.zones = zones;
    this.states = states;
    this.rebuild();
  }

  private clearLines(): void {
    if (!this.lines) return;
    this.lines.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.material instanceof LineMaterial) this.materials.delete(mesh.material);
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.lines.removeFromParent();
    this.lines = null;
  }

  /** The ring on the ground, resampled every DRAPE_STEP; parts off the board are dropped. */
  private drape(path: readonly LngLat[]): number[] {
    const frame = this.frame!;
    const out: number[] = [];
    let previous: { x: number; z: number } | null = null;
    for (const [lon, lat] of path) {
      const [mx, my] = lonLatToMercator(lon, lat);
      const p = frame.fromMercator(mx, my);
      if (!p || !frame.inside(p.x, p.z)) {
        previous = null;
        continue;
      }
      if (previous) {
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - previous.x, p.z - previous.z) / DRAPE_STEP));
        for (let s = 1; s <= steps; s += 1) {
          const x = previous.x + ((p.x - previous.x) * s) / steps;
          const z = previous.z + ((p.z - previous.z) * s) / steps;
          out.push(x, frame.surfaceAt(x, z) + ZONE_LIFT, z);
        }
      } else out.push(p.x, frame.surfaceAt(p.x, p.z) + ZONE_LIFT, p.z);
      previous = p;
    }
    return out;
  }

  private rebuild(): void {
    if (!this.group) return;
    const key = this.zones.map((z) => `${z.id}:${this.states.get(z.id) ?? ""}`).join("|");
    if (key === this.key && this.lines) return;
    this.key = key;
    this.clearLines();
    const group = new THREE.Group();
    group.name = "replay-zones";
    this.group.add(group);
    this.lines = group;
    for (const zone of this.zones) {
      const state = this.states.get(zone.id);
      if (!state) continue;
      for (const ring of outerRings(zone)) {
        if (ring.length < 3) continue;
        const positions = this.drape(ring);
        if (positions.length < 6) continue;
        const geometry = new LineGeometry();
        geometry.setPositions(positions);
        const material = new LineMaterial({
          color: new THREE.Color(REPLAY_3D_COLORS[state]).getHex(),
          linewidth: state === "ordered" ? 3.5 : 3,
          worldUnits: false,
          dashed: state === "warned",
          dashSize: 1.6,
          gapSize: 1.2,
          transparent: true,
          opacity: 0.95,
        });
        this.materials.add(material);
        const line = new Line2(geometry, material);
        if (state === "warned") line.computeLineDistances();
        line.renderOrder = 3;
        group.add(line);
      }
    }
  }
}
