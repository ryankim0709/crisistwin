/**
 * Resample a replay bundle's simulated arrival grid (`fire_simulated.arrival_grid`, see
 * docs/replay-bundle.md) onto a `LandscapeGrid`. Pure; the output is model output and must be
 * labelled simulated wherever it is drawn.
 *
 * Source grid: equirectangular, `col = floor((lon - origin_lon) * m_per_deg_lon / cell_m)`,
 * `row = floor((lat - origin_lat) * m_per_deg_lat / cell_m)`, row 0 = SOUTH, minutes after the
 * grid's own t0 (`minute_offset` shifts them onto the fire's t0); `null` = not reached.
 * Target grid: Web Mercator, row 0 = NORTH (app/src/fire/landscape.ts). Nearest cell.
 */

import { mercatorToLonLat } from "../fire/landscape";
import type { GridGeometry } from "./arrivalFromPerimeters";
import type { SimulatedArrivalGrid } from "./types";

/** Row-major on the target grid, minutes after the fire's t0; `Infinity` = not reached. */
export function simulatedArrivalOnGrid(
  grid: GridGeometry,
  source: SimulatedArrivalGrid,
): Float32Array {
  const { width, height, originX, originY, cellSizeX, cellSizeY } = grid;
  const out = new Float32Array(width * height).fill(Infinity);
  const sourceCols = new Int32Array(width);
  for (let c = 0; c < width; c++) {
    const [lon] = mercatorToLonLat(originX + c * cellSizeX, originY);
    sourceCols[c] = Math.floor(((lon - source.origin_lon) * source.m_per_deg_lon) / source.cell_m);
  }
  for (let r = 0; r < height; r++) {
    const [, lat] = mercatorToLonLat(originX, originY + r * cellSizeY);
    const sourceRow = Math.floor(((lat - source.origin_lat) * source.m_per_deg_lat) / source.cell_m);
    if (sourceRow < 0 || sourceRow >= source.nrows) continue;
    const base = sourceRow * source.ncols;
    for (let c = 0; c < width; c++) {
      const sc = sourceCols[c];
      if (sc < 0 || sc >= source.ncols) continue;
      const value = source.minutes[base + sc];
      if (value !== null) out[r * width + c] = value + source.minute_offset;
    }
  }
  return out;
}
