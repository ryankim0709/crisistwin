import { useCallback } from "react";
import { fetchFireBehavior } from "./api";
import type { FireBehaviorResponse } from "./types";
import { usePoll, type PollState } from "./usePoll";

const POLL_MS = 30_000;

/** Polls the fire-behaviour inputs (observed wind, slope at the head, carless households). */
export function useFireBehavior(
  token: string | null,
  incidentId: string,
): PollState<FireBehaviorResponse> & { refresh: () => void } {
  const fetcher = useCallback(
    (t: string, signal: AbortSignal) => fetchFireBehavior(t, incidentId, signal),
    [incidentId],
  );
  return usePoll(token, fetcher, POLL_MS, "Fire behaviour");
}
