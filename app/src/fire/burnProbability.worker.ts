/**
 * Runs one burn-probability ensemble (ensemble.ts) off the main thread and reports progress
 * after each member. One request at a time; the page terminates the worker to cancel.
 */

import { burnProbabilityEnsemble, type BurnProbabilityOptions, type BurnProbabilityRaster } from "./ensemble";
import type { LandscapeGrid } from "./landscape";
import type { ScheduledFireInput } from "./scheduledTypes";

export interface BurnProbabilityRequest {
  type: "run";
  requestId: number;
  landscape: LandscapeGrid;
  input: ScheduledFireInput;
  options: Omit<BurnProbabilityOptions, "onProgress">;
}

export type BurnProbabilityResponse =
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "result"; requestId: number; raster: BurnProbabilityRaster }
  | { type: "error"; requestId: number; message: string };

const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<BurnProbabilityRequest>) => {
  const request = event.data;
  if (request.type !== "run") return;
  try {
    const raster = burnProbabilityEnsemble(request.landscape, request.input, {
      ...request.options,
      onProgress: (done, total) =>
        scope.postMessage({
          type: "progress",
          requestId: request.requestId,
          done,
          total,
        } satisfies BurnProbabilityResponse),
    });
    scope.postMessage({ type: "result", requestId: request.requestId, raster } satisfies BurnProbabilityResponse);
  } catch (cause) {
    scope.postMessage({
      type: "error",
      requestId: request.requestId,
      message: cause instanceof Error ? cause.message : "The burn probability run failed.",
    } satisfies BurnProbabilityResponse);
  }
};
