import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "./area";
import { DispatchEngine } from "./engine";
import type { FireExposure } from "./fireExposure";
import { detectChanges, takeBaseline } from "./monitor";
import { roadsObservation } from "./observation";

const HOMES = 10;

/**
 * Zone A (node 0) reaches exit E1 (node 3) via node 1 (short: edges 0, 1, "Short Rd") or via
 * node 2 (long: edges 2, 3, "Long Rd").
 */
function twoRouteArea(): DispatchArea {
  const nodes: LonLat[] = [
    [-122.0, 37.0],
    [-121.99, 37.0],
    [-121.99, 37.02],
    [-121.98, 37.0],
  ];
  const spec: [number, number, number, string][] = [
    [0, 1, 500, "Short Rd"],
    [1, 3, 500, "Short Rd"],
    [0, 2, 2000, "Long Rd"],
    [2, 3, 2000, "Long Rd"],
  ];
  const edges: RoadEdge[] = spec.map(([from, to, lengthMeters, name], index) => ({
    index,
    from,
    to,
    lengthMeters,
    roadClass: "residential",
    speedKph: 50,
    capacityVph: 1800,
    oneway: false,
    name,
    bridge: false,
    coords: [nodes[from], nodes[to]],
  }));
  const outgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    outgoing[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
    outgoing[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
  }
  return {
    id: "two-route",
    name: "Two routes",
    bbox: [-122.01, 36.99, -121.97, 37.03],
    attribution: "synthetic",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    zones: [
      {
        id: "A",
        name: "Zone A",
        node: 0,
        homes: HOMES,
        vehicles: HOMES * 1.6,
        centroid: nodes[0],
        polygon: [nodes[0]],
        firstHome: 0,
      },
    ],
    homes: Array.from({ length: HOMES }, () => ({ position: nodes[0], zone: 0 })),
    exits: [{ id: "E1", name: "East exit", node: 3, road: "Short Rd" }],
    stations: [],
  };
}

function quietExposure(area: DispatchArea, edgeArrival?: number[]): FireExposure {
  return {
    nodeArrival: new Float64Array(area.nodes.length).fill(Infinity),
    edgeArrival: edgeArrival
      ? Float64Array.from(edgeArrival)
      : new Float64Array(area.edges.length).fill(Infinity),
    homeArrival: new Float64Array(area.homes.length).fill(Infinity),
    zoneContact: Float64Array.from([60]),
    zoneCore: new Float64Array(area.zones.length).fill(Infinity),
  };
}

function orderedEngine(area: DispatchArea, exposure = quietExposure(area)): DispatchEngine {
  const engine = new DispatchEngine(area, exposure, 180, []);
  const [outcome] = engine.applyOrders([
    { type: "order_evacuation", zone_id: "A", exit_id: "E1", reason: "test" },
  ]);
  expect(outcome.accepted).toBe(true);
  return engine;
}

const routeEdges = (engine: DispatchEngine) =>
  engine.zones[0].route?.steps.map((step) => step.edge) ?? [];

describe("live road closures", () => {
  it("re-plans an ordered zone around a road closed mid-run, and back when reopened", () => {
    const engine = orderedEngine(twoRouteArea());
    for (let i = 0; i < 5; i += 1) engine.step();
    expect(routeEdges(engine)).toEqual([0, 1]);

    expect(engine.setRoadClosed(1, true)).toBe(true);
    expect(routeEdges(engine)).toEqual([2, 3]);
    expect(engine.roadClosures).toEqual([{ edge: 1, minute: 5 }]);
    const alert = engine.alerts.find((a) => a.type === "road_closed")!;
    expect(engine.alerts.at(-1)!.type).toBe("route_changed");
    expect(alert).toMatchObject({ type: "road_closed", urgent: true, minute: 5 });
    expect(alert.text).toContain("Short Rd");
    expect(alert.text).toContain("A was routed over it");

    // Closing twice is a no-op; reopening clears the record (the route is still open, so it stays).
    expect(engine.setRoadClosed(1, true)).toBe(false);
    expect(engine.setRoadClosed(1, false)).toBe(true);
    expect(engine.roadClosures).toEqual([]);
    expect(engine.alerts.at(-1)!.type).toBe("road_reopened");
  });

  it("holds departures when closures cut the zone off, and resumes on reopen", () => {
    const engine = orderedEngine(twoRouteArea());
    engine.step();
    engine.setRoadClosed(1, true);
    engine.setRoadClosed(3, true);
    expect(engine.zones[0].routeBlocked).toBe(true);
    expect(engine.alerts.some((alert) => alert.type === "route_blocked")).toBe(true);
    engine.setRoadClosed(3, false);
    expect(engine.zones[0].routeBlocked).toBe(false);
    expect(routeEdges(engine)).toEqual([2, 3]);
  });

  it("drives every household out over the detour after a mid-run closure", () => {
    const engine = orderedEngine(twoRouteArea());
    for (let i = 0; i < 3; i += 1) engine.step();
    engine.setRoadClosed(0, true);
    while (!engine.finished) engine.step();
    expect(engine.zones[0].safe).toBe(HOMES);
    expect(engine.zones[0].caught).toBe(0);
  });

  it("wakes the monitor once per closure, even one made at the baseline minute", () => {
    const engine = orderedEngine(twoRouteArea());
    engine.step();
    const baseline = takeBaseline(engine, 0);
    engine.setRoadClosed(1, true);
    const alerts = engine.alerts.filter((alert) => alert.minute >= baseline.minute);
    const reasons = detectChanges(engine, baseline, 0, alerts);
    expect(reasons.filter((reason) => reason.includes("Short Rd"))).toHaveLength(1);
    expect(reasons[0]).toMatch(/^Planner closed Short Rd at T\+1/);

    const after = takeBaseline(engine, 0);
    expect(detectChanges(engine, after, 0, [])).toEqual([]);
    engine.setRoadClosed(1, false);
    expect(detectChanges(engine, after, 0, [])).toEqual(["Planner reopened Short Rd."]);
  });

  it("starts with closures given at T+0", () => {
    const area = twoRouteArea();
    const engine = new DispatchEngine(area, quietExposure(area), 180, [], new Set([0]));
    expect(engine.roadClosures).toEqual([{ edge: 0, minute: 0 }]);
    engine.applyOrders([{ type: "order_evacuation", zone_id: "A", exit_id: "E1", reason: "t" }]);
    expect(routeEdges(engine)).toEqual([2, 3]);
  });
});

describe("roads in the observation", () => {
  it("lists planner closures and roads the fire cuts within the routing lookahead", () => {
    const area = twoRouteArea();
    // Short Rd's second segment burns at T+12; Long Rd never.
    const engine = orderedEngine(area, quietExposure(area, [Infinity, 12, Infinity, Infinity]));
    expect(roadsObservation(engine).fire_cut_segments).toBe(0);
    engine.step();
    engine.step();
    engine.setRoadClosed(2, true);
    const roads = roadsObservation(engine);
    expect(roads.planner_closed).toEqual([{ road: "Long Rd", bridge: false, since_minute: 2 }]);
    expect(roads.fire_cut_segments).toBe(1);
    expect(roads.fire_cut_roads).toEqual(["Short Rd"]);
    // Fire on the short road and the long road closed: the zone is cut off.
    expect(engine.zones[0].routeBlocked).toBe(true);
  });
});
