import { INCIDENT_ID, LiveError, SERVER_TOKEN, readToken } from "../api";
import type { AarResponse } from "./types";

export async function fetchAar(signal: AbortSignal): Promise<AarResponse> {
  const token = readToken() ?? SERVER_TOKEN;
  let response: Response;
  try {
    response = await fetch(`/api/live/incidents/${INCIDENT_ID}/aar`, {
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
