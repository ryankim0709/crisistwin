/**
 * Shared contracts for Simulation Studio (/simulation). Every studio module imports its
 * shared shapes from here; change this file only together with all of its callers and
 * docs/adr/0011-simulation-studio.md.
 *
 * Units: WGS84 decimal degrees; elapsed simulation minutes from scenario T+0; open
 * 20-foot wind in mph; meteorological wind bearing (the direction wind blows FROM).
 */

import type { ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LandscapeGrid, MercatorBox } from "../fire/landscape";
import type { GeoPoint } from "../fire/spread";
import type {
  FireSettings,
  IgnitionProblem,
  ScheduledFireInput,
  ScheduledFireRun,
} from "../fire/scheduledTypes";

// ---------------------------------------------------------------------------------------
// Scenario (user assumptions). Persisted as JSON with `schemaVersion`.
// ---------------------------------------------------------------------------------------

export const STUDIO_SCHEMA_VERSION = 1;

export interface ScheduledIgnition {
  id: string;
  name: string;
  /** WGS84 decimal degrees. */
  location: GeoPoint;
  /** Integer elapsed simulation minutes from scenario T+0. */
  startMinute: number;
  enabled: boolean;
}

export interface StudioScenario {
  schemaVersion: typeof STUDIO_SCHEMA_VERSION;
  id: string;
  name: string;
  ignitions: ScheduledIgnition[];
  /** `stepMinutes` is ignored by the studio; display steps are `DISPLAY_STEP_MINUTES`. */
  settings: FireSettings;
}

/** Configurable cap on enabled ignitions, bounding solve cost and map clutter. */
export const MAX_ENABLED_IGNITIONS = 5;
/** Horizons offered, minutes. */
export const STUDIO_HORIZON_CHOICES = [60, 120, 180, 360] as const;
/** Regular playback frames, in addition to T+0, every ignition minute and the horizon. */
export const DISPLAY_STEP_MINUTES = 5;
/** Wind slider range, open 20-foot mph; matches the /fire page. */
export const MIN_WIND_SPEED_MPH = 0;
export const MAX_WIND_SPEED_MPH = 60;

// ---------------------------------------------------------------------------------------
// Validation. Pure; implemented in `scenario.ts`.
// ---------------------------------------------------------------------------------------

/** One problem, attached to an ignition when `ignitionId` is set, else to the scenario. */
export interface ScenarioIssue {
  ignitionId?: string;
  field?: "location" | "startMinute" | "name" | "settings" | "ignitions";
  message: string;
}

/**
 * Pre-landscape checks: schema version, finite numbers, -90..90 / -180..180, integer
 * 0 <= startMinute < horizonMinutes, 1..MAX_ENABLED_IGNITIONS enabled ignitions, unique ids,
 * wind/moisture/horizon within model limits, and the shared landscape box fitting within
 * `MAX_LANDSCAPE_SPAN_METERS` (too-far-apart points). Landscape coverage and non-burnable
 * cells are checked by the solver after the landscape loads (`IgnitionProblem`).
 */
export type ValidateScenario = (scenario: StudioScenario) => ScenarioIssue[];

// ---------------------------------------------------------------------------------------
// Shared landscape. Implemented in `bounds.ts` and `landscape.ts`.
// ---------------------------------------------------------------------------------------

/** Largest side of the shared landscape box, ground metres. Points further apart are refused. */
/** Matches the largest box /fire already loads (12 km radius). */
export const MAX_LANDSCAPE_SPAN_METERS = 24_000;

/**
 * The box a scenario needs: the bounding box of enabled ignitions grown by a spread buffer
 * that depends on the horizon, then snapped outward to a coarse grid so small edits reuse
 * the cached landscape. A cached landscape is reused whenever its box contains this one.
 */
export interface LandscapeRequirement {
  box: MercatorBox;
  /** Stable cache key derived from the snapped box. */
  key: string;
  spanMeters: number;
}

// ---------------------------------------------------------------------------------------
// Run lifecycle. Implemented in `useStudioRun.ts`.
// ---------------------------------------------------------------------------------------

export type RunPhase =
  | "editing"
  | "loading-landscape"
  | "computing"
  | "ready"
  | "failed"
  | "canceled";

export interface StudioRunResult {
  requestId: number;
  /** Deep-frozen copy of the scenario this run computed. */
  scenario: StudioScenario;
  run: ScheduledFireRun;
  /** Frame times, identical to `run.frames.map(f => f.elapsedMinutes)`. */
  frameMinutes: number[];
  landscapeKey: string;
  landscapeBox: MercatorBox;
  /** Sources for display: LANDFIRE fuel/canopy and terrain attribution strings. */
  attribution: LandscapeGrid["attribution"];
  elevationComplete: boolean;
}

export interface StudioRunState {
  phase: RunPhase;
  requestId: number;
  /** Latest successful result, possibly for an older scenario (see `stale`). */
  result: StudioRunResult | null;
  /** True when the scenario has been edited since `result` was computed. */
  stale: boolean;
  error: { message: string; problems: IgnitionProblem[] } | null;
}

