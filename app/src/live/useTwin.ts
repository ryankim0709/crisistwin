import { useCallback } from "react";
import { fetchTwin } from "./api";
import type { TwinMonitor } from "./types";
import { usePoll, type PollState } from "./usePoll";

const POLL_MS = 5_000;

/** Polls the traffic twin's monitor (docs/twin-api.md "HTTP adapter"); every value is simulated. */
export function useTwin(token: string | null, incidentId: string): PollState<TwinMonitor> & { refresh: () => void } {
  const fetcher = useCallback((t: string, signal: AbortSignal) => fetchTwin(t, incidentId, signal), [incidentId]);
  return usePoll(token, fetcher, POLL_MS, "Traffic twin");
}
