/**
 * Runs one scheduled-fire solve per message off the main thread. See contracts.ts.
 * Stochastic spread rides on `request.input.settings.stochastic` (fire/stochastic.ts; off when
 * absent), so the firefighting and initial-attack re-solves below use the same seed: every
 * tactic is compared on the same realisation of the fire.
 *
 * Order: the free run (with the solver's per-cell behaviour, so attack and drops are judged on
 * the flame at the time), then the ground initial attack per incident (studio/initialAttack.ts),
 * then the control-line plan with aircraft (studio/firefighting.ts), which releases each
 * incident's aircraft when the initial attack puts its fire out.
 */

import { simulateScheduledFireSpread } from "../fire/spread";
import { InvalidIgnitionsError } from "../fire/scheduledTypes";
import type { SolverRequest, SolverResponse } from "./contracts";
import { planFirefighting } from "./firefighting";
import { runInitialAttack } from "./initialAttack";

// The app compiles against the DOM lib, where `self` is a Window. Inside a dedicated worker
// it exposes the same onmessage/postMessage surface as a `Worker`, so type it as one rather
// than pulling the webworker lib into the whole program.
const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<SolverRequest>) => {
  const request = event.data;
  if (request.type !== "solve") return;
  let response: SolverResponse;
  try {
    const firefightingOn = request.firefighting?.enabled === true;
    // Per-cell behaviour always: firefighting judges attack and drops on it, and the diorama and
    // map classify flame bands and crown fire from it (fire/fireStates.ts). Same arrivals either way.
    const run = simulateScheduledFireSpread(request.landscape, request.input, null, null, {
      reportCellBehaviour: true,
    });
    const initialAttack =
      firefightingOn && request.firefighting
        ? runInitialAttack(request.landscape, request.input, run, request.firefighting, request.crewArrivals)
        : null;
    const firefighting =
      firefightingOn && request.firefighting
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
            request.crewArrivals,
            { bases: request.airBases },
            initialAttack?.estimate ?? null,
            request.incidents ?? null,
            initialAttack?.run ?? null,
          )
        : null;
    // The air-supported initial attack (planFirefighting) when drops hold on a fire, else the
    // ground-only one.
    if (firefighting && initialAttack) firefighting.initialAttack = firefighting.initialAttack ?? initialAttack;
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
