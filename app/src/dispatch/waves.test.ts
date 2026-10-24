import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "./area";
import { DEPARTURE_SPREAD_MINUTES, DispatchEngine, STAGE_RELEASE_SLACK_MINUTES } from "./engine";
import type { FireExposure } from "./fireExposure";
import { detectChanges, takeBaseline, threatTier } from "./monitor";

const HOMES_PER_ZONE = 10;

/** Zones A (node 0) and B (node 1) both drive through junction 2 to exit E1 (node 3). */
function tinyArea(): DispatchArea {
  const nodes: LonLat[] = [
    [-122.0, 37.0],
    [-122.0, 37.01],
    [-121.99, 37.005],
    [-121.98, 37.005],
  ];
  const pairs: [number, number][] = [
    [0, 2],
    [1, 2],
    [2, 3],
  ];
  const edges: RoadEdge[] = pairs.map(([from, to], index) => ({
    index,
    from,
    to,
    lengthMeters: 500,
    roadClass: "residential",
    speedKph: 50,
    capacityVph: 1800,
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
  const zone = (id: string, node: number, firstHome: number) => ({
    id,
    name: `Zone ${id}`,
    node,
    homes: HOMES_PER_ZONE,
    vehicles: HOMES_PER_ZONE * 1.6,
    centroid: nodes[node],
    polygon: [nodes[node]],
    firstHome,
  });
  return {
    id: "tiny",
    name: "Tiny",
    bbox: [-122.01, 36.99, -121.97, 37.02],
    attribution: "synthetic",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    zones: [zone("A", 0, 0), zone("B", 1, HOMES_PER_ZONE)],
    homes: [
      ...Array.from({ length: HOMES_PER_ZONE }, () => ({ position: nodes[0], zone: 0 })),
      ...Array.from({ length: HOMES_PER_ZONE }, () => ({ position: nodes[1], zone: 1 })),
    ],
    exits: [{ id: "E1", name: "East exit", node: 3, road: "Main St" }],
    stations: [],
  };
}

/** Fire never reaches homes or roads; only zone contact times are set. */
function exposureWithContact(area: DispatchArea, contact: [number, number]): FireExposure {
  return {
    nodeArrival: new Float64Array(area.nodes.length).fill(Infinity),
    edgeArrival: new Float64Array(area.edges.length).fill(Infinity),
    homeArrival: new Float64Array(area.homes.length).fill(Infinity),
    zoneContact: Float64Array.from(contact),
    zoneCore: new Float64Array(area.zones.length).fill(Infinity),
  };
}

function engineWith(contact: [number, number]): DispatchEngine {
  const area = tinyArea();
  return new DispatchEngine(area, exposureWithContact(area, contact), 240, []);
}

describe("staged evacuation waves", () => {
  it("releases a staged zone once the zone ahead is on the road", () => {
    const engine = engineWith([120, 200]);
    const outcomes = engine.applyOrders([
      { type: "order_evacuation", zone_id: "A", exit_id: "E1", reason: "" },
      { type: "stage_evacuation", zone_id: "B", exit_id: "E1", after_zone_id: "A", reason: "" },
    ]);
    expect(outcomes.map((o) => o.accepted)).toEqual([true, true]);
    expect(engine.waveOf(1)).toBe(2);

    let releasedAt: number | null = null;
    while (!engine.finished && releasedAt === null) {
      engine.step();
      const [a, b] = engine.zones;
      if (b.status === "ordered") {
        releasedAt = engine.minute;
        // A's households had all left home and the queue when B was told to go.
        expect(a.atHome + a.queued).toBe(0);
      }
    }
    expect(releasedAt).not.toBeNull();
    expect(releasedAt!).toBeGreaterThanOrEqual(DEPARTURE_SPREAD_MINUTES);
    expect(engine.zones[1].wave).toBe(2);
    expect(engine.alerts.some((alert) => alert.type === "wave_released" && !alert.urgent)).toBe(
      true,
    );
    expect(engine.notices.map((n) => [engine.area.zones[n.zone].id, n.kind])).toEqual([
      ["A", "leave_now"],
      ["B", "prepare"],
      ["B", "leave_now"],
    ]);
  });

  it("releases a staged zone early when its own order slack runs out", () => {
    // B's slack at T+0 is 60 - 45 = 15 min, so it must go at T+10 whatever A is doing.
    const engine = engineWith([120, 60]);
    engine.applyOrders([
      { type: "order_evacuation", zone_id: "A", exit_id: "E1", reason: "" },
      { type: "stage_evacuation", zone_id: "B", exit_id: "E1", after_zone_id: "A", reason: "" },
    ]);
    while (engine.zones[1].status === "no_order" && !engine.finished) engine.step();
    expect(engine.minute).toBe(60 - DEPARTURE_SPREAD_MINUTES - STAGE_RELEASE_SLACK_MINUTES);
    expect(engine.alerts.some((alert) => alert.type === "wave_released" && alert.urgent)).toBe(
      true,
    );
  });

  it("rejects staging behind an unordered zone, itself, or in a loop", () => {
    const engine = engineWith([120, 200]);
    const [behindIdle, behindSelf] = engine.applyOrders([
      { type: "stage_evacuation", zone_id: "B", exit_id: "E1", after_zone_id: "A", reason: "" },
      { type: "stage_evacuation", zone_id: "B", exit_id: "E1", after_zone_id: "B", reason: "" },
    ]);
    expect(behindIdle.accepted).toBe(false);
    expect(behindSelf.accepted).toBe(false);

    engine.applyOrders([{ type: "order_evacuation", zone_id: "A", exit_id: "E1", reason: "" }]);
    const [ok] = engine.applyOrders([
      { type: "stage_evacuation", zone_id: "B", exit_id: "E1", after_zone_id: "A", reason: "" },
    ]);
    expect(ok.accepted).toBe(true);
    const [ordered] = engine.applyOrders([
      { type: "stage_evacuation", zone_id: "A", exit_id: "E1", after_zone_id: "B", reason: "" },
    ]);
    expect(ordered.accepted).toBe(false);
  });
});

describe("live monitor", () => {
  it("stays quiet without change, then schedules a review", () => {
    const engine = engineWith([500, 600]);
    const baseline = takeBaseline(engine, 10);
    for (let i = 0; i < 5; i += 1) engine.step();
    expect(detectChanges(engine, baseline, 10, [])).toEqual([]);
    while (engine.minute < 30) engine.step();
    expect(detectChanges(engine, baseline, 10, [])).toEqual([
      "Scheduled review: 30 min without a decision.",
    ]);
  });

  it("wakes the agent when an unordered zone runs short of time or the fire grows", () => {
    // A's slack starts at 80 - 45 = 35 min ("watch") and drops under 30 ("soon") by T+6.
    const engine = engineWith([80, 600]);
    expect(threatTier(engine.orderSlackMinutes(0))).toBe("watch");
    const baseline = takeBaseline(engine, 10);
    for (let i = 0; i < 6; i += 1) engine.step();
    const reasons = detectChanges(engine, baseline, 10, []);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Zone A (A) has no order");

    const grown = detectChanges(engine, takeBaseline(engine, 10), 20, []);
    expect(grown).toEqual(["Fire grew from 10 ha to 20 ha since the last decision at T+6."]);
  });
});
