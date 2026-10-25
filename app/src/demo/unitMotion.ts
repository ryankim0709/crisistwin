/**
 * Display-only smoothing of the command board's road units (fire units, and any other vehicle
 * whose position comes from a model path function at a board minute, e.g. transport buses).
 * Used by the 2D map layers (boardMapLayers.ts) and the 3D overlay (DemoBoardOverlay.ts). It
 * never changes the board, its physics or its timing; it only decides where to draw.
 *
 * - The board clock steps about 5 times a second (useCommandBoard TICK_MS), so drawing units at
 *   board.minute makes them hop. Each frame a display minute chases the latest board minute
 *   over about one update interval (never ahead of the model, never back in time), and each
 *   unit is drawn with the model's own path function at that minute: along its road polyline,
 *   not on a chord between updates. A reset, a new board or a large jump snaps.
 * - Heading follows the road a few board seconds ahead, eased (no snapping at corners).
 * - A unit whose leg changes (reroute, road leg arriving for a pending trip, arrival, release)
 *   glides from where it is drawn to its new path over BLEND_MS instead of teleporting.
 * - Units at one spot (standing on scene or at a station, or driving together in a convoy) fan
 *   out on small deterministic offsets (by id, eased as groups change) instead of stacking; the
 *   offsets are in "slot" units (neighbours about 1 apart) that each renderer scales to pixels or
 *   world units. Standing and driving units are grouped separately. The first unit by id is
 *   the group's lead (a renderer can label the group there).
 * - prefers-reduced-motion: no interpolation, glides or easing; units snap to the board's
 *   positions on each board update.
 */

import type { LonLat } from "../live/types";
import { distanceM, teamPosition, type Board } from "./model";

/** Something drawn on the board that may drive along a road line. */
export interface MotionSubject {
  id: string;
  /**
   * The model's position at the minute of `view` (a read-only view of the board whose `minute`
   * is the display minute; pass it to the model's own position function, e.g. teamPosition).
   * Null when it is not on the board.
   */
  at(view: Board): LonLat | null;
  /** Driving on a road line now (heading follows the road; no standing offset). */
  moving: boolean;
  /** What identifies its current leg (compared element by element); a change glides. */
  leg: readonly unknown[];
}

/** Where to draw a subject this frame. */
export interface MotionDisplay {
  /** Smoothed model position (WGS84), before the standing offset. */
  at: LonLat;
  /** Offset from the others at its spot, slot units, [east, north] (0,0 for a lone unit). */
  offset: [number, number];
  /** Heading, degrees true (clockwise from north); null until it has driven. */
  heading: number | null;
  moving: boolean;
  /** Group it is in (2+ standing, or 2+ driving, units at one spot), else null. `ids` sorted, lead first. */
  group: { lead: string; ids: string[] } | null;
}

/** Glide from the drawn position onto a changed leg, ms. */
const BLEND_MS = 650;
/** Farther than this the glide would sweep across the board: snap instead, metres. */
const BLEND_MAX_M = 2500;
/** Heading look-ahead along the road, board minutes (about 5 s of driving). */
const HEADING_LOOK_MIN = 0.08;
/** Heading and offset easing rates, 1/s (exponential). */
const HEADING_RATE = 5;
const OFFSET_RATE = 6;
/** Units closer than this share a spot, metres. */
const GROUP_M = 45;
/** Display-minute chase duration bounds, ms (about one board update). */
const CHASE_MIN_MS = 60;
const CHASE_MAX_MS = 600;
/** A jump of more board minutes than this in one update snaps (e.g. catching up after a hold). */
const SNAP_MINUTES = 30;
/** A ring up to this many units; a Vogel spiral beyond. */
const RING_MAX = 7;

type Track = {
  subject: MotionSubject;
  pos: LonLat | null;
  heading: number | null;
  blend: { from: LonLat; start: number } | null;
  offset: [number, number];
  target: [number, number];
  group: MotionDisplay["group"];
};

/** A view of `board` at another minute (prototype read-through; nothing is copied or written to the board). */
function viewAt(board: Board, minute: number): Board {
  const view = Object.create(board) as Board;
  view.minute = minute;
  return view;
}

