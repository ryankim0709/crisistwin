/**
 * Run lifecycle for Simulation Studio: frozen scenario snapshot -> shared landscape (cached
 * or downloaded) -> worker solve -> result. Every run has a request id; an obsolete download
 * is aborted, an obsolete solve is cancelled by terminating the worker, and any response whose
 * id is not the latest is dropped, so an older scenario can never replace a newer one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type LandscapeGrid, type MercatorBox } from "../fire/landscape";
import { loadLandscapeForBoxCached } from "../fire/landscapeCache";
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
import { gridBox, gridCoversScenario } from "./useRegionBoard";
import { arrivalsOf, type CrewDispatch } from "./crewDispatch";
import type { AirBase } from "./aircraft";
import type { ApparatusCounts } from "./apparatus";

/** Resources sent from fire stations for a run, or why they were not. */
export interface RunDispatch {
  dispatch: CrewDispatch | null;
  note: string | null;
  /** Helitack and air attack bases for the aircraft model, or null without base data. */
  airBases?: AirBase[] | null;
  /**
   * Units sent, ground and air, derived from the facilities on the map (studio/mapResources.ts).
   * They replace any counts in the scenario: Studio has no hand-set unit counts.
   */
  resources?: ApparatusCounts;
}

/** A prebuilt region board offered for a run; `grid` is null while it is still loading. */
export interface RunBoard {
  id: string;
  grid: LandscapeGrid | null;
}

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
  progress: null,
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
  /** With a loaded `board` covering every enabled fire, the run is solved on that board. */
  run: (scenario: StudioScenario, board?: RunBoard, crews?: RunDispatch) => void;
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
      progress: null,
    }));
  }, []);

  const solve = useCallback(
    (
      requestId: number,
      snapshot: StudioScenario,
      landscape: CachedLandscape,
      boardId: string | null,
      crews: RunDispatch | null,
    ) => {
      setState((previous) => ({
        ...previous,
        phase: "computing",
        requestId,
        error: null,
        progress: null,
      }));
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
          if (response.type === "progress") {
            const { done, total } = response;
            setState((previous) => ({ ...previous, progress: { done, total } }));
            return;
          }
          const result: StudioRunResult = {
            requestId: response.requestId,
            scenario: snapshot,
            run: response.run,
            frameMinutes: response.run.frames.map((frame) => frame.elapsedMinutes),
            landscapeKey: landscape.key,
            landscapeBox: landscape.box,
            boardId,
            landscape: landscape.grid,
            attribution: landscape.grid.attribution,
            elevationComplete: landscape.grid.elevationComplete,
            firefighting: response.firefighting,
            crewDispatch: crews?.dispatch ?? null,
            crewDispatchNote: crews?.note ?? null,
          };
          setState({
            phase: "ready",
            requestId: response.requestId,
            result,
            stale: false,
            error: null,
            progress: null,
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
        // Units come from the map, not the scenario: drive in from their bases, no night-flying
        // helicopter the facilities layer cannot place.
        firefighting: snapshot.firefighting
          ? { ...snapshot.firefighting, fromStations: true, nightHelicopters: false, resources: crews?.resources ?? {} }
          : null,
        crewArrivals: crews?.dispatch ? arrivalsOf(crews.dispatch) : null,
        airBases: crews?.airBases ?? null,
      };
      workerRef.current.postMessage(request);
    },
    [fail],
  );

  const run = useCallback(
    (scenario: StudioScenario, board?: RunBoard, crews?: RunDispatch) => {
      const crewPlan = crews ?? null;
      const requestId = ++requestIdRef.current;
      stopInFlight();
      const snapshot = deepFreeze(structuredClone(scenario));

      const issues = validateScenario(snapshot);
      if (issues.length > 0) {
        fail(requestId, issues.map((issue) => issue.message).join(" "), []);
        return;
      }

      const boardId = board?.id ?? null;
      if (board?.grid && gridCoversScenario(board.grid, snapshot)) {
        const { grid } = board;
        solve(
          requestId,
          snapshot,
          { key: `region:${board.id}`, box: gridBox(grid), grid },
          boardId,
          crewPlan,
        );
        return;
      }

      const requirement = landscapeRequirement(snapshot);
      const cached = cacheRef.current.find((entry) => boxContains(entry.box, requirement.box));
      if (cached) {
        // Most recently used first.
        cacheRef.current = [cached, ...cacheRef.current.filter((entry) => entry !== cached)];
        solve(requestId, snapshot, cached, boardId, crewPlan);
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
        progress: null,
      }));
      loadLandscapeForBoxCached(requirement.box, controller.signal)
        .then(({ grid }) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          const entry: CachedLandscape = { key: requirement.key, box: requirement.box, grid };
          cacheRef.current = [entry, ...cacheRef.current].slice(0, LANDSCAPE_CACHE_SIZE);
          solve(requestId, snapshot, entry, boardId, crewPlan);
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
            progress: null,
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
