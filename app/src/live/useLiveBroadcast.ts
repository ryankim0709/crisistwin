/**
 * Posts the page's current `LiveSnapshot` to the backend for the resident app, at most every
 * BROADCAST_INTERVAL_MS while something changed. One request at a time: a newer snapshot
 * waits for the in-flight one rather than racing it, so the server never ends on an older
 * minute. On unmount or when switched off, the last snapshot is re-sent as "stopped".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LIVE_BROADCAST_URL, type LiveSnapshot } from "./contracts";

export const BROADCAST_INTERVAL_MS = 2000;
const STORAGE_KEY = "crisistwin.liveBroadcast";

export type BroadcastStatus =
  | { state: "off" }
  | { state: "waiting" }
  | { state: "sent"; minute: number }
  | { state: "error"; message: string };

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

async function post(snapshot: LiveSnapshot, keepalive = false): Promise<void> {
  const response = await fetch(LIVE_BROADCAST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
    keepalive,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // Keep the status line.
    }
    throw new Error(detail);
  }
}

/**
 * `getSnapshot` is read when a send is due, so the page can build it lazily; `changeKey`
 * marks that a new snapshot is available (for example the current minute and run).
 */
export function useLiveBroadcast(
  getSnapshot: () => LiveSnapshot | null,
  changeKey: unknown,
): { enabled: boolean; setEnabled: (on: boolean) => void; status: BroadcastStatus } {
  const [enabled, setEnabledState] = useState(readEnabled);
  const [status, setStatus] = useState<BroadcastStatus>(enabled ? { state: "waiting" } : { state: "off" });
  const getRef = useRef(getSnapshot);
  getRef.current = getSnapshot;
  const dirtyRef = useRef(true);
  const inFlightRef = useRef(false);
  const lastSentRef = useRef<LiveSnapshot | null>(null);

  useEffect(() => {
    dirtyRef.current = true;
  }, [changeKey]);

  const sendStopped = useCallback(() => {
    const last = lastSentRef.current;
    lastSentRef.current = null;
    if (last && last.playback !== "stopped") {
      post({ ...last, playback: "stopped" }, true).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => {
      if (inFlightRef.current || !dirtyRef.current) return;
      const snapshot = getRef.current();
      if (!snapshot) return;
      dirtyRef.current = false;
      inFlightRef.current = true;
      post(snapshot)
        .then(() => {
          lastSentRef.current = snapshot;
          if (!cancelled) setStatus({ state: "sent", minute: snapshot.minute });
        })
        .catch((cause: unknown) => {
          dirtyRef.current = true;
          if (!cancelled) {
            setStatus({ state: "error", message: cause instanceof Error ? cause.message : "Request failed." });
          }
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    tick();
    const handle = window.setInterval(tick, BROADCAST_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      sendStopped();
    };
  }, [enabled, sendStopped]);

  const setEnabled = useCallback((on: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      // Not remembered; the choice still applies to this page.
    }
    dirtyRef.current = true;
    setEnabledState(on);
    setStatus(on ? { state: "waiting" } : { state: "off" });
  }, []);

  return { enabled, setEnabled, status };
}

/** A new id per run, so the app can tell a restarted simulation from a continuing one. */
export function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
