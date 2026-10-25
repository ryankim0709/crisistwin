/**
 * Fire-station markers for every 3D diorama (one shared look): a red firehouse block with a white
 * roof stripe on a tall thin white pole, topped by a round red badge (a CSS2D label, so it keeps
 * its screen size). The marker group is scaled with camera distance so it stays visible when
 * zoomed out. No text labels: the red firehouse with its beacon is the marker.
 * Observed (current) CAL FIRE facility locations; the replay adds "today's station".
 */

import * as THREE from "three";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { STATION_STYLE, type MapStation } from "../../maps/stations";
import { lonLatToMercator } from "../landscape";
import type { BoardFrame } from "./board";
import type { LabelLayer } from "./labels";

export const STATION_LEGEND_3D = "Fire station";

/** Camera distance (fraction of the fit distance) beyond which only badges show / names show. */
const FAR = 0.85;
const NEAR = 0.45;



export class StationMarkers {
  private group: THREE.Group | null = null;
  private labels: LabelLayer | null = null;
  private items: { obj: CSS2DObject; el: HTMLDivElement }[] = [];
  private tier = "";
  private scale = 1;

  /** Rebuild for a board; stations off the board are dropped. */
  build(frame: BoardFrame, parent: THREE.Object3D, labels: LabelLayer, stations: readonly MapStation[], _suffix: string): void {
    this.dispose();
    if (!frame.grid || stations.length === 0) return;
    const group = new THREE.Group();
    group.name = "station-markers";
    parent.add(group);
    this.group = group;
    this.labels = labels;
    const red = new THREE.MeshStandardMaterial({ color: STATION_STYLE.roof, roughness: 0.55 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    // A red firehouse with a white hipped roof, a dark apparatus-bay door and a glowing red
    // beacon on top: distinct from the board's ordinary homes without a label.
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 });
    const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: 0xff2a1a, emissiveIntensity: 0.9 });
    const block = new THREE.BoxGeometry(4.4, 2.8, 3.4).translate(0, 1.4, 0);
    const stripe = new THREE.BoxGeometry(4.6, 0.45, 3.6).translate(0, 2.9, 0);
    const roof = new THREE.ConeGeometry(3.4, 1.6, 4).rotateY(Math.PI / 4).scale(1, 1, 0.8).translate(0, 3.9, 0);
    const door = new THREE.BoxGeometry(2.4, 1.9, 0.12).translate(0, 0.95, 1.72);
    const beacon = new THREE.SphereGeometry(0.55, 12, 8).translate(0, 5.0, 0);
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
      g.add(mesh(block, red), mesh(stripe, white), mesh(roof, white), mesh(door, dark), mesh(beacon, beaconMat));
      group.add(g);
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
