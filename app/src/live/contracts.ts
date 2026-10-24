/**
 * Live broadcast to the resident iOS app: the run a web page is playing, at the current
 * simulation minute. `POST /api/live/broadcast` stores the latest snapshot and the app reads
 * it from `GET /api/live` (app/backend/api/live.py). Change both sides, the Swift decoder
 * (mobile/CrisisTwin/Features/Live/LiveSnapshot.swift) and
 * docs/adr/0016-resident-live-and-family.md together.
 *
 * Everything here is simulated. Zone guidance is computed by the dispatch simulator from the
 * agent's orders and its own queue and fire-arrival figures; no text is written by the model
 * except `agent.summary`, which is labelled as AI output.
 *
 * Units: minutes are elapsed simulation minutes from T+0; coordinates are WGS84
 * [longitude, latitude]; rings are closed (first point repeated last).
 */

export const LIVE_BROADCAST_URL = "/api/live/broadcast";
export const LIVE_SNAPSHOT_VERSION = 1;
/** Server limits; keep in sync with live.py. */
export const MAX_LIVE_RINGS = 60;
export const MAX_LIVE_RING_POINTS = 600;

export type LonLat = [number, number];

export type LiveGuidance =
  /** No evacuation order for the zone yet. */
  | "no_order"
  /** Ordered, and the route has room or the fire is close: go now via `exit`. */
  | "leave_now"
  /** Ordered, but households already queued at the route bottleneck take `wait_min` to clear and the fire is not close. */
  | "wait"
  /** Ordered, but the assigned exit is unreachable; departures hold until dispatch gives another exit. */
  | "route_blocked"
  /** Everyone in the zone has left (simulated). */
  | "cleared"
  /** Fire reached the zone core (simulated). */
  | "overrun";

export interface LiveZone {
  id: string;
  name: string;
  polygon: LonLat[];
  guidance: LiveGuidance;
  /** Plain-language resident message built from the fields below. */
  message: string;
  exit: { id: string; name: string; road: string; location: LonLat } | null;
  /** Assigned route from the zone to `exit`, simplified; null without an active route. */
  route: LonLat[] | null;
  /** Free-flow drive time on `route`, minutes. */
  drive_min: number | null;
  /** Suggested wait before leaving, minutes, only for "wait". */
  wait_min: number | null;
  /** Minutes until the fire model reaches the zone edge / core; 0 = already there; null = not within the horizon. */
  fire_eta_min: number | null;
  fire_core_eta_min: number | null;
}

export interface LiveSnapshot {
  version: typeof LIVE_SNAPSHOT_VERSION;
  source: "fire_model" | "dispatch_agent";
  /** New for each run, so the app can tell a restarted simulation from a continuing one. */
  session_id: string;
  evidence_class: "simulated";
  playback: "playing" | "paused" | "finished" | "stopped";
  area_name: string;
  minute: number;
  horizon_minutes: number;
  wind: { from_degrees: number; speed_mph: number };
  /** [west, south, east, north] of the modelled area, or null. */
  bbox: [number, number, number, number] | null;
  fire: {
    /** Outer rings of the burned footprint at `minute` (holes dropped, so it never understates). */
    perimeters: LonLat[][];
    burned_area_ha: number;
  };
  /** Dispatch zones with guidance; empty for the plain fire model. */
  zones: LiveZone[];
  /** The dispatch agent's latest summary (AI output), or null. */
  agent: { summary: string; model: string; minute: number } | null;
}
