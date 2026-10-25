/**
 * Runs the /demo board's fire solves off the main thread (fireField.ts solveFireField). The
 * landscape is sent once per grid and kept; each solve message carries the request.
 *
 * Messages in:  { type: "landscape", gridId, grid } | { type: "solve", requestId, gridId, request }
 * Messages out: { type: "result", requestId, result } | { type: "error", requestId, message }
 */

import type { LandscapeGrid } from "../fire/landscape";
import { solveFireField, transferables, type FireSolveRequest, type FireSolveResult } from "./fireField";

export type FireSolverMessage =
  | { type: "landscape"; gridId: number; grid: LandscapeGrid }
  | { type: "solve"; requestId: number; gridId: number; request: FireSolveRequest };

export type FireSolverReply =
  | { type: "result"; requestId: number; result: FireSolveResult }
  | { type: "error"; requestId: number; message: string };

// The app compiles against the DOM lib, where `self` is a Window; inside a dedicated worker it
// has the same onmessage/postMessage surface as a `Worker` (as studio/solver.worker.ts).
const scope = self as unknown as Worker;
let grid: { id: number; grid: LandscapeGrid } | null = null;

scope.onmessage = (event: MessageEvent<FireSolverMessage>) => {
  const message = event.data;
  if (message.type === "landscape") {
    grid = { id: message.gridId, grid: message.grid };
    return;
  }
  if (!grid || grid.id !== message.gridId) {
    scope.postMessage({ type: "error", requestId: message.requestId, message: "The fire model has no landscape for this board." } satisfies FireSolverReply);
    return;
  }
  try {
    const result = solveFireField(grid.grid, message.request);
    scope.postMessage({ type: "result", requestId: message.requestId, result } satisfies FireSolverReply, transferables(result));
  } catch (cause) {
    scope.postMessage({
      type: "error",
      requestId: message.requestId,
      message: cause instanceof Error ? cause.message : "The fire model failed.",
    } satisfies FireSolverReply);
  }
};
