import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "./area";
import { DispatchEngine } from "./engine";
import {
  ENGINE_LINE_METERS_PER_MINUTE,
  projectOutMinute,
  type FireAreaFrame,
  type FireTarget,
} from "./fireAttack";
import type { FireExposure } from "./fireExposure";

const HORIZON = 240;

/** Zone A (node 0) and zone B (node 1) drive through node 2 to exit X (node 3); station at 3. */
function area(): DispatchArea {
  const nodes: LonLat[] = [
    [-122.0, 37.0],
    [-122.0, 37.01],
    [-121.99, 37.005],
    [-121.98, 37.005],
  ];
  const edges: RoadEdge[] = (
    [
      [0, 2],
      [1, 2],
      [2, 3],
    ] as [number, number][]
  ).map(([from, to], index) => ({
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
  const zone = (id: string, node: number) => ({
    id,
    name: `Zone ${id}`,
    node,
    homes: 2,
    vehicles: 3,
    centroid: nodes[node],
    polygon: [nodes[node]],
    firstHome: node * 2,
  });
  return {
    id: "attack",
    name: "Attack",
    bbox: [-122.01, 36.99, -121.97, 37.02],
    attribution: "synthetic",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    zones: [zone("A", 0), zone("B", 1)],
    homes: [0, 0, 1, 1].map((z) => ({ position: nodes[z], zone: z })),
    exits: [{ id: "X", name: "Exit", node: 3, road: "Main St" }],
    stations: [
      {
        id: "S1",
        name: "Station 1",
        node: 3,
        location: nodes[3],
        approachMeters: 0,
        units: [{ id: "E1", type: "engine" }],
      },
    ],
  };
}

function exposure(a: DispatchArea, contact: [number, number]): FireExposure {
  return {
    nodeArrival: new Float64Array(a.nodes.length).fill(Infinity),
    edgeArrival: new Float64Array(a.edges.length).fill(Infinity),
    homeArrival: new Float64Array(a.homes.length).fill(Infinity),
    zoneContact: Float64Array.from(contact),
    zoneCore: new Float64Array(a.zones.length).fill(Infinity),
  };
}

function target(overrides: Partial<FireTarget> = {}): FireTarget {
  return {
    id: "F1",
    name: "House fire",
    location: [-121.98, 37.005],
    ignitedMinute: 0,
    headFlameFeet: 3,
    lengthToBreadth: 1,
    workPerMeter: 1,
    notAttackable: null,
    directBlocked: null,
    structureFire: false,
    ...overrides,
  };
}

/** One fire growing by 1 ha per hour. */
const FRAMES: FireAreaFrame[] = [0, 60, 120, 180, 240].map((minute) => ({
  minute,
  areaBySource: [(minute / 60) * 10_000],
}));

describe("direct attack estimate", () => {
  it("puts a slow fire out sooner with more engines, and never without any", () => {
    const one = projectOutMinute(target(), FRAMES, 0, 0, 0, [0], HORIZON);
    const two = projectOutMinute(target(), FRAMES, 0, 0, 0, [0, 0], HORIZON);
    // A circle growing 10,000/60 m²/min is ringed by one engine's line at about T+21.
    expect(one).toBe(21);
    expect(two).not.toBeNull();
    expect(two!).toBeLessThan(one!);
    expect(projectOutMinute(target(), FRAMES, 0, 0, 0, [], HORIZON)).toBeNull();
  });

  it("cannot attack a fire engines cannot hold", () => {
    const crowning = target({ headFlameFeet: Infinity, directBlocked: "it is crowning" });
    expect(projectOutMinute(crowning, FRAMES, 0, 0, 0, [0, 0, 0], HORIZON)).toBeNull();
  });
});

describe("engines attacking a fire", () => {
  function engineWith(fire: FireTarget, contact: [number, number] = [90, Infinity]) {
    const a = area();
    const engine = new DispatchEngine(a, exposure(a, contact), HORIZON, []);
    engine.setFires([fire], FRAMES);
    return engine;
  }

  it("builds line on scene and puts the fire out when the estimate said", () => {
    const engine = engineWith(target());
    const [outcome] = engine.applyOrders([
      { type: "attack_fire", unit_id: "E1", fire_id: "F1", reason: "" },
    ]);
    expect(outcome.accepted).toBe(true);
    const projected = engine.projectedOutMinute(0);
    // T+21 for an engine working from T+0; it first waits out the 80 s turnout, arrives at
    // T+2 and works from the next minute, and the fire keeps growing meanwhile.
    expect(projected).toBe(25);
    expect(engine.units[0].status).toBe("en_route"); // not on scene before turnout
    expect(engine.attackOptions(0, 4)).toEqual([]); // the only engine is already on it
    let onScene: number | null = null;
    while (engine.fires[0].outMinute === null && !engine.finished) {
      engine.step();
      if (onScene === null && engine.units[0].status === "on_scene") onScene = engine.minute;
    }
    expect(onScene).toBe(2);
    expect(engine.fires[0].outMinute).toBe(projected);
    // Building from the minute after it arrives at T+2.
    expect(engine.fires[0].lineMeters).toBeCloseTo((25 - 2) * ENGINE_LINE_METERS_PER_MINUTE);
    expect(engine.alerts.some((alert) => alert.type === "fire_out")).toBe(true);
    expect(engine.units[0].task).toBeNull();
  });

  it("offers what-if options and rejects fires that cannot be attacked", () => {
    expect(engineWith(target()).attackOptions(0, 4)).toEqual([{ unitIds: ["E1"], outMinute: 25 }]);
    const crowning = engineWith(target({ directBlocked: "it is crowning" }));
    expect(crowning.attackOptions(0, 4)).toEqual([]);
    const [rejected] = crowning.applyOrders([
      { type: "attack_fire", unit_id: "E1", fire_id: "F1", reason: "" },
    ]);
    expect(rejected.accepted).toBe(false);
    const later = engineWith(target({ ignitedMinute: 30 }));
    expect(
      later.applyOrders([{ type: "attack_fire", unit_id: "E1", fire_id: "F1", reason: "" }])[0]
        .accepted,
    ).toBe(false);
  });

  it("flanks a fire too hot to attack directly, and releases crews once the line holds it", () => {
    const engine = engineWith(target({ directBlocked: "its head flame is too long" }));
    const [direct] = engine.applyOrders([
      { type: "attack_fire", unit_id: "E1", fire_id: "F1", tactic: "direct", reason: "" },
    ]);
    expect(direct.accepted).toBe(false);
    const [flank] = engine.applyOrders([
      { type: "attack_fire", unit_id: "E1", fire_id: "F1", tactic: "flank", reason: "" },
    ]);
    expect(flank.accepted).toBe(true);
    expect(engine.fires[0].tactic).toBe("flank");
    expect(engine.linesDirty).toBe(true);
    // The session would re-plan and re-solve; here the run says the line holds it at T+10.
    engine.setFireLines([null]);
    engine.setExposure(engine.exposure, FRAMES, [10]);
    while (engine.minute < 10) engine.step();
    expect(engine.alerts.some((alert) => alert.type === "fire_held")).toBe(true);
    expect(engine.fires[0].heldAnnounced).toBe(true);
    expect(engine.fireBurning(0)).toBe(false);
    expect(engine.units[0].task).toBeNull();
    // Releasing crews from a held fire does not ask for another re-plan.
    expect(engine.linesDirty).toBe(false);
  });

  it("switches every crew on a fire to a new tactic", () => {
    const engine = engineWith(target());
    engine.applyOrders([
      { type: "attack_fire", unit_id: "E1", fire_id: "F1", tactic: "direct", reason: "" },
    ]);
    const [switched] = engine.applyOrders([
      { type: "attack_fire", unit_id: "E1", fire_id: "F1", tactic: "indirect", reason: "" },
    ]);
    expect(switched.accepted).toBe(true);
    expect(switched.note).toMatch(/switch to indirect/);
    expect(engine.fires[0].tactic).toBe("indirect");
    expect(engine.linesDirty).toBe(true);
  });

  it("stands staged zones down when the fire that threatened them is out", () => {
    const engine = engineWith(target(), [90, 150]);
    engine.applyOrders([
      { type: "order_evacuation", zone_id: "A", exit_id: "X", reason: "" },
      { type: "stage_evacuation", zone_id: "B", exit_id: "X", after_zone_id: "A", reason: "" },
    ]);
    const a = engine.area;
    engine.setExposure(exposure(a, [90, Infinity]), FRAMES);
    expect(engine.zones[1].stage).toBeNull();
    expect(engine.zoneImpact(1)).toBe("outside");
    expect(engine.notices.at(-1)?.kind).toBe("all_clear");
    // The zone already ordered keeps going.
    expect(engine.zones[0].status).toBe("ordered");
  });
});
