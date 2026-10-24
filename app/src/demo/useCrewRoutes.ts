import { useEffect, useRef, useState } from "react";
import type { LonLat } from "../live/types";
import { GROUND_APPARATUS } from "../studio/apparatus";
import { CREW_ROUTES_URL, type CrewRouteRequest, type CrewRoutesRequest, type CrewRoutesResponse } from "./contracts";
import { activeFires, applyTravelLeg, crewTarget, distanceM, fireRing, travelKey, type Board } from "./model";

/** Free units per burning fire whose road time is fetched ahead (nearest by straight line). */
export const PREFETCH_UNITS_PER_FIRE = 4;
const MAX_REQUESTS = 40;
const RING_POINTS = 24;
const RETRY_WALL_MS = 10_000;

export interface CrewRoutesState {
  /** Legs fetched so far, and legs with no road route (kept on the straight-line fallback). */
  fetched: number;
  noRoute: number;
  error: string | null;
}

/**
 * Road drive times for units (POST /api/demo/crew_routes), written into `board.travel` with
 * model.applyTravelLeg: units already en route on a straight-line estimate are re-timed, and
 * the nearest free units to each burning fire are fetched ahead so the commander's options use
 * road times. One request at a time; a leg is asked for once.
 */
export function useCrewRoutes(board: Board | null, version: number): CrewRoutesState {
  const [state, setState] = useState<CrewRoutesState>({ fetched: 0, noRoute: 0, error: null });
  const inflight = useRef(false);
  const asked = useRef<{ board: Board | null; keys: Set<string>; failedAt: number }>({ board: null, keys: new Set(), failedAt: -Infinity });

  useEffect(() => {
    if (!board || inflight.current) return;
    if (asked.current.board !== board) asked.current = { board, keys: new Set(), failedAt: -Infinity };
    if (Date.now() - asked.current.failedAt < RETRY_WALL_MS) return;
    const seen = asked.current.keys;
    const requests: CrewRouteRequest[] = [];
    const want = (key: string, kind: keyof typeof GROUND_APPARATUS, from: LonLat, to: LonLat) => {
      if (requests.length >= MAX_REQUESTS || seen.has(key) || board.travel.has(key)) return;
      requests.push({ id: key, access_class: GROUND_APPARATUS[kind].access, from, to });
    };
    for (const team of board.teams) {
      if (team.status === "en_route" && team.travel === "straight_line" && team.fireId && team.target) {
        want(travelKey(team, team.position, team.fireId), team.kind, team.position, team.target);
      }
    }
    const fires = activeFires(board);
    for (const fire of fires) {
      if (fire.status !== "burning") continue;
      const target = crewTarget(fire);
      const free = board.teams
        .filter((t) => t.status === "available")
        .sort((a, b) => distanceM(a.position, fire.origin) - distanceM(b.position, fire.origin))
        .slice(0, PREFETCH_UNITS_PER_FIRE);
      for (const team of free) want(travelKey(team, team.position, fire.id), team.kind, team.position, target);
    }
    if (requests.length === 0) return;

    const body: CrewRoutesRequest = { fires: fires.map((f) => fireRing(f, RING_POINTS) as LonLat[]), requests };
    for (const r of requests) seen.add(r.id);
    inflight.current = true;
    fetch(CREW_ROUTES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as (CrewRoutesResponse & { detail?: string }) | null;
        if (!response.ok || !data || !Array.isArray(data.routes)) {
          throw new Error(data?.detail ?? `The crew routes service returned HTTP ${response.status}.`);
        }
        if (asked.current.board !== board) return;
        let fetched = 0;
        let noRoute = 0;
        for (const route of data.routes) {
          if (route.drive_min === null || route.basis === null) {
            noRoute += 1;
            continue;
          }
          applyTravelLeg(board, route.id, { driveMinutes: route.drive_min, line: route.line, basis: route.basis });
          fetched += 1;
        }
        setState((s) => ({ fetched: s.fetched + fetched, noRoute: s.noRoute + noRoute, error: null }));
      })
      .catch((error: unknown) => {
        for (const r of requests) seen.delete(r.id);
        asked.current.failedAt = Date.now();
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : "Crew routes unavailable." }));
      })
      .finally(() => {
        inflight.current = false;
      });
  }, [board, version]);

  return state;
}
