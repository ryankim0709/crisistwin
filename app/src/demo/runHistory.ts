/**
 * A board run's history for the /run page's scrubber: the score timeline (one ScorePoint per
 * whole board minute, scorePoint.ts) and board snapshots every SNAPSHOT_EVERY_MINUTES, so the 3D
 * board can show any earlier minute without touching the run. Pure: no React, clock or network.
 *
 * Memory (structural sharing): a snapshot deep-copies only the board's small, per-minute state
 * (minute, fires, units, zones and households, traffic, scheduled ignitions, the response state,
 * simulated comms) and keeps references to what is large and either immutable or only appended to
 * with time stamps: the landscape (env), the fire solver state, suppression (per-cell arrays with
 * the minute each cell was put out), routes, road legs, attack plans and the resource snapshot.
 * Those shared parts are read from the run's final board when a snapshot is viewed
 * (`viewBoardAt`): the fire extent at minute m is the final arrival field at or before m
 * (fireState.ts compares arrival and put-out minutes with board.minute), the forecasts are the
 * ones the board had at m (kept per snapshot).
 *
 * Units: minutes are board minutes from T+0 (Board.minute), never wall time. Everything here is
 * simulated board state.
 */

import { zoneForecasts, type Board, type ZoneForecast } from "./model";
import type { ScorePoint } from "./runContracts";
import { scorePoint } from "./scorePoint";

/** Board minutes between two snapshots (the scoreboard keeps one point per minute). UI choice. */
export const SNAPSHOT_EVERY_MINUTES = 2;

/** The board fields a snapshot shares with the run's final board (large; see the file comment). */
const SHARED = ["env", "solver", "suppression", "routes", "travel", "attackPlans", "snapshotInput", "noRoute", "classReach", "events"] as const;
type SharedKey = (typeof SHARED)[number];
type OwnState = Omit<Board, SharedKey>;

export interface BoardSnapshot {
  /** Board minute of the snapshot (fractional when the clock was between minutes). */
  minute: number;
  /** The board's own small state at that minute (deep copy). */
  own: OwnState;
  /** The newest board events at that minute, oldest dropped (shared event objects). */
  events: Board["events"];
  /** The commander's zone forecasts at that minute (model.zoneForecasts "reported"). */
  forecasts: Map<string, ZoneForecast>;
}

export interface RunHistory {
  /** The board the history belongs to (a new board starts a new history). */
  board: Board | null;
  points: ScorePoint[];
  snapshots: BoardSnapshot[];
}

export function emptyHistory(board: Board | null): RunHistory {
  return { board, points: [], snapshots: [] };
}

/** A deep copy of the board's small state now (see the file comment for what is shared instead). */
export function snapshotBoard(board: Board, forecasts: Map<string, ZoneForecast>): BoardSnapshot {
  const own: Partial<Board> = {};
  const shared = new Set<string>(SHARED);
  for (const key of Object.keys(board) as (keyof Board)[]) {
    if (!shared.has(key)) (own as Record<string, unknown>)[key] = board[key];
  }
  return {
    minute: board.minute,
    own: structuredClone(own) as OwnState,
    events: board.events.slice(),
    forecasts: new Map(forecasts),
  };
}

/**
 * Records the board's state into `history`: a score point once per whole board minute, and a
 * snapshot at T+0 and then every SNAPSHOT_EVERY_MINUTES. `forecasts`: the board's "reported"
 * zone forecasts now (computed when omitted). Returns whether a score point was added.
 */
export function recordHistory(history: RunHistory, board: Board, forecasts?: Map<string, ZoneForecast>): boolean {
  const minute = Math.floor(board.minute + 1e-9);
  const points = history.points;
  const lastPoint = points.length > 0 ? points[points.length - 1].minute : -Infinity;
  const lastSnap = history.snapshots.length > 0 ? Math.floor(history.snapshots[history.snapshots.length - 1].minute + 1e-9) : -Infinity;
  const wantPoint = minute > lastPoint;
  const wantSnap = minute >= lastSnap + SNAPSHOT_EVERY_MINUTES;
  if (!wantPoint && !wantSnap) return false;
  const f = forecasts ?? zoneForecasts(board, "reported");
  if (wantPoint) points.push(scorePoint(board, f));
  if (wantSnap) history.snapshots.push(snapshotBoard(board, f));
  return wantPoint;
}

/** The last snapshot at or before `minute` (the first one when `minute` is before it), or null. */
export function snapshotAt(history: RunHistory, minute: number): BoardSnapshot | null {
  const s = history.snapshots;
  if (s.length === 0) return null;
  let lo = 0;
  let hi = s.length - 1;
  if (s[0].minute > minute) return s[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].minute <= minute + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return s[lo];
}

/** A board to draw (never to step) for `snap`: its own state plus the run's final shared parts. */
export function viewBoardAt(final: Board, snap: BoardSnapshot): Board {
  const view = { ...final, ...snap.own, events: snap.events } as Board;
  return view;
}
