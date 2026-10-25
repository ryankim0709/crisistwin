/**
 * Board size in one place: the square's half-width (`radiusMeters`) and the cell size it
 * implies. Pages and the shared world choose the radius; everything else derives from it.
 */

import { landscapeCellMetersFor } from "./landscape";

/** Smallest and largest board half-width, ground metres (the shared world allows 1 to 60 km). */
export const MIN_BOARD_RADIUS_METERS = 1_000;
export const MAX_BOARD_RADIUS_METERS = 60_000;
/** The radius boards use when nothing else says (the /live command board). */
export const DEFAULT_BOARD_RADIUS_METERS = 15_000;

export function clampBoardRadiusMeters(radiusMeters: number): number {
  if (!Number.isFinite(radiusMeters)) return DEFAULT_BOARD_RADIUS_METERS;
  return Math.min(MAX_BOARD_RADIUS_METERS, Math.max(MIN_BOARD_RADIUS_METERS, radiusMeters));
}

/**
 * Cell size (ground metres) for a board of this half-width: LANDFIRE's native 30 m while
 * the grid fits the 900-cell side cap, otherwise the next multiple of 30 m that does (150 m
 * at 60 km). Pass the result as `cellMeters` to `loadLandscape`.
 */
export function boardCellMetersFor(radiusMeters: number): number {
  return landscapeCellMetersFor(clampBoardRadiusMeters(radiusMeters));
}
