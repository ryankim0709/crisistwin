/**
 * Pre-warm the landscape cache and the OSM street areas for every board the app can request.
 * Run through `node tools/prewarm_landscapes/run.mjs`; see app/backend/README.md
 * ("Pre-warming the landscape cache").
 *
 * Boards (each key is exactly what `loadLandscapeCached` would build, so the app hits it):
 *   - Studio: every catalogue region at its default board and at 10/15/20/30/45/60 km half-width
 *     (app/src/studio/useRegionBoard.ts: region centre, `boardCellMetersFor(radius)`).
 *   - Live: the drill environment centre (GET /api/demo/environment) at 15/30/45/60 km.
 *   - Historical fires: the recommended centre/radius/cell in public/historical-fires/index.json.
 * /fire custom-centre boards (any clicked point, horizon-dependent radius) cannot be enumerated.
 *
 * Phase 1 loads missing boards through the backend's geo cache proxies (so raw LANDFIRE and
 * terrain tiles are cached too) and POSTs the encoded package to /api/landscapes/cache.
 * Phase 2 requests the OSM street boxes the 3D diorama asks for (useBoardStreets.ts), one at a
 * time, backing off on 429/5xx, so /api/dispatch/area caches them in Mongo `dispatch_areas`.
 * State (board extents, finished street boxes) lives in a JSON file so a re-run resumes.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  LANDFIRE_CANOPY_COVERAGES,
  LANDFIRE_COVERAGE,
  LANDFIRE_UPSTREAM_WCS_URL,
  TERRAIN_UPSTREAM_TILE_URL,
  loadLandscape,
  type LandscapeGrid,
} from "../../app/src/fire/landscape";
import { landscapeCacheKey } from "../../app/src/fire/landscapeCache";
import { boardCellMetersFor } from "../../app/src/fire/boardSize";
import { decodeLandscapePackage, encodeLandscapePackage } from "../../app/src/fire/landscapePackage";
import { CALIFORNIA_REGIONS } from "../../app/src/fire/regions";
import { streetsBoxesFor } from "../../app/src/fire/useBoardStreets";
import { politeFetch } from "../build_landscape_regions/politeFetch.mts";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:8000" },
    state: { type: "string", default: "prewarm-state.json" },
    only: { type: "string", multiple: true },
    "dry-run": { type: "boolean", default: false },
    "no-streets": { type: "boolean", default: false },
    "streets-only": { type: "boolean", default: false },
    jobs: { type: "string", default: "2" },
    "max-gb": { type: "string", default: "8" },
    "bytes-per-cell": { type: "string", default: "" },
    force: { type: "boolean", default: false },
    "cache-cap": { type: "string", default: "200" },
    help: { type: "boolean", default: false },
  },
});
if (args.help) {
  console.log(
    "Usage: node tools/prewarm_landscapes/run.mjs [--dry-run] [--only <text>]... [--no-streets] [--streets-only]\n" +
      "       [--jobs 1|2] [--state <file>] [--base http://127.0.0.1:8000] [--max-gb 8] [--force]\n" +
      "       [--bytes-per-cell <n>] [--cache-cap 200]\n" +
      "--only keeps boards whose label contains the text (e.g. 'berkeley', 'r60000', 'live', 'hist').",
  );
  process.exit(0);
}

const BASE = args.base!.replace(/\/$/, "");
const statePath = path.resolve(args.state!);
const jobs = Math.min(2, Math.max(1, Number.parseInt(args.jobs!, 10) || 2));
const startedAt = Date.now();
const log = (line: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)} +${((Date.now() - startedAt) / 60000).toFixed(1)}m] ${line}`);

const controller = new AbortController();
process.on("SIGINT", () => {
  log("SIGINT: stopping after in-flight requests abort (state is saved; re-run to resume)");
  controller.abort(new DOMException("Interrupted", "AbortError"));
});
const signal = controller.signal;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

// ---- Board list -------------------------------------------------------------------------

interface Board {
  key: string;
  label: string;
  lon: number;
  lat: number;
  radius: number;
  /** Requested cell size, as the app passes it to the loader. */
  cell: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function board(label: string, lon: number, lat: number, radius: number, cell: number): Board {
  const lo = round3(lon);
  const la = round3(lat);
  return {
    key: landscapeCacheKey(lo, la, radius, Math.max(cell, 30)),
    label: `${label} r${radius} m${cell}`,
    lon: lo,
    lat: la,
    radius,
    cell,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function enumerateBoards(): Promise<Board[]> {
  const boards: Board[] = [];
  const studioKm = [10, 15, 20, 30, 45, 60];
  for (const region of CALIFORNIA_REGIONS) {
    boards.push(board(`studio:${region.id}:default`, region.center.longitude, region.center.latitude, region.radiusMeters, region.cellMeters));
    for (const km of studioKm) {
      boards.push(board(`studio:${region.id}`, region.center.longitude, region.center.latitude, km * 1000, boardCellMetersFor(km * 1000)));
    }
  }
  try {
    const env = await getJson<{ center?: [number, number] }>(`${BASE}/api/demo/environment`);
    if (env.center) {
      for (const km of [15, 30, 45, 60]) {
        boards.push(board("live", env.center[0], env.center[1], km * 1000, boardCellMetersFor(km * 1000)));
      }
    } else log("WARNING: /api/demo/environment has no centre; Live boards skipped");
  } catch (cause) {
    log(`WARNING: Live boards skipped (${(cause as Error).message})`);
  }
  try {
    const indexPath = path.resolve(process.cwd(), "app/public/historical-fires/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      fires: { id: string; board: { center: [number, number]; radius_m: number; cell_m: number } }[];
    };
    for (const fire of index.fires) {
      boards.push(board(`hist:${fire.id}`, fire.board.center[0], fire.board.center[1], fire.board.radius_m, fire.board.cell_m));
    }
  } catch (cause) {
    log(`WARNING: historical boards skipped (${(cause as Error).message})`);
  }
  const seen = new Map<string, Board>();
  for (const b of boards) if (!seen.has(b.key)) seen.set(b.key, b);
  let list = [...seen.values()];
  if (args.only?.length) list = list.filter((b) => args.only!.some((text) => b.label.includes(text) || b.key.includes(text)));
  // Small boards first: most boards are ready early.
  return list.sort((a, b) => a.radius / a.cell - b.radius / b.cell);
}

// ---- State ------------------------------------------------------------------------------

interface State {
  /** Board extents ([w,s,e,n] street boxes) per cache key. */
  boxes: Record<string, [number, number, number, number][]>;
  /** Snapped street box -> "ok" | "no_roads". */
  areas: Record<string, string>;
  failures: Record<string, string>;
}
let state: State = { boxes: {}, areas: {}, failures: {} };
try {
  state = { ...state, ...(JSON.parse(await readFile(statePath, "utf8")) as State) };
} catch {
  // first run
}
async function saveState(): Promise<void> {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state));
  await rename(`${statePath}.tmp`, statePath);
}

