import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "../dispatch/area";
import {
  HIKE_METERS_PER_MINUTE,
  TURNOUT_MINUTES,
  arrivalsOf,
  planCrewDispatch,
  tripPosition,
} from "./crewDispatch";

type Spec = [number, number, number, string, Record<string, string>?];

/**
 * A station at node 0; the fire's road point is node 2, reachable directly over a 1.2 km road
 * (0-1-2) or the long way round over 3.6 km (0-3-2). Untagged secondary roads: rule R11 gives
 * heavy apparatus the 60 km/h secondary cap (1 km/min); the default width 6.1 m is two lanes.
 */
function area(spec: Spec[] = DEFAULT_SPEC, extraNodes: LonLat[] = []): DispatchArea {
  const nodes: LonLat[] = [[0, 0], [0.005, 0], [0.01, 0], [0.005, 0.01], ...extraNodes];
  const edges: RoadEdge[] = spec.map(([from, to, lengthMeters, roadClass, tags], index) => ({
    index,
    from,
    to,
    lengthMeters,
    roadClass,
    speedKph: 36,
    capacityVph: 600,
    oneway: false,
    name: `Road ${index}`,
    bridge: false,
    coords: [nodes[from], nodes[to]],
    tags: tags ?? {},
    accessOnly: roadClass === "track" || roadClass === "service",
  }));
  const outgoing: Arc[][] = nodes.map(() => []);
  const allOutgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    for (const list of edge.accessOnly ? [allOutgoing] : [outgoing, allOutgoing]) {
      list[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
      list[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
    }
  }
  return {
    id: "test",
    name: "Test",
    bbox: [0, 0, 0.03, 0.03],
    attribution: "",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    allOutgoing,
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

const DEFAULT_SPEC: Spec[] = [
  [0, 1, 600, "secondary"],
  [1, 2, 600, "secondary"],
  [0, 3, 1800, "secondary"],
  [3, 2, 1800, "secondary"],
];

const FIRE: LonLat = [0.0101, 0.0001];

describe("crew dispatch from fire stations", () => {
  it("sends every resource after turnout and the road drive", () => {
    const { dispatch, note } = planCrewDispatch(area(), FIRE, 0, ["engine_t3", "hand_crew_t2"]);
    expect(note).toBeNull();
    expect(dispatch!.trips).toHaveLength(2);
    const trip = dispatch!.trips[0];
    expect(trip.label).toBe("T3 engine 1");
    expect(trip.departMinute).toBeCloseTo(TURNOUT_MINUTES, 6);
    expect(trip.atRoadMinute).toBeCloseTo(TURNOUT_MINUTES + 1.2, 6); // 1.2 km at 60 km/h
    // Then the walk from the road point to the fire.
    expect(trip.arriveMinute - trip.atRoadMinute).toBeCloseTo(
      trip.hikeMeters / HIKE_METERS_PER_MINUTE,
      6,
    );
    expect(trip.hikeMeters).toBeGreaterThan(0);
    expect(arrivalsOf(dispatch!).map((a) => a.kind)).toEqual(["engine_t3", "hand_crew_t2"]);
    // Without the CAL FIRE bases file the crew comes from the board station, and says so.
    expect(dispatch!.trips[1].origin).toBe("fallback");
    expect(dispatch!.notes.join(" ")).toMatch(/No CAL FIRE base data/);
  });

  it("counts the report minute", () => {
    const { dispatch } = planCrewDispatch(area(), FIRE, 20, ["engine_t3"]);
    expect(dispatch!.trips[0].atRoadMinute).toBeCloseTo(20 + TURNOUT_MINUTES + 1.2, 6);
  });

  it("moves along the road: at the station, half way, then at the fire", () => {
    const trip = planCrewDispatch(area(), FIRE, 0, ["engine_t3"]).dispatch!.trips[0];
    expect(tripPosition(trip, 0).at).toEqual([0, 0]);
    const middle = tripPosition(trip, trip.departMinute + 0.6).at;
    expect(middle[0]).toBeCloseTo(0.005, 6);
    expect(tripPosition(trip, trip.atRoadMinute + 5).at).toEqual([0.01, 0]);
  });

  it("drives around a closed road, and walks in further when none gets through", () => {
    const longWay = planCrewDispatch(area(), FIRE, 0, ["engine_t3"], (edge) => edge === 1);
    expect(longWay.dispatch!.trips[0].atRoadMinute).toBeCloseTo(TURNOUT_MINUTES + 3.6, 6);
    const cutOff = planCrewDispatch(area(), FIRE, 0, ["engine_t3"], (e) => e === 1 || e === 3);
    // It parks at node 1, 0.56 km short, and walks.
    expect(cutOff.dispatch!.trips[0].hikeMeters).toBeGreaterThan(500);
  });

  it("refuses a fire far from every road", () => {
    const { dispatch, note } = planCrewDispatch(area(), [0.2, 0.2], 0, ["engine_t3"]);
    expect(dispatch).toBeNull();
    expect(note).toMatch(/too far/);
  });

  it("routes each apparatus class on its own graph and names the rule that blocks it", () => {
    // The fire is up a 1 km dirt track (node 4) from node 2, 1.6 km beyond any other road.
    const track: Spec[] = [
      [0, 1, 600, "secondary"],
      [1, 2, 600, "secondary"],
      [2, 4, 1000, "track", { tracktype: "grade4", surface: "dirt" }],
    ];
    const far: LonLat = [0.03, 0.0];
    const a = area(track, [far]);
    const fire: LonLat = [0.0301, 0.0001];
    const { dispatch } = planCrewDispatch(a, fire, 0, ["engine_t1", "engine_t3", "engine_t6"]);
    const sent = dispatch!.trips.map((t) => t.kind);
    expect(sent).toEqual(["engine_t6"]); // grade4 is allowed only for Type 4-7 (R04)
    expect(dispatch!.noAccess.map((n) => [n.kind, n.rule])).toEqual([
      ["engine_t1", "R04"],
      ["engine_t3", "R04"],
    ]);
    // Track speed for T4-7: grade4 unpaved 12 km/h x single lane 0.6 (3.5 m default width).
    const t6 = dispatch!.trips[0];
    expect(t6.atRoadMinute - t6.departMinute).toBeCloseTo(1.2 + 1 / ((12 * 0.6) / 60), 4);
  });

  it("is deterministic", () => {
    const run = () => JSON.stringify(planCrewDispatch(area(), FIRE, 0, ["engine_t3", "chief", "dozer_t2"]));
    expect(run()).toBe(run());
  });
});
