import { useCallback, useEffect, useRef, useState } from "react";
import type { BurnProbabilityOptions, BurnProbabilityRaster } from "./ensemble";
import type { LandscapeGrid } from "./landscape";
import type { ScheduledFireInput } from "./scheduledTypes";
import type { BurnProbabilityRequest, BurnProbabilityResponse } from "./burnProbability.worker";

export type BurnProbabilityState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "ready"; raster: BurnProbabilityRaster; key: string }
  | { status: "error"; message: string };

/**
 * Runs `burnProbabilityEnsemble` in a worker so the page stays responsive. `key` identifies the
 * scenario the result belongs to; the page hides a result whose key no longer matches.
 */
export function useBurnProbability() {
  const [state, setState] = useState<BurnProbabilityState>({ status: "idle" });
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);

  const stop = useCallback(() => {
    requestRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const run = useCallback(
    (
      landscape: LandscapeGrid,
      input: ScheduledFireInput,
      options: Omit<BurnProbabilityOptions, "onProgress">,
      key: string,
    ) => {
      stop();
      const requestId = requestRef.current;
      setState({ status: "running", done: 0, total: options.members });
      try {
        const worker = new Worker(new URL("./burnProbability.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<BurnProbabilityResponse>) => {
          const message = event.data;
          if (message.requestId !== requestRef.current) return;
          if (message.type === "progress") {
            setState({ status: "running", done: message.done, total: message.total });
          } else {
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            setState(
              message.type === "result"
                ? { status: "ready", raster: message.raster, key }
                : { status: "error", message: message.message },
            );
          }
        };
        worker.onerror = (event) => {
          if (requestId !== requestRef.current) return;
          setState({ status: "error", message: event.message || "The burn probability worker crashed." });
        };
        worker.postMessage({
          type: "run",
          requestId,
          landscape,
          input,
          options,
        } satisfies BurnProbabilityRequest);
      } catch (cause) {
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not start the burn probability run.",
        });
      }
    },
    [stop],
  );

  const cancel = useCallback(() => {
    stop();
    setState({ status: "idle" });
  }, [stop]);

  return { state, run, cancel };
}