// ---- Cache calls ------------------------------------------------------------------------

async function cachedBytes(key: string): Promise<number | null> {
  const response = await fetch(`${BASE}/api/landscapes/cache?key=${encodeURIComponent(key)}`, { method: "HEAD", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HEAD ${key}: HTTP ${response.status}`);
  return Number(response.headers.get("content-length") ?? 0);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

// ---- Street boxes -----------------------------------------------------------------------

const GRID_DEG = 0.01;
/** Mirrors snap_box in app/backend/api/dispatch_area.py (outward to 0.01 degrees). */
function snapKey(box: number[]): string {
  const query = box.map((v) => v.toFixed(5)).map(Number);
  const down = (v: number) => (Math.floor(v / GRID_DEG + 1e-6) * GRID_DEG).toFixed(2);
  const up = (v: number) => (Math.ceil(v / GRID_DEG - 1e-6) * GRID_DEG).toFixed(2);
  return [down(query[0]), down(query[1]), up(query[2]), up(query[3])].join(",");
}

async function boxesFromCache(key: string): Promise<[number, number, number, number][]> {
  const response = await fetch(`${BASE}/api/landscapes/cache?key=${encodeURIComponent(key)}`, { signal });
  if (!response.ok) throw new Error(`GET ${key}: HTTP ${response.status}`);
  const { grid } = await decodeLandscapePackage(await response.arrayBuffer());
  return streetsBoxesFor(grid);
}

// ---- Phase 1: boards --------------------------------------------------------------------

const { fetch: loaderFetch, stats } = politeFetch(signal, log);
let storedBytes = 0;
let storedCount = 0;
let failedBoards = 0;

async function buildBoard(b: Board): Promise<void> {
  const began = Date.now();
  const grid: LandscapeGrid = await loadLandscape(b.lon, b.lat, b.radius, signal, {
    cellMeters: b.cell,
    endpoints: {
      landfireWcsUrl: `${BASE}/api/geo/landfire/wcs`,
      terrainTileUrl: `${BASE}/api/geo/terrarium`,
      fetch: loaderFetch,
    },
  });
  if (!grid.elevationComplete || !grid.canopyComplete) {
    throw new Error(`incomplete data (elevation ${grid.elevationComplete}, canopy ${grid.canopyComplete}); not stored`);
  }
  const now = new Date().toISOString();
  const bytes = await encodeLandscapePackage(grid, {
    regionId: b.key,
    builtAt: now,
    cellMeters: grid.cellMeters,
    resampling: grid.resampling,
    sources: {
      landfireWcs: LANDFIRE_UPSTREAM_WCS_URL,
      coverages: [LANDFIRE_COVERAGE, ...Object.values(LANDFIRE_CANOPY_COVERAGES)],
      terrainTiles: TERRAIN_UPSTREAM_TILE_URL,
      retrievedAt: now,
    },
  });
  const response = await fetch(`${BASE}/api/landscapes/cache?key=${encodeURIComponent(b.key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/gzip" },
    body: bytes as BodyInit,
    signal,
  });
  if (response.status !== 204) throw new Error(`POST HTTP ${response.status} (${bytes.length} bytes)`);
  storedBytes += bytes.length;
  storedCount++;
  state.boxes[b.key] = streetsBoxesFor(grid);
  delete state.failures[b.key];
  await saveState();
  log(`  stored ${b.label} ${grid.width}x${grid.height} ${(bytes.length / 1e6).toFixed(2)} MB in ${((Date.now() - began) / 1000).toFixed(0)}s`);
}

// ---- Phase 2: streets -------------------------------------------------------------------

async function fetchArea(box: number[]): Promise<"ok" | "no_roads" | "retry"> {
  const query = box.map((v) => v.toFixed(5)).join(",");
  const response = await fetch(`${BASE}/api/dispatch/area?bbox=${query}`, { headers: { Accept: "application/json" }, signal });
  if (response.ok) {
    await response.arrayBuffer();
    return "ok";
  }
  const retryAfter = Number(response.headers.get("retry-after")) || 0;
  let code = "";
  try {
    code = ((await response.json()) as { error?: string }).error ?? "";
  } catch {
    // not JSON
  }
  if (response.status === 422 || code === "no_roads" || code === "no_exits") return "no_roads";
  if (response.status === 400) throw new Error(`bad bbox ${query}`);
  log(`  area ${query}: HTTP ${response.status} ${code}; backing off`);
  await sleep(Math.max(retryAfter, response.status === 429 ? 30 : 20) * 1000);
  return "retry";
}

async function streetsPhase(list: Board[]): Promise<void> {
  const pending = new Map<string, number[]>();
  for (const b of list) {
    if (signal.aborted) return;
    let boxes = state.boxes[b.key];
    if (!boxes) {
      try {
        boxes = state.boxes[b.key] = await boxesFromCache(b.key);
        await saveState();
      } catch (cause) {
        log(`  streets: no extent for ${b.label} (${(cause as Error).message}); skipped`);
        continue;
      }
    }
    for (const box of boxes) {
      const key = snapKey(box);
      if (!state.areas[key] && !pending.has(key)) pending.set(key, box);
    }
  }
  const total = pending.size;
  log(`streets: ${total} distinct boxes to request (${Object.keys(state.areas).length} already done)`);
  let done = 0;
  for (const [key, box] of pending) {
    for (let attempt = 1; attempt <= 6 && !signal.aborted; attempt++) {
      let result: "ok" | "no_roads" | "retry";
      try {
        result = await fetchArea(box);
      } catch (cause) {
        if (signal.aborted) return;
        log(`  area ${key}: ${(cause as Error).message}`);
        result = "retry";
        await sleep(15_000);
      }
      if (result !== "retry") {
        state.areas[key] = result;
        break;
      }
    }
    done++;
    if (done % 10 === 0 || done === total) {
      await saveState();
      log(`streets: ${done}/${total}`);
    }
    await sleep(500);
  }
  await saveState();
}

// ---- Main -------------------------------------------------------------------------------

const boards = await enumerateBoards();
log(`${boards.length} boards enumerated`);
const cap = Number(args["cache-cap"]);
if (boards.length > cap) {
  log(`WARNING: ${boards.length} boards exceed the default landscape cache cap of ${cap} files (setting LANDSCAPE_CACHE_MAX_FILES).`);
}

let missing: Board[] = [];
if (!args["streets-only"]) {
  const sizes = await mapLimit(boards, 4, async (b) => ({ b, bytes: await cachedBytes(b.key) }));
  const cachedAlready = sizes.filter((s) => s.bytes !== null);
  missing = sizes.filter((s) => s.bytes === null).map((s) => s.b);
  const known = cachedAlready.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  log(`${cachedAlready.length} already cached (${(known / 1e6).toFixed(0)} MB); ${missing.length} to build`);

  const cellsOf = (b: Board) => (2 * b.radius / Math.max(b.cell, 30)) ** 2;
  const perCell = Number(args["bytes-per-cell"]) || (cachedAlready.length ? known / cachedAlready.reduce((s, x) => s + cellsOf(x.b), 0) : 0);
  if (perCell > 0) {
    const estimate = missing.reduce((sum, b) => sum + cellsOf(b) * perCell, 0);
    log(`estimated size of the ${missing.length} missing boards: ${(estimate / 1e9).toFixed(2)} GB (${perCell.toFixed(2)} bytes/cell)`);
    if (estimate / 1e9 > Number(args["max-gb"]) && !args.force) {
      log(`estimate exceeds --max-gb ${args["max-gb"]}; stopping (use --force to override)`);
      process.exit(3);
    }
  } else {
    log("no size measurement yet (no board cached); build one with --only first, or pass --bytes-per-cell");
  }
  // Stay under the server's file cap: it evicts the oldest file on each write beyond it.
  let maxFiles = Number(args["cache-cap"]);
  let files = cachedAlready.length;
  try {
    const status = await getJson<{ files: number; maxFiles: number }>(`${BASE}/api/landscapes/cache/status`);
    maxFiles = status.maxFiles;
    files = status.files;
  } catch {
    log(`status endpoint not available yet (server not reloaded); assuming cap ${maxFiles}, ${files} files known`);
  }
  const budget = Math.max(0, maxFiles - 10 - files);
  if (missing.length > budget) {
    log(`WARNING: cap ${maxFiles}, ${files} files cached: building only the first ${budget} of ${missing.length} missing boards (smallest first).`);
    log("  After the server reloads with LANDSCAPE_CACHE_MAX_FILES=2000, re-run this command to build the rest.");
    missing = missing.slice(0, budget);
  }
  if (args["dry-run"]) {
    for (const b of boards) console.log(`${missing.includes(b) ? "MISSING" : "cached "} ${b.key}  ${b.label}`);
    process.exit(0);
  }

  const progress = setInterval(
    () =>
      log(
        `progress: ${storedCount}/${missing.length} boards stored, ${failedBoards} failed, ${(storedBytes / 1e6).toFixed(0)} MB stored, ` +
          `${stats.completed} tile requests (${(stats.bytes / 1e6).toFixed(0)} MB), ${stats.retried} retried`,
      ),
    60_000,
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, missing.length) }, async () => {
      for (let i = next++; i < missing.length && !signal.aborted; i = next++) {
        const b = missing[i];
        log(`board ${i + 1}/${missing.length}: ${b.label} (${b.key})`);
        try {
          await buildBoard(b);
        } catch (cause) {
          if (signal.aborted) return;
          failedBoards++;
          state.failures[b.key] = (cause as Error).message;
          await saveState();
          log(`  FAILED ${b.label}: ${(cause as Error).message}`);
        }
      }
    }),
  );
  clearInterval(progress);
  log(`boards done: ${storedCount} stored (${(storedBytes / 1e6).toFixed(0)} MB), ${failedBoards} failed`);
}

if (!args["no-streets"] && !signal.aborted) {
  await streetsPhase(boards);
}
log(signal.aborted ? "interrupted; re-run the same command to resume" : "finished");
process.exit(signal.aborted ? 130 : failedBoards > 0 ? 1 : 0);
