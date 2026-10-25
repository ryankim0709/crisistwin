/**
 * The /run page's fast baseline: steps the same board model as the clock (model.step) as fast as
 * the model and the routing endpoints allow, instead of at a playback speed. It does what the
 * headless harness does (scripts/live-eval/evaluate.ts `settle` / `advance`): before the clock
 * moves, every due fire solve (in a worker, fireSolver.worker.ts), every due zone route refresh
 * (POST /api/demo/routes, the useDemoRoutes rule, with the page's safe-destination exclusions) and
 * every road leg the clock waits on (POST /api/demo/crew_routes, model.roadLegsAwaited) is
 * awaited. So the run never outruns a pending answer, and the result depends only on the seed
 * and the backend's answers, not on network latency or the machine. Steps are one board minute
 * (whole minute to whole minute), so the score timeline gets one point per minute.
 *
 * It yields to the browser between steps (setTimeout 0 every FRAME_BUDGET_MS of work) and calls
 * `onView` at most every VIEW_EVERY_MS so the page redraws the 3D board now and then instead of
 * every step. No React here; the page's own background hooks are paused while it runs
 * (useCommandBoard). Everything it computes is simulated.
 */

import { CREW_ROUTES_URL, ROUTES_URL, demoUrl, type CrewRoutesRequest, type CrewRoutesResponse, type RoutesResponse } from "./contracts";
import { fireRingsForRouting } from "./fireFootprint";
import type { FireSolveResult } from "./fireField";
import type { FireSolverMessage, FireSolverReply } from "./fireSolver.worker";
import { applyFireSolve, buildFireSolveRequest, fireSolveDue, fireSolveFailed, roadLegsAwaited, setRoutes, step, type Board } from "./model";
import { answerCovers } from "./roadClosures";
import { applyCrewRoutes, crewRouteRequests } from "./useCrewRoutes";
import { ROUTE_REFRESH_MINUTES, resolveRoutes, routesBody, routesPlan } from "./useDemoRoutes";
import type { Destination } from "../live/types";
import type { LandscapeGrid } from "../fire/landscape";

/** Main-thread work between two yields to the browser, ms (keeps the page responsive). UI choice. */
const FRAME_BUDGET_MS = 24;
/** Wall time between two redraws of the 3D board during a fast run, ms. UI choice. */
export const VIEW_EVERY_MS = 400;
/** Board minutes per step: one whole minute (the score timeline's resolution). */
const STEP_MINUTES = 1;
/** Retries of a failed routing request before the fast run stops with the error. */
const REQUEST_ATTEMPTS = 3;
const RETRY_WAIT_MS = 1_000;
/** Vertices per fire ring sent to the routing endpoints (their limit is 200; as useCrewRoutes). */
const RING_POINTS = 48;

export interface FastRunStats {
  /** Board minute reached. */
  minute: number;
  wallMs: number;
  solves: number;
  solveMs: number;
  routeCalls: number;
  routeMs: number;
  crewCalls: number;
  crewMs: number;
  /** True when the caller stopped it before `toMinute`. */
  stopped: boolean;
}

export interface FastRunOptions {
  board: Board;
  incidentId: string;
  /** The drill's destinations (useDemoRoutes' safe-destination exclusions). */
  destinations?: readonly Destination[] | null;
  /** Stop at this board minute (the run length). */
  toMinute: number;
  solver: FireSolverClient;
  /** After every step (and at the start): record the score point / snapshot. */
  onSample: (board: Board) => void;
  /** At most every VIEW_EVERY_MS and at the end: redraw. */
  onView: (board: Board) => void;
  /** True once the caller wants it to stop (Stop button, a new board, unmount). */
  cancelled: () => boolean;
}

const yieldToBrowser = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const data = (await r.json().catch(() => null)) as (T & { detail?: string }) | null;
      if (r.ok && data) return data;
      last = new Error(data?.detail ?? `HTTP ${r.status}`);
      if (r.status < 500) break;
    } catch (error) {
      last = error;
    }
    if (attempt < REQUEST_ATTEMPTS) await wait(RETRY_WAIT_MS);
  }
  throw last instanceof Error ? last : new Error("request failed");
}

