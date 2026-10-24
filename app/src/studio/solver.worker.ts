/// <reference lib="webworker" />
/** Runs one scheduled-fire solve per message off the main thread. See contracts.ts. */

import { simulateScheduledFireSpread } from "../fire/spread";
import { InvalidIgnitionsError } from "../fire/scheduledTypes";
import type { SolverRequest, SolverResponse } from "./contracts";

self.onmessage = (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  if (request.type !== "solve") return;
  let response: SolverResponse;
  try {
    const run = simulateScheduledFireSpread(request.landscape, request.input);
    response = { type: "result", requestId: request.requestId, run };
  } catch (cause) {
    response = {
      type: "error",
      requestId: request.requestId,
      message: cause instanceof Error ? cause.message : "The fire model failed.",
      problems: cause instanceof InvalidIgnitionsError ? cause.problems : [],
    };
  }
  self.postMessage(response);
};
