/**
 * The /live board clock's "Auto" speed: how fast board minutes pass per real minute, picked from
 * what is on the board and whether Claude is deciding. It only changes the wall-clock to
 * board-minute rate (useCommandBoard's clock loop); model.step lands on the same whole minutes,
 * wind samples and ignitions at any rate, so the simulation's results do not depend on it.
 * Pure: no React, no browser.
 */

import { isReported } from "./boardResponse";
import { withVehicle, zoneCounts, type Board } from "./model";
import { ORDER_COMPLIANCE, departedShare } from "./realism";

/** UI choice: nothing going on (no reported fire, nobody moving) — skip ahead to the next report. */
export const AUTO_SPEED_IDLE = 60;
/** UI choice: Claude is deciding on an URGENT wake (observation.ts WakeUrgency) — real time, so the board barely moves before its orders land. */
export const AUTO_SPEED_THINKING = 1;
/**
 * UI choice: Claude is on a ROUTINE wake (a continuous review, an arrival, a finished line...).
 * Reviews run almost back to back while a fire burns, so 1× here would pin the board at real
 * time; 5× keeps it moving (a ~30 s review is ~2.5 board minutes) while orders still land soon.
 */
export const AUTO_SPEED_REVIEWING = 5;
/** UI choice: something is happening and Claude is not deciding — fast, but watchable. */
export const AUTO_SPEED_ACTIVE = 20;
/** UI choice: board minutes the board must stay idle before Auto goes back up to the idle speed. */
export const AUTO_IDLE_HOLD_MINUTES = 5;
/** UI choice: a pending resource order counts as activity when it arrives within this many board minutes. */
export const AUTO_ORDER_SOON_MINUTES = 30;

/** thinking = Claude deciding on an urgent wake; reviewing = Claude on a routine wake. */
export type AutoSpeedReason = "idle" | "thinking" | "reviewing" | "active";

export const AUTO_SPEED: Record<AutoSpeedReason, number> = {
  idle: AUTO_SPEED_IDLE,
  thinking: AUTO_SPEED_THINKING,
  reviewing: AUTO_SPEED_REVIEWING,
  active: AUTO_SPEED_ACTIVE,
};

/** Shown next to the speed while Auto is on ("60× · idle"). */
export const AUTO_REASON_TEXT: Record<AutoSpeedReason, string> = {
  idle: "idle",
  thinking: "Claude deciding (urgent)",
  reviewing: "Claude reviewing",
  active: "active",
};

/** Teams in these states are doing something on the map (driving, on the line, filling up). */
const BUSY_TEAM = new Set(["en_route", "on_scene", "refilling", "returning", "moving_up"]);
/** Aircraft in these states are flying. */
const FLYING = new Set(["en_route", "over_fire", "returning"]);

/**
 * Whether nothing is going on that the commander can see or that moves on the map. Idle when all hold:
 * - no REPORTED fire burning or contained (an unreported fire, or one scheduled to ignite, does
 *   not count: the commander cannot act on it, so the board skips ahead to its report);
 * - no unit en route (dispatched, also waiting for its road leg), on scene, refilling, returning
 *   home or moving up to cover a station;
 * - no zone leaving (ordered, not overrun, at least one household still to depart or on the road)
 *   and no zone with a scheduled evacuation order;
 * - no aircraft flying (en route, over a fire, returning to base);
 * - no pending resource order arriving within AUTO_ORDER_SOON_MINUTES.
 */
export function boardIsIdle(board: Board): boolean {
  const minute = board.minute;
  if (board.fires.some((f) => f.status !== "out" && isReported(board, f))) return false;
  if (board.teams.some((t) => BUSY_TEAM.has(t.status))) return false;
  for (const zone of board.zones) {
    if (zone.pendingOrder !== null) return false;
    if (zone.orderedAt === null || zone.overrunAt !== null) continue;
    const toDepart = withVehicle(zone) * ORDER_COMPLIANCE * (1 - departedShare(minute - zone.orderedAt));
    if (toDepart >= 1 || zoneCounts(zone, minute).enRoute > 0) return false;
  }
  if (board.response.aircraft.some((a) => FLYING.has(a.status))) return false;
  if (board.response.orders.some((o) => o.status === "pending" && o.readyAt - minute <= AUTO_ORDER_SOON_MINUTES)) return false;
  return true;
}

/** What Auto picked, and since when the board has been idle (for the hold). */
export interface AutoSpeedState {
  reason: AutoSpeedReason;
  /** Board minute the board became idle (after the last activity or Claude call); null while not idle. */
  idleSince: number | null;
  /** Board minute of the last evaluation (a smaller minute means a new board). */
  minute: number;
}

/**
 * One Auto evaluation, with hysteresis. `thinking` is the urgency of the call in flight (null = none):
 * - Claude deciding on an urgent wake (new fire, zone late, fire outrunning its crews or breaching
 *   a line, failing strategy, a unit standing at a fire, "Ask Claude now", or an urgent event
 *   queued behind a routine call): 1× at once;
 * - Claude on a routine wake (continuous review, arrivals, finished lines...): AUTO_SPEED_REVIEWING;
 *   after either the idle hold restarts, so its orders play out at 20×;
 * - activity: 20× at once;
 * - idle: 60× once the board has been idle for AUTO_IDLE_HOLD_MINUTES board minutes (at once on a
 *   fresh board that starts idle).
 */
export function nextAutoSpeed(
  prev: AutoSpeedState | null,
  now: { minute: number; idle: boolean; thinking: "urgent" | "routine" | null },
): AutoSpeedState {
  const fresh = prev === null || now.minute < prev.minute;
  if (now.thinking) return { reason: now.thinking === "urgent" ? "thinking" : "reviewing", idleSince: null, minute: now.minute };
  if (!now.idle) return { reason: "active", idleSince: null, minute: now.minute };
  if (fresh) return { reason: "idle", idleSince: now.minute, minute: now.minute };
  const idleSince = prev.idleSince ?? now.minute;
  const reason = prev.reason === "idle" || now.minute - idleSince >= AUTO_IDLE_HOLD_MINUTES ? "idle" : "active";
  return { reason, idleSince, minute: now.minute };
}
