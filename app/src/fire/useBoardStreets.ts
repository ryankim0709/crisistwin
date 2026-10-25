/**
 * Streets for a diorama board: the OSM road network and synthetic homes over the board's
 * extent, from the dispatch area endpoint (`GET /api/dispatch/area`, ADR 0017), which caches
 * each box in process and in MongoDB. The endpoint takes boxes up to 0.22 x 0.28 degrees, so a
 * board bigger than one box is drawn from a grid of up to MAX_TILES_PER_SIDE squared tiles
 * around its centre (about 66 km across at mid latitudes); beyond that the outer ground has no
 * streets.
 *
 * `scenery` is the roads and homes of every tile that loaded, for drawing only. `area` is one
 * coherent road graph for routing, evacuation and unit staging: the box of a fixed per-board
 * lattice (`areaBoxesFor`) that best covers the `focus` points (the enabled fires), else the
 * board's centre box. Boxes are fixed per board, so every scenario on a board reuses the same
 * few cached areas (and `tools/prewarm_landscapes` can warm them all). Only one area is
 * routable: adjacent boxes share no road nodes (the backend cuts ways at the box edge), so fires
 * outside the chosen box are not covered and the page must say so (studio/areaCoverage.ts).
 *
 * Failures leave the board on its stylized house lattice; a failed tile is skipped.
 */

import { useEffect, useMemo, useState } from "react";
import { AreaRequestError, loadArea, type Bbox, type DispatchArea, type LonLat } from "../dispatch/area";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";
import type { BoardStreets } from "./diorama/types";

/** Just under the endpoint's limits (0.22 x 0.28 degrees), leaving room for its outward snapping. */
const MAX_LAT_SPAN = 0.2;
const MAX_LON_SPAN = 0.26;
/** Boxes per side; 3 x 3 = 9 Overpass-backed requests at most, cached in MongoDB afterwards. */
export const MAX_TILES_PER_SIDE = 3;
const MAX_PARALLEL_TILES = 2;
/** Parsed areas kept in this tab (one area can be tens of MB parsed). */
const AREA_CACHE_SIZE = 6;

export type BoardStreetsState =
  | { status: "idle" }
  | { status: "loading"; scenery?: BoardStreets }
  | { status: "ready"; area: DispatchArea; scenery: BoardStreets }
  | { status: "empty"; scenery?: BoardStreets }
  | { status: "error"; message: string; scenery?: BoardStreets };

/** The drawn roads and homes in any state that has them. */
export function sceneryOf(state: BoardStreetsState): BoardStreets | null {
  return "scenery" in state ? (state.scenery ?? null) : null;
}

/** WGS84 extent of the grid's cells as [west, south, east, north]. */
export function gridExtent(grid: LandscapeGrid): Bbox {
  const x0 = grid.originX - grid.cellSizeX / 2;
  const y0 = grid.originY - grid.cellSizeY / 2;
  const [lonA, latA] = mercatorToLonLat(x0, y0);
  const [lonB, latB] = mercatorToLonLat(
    x0 + grid.cellSizeX * grid.width,
    y0 + grid.cellSizeY * grid.height,
  );
  return [Math.min(lonA, lonB), Math.min(latA, latB), Math.max(lonA, lonB), Math.max(latA, latB)];
}

/** The tiled span of one axis: tile count and the covered [start, start + total]. */
function axisSpan(lo: number, hi: number, max: number) {
  const count = Math.min(MAX_TILES_PER_SIDE, Math.max(1, Math.ceil((hi - lo) / max)));
  const total = Math.min(hi - lo, count * max);
  return { count, start: (lo + hi) / 2 - total / 2, total, max };
}

function axes(grid: LandscapeGrid) {
  const [west, south, east, north] = gridExtent(grid);
  return {
    lon: axisSpan(west, east, MAX_LON_SPAN),
    lat: axisSpan(south, north, MAX_LAT_SPAN),
    centre: [(west + east) / 2, (south + north) / 2] as LonLat,
  };
}

