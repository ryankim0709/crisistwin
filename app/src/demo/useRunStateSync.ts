/**
 * Keeps the database's copy of the running board's state current: the /live controller's
 * browser PUTs runState.ts boardRunState to `/api/live/incidents/<incident_id>/run-state`
 * (docs/command-demo-realism.md "Run state in the database"). Transport only; the counts are
 * the board's (runState.ts).
 *
 * Rules:
 * - at most one PUT per RUN_STATE_MIN_INTERVAL_MS of wall time, and only when the whole board
 *   minute or any count / order changed (a paused board sends nothing);
 * - never two requests at once (a tick while one is in flight is skipped);
 * - each PUT carries previous_run_id, the run this page last saved for the incident (null on its
 *   first save). A new Board in this page (Reset board, restart, a landscape change; a new run id,
 *   runState.ts boardRunId) just PUTs with the old run as previous_run_id: the server replaces
 *   the stored run itself. The page never deletes on its own (clear() is there for a caller);
 * - single writer: while another page owns the incident's run state the server answers 409
 *   `run_state_owned`. That is not an error: the page shows who is saving, retries every
 *   RUN_STATE_OWNED_RETRY_MS (the server hands over once the owner has been quiet that long) and
 *   saves normally again after the next PUT that succeeds;
 * - other errors (e.g. 503 while MongoDB Atlas is over quota) back off, doubling from
 *   RUN_STATE_MIN_INTERVAL_MS up to RUN_STATE_MAX_BACKOFF_MS; the board keeps running and the
 *   page only shows the reason;
 * - heartbeat: while this page owns the lease (its last PUT succeeded) and is visible
 *   (!document.hidden), it re-PUTs the current state every RUN_STATE_HEARTBEAT_MS even when
 *   nothing changed (a paused board), so the server's 30 s stale rule only hands the lease over
 *   when the console is really closed or hidden. A hidden page sends no heartbeat;
 * - a state that breaks an invariant (runState.ts checkRunState, dev builds) is not saved.
 * Wall-clock time only paces requests; the saved minute is the board's simulation minute.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LiveError, request } from "../live/api";
import type { Board, ZoneForecast } from "./model";
import { assertRunState, boardRunState, type RunStatePayload, type RunStatePutBody, type RunStatePutResponse } from "./runState";

/** At most one PUT per this much wall time (the contract's 10 s). */
export const RUN_STATE_MIN_INTERVAL_MS = 10_000;
/** How often the hook checks whether a save is due, wall ms. */
export const RUN_STATE_CHECK_MS = 1_000;
/** Longest wait between retries after repeated errors, wall ms. */
export const RUN_STATE_MAX_BACKOFF_MS = 5 * 60_000;
/** Retry while another page owns the run state: the server's takeover window (owner quiet 30 s). */
export const RUN_STATE_OWNED_RETRY_MS = 30_000;
/** While this page owns the lease and is visible, an unchanged state is re-PUT this often (under the server's 30 s stale rule). */
export const RUN_STATE_HEARTBEAT_MS = 20_000;
/** The server's 409 code when another page owns the incident's run state. */
export const RUN_STATE_OWNED = "run_state_owned";
const REQUEST_TIMEOUT_MS = 10_000;

export interface RunStateSyncState {
  /** Wall time (ms) of the last successful PUT; null before the first. */
  lastSavedAt: number | null;
  /** Board minute (simulation minutes since T+0) of the state last saved; null before the first. */
  lastSavedMinute: number | null;
  /** Why the last attempt failed (short, for the status line); null after a success or while owned elsewhere. */
  error: string | null;
  /**
   * Another Live console owns the run state (409 run_state_owned): this page is not saving.
   * `sinceMinute` is the owner's board minute from the 409 body when it gives one, else null.
   */
  ownedElsewhere: { sinceMinute: number | null } | null;
}

export interface RunStateSync extends RunStateSyncState {
  /** DELETEs this page's own stored run (`?run_id=`); nothing if this page has not saved one. Never called automatically. */
  clear: () => Promise<void>;
}

export interface RunStateSyncOptions {
  /** Controller token; null = not the controller (nothing is sent). */
  token: string | null;
  incidentId: string;
  board: Board | null;
  /** The commander's zone forecasts (useCommandBoard `forecasts`, "reported" scope). */
  forecasts: Map<string, ZoneForecast>;
  /** False pauses syncing (e.g. while the page is not the controller view). */
  enabled?: boolean;
}

const path = (incidentId: string) => `incidents/${encodeURIComponent(incidentId)}/run-state`;
const IDLE: RunStateSyncState = { lastSavedAt: null, lastSavedMinute: null, error: null, ownedElsewhere: null };

function reason(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "the request timed out";
  if (!(error instanceof LiveError)) return error instanceof Error ? error.message : "unknown error";
  if (error.status === 0) return "Live API unreachable";
  if (error.status === 404) return "the server has no run-state endpoint yet (HTTP 404)";
  if (error.status === 503) return `database unavailable (HTTP 503)${error.message ? `: ${error.message}` : ""}`;
  return `${error.message} (HTTP ${error.status})`;
}

/**
 * The owner's board minute from a 409 run_state_owned body, if it names one. The lease contract
 * was still landing when this was written, so the likely field names are all read.
 */
