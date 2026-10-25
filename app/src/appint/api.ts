// Client for the app integration tab: participants (docs/app-integration.md) and the simulated
// people driver (virtual-people endpoints, owned by the driver module).
import { useCallback } from "react";
import { LiveError, request } from "../live/api";
import { usePoll, type PollState } from "../live/usePoll";
import type { ParticipantsResponse } from "./types";

const POLL_MS = 3_000;

function isParticipants(data: unknown): data is ParticipantsResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.incident_id === "string" && Array.isArray(d.participants) && typeof d.counts === "object" && d.counts !== null;
}

export async function fetchParticipants(token: string, incidentId: string, signal: AbortSignal): Promise<ParticipantsResponse> {
  const data = await request<unknown>(token, "GET", `incidents/${encodeURIComponent(incidentId)}/participants`, undefined, signal);
  if (!isParticipants(data)) throw new LiveError(200, "bad_response", "The participants list returned an unexpected response.");
  return data;
}

/** Everyone on the app in this drill, polled every 3 s. A null token stops polling. */
export function useParticipants(token: string | null, incidentId: string): PollState<ParticipantsResponse> & { refresh: () => void } {
  const fetcher = useCallback((t: string, signal: AbortSignal) => fetchParticipants(t, incidentId, signal), [incidentId]);
  return usePoll(token, fetcher, POLL_MS, "Participants list");
}

/** Adds simulated households that act through the live API (the driver picks zones and choices from the seed). */
export const addVirtualPeople = (token: string, incidentId: string, count: number, seed: number) =>
  request<unknown>(token, "POST", `incidents/${encodeURIComponent(incidentId)}/virtual-people`, { count, seed });

export const removeVirtualPeople = (token: string, incidentId: string) =>
  request<unknown>(token, "DELETE", `incidents/${encodeURIComponent(incidentId)}/virtual-people`);
