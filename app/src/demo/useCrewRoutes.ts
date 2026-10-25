import { useEffect, useRef, useState } from "react";
import type { LonLat } from "../live/types";
import { CREW_ROUTES_URL, demoUrl, type CrewRouteRequest, type CrewRoutesRequest, type CrewRoutesResponse } from "./contracts";
import { fireRingsForRouting } from "./fireFootprint";
import {
  activeFires,
  applyTravelLeg,
  attackPositions,
  crewTarget,
  dispatchable,
  distanceM,
  legAwaited,
  legStatus,
  positionDestKey,
  reachableFree,
  roadLegsAwaited,
  travelKey,
  travelLegFailed,
  tripStart,
  type Board,
  type Team,
} from "./model";
import { rescueLegWants } from "./injuries";
import { accessClassOf } from "./realism";
import { answerCovers } from "./roadClosures";

/** Free units per burning fire whose road time is fetched ahead: those its options list (model.containOptions, 4). */
export const PREFETCH_UNITS_PER_FIRE = 4;
/** Free units per attack position whose road time is fetched ahead: those its options list (model.positionOptions, 2). */
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
  /** How many units its options list (fetched after the per-class probes, in option order). */
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
 * units waiting for their road route and of released units waiting for their road home; per target, the PROBES_PER_CLASS nearest free
 * units of each access class (straight line, ties by id); then the units the target's options
 * would list now (model.reachableFree, by arrival) that are still on the estimate. Units known
 * unable to reach a target (model.legStatus "none") and legs already known or in `seen` are
 * skipped. Pure and deterministic for a board.
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
    // Dispatched units waiting to set off (not while backing off after a fire cut), released
    // units waiting for their road home, and units moving up to cover a station (model.legAwaited).
    if (legAwaited(board, team)) want(team.legKey!, team.kind, team.position, team.target!);
  }
  // Free and returning units; a returning unit's trips start from its tripStart point (model.tripStart).
  const free = board.teams.filter(dispatchable);
  const origin = new Map(free.map((t) => [t.id, tripStart(board, t).from] as const));
  const lists = targets.map((t) =>
    free
      .filter((team) => legStatus(board, team, t.destKey, t.to).route !== "none")
      .sort((a, b) => distanceM(origin.get(a.id)!, t.near) - distanceM(origin.get(b.id)!, t.near) || a.id.localeCompare(b.id)),
  );
  const ask = (team: Team, t: RouteTarget) => {
    const from = origin.get(team.id) ?? team.position;
    want(travelKey(team, from, t.destKey, t.to), team.kind, from, t.to);
  };
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
  // The units the options would list now (by arrival, estimates included): fetch those still on
  // the estimate. Their road times replace the (usually shorter) estimate, so the next batch
  // fetches the units that move up, until the listed ones all have road times.
  targets.forEach((t) => {
    for (const r of reachableFree(board, t.destKey, t.to).slice(0, t.extra)) if (!r.road) ask(r.team, t);
  });
  // Waiting injuries: the nearest free ambulances' road legs, so a send_rescue knows their road time (or that they cannot reach).
  for (const w of rescueLegWants(board)) want(travelKey(w.team, w.from, w.destKey, w.to), w.team.kind, w.from, w.to);
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
 * each access class, so each class's reachability is known (model.classReach); then the units
 * its options list while they are still on the estimate, so the commander's options use road times. Units already known unable to
 * reach a target (own leg failed, or their class cannot) are skipped. A trip with no road route
 * is recorded with the router's reason (model.travelLegFailed releases units waiting on it, and
 * notes the class). At most MAX_REQUESTS legs per request, one request at a time (the effect
 * runs again on the next board version for the rest); a leg is asked for once.
 */