// ---------------------------------------------------------------------------------------
// Worker protocol (`solver.worker.ts`). One solve per worker message; the client
// terminates and respawns the worker to cancel an obsolete solve.
// ---------------------------------------------------------------------------------------

export type SolverRequest = {
  type: "solve";
  requestId: number;
  landscape: LandscapeGrid;
  input: ScheduledFireInput;
};

export type SolverResponse =
  | { type: "result"; requestId: number; run: ScheduledFireRun }
  | { type: "error"; requestId: number; message: string; problems: IgnitionProblem[] };

// ---------------------------------------------------------------------------------------
// Component props. Page composition (SimulationStudioPage) owns all state.
// ---------------------------------------------------------------------------------------

/** "select": clicks select markers or pan. "add": a map click adds an ignition. "move": a
 * map click moves `selectedId` there. */
export type MapMode = "select" | "add" | "move";

export type IgnitionDisplayState =
  | "draft" // no current result, or the result is stale
  | "scheduled" // in the result; startMinute > current time
  | "triggered" // in the result; ignited at or before current time
  | "reached-before-start" // an earlier fire got there first (at or before current time)
  | "disabled"
  | "invalid"; // has a ScenarioIssue or IgnitionProblem

export interface StudioMapProps {
  ignitions: ScheduledIgnition[];
  /** Per ignition id. Ids missing here render as "draft". */
  ignitionStates: Record<string, IgnitionDisplayState>;
  selectedId: string | null;
  mode: MapMode;
  /** Frames up to and including the current playback time, oldest first; empty = none. */
  visibleFrames: ScheduledFireRun["frames"];
  /** Current playback minute, for the legend and labels. */
  currentMinute: number;
  horizonMinutes: number;
  windSpeedMph: number;
  windFromDegrees: number;
  /** Outline of the shared landscape grid, when one is loaded. */
  landscapeBox: MercatorBox | null;
  /** Show the footprint dimmed and labelled "Previous run" when the result is stale. */
  footprintIsStale: boolean;
  /**
   * Optional modelled-output line per ignition id (fuel, head rate), computed by the page from
   * the current, non-stale result. Shown on the marker label and tooltip. Ids missing here
   * show no line.
   */
  ignitionDetails?: Record<string, string>;
  /** Model warnings to display over the map (clipped at edge, surface-only, etc.). */
  warnings: string[];
  attribution: string[];
  onMapClick: (point: GeoPoint) => void;
  onSelectIgnition: (id: string | null) => void;
  /** Fired when a marker drag ends. */
  onMoveIgnition: (id: string, point: GeoPoint) => void;
  /** Called with the map once its studio layers exist, and with null just before it is removed. */
  onMapReady?: (map: MapLibreMap | null) => void;
  /** Extra legend group rendered after "Modelled output" and before "Source data". */
  legendExtra?: ReactNode;
  /**
   * "compact" drops the ignition-state key and locator note and starts the legend collapsed
   * behind a toggle, for pages that layer more on the map. Defaults to "full".
   */
  legendMode?: "full" | "compact";
}

export interface ConfigPanelProps {
  scenario: StudioScenario;
  issues: ScenarioIssue[];
  /** Per-ignition solver problems from the last failed run. */
  problems: IgnitionProblem[];
  selectedId: string | null;
  mode: MapMode;
  phase: RunPhase;
  stale: boolean;
  /** Text like "Saved on this device · 11:02 PM", or null before the first save. */
  draftStatus: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onModeChange: (mode: MapMode) => void;
  onSelectIgnition: (id: string | null) => void;
  /** Replace the scenario. The page decides whether the edit invalidates the result. */
  onScenarioChange: (scenario: StudioScenario) => void;
  onRun: () => void;
  onCancel: () => void;
  onClear: () => void;
  onExport: () => void;
  /** Validated JSON import. Returns issues to show, empty on success. */
  onImport: (json: string) => ScenarioIssue[];
  onLoadDemo: () => void;
}

export interface PlaybackBarProps {
  /** Disabled when there is no playable result. */
  enabled: boolean;
  frameMinutes: number[];
  frameIndex: number;
  horizonMinutes: number;
  playing: boolean;
  /** Simulation minutes advanced per wall-clock second. */
  speed: number;
  speedChoices: readonly number[];
  /** Ignition events to mark on the scrubber. */
  events: { id: string; name: string; minute: number; state: IgnitionDisplayState }[];
  metrics: {
    ignitionsTriggered: number;
    ignitionsTotal: number;
    reachedAreaSquareMeters: number;
    /** e.g. { name: "F3", minute: 45 }, or null when none remain. */
    nextIgnition: { name: string; minute: number } | null;
  };
  onPlayPause: () => void;
  onStep: (delta: -1 | 1) => void;
  onRestart: () => void;
  onSpeedChange: (speed: number) => void;
  /** Scrub to a frame index. */
  onSeek: (frameIndex: number) => void;
}
