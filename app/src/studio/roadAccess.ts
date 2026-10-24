/**
 * Road access per apparatus class: the decision table R01-R12 of docs/suppression-data.md,
 * ported from tools/suppression_data.py `road_access()` (the reference implementation; the
 * test suite checks the two agree on shared cases). Thresholds come from the generated data
 * module; nearly all are ASSUMPTIONS flagged there (only the 14 CCR 1273 width, clearance,
 * grade and bridge-load anchors and the WHEG masses are sourced).
 *
 * Also: the grade of each road edge from the landscape's elevation model, and a per-class
 * view of the dispatch road graph (which edges each class may use and how fast).
 *
 * Units: grade in percent (absolute), widths and heights in metres, masses in tonnes or lb as
 * named, speeds in km/h.
 */

import type { DispatchArea, LonLat } from "../dispatch/area";
import { groundMeters } from "../dispatch/area";
import { lonLatToMercator, type LandscapeGrid } from "../fire/landscape";
import { KG_PER_POUND, METERS_PER_FOOT, dataValue, type AccessClass } from "./apparatus";

export type RoadRule =
  | "R01"
  | "R02"
  | "R03"
  | "R04"
  | "R05"
  | "R06"
  | "R07"
  | "R08"
  | "R09"
  | "R10"
  | "R11"
  | "R12";

export const RULE_TEXT: Record<RoadRule, string> = {
  R01: "not a drivable road",
  R02: "closed to motor vehicles",
  R03: "surface too rough",
  R04: "unpaved track too soft",
  R05: "paved grade too steep",
  R06: "unpaved grade too steep",
  R07: "too narrow",
  R08: "too low",
  R09: "weight limit",
  R10: "dead end without turnaround",
  R11: "open (paved)",
  R12: "open (unpaved)",
};

export interface AccessResult {
  passable: boolean;
  speedKmh: number | null;
  rule: RoadRule;
  notes: string[];
}

export type OsmTags = Readonly<Record<string, string | undefined>>;

const RA = "road_access.";
const v = <T>(path: string) => dataValue<T>(RA + path);

const SPEEDS = v<Record<string, number>>("heavy_apparatus_speed_kmh_by_highway");
const DEFAULT_SURFACE = v<Record<string, string>>("default_surface_by_highway");
const PAVED = new Set(v<string[]>("paved_surfaces"));
const DEFAULT_WIDTH = v<Record<string, number>>("default_width_m_by_highway");
const MIN_LANE_WIDTH_M = v<number>("min_lane_width_m");
const MIN_CLEARANCE_M = v<number>("min_vertical_clearance_m");
const UNKNOWN_BRIDGE_LB = v<number>("unknown_bridge_weight_limit_lb");
const UNPAVED_SPEED = v<Record<string, number>>("unpaved_speed_kmh");
const GRADE_PENALTY = v<{ over_8pct: number; over_12pct: number; over_16pct: number }>(
  "grade_speed_penalty",
);
const SINGLE_LANE_BELOW_M = v<number>("single_lane_below_width_m");
const SINGLE_LANE_FACTOR = v<number>("single_lane_speed_factor");

/** Width when a way has no `width` tag and its class has no default (as the Python reference). */
export const FALLBACK_WIDTH_M = 3.0;

const GRAVEL_LIKE = new Set(["gravel", "fine_gravel", "compacted", "pebblestone"]);
const SOFT = new Set(["sand", "grass", "mud"]);
const FOOT_ONLY = new Set([
  "path",
  "footway",
  "steps",
  "bridleway",
  "cycleway",
  "pedestrian",
  "corridor",
]);
const TRACK_GRADES = ["grade1", "grade2", "grade3", "grade4", "grade5"];

/**
 * ASSUMPTION (deviation from the Python reference, which treats them as R01): `*_link` ramps
 * take their parent class and `living_street` is a residential street. They are public roads
 * the dispatch graph already carries.
 */
export function normaliseHighway(highway: string): string {
  if (highway.endsWith("_link")) return highway.slice(0, -"_link".length);
  if (highway === "living_street") return "residential";
  return highway;
}

/** OSM width or maxheight in metres: "3.5", "3.5 m", or feet-inches like 13'6". */
export function parseLengthMeters(raw: string | undefined): number | null {
  if (raw == null) return null;
  const text = raw.trim().toLowerCase();
  const feet = /^(\d+(?:\.\d+)?)'\s*(?:(\d+(?:\.\d+)?)"?)?$/.exec(text);
  if (feet) return (Number(feet[1]) + Number(feet[2] ?? 0) / 12) * METERS_PER_FOOT;
  const metres = /^(\d+(?:[.,]\d+)?)\s*(m)?$/.exec(text);
  return metres ? Number(metres[1].replace(",", ".")) : null;
}

function parseTonnes(raw: string | undefined): number | null {
  if (raw == null) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(t)?$/.exec(raw.trim().toLowerCase());
  return m ? Number(m[1].replace(",", ".")) : null;
}

function parseKmh(raw: string | undefined): number | null {
  if (raw == null) return null;
  const m = /^(\d+)\s*(mph|km\/h)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  return m[2] === "mph" ? Number(m[1]) * 1.609344 : Number(m[1]);
}

