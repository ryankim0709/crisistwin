/**
 * Shared landscape box for a scenario. Pure: no network, no React.
 *
 * Mercator metres (EPSG:3857) address the grid; ground metres are Mercator metres times
 * cos(latitude). Distances the user cares about (buffers, spans) are ground metres and are
 * converted once here, using the latitude at the centre of the box.
 */

import { lonLatToMercator, mercatorToLonLat, type MercatorBox } from "../fire/landscape";
import {
  MAX_LANDSCAPE_SPAN_METERS,
  type LandscapeRequirement,
  type StudioScenario,
} from "./contracts";

// Same spread-buffer logic as `radiusFor` in fire/FireSimulatorPage.tsx (not exported there,
// and importing a page module into pure logic and the worker graph is not worth it).
const ASSUMED_FAST_SPREAD_METERS_PER_MINUTE = 40;
export const MIN_BUFFER_METERS = 3000;
export const MAX_BUFFER_METERS = 12000;
/** The box is snapped outward to this grid, in Mercator metres, so small edits reuse it. */
export const SNAP_METERS = 1000;
const RADIANS_PER_DEGREE = Math.PI / 180;

export function bufferMetersFor(horizonMinutes: number): number {
  return Math.min(
    Math.max(horizonMinutes * ASSUMED_FAST_SPREAD_METERS_PER_MINUTE, MIN_BUFFER_METERS),
    MAX_BUFFER_METERS,
  );
}

export function boxContains(outer: MercatorBox, inner: MercatorBox): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function enabledPoints(scenario: StudioScenario) {
  return scenario.ignitions.filter((ignition) => ignition.enabled).map((i) => i.location);
}

/** Ground metres per Mercator metre at the vertical centre of a Mercator box. */
function groundScale(minY: number, maxY: number): number {
  const [, latitude] = mercatorToLonLat(0, (minY + maxY) / 2);
  return Math.cos(latitude * RADIANS_PER_DEGREE);
}

/** Ground extent of the enabled ignitions' bounding box, longest side, metres. */
export function ignitionExtentMeters(scenario: StudioScenario): number {
  const mercator = enabledPoints(scenario).map((p) => lonLatToMercator(p.longitude, p.latitude));
  if (mercator.length === 0) return 0;
  const xs = mercator.map(([x]) => x);
  const ys = mercator.map(([, y]) => y);
  const scale = groundScale(Math.min(...ys), Math.max(...ys));
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * scale;
}

/**
 * Box needed by the enabled ignitions: their bounding box plus a spread buffer. The buffer
 * shrinks (never below `MIN_BUFFER_METERS`) so the box stays within
 * `MAX_LANDSCAPE_SPAN_METERS` when it can; when even the minimum does not fit, the returned
 * `spanMeters` exceeds the cap and `validateScenario` refuses the scenario.
 * Throws when no ignition is enabled; validate first.
 */
export function landscapeRequirement(scenario: StudioScenario): LandscapeRequirement {
  const points = enabledPoints(scenario);
  if (points.length === 0) throw new RangeError("No enabled ignitions to cover.");
  const mercator = points.map((p) => lonLatToMercator(p.longitude, p.latitude));
  const xs = mercator.map(([x]) => x);
  const ys = mercator.map(([, y]) => y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = groundScale(minY, maxY);
  const extentMeters =
    Math.max(Math.max(...xs) - Math.min(...xs), maxY - minY) * scale;

  // Snapping can add up to SNAP_METERS on each side; keep that slack out of the buffer.
  const roomForBuffer = (MAX_LANDSCAPE_SPAN_METERS - extentMeters - 2 * SNAP_METERS) / 2;
  const bufferGround = Math.max(
    MIN_BUFFER_METERS,
    Math.min(bufferMetersFor(scenario.settings.horizonMinutes), roomForBuffer),
  );
  const bufferMercator = bufferGround / scale;

  const box: MercatorBox = {
    minX: Math.floor((Math.min(...xs) - bufferMercator) / SNAP_METERS) * SNAP_METERS,
    minY: Math.floor((minY - bufferMercator) / SNAP_METERS) * SNAP_METERS,
    maxX: Math.ceil((Math.max(...xs) + bufferMercator) / SNAP_METERS) * SNAP_METERS,
    maxY: Math.ceil((maxY + bufferMercator) / SNAP_METERS) * SNAP_METERS,
  };
  const boxScale = groundScale(box.minY, box.maxY);
  return {
    box,
    key: [box.minX, box.minY, box.maxX, box.maxY].map((v) => v / SNAP_METERS).join("_"),
    spanMeters: Math.max(box.maxX - box.minX, box.maxY - box.minY) * boxScale,
  };
}

/**
 * Message when the ignitions are too far apart to share one landscape, else null.
 * Expects valid, finite coordinates.
 */
export function spanProblem(scenario: StudioScenario): string | null {
  if (enabledPoints(scenario).length === 0) return null;
  const requirement = landscapeRequirement(scenario);
  if (requirement.spanMeters <= MAX_LANDSCAPE_SPAN_METERS) return null;
  const extentKm = ignitionExtentMeters(scenario) / 1000;
  const maxExtentKm =
    (MAX_LANDSCAPE_SPAN_METERS - 2 * MIN_BUFFER_METERS - 2 * SNAP_METERS) / 1000;
  return (
    `The enabled fires are about ${extentKm.toFixed(1)} km apart, but one run can cover ` +
    `them only within about ${Math.floor(maxExtentKm)} km. Move them closer together or ` +
    `disable one.`
  );
}
