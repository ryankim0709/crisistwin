import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

/**
 * In-scene labels (CSS2DRenderer). Every class name is prefixed `fdx-` and the stylesheet
 * lives inside the label layer (removed on dispose), so the page needs no CSS for them and
 * should avoid the `fdx-` prefix.
 */
const LABEL_CSS = `
.fdx-canvas:focus { outline: none; }
.fdx-canvas:focus-visible { outline: 3px solid #d65a40; outline-offset: -3px; }
.fdx-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.fdx-label {
  display: flex; align-items: center; gap: 6px; white-space: nowrap; pointer-events: none; user-select: none;
  font: 600 11.5px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.01em;
  color: #2a2e33; background: rgba(251, 248, 241, 0.9); padding: 4px 10px; border-radius: 999px;
  border: 1px solid rgba(60, 55, 50, 0.1);
  box-shadow: 0 1px 2px rgba(40, 35, 30, 0.16), 0 4px 14px rgba(40, 35, 30, 0.1);
}
.fdx-ignition { font-weight: 700; color: #7a2a18; padding: 2px 8px; }
.fdx-wind { font-weight: 500; color: #3a3f45; background: rgba(251, 248, 241, 0.84); }
.fdx-wind-glyph { font-size: 12px; line-height: 1; display: inline-block; color: #8a5a3c; }
.fdx-scale { font-size: 10.5px; padding: 2px 8px; gap: 5px; }
.fdx-scale-bar { display: inline-block; width: 14px; height: 4px; border: 1.5px solid #3a3f45; border-top: none; }
.fdx-place {
  font-size: 10.5px; font-weight: 600; gap: 5px; padding: 2px 8px; color: #3a3f45; letter-spacing: 0.02em;
  background: rgba(251, 248, 241, 0.74); border-color: rgba(60, 55, 50, 0.08); box-shadow: 0 1px 3px rgba(40, 35, 30, 0.14);
}
.fdx-place::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #8a8f94; flex: none; }
.fdx-place-peak::before { border-radius: 0; background: none; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-bottom: 6px solid #8a5a3c; }
.fdx-compact .fdx-place { font-size: 9.5px; padding: 1px 6px; }
.fdx-station { padding: 0; gap: 0; background: none; border: none; box-shadow: none; flex-direction: column; font-weight: 700; }
.fdx-st-badge { display: inline-flex; height: 26px; gap: 5px; padding: 0 10px 0 6px; border-radius: 999px; align-items: center; justify-content: center; background: #c8352a; color: #fff; font-size: 12px; font-weight: 800; letter-spacing: 0.01em; white-space: nowrap; border: 2.5px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.5), 0 0 0 1px rgba(120,20,10,0.5); }
.fdx-st-name { margin-top: 2px; font-size: 11px; padding: 1px 7px; border-radius: 999px; color: #7a1a10; background: rgba(255,255,255,0.94); border: 1px solid rgba(200,53,42,0.5); }
.fdx-st-far .fdx-st-name { display: none; }
.fdx-compact .fdx-st-badge { height: 22px; font-size: 10.5px; }
.fdx-clipped { visibility: hidden; }
.fdx-compact .fdx-label { font-size: 10px; padding: 2px 7px; }
.fdx-compact .fdx-scale { font-size: 9.5px; padding: 1px 6px; }
`;

/** Clear space kept between a place label and any higher-priority rect (CSS px). */
const LABEL_MARGIN_PX = 8;
/** Clear space kept between two ranked pills (see `setPriority`), CSS px. */
const PILL_MARGIN_PX = 3;
/** Camera/time changes smaller than this do not retrigger a declutter pass. */
const TIME_EPSILON_MIN = 0.25;

export type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** Extra, higher-priority inputs to a declutter pass. */
export type ClipOptions = {
  /** Screen rects (e.g. the ignition pin) that place labels must clear. */
  fixed?: ScreenRect[];
  /** Simulation minutes; with `isBurning`, place labels on burning cells are hidden. */
  time?: number;
  /** True when the grid cell is burning at `time`. Burned-out and unburned cells may show labels. */
  isBurning?: (cell: number) => boolean;
  /** Changes whenever `fixed`/`isBurning` inputs change for reasons other than time. */
  stamp?: number;
};

