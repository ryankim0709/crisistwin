/**
 * Loads one historical fire for the 3D diorama: the fire file, the LANDFIRE landscape around its
 * board, the observed arrival raster interpolated from the FEDS perimeters, and (on request) the
 * replay bundle's simulated arrival raster on the same grid. Shared by the /fire historical view
 * and the /replay 3D view, so both draw the same landscape from one cache.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { type LandscapeGrid } from "../fire/landscape";
import { loadLandscapeCached } from "../fire/landscapeCache";
import { arrivalFromPerimeters } from "./arrivalFromPerimeters";
import { fetchHistoricalFire, fetchHistoricalFireSimulated } from "./data";
import { simulatedArrivalOnGrid } from "./simulatedArrival";
import type { HistoricalFire, HistoricalFireSimulated } from "./types";

export type Load<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

export type FireLayer = "observed" | "simulated";

/** Landscapes already loaded this session, by fire id (they take a while to fetch). */
const landscapeCache = new Map<string, LandscapeGrid>();
/** Simulated-run files by name, fetched once. */
const simulatedCache = new Map<string, Promise<HistoricalFireSimulated>>();

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export type HistoricalFireData = {
  fire: Load<HistoricalFire>;
  landscape: Load<LandscapeGrid>;
  /** Null until the simulated layer is asked for. */
  simulated: Load<HistoricalFireSimulated> | null;
  /** Observed arrival minutes since the fire's t0, interpolated between perimeter snapshots. */
  observed: ReturnType<typeof arrivalFromPerimeters> | null;
  simulatedArrival: { arrival: Float32Array; lastMinute: number } | null;
  retry: () => void;
};

export function useHistoricalFireData(fireId: string, layer: FireLayer): HistoricalFireData {
  const [fire, setFire] = useState<Load<HistoricalFire>>({ status: "loading" });
  const [landscape, setLandscape] = useState<Load<LandscapeGrid>>({ status: "loading" });
  const [simulated, setSimulated] = useState<Load<HistoricalFireSimulated> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((v) => v + 1), []);

  // Fire file, then the landscape for its board.
  useEffect(() => {
    const controller = new AbortController();
    setFire({ status: "loading" });
    setLandscape({ status: "loading" });
    setSimulated(null);
    fetchHistoricalFire(fireId, controller.signal)
      .then(async (value) => {
        setFire({ status: "ready", value });
        const cached = landscapeCache.get(value.id);
        if (cached) {
          setLandscape({ status: "ready", value: cached });
          return;
        }
        const { center, radius_m, cell_m } = value.board;
        const { grid } = await loadLandscapeCached(center[0], center[1], radius_m, controller.signal, {
          cellMeters: cell_m,
        });
        landscapeCache.set(value.id, grid);
        if (!controller.signal.aborted) setLandscape({ status: "ready", value: grid });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const text = errorMessage(cause, "The fire could not be loaded.");
        setFire((current) =>
          current.status === "ready" ? current : { status: "error", message: text },
        );
        setLandscape({ status: "error", message: text });
      });
    return () => controller.abort();
  }, [fireId, attempt]);

  // Simulated layer: fetched only when asked for.
  const simulatedFile = fire.status === "ready" ? fire.value.simulated_file : null;
  useEffect(() => {
    if (layer !== "simulated" || !simulatedFile) return;
    let live = true;
    let request = simulatedCache.get(simulatedFile);
    if (!request) {
      request = fetchHistoricalFireSimulated(simulatedFile);
      simulatedCache.set(simulatedFile, request);
      request.catch(() => simulatedCache.delete(simulatedFile));
    }
    setSimulated({ status: "loading" });
    request.then(
      (value) => live && setSimulated({ status: "ready", value }),
      (cause: unknown) =>
        live &&
        setSimulated({
          status: "error",
          message: errorMessage(cause, "Simulated run unavailable."),
        }),
    );
    return () => {
      live = false;
    };
  }, [layer, simulatedFile]);

  const grid = landscape.status === "ready" ? landscape.value : null;
  const fireData = fire.status === "ready" ? fire.value : null;

  const observed = useMemo(() => {
    if (!grid || !fireData) return null;
    return arrivalFromPerimeters(
      grid,
      fireData.perimeters.snapshots.map((s) => ({ minute: s.minute, geometry: s.geometry })),
      fireData.ignitions.map((ig) => ({
        longitude: ig.coord[0],
        latitude: ig.coord[1],
        minute: ig.minute,
      })),
    );
  }, [grid, fireData]);

  const simulatedArrival = useMemo(() => {
    if (!grid || simulated?.status !== "ready") return null;
    const arrival = simulatedArrivalOnGrid(grid, simulated.value.arrival_grid);
    let last = 0;
    for (const value of arrival) if (Number.isFinite(value) && value > last) last = value;
    return { arrival, lastMinute: last };
  }, [grid, simulated]);

  return { fire, landscape, simulated, observed, simulatedArrival, retry };
}
