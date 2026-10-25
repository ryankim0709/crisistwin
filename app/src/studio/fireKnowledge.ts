/**
 * The fire as the evacuation policy may know it: only fires that have been reported, each with
 * its predicted spread from the run's arrival field. A fire is reported at its ignition plus the
 * seeded call-in and processing delay of response/report.ts (`ignitionReportDelayMinutes`, the
 * same per-fire delay the Studio's firefighting and the Dispatch agent use). Before that the
 * policy cannot order anyone because of it, and its cells are invisible to the policy.
 *
 * Restriction: the "known" arrival keeps a cell's arrival only when the run's first fire there
 * (`sourceIndexByCell`) has been reported. Where an unreported fire got to a cell first, the
 * reported fire's own later arrival there is not in the run, so the cell counts as not reached
 * by known fire (an under-estimate near where fires meet). Residents' own cues and the engine's
 * "caught" counts always use the full field: people see the real fire.
 */

import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";
import type { ScheduledFireRun } from "../fire/scheduledTypes";
import type { DispatchArea, LonLat } from "../dispatch/area";
import { arrivalAt, computeExposure, type FireExposure } from "../dispatch/fireExposure";
import { ignitionReportDelayMinutes, type FirefightingSettings } from "./firefighting";

export interface FireKnowledge {
  grid: LandscapeGrid;
  /** The run's combined arrival field, minutes from T+0 (Infinity: not reached). */
  arrivalMinutes: Float32Array;
  /** Index of the source that reached each cell first, -1 none (the run's). */
  sourceIndexByCell: Int8Array;
  /** Per source index, the minute it is reported (Infinity: it never ignites). */
  reportMinutes: readonly number[];
}

/** The reported fires and their predicted spread, as of one minute. */
export interface KnownFire {
  /** Source indices reported by then, ascending. */
  reported: number[];
  /** Arrival field restricted to cells first reached by a reported fire. */
  arrivalMinutes: Float32Array;
  /** The dispatch-area exposure of that restricted field. */
  exposure: FireExposure;
  /** Cells the known fire reaches, by arrival (earliest first), with Web Mercator x, y. */
  cells: { arrival: Float64Array; x: Float64Array; y: Float64Array };
}

/** Per source of a run, the minute it is reported (ignition + report delay); Infinity if it never ignites. */
export function fireReportMinutes(
  run: ScheduledFireRun,
  grid: LandscapeGrid,
  settings: FirefightingSettings,
): number[] {
  return run.input.sources.map((source, index) => {
    const outcome = run.ignitions[index]?.outcome;
    if (!outcome || outcome.status !== "ignited") return Infinity;
    // Same call as the Studio's firefighting (studio/firefighting.ts), seeded on the source.
    return (
      source.startMinute +
      ignitionReportDelayMinutes(grid, source.location, source.startMinute, settings)
    );
  });
}

const cache = new WeakMap<FireKnowledge, Map<string, KnownFire>>();

/** The known fire at `minute` for `area`, or null while no fire has been reported. Cached. */
export function knownFireAt(
  knowledge: FireKnowledge,
  area: DispatchArea,
  minute: number,
): KnownFire | null {
  const reported: number[] = [];
  knowledge.reportMinutes.forEach((at, index) => {
    if (at <= minute) reported.push(index);
  });
  if (reported.length === 0) return null;
  const key = `${area.id}|${reported.join(",")}`;
  let byKey = cache.get(knowledge);
  if (!byKey) {
    byKey = new Map();
    cache.set(knowledge, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const { grid, arrivalMinutes, sourceIndexByCell } = knowledge;
  const allReported = reported.length === knowledge.reportMinutes.length;
  const keep = new Set(reported);
  const known = allReported
    ? arrivalMinutes
    : Float32Array.from(arrivalMinutes, (value, cell) =>
        keep.has(sourceIndexByCell[cell]) ? value : Number.POSITIVE_INFINITY,
      );
  const order: number[] = [];
  for (let cell = 0; cell < known.length; cell += 1) if (Number.isFinite(known[cell])) order.push(cell);
  order.sort((a, b) => known[a] - known[b]);
  const cells = {
    arrival: new Float64Array(order.length),
    x: new Float64Array(order.length),
    y: new Float64Array(order.length),
  };
  order.forEach((cell, i) => {
    const col = cell % grid.width;
    const row = (cell - col) / grid.width;
    cells.arrival[i] = known[cell];
    cells.x[i] = grid.originX + col * grid.cellSizeX;
    cells.y[i] = grid.originY + row * grid.cellSizeY;
  });
  const result: KnownFire = {
    reported,
    arrivalMinutes: known,
    exposure: computeExposure(area, grid, known),
    cells,
  };
  byKey.set(key, result);
  return result;
}

/** Known arrival at a point, minutes (Infinity: not reached, or off the grid). */
export function knownArrivalAt(knowledge: FireKnowledge, known: KnownFire, point: LonLat): number {
  return arrivalAt(knowledge.grid, known.arrivalMinutes, point);
}

/**
 * The known burning cell nearest `point` at `minute` (arrival <= minute): its ground distance
 * (metres) and compass bearing from `point` (degrees from north); null when none burns yet.
 */
export function nearestKnownFire(
  known: KnownFire,
  point: LonLat,
  minute: number,
): { meters: number; bearingDegrees: number } | null {
  const [px, py] = lonLatToMercator(point[0], point[1]);
  const scale = Math.cos((point[1] * Math.PI) / 180);
  const { arrival, x, y } = known.cells;
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < arrival.length && arrival[i] <= minute; i += 1) {
    const d2 = (x[i] - px) ** 2 + (y[i] - py) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  if (best < 0) return null;
  return {
    meters: Math.sqrt(bestD2) * scale,
    bearingDegrees: mercatorBearing(px, py, x[best], y[best]),
  };
}

/** Compass bearing (degrees from north) from one Web Mercator point to another. */
export function mercatorBearing(ax: number, ay: number, bx: number, by: number): number {
  return ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two compass bearings, 0..180 degrees. */
export function bearingDifference(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
