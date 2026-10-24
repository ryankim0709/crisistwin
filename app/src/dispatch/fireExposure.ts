/**
 * When the modelled fire reaches points of the dispatch area, read from the run's per-cell
 * arrival field (`FireRun.arrivalMinutes`, minutes since ignition, Infinity where fire never
 * arrives). A point takes the arrival of the landscape cell it falls in, so resolution is the
 * landscape cell (30 m on stored boards); points off the board are never reached.
 */

import type { LandscapeGrid } from "../fire/landscape";
import { cellAt } from "../fire/spread";
import type { DispatchArea, LonLat } from "./area";

export interface FireExposure {
  /** Modelled arrival minute per graph node; Infinity when not reached. */
  nodeArrival: Float64Array;
  /** Earliest arrival over each edge's vertices. */
  edgeArrival: Float64Array;
  /** Arrival at each home. */
  homeArrival: Float64Array;
  /** First fire contact in each zone: its first home, hull vertex, centroid or loading node. */
  zoneContact: Float64Array;
  /** Fire reaches the zone's core (loading node or centroid): everyone still there is caught. */
  zoneCore: Float64Array;
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

  return { nodeArrival, edgeArrival, homeArrival, zoneContact, zoneCore };
}
