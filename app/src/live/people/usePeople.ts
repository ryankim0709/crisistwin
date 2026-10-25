import { useCallback } from "react";
import { LiveError, request } from "../api";
import { usePoll, type PollState } from "../usePoll";
import type { PeopleSnapshot } from "./types";

const POLL_MS = 3_000;

function isPeople(data: unknown): data is PeopleSnapshot {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.kind === "crisistwin_live_people" &&
    typeof d.totals === "object" &&
    Array.isArray(d.zones) &&
    typeof d.edges === "object" &&
    Array.isArray(d.stuck) &&
    Array.isArray(d.destinations)
  );
}

export async function fetchPeople(token: string, incidentId: string, signal: AbortSignal): Promise<PeopleSnapshot> {
  const data = await request<unknown>(token, "GET", `incidents/${encodeURIComponent(incidentId)}/people`, undefined, signal);
  if (!isPeople(data)) throw new LiveError(200, "bad_response", "The people picture returned an unexpected response.");
  return data;
}

/** Polls the simulated people picture (docs/twin-api.md "People snapshot"). A null token stops polling. */
export function usePeople(token: string | null, incidentId: string): PollState<PeopleSnapshot> & { refresh: () => void } {
  const fetcher = useCallback((t: string, signal: AbortSignal) => fetchPeople(t, incidentId, signal), [incidentId]);
  return usePoll(token, fetcher, POLL_MS, "People picture");
}
