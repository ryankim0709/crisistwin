/**
 * Contract for the scheduled multi-ignition solver. `simulateScheduledFireSpread` in
 * `spread.ts` implements it; `simulateFireSpread` stays the single-origin entry point and
 * wraps it. See docs/adr/0011-simulation-studio.md.
 *
 * Times are elapsed simulation-clock minutes from T+0 of the scenario, not from any one
 * ignition. Coordinates are WGS84 decimal degrees. Areas are ground square metres.
 */

import type {
  ArrivalBreakdown,
  CellBehaviour,
  CrownFireBreakdown,
  CrownFireStatus,
  FirePerimeter,
  FireRun,
  FireScenario,
  GeoPoint,
  IgnitionConditions,
  MidflameWindSummary,
  SpottingOptions,
  StructureSpreadOptions,
} from "./spread";
import type { StochasticRunSummary } from "./stochastic";

/** Everything a run needs besides where and when fire starts. */
export type FireSettings = Omit<FireScenario, "origin">;

/** One point fire source. Only enabled studio ignitions are passed to the solver. */
export interface IgnitionSource {
  /** Stable identifier, echoed back on results; opaque to the solver. */
  id: string;
  location: GeoPoint;
  /** Integer elapsed minute at which this source may first spread fire. 0 <= x < horizon. */
  startMinute: number;
}

export interface ScheduledFireInput {
  settings: FireSettings;
  /** At least one. Order is part of the input: it breaks exact time ties deterministically. */
  sources: IgnitionSource[];
  /**
   * Elapsed minutes at which to report a frame, ascending, unique, each within
   * [0, settings.horizonMinutes]. The solver contours exactly these thresholds and nothing
   * else; `settings.stepMinutes` is ignored by the scheduled entry point.
   */
  frameMinutes: number[];
}

/**
 * What happened at one ignition point.
 *
 * - "ignited": the cell had not been reached when the source's start minute came, so fire
 *   originated there at `startMinute`.
 * - "reached-before-start": an earlier fire reached the cell first. The source contributes
 *   nothing; the cell is not reset or reburned. `reachedMinute < startMinute`.
 * - "not-reached-within-horizon" is impossible for a valid source and is not modelled.
 *
 * A source whose start minute exactly equals an earlier fire's arrival is "ignited" — at the
 * same time, the result is identical either way, and "ignited" is what the user scheduled.
 */
export type IgnitionOutcome =
  | { status: "ignited"; ignitedMinute: number }
  | {
      status: "reached-before-start";
      reachedMinute: number;
      /** The source whose fire got there first ("" for burned ground of a resumed run, spread.ts ResumeFrom). */
      reachedBySourceId: string;
    };

export interface IgnitionResult {
  sourceId: string;
  outcome: IgnitionOutcome;
  /** Fuel, slope and spread at the ignition cell, as the single-origin run reports them. */
  conditions: IgnitionConditions;
}

export interface ScheduledFireFrame {
  elapsedMinutes: number;
  /** Combined footprint: every cell with arrival <= elapsedMinutes, contoured once. */
  perimeters: FirePerimeter[];
  /** Cells reached by this time, each counted once however many fires reached it. */
  reachedAreaSquareMeters: number;
  /**
   * The same area split by the source whose fire reached each cell first. Sums to
   * `reachedAreaSquareMeters`. Keys are source ids; sources with no area are present as 0.
   */
  reachedAreaBySourceSquareMeters: Record<string, number>;
  /** Sources whose outcome is "ignited" and whose ignitedMinute <= elapsedMinutes. */
  ignitedSourceIds: string[];
}

/**
 * Landscape-wide metadata shares `FireRun`'s fields and meanings; those fields are the run
 * totals at the horizon over the combined footprint.
 */
export interface ScheduledFireRun {
  model: FireRun["model"];
  input: ScheduledFireInput;
  frames: ScheduledFireFrame[];
  /** One per input source, same order. */
  ignitions: IgnitionResult[];
  burnableFraction: number;
  developedFraction: number;
  fireCarryingFraction: number;
  appliedOptions: { spotting: SpottingOptions; structureSpread: StructureSpreadOptions };
  arrivalBreakdown: ArrivalBreakdown;
  crownFire: CrownFireStatus;
  crownFireBreakdown: CrownFireBreakdown;
  midflameWind: MidflameWindSummary;
  /** Present only on a stochastic run; same meaning as `FireRun.stochastic`. */
  stochastic?: StochasticRunSummary;
  /** True when fire reached the edge of the modelled area, so the footprint is clipped. */
  reachedEdge: boolean;
  /** Earliest minute fire reached the grid edge, or null. Frames at or after it are clipped. */
  reachedEdgeMinute: number | null;
  cellSizeMeters: number;
  computeMilliseconds: number;
  /**
   * Combined fire arrival per landscape cell, elapsed minutes from scenario T+0, row-major
   * like `LandscapeGrid.fuelCodes`; `Infinity` where no fire arrives. Same meaning as
   * `FireRun.arrivalMinutes`, for renderers such as the studio's 3D diorama.
   */
  arrivalMinutes: Float32Array;
  /**
   * Index into `input.sources` of the fire that reached each cell first, -1 where none did
   * (same layout as `arrivalMinutes`). Lets callers isolate one fire's footprint.
   */
  sourceIndexByCell: Int8Array;
  /**
   * The solver's per-cell behaviour, only when `reportCellBehaviour` was asked for
   * (`ScheduledSolveExtensions` in spread.ts).
   */
  cellBehaviour?: CellBehaviour;
}

export type IgnitionProblemReason = "outside-landscape" | "non-burnable";

export interface IgnitionProblem {
  sourceId: string;
  reason: IgnitionProblemReason;
  /** Human-readable, safe to show verbatim. */
  message: string;
  /** FBFM40 code at the point, when it is on the grid. */
  fuelCode?: number;
}

/**
 * Thrown by `simulateScheduledFireSpread` when one or more sources cannot ignite. Lists
 * every bad source, not just the first, so the UI can mark each marker.
 */
export class InvalidIgnitionsError extends Error {
  constructor(readonly problems: IgnitionProblem[]) {
    super(problems.map((problem) => problem.message).join(" "));
    this.name = "InvalidIgnitionsError";
  }
}