const lbToTonnes = (lb: number) => (lb * KG_PER_POUND) / 1000;

/**
 * Can `vehicle` use a way with these OSM tags at this grade, and how fast? First matching rule
 * of R01-R12 decides. `deadEnd` and `hasTurnaround` feed R10.
 */
export function roadAccess(
  tags: OsmTags,
  gradePercent: number,
  vehicle: AccessClass,
  deadEnd = false,
  hasTurnaround = true,
): AccessResult {
  const notes: string[] = [];
  const no = (rule: RoadRule, why: string): AccessResult => ({
    passable: false,
    speedKmh: null,
    rule,
    notes: [...notes, why],
  });
  const highway = normaliseHighway(tags.highway ?? "");
  const grade = Math.abs(gradePercent);
  if (FOOT_ONLY.has(highway)) return no("R01", `highway=${highway} is not drivable`);
  if (!(highway in SPEEDS) && highway !== "track") {
    return no("R01", `highway=${highway || "missing"} is not a drivable class`);
  }
  if (tags.emergency === "no" || (tags.motor_vehicle === "no" && tags.emergency !== "yes")) {
    return no("R02", "motor vehicles excluded");
  }
  if (tags.access === "private" || tags.access === "no") {
    notes.push("private access: assumed open to emergency vehicles, gate delay unknown");
  }

  const surface = tags.surface ?? DEFAULT_SURFACE[highway] ?? "paved";
  if (!tags.surface) notes.push(`surface unknown, default ${surface} for ${highway}`);
  const paved = PAVED.has(surface) || surface === "paved";
  let tracktype = tags.tracktype;
  if (paved) tracktype = "grade1";
  else if (!tracktype || !TRACK_GRADES.includes(tracktype)) {
    tracktype = GRAVEL_LIKE.has(surface) ? "grade2" : SOFT.has(surface) ? "grade4" : "grade3";
    notes.push(`tracktype inferred as ${tracktype} from surface=${surface}`);
  }

  const smoothness = tags.smoothness;
  if (smoothness && !v<string[]>(`allowed_smoothness.${vehicle}`).includes(smoothness)) {
    return no("R03", `smoothness=${smoothness} too rough for ${vehicle}`);
  }
  if (!paved && !v<string[]>(`allowed_unpaved_tracktype.${vehicle}`).includes(tracktype)) {
    return no("R04", `${tracktype} not allowed for ${vehicle}`);
  }
  const limit = v<number>(`${paved ? "max_grade_paved_pct" : "max_grade_unpaved_pct"}.${vehicle}`);
  if (grade > limit) {
    return no(paved ? "R05" : "R06", `grade ${grade.toFixed(0)}% above ${limit}% limit for ${vehicle}`);
  }

  let width = parseLengthMeters(tags.width);
  const widthKnown = width !== null;
  if (width === null) width = DEFAULT_WIDTH[highway] ?? FALLBACK_WIDTH_M;
  if (width < MIN_LANE_WIDTH_M) {
    return no("R07", `width ${width.toFixed(1)} m${widthKnown ? "" : " (default)"} below the ${MIN_LANE_WIDTH_M} m minimum lane`);
  }
  const height = parseLengthMeters(tags.maxheight);
  if (height !== null && height < MIN_CLEARANCE_M) {
    return no("R08", `maxheight ${height.toFixed(1)} m below ${MIN_CLEARANCE_M} m`);
  }

  const gvwrT = lbToTonnes(v<number>(`vehicle_classes.${vehicle}.gvwr_lb`));
  const maxweight = parseTonnes(tags.maxweight);
  if (maxweight !== null && gvwrT > maxweight) {
    return no("R09", `maxweight ${maxweight} t below ${vehicle} GVWR ${gvwrT.toFixed(1)} t`);
  }
  if (tags.bridge !== undefined && tags.bridge !== "no" && maxweight === null) {
    if ((highway === "track" || highway === "service" || !paved) && gvwrT > lbToTonnes(UNKNOWN_BRIDGE_LB)) {
      return no("R09", "bridge on a track/service/unpaved way with no maxweight; assumed 40,000 lb capacity");
    }
  }
  if (
    deadEnd &&
    !hasTurnaround &&
    (vehicle === "engine_t1_t2" || vehicle === "tender_support" || vehicle === "tender_tactical")
  ) {
    return no("R10", "dead end without a turnaround; heavy apparatus cannot reverse out");
  }

  let base = SPEEDS[highway];
  if (!paved || base === undefined) base = UNPAVED_SPEED[tracktype];
  const posted = parseKmh(tags.maxspeed);
  if (posted !== null) base = Math.min(base, posted);
  let factor =
    grade > 16
      ? GRADE_PENALTY.over_16pct
      : grade > 12
        ? GRADE_PENALTY.over_12pct
        : grade > 8
          ? GRADE_PENALTY.over_8pct
          : 1;
  if (factor < 1) notes.push(`grade ${grade.toFixed(0)}% slows to x${factor}`);
  const single = tags.lanes === "1" || width < SINGLE_LANE_BELOW_M;
  if (single && tags.oneway !== "yes") {
    factor *= SINGLE_LANE_FACTOR;
    notes.push(`single lane${widthKnown ? "" : " (width default)"}`);
  }
  return {
    passable: true,
    speedKmh: Math.round(base * factor * 10) / 10,
    rule: paved ? "R11" : "R12",
    notes,
  };
}

