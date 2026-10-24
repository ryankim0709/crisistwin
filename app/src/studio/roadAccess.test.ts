import { describe, expect, it } from "vitest";
import { ACCESS_CLASSES, type AccessClass } from "./apparatus";
import { normaliseHighway, parseLengthMeters, polylineGradePercent, roadAccess } from "./roadAccess";
import { mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";

/**
 * Synthetic edges against every class. Expected results were produced by the reference
 * implementation, tools/suppression_data.py road_access(), on 2026-10-24 (rule, and speed in
 * km/h when passable), so the TypeScript port is checked for parity, class by class.
 */
const PARITY: [Record<string, string>, number, string[]][] = [
  [{"highway": "residential"}, 0, ["R11:35.0", "R11:35.0", "R11:35.0", "R11:35.0", "R11:35.0"]],
  [{"highway": "residential"}, 18, ["R05", "R11:14.0", "R11:14.0", "R05", "R05"]],
  [{"highway": "track", "surface": "dirt"}, 10, ["R04", "R12:9.6", "R12:9.6", "R04", "R12:9.6"]],
  [{"highway": "track", "surface": "dirt"}, 22, ["R04", "R06", "R12:4.8", "R04", "R06"]],
  [{"highway": "track", "tracktype": "grade4"}, 5, ["R04", "R04", "R12:7.2", "R04", "R04"]],
  [{"highway": "track", "surface": "gravel"}, 7, ["R04", "R12:18.0", "R12:18.0", "R04", "R12:18.0"]],
  [{"highway": "service", "width": "2.8"}, 0, ["R07", "R07", "R07", "R07", "R07"]],
  [{"highway": "tertiary", "maxheight": "12'6\""}, 0, ["R08", "R08", "R08", "R08", "R08"]],
  [{"highway": "service", "bridge": "yes"}, 0, ["R09", "R11:15.0", "R11:15.0", "R09", "R09"]],
  [{"highway": "unclassified", "smoothness": "bad"}, 0, ["R03", "R11:27.0", "R11:27.0", "R03", "R11:27.0"]],
  [{"highway": "primary", "maxweight": "18"}, 0, ["R09", "R11:70.0", "R11:70.0", "R09", "R09"]],
  [{"highway": "footway"}, 0, ["R01", "R01", "R01", "R01", "R01"]],
  [{"highway": "residential", "motor_vehicle": "no"}, 0, ["R02", "R02", "R02", "R02", "R02"]],
  [{"highway": "tertiary", "lanes": "1", "maxspeed": "25 mph"}, 13, ["R11:14.5", "R11:14.5", "R11:14.5", "R05", "R11:14.5"]]
];

const show = (tags: Record<string, string>, grade: number, vehicle: AccessClass) => {
  const r = roadAccess(tags, grade, vehicle);
  return r.passable ? `${r.rule}:${r.speedKmh!.toFixed(1)}` : r.rule;
};

describe("road access R01-R12 per apparatus class", () => {
  it.each(PARITY)("%j at %d%% matches the Python reference", (tags, grade, expected) => {
    expect(ACCESS_CLASSES.map((vehicle) => show(tags, grade, vehicle))).toEqual(expected);
  });

  it("keeps a structure engine off a narrow, steep dirt road that a Type 3 can take", () => {
    const dirt = { highway: "track", surface: "dirt", width: "3.2" };
    expect(roadAccess(dirt, 12, "engine_t1_t2")).toMatchObject({ passable: false, rule: "R04" });
    const t3 = roadAccess(dirt, 12, "engine_t3");
    expect(t3.passable).toBe(true);
    // grade3 inferred from dirt: 20 km/h x 0.8 (grade over 8%) x 0.6 (single lane) = 9.6 km/h.
    expect(t3.speedKmh).toBeCloseTo(9.6, 6);
    expect(t3.notes.join(" ")).toMatch(/tracktype inferred/);
    // Too steep even for the Type 3 above its 20% unpaved limit (R06).
    expect(roadAccess(dirt, 22, "engine_t3").rule).toBe("R06");
  });

  it("labels unknown tags with the documented default", () => {
    const r = roadAccess({ highway: "service" }, 0, "engine_t3");
    expect(r.notes.join(" ")).toMatch(/surface unknown, default paved/);
    expect(r.notes.join(" ")).toMatch(/single lane \(width default\)/);
  });

  it("applies the dead-end rule only to structure engines and tenders", () => {
    const tags = { highway: "residential" };
    expect(roadAccess(tags, 0, "engine_t1_t2", true, false).rule).toBe("R10");
    expect(roadAccess(tags, 0, "tender_support", true, false).rule).toBe("R10");
    expect(roadAccess(tags, 0, "engine_t3", true, false).passable).toBe(true);
    expect(roadAccess(tags, 0, "engine_t1_t2", true, true).passable).toBe(true);
  });

  it("treats link ramps and living streets as their parent class (labelled deviation)", () => {
    expect(normaliseHighway("primary_link")).toBe("primary");
    expect(normaliseHighway("living_street")).toBe("residential");
    expect(roadAccess({ highway: "secondary_link" }, 0, "engine_t1_t2").speedKmh).toBe(60);
  });

  it("parses widths in metres and feet-inches", () => {
    expect(parseLengthMeters("3.5")).toBe(3.5);
    expect(parseLengthMeters("3,5 m")).toBe(3.5);
    expect(parseLengthMeters("13'6\"")).toBeCloseTo(4.1148, 4);
    expect(parseLengthMeters("wide")).toBeNull();
  });
});

describe("road grade from the elevation model", () => {
  // A 100 x 100 grid of 30 m cells at the equator rising 3 m per cell eastward: 10% east-west.
  function ramp(): LandscapeGrid {
    const width = 100;
    const height = 100;
    const n = width * height;
    const elevation = new Float32Array(n);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) elevation[r * width + c] = 3 * c;
    }
    return {
      width,
      height,
      originX: 0,
      originY: 0,
      cellSizeX: 30,
      cellSizeY: -30,
      groundCellSizeMeters: 30,
      elevationComplete: true,
      fuelCodes: new Int16Array(n),
      elevationMeters: elevation,
      slopeTangent: new Float32Array(n),
      upslopeDegrees: new Float32Array(n),
      canopyBaseHeightMeters: new Float32Array(n),
      canopyBulkDensityKgPerM3: new Float32Array(n),
      canopyCoverFraction: new Float32Array(n),
      canopyHeightMeters: new Float32Array(n),
      canopyComplete: false,
      cellMeters: 30,
      resampling: "native",
      attribution: { fuel: "test", terrain: "test", canopy: "test" },
    };
  }
  const at = (x: number, y: number) => mercatorToLonLat(x, y);

  it("measures an east-west road's grade and a contour road's flatness", () => {
    const grid = ramp();
    const eastWest = polylineGradePercent(grid, [at(300, -1500), at(2400, -1500)])!;
    expect(eastWest).toBeCloseTo(10, 1);
    const contour = polylineGradePercent(grid, [at(1500, -300), at(1500, -2400)])!;
    expect(contour).toBeCloseTo(0, 6);
    expect(polylineGradePercent(grid, [at(-500, 0), at(100, 0)])).toBeNull();
  });
});
