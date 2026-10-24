import { useCallback, useEffect, useRef, useState } from "react";
import { LiveError } from "./api";

const REQUEST_TIMEOUT_MS = 10_000;

export interface PollState<T> {
  data: T | null;
  /** Wall time (ms) the current `data` arrived. */
  receivedAt: number | null;
  error: LiveError | null;
  loading: boolean;
}

/**
 * Polls `fetcher` every `intervalMs` after the previous request settles. Each request has its
 * own AbortController and sequence number; a response is applied only if it is the newest one
 * issued, so a slow older poll can never overwrite a newer result. Errors keep the last data.
 */
export function usePoll<T>(
  token: string | null,
  fetcher: (token: string, signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  unreachable: string,
): PollState<T> & { refresh: () => void } {
  const [state, setState] = useState<PollState<T>>({ data: null, receivedAt: null, error: null, loading: true });
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
    fetcher(token, controller.signal)
      .then((data) => {
        if (id !== seq.current) return;
        setState({ data, receivedAt: Date.now(), error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (id !== seq.current) return;
        const err =
          error instanceof LiveError
            ? error
            : new LiveError(0, "network", controller.signal.aborted ? `${unreachable} timed out.` : `${unreachable} unreachable.`);
        setState((prev) => ({ ...prev, error: err, loading: false }));
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (id !== seq.current) return;
        inflight.current = null;
        timer.current = window.setTimeout(() => pollRef.current(), intervalMs);
      });
  }, [token, fetcher, intervalMs, unreachable]);

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
