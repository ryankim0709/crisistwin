/**
 * What part of a board the routing area (roads, homes, evacuation zones, unit staging) covers,
 * and what a run does outside it: fires that start outside the area, and developed ground
 * (FBFM40 91) the fire reaches outside it, whose homes the evacuation cannot see. Pure; the UI is
 * studio/AreaCoverageNotice.tsx. Units: WGS84 [lon, lat]; hectares; simulation minutes.
 */

import type { Bbox, LonLat } from "../dispatch/area";
import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";
import { DEVELOPED_FUEL_CODE } from "../fire/spread";
import { gridExtent } from "../fire/useBoardStreets";

export interface AreaCoverage {
  /** The area's place name from the road service, e.g. "Lafayette area". */
  areaName: string;
  /** Where the area sits on the board, e.g. "north-east"; null when it covers the whole board. */
  part: string | null;
  /** Names of enabled fires that start outside the area. */
  firesOutside: string[];
  /** Developed ground the fire reaches by the horizon outside the area, hectares; null before a run. */
  developedOutsideHectares: number | null;
}

/** Share of the board's width (or height) the area may miss and still count as the whole board. */
const WHOLE_BOARD_SLACK = 0.05;
/** Offset of the area's centre, as a share of the board's size, that names a side. */
const SIDE_OFFSET = 0.08;

export function boardPart(board: Bbox, area: Bbox): string | null {
  const width = board[2] - board[0];
  const height = board[3] - board[1];
  const coversX = area[0] <= board[0] + width * WHOLE_BOARD_SLACK && area[2] >= board[2] - width * WHOLE_BOARD_SLACK;
  const coversY = area[1] <= board[1] + height * WHOLE_BOARD_SLACK && area[3] >= board[3] - height * WHOLE_BOARD_SLACK;
  if (coversX && coversY) return null;
  const dx = ((area[0] + area[2]) / 2 - (board[0] + board[2]) / 2) / width;
  const dy = ((area[1] + area[3]) / 2 - (board[1] + board[3]) / 2) / height;
  const ns = !coversY && Math.abs(dy) >= SIDE_OFFSET ? (dy > 0 ? "north" : "south") : "";
  const ew = !coversX && Math.abs(dx) >= SIDE_OFFSET ? (dx > 0 ? "east" : "west") : "";
  return ns && ew ? `${ns}-${ew}` : ns || ew || "centre";
}

const inside = (box: Bbox, [lon, lat]: LonLat) =>
  lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];

/** Hectares of developed cells the fire reaches by `horizonMinutes` outside `area`. */
export function developedReachedOutside(
  grid: LandscapeGrid,
  arrivalMinutes: Float32Array,
  horizonMinutes: number,
  area: Bbox,
): number {
  const [x0, y0] = lonLatToMercator(area[0], area[1]);
  const [x1, y1] = lonLatToMercator(area[2], area[3]);
  const [minX, maxX, minY, maxY] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  let cells = 0;
  for (let i = 0; i < arrivalMinutes.length; i += 1) {
    if (!(arrivalMinutes[i] <= horizonMinutes) || grid.fuelCodes[i] !== DEVELOPED_FUEL_CODE) continue;
    const c = i % grid.width;
    const r = (i - c) / grid.width;
    const x = grid.originX + c * grid.cellSizeX;
    const y = grid.originY + r * grid.cellSizeY;
    if (x < minX || x > maxX || y < minY || y > maxY) cells += 1;
  }
  return (cells * grid.groundCellSizeMeters * grid.groundCellSizeMeters) / 10_000;
}

export function areaCoverage(input: {
  grid: LandscapeGrid;
  area: { name: string; bbox: Bbox };
  fires: readonly { name: string; at: LonLat }[];
  run: { arrivalMinutes: Float32Array; horizonMinutes: number } | null;
}): AreaCoverage {
  const { grid, area, fires, run } = input;
  return {
    areaName: area.name,
    part: boardPart(gridExtent(grid), area.bbox),
    firesOutside: fires.filter((fire) => !inside(area.bbox, fire.at)).map((fire) => fire.name),
    developedOutsideHectares: run
      ? developedReachedOutside(grid, run.arrivalMinutes, run.horizonMinutes, area.bbox)
      : null,
  };
}
