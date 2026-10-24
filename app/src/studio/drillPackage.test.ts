import { describe, expect, it } from "vitest";
import type { StudioRunResult } from "./contracts";
import { buildRunExport } from "./drillPackage";

/** 10 x 10 grid of 100 Mercator m; fire reaches a 2 x 2 block at rows 4-5, cols 6-7. */
function fakeResult(): StudioRunResult {
  const arrival = new Float32Array(100).fill(Infinity);
  arrival[4 * 10 + 6] = 0;
  arrival[4 * 10 + 7] = 5.5;
  arrival[5 * 10 + 6] = 7;
  arrival[5 * 10 + 7] = 500; // beyond the 60 min horizon -> null
  const ring = [
    [-122.6, 38.5],
    [-122.59, 38.5],
    [-122.59, 38.51],
    [-122.6, 38.5],
  ];
  return {
    scenario: {
      id: "s1",
      name: "Test",
      ignitions: [
        {
          id: "a",
          name: "F1",
          location: { latitude: 38.5, longitude: -122.6 },
          startMinute: 0,
          enabled: true,
        },
      ],
      settings: {
        windSpeedMph: 20,
        windFromDegrees: 45,
        moisture: { dead1h: 0.03, dead10h: 0.04, dead100h: 0.05, liveHerb: 0.3, liveWoody: 0.6 },
        midflameAdjustment: 0.4,
        stepMinutes: 5,
        horizonMinutes: 60,
      },
    },
    run: {
      model: { id: "rothermel-1972-mtt", version: "4.1.0" },
      input: {
        sources: [{ id: "a", location: { latitude: 38.5, longitude: -122.6 }, startMinute: 0 }],
      },
      frames: [0, 5, 10, 15, 60].map((minute) => ({
        elapsedMinutes: minute,
        perimeters:
          minute === 0
            ? []
            : [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] } }],
        reachedAreaSquareMeters: minute * 100,
      })),
      arrivalMinutes: arrival,
    },
    landscape: {
      width: 10,
      height: 10,
      originX: 1000,
      originY: 5000,
      cellSizeX: 100,
      cellSizeY: -100,
      groundCellSizeMeters: 78,
      cellMeters: 30,
      resampling: "native",
      elevationComplete: true,
    },
    boardId: null,
  } as unknown as StudioRunResult;
}

describe("buildRunExport", () => {
  it("crops the arrival grid to reached cells plus padding, in seconds", () => {
    const out = buildRunExport(fakeResult(), new Date("2026-10-24T20:00:31.500Z"));
    expect(out.ignition_time).toBe("2026-10-24T20:00:00Z");
    const grid = out.arrival_grid;
    // cols 6-7 padded by 2 -> 4..9; rows 4-5 -> 2..7.
    expect([grid.ncols, grid.nrows]).toEqual([6, 6]);
    expect(grid.origin_x).toBe(1000 + 4 * 100);
    expect(grid.origin_y).toBe(5000 - 2 * 100);
    expect(grid.arrival_s.length).toBe(36);
    const at = (row: number, col: number) => grid.arrival_s[(row - 2) * 6 + (col - 4)];
    expect([at(4, 6), at(4, 7), at(5, 6), at(5, 7), at(2, 4)]).toEqual([0, 330, 420, null, null]);
  });

  it("sends frames as [lon, lat] MultiPolygons with assumptions and enabled ignitions", () => {
    const out = buildRunExport(fakeResult(), new Date("2026-10-24T20:00:00Z"));
    expect(out.frames.map((f) => f.minute)).toEqual([0, 10, 60]);
    expect(out.frames[0].geometry).toBeNull();
    expect(out.frames[1].geometry?.coordinates[0][0][0]).toEqual([-122.6, 38.5]);
    expect(out.ignitions).toEqual([
      { id: "a", name: "F1", coord: [-122.6, 38.5], start_minute: 0 },
    ]);
    expect(out.assumptions.wind_from_deg).toBe(45);
  });
});
