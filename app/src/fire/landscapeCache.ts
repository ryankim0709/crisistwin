/**
 * Cached live landscape loads. `loadLandscape` and `loadLandscapeForBox` read LANDFIRE and
 * terrain from the network and can take minutes for a large board; these wrappers look the
 * finished grid up in MongoDB first (`GET /api/landscapes/cache?key=`) and, after a live
 * load, write it back (`POST /api/landscapes/cache?key=`, fire and forget) so the next load
 * of the same area, radius and cell size is instant. Callers use these, not the raw loaders.
 *
 * The key is made from the centre rounded to 0.001 degrees (about 100 m) and the radius and
 * cell size, or from a box snapped outward to a 150 m grid. The loader is given the rounded
 * values too, so a cached grid is exactly what a live load of that key produces.
 *
 * A cached grid is labelled: `source` is "cache" and `cachedAt` says when it was stored, and
 * the grid's attribution strings say it is a cached copy (observed data, not re-read).
 * Only grids with complete terrain and canopy are stored. Storage is best effort: any
 * failure falls back to a live load or skips the write.
 */

import {
  LANDFIRE_CANOPY_COVERAGES,
  LANDFIRE_COVERAGE,
  LANDFIRE_UPSTREAM_WCS_URL,
  TERRAIN_UPSTREAM_TILE_URL,
  loadLandscape,
  loadLandscapeForBox,
  type LandscapeGrid,
  type LandscapeLoadOptions,
  type MercatorBox,
} from "./landscape";
import { decodeLandscapePackage, encodeLandscapePackage } from "./landscapePackage";

export const LANDSCAPE_CACHE_URL = "/api/landscapes/cache";
/** Bump when the loader's output changes for the same inputs. */
const CACHE_VERSION = "ls1";
const CENTER_DEGREES_PER_STEP = 1000;
const BOX_SNAP_METERS = 150;
/** The server rejects more; do not upload what it will refuse. */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export interface CachedLandscapeResult {
  grid: LandscapeGrid;
  /** "cache": read from the MongoDB copy. "live": just loaded from LANDFIRE and terrain. */
  source: "cache" | "live";
  /** UTC ISO time the cached copy was stored; only when `source` is "cache". */
  cachedAt?: string;
}

function signedInt(value: number): string {
  const rounded = Math.round(value);
  return rounded < 0 ? `n${-rounded}` : `${rounded}`;
}

/** Cache key for a centre/radius board. Centre and radius are what the loader will use. */
export function landscapeCacheKey(
  longitude: number,
  latitude: number,
  radiusMeters: number,
  cellMeters: number,
): string {
  return [
    CACHE_VERSION,
    "c",
    signedInt(longitude * CENTER_DEGREES_PER_STEP),
    signedInt(latitude * CENTER_DEGREES_PER_STEP),
    `r${Math.round(radiusMeters)}`,
    `m${Math.round(cellMeters)}`,
  ].join("-");
}

function boxCacheKey(box: MercatorBox): string {
  return [
    CACHE_VERSION,
    "b",
    signedInt(box.minX / BOX_SNAP_METERS),
    signedInt(box.minY / BOX_SNAP_METERS),
    signedInt(box.maxX / BOX_SNAP_METERS),
    signedInt(box.maxY / BOX_SNAP_METERS),
  ].join("-");
}

function usesDefaultEndpoints(options: Pick<LandscapeLoadOptions, "endpoints">): boolean {
  const endpoints = options.endpoints;
  return !endpoints || (!endpoints.fetch && !endpoints.landfireWcsUrl && !endpoints.terrainTileUrl);
}

function labelCached(grid: LandscapeGrid, storedAt: string): LandscapeGrid {
  const note = ` (cached copy stored ${storedAt.slice(0, 10)})`;
  return {
    ...grid,
    attribution: {
      fuel: grid.attribution.fuel + note,
      terrain: grid.attribution.terrain + note,
      canopy: grid.attribution.canopy + note,
    },
  };
}

