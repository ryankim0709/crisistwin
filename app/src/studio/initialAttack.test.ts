import { describe, expect, it } from "vitest";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { MOISTURE_PRESETS, simulateScheduledFireSpread } from "../fire/spread";
import type { ScheduledFireInput } from "../fire/scheduledTypes";
import { DEFAULT_FIREFIGHTING, type FirefightingSettings } from "./firefighting";
import { ellipsePerimeter, estimateInitialAttack, runInitialAttack } from "./initialAttack";

/** Flat grass (GR4 by default) on a 30 m grid at the equator. */
const SIZE = 121;
const CELL = 30;

function field(fuel = 104): LandscapeGrid {
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
  const [longitude, latitude] = mercatorToLonLat(60 * CELL, -60 * CELL);
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
    sources: [{ id: "F", location: { latitude, longitude }, startMinute: 0 }],
    frameMinutes,
  };
}

const crews = (patch: Partial<FirefightingSettings>): FirefightingSettings => ({
  ...DEFAULT_FIREFIGHTING,
  enabled: true,
  ...patch,
});

describe("initial attack estimate", () => {
  it("uses the circle's perimeter for a ratio of 1", () => {
    const area = Math.PI * 100 * 100;
    expect(ellipsePerimeter(area, 1)).toBeCloseTo(2 * Math.PI * 100, 6);
    expect(ellipsePerimeter(area, 3)).toBeGreaterThan(2 * Math.PI * 100);
    expect(ellipsePerimeter(0, 3)).toBe(0);
  });

  it("puts out a small grass fire with enough crews, and the run stops growing", () => {
    const grid = field();
    const run = simulateScheduledFireSpread(grid, input(5));
    const settings = crews({ handCrews: 4, engines: 4, dozers: 1, responseMinutes: 15 });
    const { estimate, run: attacked } = runInitialAttack(grid, input(5), run, settings);
    const out = estimate.fires[0].outMinute;
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThanOrEqual(15);
    const free = run.frames[run.frames.length - 1].reachedAreaSquareMeters;
    const held = attacked.frames[attacked.frames.length - 1].reachedAreaSquareMeters;
    expect(held).toBeLessThan(free);
    // Nothing burns after the fire is out.
    for (const minutes of attacked.arrivalMinutes) {
      if (Number.isFinite(minutes)) expect(minutes).toBeLessThanOrEqual(out! + 1e-6);
    }
  });

  it("takes longer with fewer crews, or never", () => {
    const grid = field();
    const run = simulateScheduledFireSpread(grid, input(5));
    const many = estimateInitialAttack(run, crews({ handCrews: 10, engines: 10, dozers: 4 }));
    const few = estimateInitialAttack(run, crews({ handCrews: 1, engines: 0, dozers: 0 }));
    expect(many.fires[0].outMinute).not.toBeNull();
    if (few.fires[0].outMinute !== null) {
      expect(few.fires[0].outMinute).toBeGreaterThan(many.fires[0].outMinute!);
    }
  });

  it("does not attack a head flame longer than the crews can hold", () => {
    const grid = field(107); // GR7: about 12 ft head flame at 20 mph
    const run = simulateScheduledFireSpread(grid, input(20, 60));
    const estimate = estimateInitialAttack(run, crews({ handCrews: 20, engines: 20, dozers: 20 }));
    expect(estimate.fires[0].headFlameFeet).toBeGreaterThan(estimate.holdsFlameLengthFeet);
    expect(estimate.fires[0].attackable).toBe(false);
    expect(estimate.fires[0].outMinute).toBeNull();
    expect(estimate.outFromMinuteBySource[0]).toBe(Infinity);
  });
});
