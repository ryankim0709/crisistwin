/**
 * Fire-station markers for every 3D diorama (one shared look): a red firehouse block with a white
 * roof stripe on a tall thin white pole, topped by a round red badge (a CSS2D label, so it keeps
 * its screen size). The marker group is scaled with camera distance so it stays visible when
 * zoomed out. Zoom tiers: far = badge only, mid = badge + short name, near = name + suffix.
 * Observed (current) CAL FIRE facility locations; the replay adds "today's station".
 */

import * as THREE from "three";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { STATION_STYLE, type MapStation } from "../../maps/stations";
import { lonLatToMercator } from "../landscape";
import type { BoardFrame } from "./board";
import type { LabelLayer } from "./labels";

export const STATION_LEGEND_3D = "Fire station";

const POLE_H = 9;
/** Camera distance (fraction of the fit distance) beyond which only badges show / names show. */
const FAR = 0.85;
const NEAR = 0.45;

// Fire-service Maltese cross (cross pattée), white on the red badge.
const BADGE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 12 8.5 2.5h7Zm0 0 9.5-3.5v7Zm0 0 3.5 9.5h-7Zm0 0L2.5 15.5v-7Z" fill="#fff"/><circle cx="12" cy="12" r="2.6" fill="#fff"/></svg>';

/** "Paradise FS · CAL FIRE" -> "Paradise FS". */
function shortName(label: string): string {
  return label.split(" · ")[0].replace(/\s*\(.*\)\s*$/, "");
}

export class StationMarkers {
  private group: THREE.Group | null = null;
  private labels: LabelLayer | null = null;
  private items: { obj: CSS2DObject; el: HTMLDivElement }[] = [];
  private tier = "";
  private scale = 1;

  /** Rebuild for a board; stations off the board are dropped. */
  build(frame: BoardFrame, parent: THREE.Object3D, labels: LabelLayer, stations: readonly MapStation[], suffix: string): void {
    this.dispose();
    if (!frame.grid || stations.length === 0) return;
    const group = new THREE.Group();
    group.name = "station-markers";
    parent.add(group);
    this.group = group;
    this.labels = labels;
    const red = new THREE.MeshStandardMaterial({ color: STATION_STYLE.roof, roughness: 0.55 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const pole = new THREE.CylinderGeometry(0.22, 0.22, POLE_H, 6).translate(0, POLE_H / 2, 0);
    const block = new THREE.BoxGeometry(4.4, 2.8, 3.4).translate(0, 1.4, 0);
    const stripe = new THREE.BoxGeometry(4.6, 0.55, 3.6).translate(0, 3.05, 0);
    for (const s of stations) {
      const [mx, my] = lonLatToMercator(s.lon, s.lat);
      const p = frame.fromMercator(mx, my);
      if (!p || !frame.inside(p.x, p.z)) continue;
      const g = new THREE.Group();
      g.position.set(p.x, frame.surfaceAt(p.x, p.z), p.z);
      const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        return m;
      };
      g.add(mesh(block, red), mesh(stripe, white), mesh(pole, white));
      group.add(g);
      const l = labels.add(g, "fdx-station", new THREE.Vector3(0, POLE_H + 1.2, 0), new THREE.Vector2(0.5, 1));
      const name = shortName(s.label);
      l.el.innerHTML = `<span class="fdx-st-badge">${BADGE_SVG}<span class="fdx-st-kind">Fire station</span></span><span class="fdx-st-name"></span>`;
      const nameEl = l.el.querySelector(".fdx-st-name") as HTMLElement;
      nameEl.textContent = suffix ? `${name} · ${suffix}` : name;
      l.el.title = s.label + (suffix ? ` · ${suffix}` : "");
      this.items.push(l);
    }
    this.tier = "";
    this.scale = 0;
  }

  /** Scale with distance and pick the zoom tier. */
  tick(distance: number, fit: number): void {
    if (!this.group || fit <= 0) return;
    const ratio = distance / fit;
    const scale = THREE.MathUtils.clamp(ratio * 1.6, 0.7, 4);
    if (Math.abs(scale - this.scale) > 0.02) {
      this.scale = scale;
      for (const g of this.group.children) g.scale.setScalar(scale);
    }
    const tier = ratio > FAR ? "far" : ratio > NEAR ? "mid" : "near";
    if (tier !== this.tier) {
      this.tier = tier;
      for (const { el } of this.items) {
        el.classList.toggle("fdx-st-far", tier === "far");
        el.classList.toggle("fdx-st-near", tier === "near");
      }
      this.labels?.invalidate();
    }
  }

  dispose(): void {
    for (const { obj } of this.items) this.labels?.remove(obj);
    this.items = [];
    if (this.group) {
      this.group.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
      this.group.removeFromParent();
    }
    this.group = null;
  }
}