const sameLeg = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const smooth = (k: number) => k * k * (3 - 2 * k);
const lerp = (a: LonLat, b: LonLat, k: number): LonLat => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

/** Bearing from p to q, degrees true (flat approximation; units move metres per frame). */
function bearing(p: LonLat, q: LonLat): number {
  const dx = (q[0] - p[0]) * Math.cos((p[1] * Math.PI) / 180);
  const dy = q[1] - p[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Slot `i` of `n` standing units, [east, north], neighbours about one slot unit apart. */
export function standingSlot(i: number, n: number): [number, number] {
  if (n <= 1) return [0, 0];
  if (n <= RING_MAX) {
    const r = 1 / (2 * Math.sin(Math.PI / n));
    const a = Math.PI / 2 - (i * 2 * Math.PI) / n; // lead on top, then clockwise
    return [r * Math.cos(a), r * Math.sin(a)];
  }
  const r = 0.56 * Math.sqrt(i + 0.5);
  const a = Math.PI / 2 - i * 2.399963; // golden angle
  return [r * Math.cos(a), r * Math.sin(a)];
}

export class BoardMotion {
  private board: Board | null = null;
  private tracks = new Map<string, Track>();
  private reduced = false;
  // Display minute: chases from `from` to `to` (the latest board minute) over `duration` ms from `start`.
  private from = 0;
  private to = 0;
  private start = 0;
  private duration = 200;
  private lastAdvance = -1;
  private lastFrame = -1;
  private shown = 0;

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  /** Display minute at `now` (never ahead of the latest board minute). */
  private minuteAt(now: number): number {
    if (this.reduced || this.duration <= 0) return this.to;
    const k = Math.min(1, Math.max(0, (now - this.start) / this.duration));
    return this.from + (this.to - this.from) * k;
  }

  /** A board update: the latest minute and every subject as it is now. */
  sample(board: Board | null, subjects: readonly MotionSubject[], now = performance.now()): void {
    const fresh = board !== this.board;
    this.board = board;
    if (!board) {
      this.tracks.clear();
      return;
    }
    const m = board.minute;
    const shown = this.minuteAt(now);
    if (fresh || this.reduced || m < shown - 1e-6 || m - shown > SNAP_MINUTES) {
      this.from = this.to = m;
      this.start = now;
      this.lastAdvance = -1;
      if (fresh) this.tracks.clear();
    } else {
      if (m > this.to + 1e-9) {
        if (this.lastAdvance >= 0) {
          const gap = Math.min(CHASE_MAX_MS, Math.max(CHASE_MIN_MS, now - this.lastAdvance));
          this.duration = this.duration * 0.7 + gap * 0.3;
        }
        this.lastAdvance = now;
      }
      this.from = shown;
      this.to = m;
      this.start = now;
    }

    const spots: { id: string; at: LonLat; moving: boolean }[] = [];
    const seen = new Set<string>();
    const nowView = viewAt(board, m);
    for (const subject of subjects) {
      seen.add(subject.id);
      const track = this.tracks.get(subject.id);
      if (!track) {
        this.tracks.set(subject.id, { subject, pos: null, heading: null, blend: null, offset: [0, 0], target: [0, 0], group: null });
      } else {
        if (!this.reduced && track.pos && !sameLeg(track.subject.leg, subject.leg)) {
          const next = subject.at(viewAt(board, shown));
          track.blend = next && distanceM(track.pos, next) <= BLEND_MAX_M ? { from: track.pos, start: now } : null;
        }
        track.subject = subject;
      }
      const at = subject.at(nowView);
      if (at) spots.push({ id: subject.id, at, moving: subject.moving });
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id);

    // Groups at one spot (greedy, by id so the slots are deterministic; standing and driving apart).
    spots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const groups: { at: LonLat; moving: boolean; ids: string[] }[] = [];
    for (const s of spots) {
      const g = groups.find((x) => x.moving === s.moving && distanceM(x.at, s.at) < GROUP_M);
      if (g) g.ids.push(s.id);
      else groups.push({ at: s.at, moving: s.moving, ids: [s.id] });
    }
    for (const track of this.tracks.values()) {
      track.target = [0, 0];
      track.group = null;
    }
    for (const g of groups) {
      if (g.ids.length < 2) continue;
      const group = { lead: g.ids[0], ids: g.ids };
      g.ids.forEach((id, i) => {
        const track = this.tracks.get(id)!;
        track.target = standingSlot(i, g.ids.length);
        track.group = group;
      });
    }
  }

  /**
   * Advances the drawing to `now` (call once per animation frame, and after each sample).
   * `snap` draws the model's positions at the latest board minute at once (hidden view).
   * Returns whether anything is still changing (keep requesting frames).
   */
  frame(now = performance.now(), snap = false): boolean {
    const board = this.board;
    if (!board) return false;
    const instant = snap || this.reduced;
    // Once drawn at the board minute, never step back to a chased minute.
    if (instant) this.from = this.to;
    const dt = this.lastFrame < 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const minute = instant ? this.to : this.minuteAt(now);
    const catching = minute < this.to - 1e-9;
    this.shown = minute;
    const view = viewAt(board, minute);
    const ahead = viewAt(board, minute + HEADING_LOOK_MIN);
    const kHeading = 1 - Math.exp(-HEADING_RATE * dt);
    const kOffset = 1 - Math.exp(-OFFSET_RATE * dt);
    // Still changing: a driving unit while the display minute catches up, a glide, an easing.
    let changing = false;
    for (const track of this.tracks.values()) {
      const { subject } = track;
      if (catching && subject.moving) changing = true;
      let at = subject.at(view);
      if (at && track.blend && !instant) {
        const k = (now - track.blend.start) / BLEND_MS;
        if (k >= 1) track.blend = null;
        else {
          at = lerp(track.blend.from, at, smooth(Math.max(0, k)));
          changing = true;
        }
      } else track.blend = null;
      if (at && track.pos && (at[0] !== track.pos[0] || at[1] !== track.pos[1])) changing = true;

      // Heading: along the road just ahead while driving; kept while standing.
      if (at && subject.moving) {
        const next = subject.at(ahead);
        if (next && distanceM(at, next) > 0.5) {
          const target = bearing(at, next);
          if (track.heading === null || instant) track.heading = target;
          else {
            const turn = ((target - track.heading + 540) % 360) - 180;
            if (Math.abs(turn) > 0.2) changing = true;
            track.heading = (track.heading + turn * kHeading + 360) % 360;
          }
        }
      } else if (at && track.pos && track.blend && distanceM(track.pos, at) > 0.5 && !instant) {
        // Gliding onto a stand: face the way it glides.
        const target = bearing(track.pos, at);
        const turn = track.heading === null ? 0 : ((target - track.heading + 540) % 360) - 180;
        track.heading = track.heading === null ? target : (track.heading + turn * kHeading + 360) % 360;
      }

      const [tx, ty] = track.target;
      if (instant || track.pos === null) track.offset = [tx, ty];
      else {
        const dx = tx - track.offset[0];
        const dy = ty - track.offset[1];
        if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) {
          track.offset = [track.offset[0] + dx * kOffset, track.offset[1] + dy * kOffset];
          changing = true;
        } else track.offset = [tx, ty];
      }
      track.pos = at;
    }
    return changing;
  }

  /** The display minute of the last frame. */
  get minute(): number {
    return this.shown;
  }

  /** Where to draw `id` (after `frame`); null when it is not on the board. */
  get(id: string): MotionDisplay | null {
    const track = this.tracks.get(id);
    if (!track?.pos) return null;
    return { at: track.pos, offset: track.offset, heading: track.heading, moving: track.subject.moving, group: track.group };
  }
}

/** Driving on a road line: to a fire, home to its station, or to cover another station. */
const DRIVING: ReadonlySet<Board["teams"][number]["status"]> = new Set(["en_route", "returning", "moving_up"]);

/** The board's fire units as motion subjects (model.teamPosition); the leg is its status, road line and timing. */
export function teamSubjects(board: Board): MotionSubject[] {
  return board.teams.map((team) => ({
    id: team.id,
    at: (view) => teamPosition(view, team),
    moving: DRIVING.has(team.status) && team.route !== null && team.route.length >= 2,
    leg: [team.status, team.route, team.rollAt, team.arriveAt],
  }));
}
