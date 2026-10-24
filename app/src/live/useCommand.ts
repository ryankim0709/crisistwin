import { useCallback, useEffect, useRef, useState } from "react";
import { LiveError, fetchCommand } from "./api";
import type { CommandResponse } from "./types";

const POLL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CommandState {
  data: CommandResponse | null;
  /** Wall time (ms) the current `data` arrived, for the local drill-clock tick. */
  receivedAt: number | null;
  error: LiveError | null;
  loading: boolean;
}

/**
 * Polls the command endpoint every POLL_MS after the previous request settles. Each request has
 * its own AbortController and sequence number; a response is applied only if it is the newest
 * one issued, so a slow older poll can never overwrite a newer result.
 */
export function useCommand(token: string | null): CommandState & { refresh: () => void } {
  const [state, setState] = useState<CommandState>({ data: null, receivedAt: null, error: null, loading: true });
  const seq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const pollRef = useRef<() => void>(() => {});

  const poll = useCallback(() => {
    if (!token) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const id = ++seq.current;
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    fetchCommand(token, controller.signal)
      .then((data) => {
        if (id !== seq.current) return;
        setState({ data, receivedAt: Date.now(), error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (id !== seq.current) return;
        const err =
          error instanceof LiveError
            ? error
            : new LiveError(0, "network", controller.signal.aborted ? "Live API timed out." : "Live API unreachable.");
        setState((prev) => ({ ...prev, error: err, loading: false }));
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (id !== seq.current) return;
        inflight.current = null;
        timer.current = window.setTimeout(() => pollRef.current(), POLL_MS);
      });
  }, [token]);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  useEffect(() => {
    if (!token) {
      setState({ data: null, receivedAt: null, error: null, loading: false });
      return;
    }
    setState({ data: null, receivedAt: null, error: null, loading: true });
    poll();
    return () => {
      seq.current++;
      inflight.current?.abort();
      inflight.current = null;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [token, poll]);

  return { ...state, refresh: poll };
}
