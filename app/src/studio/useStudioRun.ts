/**
 * Run lifecycle for Simulation Studio: frozen scenario snapshot -> shared landscape (cached
 * or downloaded) -> worker solve -> result. Every run has a request id; an obsolete download
 * is aborted, an obsolete solve is cancelled by terminating the worker, and any response whose
 * id is not the latest is dropped, so an older scenario can never replace a newer one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadLandscapeForBox, type LandscapeGrid, type MercatorBox } from "../fire/landscape";
import { boxContains, landscapeRequirement } from "./bounds";
import type {
  SolverRequest,
  SolverResponse,
  StudioRunResult,
  StudioRunState,
  StudioScenario,
} from "./contracts";
import type { IgnitionProblem } from "../fire/scheduledTypes";
import { toSolverInput, validateScenario } from "./scenario";

/** Landscapes kept for reuse; each is a few MB of typed arrays. */
const LANDSCAPE_CACHE_SIZE = 2;

interface CachedLandscape {
  key: string;
  box: MercatorBox;
  grid: LandscapeGrid;
}

const INITIAL_STATE: StudioRunState = {
  phase: "editing",
  requestId: 0,
  result: null,
  stale: false,
  error: null,
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export interface StudioRunController {
  state: StudioRunState;
  run: (scenario: StudioScenario) => void;
  cancel: () => void;
  markStale: () => void;
}

export function useStudioRun(): StudioRunController {
  const [state, setState] = useState<StudioRunState>(INITIAL_STATE);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const cacheRef = useRef<CachedLandscape[]>([]);

  const stopInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => stopInFlight, [stopInFlight]);

  const fail = useCallback((requestId: number, message: string, problems: IgnitionProblem[]) => {
    if (requestId !== requestIdRef.current) return;
    setState((previous) => ({
      phase: "failed",
      requestId,
      result: previous.result,
      stale: previous.result !== null,
      error: { message, problems },
    }));
  }, []);

  const solve = useCallback(
    (requestId: number, snapshot: StudioScenario, landscape: CachedLandscape) => {
      setState((previous) => ({ ...previous, phase: "computing", requestId, error: null }));
      if (workerRef.current === null) {
        const worker = new Worker(new URL("./solver.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<SolverResponse>) => {
          const response = event.data;
          if (response.requestId !== requestIdRef.current) return;
          if (response.type === "error") {
            fail(response.requestId, response.message, response.problems);
            return;
          }
          const result: StudioRunResult = {
            requestId: response.requestId,
            scenario: snapshot,
            run: response.run,
            frameMinutes: response.run.frames.map((frame) => frame.elapsedMinutes),
            landscapeKey: landscape.key,
            landscapeBox: landscape.box,
            attribution: landscape.grid.attribution,
            elevationComplete: landscape.grid.elevationComplete,
          };
          setState({
            phase: "ready",
            requestId: response.requestId,
            result,
            stale: false,
            error: null,
          });
        };
        worker.onerror = (event) => {
          fail(requestIdRef.current, event.message || "The fire model worker crashed.", []);
        };
        workerRef.current = worker;
      }
      const request: SolverRequest = {
        type: "solve",
        requestId,
        landscape: landscape.grid,
        input: toSolverInput(snapshot),
      };
      workerRef.current.postMessage(request);
    },
    [fail],
  );

  const run = useCallback(
    (scenario: StudioScenario) => {
      const requestId = ++requestIdRef.current;
      stopInFlight();
      const snapshot = deepFreeze(structuredClone(scenario));

      const issues = validateScenario(snapshot);
      if (issues.length > 0) {
        fail(requestId, issues.map((issue) => issue.message).join(" "), []);
        return;
      }

      const requirement = landscapeRequirement(snapshot);
      const cached = cacheRef.current.find((entry) => boxContains(entry.box, requirement.box));
      if (cached) {
        // Most recently used first.
        cacheRef.current = [cached, ...cacheRef.current.filter((entry) => entry !== cached)];
        solve(requestId, snapshot, cached);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setState((previous) => ({
        phase: "loading-landscape",
        requestId,
        result: previous.result,
        stale: previous.result !== null,
        error: null,
      }));
      loadLandscapeForBox(requirement.box, controller.signal)
        .then((grid) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          const entry: CachedLandscape = { key: requirement.key, box: requirement.box, grid };
          cacheRef.current = [entry, ...cacheRef.current].slice(0, LANDSCAPE_CACHE_SIZE);
          solve(requestId, snapshot, entry);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          fail(
            requestId,
            cause instanceof Error ? cause.message : "Could not load fuel and terrain data.",
            [],
          );
        });
    },
    [fail, solve, stopInFlight],
  );

  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    stopInFlight();
    setState((previous) =>
      previous.phase === "loading-landscape" || previous.phase === "computing"
        ? {
            phase: "canceled",
            requestId: requestIdRef.current,
            result: previous.result,
            stale: previous.result !== null,
            error: null,
          }
        : previous,
    );
  }, [stopInFlight]);

  const markStale = useCallback(() => {
    setState((previous) => {
      if (previous.phase === "loading-landscape" || previous.phase === "computing") {
        return previous;
      }
      if (previous.phase === "editing" && (previous.stale || previous.result === null)) {
        return previous;
      }
      return {
        ...previous,
        phase: "editing",
        stale: previous.result !== null,
        error: null,
      };
    });
  }, []);

  return { state, run, cancel, markStale };
}
