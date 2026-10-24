import { fetchTwin } from "./api";
import type { TwinMonitor } from "./types";
import { usePoll, type PollState } from "./usePoll";

const POLL_MS = 5_000;

/** Polls the traffic twin's monitor (docs/twin-api.md "HTTP adapter"); every value is simulated. */
export function useTwin(token: string | null): PollState<TwinMonitor> & { refresh: () => void } {
  return usePoll(token, fetchTwin, POLL_MS, "Traffic twin");
}
