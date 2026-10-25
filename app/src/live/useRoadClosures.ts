/**
 * Controller drill road closures on the Live map: the API client, the poll, the close / reopen
 * tool state, and the glue that applies closures to the simulated board (demo/roadClosures.ts).
 *
 * GET/POST /api/live/incidents/<id>/road-closures, GET ...?near=lon,lat, DELETE
 * .../road-closures/<segment_id> (docs/live-reports.md "Road closures"). Every console polls the
 * list (CLOSURE_POLL_MS), so all of them, and the AI agent's observation, see the same closures;
 * the board routers read them server side. A closure is a drill action, labelled as such.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { RoutesState } from "../demo/useDemoRoutes";
import type { Board } from "../demo/model";
import { answerCovers, applyClosureSet, reconcileZones, type RoadClosure } from "../demo/roadClosures";
import { LiveError, request } from "./api";
import { usePoll } from "./usePoll";
import { attachRoadClosureLayer, type RoadClosureLayer } from "./roadClosureLayer";
import { RoadClosureOverlay } from "./roadClosure3d";
import type { LonLat } from "./types";

export const CLOSURE_POLL_MS = 4_000;
/** How long the "Road closed" / "Road reopened" notice stays up, ms. */
const NOTICE_MS = 8_000;
/** A 3D click (not armed) this close to a closed road selects it, metres (no rendered-feature hit test in 3D). */
const SELECT_3D_M = 60;

/** The last close or reopen this console made, for a short notice. */
export interface ClosureNotice {
  id: number;
  kind: "closed" | "reopened";
  name: string;
}

/** Metres from `p` to the polyline (equirectangular, fine at road scale). */
function distanceToLineM(p: LonLat, line: LonLat[]): number {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111_320;
  const m = 111_320;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const ax = (line[i][0] - p[0]) * k;
    const ay = (line[i][1] - p[1]) * m;
    const bx = (line[i + 1][0] - p[0]) * k;
    const by = (line[i + 1][1] - p[1]) * m;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** The road the controller picked on the map, before confirming (or a closed one, to reopen). */
export interface ClosureCandidate {
  segmentId: string;
  name: string;
  line: LonLat[];
  closed: boolean;
  /** The closure when it is closed. */
  closure: RoadClosure | null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isLine = (v: unknown): v is LonLat[] =>
  Array.isArray(v) && v.length >= 2 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)));

function parseClosure(raw: unknown): RoadClosure | null {
  const c = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!isStr(c.segment_id) || !isLine(c.line)) return null;
  return {
    segmentId: c.segment_id,
    name: isStr(c.name) && c.name ? c.name : c.segment_id,
    line: c.line,
    closedAt: isStr(c.closed_at) ? c.closed_at : null,
    boardMinute: typeof c.board_minute === "number" && Number.isFinite(c.board_minute) ? c.board_minute : null,
    by: isStr(c.by) && c.by ? c.by : "controller",
  };
}

const base = (incidentId: string) => `incidents/${encodeURIComponent(incidentId)}/road-closures`;

export async function fetchRoadClosures(token: string, incidentId: string, signal?: AbortSignal): Promise<RoadClosure[]> {
  const data = await request<{ closures?: unknown } | null>(token, "GET", base(incidentId), undefined, signal);
  if (!data || !Array.isArray(data.closures)) throw new LiveError(200, "bad_response", "The road closure list returned an unexpected response.");
  return data.closures.flatMap((c) => parseClosure(c) ?? []);
}

async function fetchNearestRoad(token: string, incidentId: string, at: LonLat): Promise<ClosureCandidate | null> {
  const near = `${at[0].toFixed(6)},${at[1].toFixed(6)}`;
  const data = await request<{ segment?: Record<string, unknown> | null } | null>(token, "GET", `${base(incidentId)}?near=${near}`);
  const s = data?.segment;
  if (!s || !isStr(s.segment_id) || !isLine(s.line)) return null;
  return { segmentId: s.segment_id, name: isStr(s.name) ? s.name : s.segment_id, line: s.line, closed: s.closed === true, closure: null };
}

export interface RoadClosuresOptions {
  /** Controller token (null: not connected). */
  token: string | null;
  incidentId: string;
  board: Board | null;
  /** The board's zone routes (useDemoRoutes): a covering answer reroutes leaving zones. */
  routes: RoutesState;
  /** Marks an in-place board change (useCommandBoard bump). */
  bump: () => void;
}

