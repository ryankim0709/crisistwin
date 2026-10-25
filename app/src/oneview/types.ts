/**
 * Page-level types of the single-view scenario run (/run). Shared contracts with other modules
 * (run modes, score timeline, demo seeds) live in demo/runContracts.ts.
 *
 * Units: minutes are board minutes from scenario T+0 (never wall time); wind speed is the open
 * 20 ft wind in mph and its direction the bearing it blows FROM, degrees true (studio/liveFire.ts);
 * coordinates are WGS84 degrees.
 */

import type { DemoSeedPreset } from "../demo/runContracts";

/** The three steps of a run, in order. */
export type RunPhase = "setup" | "baseline" | "ai";

/** The user's working copy of a preset (Setup step); what "Prepare" publishes. */
export interface ScenarioDraft {
  presetId: string;
  /** Board seed both runs use (the preset's; restart(seed) on the board). */
  seed: number;
  windSpeedMph: number;
  windFromDeg: number;
  moisturePreset: DemoSeedPreset["moisturePreset"];
  ignitions: DemoSeedPreset["ignitions"];
  /** Run length, board minutes. */
  horizonMinutes: number;
}

export function draftFromPreset(preset: DemoSeedPreset): ScenarioDraft {
  return {
    presetId: preset.id,
    seed: preset.seed,
    windSpeedMph: preset.wind.speedMph,
    windFromDeg: preset.wind.fromDeg,
    moisturePreset: preset.moisturePreset,
    ignitions: preset.ignitions.map((i) => ({ ...i })),
    horizonMinutes: preset.horizonMinutes,
  };
}

/** Progress of "Prepare" (oneview/publishScenario.ts). */
export type PrepareState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "switching"; packageName: string }
  /** No stored package fits: the preset is solved in this page and stored as one (oneview/studioPackage.ts). */
  | { status: "building"; step: "terrain" | "simulating" | "publishing" }
  | { status: "sending" }
  | {
      status: "done";
      fireId: string;
      incidentId: string;
      incidentName: string;
      /** Board region id the drill runs on ("berkeley-hills-tilden@15km"). */
      regionId: string;
      /** Name of the stored package this Prepare switched the live drill to, else null (already active). */
      switchedTo: string | null;
      /** Ignition ids the server found outside the drill area. */
      outsideDrill: string[];
    }
  | {
      status: "failed";
      message: string;
      /** True when no stored Berkeley Hills & Tilden drill package exists: one Studio run must make it first. */
      needsStudioPackage: boolean;
    };
