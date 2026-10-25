/**
 * Prebuilt region board for the Studio 3D view: the same 13 station-scale regions (Bay Area plus two Los Angeles boards) the
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
import { type LandscapeGrid, type MercatorBox } from "../fire/landscape";
import { loadLandscapeCached } from "../fire/landscapeCache";
import { CALIFORNIA_REGIONS, type LandscapeRegion } from "../fire/regions";
import { boardCellMetersFor } from "../fire/boardSize";
import { cellAt } from "../fire/spread";
import type { StudioScenario } from "./contracts";

/** Contains the demo scenario's three fires, so "Load demo" lands on the board. */
export const STUDIO_DEFAULT_REGION_ID = "berkeley-hills-tilden";
const REGION_STORAGE_KEY = "crisistwin.studio.region";

/**
 * Studio board half-widths on offer (ground metres); null is the region's own board. The choice
 * lives in the shared world (`region.radiusMeters`, docs/shared-world.md), so every tab follows it.
 */
export const STUDIO_BOARD_SIZES: readonly { radiusMeters: number | null; label: string }[] = [
  { radiusMeters: null, label: "Region default (~7 km)" },
  ...[10, 15, 20, 30, 45, 60].map((km) => ({
    radiusMeters: km * 1000,
    label: `About ${km * 2} \u00d7 ${km * 2} km`,
  })),
];
/** A world radius at or above this is a chosen size; below it the region's own board is used. */
export const STUDIO_CUSTOM_RADIUS_METERS = 10_000;

export function studioRadiusOverride(worldRadiusMeters: number): number | null {
  return worldRadiusMeters >= STUDIO_CUSTOM_RADIUS_METERS ? worldRadiusMeters : null;
}

/**
 * Identity of a Studio board: the region id alone for the region's own board, else
 * "<region id>@<N>km" for a chosen half-width (`radiusMeters`, N = km). Runs, drill packages
 * (`summary.region_id`), `GET /api/live/active` `region_id` and published Studio fires carry it,
 * so Live command can load the same landscape (`parseStudioBoardId`).
 */
export function studioBoardId(regionId: string, radiusMeters: number | null): string {
  return radiusMeters === null ? regionId : `${regionId}@${radiusMeters / 1000}km`;
}

/**
 * A Studio board id back to its region and chosen half-width (ground metres; null = the
 * region's own board), or null when the id names no known region.
 */
export function parseStudioBoardId(boardId: string): { region: LandscapeRegion; radiusMeters: number | null } | null {
  const match = /^([a-z0-9-]+)(?:@(\d+(?:\.\d+)?)km)?$/.exec(boardId);
  const region = match ? findRegion(match[1]) : null;
  if (!match || !region) return null;
  const km = match[2] === undefined ? null : Number(match[2]);
  return { region, radiusMeters: km !== null && km > 0 ? km * 1000 : null };
}

export type RegionCatalogState =
  { status: "loading" } | { status: "ready"; ids: ReadonlySet<string> } | { status: "error" };

export type RegionBoardState =
  | { status: "loading"; storedUnavailable: boolean }
  | { status: "ready"; grid: LandscapeGrid; source: "stored" | "cached" | "live" }
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

export function useRegionBoard(regionId: string, attempt: number, radiusMeters: number | null = null) {
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

    // A chosen size always loads live around the region centre (cached server-side after the first time).
    const custom = radiusMeters !== null
      ? loadLandscapeCached(
          region.center.longitude,
          region.center.latitude,
          radiusMeters,
          controller.signal,
          { cellMeters: boardCellMetersFor(radiusMeters) },
        ).then(({ grid, source }) => {
          if (!stale()) setBoard({ status: "ready", grid, source: source === "cache" ? "cached" : "live" });
        })
      : null;
    (custom ?? fetchRegionLandscape(region.id, controller.signal)
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
          return loadLandscapeCached(
            region.center.longitude,
            region.center.latitude,
            region.radiusMeters,
            controller.signal,
            { cellMeters: region.cellMeters },
          ).then(({ grid, source }) => {
            if (!stale()) setBoard({ status: "ready", grid, source: source === "cache" ? "cached" : "live" });
          });
        },
      ))
      .catch((cause: unknown) => {
        if (stale()) return;
        setBoard({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not load the region board.",
        });
      });
    return () => controller.abort();
  }, [regionId, attempt, radiusMeters]);

  return { catalog, board };
}
