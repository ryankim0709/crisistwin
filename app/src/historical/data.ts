/** Fetch helpers for the static historical-fire files (see ./types.ts). */

import { useEffect, useState } from "react";
import type { HistoricalFire, HistoricalFireIndex, HistoricalFireSimulated } from "./types";

export const HISTORICAL_FIRES_BASE = "/historical-fires";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${HISTORICAL_FIRES_BASE}/${path}`, { signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function fetchHistoricalFireIndex(signal?: AbortSignal): Promise<HistoricalFireIndex> {
  return getJson<HistoricalFireIndex>("index.json", signal);
}

export function fetchHistoricalFire(id: string, signal?: AbortSignal): Promise<HistoricalFire> {
  return getJson<HistoricalFire>(`${encodeURIComponent(id)}.json`, signal);
}

export function fetchHistoricalFireSimulated(
  file: string,
  signal?: AbortSignal,
): Promise<HistoricalFireSimulated> {
  return getJson<HistoricalFireSimulated>(encodeURIComponent(file), signal);
}

export type HistoricalIndexState =
  | { status: "loading" }
  | { status: "ready"; index: HistoricalFireIndex }
  | { status: "error"; message: string };

/** The list of historical fires, loaded once per mount. */
export function useHistoricalFireIndex(): HistoricalIndexState {
  const [state, setState] = useState<HistoricalIndexState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetchHistoricalFireIndex(controller.signal)
      .then((index) => setState({ status: "ready", index }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : "Historical fires unavailable.",
        });
      });
    return () => controller.abort();
  }, []);
  return state;
}