async function readCached(
  key: string,
  signal: AbortSignal,
  accept: (grid: LandscapeGrid) => boolean,
): Promise<{ grid: LandscapeGrid; cachedAt: string } | null> {
  try {
    const response = await fetch(`${LANDSCAPE_CACHE_URL}?key=${encodeURIComponent(key)}`, {
      signal,
    });
    if (!response.ok) return null;
    const { grid, header } = await decodeLandscapePackage(await response.arrayBuffer());
    if (!accept(grid)) return null;
    return { grid: labelCached(grid, header.builtAt), cachedAt: header.builtAt };
  } catch (cause) {
    if (signal.aborted) throw cause;
    return null;
  }
}

/** Fire and forget; never rejects, never tied to the caller's signal. */
function writeBack(key: string, grid: LandscapeGrid): void {
  if (!grid.elevationComplete || !grid.canopyComplete) return;
  const now = new Date().toISOString();
  encodeLandscapePackage(grid, {
    regionId: key,
    builtAt: now,
    cellMeters: grid.cellMeters,
    resampling: grid.resampling,
    sources: {
      landfireWcs: LANDFIRE_UPSTREAM_WCS_URL,
      coverages: [LANDFIRE_COVERAGE, ...Object.values(LANDFIRE_CANOPY_COVERAGES)],
      terrainTiles: TERRAIN_UPSTREAM_TILE_URL,
      retrievedAt: now,
    },
  })
    .then((bytes) => {
      if (bytes.length > MAX_UPLOAD_BYTES) return undefined;
      return fetch(`${LANDSCAPE_CACHE_URL}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: bytes as BodyInit,
      });
    })
    .catch(() => undefined);
}

/**
 * `loadLandscape` with a MongoDB read-through and write-back. Same arguments; the centre is
 * rounded to 0.001 degrees first. With custom `endpoints` (a Node caller) it loads live and
 * never touches the cache.
 */
export async function loadLandscapeCached(
  longitude: number,
  latitude: number,
  groundRadiusMeters: number,
  signal: AbortSignal,
  options: LandscapeLoadOptions = {},
): Promise<CachedLandscapeResult> {
  if (!usesDefaultEndpoints(options)) {
    return { grid: await loadLandscape(longitude, latitude, groundRadiusMeters, signal, options), source: "live" };
  }
  const lon = Math.round(longitude * CENTER_DEGREES_PER_STEP) / CENTER_DEGREES_PER_STEP;
  const lat = Math.round(latitude * CENTER_DEGREES_PER_STEP) / CENTER_DEGREES_PER_STEP;
  const cell = options.cellMeters ?? 30;
  const key = landscapeCacheKey(lon, lat, groundRadiusMeters, Math.max(cell, 30));
  const hit = await readCached(key, signal, (grid) => grid.cellMeters === Math.max(cell, 30));
  if (hit) return { grid: hit.grid, source: "cache", cachedAt: hit.cachedAt };
  const grid = await loadLandscape(lon, lat, groundRadiusMeters, signal, options);
  writeBack(key, grid);
  return { grid, source: "live" };
}

/**
 * `loadLandscapeForBox` with a MongoDB read-through and write-back. The box is snapped
 * outward to a 150 m grid first, so the grid may extend slightly past the requested box.
 */
export async function loadLandscapeForBoxCached(
  box: MercatorBox,
  signal: AbortSignal,
  options: Pick<LandscapeLoadOptions, "endpoints"> = {},
): Promise<CachedLandscapeResult> {
  if (!usesDefaultEndpoints(options)) {
    return { grid: await loadLandscapeForBox(box, signal, options), source: "live" };
  }
  const snap = (value: number, up: boolean) =>
    (up ? Math.ceil(value / BOX_SNAP_METERS) : Math.floor(value / BOX_SNAP_METERS)) *
    BOX_SNAP_METERS;
  const snapped: MercatorBox = {
    minX: snap(box.minX, false),
    minY: snap(box.minY, false),
    maxX: snap(box.maxX, true),
    maxY: snap(box.maxY, true),
  };
  const key = boxCacheKey(snapped);
  const hit = await readCached(key, signal, (grid) => grid.resampling === "native");
  if (hit) return { grid: hit.grid, source: "cache", cachedAt: hit.cachedAt };
  const grid = await loadLandscapeForBox(snapped, signal, options);
  writeBack(key, grid);
  return { grid, source: "live" };
}
