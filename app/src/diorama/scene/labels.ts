import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

/**
 * In-scene labels rendered with CSS2DRenderer. All class names are prefixed `dsc-` and the
 * stylesheet lives inside the label layer element (removed on dispose), so page CSS does not
 * need to style them and should avoid the `dsc-` prefix.
 */
const LABEL_CSS = `
.dsc-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.dsc-label {
  display: flex; align-items: center; gap: 6px; white-space: nowrap; pointer-events: none; user-select: none;
  font: 600 11.5px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.01em;
  color: #2a2e33; background: rgba(251, 248, 241, 0.93); padding: 4px 10px 4px 8px; border-radius: 999px;
  border: 1px solid rgba(60, 55, 50, 0.1);
  box-shadow: 0 1px 2px rgba(40, 35, 30, 0.16), 0 4px 14px rgba(40, 35, 30, 0.1);
  transition: border-color 300ms ease, box-shadow 300ms ease;
}
.dsc-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsc-dot--shelter { background: #2fb3c8; box-shadow: 0 0 0 2px rgba(73, 194, 212, 0.25); }
.dsc-dot--station { background: #c4473b; border-radius: 2px; }
.dsc-dot--bridge { background: #6b7480; border-radius: 2px; transform: rotate(45deg); width: 6px; height: 6px; }
.dsc-wind { font-weight: 500; color: #3a3f45; background: rgba(251, 248, 241, 0.8); }
.dsc-badge {
  display: none; font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: #fff; background: #d65a40; padding: 2px 6px; border-radius: 999px;
}
.dsc-label--alert { border-color: rgba(226, 103, 76, 0.85); animation: dsc-pulse 1.8s ease-in-out infinite; }
.dsc-label--alert .dsc-badge { display: inline-block; }
.dsc-reduced .dsc-label--alert { animation: none; box-shadow: 0 0 0 3px rgba(226, 103, 76, 0.22); }
@keyframes dsc-pulse {
  0%, 100% { box-shadow: 0 0 0 2px rgba(226, 103, 76, 0.28), 0 4px 14px rgba(40, 35, 30, 0.1); }
  50% { box-shadow: 0 0 0 7px rgba(226, 103, 76, 0.08), 0 4px 14px rgba(40, 35, 30, 0.1); }
}
@media (prefers-reduced-motion: reduce) { .dsc-label--alert { animation: none; } }
`;

export type LabelKind = "shelter" | "station" | "bridge" | "wind";

export class LabelLayer {
  readonly renderer: CSS2DRenderer;
  private readonly objects: CSS2DObject[] = [];
  private bridgeEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new CSS2DRenderer();
    const el = this.renderer.domElement;
    el.className = "dsc-layer";
    el.setAttribute("aria-hidden", "true");
    // Inline essentials too, in case the stylesheet is blocked by a CSP.
    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.pointerEvents = "none";
    const style = document.createElement("style");
    style.textContent = LABEL_CSS;
    el.appendChild(style);
    container.appendChild(el);
  }

  add(parent: THREE.Object3D, kind: LabelKind, text: string, position: THREE.Vector3): CSS2DObject {
    const el = document.createElement("div");
    el.className = kind === "wind" ? "dsc-label dsc-wind" : "dsc-label";
    if (kind !== "wind") {
      const dot = document.createElement("span");
      dot.className = `dsc-dot dsc-dot--${kind}`;
      el.appendChild(dot);
    }
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    if (kind === "bridge") {
      const badge = document.createElement("span");
      badge.className = "dsc-badge";
      badge.textContent = "Bottleneck";
      el.appendChild(badge);
      this.bridgeEl = el;
    }
    const obj = new CSS2DObject(el);
    obj.position.copy(position);
    obj.center.set(0.5, 1);
    parent.add(obj);
    this.objects.push(obj);
    return obj;
  }

  setBottleneck(active: boolean) {
    this.bridgeEl?.classList.toggle("dsc-label--alert", active);
  }

  setReducedMotion(value: boolean) {
    this.renderer.domElement.classList.toggle("dsc-reduced", value);
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer.render(scene, camera);
  }

  dispose() {
    for (const o of this.objects) {
      o.removeFromParent();
      o.element.remove();
    }
    this.renderer.domElement.remove();
  }
}