export class LabelLayer {
  readonly renderer: CSS2DRenderer;
  private readonly objects: CSS2DObject[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly cells = new Map<CSS2DObject, number>();
  private readonly sizes = new Map<CSS2DObject, { key: string; w: number; h: number }>();
  private lastKey: number[] = [];
  private compact = false;

  constructor(container: HTMLElement) {
    this.renderer = new CSS2DRenderer();
    const el = this.renderer.domElement;
    el.className = "fdx-layer";
    el.setAttribute("aria-hidden", "true");
    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.pointerEvents = "none";
    const style = document.createElement("style");
    style.textContent = LABEL_CSS;
    el.appendChild(style);
    container.appendChild(el);
  }

  /** A pill whose `center` (0..1 of its box) sits on `position`. */
  add(
    parent: THREE.Object3D,
    className: string,
    position: THREE.Vector3,
    center = new THREE.Vector2(0.5, 1),
  ): { obj: CSS2DObject; el: HTMLDivElement } {
    const el = document.createElement("div");
    el.className = `fdx-label ${className}`;
    const obj = new CSS2DObject(el);
    obj.position.copy(position);
    obj.center.copy(center);
    parent.add(obj);
    this.objects.push(obj);
    return { obj, el };
  }

  /** Labels excluded from overlap checks against each other only after the other pills. */
  private readonly places = new Set<CSS2DObject>();
  /** Pills that yield to each other (and to the unranked pills) by priority, higher first; ties keep add order. */
  private readonly ranks = new Map<CSS2DObject, number>();

  /** Ranks a pill for screen-space collision culling in `clip`: it is hidden when it overlaps a higher-ranked pill. Call `invalidate` after changing ranks. */
  setPriority(obj: CSS2DObject, priority: number): void {
    if (this.ranks.get(obj) === priority) return;
    this.ranks.set(obj, priority);
    this.lastKey = [];
  }

  /** A small reference-place label (decluttered in `clip`); earlier adds win overlaps. */
  addPlace(
    parent: THREE.Object3D,
    text: string,
    kind: "city" | "peak",
    position: THREE.Vector3,
    cell = -1,
  ): CSS2DObject {
    const { obj, el } = this.add(
      parent,
      kind === "peak" ? "fdx-place fdx-place-peak" : "fdx-place",
      position,
      new THREE.Vector2(0.5, 1.15),
    );
    el.textContent = text;
    this.places.add(obj);
    this.cells.set(obj, cell);
    this.lastKey = [];
    return obj;
  }

  remove(obj: CSS2DObject) {
    this.places.delete(obj);
    this.ranks.delete(obj);
    this.cells.delete(obj);
    this.sizes.delete(obj);
    this.lastKey = [];
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
    obj.removeFromParent();
    obj.element.remove();
  }

  /** Forces the next `clip` to redo the declutter pass. */
  invalidate() {
    this.lastKey = [];
  }

  /** Label box size in CSS px, re-measured only when its text or the compact mode changes. */
  private measure(o: CSS2DObject): { w: number; h: number } {
    const key = `${this.compact}|${o.element.textContent}`;
    let m = this.sizes.get(o);
    if (!m || m.key !== key) {
      m = { key, w: o.element.offsetWidth, h: o.element.offsetHeight };
      this.sizes.set(o, m);
    }
    return m;
  }

  /**
   * Hides labels whose anchor projects outside `free` (CSS px rectangle not covered by the
   * page's floating panels). Place labels are then hidden when their screen rect (padded by
   * `LABEL_MARGIN_PX`) meets a higher-priority rect: the ignition pin and wind pill first, then
   * the scale pill, then earlier-added (more important) places. Places on burning cells
   * are hidden too. The pass reruns only when the camera, time bucket or inputs change.
   */
  clip(camera: THREE.Camera, w: number, h: number, free: ScreenRect, opts: ClipOptions = {}) {
    const key = [
      ...camera.matrixWorldInverse.elements,
      ...camera.projectionMatrix.elements.slice(0, 1),
      w,
      h,
      free.left,
      free.top,
      free.right,
      free.bottom,
      opts.stamp ?? 0,
      opts.time ?? 0,
    ];
    const last = this.lastKey;
    let same = last.length === key.length;
    for (let i = 0; same && i < key.length; i++) {
      const tol = i === key.length - 1 ? TIME_EPSILON_MIN : 1e-5;
      if (Math.abs(key[i] - last[i]) > tol) same = false;
    }
    if (same) return;
    this.lastKey = key;

    // Reads first (anchor projection and cached sizes), writes (class toggles) after.
    const taken: ScreenRect[] = [...(opts.fixed ?? [])];
    const pills: { o: CSS2DObject; inside: boolean }[] = [];
    const candidates: { o: CSS2DObject; rect: ScreenRect }[] = [];
    const hidden: CSS2DObject[] = [];
    const project = (o: CSS2DObject) => {
      this.tmp.setFromMatrixPosition(o.matrixWorld).project(camera);
      const x = ((this.tmp.x + 1) / 2) * w;
      const y = ((1 - this.tmp.y) / 2) * h;
      const inside =
        this.tmp.z < 1 &&
        x >= free.left &&
        x <= w - free.right &&
        y >= free.top &&
        y <= h - free.bottom;
      const m = this.measure(o);
      const rect = {
        left: x - m.w * o.center.x,
        top: y - m.h * (1 - o.center.y),
        right: 0,
        bottom: 0,
      };
      rect.right = rect.left + m.w;
      rect.bottom = rect.top + m.h;
      return { inside, rect };
    };
    const wind: CSS2DObject[] = [];
    const furniture: CSS2DObject[] = [];
    const ranked: CSS2DObject[] = [];
    for (const o of this.objects) {
      if (!o.visible || this.places.has(o)) continue;
      if (this.ranks.has(o)) ranked.push(o);
      else (o.element.classList.contains("fdx-wind") ? wind : furniture).push(o);
    }
    ranked.sort((a, b) => this.ranks.get(b)! - this.ranks.get(a)!);
    // Priority: pin (fixed) and wind label, then scale, then places.
    for (const o of [...wind, ...furniture]) {
      const { inside, rect } = project(o);
      pills.push({ o, inside });
      if (inside) taken.push(rect);
    }
    // Ranked pills (overlay labels): kept in priority order unless they overlap one already kept.
    const pm = PILL_MARGIN_PX;
    for (const o of ranked) {
      const { inside, rect } = project(o);
      const clear =
        inside &&
        !taken.some((t) => rect.left < t.right + pm && rect.right + pm > t.left && rect.top < t.bottom + pm && rect.bottom + pm > t.top);
      if (clear) taken.push(rect);
      pills.push({ o, inside: clear });
    }
    for (const o of this.objects) {
      if (!o.visible || !this.places.has(o)) continue;
      const { inside, rect } = project(o);
      const cell = this.cells.get(o) ?? -1;
      if (!inside || (opts.isBurning && cell >= 0 && opts.isBurning(cell))) hidden.push(o);
      else candidates.push({ o, rect });
    }
    const m = LABEL_MARGIN_PX;
    const hits = (a: ScreenRect, b: ScreenRect) =>
      a.left < b.right + m && a.right + m > b.left && a.top < b.bottom + m && a.bottom + m > b.top;
    const shown: CSS2DObject[] = [];
    for (const { o, rect } of candidates) {
      if (taken.some((t) => hits(rect, t))) hidden.push(o);
      else {
        taken.push(rect);
        shown.push(o);
      }
    }
    for (const { o, inside } of pills) o.element.classList.toggle("fdx-clipped", !inside);
    for (const o of shown) o.element.classList.remove("fdx-clipped");
    for (const o of hidden) o.element.classList.add("fdx-clipped");
  }

  setCompact(value: boolean) {
    this.compact = value;
    this.lastKey = [];
    this.renderer.domElement.classList.toggle("fdx-compact", value);
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer.render(scene, camera);
  }

  dispose() {
    for (const o of [...this.objects]) this.remove(o);
    this.renderer.domElement.remove();
  }
}
