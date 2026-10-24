/**
 * Studio run -> drill package request (`POST /api/live/packages`). Contract:
 * docs/replay-bundle.md "Drill packages"; decision: docs/adr/0037-studio-drill-packages.md.
 *
 * The export carries the free-burning fire (`result.run`, never a firefighting plan), the
 * arrival grid in Web Mercator (EPSG:3857, cell centres, row 0 north), frame perimeters as
 * WGS84 [lon, lat], and the run's assumptions. Arrival times are integer seconds after T+0.
 */

import type { StudioRunResult } from "./contracts";

export const RUN_EXPORT_KIND = "crisistwin_studio_run";
/** Mirrors livecore/package.py MAX_GRID_CELLS (with headroom). */
const MAX_EXPORT_CELLS = 1_400_000;
/** Mirrors livecore/package.py MAX_FRAME_VERTICES (with headroom). */
const MAX_EXPORT_VERTICES = 300_000;
const FRAME_STEP_CHOICES = [10, 15, 20, 30, 60];
const PAD_CELLS = 2;

type LonLat = [number, number];

export interface StudioRunExport {
  kind: typeof RUN_EXPORT_KIND;
  schema_version: 1;
  scenario: { id: string; name: string };
  region_id: string | null;
  /** Drill T+0, UTC ISO 8601 with Z. Chosen, not observed. */
  ignition_time: string;
  ignitions: { id: string; name: string; coord: LonLat; start_minute: number }[];
  assumptions: {
    wind_20ft_mph: number;
    /** Degrees true, the direction the wind blows FROM. */
    wind_from_deg: number;
    moisture: Record<string, number>;
    midflame_adjustment: number;
    horizon_min: number;
    spotting: unknown;
    structure_spread: unknown;
  };
  model: { id: string; version: string };
  landscape: { cell_m: number; resampling: string; elevation_complete: boolean };
  arrival_grid: {
    crs: "EPSG:3857";
    order: "row_major_north_first";
    origin_x: number;
    origin_y: number;
    cell_x: number;
    cell_y: number;
    ground_cell_m: number;
    ncols: number;
    nrows: number;
    arrival_s: (number | null)[];
  };
  frames: {
    minute: number;
    geometry: { type: "MultiPolygon"; coordinates: LonLat[][][] } | null;
    area_m2: number;
  }[];
}

export interface DrillPackageSummary {
  name: string;
  place: string;
  zones: number;
  homes: number;
  vehicles: number;
  exits: number;
  stations: number;
  fronts: number;
  clipped: boolean;
}

export interface DrillPackageResponse {
  package_id: string;
  incident_id: string;
  summary: DrillPackageSummary;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The arrival grid cropped to reached cells (+ padding), coarsened by block minimum if huge. */
function exportGrid(result: StudioRunResult): StudioRunExport["arrival_grid"] {
  const { landscape, run } = result;
  const horizon = result.scenario.settings.horizonMinutes;
  const { width, height } = landscape;
  const arrival = run.arrivalMinutes;
  let minC = width;
  let minR = height;
  let maxC = -1;
  let maxR = -1;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const minute = arrival[row * width + col];
      if (Number.isFinite(minute) && minute <= horizon) {
        if (col < minC) minC = col;
        if (col > maxC) maxC = col;
        if (row < minR) minR = row;
        if (row > maxR) maxR = row;
      }
    }
  }
  if (maxC < 0) throw new Error("The run has no burned area.");
  minC = Math.max(0, minC - PAD_CELLS);
  minR = Math.max(0, minR - PAD_CELLS);
  maxC = Math.min(width - 1, maxC + PAD_CELLS);
  maxR = Math.min(height - 1, maxR + PAD_CELLS);
  const cropW = maxC - minC + 1;
  const cropH = maxR - minR + 1;
  const k = Math.max(1, Math.ceil(Math.sqrt((cropW * cropH) / MAX_EXPORT_CELLS)));
  const ncols = Math.ceil(cropW / k);
  const nrows = Math.ceil(cropH / k);
  const out: (number | null)[] = new Array(ncols * nrows);
  for (let r = 0; r < nrows; r += 1) {
    for (let c = 0; c < ncols; c += 1) {
      let best = Infinity;
      for (let dr = 0; dr < k; dr += 1) {
        const row = minR + r * k + dr;
        if (row > maxR) break;
        for (let dc = 0; dc < k; dc += 1) {
          const col = minC + c * k + dc;
          if (col > maxC) break;
          const minute = arrival[row * width + col];
          if (minute < best) best = minute;
        }
      }
      out[r * ncols + c] = Number.isFinite(best) && best <= horizon ? Math.round(best * 60) : null;
    }
  }
  return {
    crs: "EPSG:3857",
    order: "row_major_north_first",
    // Centre of the first (k x k) block.
    origin_x: landscape.originX + (minC + (k - 1) / 2) * landscape.cellSizeX,
    origin_y: landscape.originY + (minR + (k - 1) / 2) * landscape.cellSizeY,
    cell_x: landscape.cellSizeX * k,
    cell_y: landscape.cellSizeY * k,
    ground_cell_m: landscape.groundCellSizeMeters * k,
    ncols,
    nrows,
    arrival_s: out,
  };
}

