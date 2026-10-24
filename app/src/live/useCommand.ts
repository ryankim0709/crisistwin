import { useCallback } from "react";
import { fetchCommand } from "./api";
import type { CommandResponse } from "./types";
import { usePoll, type PollState } from "./usePoll";

const POLL_MS = 3_000;

export type CommandState = PollState<CommandResponse>;

/** The controller's one poll (docs/live-reports.md "Command"); restarts when the incident changes. */
export function useCommand(token: string | null, incidentId: string): CommandState & { refresh: () => void } {
  const fetcher = useCallback((t: string, signal: AbortSignal) => fetchCommand(t, incidentId, signal), [incidentId]);
  return usePoll(token, fetcher, POLL_MS, "Live API");
}
