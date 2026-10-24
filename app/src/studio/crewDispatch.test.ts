import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "../dispatch/area";
import {
  HIKE_METERS_PER_MINUTE,
  TURNOUT_MINUTES,
  arrivalsOf,
  planCrewDispatch,
  tripPosition,
} from "./crewDispatch";

/**
 * A station at node 0; the fire's road point is node 2, reachable directly over a 1.2 km road
 * (0-1-2) or the long way round over 3.6 km (0-3-2). 36 km/h is 0.6 km/min.
 */
function area(): DispatchArea {
  const nodes: LonLat[] = [
    [0, 0],
    [0.005, 0],
    [0.01, 0],
    [0.005, 0.01],
  ];
  const spec: [number, number, number][] = [
    [0, 1, 600],
    [1, 2, 600],
    [0, 3, 1800],
    [3, 2, 1800],
  ];
  const edges: RoadEdge[] = spec.map(([from, to, lengthMeters], index) => ({
    index,
    from,
    to,
    lengthMeters,
    roadClass: "secondary",
    speedKph: 36,
    capacityVph: 600,
    oneway: false,
    name: null,
    bridge: false,
    coords: [nodes[from], nodes[to]],
  }));
  const outgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    outgoing[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
    outgoing[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
  }
  return {
    id: "test",
    name: "Test",
    bbox: [0, 0, 0.01, 0.01],
    attribution: "",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    zones: [],
    homes: [],
    exits: [],
    stations: [
      {
        id: "S1",
        name: "Station 1",
        node: 0,
        location: [0, 0],
        approachMeters: 0,
        units: [{ id: "E1", type: "engine" }],
      },
    ],
  };
}

const FIRE: LonLat = [0.0101, 0.0001];

describe("crew dispatch from fire stations", () => {
  it("sends every resource after turnout and the road drive", () => {
    const { dispatch, note } = planCrewDispatch(area(), FIRE, 0, ["engine", "hand_crew"]);
    expect(note).toBeNull();
    expect(dispatch!.trips).toHaveLength(2);
    const trip = dispatch!.trips[0];
    expect(trip.label).toBe("Engine 1");
    expect(trip.departMinute).toBeCloseTo(TURNOUT_MINUTES, 6);
    expect(trip.atRoadMinute).toBeCloseTo(TURNOUT_MINUTES + 2, 6); // 1.2 km at 0.6 km/min
    // Then the walk from the road point to the fire.
    expect(trip.arriveMinute - trip.atRoadMinute).toBeCloseTo(
      dispatch!.hikeMeters / HIKE_METERS_PER_MINUTE,
      6,
    );
    expect(dispatch!.hikeMeters).toBeGreaterThan(0);
    expect(arrivalsOf(dispatch!).map((a) => a.kind)).toEqual(["engine", "hand_crew"]);
  });

  it("counts the report minute", () => {
    const { dispatch } = planCrewDispatch(area(), FIRE, 20, ["engine"]);
    expect(dispatch!.trips[0].atRoadMinute).toBeCloseTo(20 + TURNOUT_MINUTES + 2, 6);
  });

  it("moves along the road: at the station, half way, then at the fire", () => {
    const trip = planCrewDispatch(area(), FIRE, 0, ["engine"]).dispatch!.trips[0];
    expect(tripPosition(trip, 0).at).toEqual([0, 0]);
    const middle = tripPosition(trip, trip.departMinute + 1).at;
    expect(middle[0]).toBeCloseTo(0.005, 6);
    expect(tripPosition(trip, trip.atRoadMinute + 5).at).toEqual([0.01, 0]);
  });

  it("drives around a closed road, and explains when none gets through", () => {
    const longWay = planCrewDispatch(area(), FIRE, 0, ["engine"], (edge) => edge === 1);
    expect(longWay.dispatch!.trips[0].atRoadMinute).toBeCloseTo(TURNOUT_MINUTES + 6, 6);
    const cutOff = planCrewDispatch(
      area(),
      FIRE,
      0,
      ["engine"],
      (edge) => edge === 1 || edge === 3,
    );
    expect(cutOff.dispatch).toBeNull();
    expect(cutOff.note).toMatch(/reach/);
  });

  it("refuses a fire far from every road", () => {
    const { dispatch, note } = planCrewDispatch(area(), [0.2, 0.2], 0, ["engine"]);
    expect(dispatch).toBeNull();
    expect(note).toMatch(/too far/);
  });
});