function exportFrames(result: StudioRunResult): StudioRunExport["frames"] {
  const all = result.run.frames.map((frame) => ({
    minute: frame.elapsedMinutes,
    area_m2: frame.reachedAreaSquareMeters,
    coordinates: frame.perimeters.map((feature) =>
      feature.geometry.coordinates.map((ring) =>
        ring.map((point) => [round6(point[0]), round6(point[1])] as LonLat),
      ),
    ),
  }));
  const vertices = (frame: (typeof all)[number]) =>
    frame.coordinates.reduce(
      (sum, polygon) => sum + polygon.reduce((s, ring) => s + ring.length, 0),
      0,
    );
  const last = all[all.length - 1];
  // Keep every `step`-minute frame plus the last, at the finest step that fits the vertex cap.
  let kept = all;
  for (const step of FRAME_STEP_CHOICES) {
    kept = all.filter((frame) => frame.minute % step === 0 || frame === last);
    if (kept.reduce((sum, frame) => sum + vertices(frame), 0) <= MAX_EXPORT_VERTICES) break;
  }
  return kept.map((frame) => ({
    minute: frame.minute,
    area_m2: frame.area_m2,
    geometry:
      frame.coordinates.length > 0
        ? { type: "MultiPolygon", coordinates: frame.coordinates }
        : null,
  }));
}

/** Build the run export. `ignitionTime` is drill T+0 (the scenario has no clock of its own). */
export function buildRunExport(result: StudioRunResult, ignitionTime: Date): StudioRunExport {
  const { scenario, run, landscape } = result;
  const { settings } = scenario;
  const names = new Map(scenario.ignitions.map((ignition) => [ignition.id, ignition.name]));
  const t0 = new Date(Math.floor(ignitionTime.getTime() / 60_000) * 60_000);
  return {
    kind: RUN_EXPORT_KIND,
    schema_version: 1,
    scenario: { id: scenario.id, name: scenario.name.trim() || "Untitled scenario" },
    region_id: result.boardId,
    ignition_time: t0.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ignitions: run.input.sources.map((source) => ({
      id: source.id,
      name: names.get(source.id) ?? source.id,
      coord: [source.location.longitude, source.location.latitude],
      start_minute: source.startMinute,
    })),
    assumptions: {
      wind_20ft_mph: settings.windSpeedMph,
      wind_from_deg: settings.windFromDegrees,
      moisture: { ...settings.moisture },
      midflame_adjustment: settings.midflameAdjustment,
      horizon_min: settings.horizonMinutes,
      spotting: settings.spotting ?? null,
      structure_spread: settings.structureSpread ?? null,
    },
    model: { id: run.model.id, version: run.model.version },
    landscape: {
      cell_m: landscape.cellMeters,
      resampling: landscape.resampling,
      elevation_complete: landscape.elevationComplete,
    },
    arrival_grid: exportGrid(result),
    frames: exportFrames(result),
  };
}

/** POST the export. Controller auth comes from the dev proxy (vite.config.ts). */
export async function postDrillPackage(
  body: StudioRunExport,
  signal?: AbortSignal,
): Promise<DrillPackageResponse> {
  const response = await fetch("/api/live/packages", {
    method: "POST",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const err = (data ?? {}) as { error?: string; detail?: string };
    if (response.status === 401 || response.status === 403) {
      throw new Error("The live server refused the controller request.");
    }
    throw new Error(
      err.detail ?? err.error?.replace(/_/g, " ") ?? `Live API returned HTTP ${response.status}.`,
    );
  }
  return data as DrillPackageResponse;
}
