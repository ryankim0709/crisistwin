import { describe, expect, it } from "vitest";
import type { Arc, DispatchArea, LonLat, RoadEdge } from "../dispatch/area";
import type { FireExposure } from "../dispatch/fireExposure";
import { simulateEvacuation, type EvacuationInputs, type EvacuationSummary } from "./evacuation";
import { compareSummaries, optimizeEvacuation } from "./evacuationOptimizer";

/** [from, to, metres, capacity vph]; 36 km/h is 10 m/s. */
type EdgeSpec = [number, number, number, number];

/** Synthetic area: zones (id, node, homes) with 1.5 vehicles per home. */
function buildArea(
  nodes: LonLat[],
  spec: EdgeSpec[],
  zones: [string, number, number][],
  exits: [string, number][],
): DispatchArea {
  const edges: RoadEdge[] = spec.map(([from, to, lengthMeters, capacityVph], index) => ({
    index,
    from,
    to,
    lengthMeters,
    roadClass: "secondary",
    speedKph: 36,
    capacityVph,
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
  let firstHome = 0;
  const areaZones = zones.map(([id, node, homes]) => {
    const zone = {
      id,
      name: `Zone ${id}`,
      node,
      homes,
      vehicles: homes * 1.5,
      centroid: nodes[node],
      polygon: [],
      firstHome,
    };
    firstHome += homes;
    return zone;
  });
  return {
    id: "test",
    name: "Test area",
    bbox: [-0.05, -0.05, 0.05, 0.05],
    attribution: "synthetic",
    osmTimestamp: null,
    notes: [],
    nodes,
    edges,
    outgoing,
    zones: areaZones,
    homes: areaZones.flatMap((zone, index) =>
      Array.from({ length: zone.homes }, () => ({ position: zone.centroid, zone: index })),
    ),
    exits: exits.map(([id, node]) => ({ id, name: `Exit ${id}`, node, road: "" })),
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

/**
 * Zones A (node 0) and B (node 1), 100 homes each, each with its own wide road out (XA, XB).
 * Both can also reach a narrow road (4-5, 300 vph) to XS through junction 4, and B has a long
 * wide road to XL. Closing the two own roads forces both zones onto the narrow one.
 */
function forkArea(): DispatchArea {
  return buildArea(
    [
      [0, 0],
      [0, 0.01],
      [-0.01, 0],
      [-0.01, 0.01],
      [0.01, 0.005],
      [0.02, 0.005],
      [0, 0.03],
    ],
    [
      [0, 2, 800, 1800], // 0: A's own road
      [1, 3, 800, 1800], // 1: B's own road
      [0, 4, 500, 1800],
      [1, 4, 500, 1800],
      [4, 5, 500, 300], // 4: narrow shared road
      [1, 6, 4000, 1800], // 5: B's long road
    ],
    [
      ["A", 0, 100],
      ["B", 1, 100],
    ],
    [
      ["XA", 2],
      ["XB", 3],
      ["XS", 5],
      ["XL", 6],
    ],
  );
}

/** Zones A (node 0) and B (node 1) share junction 2 and one narrow road (2-3) to exit X. */
function singleRoadArea(): DispatchArea {
  return buildArea(
    [
      [0, 0],
      [0, 0.01],
      [0.01, 0.005],
      [0.02, 0.005],
    ],
    [
      [0, 2, 500, 1800],
      [1, 2, 500, 1800],
      [2, 3, 500, 300],
    ],
    [
      ["A", 0, 100],
      ["B", 1, 100],
    ],
    [["X", 3]],
  );
}

const HORIZON = 180;

function inputsFor(area: DispatchArea, closed: number[] = [], exposure = noFire(area)) {
  return {
    area,
    exposure,
    horizonMinutes: HORIZON,
    closedEdges: new Set(closed),
    orderMinute: 0,
  } satisfies EvacuationInputs;
}

function summary(
  caught: number,
  safe: number,
  hours: number,
  allClearMinute: number | null,
): EvacuationSummary {
  const final = { homes: 10, vehicles: 15, notOrdered: 0, waiting: 0, onRoad: 0, safe, caught };
  return {
    totalsByMinute: [final],
    final,
    cutOffZones: 0,
    cutOffHomes: 0,
    allClearMinute,
    householdHoursEvacuating: hours,
    stagedHomes: 0,
  };
}

describe("compareSummaries", () => {
  it("orders by caught, then safe, then household-hours, then all-clear", () => {
    expect(compareSummaries(summary(1, 9, 1, 10), summary(2, 8, 1, 10))).toBeLessThan(0);
    expect(compareSummaries(summary(1, 9, 5, 90), summary(1, 8, 1, 10))).toBeLessThan(0);
    expect(compareSummaries(summary(1, 9, 1, 90), summary(1, 9, 2, 10))).toBeLessThan(0);
    expect(compareSummaries(summary(1, 9, 1, 10), summary(1, 9, 1, 20))).toBeLessThan(0);
    expect(compareSummaries(summary(1, 9, 1, 20), summary(1, 9, 1, 10))).toBeGreaterThan(0);
  });

  it("treats a missing all-clear as worst and tiny hour differences as equal", () => {
    expect(compareSummaries(summary(0, 10, 1, 170), summary(0, 10, 1, null))).toBeLessThan(0);
    expect(compareSummaries(summary(0, 10, 1, null), summary(0, 10, 1, 170))).toBeGreaterThan(0);
    expect(compareSummaries(summary(0, 10, 1, null), summary(0, 10, 1, null))).toBe(0);
    expect(compareSummaries(summary(0, 10, 1, 50), summary(0, 10, 1 + 1e-9, 50))).toBe(0);
  });
});

describe("optimizeEvacuation", () => {
  it("returns the baseline when there is only one exit and nothing to stage", () => {
    const area = singleRoadArea();
    const result = optimizeEvacuation(inputsFor(area));
    expect(result.improved).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.best).toBe(result.baseline);
    expect(result.evaluations).toBe(1);
    expect(result.tried.map((candidate) => candidate.label)).toEqual([
      "Fastest exit (current policy)",
    ]);
    expect(result.baseline.summary).toEqual(simulateEvacuation(inputsFor(area)));
  });

  it("re-optimises when closures change: a closure that forces two zones onto one narrow road moves one", () => {
    const area = forkArea();
    const open = optimizeEvacuation(inputsFor(area));
    expect(open.improved).toBe(false);
    expect(open.changes).toEqual([]);
    expect(open.best.plan).toEqual({ exits: {}, after: {} });

    const closedInputs = inputsFor(area, [0, 1]);
    const closed = optimizeEvacuation(closedInputs);
    // Fastest-exit policy: both zones onto the narrow road to XS.
    expect(closed.changes.every((change) => change.fastestExitId === "XS")).toBe(true);
    expect(closed.improved).toBe(true);
    expect(compareSummaries(closed.best.summary, closed.baseline.summary)).toBeLessThan(0);
    expect(closed.best.summary.householdHoursEvacuating).toBeLessThan(
      closed.baseline.summary.householdHoursEvacuating,
    );
    expect(closed.best.plan).not.toEqual(open.best.plan);
    expect(closed.changes).toHaveLength(1);
    const [change] = closed.changes;
    expect(change.exitId === "XL" || change.afterZoneId !== null).toBe(true);
    expect(change.homes).toBe(100);
    // Labels and order: best first, and the numbers are the engine's for that plan.
    expect(closed.tried[0]).toBe(closed.best);
    expect(closed.tried.map((candidate) => candidate.id)).toContain("baseline");
    expect(closed.tried.length).toBeLessThanOrEqual(6);
    expect(closed.best.summary).toEqual(
      simulateEvacuation({ ...closedInputs, plan: closed.best.plan }),
    );
  });

  it("stages a zone outside the fire path behind a threatened zone on a shared road", () => {
    const area = singleRoadArea();
    const exposure = noFire(area);
    exposure.zoneContact[0] = 40;
    exposure.zoneCore[0] = 50;
    for (let h = 0; h < 100; h += 1) exposure.homeArrival[h] = 50;
    const inputs = inputsFor(area, [], exposure);
    const result = optimizeEvacuation(inputs);
    expect(result.baseline.summary.final.caught).toBeGreaterThan(0);
    expect(result.improved).toBe(true);
    expect(result.best.summary.final.caught).toBeLessThan(result.baseline.summary.final.caught);
    expect(result.changes).toEqual([
      {
        zoneId: "B",
        zoneName: "Zone B",
        homes: 100,
        fastestExitId: "X",
        exitId: "X",
        afterZoneId: "A",
      },
    ]);
    expect(result.best.label).toBe("Staged waves");
  });

  it("is deterministic", () => {
    const area = forkArea();
    const a = optimizeEvacuation(inputsFor(area, [0, 1]));
    const b = optimizeEvacuation(inputsFor(area, [0, 1]));
    expect(b).toEqual(a);
  });

  it("respects the evaluation budget and reports progress after each run", () => {
    const area = forkArea();
    for (const maxEvaluations of [1, 2, 3]) {
      const progress: [number, number][] = [];
      const result = optimizeEvacuation(inputsFor(area, [0, 1]), {
        maxEvaluations,
        onProgress: (done, total) => progress.push([done, total]),
      });
      expect(result.evaluations).toBeLessThanOrEqual(maxEvaluations);
      expect(progress.map(([done]) => done)).toEqual(
        Array.from({ length: result.evaluations }, (_, i) => i + 1),
      );
      for (const [done, total] of progress) expect(done).toBeLessThanOrEqual(total);
    }
    const baselineOnly = optimizeEvacuation(inputsFor(area, [0, 1]), { maxEvaluations: 1 });
    expect(baselineOnly.improved).toBe(false);
    expect(baselineOnly.best).toBe(baselineOnly.baseline);
  });

  it("ignores a plan already in the inputs for its baseline", () => {
    const area = forkArea();
    const inputs = inputsFor(area, [0, 1]);
    const plain = optimizeEvacuation(inputs);
    const withPlan = optimizeEvacuation({ ...inputs, plan: { exits: { A: "XL" }, after: {} } });
    expect(withPlan.baseline.summary).toEqual(plain.baseline.summary);
    expect(withPlan.best.plan).toEqual(plain.best.plan);
  });
});
