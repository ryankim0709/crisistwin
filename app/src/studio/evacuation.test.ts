import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "../dispatch/area";
import type { FireExposure } from "../dispatch/fireExposure";
import {
  EvacuationPlayer,
  EvacuationPolicyRun,
  nearestEdge,
  simulateEvacuation,
} from "./evacuation";

/**
 * One zone at node 0 with two ways out: a short one over a bridge (0-1-2, exit X01) and a
 * longer one (0-3-4, exit X02). 36 km/h is 10 m/s.
 */
function testArea(): DispatchArea {
  const nodes: LonLat[] = [
    [0, 0],
    [0.01, 0],
    [0.02, 0],
    [0, 0.01],
    [0, 0.03],
  ];
  const spec: [number, number, number, boolean][] = [
    [0, 1, 1000, false],
    [1, 2, 1000, true],
    [0, 3, 2000, false],
    [3, 4, 2000, false],
  ];
  const edges: RoadEdge[] = spec.map(([from, to, lengthMeters, bridge], index) => ({
    index,
    from,
    to,
    lengthMeters,
    roadClass: "secondary",
    speedKph: 36,
    capacityVph: 600,
    oneway: false,
    name: bridge ? "River Bridge" : null,
    bridge,
    coords: [nodes[from], nodes[to]],
  }));
  const outgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    outgoing[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
    outgoing[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
  }
  const homes = Array.from({ length: 10 }, (_, i) => ({
    position: [0.0001 * i, 0.0001] as LonLat,
    zone: 0,
  }));
  return {
    id: "test",
    name: "Test area",
    bbox: [0, 0, 0.02, 0.03],
    attribution: "",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    zones: [
      {
        id: "Z01",
        name: "Zone 1",
        node: 0,
        homes: 10,
        vehicles: 15,
        centroid: [0.0005, 0.0001],
        polygon: [],
        firstHome: 0,
      },
    ],
    homes,
    exits: [
      { id: "X01", name: "East", node: 2, road: "" },
      { id: "X02", name: "North", node: 4, road: "" },
    ],
    stations: [],
  };
}

function noFire(area: DispatchArea): FireExposure {
  return {
    nodeArrival: new Float64Array(area.nodes.length).fill(Infinity),
    edgeArrival: new Float64Array(area.edges.length).fill(Infinity),
    homeArrival: new Float64Array(area.homes.length).fill(Infinity),
    zoneContact: new Float64Array(area.zones.length).fill(Infinity),
    zoneCore: new Float64Array(area.zones.length).fill(Infinity),
  };
}

const HORIZON = 120;

describe("studio evacuation policy", () => {
  it("sends every zone to its fastest exit and gets everyone out", () => {
    const area = testArea();
    const inputs = {
      area,
      exposure: noFire(area),
      horizonMinutes: HORIZON,
      closedEdges: new Set<number>(),
      orderMinute: 0,
    };
    expect(new EvacuationPolicyRun(inputs).engine.zones[0].exitId).toBe("X01");
    const summary = simulateEvacuation(inputs);
    expect(summary.final.safe).toBe(10);
    expect(summary.final.caught).toBe(0);
    expect(summary.cutOffZones).toBe(0);
    expect(summary.allClearMinute).not.toBeNull();
    expect(summary.totalsByMinute).toHaveLength(HORIZON + 1);
  });

  it("re-routes around a failed bridge, and the longer way takes longer", () => {
    const area = testArea();
    const base = {
      area,
      exposure: noFire(area),
      horizonMinutes: HORIZON,
      orderMinute: 0,
    };
    const open = simulateEvacuation({ ...base, closedEdges: new Set() });
    const closedInputs = { ...base, closedEdges: new Set([1]) };
    expect(new EvacuationPolicyRun(closedInputs).engine.zones[0].exitId).toBe("X02");
    const closed = simulateEvacuation(closedInputs);
    expect(closed.final.safe).toBe(10);
    expect(closed.allClearMinute!).toBeGreaterThan(open.allClearMinute!);
    expect(closed.householdHoursEvacuating).toBeGreaterThan(open.householdHoursEvacuating);
  });

  it("leaves a zone with every way out closed cut off at home", () => {
    const area = testArea();
    const summary = simulateEvacuation({
      area,
      exposure: noFire(area),
      horizonMinutes: HORIZON,
      closedEdges: new Set([0, 2]),
      orderMinute: 0,
    });
    expect(summary.cutOffZones).toBe(1);
    expect(summary.cutOffHomes).toBe(10);
    expect(summary.final.safe).toBe(0);
    expect(summary.final.notOrdered).toBe(10);
    expect(summary.allClearMinute).toBeNull();
  });

  it("counts households caught when the order comes after the fire reaches them", () => {
    const area = testArea();
    const exposure = noFire(area);
    exposure.homeArrival.fill(5);
    exposure.zoneContact.fill(5);
    const summary = simulateEvacuation({
      area,
      exposure,
      horizonMinutes: HORIZON,
      closedEdges: new Set(),
      orderMinute: 15,
    });
    expect(summary.final.caught).toBe(10);
    expect(summary.final.safe).toBe(0);
    // Conservation: every household is in exactly one state.
    const { notOrdered, waiting, onRoad, safe, caught } = summary.final;
    expect(notOrdered + waiting + onRoad + safe + caught).toBe(10);
  });

  it("replays identically when playback moves back", () => {
    const area = testArea();
    const inputs = {
      area,
      exposure: noFire(area),
      horizonMinutes: HORIZON,
      closedEdges: new Set([1]),
      orderMinute: 0,
    };
    const player = new EvacuationPlayer(inputs);
    player.syncTo(30);
    const at30 = player.engine.totals();
    player.syncTo(60);
    player.syncTo(30);
    expect(player.engine.minute).toBe(30);
    expect(player.engine.totals()).toEqual(at30);
  });

  it("picks the road nearest a click, within range", () => {
    const area = testArea();
    expect(nearestEdge(area, [0.015, 0.0002])).toBe(1);
    expect(nearestEdge(area, [0.0002, 0.02])).toBe(3);
    expect(nearestEdge(area, [0.015, 0.015])).toBeNull();
  });
});

describe("firefighters overwhelmed by the fire", () => {
  it("join the evacuation at their leave minute and speed up departures", () => {
    const area = testArea();
    const inputs = {
      area,
      exposure: noFire(area),
      horizonMinutes: HORIZON,
      closedEdges: new Set<number>(),
      orderMinute: 0,
    };
    const without = simulateEvacuation(inputs);
    const crews = [{ id: "Engine 1", node: 2, homeNode: 2, leaveMinute: 0 }];
    const run = new EvacuationPolicyRun({ ...inputs, crews });
    const unit = run.engine.units.find((candidate) => candidate.id === "Engine 1");
    expect(unit?.task).toBe("evacuation_support");
    expect(unit?.zone).toBe(0);
    const helped = simulateEvacuation({ ...inputs, crews });
    expect(helped.final.safe).toBe(10);
    expect(helped.allClearMinute!).toBeLessThan(without.allClearMinute!);
  });

  it("stay away until they leave the fire", () => {
    const area = testArea();
    const run = new EvacuationPolicyRun({
      area,
      exposure: noFire(area),
      horizonMinutes: HORIZON,
      closedEdges: new Set<number>(),
      orderMinute: 0,
      crews: [{ id: "Engine 1", node: 2, homeNode: 2, leaveMinute: 30 }],
    });
    while (run.minute < 29) run.step();
    expect(run.engine.units.some((unit) => unit.id === "Engine 1")).toBe(false);
    run.step();
    expect(run.engine.units.find((unit) => unit.id === "Engine 1")?.status).toBe("en_route");
  });
});

describe("crews leaving a fire that has reached their road point", () => {
  it("pull back to the nearest open road and still join", () => {
    const area = testArea();
    const exposure = noFire(area);
    // Fire is on node 2 and its only road (1-2) when the crew leaves.
    exposure.nodeArrival[2] = 0;
    exposure.edgeArrival[1] = 0;
    const run = new EvacuationPolicyRun({
      area,
      exposure,
      horizonMinutes: HORIZON,
      closedEdges: new Set<number>(),
      orderMinute: 0,
      crews: [{ id: "Engine 1", node: 2, homeNode: 4, leaveMinute: 0 }],
    });
    const unit = run.engine.units.find((candidate) => candidate.id === "Engine 1");
    expect(unit?.task).toBe("evacuation_support");
  });
});

describe("crews in a pocket the fire has cut off", () => {
  it("pull back to a node that can still reach the zone", () => {
    const area = testArea();
    const exposure = noFire(area);
    // Both roads from node 3 (to the zone at 0 and to exit node 4) are burning: a crew parked
    // there cannot reach the zone and must start from the nearest node that can.
    exposure.edgeArrival[2] = 0;
    exposure.edgeArrival[3] = 0;
    const run = new EvacuationPolicyRun({
      area,
      exposure,
      horizonMinutes: HORIZON,
      closedEdges: new Set<number>(),
      orderMinute: 0,
      crews: [{ id: "Engine 1", node: 3, homeNode: 2, leaveMinute: 0 }],
    });
    const unit = run.engine.units.find((candidate) => candidate.id === "Engine 1");
    expect(unit?.task).toBe("evacuation_support");
    expect(unit?.node).not.toBe(3);
  });
});
