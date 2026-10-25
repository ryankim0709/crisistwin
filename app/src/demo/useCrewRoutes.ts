import { useEffect, useRef, useState } from "react";
import type { LonLat } from "../live/types";
import { CREW_ROUTES_URL, demoUrl, type CrewRouteRequest, type CrewRoutesRequest, type CrewRoutesResponse } from "./contracts";
import { fireRingsForRouting } from "./fireFootprint";
import {
  activeFires,
  applyTravelLeg,
  attackPositions,
  crewTarget,
  distanceM,
  legStatus,
  positionDestKey,
  travelKey,
  travelLegFailed,
  type Board,
  type Team,
} from "./model";
import { accessClassOf } from "./realism";

/** Free units per burning fire whose road time is fetched ahead (nearest by straight line). */
export const PREFETCH_UNITS_PER_FIRE = 4;
/** Free units per attack position whose road time is fetched ahead. */
export const PREFETCH_UNITS_PER_POSITION = 2;
/**
 * Reachability probes: per target (each burning fire's crew target and each of its attack
 * positions) and per access class among the free units, the road legs of this many nearest
 * units of that class (model.REACH_CONFIRM_ORIGINS origins decide that a class cannot reach).
 */
export const PROBES_PER_CLASS = 2;
/** Legs per request (the endpoint's limit is 40). */
const MAX_REQUESTS = 40;
/** Vertices per fire ring sent to the routing endpoints (their limit is 200). */
const RING_POINTS = 48;
const RETRY_WALL_MS = 10_000;

export interface CrewRoutesState {
  /** Legs fetched so far, and legs with no road route (kept on the straight-line fallback). */
  fetched: number;
  noRoute: number;
  error: string | null;
}

/** A trip destination road legs are fetched for: a fire's crew target (destKey = fire id) or an attack position (its line id). */
export interface RouteTarget {
  destKey: string;
  to: LonLat;
  /** Where "nearest" is measured from (the fire's origin for direct attack). */
  near: LonLat;
  /** Nearest units overall to fetch after the per-class probes. */
  extra: number;
}

/** Each burning fire's crew target and each of its attack positions (re-planned positions are new targets). */
export function routeTargets(board: Board): RouteTarget[] {
  const targets: RouteTarget[] = [];
  for (const fire of activeFires(board)) {
    if (fire.status !== "burning") continue;
    targets.push({ destKey: fire.id, to: crewTarget(fire), near: fire.origin, extra: PREFETCH_UNITS_PER_FIRE });
    for (const pos of attackPositions(board, fire)) {
      targets.push({ destKey: positionDestKey(fire, pos), to: pos.point, near: pos.point, extra: PREFETCH_UNITS_PER_POSITION });
    }
  }
  return targets;
}

/**
 * The next batch of road legs to ask for (at most `max`), in priority order: trips of dispatched
 * units waiting at base for their road route; per target, the PROBES_PER_CLASS nearest free
 * units of each access class (straight line, ties by id); then the target's nearest free units
 * overall. Units known unable to reach a target (model.legStatus "none") and legs already known
 * or in `seen` are skipped. Pure and deterministic for a board.
 */
export function crewRouteRequests(
  board: Board,
  seen: ReadonlySet<string>,
  targets: RouteTarget[] = routeTargets(board),
  max = MAX_REQUESTS,
): CrewRouteRequest[] {
  const requests: CrewRouteRequest[] = [];
  const ids = new Set<string>();
  const want = (key: string, kind: Team["kind"], from: LonLat, to: LonLat) => {
    if (requests.length >= max || ids.has(key) || seen.has(key) || board.travel.has(key) || board.noRoute.has(key)) return;
    ids.add(key);
    requests.push({ id: key, access_class: accessClassOf(kind), from, to });
  };
  for (const team of board.teams) {
    if (team.status === "en_route" && team.travel === "pending" && team.legKey && team.target) {
      want(team.legKey, team.kind, team.position, team.target);
    }
  }
  const free = board.teams.filter((t) => t.status === "available");
  const lists = targets.map((t) =>
    free
      .filter((team) => legStatus(board, team, t.destKey, t.to).route !== "none")
      .sort((a, b) => distanceM(a.position, t.near) - distanceM(b.position, t.near) || a.id.localeCompare(b.id)),
  );
  const ask = (team: Team, t: RouteTarget) => want(travelKey(team, team.position, t.destKey, t.to), team.kind, team.position, t.to);
  targets.forEach((t, i) => {
    const perClass = new Map<string, number>();
    for (const team of lists[i]) {
      const access = accessClassOf(team.kind);
      const n = perClass.get(access) ?? 0;
      if (n >= PROBES_PER_CLASS) continue;
      perClass.set(access, n + 1);
      ask(team, t);
    }
  });
  targets.forEach((t, i) => {
    for (const team of lists[i].slice(0, t.extra)) ask(team, t);
  });
  return requests;
}

