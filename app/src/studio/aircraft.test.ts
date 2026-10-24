import { describe, expect, it } from "vitest";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";
import { MOISTURE_PRESETS, simulateScheduledFireSpread } from "../fire/spread";
import type { ScheduledFireInput } from "../fire/scheduledTypes";
import {
  AIRCRAFT,
  airtankerCycleMinutes,
  coverageLevel,
  helicopterTurnaroundMinutes,
  lineFeetPerLoad,
  planAircraft,
  windEffect,
  type AirBase,
} from "./aircraft";
import { sunTimesUtc } from "./daylight";
import {
  DEFAULT_FIREFIGHTING,
  burnedAreas,
  planFirefighting,
  type FirefightingSettings,
} from "./firefighting";
import { MPH_PER_KNOT, type ApparatusCounts } from "./apparatus";

/** Flat GR2 grass on a 30 m grid at the equator (longitude 0). */
const SIZE = 121;
const CELL = 30;

function field(fuel = 102): LandscapeGrid {
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

function input(windSpeedMph: number, horizon = 180): ScheduledFireInput {
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

/** A helitack base and an air attack base about 22 km north of the fire. */
const BASES: AirBase[] = [
  { id: "hb", name: "Helitack", type: "HB", lon: 0.0162, lat: 0.2 },
  { id: "aab", name: "Air attack", type: "AAB", lon: 0.0162, lat: 0.2 },
];

const NOON_UTC = Date.UTC(2026, 2, 20, 12); // equinox noon at longitude 0
const EVENING_UTC = Date.UTC(2026, 2, 20, 21); // about three hours after sunset

function plan(counts: ApparatusCounts, windMph = 8, startMs = NOON_UTC, night = false) {
  const grid = field();
  const fire = input(windMph);
  const baseline = simulateScheduledFireSpread(grid, fire);
  return planAircraft({
    grid,
    input: fire,
    baseline,
    counts,
    bases: BASES,
    reportMinute: 0,
    startMs,
    nightHelicopters: night,
  });
}

describe("aircraft turnaround maths", () => {
  it("follows the data's helicopter dip formula and the airtanker reload round trip", () => {
    // 2 x (4 km / 185.2 km/h x 60) + 1.5 + 0.5 = 4.592 min at 100 kt.
    expect(helicopterTurnaroundMinutes(4, 100)).toBeCloseTo(2 * (4 / 185.2) * 60 + 2, 9);
    // S-2T at 230 kt, 60 km to reload: 2 x 60 / 425.96 x 60 + 10 = 26.90 min.
    expect(airtankerCycleMinutes(60, 230)).toBeCloseTo(2 * (60 / (230 * 1.852)) * 60 + 10, 9);
    expect(AIRCRAFT.airtanker_s2t.gallons).toBe(1200);
    expect(AIRCRAFT.helicopter_t2.gallons).toBe(300);
  });

  it("reads line per load from IASG Table 8 and coverage from Table 7", () => {
    expect(coverageLevel(1)).toBe(1);
    expect(coverageLevel(4)).toBe(6); // California chaparral
    expect(lineFeetPerLoad(1200, 1)).toBe(1289);
    expect(lineFeetPerLoad(1100, 2)).toBeCloseTo((607 + 687) / 2, 9);
    expect(lineFeetPerLoad(400, 1)).toBeCloseTo(1114 / 2, 9); // scaled below 800 gal
    expect(lineFeetPerLoad(6000, 1)).toBe(2 * 2078); // two 3,000 gal segments
  });
});

describe("aviation gating", () => {
  it("evaluates drops at 15 kt and finds them ineffective at 25 kt or more", () => {
    expect(windEffect(10)).toBe(1);
    expect(windEffect(20)).toBeCloseTo(0.5, 9);
    expect(windEffect(25)).toBe(0);
    const windy = plan({ airtanker_s2t: 1 }, 26 * MPH_PER_KNOT);
    expect(windy.drops).toHaveLength(0);
    expect(windy.aircraft[0].limitedBy).toMatch(/not effective/);
  });

  it("computes sunrise and sunset (NOAA) close to published times", () => {
    // Boulder, CO on 2021-12-30 (Marshall Fire): US Naval Observatory 07:21 and 16:44 MST.
    const sun = sunTimesUtc(Date.UTC(2021, 11, 30), 39.95, -105.17);
    const mst = (ms: number | null) => (ms! - Date.UTC(2021, 11, 30, 7)) / 60_000;
    expect(Math.abs(mst(sun.sunriseMs) - (7 * 60 + 21))).toBeLessThanOrEqual(3);
    expect(Math.abs(mst(sun.sunsetMs) - (16 * 60 + 44))).toBeLessThanOrEqual(3);
  });

  it("grounds fixed wing at night and helicopters unless night-capable", () => {
    const day = plan({ airtanker_s2t: 1, helicopter_t2: 1 });
    expect(day.aircraft.every((a) => a.drops > 0)).toBe(true);
    const night = plan({ airtanker_s2t: 1, helicopter_t2: 1 }, 8, EVENING_UTC);
    expect(night.drops).toHaveLength(0);
    expect(night.aircraft.every((a) => /night/.test(a.limitedBy ?? ""))).toBe(true);
    const nightHeli = plan({ airtanker_s2t: 1, helicopter_t2: 1 }, 8, EVENING_UTC, true);
    expect(nightHeli.aircraft[0].drops).toBe(0); // the S-2T still cannot fly
    expect(nightHeli.aircraft[1].drops).toBeGreaterThan(0);
  });

  it("times the first airtanker drop from reaction time and flight", () => {
    const one = plan({ airtanker_s2t: 1 });
    const km = one.aircraft[0].baseKm!;
    expect(km).toBeGreaterThan(20);
    // 15 min reaction (PMS 508) + distance at 230 kt.
    expect(one.drops[0].minute).toBeCloseTo(15 + (km / (230 * 1.852)) * 60, 1);
    // Then one drop per reload cycle.
    expect(one.drops[1].minute - one.drops[0].minute).toBeCloseTo(one.aircraft[0].cycleMinutes!, 1);
  });

  it("reports no base data instead of inventing a base", () => {
    const grid = field();
    const fire = input(8);
    const baseline = simulateScheduledFireSpread(grid, fire);
    const none = planAircraft({
      grid,
      input: fire,
      baseline,
      counts: { helicopter_t1: 1 },
      bases: null,
      reportMinute: 0,
      startMs: NOON_UTC,
      nightHelicopters: false,
    });
    expect(none.drops).toHaveLength(0);
    expect(none.aircraft[0].limitedBy).toMatch(/no base data/);
  });

  it("is deterministic", () => {
    const a = plan({ airtanker_s2t: 2, helicopter_t2: 1, air_attack: 1 });
    const b = plan({ airtanker_s2t: 2, helicopter_t2: 1, air_attack: 1 });
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
    expect(a.drops).toEqual(b.drops);
  });
});

describe("suppression never makes the fire bigger", () => {
  const settings = (resources: ApparatusCounts): FirefightingSettings => ({
    ...DEFAULT_FIREFIGHTING,
    enabled: true,
    fromStations: false,
    responseMinutes: 15,
    resources,
    startLocalIso: "2026-03-20T12:00Z",
  });

  it.each([
    ["first alarm", { ...DEFAULT_FIREFIGHTING.resources }],
    ["aircraft only", { airtanker_s2t: 2, helicopter_t1: 1 }],
    ["one hand crew", { hand_crew_t2: 1 }],
  ])("%s: every candidate burns no more than no crews, cell by cell", (_, resources) => {
    const grid = field();
    const fire = input(12);
    const baseline = simulateScheduledFireSpread(grid, fire);
    const result = planFirefighting(grid, fire, baseline, settings(resources), undefined, null, {
      bases: BASES,
    });
    const horizon = fire.settings.horizonMinutes;
    const free = burnedAreas(grid, baseline.arrivalMinutes, horizon).burnedSquareMeters;
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.burnedSquareMeters).toBeLessThanOrEqual(free);
    }
    const run = result.best!.run;
    for (let i = 0; i < run.arrivalMinutes.length; i += 1) {
      // Lines only delay fire: no cell burns earlier than in the free run.
      expect(run.arrivalMinutes[i]).toBeGreaterThanOrEqual(baseline.arrivalMinutes[i] - 1e-3);
    }
  });
});