export function useCrewRoutes(board: Board | null, version: number, incidentId: string, paused = false): CrewRoutesState {
  const [state, setState] = useState<CrewRoutesState>({ fetched: 0, noRoute: 0, error: null });
  const inflight = useRef(false);
  const asked = useRef<{ board: Board | null; keys: Set<string>; failedAt: number }>({ board: null, keys: new Set(), failedAt: -Infinity });
  // Bumped to ask again at once for legs dropped because a road closure arrived while they were in flight.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!board || inflight.current || paused) return;
    if (asked.current.board !== board) asked.current = { board, keys: new Set(), failedAt: -Infinity };
    if (Date.now() - asked.current.failedAt < RETRY_WALL_MS) return;
    const seen = asked.current.keys;
    const requests = crewRouteRequests(board, seen);
    if (requests.length === 0) return;

    const body: CrewRoutesRequest = { fires: fireRingsForRouting(board, RING_POINTS), requests };
    for (const r of requests) seen.add(r.id);
    inflight.current = true;
    let askAgain = false;
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
        if (!answerCovers(board, data.closed_segment_ids)) {
          // Legs planned without a controller road closure the board knows of (demo/roadClosures.ts): never used.
          for (const r of requests) seen.delete(r.id);
          if (data.closures_status === "unavailable") {
            asked.current.failedAt = Date.now();
            setState((s) => ({ ...s, error: "road legs ignore a controller road closure (closure store unavailable); retrying" }));
          } else askAgain = true;
          return;
        }
        const { fetched, noRoute } = applyCrewRoutes(board, data.routes);
        // Answered legs are now in board.travel / board.noRoute (crewRouteRequests skips those);
        // forget them here so a leg the board drops later (a fire cut, model.rerouteTeam) is asked again.
        for (const route of data.routes) seen.delete(route.id);
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
        if (askAgain) setRetry((n) => n + 1);
      });
  }, [board, version, incidentId, retry, paused]);

  return state;
}

/**
 * Real-time cap on holding the board clock for one road leg, ms. **ASSUMPTION** (no source): a
 * crew_routes round trip takes about 2-3 s, so 10 s covers a slow answer and the request after a
 * busy one (one request at a time) without freezing the board when the router is down.
 */
export const ROAD_LEG_HOLD_MAX_MS = 10_000;

/** The board clock's road-leg hold: model.step's `holdForLegs`. */
export interface RoadLegHold {
  /** True while some leg the board waits on (model.roadLegsAwaited) has waited less than the cap. */
  holds(board: Board): boolean;
  /** Legs whose hold ran out while still pending, on the current board (the clock moved on without them). */
  expired(): string[];
}

/**
 * Holds the board clock while a dispatched, returning or moving-up unit waits for its road leg
 * (as model.step holds while a fire solve is due), so the unit sets off at the board minute it was
 * sent and response times do not depend on the router's latency or the playback speed. Each leg
 * is held for at most `maxMs` of real time (`now`, ms) from when the hold first saw it; after that
 * the clock runs on and the unit waits where it stands as before (console.warn once per leg).
 * Results are then machine-dependent, which the warning says. State is per board.
 */
export function createRoadLegHold(maxMs: number = ROAD_LEG_HOLD_MAX_MS, now: () => number = () => performance.now()): RoadLegHold {
  let current: Board | null = null;
  const since = new Map<string, number>();
  const expired = new Set<string>();
  return {
    holds(board) {
      if (board !== current) {
        current = board;
        since.clear();
        expired.clear();
      }
      const keys = roadLegsAwaited(board);
      const live = new Set(keys);
      for (const k of [...since.keys()]) if (!live.has(k)) since.delete(k);
      for (const k of [...expired]) if (!live.has(k)) expired.delete(k);
      const t = now();
      let hold = false;
      for (const k of keys) {
        const start = since.get(k) ?? t;
        since.set(k, start);
        if (t - start < maxMs) hold = true;
        else if (!expired.has(k)) {
          expired.add(k);
          console.warn(
            `Board clock no longer held for road leg ${k} at board minute ${board.minute.toFixed(2)}: no answer from crew_routes within ${maxMs / 1000} s; the unit waits where it stands and this run's timing now depends on the router's latency.`,
          );
        }
      }
      return hold;
    },
    expired: () => [...expired],
  };
}