/** Steps `board` to `toMinute` (see the file comment). Throws when a solve or a routing request fails. */
export async function fastForward(o: FastRunOptions): Promise<FastRunStats> {
  const { board } = o;
  const t0 = performance.now();
  const stats: FastRunStats = { minute: board.minute, wallMs: 0, solves: 0, solveMs: 0, routeCalls: 0, routeMs: 0, crewCalls: 0, crewMs: 0, stopped: false };
  const routeMemo = { key: "\u0000", minute: -Infinity };

  const refreshRoutesIfDue = async (): Promise<boolean> => {
    const plan = routesPlan(board, o.destinations);
    if (plan.key === routeMemo.key && !(plan.burning && board.minute - routeMemo.minute >= ROUTE_REFRESH_MINUTES)) return false;
    routeMemo.key = plan.key;
    routeMemo.minute = board.minute;
    const t = performance.now();
    const data = await postJson<RoutesResponse>(demoUrl(ROUTES_URL, o.incidentId), routesBody(board, plan.excluded));
    stats.routeMs += performance.now() - t;
    stats.routeCalls += 1;
    if (!Array.isArray(data.zones)) throw new Error("The routes service answered without zones.");
    const closed = Array.isArray(data.closed_segment_ids) ? data.closed_segment_ids : [];
    // As useDemoRoutes: an answer computed without a closure the board knows of is never used.
    if (!answerCovers(board, closed)) throw new Error("The routes ignore a controller road closure (closure store unavailable).");
    setRoutes(board, resolveRoutes(data));
    return true;
  };

  const awaitedLegs = async (): Promise<boolean> => {
    if (roadLegsAwaited(board).length === 0) return false;
    const requests = crewRouteRequests(board, new Set());
    if (requests.length === 0) return false;
    const body: CrewRoutesRequest = { fires: fireRingsForRouting(board, RING_POINTS), requests };
    const t = performance.now();
    const data = await postJson<CrewRoutesResponse>(demoUrl(CREW_ROUTES_URL, o.incidentId), body);
    stats.crewMs += performance.now() - t;
    stats.crewCalls += 1;
    if (!answerCovers(board, data.closed_segment_ids)) throw new Error("Road legs ignore a controller road closure.");
    applyCrewRoutes(board, data.routes);
    return true;
  };

  const settle = async (): Promise<void> => {
    for (let guard = 0; guard < 200; guard += 1) {
      if (fireSolveDue(board) !== null) {
        const minute = board.minute;
        const t = performance.now();
        let result: FireSolveResult;
        try {
          result = await o.solver.solve(board.env.landscape, buildFireSolveRequest(board));
        } catch (error) {
          const message = error instanceof Error ? error.message : "The fire model failed.";
          fireSolveFailed(board, message);
          throw new Error(message);
        }
        stats.solveMs += performance.now() - t;
        stats.solves += 1;
        // The page's own solver may have landed the same solve meanwhile (one in flight when the run began).
        if (fireSolveDue(board) !== null && !applyFireSolve(board, result, minute)) throw new Error(`The fire solve for minute ${minute} could not be applied.`);
        continue;
      }
      if (await refreshRoutesIfDue()) continue;
      if (await awaitedLegs()) continue;
      return;
    }
    throw new Error(`The board did not settle at minute ${board.minute.toFixed(1)}.`);
  };

  let sliceStart = performance.now();
  let lastView = sliceStart;
  const holdForLegs = (b: Board) => roadLegsAwaited(b).length > 0;
  await settle();
  o.onSample(board);
  while (board.minute < o.toMinute - 1e-9) {
    if (o.cancelled()) {
      stats.stopped = true;
      break;
    }
    const target = Math.min(o.toMinute, Math.floor(board.minute + 1e-9) + STEP_MINUTES);
    for (let guard = 0; board.minute < target - 1e-9; guard += 1) {
      if (guard > 1000) throw new Error(`The board clock did not advance at minute ${board.minute.toFixed(1)}.`);
      await settle();
      step(board, target - board.minute, holdForLegs);
    }
    await settle();
    o.onSample(board);
    const now = performance.now();
    if (now - lastView >= VIEW_EVERY_MS) {
      lastView = now;
      o.onView(board);
    }
    if (performance.now() - sliceStart >= FRAME_BUDGET_MS) {
      await yieldToBrowser();
      sliceStart = performance.now();
    }
  }
  stats.minute = board.minute;
  stats.wallMs = performance.now() - t0;
  o.onView(board);
  return stats;
}

/** Fire solves in a dedicated worker (fireSolver.worker.ts), one at a time. */
export interface FireSolverClient {
  solve(grid: LandscapeGrid, request: ReturnType<typeof buildFireSolveRequest>): Promise<FireSolveResult>;
  terminate(): void;
}

export function createFireSolverClient(): FireSolverClient {
  let worker: Worker | null = null;
  let sentGrid: LandscapeGrid | null = null;
  let nextId = 0;
  const pending = new Map<number, { resolve: (r: FireSolveResult) => void; reject: (e: Error) => void }>();
  const fail = (message: string) => {
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };
  const ensure = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL("./fireSolver.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<FireSolverReply>) => {
      const reply = event.data;
      const p = pending.get(reply.requestId);
      if (!p) return;
      pending.delete(reply.requestId);
      if (reply.type === "error") p.reject(new Error(reply.message));
      else p.resolve(reply.result);
    };
    w.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      w.terminate();
      if (worker === w) {
        worker = null;
        sentGrid = null;
      }
      fail(`The fire model worker stopped${event.message ? `: ${event.message}` : ""}.`);
    };
    worker = w;
    sentGrid = null;
    return w;
  };
  return {
    solve(grid, request) {
      const w = ensure();
      if (sentGrid !== grid) {
        w.postMessage({ type: "landscape", gridId: 1, grid } satisfies FireSolverMessage);
        sentGrid = grid;
      }
      const requestId = ++nextId;
      return new Promise<FireSolveResult>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        w.postMessage({ type: "solve", requestId, gridId: 1, request } satisfies FireSolverMessage);
      });
    },
    terminate() {
      worker?.terminate();
      worker = null;
      sentGrid = null;
      fail("The fire model worker was stopped.");
    },
  };
}
