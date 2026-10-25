import { useCallback } from "react";
import { LiveError, request } from "../live/api";
import { usePoll, type PollState } from "../live/usePoll";

/** `GET /api/live/incidents/<id>/participants/<pid>/phone-view` (docs/app-integration.md "Phone mirror"). Coordinates are [lon, lat]. */
export type PhoneScreen =
  | "guidance"
  | "checked_out"
  | "help_requested"
  | "responder"
  | "no_order"
  | "not_joined";

export interface PhoneButton {
  label: string;
  kind: "primary" | "danger" | "secondary";
}

export interface PhoneView {
  participant_id: string;
  name: string | null;
  role: "civilian" | "responder";
  /** `phone` is a real device; `simulated` is a virtual person. */
  kind: "phone" | "simulated";
  screen: PhoneScreen;
  headline: string;
  sub: string;
  lines: string[];
  buttons: PhoneButton[];
  zone: { id: string; name: string } | null;
  fire_distance_km: number | null;
  /** Where the phone is, or the zone centre when it has not reported a place (`position_is`). */
  position: [number, number] | null;
  position_is: "device" | "zone_centre" | null;
  route: { line: [number, number][]; destination_name: string; eta_min: number | null } | null;
  destination_coord?: [number, number] | null;
  assignment: {
    task_id: string;
    kind: string;
    status: string;
    place: string;
    target: [number, number] | null;
    note: string | null;
    open_tasks: number;
  } | null;
  fire: { rings: [number, number][][] };
  fire_label: string;
  incident: { id: string; name: string; mode: string };
  as_of: string;
  evidence_class: string;
}

const SCREENS: readonly string[] = ["guidance", "checked_out", "help_requested", "responder", "no_order", "not_joined"];

function isPhoneView(data: unknown): data is PhoneView {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.participant_id === "string" &&
    typeof d.screen === "string" &&
    SCREENS.includes(d.screen) &&
    typeof d.headline === "string" &&
    Array.isArray(d.lines) &&
    Array.isArray(d.buttons) &&
    typeof d.fire === "object" &&
    d.fire !== null
  );
}

export async function fetchPhoneView(
  token: string,
  incidentId: string,
  participantId: string,
  signal: AbortSignal,
): Promise<PhoneView> {
  const path = `incidents/${encodeURIComponent(incidentId)}/participants/${encodeURIComponent(participantId)}/phone-view`;
  const data = await request<unknown>(token, "GET", path, undefined, signal);
  if (!isPhoneView(data)) throw new LiveError(200, "bad_response", "The phone view returned an unexpected response.");
  return data;
}

export const PHONE_VIEW_POLL_MS = 3_000;

/** Polls one participant's phone view every 3 s. A null token stops polling; errors keep the last view. */
export function usePhoneView(
  token: string | null,
  incidentId: string,
  participantId: string,
): PollState<PhoneView> & { refresh: () => void } {
  const fetcher = useCallback(
    (t: string, signal: AbortSignal) => fetchPhoneView(t, incidentId, participantId, signal),
    [incidentId, participantId],
  );
  return usePoll(token, fetcher, PHONE_VIEW_POLL_MS, "Phone view");
}
