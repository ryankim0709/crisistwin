/**
 * Streets for a diorama board: the OSM road network and synthetic homes over the board's
 * extent, from the dispatch area endpoint (`GET /api/dispatch/area`, ADR 0017), which caches
 * each box in process and in MongoDB. The endpoint takes boxes up to 0.22 x 0.28 degrees, so a
 * board bigger than one box is covered by a grid of up to MAX_TILES_PER_SIDE squared boxes
 * around its centre (about 66 km across at mid latitudes); beyond that the outer ground has no
 * streets. `area` is the centre box alone, a coherent road graph for routing and evacuation;
 * `scenery` is the roads and homes of every box that loaded, for drawing only. Failures leave
 * the board on its stylized house lattice; a failed outer box is skipped.
 */

import { useEffect, useState } from "react";
import { AreaRequestError, loadArea, type Bbox, type DispatchArea } from "../dispatch/area";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";
import type { BoardStreets } from "./diorama/types";

/** Just under the endpoint's limits (0.22 x 0.28 degrees), leaving room for its outward snapping. */
const MAX_LAT_SPAN = 0.2;
const MAX_LON_SPAN = 0.26;
/** Boxes per side; 3 x 3 = 9 Overpass-backed requests at most, cached in MongoDB afterwards. */
export const MAX_TILES_PER_SIDE = 3;
const MAX_PARALLEL_TILES = 2;

export type BoardStreetsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; area: DispatchArea; scenery: BoardStreets }
  | { status: "empty" }
  | { status: "error"; message: string };

/** WGS84 extent of the grid's cells as [west, south, east, north]. */
function gridExtent(grid: LandscapeGrid): Bbox {
  const x0 = grid.originX - grid.cellSizeX / 2;
  const y0 = grid.originY - grid.cellSizeY / 2;
  const [lonA, latA] = mercatorToLonLat(x0, y0);
  const [lonB, latB] = mercatorToLonLat(
    x0 + grid.cellSizeX * grid.width,
    y0 + grid.cellSizeY * grid.height,
  );
  return [Math.min(lonA, lonB), Math.min(latA, latB), Math.max(lonA, lonB), Math.max(latA, latB)];
}

/** Boxes covering the grid, centre box first, clipped around the centre to the tile cap. */
export function streetsBoxesFor(grid: LandscapeGrid): Bbox[] {
  const [west, south, east, north] = gridExtent(grid);
  const axis = (lo: number, hi: number, max: number) => {
    const count = Math.min(MAX_TILES_PER_SIDE, Math.max(1, Math.ceil((hi - lo) / max)));
    const total = Math.min(hi - lo, count * max);
    const start = (lo + hi) / 2 - total / 2;
    return Array.from({ length: count }, (_, i): [number, number] => [
      start + (i * total) / count,
      start + ((i + 1) * total) / count,
    ]);
  };
  const columns = axis(west, east, MAX_LON_SPAN);
  const rows = axis(south, north, MAX_LAT_SPAN);
  const centre: [number, number] = [(west + east) / 2, (south + north) / 2];
  const boxes: Bbox[] = [];
  for (const [s, n] of rows) for (const [w, e] of columns) boxes.push([w, s, e, n]);
  const distance = (box: Bbox) =>
    Math.hypot((box[0] + box[2]) / 2 - centre[0], (box[1] + box[3]) / 2 - centre[1]);
  return boxes.sort((a, b) => distance(a) - distance(b));
}

/** WGS84 box of the grid's cells, clipped around its centre to one endpoint box. */
export function streetsBoxFor(grid: LandscapeGrid): Bbox {
  return streetsBoxesFor(grid)[0];
}

function isNoRoads(cause: unknown): boolean {
  return cause instanceof AreaRequestError && (cause.code === "no_roads" || cause.code === "no_exits");
}

async function loadBoardStreets(
  grid: LandscapeGrid,
  signal: AbortSignal,
): Promise<{ area: DispatchArea; scenery: BoardStreets } | "empty"> {
  const [centreBox, ...outerBoxes] = streetsBoxesFor(grid);
  // The centre box decides loading, empty and error; outer boxes are decoration.
  const centre = loadArea(centreBox, signal).catch((cause: unknown) => (isNoRoads(cause) ? null : Promise.reject(cause)));
  const outer: (DispatchArea | null)[] = new Array(outerBoxes.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_TILES, outerBoxes.length) }, async () => {
    for (let i = next++; i < outerBoxes.length; i = next++) {
      if (signal.aborted) return;
      outer[i] = await loadArea(outerBoxes[i], signal).catch(() => null);
    }
  });
  const [area] = await Promise.all([centre, ...workers]);
  const areas = [area, ...outer].filter((a): a is DispatchArea => a !== null);
  if (!area) return areas.length > 0 ? { area: areas[0], scenery: sceneryOf(areas) } : "empty";
  return { area, scenery: sceneryOf(areas) };
}

function sceneryOf(areas: DispatchArea[]): BoardStreets {
  if (areas.length === 1) return areas[0];
  return {
    edges: areas.flatMap((a) => a.edges),
    homes: areas.flatMap((a) => a.homes),
  };
}

export function useBoardStreets(grid: LandscapeGrid | null): BoardStreetsState {
  const [state, setState] = useState<{ grid: LandscapeGrid | null; value: BoardStreetsState }>({
    grid: null,
    value: { status: "idle" },
  });

  useEffect(() => {
    if (!grid) return;
    const controller = new AbortController();
    loadBoardStreets(grid, controller.signal)
      .then((result) =>
        setState({
          grid,
          value: result === "empty" ? { status: "empty" } : { status: "ready", ...result },
        }),
      )
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // Wilderness boards have no roads; that is not an error worth showing.
        if (isNoRoads(cause)) {
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