const boxCentre = (box: Bbox): LonLat => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
const distance = (a: LonLat, b: LonLat) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Drawn tiles covering the grid, centre tile first, clipped around the centre to the tile cap. */
export function streetsBoxesFor(grid: LandscapeGrid): Bbox[] {
  const { lon, lat, centre } = axes(grid);
  const split = ({ count, start, total }: ReturnType<typeof axisSpan>) =>
    Array.from({ length: count }, (_, i): [number, number] => [
      start + (i * total) / count,
      start + ((i + 1) * total) / count,
    ]);
  const boxes: Bbox[] = [];
  for (const [s, n] of split(lat)) for (const [w, e] of split(lon)) boxes.push([w, s, e, n]);
  return boxes.sort((a, b) => distance(boxCentre(a), centre) - distance(boxCentre(b), centre));
}

/**
 * Candidate routing-area boxes of a board: the largest box the endpoint takes, slid across the
 * tiled extent in steps of at most half its size, an odd number of positions per axis so one
 * box sits on the board's centre. A board that fits one box has that box only (the drawn tile).
 * Fixed per board, so their cached areas are shared by every scenario on it. Centre box first.
 */
export function areaBoxesFor(grid: LandscapeGrid): Bbox[] {
  const { lon, lat, centre } = axes(grid);
  const positions = ({ count, start, total, max }: ReturnType<typeof axisSpan>): [number, number][] => {
    if (count === 1) return [[start, start + total]];
    let n = Math.ceil((total - max) / (max / 2)) + 1;
    if (n % 2 === 0) n += 1;
    return Array.from({ length: n }, (_, i): [number, number] => {
      const lo = start + ((total - max) * i) / (n - 1);
      return [lo, lo + max];
    });
  };
  const boxes: Bbox[] = [];
  for (const [s, n] of positions(lat)) for (const [w, e] of positions(lon)) boxes.push([w, s, e, n]);
  return boxes.sort((a, b) => distance(boxCentre(a), centre) - distance(boxCentre(b), centre));
}

/** Every box the board may request: drawn tiles, then routing-area candidates (deduplicated). */
export function allStreetBoxesFor(grid: LandscapeGrid): Bbox[] {
  const seen = new Set<string>();
  return [...streetsBoxesFor(grid), ...areaBoxesFor(grid)].filter((box) => {
    const key = boxKey(box);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const inside = (box: Bbox, [lon, lat]: LonLat) =>
  lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];

/**
 * The routing-area box for `focus` (points in priority order, e.g. fires by start minute): the
 * candidate holding the most points, then the one holding the first point, then the one whose
 * centre is nearest the held points' centroid (so each fire sits well inside it). No points:
 * the centre box.
 */
export function areaBoxFor(grid: LandscapeGrid, focus: readonly LonLat[] = []): Bbox {
  const candidates = areaBoxesFor(grid);
  if (focus.length === 0) return candidates[0];
  let best = candidates[0];
  let bestScore: [number, number, number] | null = null;
  for (const box of candidates) {
    const held = focus.filter((point) => inside(box, point));
    const centroid: LonLat = held.length
      ? [held.reduce((s, p) => s + p[0], 0) / held.length, held.reduce((s, p) => s + p[1], 0) / held.length]
      : boxCentre(box);
    const score: [number, number, number] = [
      held.length,
      inside(box, focus[0]) ? 1 : 0,
      -distance(boxCentre(box), centroid),
    ];
    // Strictly better only, so ties keep the box nearer the board's centre (listed first).
    const better =
      !bestScore ||
      score[0] > bestScore[0] ||
      (score[0] === bestScore[0] &&
        (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2] + 1e-9)));
    if (better) {
      best = box;
      bestScore = score;
    }
  }
  return best;
}

/** WGS84 centre box of the grid's routing-area candidates. */
export function streetsBoxFor(grid: LandscapeGrid): Bbox {
  return areaBoxesFor(grid)[0];
}

function isNoRoads(cause: unknown): boolean {
  return cause instanceof AreaRequestError && (cause.code === "no_roads" || cause.code === "no_exits");
}

