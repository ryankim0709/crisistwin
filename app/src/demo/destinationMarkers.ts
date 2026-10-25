/**
 * Evacuation safe areas (the destinations of the board's zone routes) on the /live board's 3D view:
 * a white pole with a green pennant over a green assembly pad, a fill gauge beside it (vehicles
 * arrived vs the destination's capacity) and a short label. Scaled with camera distance like the
 * station markers (fire/diorama/stationMarkers.ts) so they stay visible zoomed out. Display only;
 * the counts are the board's simulated traffic (model.ts zoneCounts x vehiclesPerHousehold).
 */

import * as THREE from "three";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { BoardFrame } from "../fire/diorama/board";
import type { LabelLayer } from "../fire/diorama/labels";
import { lonLatToMercator } from "../fire/landscape";
import type { LonLat } from "../live/types";
import { DESTINATION_COLORS } from "./board3dPalette";
import { activeRoute, vehiclesPerHousehold, zoneCounts, type Board } from "./model";

export interface DestinationMark {
  id: string;
  name: string;
  kind: string;
  coord: LonLat;
  /** Vehicles it can take; null = unknown (an exit road). */
  capacityVeh: number | null;
  /** Simulated vehicles arrived there / still driving there. */
  arrivedVeh: number;
  enRouteVeh: number;
}

/** Every destination the zones' route options reach (a dedicated board list, when present, wins for name/coord/capacity). */
export function destinationMarks(board: Board): DestinationMark[] {
  const marks = new Map<string, DestinationMark>();
  const listed = (board as { destinations?: { id: string; name: string; coord: LonLat; capacityVeh?: number | null; kind?: string }[] }).destinations;
  for (const d of listed ?? []) {
    marks.set(d.id, { id: d.id, name: d.name, kind: d.kind ?? "safe_area", coord: d.coord, capacityVeh: d.capacityVeh ?? null, arrivedVeh: 0, enRouteVeh: 0 });
  }
  for (const options of board.routes.values()) {
    for (const o of options) {
      if (marks.has(o.destination_id) || o.line.length === 0) continue;
      marks.set(o.destination_id, {
        id: o.destination_id,
        name: o.name,
        kind: o.kind,
        coord: o.line[o.line.length - 1],
        capacityVeh: o.destination_capacity_veh,
        arrivedVeh: 0,
        enRouteVeh: 0,
      });
    }
  }
  for (const zone of board.zones) {
    const route = activeRoute(zone);
    const mark = route ? marks.get(route.destination_id) : undefined;
    if (!mark) continue;
    const c = zoneCounts(zone, board.minute);
    const vph = vehiclesPerHousehold(zone);
    mark.arrivedVeh += Math.max(0, c.out) * vph;
    mark.enRouteVeh += Math.max(0, c.enRoute) * vph;
  }
  return [...marks.values()].map((m) => ({ ...m, arrivedVeh: Math.round(m.arrivedVeh), enRouteVeh: Math.round(m.enRouteVeh) }));
}

const LABEL_CSS = `
.fdx-dmdest { font-size: 10px; padding: 2px 7px; font-weight: 600; line-height: 1.25; text-align: center; white-space: nowrap; }
.fdx-dmdest b { display: block; font-weight: 700; }
.fdx-dmdest-full b::after { content: " · FULL"; }
.fdx-compact .fdx-dmdest { font-size: 9px; padding: 1px 6px; }
`;

/** Marker parts, world units at scale 1 (exaggerated like the station marker). */
const POLE_H = 7;
const GAUGE = { w: 1.1, h: 5, d: 1.1, x: 2.2 } as const;
const BUSY = 0.7;
const NEAR_FULL = 0.95;
/** Gauge shown when the capacity is unknown (a share of the frame). */
const UNKNOWN_FILL = 0.15;

