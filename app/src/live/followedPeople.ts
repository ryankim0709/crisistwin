/**
 * Simulated people that phones are following (docs/app-integration.md "Follow a simulated person"):
 * `GET /api/live/incidents/<id>/followed` polled every FOLLOWED_POLL_MS through the live API client.
 * A phone picks a person with `POST /api/live/me/follow`; the controller lists the people with at least
 * one active follower and each person's track (position, route, progress, trail).
 *
 * Everything here is `evidence_class: "simulated"`: the people are synthetic households run by the server
 * on the drill clock and their positions are estimates along the published route, never observations.
 */

import { useCallback, useMemo } from "react";
import { LiveError, request } from "./api";
import { usePoll } from "./usePoll";

export const FOLLOWED_POLL_MS = 3_000;

type LonLat = [number, number];

/** One followed person as the map and panels use it. Positions are `[lon, lat]`, WGS84. */
export type FollowedPerson = {
  personId: string;
  /** The person's made-up street address (`GET homes`), or "Home <n>, <zone>". */
  label: string;
  position: [number, number] | null;
  path: [number, number][];
  /** 0..1 along `path`; null when the person has no route yet. */
  progress: number | null;
  /** Plain-language status as the participants list shows it ("Driving out, 14 min to go"). */
  status: string;
  /** Devices currently following this person. */
  followers: number;
  destination: { name: string; coord: [number, number] } | null;
  phase?: string;
  flags?: string[];
  /** Minutes remaining at free flow; null unless driving or arrived. */
  etaMin?: number | null;
  /** `driving | queued | long_queue | blocked` while en route, else null. */
  motion?: string | null;
  /** Where the person has been, oldest first, at most 120 points. */
  trail?: { t: string; coord: [number, number] }[];
};

/** The track object of `GET virtual-people/<id>/track` as the server sends it. */
export interface FollowTrack {
  id: string;
  label: string;
  zone: { id: string; name: string | null } | null;
  phase: string;
  status: string;
  flags: string[];
  position: LonLat | null;
  path: LonLat[];
  progress: number | null;
  total_min: number | null;
  eta_min: number | null;
  destination: { id: string; name: string | null; coord: LonLat } | null;
  motion: string | null;
  trail: { t: string; coord: LonLat }[];
  drill: { now: string; speed: number; running: boolean };
  evidence_class: "simulated";
}

export interface FollowedResponse {
  incident_id: string;
  label: string;
  evidence_class: "simulated";
  total_followers: number;
  people: { person_id: string; followers: number; track: FollowTrack }[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isLonLat = (v: unknown): v is LonLat => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const lonLat = (v: unknown): LonLat | null => (isLonLat(v) ? [v[0], v[1]] : null);

/** Maps one `people[]` entry of the followed response to a `FollowedPerson`; null when it is malformed. */
export function toFollowedPerson(entry: unknown): FollowedPerson | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const t = e.track as Record<string, unknown> | null | undefined;
  if (typeof e.person_id !== "string" || typeof t !== "object" || t === null) return null;
  const path = Array.isArray(t.path) ? t.path.map(lonLat).filter((p): p is LonLat => p !== null) : [];
  const dest = t.destination as Record<string, unknown> | null | undefined;
  const destCoord = dest ? lonLat(dest.coord) : null;
  const trail = Array.isArray(t.trail)
    ? t.trail.flatMap((p: unknown) => {
        const point = p as { t?: unknown; coord?: unknown } | null;
        const coord = lonLat(point?.coord);
        return coord && typeof point?.t === "string" ? [{ t: point.t, coord }] : [];
      })
    : [];
  return {
    personId: e.person_id,
    label: typeof t.label === "string" && t.label ? t.label : e.person_id,
    position: lonLat(t.position),
    path,
    progress: isNum(t.progress) ? t.progress : null,
    status: typeof t.status === "string" ? t.status : "",
    followers: isNum(e.followers) ? e.followers : 0,
    destination: dest && destCoord ? { name: typeof dest.name === "string" && dest.name ? dest.name : "Destination", coord: destCoord } : null,
    phase: typeof t.phase === "string" ? t.phase : undefined,
    flags: Array.isArray(t.flags) ? t.flags.filter((f): f is string => typeof f === "string") : undefined,
    etaMin: isNum(t.eta_min) ? t.eta_min : null,
    motion: typeof t.motion === "string" ? t.motion : null,
    trail,
  };
}

async function fetchFollowed(token: string, incidentId: string, signal: AbortSignal): Promise<FollowedPerson[]> {
  const data = await request<unknown>(token, "GET", `incidents/${encodeURIComponent(incidentId)}/followed`, undefined, signal);
  const people = (data as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) throw new LiveError(200, "bad_response", "The live API returned an unexpected response.");
  return people.flatMap((p) => toFollowedPerson(p) ?? []);
}

/**
 * The simulated people phones are following, polled every 3 s. `[]` while `incidentId` or `token` is null.
 * A failed poll keeps the last people and sets `error`.
 */
export function useFollowedPeople(
  incidentId: string | null,
  token: string | null,
): { people: FollowedPerson[]; error: string | null } {
  const fetcher = useCallback(
    (t: string, signal: AbortSignal) => fetchFollowed(t, incidentId ?? "", signal),
    [incidentId],
  );
  const poll = usePoll<FollowedPerson[]>(incidentId ? token : null, fetcher, FOLLOWED_POLL_MS, "Followed people");
  const people = useMemo(() => poll.data ?? [], [poll.data]);
  return { people, error: poll.error ? poll.error.message : null };
}
