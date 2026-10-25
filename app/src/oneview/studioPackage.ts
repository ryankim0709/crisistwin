/**
 * Builds a Berkeley Hills & Tilden drill package from a /run preset when the server has none:
 * the Studio's own solve (studio/solver.worker.ts, the free-burning fire, firefighting off) on the
 * preset's Studio board (the same landscape load as studio/useRegionBoard.ts), then
 * `POST /api/live/packages` with studio/drillPackage.ts buildRunExport, as
 * studio/usePublishLiveFire.ts does for "Use as live drill". The fire is simulated; units as in
 * studio/contracts.ts (WGS84 degrees, minutes from T+0, open 20 ft wind mph FROM degrees true).
 */

import { MOISTURE_PRESETS } from "../fire/spread";
import { boardCellMetersFor } from "../fire/boardSize";
import { loadLandscapeCached } from "../fire/landscapeCache";
import { fetchRegionLandscape } from "../fire/landscapePackage";
import type { LandscapeGrid } from "../fire/landscape";
import type { DemoSeedPreset } from "../demo/runContracts";
import type { SolverRequest, SolverResponse, StudioRunResult, StudioScenario } from "../studio/contracts";
import { buildRunExport, postDrillPackage, type DrillPackageResponse } from "../studio/drillPackage";
import { emptyScenario, toSolverInput, validateScenario } from "../studio/scenario";
import { gridBox, gridCoversScenario, parseStudioBoardId } from "../studio/useRegionBoard";
import type { ScenarioDraft } from "./types";
import { presetWeatherSeries } from "./presetWeather";

/** The preset's Studio board landscape: a chosen size loads around the region centre, else the stored region board. */
async function loadBoard(boardId: string, signal: AbortSignal): Promise<LandscapeGrid> {
  const parsed = parseStudioBoardId(boardId);
  if (!parsed) throw new Error(`Unknown Studio board "${boardId}".`);
  const { region, radiusMeters } = parsed;
  if (radiusMeters !== null) {
    const { grid } = await loadLandscapeCached(region.center.longitude, region.center.latitude, radiusMeters, signal, {
      cellMeters: boardCellMetersFor(radiusMeters),
    });
    return grid;
  }
  try {
    return (await fetchRegionLandscape(region.id, signal)).grid;
  } catch {
    const { grid } = await loadLandscapeCached(region.center.longitude, region.center.latitude, region.radiusMeters, signal, {
      cellMeters: region.cellMeters,
    });
    return grid;
  }
}

/** The preset as a Studio scenario: its ignitions, wind, moisture preset and run length; no firefighting. */
export function presetScenario(draft: ScenarioDraft, preset: DemoSeedPreset): StudioScenario {
  const base = emptyScenario();
  const moisture = MOISTURE_PRESETS.find((m) => m.id === draft.moisturePreset) ?? MOISTURE_PRESETS[0];
  const series = presetWeatherSeries(preset);
  return {
    ...base,
    name: preset.label,
    ignitions: draft.ignitions.map((ig, n) => {
      const start = Math.max(0, Math.round(ig.startMinute));
      return {
        id: `ign-${n + 1}`,
        name: `F${n + 1}`,
        location: { latitude: ig.lat, longitude: ig.lon },
        startMinute: start,
        reportMinute: ig.reportMinute === null ? null : Math.max(start, Math.round(ig.reportMinute)),
        enabled: true,
      };
    }),
    settings: {
      ...base.settings,
      windSpeedMph: draft.windSpeedMph,
      windFromDegrees: ((Math.round(draft.windFromDeg) % 360) + 360) % 360,
      moisture: { ...moisture.moisture },
      horizonMinutes: Math.round(draft.horizonMinutes),
      // The preset's weather schedule, so the package's road box follows the fire the board runs.
      ...(series ? { weatherSeries: series } : {}),
    },
  };
}

/** One solve in a fresh Studio solver worker; terminated on abort. */
function solve(grid: LandscapeGrid, scenario: StudioScenario, signal: AbortSignal): Promise<Extract<SolverResponse, { type: "result" }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../studio/solver.worker.ts", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
    const done = () => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<SolverResponse>) => {
      const response = event.data;
      if (response.type === "progress") return;
      done();
      if (response.type === "error") reject(new Error(response.message));
      else resolve(response);
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(event.message || "The fire model worker crashed."));
    };
    const request: SolverRequest = {
      type: "solve",
      requestId: 1,
      landscape: grid,
      input: toSolverInput(scenario),
      firefighting: null,
      crewArrivals: null,
      airBases: null,
      incidents: null,
    };
    worker.postMessage(request);
  });
}

export type PackageStep = "terrain" | "simulating" | "publishing";

/** Solves the preset on its Studio board and stores it as a drill package (not yet activated). */
export async function buildPresetPackage(
  draft: ScenarioDraft,
  preset: DemoSeedPreset,
  signal: AbortSignal,
  onStep: (step: PackageStep) => void,
): Promise<DrillPackageResponse> {
  const scenario = presetScenario(draft, preset);
  const issues = validateScenario(scenario);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));
  onStep("terrain");
  const grid = await loadBoard(preset.regionId, signal);
  if (!gridCoversScenario(grid, scenario)) throw new Error("An ignition lies outside the Berkeley Hills & Tilden board.");
  onStep("simulating");
  const response = await solve(grid, scenario, signal);
  const result: StudioRunResult = {
    requestId: response.requestId,
    scenario,
    run: response.run,
    frameMinutes: response.run.frames.map((frame) => frame.elapsedMinutes),
    landscapeKey: `region:${preset.regionId}`,
    landscapeBox: gridBox(grid),
    boardId: preset.regionId,
    landscape: grid,
    attribution: grid.attribution,
    elevationComplete: grid.elevationComplete,
    firefighting: null,
    crewDispatch: null,
    crewDispatchNote: null,
  };
  onStep("publishing");
  return postDrillPackage(buildRunExport(result, new Date()), signal);
}