// ---- grade from the elevation model -----------------------------------------------------

/**
 * ASSUMPTION: grade is the steepest rise over run along the edge measured over windows of this
 * many ground metres, from the landscape DEM sampled bilinearly every SAMPLE_SPACING_METERS. A
 * window smooths 30 m DEM noise (road cuts and fills are finer than the DEM); shorter edges use
 * their full length. Not sourced; calibrate against surveyed road grades.
 */
export const GRADE_WINDOW_METERS = 100;
export const GRADE_SAMPLE_SPACING_METERS = 10;

function elevationAt(grid: LandscapeGrid, point: LonLat): number | null {
  const [x, y] = lonLatToMercator(point[0], point[1]);
  const fx = (x - grid.originX) / grid.cellSizeX;
  const fy = (y - grid.originY) / grid.cellSizeY;
  if (fx < 0 || fy < 0 || fx > grid.width - 1 || fy > grid.height - 1) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const e = grid.elevationMeters;
  const top = e[y0 * grid.width + x0] * (1 - tx) + e[y0 * grid.width + x1] * tx;
  const bottom = e[y1 * grid.width + x0] * (1 - tx) + e[y1 * grid.width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Steepest windowed grade along a polyline, percent; null when any part is off the grid. */
export function polylineGradePercent(grid: LandscapeGrid, coords: readonly LonLat[]): number | null {
  const distance: number[] = [0];
  const height: number[] = [];
  const first = elevationAt(grid, coords[0]);
  if (first === null) return null;
  height.push(first);
  let along = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    const length = groundMeters(a, b);
    const steps = Math.max(1, Math.ceil(length / GRADE_SAMPLE_SPACING_METERS));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const z = elevationAt(grid, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      if (z === null) return null;
      distance.push(along + length * t);
      height.push(z);
    }
    along += length;
  }
  if (along <= 0) return 0;
  if (along <= GRADE_WINDOW_METERS) return (Math.abs(height[height.length - 1] - height[0]) / along) * 100;
  let steepest = 0;
  let j = 0;
  for (let i = 0; i < distance.length; i += 1) {
    while (j < distance.length - 1 && distance[j] - distance[i] < GRADE_WINDOW_METERS) j += 1;
    const run = distance[j] - distance[i];
    if (run < GRADE_WINDOW_METERS) break;
    steepest = Math.max(steepest, (Math.abs(height[j] - height[i]) / run) * 100);
  }
  return steepest;
}

// ---- per-class road graph ---------------------------------------------------------------

export interface EdgeAccess {
  /** Grade used, percent; 0 when unknown. */
  gradePercent: number;
  /** False when the edge is off the terrain board, so grade 0 was ASSUMED. */
  gradeKnown: boolean;
  /** A dead end (degree-1 node not on the box boundary) with no turning circle. */
  deadEndNoTurnaround: boolean;
  byClass: Record<AccessClass, AccessResult>;
}

/**
 * Access of every edge for every class. Edges with no OSM tags (areas cached before the
 * builder kept them) are judged on their class alone: every missing tag takes the documented
 * default, and the notes say so.
 */
export function edgeAccessTable(
  area: DispatchArea,
  grid: LandscapeGrid | null,
  classes: readonly AccessClass[],
): EdgeAccess[] {
  const degree = new Array<number>(area.nodes.length).fill(0);
  for (const edge of area.edges) {
    degree[edge.from] += 1;
    degree[edge.to] += 1;
  }
  const boundaryNodes = area.boundaryNodes ?? [];
  const boundary = new Set(boundaryNodes);
  const turning = new Set(area.turningNodes ?? []);
  return area.edges.map((edge) => {
    const grade = grid ? polylineGradePercent(grid, edge.coords) : null;
    const endsBlind = (node: number) => degree[node] === 1 && !boundary.has(node);
    // Without boundary data (areas cached before dispatch-area/4) a cut road looks like a dead
    // end, so R10 is not applied at all.
    const deadEnd = boundaryNodes.length > 0 && (endsBlind(edge.from) || endsBlind(edge.to));
    const blindNode = endsBlind(edge.from) ? edge.from : edge.to;
    const hasTurnaround = !deadEnd || turning.has(blindNode);
    const tags: OsmTags = { highway: edge.roadClass, ...edge.tags };
    const byClass = {} as Record<AccessClass, AccessResult>;
    for (const vehicle of classes) {
      const result = roadAccess(tags, grade ?? 0, vehicle, deadEnd, hasTurnaround);
      if (grade === null) result.notes.push("grade unknown off the terrain board; 0% assumed");
      byClass[vehicle] = result;
    }
    return {
      gradePercent: grade ?? 0,
      gradeKnown: grade !== null,
      deadEndNoTurnaround: deadEnd && !hasTurnaround,
      byClass,
    };
  });
}
