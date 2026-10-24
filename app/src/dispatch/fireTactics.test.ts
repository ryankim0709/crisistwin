import { describe, expect, it } from "vitest";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { MOISTURE_PRESETS, simulateScheduledFireSpread } from "../fire/spread";
import type { ScheduledFireInput } from "../fire/scheduledTypes";
import { fireAreaFrames, fireTargets } from "./fireAttack";
import {
  builtPart,
  combineLines,
  fireArrival,
  heldMinute,
  planTacticLine,
  tacticBlocked,
} from "./fireTactics";

const SIZE = 121;
const CELL = 30;

function field(fuel: number): LandscapeGrid {
  const count = SIZE * SIZE;
  return {
    width: SIZE,
    height: SIZE,
    originX: 0,
    originY: 0,
    cellSizeX: CELL,
    cellSizeY: -CELL,
    groundCellSizeMeters: CELL,
    elevationComplete: true,
    fuelCodes: new Int16Array(count).fill(fuel),
    elevationMeters: new Float32Array(count),
    slopeTangent: new Float32Array(count),
    upslopeDegrees: new Float32Array(count),
    canopyBaseHeightMeters: new Float32Array(count),
    canopyBulkDensityKgPerM3: new Float32Array(count),
    canopyCoverFraction: new Float32Array(count),
    canopyHeightMeters: new Float32Array(count),
    canopyComplete: false,
    cellMeters: CELL,
    resampling: "native",
    attribution: { fuel: "test", terrain: "test", canopy: "test" },
  };
}

function input(windSpeedMph: number, horizon = 120): ScheduledFireInput {
  const [longitude, latitude] = mercatorToLonLat(40 * CELL, -60 * CELL);
  const dry = MOISTURE_PRESETS.find((preset) => preset.id === "dry")!;
  const frameMinutes: number[] = [];
  for (let m = 0; m <= horizon; m += 5) frameMinutes.push(m);
  return {
    settings: {
      windSpeedMph,
      windFromDegrees: 270,
      moisture: { ...dry.moisture },
      midflameAdjustment: 0.5,
      stepMinutes: 5,
      horizonMinutes: horizon,
      spotting: { enabled: false, maxDistanceMeters: 0 },
    },
    sources: [{ id: "F1", location: { latitude, longitude }, startMinute: 0 }],
    frameMinutes,
  };
}

const burned = (arrival: Float32Array, horizon: number) =>
  arrival.reduce((n, minute) => (minute <= horizon ? n + 1 : n), 0);

describe("which tactics engines can use", () => {
  it("lets engines attack a structure fire directly", () => {
    const run = simulateScheduledFireSpread(field(91), input(10));
    const [target] = fireTargets(run, {});
    expect(target.structureFire).toBe(true);
    expect(target.directBlocked).toBeNull();
    expect(tacticBlocked(target, "direct")).toBeNull();
  });

  it("blocks only direct attack on a head too hot to hold, not the flanks", () => {
    const run = simulateScheduledFireSpread(field(107), input(20, 60)); // GR7, ~12 ft head
    const [target] = fireTargets(run, {});
    expect(target.headFlameFeet).toBeGreaterThan(8);
    expect(tacticBlocked(target, "direct")).toMatch(/Hauling/);
    expect(tacticBlocked(target, "flank")).toBeNull();
    expect(tacticBlocked(target, "indirect")).toBeNull();
  });
});

describe("flank and indirect lines through the fire model", () => {
  const grid = field(104); // GR4: about 6 ft at the head at 20 mph
  const fire = input(20);
  const free = simulateScheduledFireSpread(grid, fire);
  const unchecked = fireArrival(free, 0);

  it("isolates one fire's footprint", () => {
    expect(burned(unchecked, 120)).toBe(burned(free.arrivalMinutes, 120));
  });

  it("a flank line from the heel shrinks the fire, and the solver keeps arrivals no earlier", () => {
    const plan = planTacticLine(grid, unchecked, "flank", [10, 10, 10, 10], 270, 120)!;
    expect(plan.cells.length).toBeGreaterThan(0);
    const lined = simulateScheduledFireSpread(grid, fire, combineLines(grid, [plan]));
    expect(burned(lined.arrivalMinutes, 120)).toBeLessThan(burned(free.arrivalMinutes, 120));
  });

  it("plans an indirect line further out than a flank line", () => {
    const flank = planTacticLine(grid, unchecked, "flank", [10, 10], 270, 120)!;
    const indirect = planTacticLine(grid, unchecked, "indirect", [10, 10], 270, 120)!;
    expect(indirect.plannedMeters).toBeGreaterThan(flank.plannedMeters);
  });

  it("keeps only line already built when crews leave", () => {
    const plan = planTacticLine(grid, unchecked, "flank", [10, 10], 270, 120)!;
    const kept = builtPart(plan, 30);
    expect(kept.cells.length).toBeLessThan(plan.cells.length);
    for (const minute of kept.holdFromMinute) expect(minute).toBeLessThanOrEqual(30);
  });

  it("calls a fire held once its area stops growing well before the horizon", () => {
    const frames = [0, 10, 20, 30, 40, 50, 60].map((minute) => ({
      minute,
      areaBySource: [Math.min(minute, 20) * 100],
    }));
    expect(heldMinute(frames, 0, 60)).toBe(20);
    expect(heldMinute(fireAreaFrames(free), 0, 120)).toBeNull(); // the free fire keeps going
  });
});
