/**
 * Keeps the board's fire field solved (fireField.ts, in fireSolver.worker.ts). Whenever
 * model.fireSolveDue reports a reason, it posts model.buildFireSolveRequest to the worker and,
 * when the answer comes, installs it with model.applyFireSolve and calls `onApplied` (the page
 * bumps its version). The board clock holds meanwhile (model.step), so results do not depend on
 * how long a solve takes. One solve at a time; an answer for another board or minute is dropped
 * and the solve asked again. A failed solve is recorded on the board (shown by the page) and
 * retried after RETRY_WALL_MS.
 */

import { useEffect, useRef, useState } from "react";
import type { LandscapeGrid } from "../fire/landscape";
import type { FireSolverMessage, FireSolverReply } from "./fireSolver.worker";
import { applyFireSolve, buildFireSolveRequest, fireSolveDue, fireSolveFailed, type Board } from "./model";

const RETRY_WALL_MS = 10_000;

export interface FireSolverState {
  /** Why a solve is running now, or null. */
  solving: string | null;
  /** Wall time of the last solve in the worker, milliseconds. */
  lastSolveMs: number | null;
  error: string | null;
}

const gridIds = new WeakMap<LandscapeGrid, number>();
let nextGridId = 0;
function gridId(grid: LandscapeGrid): number {
  let id = gridIds.get(grid);
  if (id === undefined) {
    id = ++nextGridId;
    gridIds.set(grid, id);
  }
  return id;
}

export function useFireSolver(board: Board | null, version: number, onApplied: () => void): FireSolverState {
  const [state, setState] = useState<FireSolverState>({ solving: null, lastSolveMs: null, error: null });
  const workerRef = useRef<Worker | null>(null);
  const sentGrid = useRef<number | null>(null);
  const inflight = useRef<{ requestId: number; board: Board; minute: number } | null>(null);
  const nextRequest = useRef(0);
  const failedAt = useRef(-Infinity);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  const boardRef = useRef(board);
  boardRef.current = board;
  const [retryTick, setRetryTick] = useState(0);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!board) return;
    if (inflight.current) return;
    const due = fireSolveDue(board);
    if (due === null) {
      setState((s) => (s.solving === null ? s : { ...s, solving: null }));
      return;
    }
    if (board.solver.error && Date.now() - failedAt.current < RETRY_WALL_MS) {
      const wait = RETRY_WALL_MS - (Date.now() - failedAt.current);
      const id = window.setTimeout(() => setRetryTick((t) => t + 1), wait);
      return () => window.clearTimeout(id);
    }
    let worker = workerRef.current;
    if (!worker) {
      worker = new Worker(new URL("./fireSolver.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<FireSolverReply>) => {
        const reply = event.data;
        const asked = inflight.current;
        if (!asked || asked.requestId !== reply.requestId) return;
        inflight.current = null;
        const current = boardRef.current;
        if (current !== asked.board) {
          setState((s) => ({ ...s, solving: null }));
          return;
        }
        if (reply.type === "error") {
          failedAt.current = Date.now();
          fireSolveFailed(current, reply.message);
          setState((s) => ({ ...s, solving: null, error: reply.message }));
        } else {
          applyFireSolve(current, reply.result, asked.minute);
          setState({ solving: null, lastSolveMs: reply.result.computeMilliseconds, error: null });
        }
        onAppliedRef.current();
      };
      workerRef.current = worker;
      sentGrid.current = null;
    }
    const grid = board.env.landscape;
    const id = gridId(grid);
    if (sentGrid.current !== id) {
      worker.postMessage({ type: "landscape", gridId: id, grid } satisfies FireSolverMessage);
      sentGrid.current = id;
    }
    // A retry clears the failure so the request can be built; it is set again if it fails.
    board.solver.error = null;
    const request = buildFireSolveRequest(board);
    const requestId = ++nextRequest.current;
    inflight.current = { requestId, board, minute: board.minute };
    setState((s) => ({ ...s, solving: due }));
    worker.postMessage({ type: "solve", requestId, gridId: id, request } satisfies FireSolverMessage);
  }, [board, version, retryTick]);

  return state;
}
