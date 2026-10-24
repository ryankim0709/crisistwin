/**
 * Several `BoardOverlay`s on one board: the scene takes a single overlay, so a page drawing
 * more than one (the studio's evacuation and control lines) sets this and swaps its children.
 */

import type * as THREE from "three";
import type { BoardFrame } from "./board";
import type { LabelLayer } from "./labels";
import type { BoardOverlay } from "./types";

export class CompositeOverlay implements BoardOverlay {
  private children: readonly BoardOverlay[] = [];
  private attached: { frame: BoardFrame; parent: THREE.Group; labels: LabelLayer } | null = null;

  /** Replace the children, attaching new ones and detaching dropped ones if on a board. */
  setChildren(children: readonly BoardOverlay[]): void {
    const before = this.children;
    this.children = children;
    if (!this.attached) return;
    const { frame, parent, labels } = this.attached;
    for (const child of before) if (!children.includes(child)) child.detach();
    for (const child of children) if (!before.includes(child)) child.attach(frame, parent, labels);
  }

  attach(frame: BoardFrame, parent: THREE.Group, labels: LabelLayer): void {
    this.attached = { frame, parent, labels };
    for (const child of this.children) child.attach(frame, parent, labels);
  }

  detach(): void {
    for (const child of this.children) child.detach();
    this.attached = null;
  }

  tick(time: number, dt: number, reducedMotion: boolean, width: number, height: number): void {
    for (const child of this.children) child.tick(time, dt, reducedMotion, width, height);
  }
}
