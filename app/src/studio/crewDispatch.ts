/**
 * Sending the Studio's firefighters from real fire stations: the fire is reported at a given
 * minute, each resource leaves an OpenStreetMap fire station after a turnout time, and drives
 * the board's road graph (dispatch/routing.ts, free-flow speeds) to the road point nearest the
 * fire. Its arrival minute is when it starts work in the firefighting model
 * (studio/firefighting.ts, studio/initialAttack.ts). See docs/adr/0023-studio-crew-dispatch.md.
 *
 * Assumptions, named below: every resource type is housed at OSM fire stations (in reality hand
 * crews and dozers often come from further away); resources go out from the nearest stations
 * first, one per station in turn, engines first; vehicles drive at the road's free-flow speed
 * and cover a station's off-graph approach at APPROACH_SPEED_KPH; closed roads are avoided;
 * crews then hike from the road point to the ignition point at HIKE_METERS_PER_MINUTE.
 */

import { groundMeters, type DispatchArea, type LonLat } from "../dispatch/area";
import { APPROACH_SPEED_KPH } from "../dispatch/engine";
import { edgeSeconds, routeTo, shortestPathTree } from "../dispatch/routing";
import type { CrewArrival, ResourceKind } from "./firefighting";

/** NFPA 1710 turnout time for fire calls: 80 s from alarm to wheels rolling. */
export const TURNOUT_MINUTES = 80 / 60;
/** Stations tried, nearest first by straight line. */
const MAX_STATIONS = 12;
/** ASSUMED walking pace with tools over rough ground, about 3 km/h. */
export const HIKE_METERS_PER_MINUTE = 50;
/** A fire farther than this from any road on the board is out of the road network's reach. */
export const MAX_ROAD_GAP_METERS = 1500;

const DISPATCH_PRIORITY: Record<ResourceKind, number> = { engine: 0, hand_crew: 1, dozer: 2 };

const KIND_LABEL: Record<ResourceKind, string> = {
  dozer: "Dozer",
  engine: "Engine",
  hand_crew: "Hand crew",
};

export interface CrewTrip {
  kind: ResourceKind;
  /** e.g. "Engine 2". */
  label: string;
  stationName: string;
  departMinute: number;
  /** Minute the vehicle stops at the fire's road point. */
  atRoadMinute: number;
  /** Minute the crew reaches the fire on foot and starts work. */
  arriveMinute: number;
  /** Station, then the road path to the fire's road point. */
  path: LonLat[];
  /** Minutes after departure at each path vertex (same length as `path`). */
  pathMinutes: number[];
}

export interface CrewDispatch {
  reportMinute: number;
  /** The fire's ignition point and the road point crews drive to. */
  fire: LonLat;
  roadPoint: LonLat;
  /** Walk from the road point to the fire, ground metres and minutes. */
  hikeMeters: number;
  hikeMinutes: number;
  trips: CrewTrip[];
}

/** Start minute per resource, for the firefighting model. */
export function arrivalsOf(dispatch: CrewDispatch): CrewArrival[] {
  return dispatch.trips.map((trip) => ({ kind: trip.kind, minute: trip.arriveMinute }));
}

/**
 * Plan every resource's trip, or explain why there is none. `blocked` marks edges closed to
 * traffic (the Studio's road closures).
 */
