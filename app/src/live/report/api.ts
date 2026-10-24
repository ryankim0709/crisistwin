import { DEFAULT_INCIDENT_ID, LiveError, SERVER_TOKEN, readToken } from "../api";
import type { AarResponse } from "./types";

/** The active incident's id (no auth); falls back to the default when the server cannot say. */
async function activeIncidentId(signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch("/api/live/active", { signal, headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = (await response.json()) as { incident_id?: unknown };
      if (typeof data.incident_id === "string" && data.incident_id) return data.incident_id;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }
  return DEFAULT_INCIDENT_ID;
}

export async function fetchAar(signal: AbortSignal): Promise<AarResponse> {
  const token = readToken() ?? SERVER_TOKEN;
  const incidentId = await activeIncidentId(signal);
  let response: Response;
  try {
    response = await fetch(`/api/live/incidents/${encodeURIComponent(incidentId)}/aar`, {
      signal,
      headers: { Accept: "application/json", ...(token === SERVER_TOKEN ? {} : { Authorization: `Bearer ${token}` }) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LiveError(0, "network", "Live API unreachable.");
  }
  if (response.status === 401 || response.status === 403)
    throw new LiveError(response.status, "unauthorized", "Sign in on the live page first.");
  if (!response.ok) throw new LiveError(response.status, null, `Live API returned HTTP ${response.status}.`);
  const data = (await response.json()) as AarResponse;
  if (data?.kind !== "crisistwin_live_aar") throw new LiveError(200, "bad_response", "Unexpected response.");
  return data;
}
