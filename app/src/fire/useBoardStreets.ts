/**
 * Streets for a diorama board: the OSM road network and synthetic homes over the board's
 * extent, from the dispatch area endpoint (`GET /api/dispatch/area`, ADR 0017), which caches
 * each box in process and in MongoDB. Boards larger than the endpoint allows get the centre
 * box only. Failures leave the board on its stylized house lattice.
 */

import { useEffect, useState } from "react";
import { AreaRequestError, loadArea, type Bbox, type DispatchArea } from "../dispatch/area";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";

/** Just under the endpoint's limits (0.22° × 0.28°), leaving room for its outward snapping. */
const MAX_LAT_SPAN = 0.2;
const MAX_LON_SPAN = 0.26;

export type BoardStreetsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; area: DispatchArea }
  | { status: "empty" }
  | { status: "error"; message: string };

/** WGS84 box of the grid's cells, clipped around its centre to the endpoint's limits. */
export function streetsBoxFor(grid: LandscapeGrid): Bbox {
  const x0 = grid.originX - grid.cellSizeX / 2;
  const y0 = grid.originY - grid.cellSizeY / 2;
  const [lonA, latA] = mercatorToLonLat(x0, y0);
  const [lonB, latB] = mercatorToLonLat(
    x0 + grid.cellSizeX * grid.width,
    y0 + grid.cellSizeY * grid.height,
  );
  const clip = (a: number, b: number, max: number): [number, number] => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo <= max) return [lo, hi];
    const mid = (lo + hi) / 2;
    return [mid - max / 2, mid + max / 2];
  };
  const [west, east] = clip(lonA, lonB, MAX_LON_SPAN);
  const [south, north] = clip(latA, latB, MAX_LAT_SPAN);
  return [west, south, east, north];
}

export function useBoardStreets(grid: LandscapeGrid | null): BoardStreetsState {
  const [state, setState] = useState<{ grid: LandscapeGrid | null; value: BoardStreetsState }>({
    grid: null,
    value: { status: "idle" },
  });

  useEffect(() => {
    if (!grid) return;
    const controller = new AbortController();
    loadArea(streetsBoxFor(grid), controller.signal)
      .then((area) => setState({ grid, value: { status: "ready", area } }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // Wilderness boards have no roads; that is not an error worth showing.
        if (
          cause instanceof AreaRequestError &&
          (cause.code === "no_roads" || cause.code === "no_exits")
        ) {
          setState({ grid, value: { status: "empty" } });
          return;
        }
        console.warn("Board streets unavailable", cause);
        const message =
          cause instanceof Error ? cause.message : "The road network could not be loaded.";
        setState({ grid, value: { status: "error", message } });
      });
    return () => controller.abort();
  }, [grid]);

  // Loading until this board's result lands; a previous board's result never applies.
  return grid && state.grid === grid ? state.value : { status: grid ? "loading" : "idle" };
}
