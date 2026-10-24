import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "../dispatch/area";
import type { FireExposure } from "../dispatch/fireExposure";
import { EvacuationPlayer, simulateEvacuation } from "./evacuation";
import { diffTick, homeAddresses, runPayload, zoneTick, type SimTickZone } from "./simState";

/** One zone at node 0; edge 0 (named "Oak St") runs east, edge 1 north is unnamed. */
function testArea(homePositions: LonLat[]): DispatchArea {
  const nodes: LonLat[] = [
    [0, 0],
    [0.02, 0],
    [0, 0.02],
  ];
  const edges: RoadEdge[] = [
    [0, 1, "Oak St"],
    [0, 2, null],
  ].map(([from, to, name], index) => ({
    index,
    from: from as number,
    to: to as number,
    lengthMeters: 2200,
    roadClass: "secondary",
    speedKph: 36,
    capacityVph: 600,
    oneway: false,
    name: name as string | null,
    bridge: false,
    coords: [nodes[from as number], nodes[to as number]],
  }));
  const outgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    outgoing[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
    outgoing[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
  }
  return {
    id: "test",
    name: "Test area",
    bbox: [0, 0, 0.02, 0.02],
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
        homes: homePositions.length,
        vehicles: homePositions.length,
        centroid: [0.0005, 0.0001],
        polygon: [],
        firstHome: 0,
      },
    ],
    homes: homePositions.map((position) => ({ position, zone: 0 })),
    exits: [{ id: "X01", name: "East", node: 1, road: "" }],
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

describe("synthetic addresses", () => {
  // 0.0001 degrees of latitude is about 11 m; home 3 is far from every road.
  const positions: LonLat[] = [
    [0.002, 0.0001],
    [0.002, -0.0001],
    [0.0021, 0.0001],
    [0.01, 0.01],
  ];

  it("names homes after the nearest named road, deterministically", () => {
    const area = testArea(positions);
    const a = homeAddresses(area);
    expect(homeAddresses(area)).toEqual(a);
    expect(a[0]).toMatch(/^\d+ Oak St$/);
    expect(a[1]).toMatch(/^\d+ Oak St$/);
  });

  it("gives neighbours across the street and along it different numbers, odd and even", () => {
    const a = homeAddresses(testArea(positions));
    const n = a.slice(0, 3).map((s) => Number.parseInt(s, 10));
    expect(new Set(n).size).toBe(3);
    expect(n[0] % 2).not.toBe(n[1] % 2);
  });

  it("falls back to a zone-relative label when no named road is near", () => {
    expect(homeAddresses(testArea(positions))[3]).toBe("Home 4, Zone 1");
  });

  it("builds the run payload with ranks from the zone's first home", () => {
    const area = testArea(positions);
    const body = runPayload(
      area,
      { horizonMinutes: 60, orderMinute: 15 },
      homeAddresses(area),
      "x",
    );
    expect(body.homes.map((h) => [h.home_id, h.rank])).toEqual([
      ["h0", 0],
      ["h1", 1],
      ["h2", 2],
      ["h3", 3],
    ]);
    expect(body.zones[0]).toMatchObject({ zone_id: "Z01", homes: 4 });
    expect(body.order_minute).toBe(15);
  });
});

describe("zone advice", () => {
  const area = testArea(Array.from({ length: 5 }, (_, i) => [0.001 * i, 0.0001] as LonLat));
  const inputs = {
    area,
    exposure: noFire(area),
    horizonMinutes: 120,
    closedEdges: new Set<number>(),
    orderMinute: 15,
  };

  it("is leave_later before the order, leave_now after, cleared at the end", () => {
    const summary = simulateEvacuation(inputs);
    expect(summary.zoneOrderMinutes).toEqual([15]);
    const player = new EvacuationPlayer(inputs);
    const cutOff = new Set(summary.cutOffZoneIndices);
    player.syncTo(5);
    expect(zoneTick(area, player.engine, cutOff, summary).zones[0]).toMatchObject({
      advice: "leave_later",
      order_minute: 15,
      departed: 0,
    });
    player.syncTo(16);
    const now = zoneTick(area, player.engine, cutOff, summary).zones[0];
    expect(now.advice).toBe("leave_now");
    expect(now.exit_id).toBe("X01");
    expect(now.departed + now.at_home).toBe(5);
    player.syncTo(120);
    expect(zoneTick(area, player.engine, cutOff, summary).zones[0]).toMatchObject({
      advice: "cleared",
      departed: 5,
      at_home: 0,
    });
  });

  it("is cut_off when every way out is closed", () => {
    const closed = { ...inputs, closedEdges: new Set([0, 1]) };
    const summary = simulateEvacuation(closed);
    const player = new EvacuationPlayer(closed);
    player.syncTo(30);
    const zone = zoneTick(area, player.engine, new Set(summary.cutOffZoneIndices), summary)
      .zones[0];
    expect(zone.advice).toBe("cut_off");
    expect(zone.order_minute).toBeNull();
    expect(zone.departed).toBe(0);
  });
});

describe("diffTick", () => {
  const z = (id: string, departed: number): SimTickZone => ({
    zone_id: id,
    advice: "leave_now",
    order_minute: 0,
    departed,
    at_home: 10 - departed,
    exit_id: null,
  });

  it("sends everything first, then only changed zones", () => {
    const first = [z("z0", 1), z("z1", 2)];
    expect(diffTick(null, first)).toEqual(first);
    expect(diffTick(first, [z("z0", 1), z("z1", 3)])).toEqual([z("z1", 3)]);
    expect(diffTick(first, first)).toEqual([]);
  });
});
