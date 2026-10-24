import { describe, expect, it } from "vitest";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";
import { MOISTURE_PRESETS, simulateScheduledFireSpread, type ControlLines } from "./spread";
import type { ScheduledFireInput } from "./scheduledTypes";

/** Flat GR4 grass (6.2 ft head flame at 20 mph, dry) on a 30 m grid at the equator (Mercator metres = ground metres). */
const SIZE = 81;
const CELL = 30;
const CENTRE = 40;

function grassField(): LandscapeGrid {
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
    fuelCodes: new Int16Array(count).fill(104),
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

function input(windSpeedMph: number): ScheduledFireInput {
  const [longitude, latitude] = mercatorToLonLat(CENTRE * CELL, -CENTRE * CELL);
  const dry = MOISTURE_PRESETS.find((preset) => preset.id === "dry")!;
  return {
    settings: {
      windSpeedMph,
      windFromDegrees: 270, // from the west: the head runs east (+x)
      moisture: { ...dry.moisture },
      midflameAdjustment: 0.5,
      stepMinutes: 15,
      horizonMinutes: 120,
      spotting: { enabled: false, maxDistanceMeters: 0 },
    },
    sources: [{ id: "F", location: { latitude, longitude }, startMinute: 0 }],
    frameMinutes: [0, 120],
  };
}

const cell = (x: number, y: number) => y * SIZE + x;

/** A straight line: a column at `x` (for the head) or a row at `y` (for a flank). */
function line(
  kind: "column" | "row",
  at: number,
  holdFromMinute: number,
  holdsFeet: number,
): ControlLines {
  const holdFrom = new Float32Array(SIZE * SIZE).fill(Number.POSITIVE_INFINITY);
  const holds = new Float32Array(SIZE * SIZE);
  for (let k = 0; k < SIZE; k += 1) {
    const c = kind === "column" ? cell(at, k) : cell(k, at);
    holdFrom[c] = holdFromMinute;
    holds[c] = holdsFeet;
  }
  return { holdFromMinute: holdFrom, holdsFlameLengthFeet: holds };
}

/** Burned cells beyond the line (east of a column, north of a row). */
function burnedBeyond(arrival: Float32Array, kind: "column" | "row", at: number): number {
  let n = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const beyond = kind === "column" ? x > at : y < at;
      if (beyond && arrival[cell(x, y)] <= 120) n += 1;
    }
  }
  return n;
}

describe("control lines in the fire solver", () => {
  const grid = grassField();

  it("burns past the head without a line (sanity)", () => {
    const run = simulateScheduledFireSpread(grid, input(10));
    expect(burnedBeyond(run.arrivalMinutes, "column", CENTRE + 6)).toBeGreaterThan(0);
  });

  it("stops the fire at a line built in time that holds its flames", () => {
    const run = simulateScheduledFireSpread(grid, input(10), line("column", CENTRE + 6, 0, 100));
    expect(burnedBeyond(run.arrivalMinutes, "column", CENTRE + 6)).toBe(0);
    // The line cells themselves never burn.
    for (let y = 0; y < SIZE; y += 1)
      expect(run.arrivalMinutes[cell(CENTRE + 6, y)]).toBe(Infinity);
  });

  it("is breached where the flame is longer than the line holds", () => {
    const run = simulateScheduledFireSpread(grid, input(10), line("column", CENTRE + 6, 0, 0));
    // The fire burns into the line and carries on beyond it.
    expect(run.arrivalMinutes[cell(CENTRE + 6, CENTRE)]).toBeLessThan(120);
    expect(burnedBeyond(run.arrivalMinutes, "column", CENTRE + 6)).toBeGreaterThan(0);
  });

  it("does nothing where the fire gets there before the line is built", () => {
    const free = simulateScheduledFireSpread(grid, input(10));
    const late = free.arrivalMinutes[cell(CENTRE + 6, CENTRE)] + 1;
    const run = simulateScheduledFireSpread(grid, input(10), line("column", CENTRE + 6, late, 100));
    expect(run.arrivalMinutes[cell(CENTRE + 10, CENTRE)]).toBeCloseTo(
      free.arrivalMinutes[cell(CENTRE + 10, CENTRE)],
      3,
    );
  });

  it("holds on the flank with a limit the head breaks through", () => {
    const wind = 20;
    const head = simulateScheduledFireSpread(grid, input(wind), line("column", CENTRE + 4, 0, 4));
    const flank = simulateScheduledFireSpread(grid, input(wind), line("row", CENTRE - 3, 0, 4));
    expect(burnedBeyond(head.arrivalMinutes, "column", CENTRE + 4)).toBeGreaterThan(0);
    expect(burnedBeyond(flank.arrivalMinutes, "row", CENTRE - 3)).toBe(0);
  });

  it("never lets fire arrive earlier anywhere (surface fire only)", () => {
    const free = simulateScheduledFireSpread(grid, input(15));
    const run = simulateScheduledFireSpread(grid, input(15), line("row", CENTRE - 2, 5, 4));
    for (let i = 0; i < free.arrivalMinutes.length; i += 1) {
      expect(run.arrivalMinutes[i]).toBeGreaterThanOrEqual(free.arrivalMinutes[i] - 1e-3);
    }
  });
});
