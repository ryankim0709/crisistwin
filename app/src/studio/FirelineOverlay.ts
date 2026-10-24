/**
 * Firefighters' control line on the studio's 3D board (a `BoardOverlay`). At the playback
 * minute a line cell that is built and not burned is a dark, low strip (held so far); a line
 * cell the fire has reached is a tall post, red where it was breached and orange where the
 * fire got there before the crew. Shape and colour both carry the state. Draws solver output
 * only (studio/firefighting.ts).
 */

import * as THREE from "three";
import type { BoardFrame } from "../fire/diorama/board";
import type { BoardOverlay } from "../fire/diorama/types";
import type { LandscapeGrid } from "../fire/landscape";
import { FIRELINE_COLORS } from "./firelinePalette";
import { LineStatus, type LinePlan } from "./firefighting";

/** Drawn strip and post sizes, world units. */
const STRIP_HEIGHT = 0.25;
const POST_HEIGHT = 1.6;
const POST_WIDTH_FRACTION = 0.45;

export interface FirelineView {
  grid: LandscapeGrid;
  line: LinePlan;
  /** Final status per line cell (`lineStatus`). */
  status: Uint8Array;
  /** Fire arrival of the run shown, per landscape cell. */
  arrival: Float32Array;
}

export class FirelineOverlay implements BoardOverlay {
  private frame: BoardFrame | null = null;
  private group: THREE.Group | null = null;
  private strips: THREE.InstancedMesh | null = null;
  private posts: THREE.InstancedMesh | null = null;
  private view: FirelineView | null = null;
  /** World position per line cell, or null when off the board. */
  private placed: ({ x: number; y: number; z: number } | null)[] = [];
  private size = 1;
  private minute = -1;
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  attach(frame: BoardFrame, parent: THREE.Group): void {
    this.detach();
    if (!frame.grid) return;
    this.frame = frame;
    this.group = new THREE.Group();
    this.group.name = "fireline-overlay";
    parent.add(this.group);
    this.build();
  }

  detach(): void {
    if (!this.group) return;
    this.group.removeFromParent();
    for (const mesh of [this.strips, this.posts]) {
      mesh?.geometry.dispose();
      (mesh?.material as THREE.Material | undefined)?.dispose();
    }
    this.group = null;
    this.strips = null;
    this.posts = null;
    this.frame = null;
  }

  tick(): void {}

  setView(view: FirelineView | null): void {
    if (view === this.view) return;
    this.view = view;
    this.build();
  }

  /** Playback minute; cheap to call every frame. */
  setMinute(minute: number): void {
    const whole = Math.floor(minute);
    if (whole === this.minute) return;
    this.minute = whole;
    this.paint();
  }

  private build(): void {
    const { frame, group } = this;
    if (!frame || !group) return;
    for (const mesh of [this.strips, this.posts]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.strips = null;
    this.posts = null;
    const view = this.view;
    if (!view || view.line.cells.length === 0) return;
    const { grid, line } = view;
    this.size = Math.max(0.3, grid.groundCellSizeMeters * frame.unitsPerMeter);
    this.placed = Array.from(line.cells, (cell) => {
      const column = cell % grid.width;
      const row = (cell - column) / grid.width;
      const p = frame.fromMercator(
        grid.originX + column * grid.cellSizeX,
        grid.originY + row * grid.cellSizeY,
      );
      if (!p || !frame.inside(p.x, p.z)) return null;
      return { x: p.x, y: frame.surfaceAt(p.x, p.z), z: p.z };
    });
    const count = line.cells.length;
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.strips = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: FIRELINE_COLORS.held, roughness: 0.9 }),
      count,
    );
    this.posts = new THREE.InstancedMesh(
      box.clone(),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
      count,
    );
    this.strips.name = "fireline-built";
    this.posts.name = "fireline-lost";
    group.add(this.strips, this.posts);
    this.minute = -1;
    this.paint();
  }

  private paint(): void {
    const { strips, posts, view } = this;
    if (!strips || !posts || !view) return;
    const minute = this.minute;
    const color = new THREE.Color();
    const s = this.size;
    for (let k = 0; k < this.placed.length; k += 1) {
      const p = this.placed[k];
      const cell = view.line.cells[k];
      const burned = view.arrival[cell] <= minute;
      const built = view.line.holdFromMinute[k] <= minute;
      if (!p || (!burned && !built)) {
        strips.setMatrixAt(k, this.hidden);
        posts.setMatrixAt(k, this.hidden);
        continue;
      }
      if (burned) {
        strips.setMatrixAt(k, this.hidden);
        const w = s * POST_WIDTH_FRACTION;
        posts.setMatrixAt(k, this.matrix.makeScale(w, POST_HEIGHT, w).setPosition(p.x, p.y, p.z));
        const lost =
          view.status[k] === LineStatus.outrun ? FIRELINE_COLORS.outrun : FIRELINE_COLORS.breached;
        posts.setColorAt(k, color.set(lost));
      } else {
        posts.setMatrixAt(k, this.hidden);
        strips.setMatrixAt(k, this.matrix.makeScale(s, STRIP_HEIGHT, s).setPosition(p.x, p.y, p.z));
      }
    }
    strips.instanceMatrix.needsUpdate = true;
    posts.instanceMatrix.needsUpdate = true;
    if (posts.instanceColor) posts.instanceColor.needsUpdate = true;
  }
}
