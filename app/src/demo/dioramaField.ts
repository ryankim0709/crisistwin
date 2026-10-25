/**
 * Arrival field for the /demo 3D diorama: the fire solver's own arrival field (fireField.ts, the
 * board's FireField), in board minutes, on the cells of the drill's LANDFIRE landscape. The
 * diorama draws it as the scene's arrival field (fire/diorama/types.ts DioramaRun): the scene's
 * setTime(board minute) shows only cells with arrival at or before that minute, so the solver's
 * lookahead stays hidden until the clock reaches it; cells flame for the scene's burn window
 * after arrival, then stay charred. Burned ground of fires that left the board stays in the
 * field, so their scars stay on the 3D board until the board is restarted.
 *
 * Pure: no React, three.js or network.
 */

import type { DioramaRun } from "../fire/diorama/types";
import type { LandscapeGrid } from "../fire/landscape";
import { studioDisplayStepMinutes } from "../studio/contracts";
import type { Board } from "./model";

/** The fire scene's minimum burn window is set from the arrival spacing; the field has no frame step, so one minute. */
const FIELD_STEP_MINUTES = 1;

export interface ArrivalField {
  readonly grid: LandscapeGrid;
  /** Board minute each cell burns in the solver, row-major like the grid; Infinity = not within the lookahead. */
  readonly arrival: Float32Array;
  /** Last minute the field covers (the solve's horizon). */
  readonly horizonMinutes: number;
  /** Match Studio's flame display window for native runs. */
  readonly stepMinutes?: number;
}

/** The board's current solver field as an arrival field, or null before the first solve. */
export function arrivalFieldOf(board: Board): ArrivalField | null {
  const field = board.solver.field;
  return field ? {
    grid: board.env.landscape,
    arrival: field.arrivalMinutes,
    horizonMinutes: field.horizonMinutes,
    stepMinutes: board.conditions?.settings ? studioDisplayStepMinutes(board.conditions.horizonMinutes) : FIELD_STEP_MINUTES,
  } : null;
}

/** The field as the scene's run; the scene's time (board minute) decides what shows as burned. */
export function dioramaRun(field: ArrivalField): DioramaRun {
  return {
    arrivalMinutes: field.arrival,
    scenario: { horizonMinutes: field.horizonMinutes, stepMinutes: field.stepMinutes ?? FIELD_STEP_MINUTES },
  };
}