export function useRoadClosures({ token, incidentId, board, routes, bump }: RoadClosuresOptions) {
  const fetcher = useCallback(
    async (t: string, signal: AbortSignal) => ({ incidentId, closures: await fetchRoadClosures(t, incidentId, signal) }),
    [incidentId],
  );
  const poll = usePoll(token, fetcher, CLOSURE_POLL_MS, "Road closure list");
  // The poll keeps the previous incident's answer until the new one lands: ignore it meanwhile.
  const listed = poll.data?.incidentId === incidentId ? poll.data.closures : null;
  const closures = useMemo(() => listed ?? [], [listed]);
  const [armed, setArmed] = useState(false);
  const [candidate, setCandidate] = useState<ClosureCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ClosureNotice | null>(null);
  const noticeId = useRef(0);
  const announce = useCallback((kind: ClosureNotice["kind"], name: string) => {
    noticeId.current += 1;
    setNotice({ id: noticeId.current, kind, name });
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

  // The board follows the closure list (units reroute at once; zones on the next covering routes answer).
  useEffect(() => {
    if (!board || !listed) return;
    if (applyClosureSet(board, listed)) bump();
  }, [board, listed, bump]);
  useEffect(() => {
    if (!board || routes.closedSegmentIds === null || !answerCovers(board, routes.closedSegmentIds)) return;
    if (reconcileZones(board, routes.routes)) bump();
  }, [board, routes.routes, routes.closedSegmentIds, bump]);

  // ---- tool ----
  const refs = useRef({ token, incidentId, armed, closures });
  useEffect(() => {
    refs.current = { token, incidentId, armed, closures };
  });

  const pickAt = useCallback(async (at: LonLat) => {
    const { token: t, incidentId: inc } = refs.current;
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const hit = await fetchNearestRoad(t, inc, at);
      if (!hit) {
        setCandidate(null);
        setError("No drill road there. Click on a road.");
        return;
      }
      const closure = refs.current.closures.find((c) => c.segmentId === hit.segmentId) ?? null;
      setCandidate({ ...hit, closed: hit.closed || !!closure, closure });
      setArmed(false);
    } catch (e) {
      setError(e instanceof LiveError ? e.message : "Could not look up that road.");
    } finally {
      setBusy(false);
    }
  }, []);

  const selectClosure = useCallback((segmentId: string) => {
    const closure = refs.current.closures.find((c) => c.segmentId === segmentId);
    if (!closure) return;
    setArmed(false);
    setError(null);
    setCandidate({ segmentId, name: closure.name, line: closure.line, closed: true, closure });
  }, []);

  const confirmClose = useCallback(async () => {
    if (!token || !candidate || candidate.closed) return;
    setBusy(true);
    setError(null);
    try {
      await request(token, "POST", base(incidentId), {
        segment_id: candidate.segmentId,
        board_minute: board ? Math.round(board.minute) : null,
      });
      setCandidate(null);
      announce("closed", candidate.name);
      poll.refresh();
    } catch (e) {
      setError(e instanceof LiveError ? e.message : "Could not close the road.");
    } finally {
      setBusy(false);
    }
  }, [token, candidate, incidentId, board, poll, announce]);

  const reopen = useCallback(
    async (segmentId: string) => {
      if (!token) return;
      setBusy(true);
      setError(null);
      try {
        await request(token, "DELETE", `${base(incidentId)}/${encodeURIComponent(segmentId)}`);
        const name = refs.current.closures.find((c) => c.segmentId === segmentId)?.name;
        if (name) announce("reopened", name);
        setCandidate((c) => (c?.segmentId === segmentId ? null : c));
        poll.refresh();
      } catch (e) {
        setError(e instanceof LiveError ? e.message : "Could not reopen the road.");
      } finally {
        setBusy(false);
      }
    },
    [token, incidentId, poll, announce],
  );

  const arm = useCallback(() => {
    setArmed(true);
    setCandidate(null);
    setError(null);
    setNotice(null);
  }, []);
  const cancel = useCallback(() => {
    setArmed(false);
    setCandidate(null);
    setError(null);
  }, []);

  // Esc leaves the tool.
  useEffect(() => {
    if (!armed && !candidate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, candidate, cancel]);

  // ---- map ----
  const layer = useRef<RoadClosureLayer | null>(null);
  const handlers = useRef({ pickAt, selectClosure });
  useEffect(() => {
    handlers.current = { pickAt, selectClosure };
  });
  useEffect(() => {
    layer.current?.update(board ? closures : [], candidate && !candidate.closed ? candidate.line : null, armed);
  }, [board, closures, candidate, armed]);
  /** Attach the closure layers (call from CommandMap's onMapReady, before the board layers); returns the cleanup. */
  const attach = useCallback((map: MapLibreMap) => {
    const l = attachRoadClosureLayer(map, {
      armed: () => refs.current.armed,
      onPick: (at) => void handlers.current.pickAt(at),
      onSelect: (id) => handlers.current.selectClosure(id),
    });
    layer.current = l;
    return () => {
      l.dispose();
      layer.current = null;
    };
  }, []);
  // ---- 3D diorama ----
  const [overlay3d] = useState(() => new RoadClosureOverlay());
  useEffect(() => {
    overlay3d.update(board ? closures : [], candidate && !candidate.closed ? { line: candidate.line, name: candidate.name } : null);
  }, [overlay3d, board, closures, candidate]);
  /** A click on the 3D board (DemoDiorama onGroundPick): picks the road there while armed, else selects a closed road near it. */
  const groundClick = useCallback((at: LonLat) => {
    if (refs.current.armed) {
      void handlers.current.pickAt(at);
      return;
    }
    let best: { id: string; d: number } | null = null;
    for (const c of refs.current.closures) {
      const d = distanceToLineM(at, c.line);
      if (d <= SELECT_3D_M && (!best || d < best.d)) best = { id: c.segmentId, d };
    }
    if (best) handlers.current.selectClosure(best.id);
  }, []);

  /** CommandMap interceptClick: the click belongs to the closure tool (armed, or on a closed road). */
  const claimsClick = useCallback((e: MapMouseEvent) => layer.current?.claimsClick(e) ?? false, []);
  /** True while a click the closure tool took is being handled (the board layers then ignore it). */
  const claimedClick = useCallback(() => layer.current?.claimedClick() ?? false, []);

  return {
    closures,
    loadError: poll.error ? poll.error.message : null,
    armed,
    candidate,
    busy,
    error,
    canEdit: !!token && !!board,
    /** Why the tool cannot be used now (null when it can). */
    disabledReason: !token
      ? "Connect with the controller token to close roads."
      : !board
        ? "Waiting for the simulated board to load."
        : null,
    notice,
    dismissNotice: () => setNotice(null),
    arm,
    cancel,
    confirmClose,
    reopen,
    selectClosure,
    attach,
    claimsClick,
    claimedClick,
    overlay3d,
    groundClick,
  };
}

export type RoadClosuresState = ReturnType<typeof useRoadClosures>;
