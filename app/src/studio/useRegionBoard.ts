/**
 * Prebuilt region board for the Studio 3D view: the same station-scale California regions the
 * /fire page offers (docs/adr/0013-prebuilt-socal-landscapes.md), read from MongoDB GridFS via
 * `GET /api/landscapes/<id>`. When the store or API is unavailable it falls back to loading
 * the same box live from LANDFIRE, as /fire does. A run whose enabled fires all sit on the
 * board is solved on it (see `useStudioRun`).
 */

import { useEffect, useRef, useState } from "react";
import {
  RegionUnavailableError,
  fetchRegionCatalog,
  fetchRegionLandscape,
} from "../fire/landscapePackage";
import { loadLandscape, type LandscapeGrid, type MercatorBox } from "../fire/landscape";
import { CALIFORNIA_REGIONS, type LandscapeRegion } from "../fire/regions";
import { cellAt } from "../fire/spread";
import type { StudioScenario } from "./contracts";

/** Contains the demo scenario's three fires, so "Load demo" lands on the board. */
export const STUDIO_DEFAULT_REGION_ID = "berkeley-hills-tilden";
const REGION_STORAGE_KEY = "crisistwin.studio.region";

export type RegionCatalogState =
  { status: "loading" } | { status: "ready"; ids: ReadonlySet<string> } | { status: "error" };

export type RegionBoardState =
  | { status: "loading"; storedUnavailable: boolean }
  | { status: "ready"; grid: LandscapeGrid; source: "stored" | "live" }
  | { status: "error"; message: string };

export function findRegion(id: string): LandscapeRegion | null {
  return CALIFORNIA_REGIONS.find((region) => region.id === id) ?? null;
}

export function loadRegionId(): string {
  try {
    const stored = window.localStorage.getItem(REGION_STORAGE_KEY);
    if (stored && findRegion(stored)) return stored;
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return STUDIO_DEFAULT_REGION_ID;
}

export function saveRegionId(id: string): void {
  try {
    window.localStorage.setItem(REGION_STORAGE_KEY, id);
  } catch {
    // The choice then lasts for this visit only.
  }
}

/** Mercator box covered by a grid's cells (cell centres are offset half a cell inward). */
export function gridBox(grid: LandscapeGrid): MercatorBox {
  const x0 = grid.originX - grid.cellSizeX / 2;
  const y0 = grid.originY - grid.cellSizeY / 2;
  const x1 = x0 + grid.cellSizeX * grid.width;
  const y1 = y0 + grid.cellSizeY * grid.height;
  return {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  };
}

/** True when every enabled ignition lies on the grid (and at least one is enabled). */
export function gridCoversScenario(grid: LandscapeGrid, scenario: StudioScenario): boolean {
  const enabled = scenario.ignitions.filter((ignition) => ignition.enabled);
  return enabled.length > 0 && enabled.every((ignition) => cellAt(grid, ignition.location) >= 0);
}

export function useRegionBoard(regionId: string, attempt: number) {
  const [catalog, setCatalog] = useState<RegionCatalogState>({ status: "loading" });
  const [board, setBoard] = useState<RegionBoardState>({
    status: "loading",
    storedUnavailable: false,
  });
  const requestRef = useRef(0);

  // Which regions are stored is advisory: a load still tries the store directly.
  useEffect(() => {
    const controller = new AbortController();
    fetchRegionCatalog(controller.signal)
      .then((regions) => setCatalog({ status: "ready", ids: new Set(regions.map((r) => r.id)) }))
      .catch(() => {
        if (!controller.signal.aborted) setCatalog({ status: "error" });
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    // Ids come from `loadRegionId` or the picker, so they are always known regions.
    const region = findRegion(regionId);
    if (!region) return;
    const request = ++requestRef.current;
    const controller = new AbortController();
    const stale = () => controller.signal.aborted || request !== requestRef.current;
    setBoard({ status: "loading", storedUnavailable: false });

    fetchRegionLandscape(region.id, controller.signal)
      .then(
        ({ grid }) => {
          if (!stale()) setBoard({ status: "ready", grid, source: "stored" });
        },
        (cause: unknown) => {
          if (stale()) return;
          // A missing store or a dead API is expected; a corrupt package is not.
          if (!(cause instanceof RegionUnavailableError) && !(cause instanceof TypeError)) {
            throw cause;
          }
          setBoard({ status: "loading", storedUnavailable: true });
          return loadLandscape(
            region.center.longitude,
            region.center.latitude,
            region.radiusMeters,
            controller.signal,
            { cellMeters: region.cellMeters },
          ).then((grid) => {
            if (!stale()) setBoard({ status: "ready", grid, source: "live" });
          });
        },
      )
      .catch((cause: unknown) => {
        if (stale()) return;
        setBoard({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not load the region board.",
        });
      });
    return () => controller.abort();
  }, [regionId, attempt]);

  return { catalog, board };
}
