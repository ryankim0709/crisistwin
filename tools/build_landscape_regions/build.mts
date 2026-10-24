/**
 * Build prebuilt Southern California landscape packages (ADR 0013) with the page's own
 * loader and encoder. Run through `node tools/build_landscape_regions/run.mjs`, which
 * bundles this file with esbuild; see tools/build_landscape_regions/README.md.
 *
 * Output (git-ignored): <out>/<regionId>/<sha256>.ctls.gz and <out>/manifest.json.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  LANDFIRE_CANOPY_COVERAGES,
  LANDFIRE_COVERAGE,
  LANDFIRE_UPSTREAM_WCS_URL,
  LANDFIRE_USER_AGENT,
  TERRAIN_TILE_URL,
  loadLandscape,
  type LandscapeResampling,
} from "../../app/src/fire/landscape";
import {
  LANDSCAPE_PACKAGE_VERSION,
  encodeLandscapePackage,
  type LandscapePackageSources,
} from "../../app/src/fire/landscapePackage";
import { SOCAL_REGIONS, type LandscapeRegion } from "../../app/src/fire/regions";
import { politeFetch } from "./politeFetch.mts";

const MAX_JOBS = 2;
const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  regionId: string;
  name: string;
  counties: string[];
  summary: string;
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  cellMeters: number;
  width: number;
  height: number;
  builtAt: string;
  bytes: number;
  sha256: string;
  /** Package path relative to the manifest's directory. */
  path: string;
  formatVersion: number;
  lattice: {
    width: number;
    height: number;
    cellMeters: number;
    groundCellSizeMeters: number;
    originX: number;
    originY: number;
    cellSizeX: number;
    cellSizeY: number;
    resampling: LandscapeResampling;
  };
  elevationComplete: boolean;
  canopyComplete: boolean;
  sources: LandscapePackageSources;
  buildSeconds: number;
}

interface Manifest {
  manifestVersion: number;
  regions: ManifestEntry[];
}

const { values: args } = parseArgs({
  options: {
    region: { type: "string", multiple: true },
    out: { type: "string" },
    jobs: { type: "string", default: "1" },
    // Smoke-test overrides; use with --out pointing somewhere other than data/landscapes.
    radius: { type: "string" },
    "cell-meters": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(
    "Usage: node tools/build_landscape_regions/run.mjs [--region <id>]... [--jobs 1|2] [--out <dir>]\n" +
      "       [--radius <m>] [--cell-meters <m>]   (smoke-test overrides of the catalogue)\n" +
      `Regions: ${SOCAL_REGIONS.map((region) => region.id).join(", ")}`,
  );
  process.exit(0);
}

const startedAt = Date.now();
const log = (line: string) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(5)}s] ${line}`);

const outDir = path.resolve(args.out ?? "data/landscapes");
const jobs = Math.min(Math.max(1, Number.parseInt(args.jobs ?? "1", 10) || 1), MAX_JOBS);
const regions: LandscapeRegion[] = args.region?.length
  ? args.region.map((id) => {
      const region = SOCAL_REGIONS.find((candidate) => candidate.id === id);
      if (!region) {
        console.error(`Unknown region ${id}. Known: ${SOCAL_REGIONS.map((r) => r.id).join(", ")}`);
        process.exit(2);
      }
      return region;
    })
  : [...SOCAL_REGIONS];
for (const [key, field] of [
  ["radius", "radiusMeters"],
  ["cell-meters", "cellMeters"],
] as const) {
  const raw = args[key];
  if (raw === undefined) continue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${key} must be a positive number of metres.`);
    process.exit(2);
  }
  for (let i = 0; i < regions.length; i++) regions[i] = { ...regions[i], [field]: value };
}

const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  log("SIGINT: aborting in-flight requests (press Ctrl-C again to force quit)");
  controller.abort(new DOMException("Build interrupted", "AbortError"));
});

const { fetch: buildFetch, stats: fetchStats } = politeFetch(controller.signal, log);