/** Writes an answer's legs into the board (model.applyTravelLeg / travelLegFailed); returns the counts. */
export function applyCrewRoutes(board: Board, routes: CrewRoutesResponse["routes"]): { fetched: number; noRoute: number } {
  let fetched = 0;
  let noRoute = 0;
  for (const route of routes) {
    if (route.drive_min === null || route.basis === null) {
      travelLegFailed(board, route.id, route.reason ?? "no road route");
      noRoute += 1;
      continue;
    }
    applyTravelLeg(board, route.id, { driveMinutes: route.drive_min, line: route.line, basis: route.basis });
    fetched += 1;
  }
  return { fetched, noRoute };
}

/**
 * Road drive times for units (POST /api/demo/crew_routes), written into `board.travel` with
 * model.applyTravelLeg. First the trips of units dispatched and waiting at base for their road
 * route (keyed by the trip they are on, `team.legKey`, to their actual destination: the fire's
 * anchor or their attack line); then, for each burning fire's crew target and each of its attack
 * positions (re-planned positions are new targets), the PROBES_PER_CLASS nearest free units of
 * each access class, so each class's reachability is known (model.classReach); then the nearest
 * free units overall, so the commander's options use road times. Units already known unable to
 * reach a target (own leg failed, or their class cannot) are skipped. A trip with no road route
 * is recorded with the router's reason (model.travelLegFailed releases units waiting on it, and
 * notes the class). At most MAX_REQUESTS legs per request, one request at a time (the effect
 * runs again on the next board version for the rest); a leg is asked for once.
 */
export function useCrewRoutes(board: Board | null, version: number, incidentId: string): CrewRoutesState {
  const [state, setState] = useState<CrewRoutesState>({ fetched: 0, noRoute: 0, error: null });
  const inflight = useRef(false);
  const asked = useRef<{ board: Board | null; keys: Set<string>; failedAt: number }>({ board: null, keys: new Set(), failedAt: -Infinity });

  useEffect(() => {
    if (!board || inflight.current) return;
    if (asked.current.board !== board) asked.current = { board, keys: new Set(), failedAt: -Infinity };
    if (Date.now() - asked.current.failedAt < RETRY_WALL_MS) return;
    const seen = asked.current.keys;
    const requests = crewRouteRequests(board, seen);
    if (requests.length === 0) return;

    const body: CrewRoutesRequest = { fires: fireRingsForRouting(board, RING_POINTS), requests };
    for (const r of requests) seen.add(r.id);
    inflight.current = true;
    fetch(demoUrl(CREW_ROUTES_URL, incidentId), {
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
        const { fetched, noRoute } = applyCrewRoutes(board, data.routes);
        setState((s) => ({ fetched: s.fetched + fetched, noRoute: s.noRoute + noRoute, error: null }));
      })
      .catch((error: unknown) => {
        if (asked.current.board !== board) return; // an older board's (or incident's) request
        for (const r of requests) seen.delete(r.id);
        asked.current.failedAt = Date.now();
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : "Crew routes unavailable." }));
      })
      .finally(() => {
        inflight.current = false;
      });
  }, [board, version, incidentId]);

  return state;
}
