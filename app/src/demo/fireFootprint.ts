/**
 * Map geometry of the board's fires: each fire's solver footprint (fireField.ts) contoured at the
 * board minute with the solver's own marching squares (fire/spread.ts contourArrival), so the
 * map draws exactly the cells the board counts as burned by that fire. Pure: no React or map
 * library. Contours are cached per fire and whole board minute.
 *
 * Coordinates are WGS84 [lon, lat]; a fire can have several polygons (spot fires, fingers) and
 * holes (unburned islands).
 */

import type { Position } from "geojson";
import { contourArrival, type FirePerimeter } from "../fire/spread";
import type { LonLat } from "../live/types";
import { countAtMost } from "./fireField";
import { activeFires, thinRing, type Board, type Fire, type FireField, type FireSource, type FireStatus } from "./model";

/** Properties of each footprint polygon. */
export interface FireFeatureProperties {
  id: string;
  status: FireStatus;
  source: FireSource;
}

const scratchByField = new WeakMap<FireField, Float64Array>();
const contourCache = new WeakMap<FireField, Map<string, { minute: number; polygons: FirePerimeter[] }>>();

/** The fire's footprint polygons at the board's whole minute ([] before it has burned a cell or when it is not a solver source). */
export function firePolygons(board: Board, fire: Fire): FirePerimeter[] {
  const field = board.solver.field;
  const s = field?.sourceIndex.get(fire.id);
  if (!field || s === undefined) return [];
  const minute = Math.floor(board.minute);
  let cache = contourCache.get(field);
  if (!cache) {
    cache = new Map();
    contourCache.set(field, cache);
  }
  const hit = cache.get(fire.id);
  if (hit && hit.minute === minute) return hit.polygons;

  const grid = board.env.landscape;
  const cells = field.cellsBySource[s];
  const n = countAtMost(field.arrivalBySource[s], minute);
  let polygons: FirePerimeter[] = [];
  if (n > 0) {
    let scratch = scratchByField.get(field);
    if (!scratch) {
      scratch = new Float64Array(grid.width * grid.height).fill(Number.POSITIVE_INFINITY);
      scratchByField.set(field, scratch);
    }
    let minX = grid.width, maxX = -1, minY = grid.height, maxY = -1;
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      const x = c % grid.width;
      const y = (c - x) / grid.width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      scratch[c] = field.arrivalMinutes[c];
    }
    polygons = contourArrival(grid, scratch, minute, { minX, maxX, minY, maxY });
    for (let i = 0; i < n; i++) scratch[cells[i]] = Number.POSITIVE_INFINITY;
  }
  cache.set(fire.id, { minute, polygons });
  return polygons;
}

/**
 * Every fire on the board (burning, contained, out) as footprint polygons at board.minute, one
 * feature per polygon. For map layers (demo/boardMapLayers.ts on /live, DemoMap.tsx).
 */
export function boardFireFeatures(board: Board): GeoJSON.FeatureCollection<GeoJSON.Polygon, FireFeatureProperties> {
  const features: GeoJSON.Feature<GeoJSON.Polygon, FireFeatureProperties>[] = [];
  for (const fire of board.fires) {
    for (const polygon of firePolygons(board, fire)) {
      features.push({
        type: "Feature",
        geometry: polygon.geometry,
        properties: { id: fire.id, status: fire.status, source: fire.source },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Outer rings of one fire's footprint, largest first. */
export function fireOuterRings(board: Board, fire: Fire): LonLat[][] {
  return firePolygons(board, fire)
    .map((p) => p.geometry.coordinates[0] as Position[])
    .sort((a, b) => b.length - a.length)
    .map((ring) => ring.map((q) => [q[0], q[1]] as LonLat));
}

/**
 * Closed outer rings of the fires that are not out, for the routing endpoints (their contract:
 * at most `maxRings` rings of 4..200 points). Burning fires first, each fire's largest polygons
 * first; each ring thinned to at most `maxPoints` vertices.
 */
export function fireRingsForRouting(board: Board, maxPoints = 48, maxRings = 60): LonLat[][] {
  const fires = activeFires(board).sort((a, b) => (a.status === b.status ? b.areaHa - a.areaHa : a.status === "burning" ? -1 : 1));
  const rings: LonLat[][] = [];
  for (const fire of fires) {
    for (const ring of fireOuterRings(board, fire)) {
      if (rings.length >= maxRings) return rings;
      const open = thinRing(ring, maxPoints);
      if (open.length < 3) continue;
      rings.push([...open, open[0]]);
    }
  }
  return rings;
}