async function buildRegion(region: LandscapeRegion): Promise<ManifestEntry> {
  const regionStart = Date.now();
  const retrievedAt = new Date().toISOString();
  log(
    `${region.id}: loading ${(region.radiusMeters / 1000).toFixed(0)} km radius at ` +
      `${region.cellMeters} m cells`,
  );
  const grid = await loadLandscape(
    region.center.longitude,
    region.center.latitude,
    region.radiusMeters,
    controller.signal,
    {
      cellMeters: region.cellMeters,
      endpoints: {
        landfireWcsUrl: LANDFIRE_UPSTREAM_WCS_URL,
        terrainTileUrl: TERRAIN_TILE_URL,
        userAgent: LANDFIRE_USER_AGENT,
        fetch: buildFetch,
      },
    },
  );
  const { cellMeters, resampling } = grid;
  const builtAt = new Date().toISOString();
  const sources: LandscapePackageSources = {
    landfireWcs: LANDFIRE_UPSTREAM_WCS_URL,
    coverages: [LANDFIRE_COVERAGE, ...Object.values(LANDFIRE_CANOPY_COVERAGES)],
    terrainTiles: TERRAIN_TILE_URL,
    retrievedAt,
  };
  const bytes = await encodeLandscapePackage(grid, {
    regionId: region.id,
    builtAt,
    cellMeters,
    resampling,
    sources,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relative = `${region.id}/${sha256}.ctls.gz`;
  const target = path.join(outDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, bytes);
  await rename(`${target}.tmp`, target);
  const buildSeconds = Math.round((Date.now() - regionStart) / 100) / 10;
  log(
    `${region.id}: ${grid.width}x${grid.height} cells, ${(bytes.length / 1e6).toFixed(2)} MB, ` +
      `${buildSeconds}s, elevation ${grid.elevationComplete ? "complete" : "INCOMPLETE"}, ` +
      `canopy ${grid.canopyComplete ? "complete" : "INCOMPLETE"} -> ${relative}`,
  );
  return {
    regionId: region.id,
    name: region.name,
    counties: region.counties,
    summary: region.summary,
    center: region.center,
    radiusMeters: region.radiusMeters,
    cellMeters,
    width: grid.width,
    height: grid.height,
    builtAt,
    bytes: bytes.length,
    sha256,
    path: relative,
    formatVersion: LANDSCAPE_PACKAGE_VERSION,
    lattice: {
      width: grid.width,
      height: grid.height,
      cellMeters,
      groundCellSizeMeters: grid.groundCellSizeMeters,
      originX: grid.originX,
      originY: grid.originY,
      cellSizeX: grid.cellSizeX,
      cellSizeY: grid.cellSizeY,
      resampling,
    },
    elevationComplete: grid.elevationComplete,
    canopyComplete: grid.canopyComplete,
    sources,
    buildSeconds,
  };
}

const manifestPath = path.join(outDir, "manifest.json");
let manifestWrite = Promise.resolve();

async function recordInManifest(entry: ManifestEntry): Promise<void> {
  // Serialised so two parallel jobs cannot interleave read-modify-write.
  manifestWrite = manifestWrite.then(async () => {
    let manifest: Manifest = { manifestVersion: MANIFEST_VERSION, regions: [] };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    manifest.regions = manifest.regions
      .filter((existing) => existing.regionId !== entry.regionId)
      .concat(entry)
      .sort((a, b) => a.regionId.localeCompare(b.regionId));
    await mkdir(outDir, { recursive: true });
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(`${manifestPath}.tmp`, manifestPath);
  });
  return manifestWrite;
}

const progress = setInterval(() => {
  log(
    `  requests ${fetchStats.completed}/${fetchStats.started} done, ${fetchStats.retried} retried, ` +
      `${fetchStats.failed} failed, ${(fetchStats.bytes / 1e6).toFixed(0)} MB downloaded`,
  );
}, 15_000);

const failures: string[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, regions.length) }, async () => {
    for (let index = next++; index < regions.length; index = next++) {
      if (controller.signal.aborted) return;
      const region = regions[index];
      try {
        await recordInManifest(await buildRegion(region));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failures.push(`${region.id}: ${message}`);
        log(`${region.id}: FAILED - ${message}`);
      }
    }
  }),
);
clearInterval(progress);
log(
  `done: ${regions.length - failures.length}/${regions.length} regions built, ` +
    `${fetchStats.completed} requests, ${(fetchStats.bytes / 1e6).toFixed(0)} MB downloaded`,
);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(controller.signal.aborted ? 130 : 1);
}
