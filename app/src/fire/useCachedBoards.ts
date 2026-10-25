/**
 * Which board requests are already cached in MongoDB (`GET /api/landscapes/cache/status`), so
 * size pickers can say "Ready" or "First load ~N s" without downloading any board. Unknown
 * (still loading, or the API is down) reads as not cached. `refreshKey` re-checks, e.g. after a
 * board finishes loading.
 */

import { useEffect, useState } from "react";
import { LANDSCAPE_CACHE_URL, landscapeCacheKey } from "./landscapeCache";

export interface BoardRequest {
  longitude: number;
  latitude: number;
  radiusMeters: number;
  /** The cell size the page passes to the loader. */
  cellMeters: number;
}

/** The key `loadLandscapeCached` uses for this request (centre rounded to 0.001 degrees). */
export function boardCacheKey(board: BoardRequest): string {
  return landscapeCacheKey(
    Math.round(board.longitude * 1000) / 1000,
    Math.round(board.latitude * 1000) / 1000,
    board.radiusMeters,
    Math.max(board.cellMeters, 30),
  );
}

/** Rough seconds a first (uncached) load takes, from the grid size (measured: 6.5 km 14 s, 60 km 57 s). */
export function firstLoadSeconds(radiusMeters: number, cellMeters: number): number {
  const side = (2 * radiusMeters) / Math.max(cellMeters, 30);
  return Math.max(10, Math.round((5 + (side * side) / 14_000) / 5) * 5);
}

/** "Ready" when cached, else "First load ~N s". */
export function readinessLabel(ready: boolean, radiusMeters: number, cellMeters: number): string {
  return ready ? "Ready" : `First load ~${firstLoadSeconds(radiusMeters, cellMeters)} s`;
}

async function fetchCachedKeys(keys: string[], signal: AbortSignal): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const response = await fetch(`${LANDSCAPE_CACHE_URL}/status?keys=${chunk.map(encodeURIComponent).join(",")}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { cached?: Record<string, unknown> };
    for (const key of Object.keys(body.cached ?? {})) found.add(key);
  }
  return found;
}

export function useCachedBoards(
  boards: readonly BoardRequest[],
  refreshKey: unknown = 0,
): (board: BoardRequest) => boolean {
  const joined = boards.map(boardCacheKey).join(",");
  const [cached, setCached] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!joined) return;
    const controller = new AbortController();
    fetchCachedKeys(joined.split(","), controller.signal)
      .then(setCached)
      .catch(() => undefined);
    return () => controller.abort();
  }, [joined, refreshKey]);
  return (board) => cached.has(boardCacheKey(board));
}
