import { useEffect, useRef, useState } from "react";
import { ROUTES_URL, demoUrl, type RoutesRequest, type RoutesResponse } from "./contracts";
import { fireRingsForRouting } from "./fireFootprint";
import { activeFires, type Board, type RouteOption } from "./model";
import type { RouteSegment } from "./traffic";

/** Re-route at most this often (simulation minutes) while the fires keep growing. */
export const ROUTE_REFRESH_MINUTES = 5;
/** Vertices per fire ring sent to the routing endpoints (their limit is 200). */
const RING_POINTS = 48;
const RETRY_WALL_MS = 10_000;

/** The answer's options with their segment ids resolved (one shared object per segment id). */
function resolveRoutes(data: RoutesResponse): Map<string, RouteOption[]> {
  const table = new Map<string, RouteSegment>();
  const segment = (id: string): RouteSegment | null => {
    const hit = table.get(id);
    if (hit) return hit;
    const raw = data.segments?.[id];
    if (!raw) return null;
    const s: RouteSegment = { id, ...raw };
    table.set(id, s);
    return s;
  };
  return new Map(
    data.zones.map((z) => [
      z.zone_id,
      z.options.map(({ segment_ids, ...o }) => ({
        ...o,
        destination_capacity_veh: o.destination_capacity_veh ?? null,
        segments: (segment_ids ?? []).flatMap((id) => segment(id) ?? []),
      })),
    ]),
  );
}

export interface RoutesState {
  routes: ReadonlyMap<string, RouteOption[]>;
  /** Simulation minute the current routes were computed for; null before the first answer. */
  asOf: number | null;
  error: string | null;
}

/**
 * Zone routes around the fires that are not out (POST /api/demo/routes). Refreshes when the set
 * of active fires changes, and every ROUTE_REFRESH_MINUTES while any fire burns. One request at
 * a time; an answer for an older board is dropped.
 */
export function useDemoRoutes(board: Board | null, version: number, incidentId: string): RoutesState {
  const [state, setState] = useState<RoutesState>({ routes: new Map(), asOf: null, error: null });
  const inflight = useRef(false);
  const last = useRef<{ board: Board | null; key: string; minute: number; failedAt: number }>({
    board: null,
    key: "",
    minute: -Infinity,
    failedAt: -Infinity,
  });

  useEffect(() => {
    if (!board) {
      // Incident switch: forget the old board so its in-flight answer is dropped.
      last.current = { board: null, key: "", minute: -Infinity, failedAt: -Infinity };
      setState((s) => (s.asOf === null && s.routes.size === 0 && !s.error ? s : { routes: new Map(), asOf: null, error: null }));
      return;
    }
    if (inflight.current) return;
    const fires = activeFires(board);
    const key = fires.map((f) => `${f.id}:${f.status}`).join(",");
    const prev = last.current;
    const burning = fires.some((f) => f.status === "burning");
    const due =
      prev.board !== board ||
      key !== prev.key ||
      (burning && board.minute - prev.minute >= ROUTE_REFRESH_MINUTES);
    if (!due || Date.now() - prev.failedAt < RETRY_WALL_MS) return;

    const minute = board.minute;
    const body: RoutesRequest = { fires: fireRingsForRouting(board, RING_POINTS) };
    inflight.current = true;
    last.current = { ...prev, board, key, minute };
    // Not aborted on re-render: the page re-renders several times a second and the answer is still wanted.
    fetch(demoUrl(ROUTES_URL, incidentId), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as (RoutesResponse & { detail?: string }) | null;
        if (!response.ok || !data || !Array.isArray(data.zones)) {
          throw new Error(data?.detail ?? `The routes service returned HTTP ${response.status}.`);
        }
        if (last.current.board !== board) return;
        setState({ routes: resolveRoutes(data), asOf: minute, error: null });
      })
      .catch((error: unknown) => {
        if (last.current.board !== board) return; // an older board's (or incident's) request
        // Forget the key so the request is retried after RETRY_WALL_MS.
        last.current = { ...last.current, key: "", failedAt: Date.now() };
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : "Routes unavailable." }));
      })
      .finally(() => {
        inflight.current = false;
      });
  }, [board, version, incidentId]);

  return state;
}
