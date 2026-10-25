/**
 * When the modelled fire reaches points of the dispatch area, read from the run's per-cell
 * arrival field (`FireRun.arrivalMinutes`, minutes since ignition, Infinity where fire never
 * arrives). A point takes the arrival of the landscape cell it falls in, so resolution is the
 * landscape cell (30 m on stored boards); points off the board are never reached.
 */

import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";
import { cellAt } from "../fire/spread";
import type { DispatchArea, LonLat } from "./area";

/**
 * Near fire cue (population/householdBehavior.ts): a household sees flames or embers close to
 * its house once the modelled fire is within this many ground metres. ASSUMPTION (no published
 * distance found): 500 m, a few blocks; NIST TN 2103 (Gatlinburg 2016) found that seeing flames or
 * embers, not smoke, raised residents' risk perception, without a distance. Sensitivity 250 and
 * 1,000 m in docs/people-data.md.
 */
export const FIRE_CUE_NEAR_METERS = 500;
/**
 * The near-cue search pools the arrival grid into blocks of about this many ground metres (min
 * arrival per block), so the cue is resolved to about one block. Numerical, not behavioural.
 */
export const NEAR_CUE_BLOCK_METERS = 120;

export interface FireExposure {
  /** Modelled arrival minute per graph node; Infinity when not reached. */
  nodeArrival: Float64Array;
  /** Earliest arrival over each edge's vertices. */
  edgeArrival: Float64Array;
  /** Arrival at each home. */
  homeArrival: Float64Array;
  /** First fire contact in each zone: its first home, hull vertex, centroid or loading node. */
  zoneContact: Float64Array;
  /** Fire reaches the zone's core (loading node or centroid): the zone is overrun. */
  zoneCore: Float64Array;
  /**
   * Per home, the first minute the fire is within FIRE_CUE_NEAR_METERS of it (the near fire
   * cue); Infinity when never. Resolved to NEAR_CUE_BLOCK_METERS. Always set by
   * `computeExposure`; absent only on hand-built exposures (then there is no near cue).
   */
  homeNear?: Float64Array;
}

export function arrivalAt(
  grid: LandscapeGrid,
  arrivalMinutes: Float32Array,
  [longitude, latitude]: LonLat,
): number {
  const cell = cellAt(grid, { latitude, longitude });
  return cell < 0 ? Infinity : arrivalMinutes[cell];
}

export function computeExposure(
  area: DispatchArea,
  grid: LandscapeGrid,
  arrivalMinutes: Float32Array,
): FireExposure {
  const at = (point: LonLat) => arrivalAt(grid, arrivalMinutes, point);
  const nodeArrival = Float64Array.from(area.nodes, at);

  // Every vertex of the polyline, so a long curving road is cut where the fire crosses it.
  const edgeArrival = Float64Array.from(area.edges, (edge) => {
    let first = Math.min(nodeArrival[edge.from], nodeArrival[edge.to]);
    for (let i = 1; i < edge.coords.length - 1; i += 1) first = Math.min(first, at(edge.coords[i]));
    return first;
  });

  const homeArrival = Float64Array.from(area.homes, (home) => at(home.position));

  const zoneContact = new Float64Array(area.zones.length);
  const zoneCore = new Float64Array(area.zones.length);
  area.zones.forEach((zone, i) => {
    const core = Math.min(nodeArrival[zone.node], at(zone.centroid));
    let contact = core;
    for (const vertex of zone.polygon) contact = Math.min(contact, at(vertex));
    for (let h = zone.firstHome; h < zone.firstHome + zone.homes; h += 1) {
      contact = Math.min(contact, homeArrival[h]);
    }
    zoneContact[i] = contact;
    zoneCore[i] = core;
  });

  const homeNear = nearArrival(area, grid, arrivalMinutes, FIRE_CUE_NEAR_METERS);
  return { nodeArrival, edgeArrival, homeArrival, zoneContact, zoneCore, homeNear };
}

/**
 * Per home, the earliest arrival within `meters` of it: the arrival grid min-pooled into blocks
 * of about NEAR_CUE_BLOCK_METERS, then the blocks whose centre is within `meters` (plus half a
 * block diagonal) of the home. Homes off the grid get Infinity.
 */
export function nearArrival(
  area: DispatchArea,
  grid: LandscapeGrid,
  arrivalMinutes: Float32Array,
  meters: number,
): Float64Array {
  const block = Math.max(1, Math.round(NEAR_CUE_BLOCK_METERS / grid.groundCellSizeMeters));
  const bw = Math.ceil(grid.width / block);
  const bh = Math.ceil(grid.height / block);
  const pooled = new Float64Array(bw * bh).fill(Infinity);
  for (let row = 0; row < grid.height; row += 1) {
    const br = Math.floor(row / block) * bw;
    for (let col = 0; col < grid.width; col += 1) {
      const minute = arrivalMinutes[row * grid.width + col];
      const b = br + Math.floor(col / block);
      if (minute < pooled[b]) pooled[b] = minute;
    }
  }
  const blockMeters = block * grid.groundCellSizeMeters;
  const reach = meters + (blockMeters * Math.SQRT2) / 2;
  const radius = Math.ceil(reach / blockMeters);
  return Float64Array.from(area.homes, (home) => {
    const [x, y] = lonLatToMercator(home.position[0], home.position[1]);
    const col = (x - grid.originX) / grid.cellSizeX;
    const row = (y - grid.originY) / grid.cellSizeY;
    if (col < -0.5 || row < -0.5 || col > grid.width - 0.5 || row > grid.height - 0.5) return Infinity;
    // Block coordinates of the home, fractional; a block's centre is at index + 0.5.
    const bc = (col + 0.5) / block;
    const brow = (row + 0.5) / block;
    let best = Infinity;
    for (let r = Math.floor(brow) - radius; r <= Math.floor(brow) + radius; r += 1) {
      if (r < 0 || r >= bh) continue;
      for (let c = Math.floor(bc) - radius; c <= Math.floor(bc) + radius; c += 1) {
        if (c < 0 || c >= bw) continue;
        const d = Math.hypot(c + 0.5 - bc, r + 0.5 - brow) * blockMeters;
        if (d <= reach && pooled[r * bw + c] < best) best = pooled[r * bw + c];
      }
    }
    return best;
  });
}
