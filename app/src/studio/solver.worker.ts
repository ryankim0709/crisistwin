/** Runs one scheduled-fire solve per message off the main thread. See contracts.ts. */

import { simulateScheduledFireSpread } from "../fire/spread";
import { InvalidIgnitionsError } from "../fire/scheduledTypes";
import type { SolverRequest, SolverResponse } from "./contracts";
import { planFirefighting } from "./firefighting";

// The app compiles against the DOM lib, where `self` is a Window. Inside a dedicated worker
// it exposes the same onmessage/postMessage surface as a `Worker`, so type it as one rather
// than pulling the webworker lib into the whole program.
const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  if (request.type !== "solve") return;
  let response: SolverResponse;
  try {
    const run = simulateScheduledFireSpread(request.landscape, request.input);
    const firefighting = request.firefighting?.enabled
      ? planFirefighting(
          request.landscape,
          request.input,
          run,
          request.firefighting,
          (done, total) =>
            scope.postMessage({
              type: "progress",
              requestId: request.requestId,
              done,
              total,
            } satisfies SolverResponse),
        )
      : null;
    response = { type: "result", requestId: request.requestId, run, firefighting };
  } catch (cause) {
    response = {
      type: "error",
      requestId: request.requestId,
      message: cause instanceof Error ? cause.message : "The fire model failed.",
      problems: cause instanceof InvalidIgnitionsError ? cause.problems : [],
    };
  }
  scope.postMessage(response);
};