const boxKey = (box: Bbox) => box.map((v) => v.toFixed(5)).join(",");

/**
 * Areas by box, shared by every caller in this tab (a drawn tile is often also the routing area).
 * A fetch is not aborted when one caller leaves, so the result still lands in the cache.
 */
const areaCache = new Map<string, Promise<DispatchArea>>();
function cachedArea(box: Bbox, signal: AbortSignal): Promise<DispatchArea> {
  const key = boxKey(box);
  let pending = areaCache.get(key);
  if (pending) {
    areaCache.delete(key);
  } else {
    pending = loadArea(box, new AbortController().signal);
    pending.catch(() => areaCache.delete(key));
  }
  areaCache.set(key, pending);
  while (areaCache.size > AREA_CACHE_SIZE) areaCache.delete(areaCache.keys().next().value!);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function loadScenery(grid: LandscapeGrid, signal: AbortSignal): Promise<BoardStreets | null> {
  const boxes = streetsBoxesFor(grid);
  const areas: (DispatchArea | null)[] = new Array(boxes.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_TILES, boxes.length) }, async () => {
      for (let i = next++; i < boxes.length; i = next++) {
        if (signal.aborted) return;
        areas[i] = await cachedArea(boxes[i], signal).catch(() => null);
      }
    }),
  );
  const loaded = areas.filter((a): a is DispatchArea => a !== null);
  if (loaded.length === 0) return null;
  if (loaded.length === 1) return loaded[0];
  return { edges: loaded.flatMap((a) => a.edges), homes: loaded.flatMap((a) => a.homes) };
}

type AreaResult = { area: DispatchArea } | { empty: true } | { error: string };

/**
 * Streets of `grid`, with the routing area chosen for `focus` ([lon, lat] points in priority
 * order, e.g. the enabled fires by start minute; empty or omitted: the board's centre box).
 */
export function useBoardStreets(
  grid: LandscapeGrid | null,
  focus: readonly LonLat[] = NO_FOCUS,
): BoardStreetsState {
  const box = useMemo(() => (grid ? areaBoxFor(grid, focus) : null), [grid, focus]);
  const key = box ? boxKey(box) : null;

  const [scenery, setScenery] = useState<{ grid: LandscapeGrid | null; value: BoardStreets | null | undefined }>({
    grid: null,
    value: undefined,
  });
  const [area, setArea] = useState<{ grid: LandscapeGrid | null; key: string | null; value: AreaResult | null }>({
    grid: null,
    key: null,
    value: null,
  });

  useEffect(() => {
    if (!grid) return;
    const controller = new AbortController();
    loadScenery(grid, controller.signal)
      .then((value) => !controller.signal.aborted && setScenery({ grid, value }))
      .catch(() => !controller.signal.aborted && setScenery({ grid, value: null }));
    return () => controller.abort();
  }, [grid]);

  useEffect(() => {
    if (!grid || !box || !key) return;
    const controller = new AbortController();
    cachedArea(box, controller.signal)
      .then((value) => setArea({ grid, key, value: { area: value } }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // Wilderness boxes have no roads; that is not an error worth showing.
        if (isNoRoads(cause)) {
          setArea({ grid, key, value: { empty: true } });
          return;
        }
        console.warn("Board streets unavailable", cause);
        const message = cause instanceof Error ? cause.message : "The road network could not be loaded.";
        setArea({ grid, key, value: { error: message } });
      });
    return () => controller.abort();
    // `box` is derived from `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, key]);

  if (!grid) return { status: "idle" };
  // A previous board's result never applies; a previous area's result never applies either.
  const drawn = scenery.grid === grid ? scenery.value : undefined;
  const result = area.grid === grid && area.key === key ? area.value : null;
  const shown = drawn ?? undefined;
  if (!result || drawn === undefined) return { status: "loading", scenery: shown };
  if ("area" in result) return { status: "ready", area: result.area, scenery: drawn ?? result.area };
  if ("empty" in result) return { status: "empty", scenery: shown };
  return { status: "error", message: result.error, scenery: shown };
}

const NO_FOCUS: readonly LonLat[] = [];
