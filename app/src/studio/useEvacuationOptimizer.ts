/**
 * Re-optimises the evacuation whenever its inputs change (closed roads, order minute, run,
 * crews). The optimiser is synchronous, so a stale search is cancelled by terminating its
 * worker; a fresh worker starts once the inputs have been still for DEBOUNCE_MS. Every request
 * has an id and any response that is not the latest is dropped. Results are stored together
 * with the inputs they were computed for, so a result can never be shown for other inputs.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { OptimizerRequest, OptimizerResponse } from "./contracts";
import type { EvacuationInputs } from "./evacuation";
import type { EvacuationOptimization } from "./evacuationOptimizer";

/** Quiet time after the last input change before a search starts. */
export const OPTIMIZER_DEBOUNCE_MS = 250;

export interface EvacuationOptimizerState {
  status: "idle" | "running" | "ready" | "error";
  progress?: { done: number; total: number };
  result?: EvacuationOptimization;
  error?: string;
}

type Settled =
  | { inputs: EvacuationInputs; kind: "progress"; done: number; total: number }
  | { inputs: EvacuationInputs; kind: "result"; result: EvacuationOptimization }
  | { inputs: EvacuationInputs; kind: "error"; message: string };

const IDLE: EvacuationOptimizerState = { status: "idle" };

export function useEvacuationOptimizer(
  inputs: EvacuationInputs | null,
  enabled: boolean,
): EvacuationOptimizerState {
  const [latest, setLatest] = useState<Settled | null>(null);
  const requestIdRef = useRef(0);
  const active = enabled ? inputs : null;

  useEffect(() => {
    if (!active) return;
    const requestId = ++requestIdRef.current;
    let worker: Worker | null = null;
    const timer = setTimeout(() => {
      worker = new Worker(new URL("./evacuationOptimizer.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<OptimizerResponse>) => {
        const response = event.data;
        if (response.requestId !== requestIdRef.current) return;
        if (response.type === "progress") {
          setLatest({
            inputs: active,
            kind: "progress",
            done: response.done,
            total: response.total,
          });
        } else if (response.type === "error") {
          setLatest({ inputs: active, kind: "error", message: response.message });
        } else {
          setLatest({ inputs: active, kind: "result", result: response.result });
        }
      };
      worker.onerror = (event) => {
        if (requestId !== requestIdRef.current) return;
        setLatest({
          inputs: active,
          kind: "error",
          message: event.message || "The evacuation optimiser worker crashed.",
        });
      };
      const request: OptimizerRequest = { type: "optimize", requestId, inputs: active };
      worker.postMessage(request);
    }, OPTIMIZER_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // Invalidate in-flight responses and stop the search.
      requestIdRef.current += 1;
      worker?.terminate();
    };
  }, [active]);

  return useMemo<EvacuationOptimizerState>(() => {
    if (!active) return IDLE;
    // A stored message for other inputs is stale: a new search is pending or running.
    if (!latest || latest.inputs !== active) return { status: "running" };
    if (latest.kind === "result") return { status: "ready", result: latest.result };
    if (latest.kind === "error") return { status: "error", error: latest.message };
    return { status: "running", progress: { done: latest.done, total: latest.total } };
  }, [active, latest]);
}
