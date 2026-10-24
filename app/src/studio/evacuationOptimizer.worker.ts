/** Runs one evacuation optimisation per message off the main thread. See contracts.ts. */

import type { OptimizerRequest, OptimizerResponse } from "./contracts";
import { optimizeEvacuation } from "./evacuationOptimizer";

// Same typing as solver.worker.ts: a dedicated worker scope behaves as a `Worker` here.
const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<OptimizerRequest>) => {
  const request = event.data;
  if (request.type !== "optimize") return;
  let response: OptimizerResponse;
  try {
    const result = optimizeEvacuation(request.inputs, {
      maxEvaluations: request.maxEvaluations,
      onProgress: (done, total) =>
        scope.postMessage({
          type: "progress",
          requestId: request.requestId,
          done,
          total,
        } satisfies OptimizerResponse),
    });
    response = { type: "result", requestId: request.requestId, result };
  } catch (cause) {
    response = {
      type: "error",
      requestId: request.requestId,
      message: cause instanceof Error ? cause.message : "The evacuation optimiser failed.",
    };
  }
  scope.postMessage(response);
};