function ownerMinute(error: LiveError): number | null {
  const b = error.body ?? {};
  const owner = (typeof b.owner === "object" && b.owner !== null ? b.owner : {}) as Record<string, unknown>;
  for (const v of [b.owner_board_minute, b.owner_since_minute, b.since_minute, b.board_minute, owner.board_minute, owner.since_minute]) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/** Change key: whole board minute plus every count and order (the fractional minute alone does not count). */
function changeKey(incidentId: string, payload: RunStatePayload): string {
  return `${incidentId}|${payload.run_id}|${Math.floor(payload.board_minute)}|${JSON.stringify(payload.zones)}`;
}

export function useRunStateSync({ token, incidentId, board, forecasts, enabled = true }: RunStateSyncOptions): RunStateSync {
  const [state, setState] = useState<RunStateSyncState>(IDLE);
  const latest = useRef({ token, incidentId, board, forecasts, enabled });
  useEffect(() => {
    latest.current = { token, incidentId, board, forecasts, enabled };
  });
  const sync = useRef({
    inflight: null as AbortController | null,
    nextAt: 0,
    backoffMs: RUN_STATE_MIN_INTERVAL_MS,
    lastKey: null as string | null,
    /** The run this page last saved, per incident: the next PUT's previous_run_id and clear()'s run_id. */
    savedRun: null as { incidentId: string; runId: string } | null,
    /** This page owns the lease: its last PUT succeeded (heartbeats only then). */
    owns: false,
    /** Wall time of the last successful PUT. */
    lastPutAt: 0,
    reported: new Set<string>(),
  });

  // A different incident: forget the previous one's progress (its stored state stays).
  useEffect(() => {
    const s = sync.current;
    s.inflight?.abort();
    s.inflight = null;
    s.nextAt = 0;
    s.backoffMs = RUN_STATE_MIN_INTERVAL_MS;
    s.lastKey = null;
    s.savedRun = null;
    s.owns = false;
    setState(IDLE);
  }, [incidentId]);

  useEffect(() => {
    const s = sync.current;
    const tick = async () => {
      const { token: t, incidentId: id, board: b, forecasts: f, enabled: on } = latest.current;
      if (!on || !t || !b || s.inflight || Date.now() < s.nextAt) return;
      const payload = boardRunState(b, { forecasts: f });
      try {
        assertRunState(payload, b);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!s.reported.has(message)) {
          s.reported.add(message);
          console.error(message);
        }
        s.nextAt = Date.now() + RUN_STATE_MIN_INTERVAL_MS;
        setState((prev) => ({ ...prev, error: "the board's counts failed a consistency check (see console)" }));
        return;
      }
      const key = changeKey(id, payload);
      // Unchanged: only a heartbeat (lease owner, page visible, RUN_STATE_HEARTBEAT_MS since the last PUT).
      if (key === s.lastKey && !(s.owns && !document.hidden && Date.now() - s.lastPutAt >= RUN_STATE_HEARTBEAT_MS)) return;
      const body: RunStatePutBody = { ...payload, previous_run_id: s.savedRun?.incidentId === id ? s.savedRun.runId : null };
      const controller = new AbortController();
      s.inflight = controller;
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        await request<RunStatePutResponse>(t, "PUT", path(id), body, controller.signal);
        if (latest.current.incidentId !== id) return;
        s.lastKey = key;
        s.savedRun = { incidentId: id, runId: payload.run_id };
        s.owns = true;
        s.lastPutAt = Date.now();
        s.backoffMs = RUN_STATE_MIN_INTERVAL_MS;
        s.nextAt = Date.now() + RUN_STATE_MIN_INTERVAL_MS;
        setState({ lastSavedAt: Date.now(), lastSavedMinute: payload.board_minute, error: null, ownedElsewhere: null });
      } catch (error) {
        if (latest.current.incidentId !== id || s.inflight !== controller) return;
        // Not saved: the next tick past nextAt retries even if the state is unchanged (e.g. a paused board after losing the lease).
        s.owns = false;
        s.lastKey = null;
        if (error instanceof LiveError && error.status === 409 && error.code === RUN_STATE_OWNED) {
          // Another console owns it: wait for the takeover window, no backoff spiral.
          s.backoffMs = RUN_STATE_MIN_INTERVAL_MS;
          s.nextAt = Date.now() + RUN_STATE_OWNED_RETRY_MS;
          setState((prev) => ({ ...prev, error: null, ownedElsewhere: { sinceMinute: ownerMinute(error) } }));
          return;
        }
        s.nextAt = Date.now() + s.backoffMs;
        s.backoffMs = Math.min(s.backoffMs * 2, RUN_STATE_MAX_BACKOFF_MS);
        setState((prev) => ({ ...prev, error: reason(error), ownedElsewhere: null }));
      } finally {
        window.clearTimeout(timeout);
        if (s.inflight === controller) s.inflight = null;
      }
    };
    const timer = window.setInterval(() => void tick(), RUN_STATE_CHECK_MS);
    return () => {
      window.clearInterval(timer);
      s.inflight?.abort();
      s.inflight = null;
    };
  }, []);

  const clear = useCallback(async () => {
    const { token: t, incidentId: id } = latest.current;
    const s = sync.current;
    const own = s.savedRun?.incidentId === id ? s.savedRun.runId : null;
    if (!t || own === null) return;
    s.inflight?.abort();
    s.inflight = null;
    s.lastKey = null;
    s.savedRun = null;
    s.owns = false;
    s.nextAt = 0;
    try {
      await request<unknown>(t, "DELETE", `${path(id)}?run_id=${encodeURIComponent(own)}`);
    } catch (error) {
      if (!(error instanceof LiveError && error.status === 404)) setState((prev) => ({ ...prev, error: reason(error) }));
    }
  }, []);

  return { ...state, clear };
}