export function planCrewDispatch(
  area: DispatchArea,
  fire: LonLat,
  reportMinute: number,
  resources: readonly ResourceKind[],
  blocked: (edge: number) => boolean = () => false,
): { dispatch: CrewDispatch | null; note: string | null } {
  if (resources.length === 0) return { dispatch: null, note: "No resources assigned." };
  if (area.stations.length === 0) {
    return { dispatch: null, note: "No fire stations on or near this board's roads." };
  }
  let roadNode = -1;
  let gap = Infinity;
  area.nodes.forEach((node, index) => {
    const meters = groundMeters(node, fire);
    if (meters < gap) {
      gap = meters;
      roadNode = index;
    }
  });
  if (roadNode < 0 || gap > MAX_ROAD_GAP_METERS) {
    return { dispatch: null, note: "The fire is too far from the board's roads to drive to." };
  }

  const approachMinutesPerMeter = 1 / ((APPROACH_SPEED_KPH * 1000) / 60);
  const candidates = [...area.stations]
    .sort((a, b) => groundMeters(a.location, fire) - groundMeters(b.location, fire))
    .slice(0, MAX_STATIONS)
    .flatMap((station) => {
      const route = routeTo(area, shortestPathTree(area, station.node, blocked), roadNode);
      if (!route) return [];
      const path: LonLat[] = [station.location];
      const pathMinutes: number[] = [0];
      let clock = station.approachMeters * approachMinutesPerMeter;
      path.push(area.nodes[station.node]);
      pathMinutes.push(clock);
      for (const step of route.steps) {
        const edge = area.edges[step.edge];
        const line = step.forward ? edge.coords : [...edge.coords].reverse();
        const lengths = line.slice(1).map((point, i) => groundMeters(line[i], point));
        const total = lengths.reduce((a, b) => a + b, 0);
        const minutes = edgeSeconds(area, step.edge) / 60;
        lengths.forEach((length, i) => {
          clock += total > 0 ? (minutes * length) / total : minutes / lengths.length;
          path.push(line[i + 1]);
          pathMinutes.push(clock);
        });
      }
      return [{ name: station.name, path, pathMinutes, travelMinutes: clock }];
    })
    .sort((a, b) => a.travelMinutes - b.travelMinutes);
  if (candidates.length === 0) {
    return { dispatch: null, note: "No fire station can reach the fire by road." };
  }

  // Engines get the nearest stations (that is what stations house), then hand crews, then
  // dozers; trips keep the order of `resources`.
  const departMinute = reportMinute + TURNOUT_MINUTES;
  const hikeMinutes = gap / HIKE_METERS_PER_MINUTE;
  const stationOf = new Array<number>(resources.length);
  resources
    .map((kind, index) => ({ kind, index }))
    .sort((a, b) => DISPATCH_PRIORITY[a.kind] - DISPATCH_PRIORITY[b.kind] || a.index - b.index)
    .forEach(({ index }, order) => {
      stationOf[index] = order % candidates.length;
    });
  const counts: Partial<Record<ResourceKind, number>> = {};
  const trips = resources.map((kind, index): CrewTrip => {
    const station = candidates[stationOf[index]];
    counts[kind] = (counts[kind] ?? 0) + 1;
    return {
      kind,
      label: `${KIND_LABEL[kind]} ${counts[kind]}`,
      stationName: station.name,
      departMinute,
      atRoadMinute: departMinute + station.travelMinutes,
      arriveMinute: departMinute + station.travelMinutes + hikeMinutes,
      path: station.path,
      pathMinutes: station.pathMinutes,
    };
  });
  return {
    dispatch: {
      reportMinute,
      fire,
      roadPoint: area.nodes[roadNode],
      hikeMeters: gap,
      hikeMinutes,
      trips,
    },
    note: null,
  };
}

/** Where a trip is at `minute`: at the station, on the road, or at the fire's road point. */
export function tripPosition(trip: CrewTrip, minute: number): { at: LonLat; ahead: LonLat } {
  const { path, pathMinutes } = trip;
  const elapsed = minute - trip.departMinute;
  if (elapsed <= 0) return { at: path[0], ahead: path[Math.min(1, path.length - 1)] };
  const last = path.length - 1;
  if (elapsed >= pathMinutes[last]) return { at: path[last], ahead: path[last] };
  let i = 1;
  while (i < last && pathMinutes[i] < elapsed) i += 1;
  const span = pathMinutes[i] - pathMinutes[i - 1];
  const t = span > 0 ? (elapsed - pathMinutes[i - 1]) / span : 1;
  const a = path[i - 1];
  const b = path[i];
  return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ahead: b };
}
