/**
 * Shared contracts for Simulation Studio (/simulation). Every studio module imports its
 * shared shapes from here; change this file only together with all of its callers and
 * docs/adr/0011-simulation-studio.md.
 *
 * Units: WGS84 decimal degrees; elapsed simulation minutes from scenario T+0; open
 * 20-foot wind in mph; meteorological wind bearing (the direction wind blows FROM).
 */

import type { AirBase } from "./aircraft";
import type { ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LandscapeGrid, MercatorBox } from "../fire/landscape";
import type { ScenarioWindRecord } from "../fire/scenarioWeather";
import type { GeoPoint } from "../fire/spread";
import { HORIZON_PRESET_HOURS, frameStepMinutes } from "../fire/horizon";
import type {
  FireSettings,
  IgnitionProblem,
  ScheduledFireInput,
  ScheduledFireRun,
} from "../fire/scheduledTypes";
import type { CrewArrival, FirefightingResult, FirefightingSettings } from "./firefighting";
import type { CrewDispatch, IncidentDispatch } from "./crewDispatch";
import type { EvacuationInputs } from "./evacuation";
import type { EvacuationOptimization } from "./evacuationOptimizer";

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
  /** Crews building control line (studio/firefighting.ts). Absent means none. */
  firefighting?: FirefightingSettings;
  /**
   * Weather the wind in `settings` came from (observed, forecast or derived), with station and
   * distance. Absent means the wind is the user's assumption. Dropped when the wind is edited.
   */
  weather?: ScenarioWindRecord;
}

/** Configurable cap on enabled ignitions, bounding solve cost and map clutter. */
export const MAX_ENABLED_IGNITIONS = 5;
/**
 * One-click horizons, minutes (3 h to 3 days, fire/horizon.ts). Any whole number of minutes
 * from `MIN_HORIZON_MINUTES` (1 h) to `MAX_HORIZON_MINUTES` (7 days) is valid.
 */
export const STUDIO_HORIZON_CHOICES = HORIZON_PRESET_HOURS.map((hours) => hours * 60);
/**
 * Regular playback frames on short runs, in addition to T+0, every ignition minute and the
 * horizon. Longer runs space them further apart (`studioDisplayStepMinutes`).
 */
export const DISPLAY_STEP_MINUTES = 5;

/** Spacing of the regular frames for a horizon: 5 min up to 20 h, 10 min to 40 h, 30 min at 72 h. */
export function studioDisplayStepMinutes(horizonMinutes: number): number {
  return frameStepMinutes(horizonMinutes, DISPLAY_STEP_MINUTES);
}
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
  "editing" | "loading-landscape" | "computing" | "ready" | "failed" | "canceled";

export interface StudioRunResult {
  requestId: number;
  /** Deep-frozen copy of the scenario this run computed. */
  scenario: StudioScenario;
  run: ScheduledFireRun;
  /** Frame times, identical to `run.frames.map(f => f.elapsedMinutes)`. */
  frameMinutes: number[];
  landscapeKey: string;
  landscapeBox: MercatorBox;
  /**
   * Prebuilt region board selected when the run started (`fire/regions.ts` id), or null.
   * The run was solved on that board when its enabled fires were all on it; otherwise on a
   * box downloaded for the fires, and `landscapeKey` is that box's key.
   */
  boardId: string | null;
  /** The grid the run was solved on (shared with the landscape cache, not a copy). */
  landscape: LandscapeGrid;
  /** Sources for display: LANDFIRE fuel/canopy and terrain attribution strings. */
  attribution: LandscapeGrid["attribution"];
  elevationComplete: boolean;
  /**
   * With firefighting enabled: the plans tried and the best plan's run. `run` stays the
   * fire with no firefighting, so the two can be compared.
   */
  firefighting: FirefightingResult | null;
  /** Trips of the resources sent from fire stations for this run, or null. */
  crewDispatch: CrewDispatch | null;
  /** Why resources were not sent from stations when that was asked for, or null. */
  crewDispatchNote: string | null;
}

export interface StudioRunState {
  phase: RunPhase;
  requestId: number;
  /** Latest successful result, possibly for an older scenario (see `stale`). */
  result: StudioRunResult | null;
  /** True when the scenario has been edited since `result` was computed. */
  stale: boolean;
  error: { message: string; problems: IgnitionProblem[] } | null;
  /** Firefighting plans solved so far while computing, or null. */
  progress: { done: number; total: number } | null;
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
  /** When enabled, the worker also plans and solves firefighting after the free run. */
  firefighting: FirefightingSettings | null;
  /** When each resource starts work, from station dispatch; null uses the response time. */
  crewArrivals: CrewArrival[] | null;
  /** Helitack and air attack bases near the fire (null without the local bases file). */
  airBases: AirBase[] | null;
  /**
   * One incident per ignition (studio/incidents.ts): report minute and the aircraft sent to it.
   * Null or absent: one incident, the first fire, with the counts in `firefighting.resources`.
   */
  incidents?: IncidentDispatch[] | null;
};

export type SolverResponse =
  | {
      type: "result";
      requestId: number;
      run: ScheduledFireRun;
      firefighting: FirefightingResult | null;
    }
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "error"; requestId: number; message: string; problems: IgnitionProblem[] };

// ---------------------------------------------------------------------------------------
// Worker protocol (`evacuationOptimizer.worker.ts`). One optimisation per message. The
// optimiser is synchronous, so the client terminates and respawns the worker to cancel.
// ---------------------------------------------------------------------------------------

export type OptimizerRequest = {
  type: "optimize";
  requestId: number;
  /** Structured-cloned: Set, Float64Array and plain objects survive. */
  inputs: EvacuationInputs;
  maxEvaluations?: number;
};

export type OptimizerResponse =
  | { type: "result"; requestId: number; result: EvacuationOptimization }
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "error"; requestId: number; message: string };

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
  /** When this changes, the camera frames the current ignitions (a random scenario moved the board). */
  recenterKey?: string | null;
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
  /** The "Random scenario" button, "Keep this area" box and seed field (the page owns them). */
  randomScenario?: ReactNode;
  /** Quick-setup controls (location, size, fire starts, generate); shown unless Custom is on. */
  quickSetup?: ReactNode;
  onCancel: () => void;
  onClear: () => void;
  onExport: () => void;
  /** Validated JSON import. Returns issues to show, empty on success. */
  onImport: (json: string) => ScenarioIssue[];
  onLoadDemo: () => void;
  /** Rendered under the export buttons (the "Use as live drill" action). */
  liveDrill?: ReactNode;
  /** Firefighting inputs and last result, rendered after the conditions. */
  firefighting?: ReactNode;
}

export interface PlaybackBarProps {
  /** Disabled when there is no playable result. */
  enabled: boolean;
  /** The speed menu is locked while something else drives the clock (an AI dispatcher session). */
  speedLocked?: boolean;
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
  /**
   * The scenario's clock (T+0 as UTC ms) and where to compute sunrise and sunset; when set the
   * bar shows local time with day and night. Absent: elapsed time only.
   */
  clock?: { startMs: number; latitude: number; longitude: number; note?: string };
}
