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
.fdx-wind { font-weight: 500; color: #3a3f45; background: rgba(251, 248, 241, 0.84); }
.fdx-wind-glyph { font-size: 12px; line-height: 1; display: inline-block; color: #8a5a3c; }
.fdx-north {
  width: 26px; height: 26px; padding: 0; justify-content: center; border-radius: 50%;
  font: 700 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #2a2e33;
  flex-direction: column; gap: 0;
}
.fdx-north::before { content: ""; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-bottom: 6px solid #d65a40; margin-bottom: 1px; }
.fdx-scale { font-size: 10.5px; padding: 2px 8px; gap: 5px; }
.fdx-scale-bar { display: inline-block; width: 14px; height: 4px; border: 1.5px solid #3a3f45; border-top: none; }
.fdx-clipped { visibility: hidden; }
.fdx-compact .fdx-label { font-size: 10px; padding: 2px 7px; }
.fdx-compact .fdx-north { width: 22px; height: 22px; padding: 0; }
.fdx-compact .fdx-scale { font-size: 9.5px; padding: 1px 6px; }
`;

export class LabelLayer {
  readonly renderer: CSS2DRenderer;
  private readonly objects: CSS2DObject[] = [];
  private readonly tmp = new THREE.Vector3();

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
  add(parent: THREE.Object3D, className: string, position: THREE.Vector3, center = new THREE.Vector2(0.5, 1)): { obj: CSS2DObject; el: HTMLDivElement } {
    const el = document.createElement("div");
    el.className = `fdx-label ${className}`;
    const obj = new CSS2DObject(el);
    obj.position.copy(position);
    obj.center.copy(center);
    parent.add(obj);
    this.objects.push(obj);
    return { obj, el };
  }

  remove(obj: CSS2DObject) {
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
    obj.removeFromParent();
    obj.element.remove();
  }

  /**
   * Hides labels whose anchor projects outside `free` (CSS px rectangle not covered by the
   * page's floating panels), so pills never sit on top of page UI.
   */
  clip(camera: THREE.Camera, w: number, h: number, free: { left: number; top: number; right: number; bottom: number }) {
    for (const o of this.objects) {
      if (!o.visible) continue;
      this.tmp.setFromMatrixPosition(o.matrixWorld).project(camera);
      const x = ((this.tmp.x + 1) / 2) * w;
      const y = ((1 - this.tmp.y) / 2) * h;
      const inside = this.tmp.z < 1 && x >= free.left && x <= w - free.right && y >= free.top && y <= h - free.bottom;
      o.element.classList.toggle("fdx-clipped", !inside);
    }
  }

  setCompact(value: boolean) {
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