function shortName(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

type Item = { id: string; root: THREE.Group; fill: THREE.Mesh; label: { obj: CSS2DObject; el: HTMLDivElement } };

export class DestinationMarkers {
  private group: THREE.Group | null = null;
  private labels: LabelLayer | null = null;
  private style: HTMLStyleElement | null = null;
  private items: Item[] = [];
  private key = "";
  private scale = 0;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private fillMats: Record<"ok" | "busy" | "full" | "unknown", THREE.MeshStandardMaterial> | null = null;

  update(frame: BoardFrame, parent: THREE.Object3D, labels: LabelLayer, marks: readonly DestinationMark[]): void {
    const key = marks.map((m) => `${m.id}@${m.coord.join(",")}`).join("|");
    if (key !== this.key || !this.group || this.group.parent !== parent) {
      this.dispose();
      this.key = key;
      this.build(frame, parent, labels, marks);
    }
    const byId = new Map(marks.map((m) => [m.id, m]));
    for (const item of this.items) {
      const m = byId.get(item.id);
      if (!m) continue;
      const share = m.capacityVeh && m.capacityVeh > 0 ? m.arrivedVeh / m.capacityVeh : null;
      const shown = share === null ? UNKNOWN_FILL : Math.min(1, Math.max(0.02, share));
      item.fill.scale.y = shown;
      const mats = this.fillMats!;
      item.fill.material = share === null ? mats.unknown : share >= NEAR_FULL ? mats.full : share >= BUSY ? mats.busy : mats.ok;
      const count =
        m.capacityVeh && m.capacityVeh > 0 ? `${m.arrivedVeh} of ${m.capacityVeh} cars` : `${m.arrivedVeh} cars · capacity unknown`;
      const text = `${count}${m.enRouteVeh > 0 ? ` (+${m.enRouteVeh} on the way)` : ""}`;
      const title = `Safe area · ${shortName(m.name)}`;
      const full = share !== null && share >= 1;
      if (item.label.el.dataset.text !== `${title}|${text}|${full}`) {
        item.label.el.dataset.text = `${title}|${text}|${full}`;
        item.label.el.replaceChildren();
        const b = document.createElement("b");
        b.textContent = title;
        item.label.el.append(b, document.createTextNode(text));
        item.label.el.classList.toggle("fdx-dmdest-full", full);
        item.label.el.title = m.name;
        labels.invalidate();
      }
    }
  }

  private build(frame: BoardFrame, parent: THREE.Object3D, labels: LabelLayer, marks: readonly DestinationMark[]): void {
    if (!frame.grid || marks.length === 0) return;
    const group = new THREE.Group();
    group.name = "demo-destinations";
    parent.add(group);
    this.group = group;
    this.labels = labels;
    this.style = document.createElement("style");
    this.style.textContent = LABEL_CSS;
    labels.renderer.domElement.appendChild(this.style);
    const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
      this.materials.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geometries.push(g);
      return g;
    };
    const green = mat(DESTINATION_COLORS.marker);
    const white = mat(DESTINATION_COLORS.pole);
    const frameMat = mat(DESTINATION_COLORS.gaugeFrame, { wireframe: true });
    this.fillMats = {
      ok: mat(DESTINATION_COLORS.gaugeOk),
      busy: mat(DESTINATION_COLORS.gaugeBusy),
      full: mat(DESTINATION_COLORS.gaugeFull),
      unknown: mat(DESTINATION_COLORS.gaugeUnknown),
    };
    const pad = geo(new THREE.CylinderGeometry(3.2, 3.4, 0.35, 20).translate(0, 0.17, 0));
    const pole = geo(new THREE.CylinderGeometry(0.16, 0.16, POLE_H, 6).translate(0, POLE_H / 2, 0));
    // Pennant: a triangle flying east from the pole top.
    const flagShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(2.6, -0.8), new THREE.Vector2(0, -1.6)]);
    const flag = geo(new THREE.ShapeGeometry(flagShape).translate(0.1, POLE_H, 0));
    const frameBox = geo(new THREE.BoxGeometry(GAUGE.w, GAUGE.h, GAUGE.d).translate(GAUGE.x, GAUGE.h / 2 + 0.35, 0));
    // Fill grows from the bottom: geometry base at y=0, scaled in y.
    const fillBox = geo(new THREE.BoxGeometry(GAUGE.w * 0.8, GAUGE.h, GAUGE.d * 0.8).translate(0, GAUGE.h / 2, 0));
    const flagMat = mat(DESTINATION_COLORS.marker, { side: THREE.DoubleSide });
    for (const m of marks) {
      const [mx, my] = lonLatToMercator(m.coord[0], m.coord[1]);
      const p = frame.fromMercator(mx, my);
      if (!p || !frame.inside(p.x, p.z)) continue;
      const root = new THREE.Group();
      root.position.set(p.x, frame.surfaceAt(p.x, p.z), p.z);
      const fill = new THREE.Mesh(fillBox, this.fillMats.ok);
      fill.position.set(GAUGE.x, 0.35, 0);
      root.add(new THREE.Mesh(pad, green), new THREE.Mesh(pole, white), new THREE.Mesh(flag, flagMat), new THREE.Mesh(frameBox, frameMat), fill);
      for (const c of root.children) c.castShadow = true;
      group.add(root);
      const label = labels.add(root, "fdx-dmdest", new THREE.Vector3(0, POLE_H + 1.2, 0), new THREE.Vector2(0.5, 1));
      this.items.push({ id: m.id, root, fill, label });
    }
    this.scale = 0;
  }

  /** Scale with camera distance (as StationMarkers.tick) so the markers stay readable zoomed out. */
  tick(distance: number, fit: number): void {
    if (!this.group || fit <= 0) return;
    const scale = THREE.MathUtils.clamp((distance / fit) * 1.6, 0.7, 4);
    if (Math.abs(scale - this.scale) <= 0.02) return;
    this.scale = scale;
    for (const item of this.items) item.root.scale.setScalar(scale);
  }

  dispose(): void {
    for (const item of this.items) this.labels?.remove(item.label.obj);
    this.items = [];
    this.group?.removeFromParent();
    this.group = null;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.fillMats = null;
    this.style?.remove();
    this.style = null;
    this.key = "";
  }
}
