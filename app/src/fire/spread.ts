/**
 * Landscape fire growth: Rothermel rate of spread per 30 m cell, propagated as a
 * minimum-travel-time arrival field (after Finney 2002), then contoured into perimeters.
 *
 * A cell's fire spreads to its neighbours at the elliptical rate for the direction of
 * travel, so heading, flanking, and backing spread all fall out of one field. Cells with
 * no fuel are never reached, which is what keeps fire out of water and streets.
 *
 * Times are elapsed simulation-clock minutes from ignition. Distances inside the solver
 * are ground metres.
 */

import type { Feature, Polygon, Position } from "geojson";
import { FUEL_MODELS, NON_BURNABLE_CODES, fuelLabel, isBurnable } from "./fuelModels";
import { prepareFuelBed, spreadFromBed, type FuelMoisture, type SpreadResult } from "./rothermel";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface FireScenario {
  origin: GeoPoint;
  /** Open (20-foot) wind speed, miles per hour. */
  windSpeedMph: number;
  /** Meteorological bearing the wind blows FROM, degrees clockwise from true north. */
  windFromDegrees: number;
  moisture: FuelMoisture;
  /** Share of the open wind that reaches midflame height. */
  midflameAdjustment: number;
  stepMinutes: number;
  horizonMinutes: number;
}

export interface MoisturePreset {
  id: string;
  label: string;
  description: string;
  moisture: FuelMoisture;
}

/**
 * Standard dead and live fuel moisture scenarios used with the SB40 models
 * (Scott & Burgan 2005, Table 1). Percentages of oven-dry weight.
 */
export const MOISTURE_PRESETS: readonly MoisturePreset[] = [
  {
    id: "critical",
    label: "Critical — Red Flag",
    description: "Very low dead moisture with cured grass. Peak fire weather.",
    moisture: { dead1h: 0.03, dead10h: 0.04, dead100h: 0.05, liveHerb: 0.3, liveWoody: 0.6 },
  },
  {
    id: "dry",
    label: "Dry",
    description: "Low dead moisture, partly cured herbaceous fuel.",
    moisture: { dead1h: 0.06, dead10h: 0.07, dead100h: 0.08, liveHerb: 0.6, liveWoody: 0.9 },
  },
  {
    id: "moderate",
    label: "Moderate",
    description: "Typical summer afternoon conditions.",
    moisture: { dead1h: 0.09, dead10h: 0.1, dead100h: 0.11, liveHerb: 0.9, liveWoody: 1.2 },
  },
  {
    id: "wet",
    label: "Wet / green",
    description: "High dead moisture with green herbaceous fuel.",
    moisture: { dead1h: 0.12, dead10h: 0.13, dead100h: 0.14, liveHerb: 1.2, liveWoody: 1.5 },
  },
] as const;

export const FIRE_STEP_MINUTES = 15;
export const FIRE_HORIZON_MINUTES = 180;
export const HORIZON_CHOICES = [120, 180, 360] as const;
/** Unsheltered midflame wind is roughly half the 20-foot wind (Albini & Baughman 1979). */
export const DEFAULT_MIDFLAME_ADJUSTMENT = 0.5;

export const SPREAD_MODEL = {
  id: "rothermel-1972-mtt",
  version: "2.0.0",
  surfaceSpread: "Rothermel (1972), per Andrews RMRS-GTR-371 (2018)",
  fuelModels: "Scott & Burgan (2005) 40 standard fire behavior fuel models",
  ellipse: "Anderson (1983) length-to-breadth; Alexander (1985) elliptical spread",
  propagation: "Minimum travel time over a 30 m grid (after Finney 2002)",
} as const;

const FEET_PER_MINUTE_PER_MPH = 88;
const METERS_PER_FOOT = 0.3048;
const RADIANS_PER_DEGREE = Math.PI / 180;
export const SQUARE_METERS_PER_HECTARE = 10_000;
export const SQUARE_METERS_PER_ACRE = 4046.8564224;
export const METERS_PER_MILE = 1609.344;

export interface PerimeterProperties {
  elapsedMinutes: number;
}
export type FirePerimeter = Feature<Polygon, PerimeterProperties>;

export interface FireFrame {
  elapsedMinutes: number;
  perimeters: FirePerimeter[];
  burnedAreaSquareMeters: number;
  /** Greatest ground distance from the ignition point reached by this time, metres. */
  maxReachMeters: number;
}

export interface IgnitionConditions {
  fuelCode: number;
  fuelLabel: string;
  slopePercent: number;
  elevationMeters: number;
  spread: SpreadResult;
}

export interface FireRun {
  model: typeof SPREAD_MODEL;
  scenario: FireScenario;
  frames: FireFrame[];
  ignition: IgnitionConditions;
  /** Share of the modelled area that carries fire at all. */
  burnableFraction: number;
  /** True when fire reached the edge of the modelled area, so the run is truncated. */
  reachedEdge: boolean;
  cellSizeMeters: number;
  computeMilliseconds: number;
}

export class NonBurnableIgnitionError extends Error {
  constructor(readonly fuelCode: number) {
    super(
      `The ignition point is on ${(NON_BURNABLE_CODES.get(fuelCode) ?? "unmapped ground").toLowerCase()}, which carries no fire. Place it on vegetated ground.`,
    );
    this.name = "NonBurnableIgnitionError";
  }
}

// Sixteen neighbours rather than eight: with only the immediate ring, spread directions
// quantise to 45 degrees and perimeters come out visibly octagonal.
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [2, 1],
  [1, 2],
  [-1, 2],
  [-2, 1],
  [-2, -1],
  [-1, -2],
  [1, -2],
  [2, -1],
];

/** Binary min-heap over (time, cell index) pairs. */
class TimeHeap {
  private times: Float64Array;
  private cells: Int32Array;
  private size = 0;

  constructor(capacity: number) {
    this.times = new Float64Array(capacity);
    this.cells = new Int32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(time: number, cell: number): void {
    if (this.size === this.times.length) this.grow();
    let index = this.size++;
    this.times[index] = time;
    this.cells[index] = cell;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.times[parent] <= this.times[index]) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  pop(): { time: number; cell: number } {
    const time = this.times[0];
    const cell = this.cells[0];
    this.size--;
    if (this.size > 0) {
      this.times[0] = this.times[this.size];
      this.cells[0] = this.cells[this.size];
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.size && this.times[left] < this.times[smallest]) smallest = left;
        if (right < this.size && this.times[right] < this.times[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(smallest, index);
        index = smallest;
      }
    }
    return { time, cell };
  }

  private swap(a: number, b: number): void {
    const t = this.times[a];
    this.times[a] = this.times[b];
    this.times[b] = t;
    const c = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = c;
  }

  private grow(): void {
    const times = new Float64Array(this.times.length * 2);
    times.set(this.times);
    this.times = times;
    const cells = new Int32Array(this.cells.length * 2);
    cells.set(this.cells);
    this.cells = cells;
  }
}

export function simulateFireSpread(landscape: LandscapeGrid, scenario: FireScenario): FireRun {
  const startedAt = performance.now();
  const { width, height, fuelCodes, slopeTangent, upslopeDegrees, groundCellSizeMeters } =
    landscape;
  const cellCount = width * height;

  const originCell = cellAt(landscape, scenario.origin);
  if (originCell < 0) throw new Error("The ignition point is outside the modelled area.");
  const originFuel = fuelCodes[originCell];
  if (!isBurnable(originFuel)) throw new NonBurnableIgnitionError(originFuel);

  // One fuel bed per distinct fuel model present, reused by every cell that uses it.
  const midflameWind =
    scenario.windSpeedMph * FEET_PER_MINUTE_PER_MPH * scenario.midflameAdjustment;
  const windToward = (scenario.windFromDegrees + 180) % 360;
  const beds = new Map<number, ReturnType<typeof prepareFuelBed>>();
  for (const [code, fuel] of FUEL_MODELS) beds.set(code, prepareFuelBed(fuel, scenario.moisture));

  // Per-cell spread: metres per minute at the head, heading, and ellipse eccentricity.
  const headRate = new Float32Array(cellCount);
  const headingRadians = new Float32Array(cellCount);
  const eccentricity = new Float32Array(cellCount);
  let burnableCells = 0;
  for (let i = 0; i < cellCount; i++) {
    const bed = beds.get(fuelCodes[i]);
    if (!bed) continue;
    burnableCells++;
    const spread = spreadFromBed(bed, midflameWind, windToward, slopeTangent[i], upslopeDegrees[i]);
    headRate[i] = spread.headRateFeetPerMinute * METERS_PER_FOOT;
    headingRadians[i] = spread.headingDegrees * RADIANS_PER_DEGREE;
    const lb = spread.lengthToBreadth;
    eccentricity[i] = lb > 1 ? Math.sqrt(lb * lb - 1) / lb : 0;
  }

  const arrival = new Float64Array(cellCount).fill(Number.POSITIVE_INFINITY);
  arrival[originCell] = 0;
  const settled = new Uint8Array(cellCount);
  const heap = new TimeHeap(Math.min(cellCount, 1 << 16));
  heap.push(0, originCell);

  const bearings = NEIGHBOURS.map(([dx, dy]) => Math.atan2(dx, -dy));
  const distances = NEIGHBOURS.map(([dx, dy]) => Math.hypot(dx, dy) * groundCellSizeMeters);
  let reachedEdge = false;

  while (heap.length > 0) {
    const { time, cell } = heap.pop();
    if (settled[cell]) continue;
    if (time > scenario.horizonMinutes) break;
    settled[cell] = 1;

    const rate = headRate[cell];
    if (rate <= 0) continue;
    const x = cell % width;
    const y = (cell - x) / width;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) reachedEdge = true;

    for (let n = 0; n < NEIGHBOURS.length; n++) {
      const [dx, dy] = NEIGHBOURS[n];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
      if (settled[neighbour] || headRate[neighbour] <= 0) continue;
      // A two-cell step must not hop a solid barrier, so require a passable cell
      // roughly halfway along it.
      if (Math.abs(dx) === 2 || Math.abs(dy) === 2) {
        const midA = (y + (dy >> 1)) * width + (x + (dx >> 1));
        const midB = (y + Math.round(dy / 2)) * width + (x + Math.round(dx / 2));
        if (headRate[midA] <= 0 && headRate[midB] <= 0) continue;
      }
      // Elliptical spread from the cell's heading, inlined: this is the hot loop.
      const e = eccentricity[cell];
      const rateToward =
        e > 0 ? (rate * (1 - e)) / (1 - e * Math.cos(bearings[n] - headingRadians[cell])) : rate;
      if (rateToward <= 0) continue;
      const candidate = time + distances[n] / rateToward;
      if (candidate < arrival[neighbour]) {
        arrival[neighbour] = candidate;
        heap.push(candidate, neighbour);
      }
    }
  }

  const cellArea = groundCellSizeMeters * groundCellSizeMeters;
  const originX = originCell % width;
  const originY = (originCell - originX) / width;
  const frames: FireFrame[] = [];
  for (let minutes = 0; minutes <= scenario.horizonMinutes; minutes += scenario.stepMinutes) {
    let burned = 0;
    let maxReach = 0;
    for (let i = 0; i < cellCount; i++) {
      if (arrival[i] > minutes) continue;
      burned++;
      const x = i % width;
      const y = (i - x) / width;
      const reach = Math.hypot(x - originX, y - originY) * groundCellSizeMeters;
      if (reach > maxReach) maxReach = reach;
    }
    frames.push({
      elapsedMinutes: minutes,
      perimeters: minutes === 0 ? [] : contour(landscape, arrival, minutes),
      burnedAreaSquareMeters: burned * cellArea,
      maxReachMeters: maxReach,
    });
  }

  const originBed = beds.get(originFuel)!;
  return {
    model: SPREAD_MODEL,
    scenario,
    frames,
    ignition: {
      fuelCode: originFuel,
      fuelLabel: fuelLabel(originFuel),
      slopePercent: slopeTangent[originCell] * 100,
      elevationMeters: landscape.elevationMeters[originCell],
      spread: spreadFromBed(
        originBed,
        midflameWind,
        windToward,
        slopeTangent[originCell],
        upslopeDegrees[originCell],
      ),
    },
    burnableFraction: burnableCells / cellCount,
    reachedEdge,
    cellSizeMeters: groundCellSizeMeters,
    computeMilliseconds: performance.now() - startedAt,
  };
}

export function cellAt(landscape: LandscapeGrid, point: GeoPoint): number {
  const { width, height, originX, originY, cellSizeX, cellSizeY } = landscape;
  const [x, y] = mercatorOf(point);
  const column = Math.round((x - originX) / cellSizeX);
  const row = Math.round((y - originY) / cellSizeY);
  if (column < 0 || row < 0 || column >= width || row >= height) return -1;
  return row * width + column;
}

function mercatorOf(point: GeoPoint): [number, number] {
  const x = (point.longitude / 180) * 20037508.342789244;
  const clamped = Math.max(Math.min(point.latitude, 85.05112878), -85.05112878);
  const y = (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) / Math.PI) * 20037508.342789244;
  return [x, y];
}

// Marching squares over the burned/unburned mask. Segments are emitted with the burned
// side on the left, so assembled rings enclose burned ground.
const EDGE_TABLE: readonly (readonly (readonly [number, number])[])[] = [
  [],
  [[2, 3]],
  [[1, 2]],
  [[1, 3]],
  [[0, 1]],
  [
    [0, 1],
    [2, 3],
  ],
  [[0, 2]],
  [[0, 3]],
  [[3, 0]],
  [[2, 0]],
  [
    [3, 0],
    [1, 2],
  ],
  [[1, 0]],
  [[3, 1]],
  [[2, 1]],
  [[3, 2]],
  [],
];

function contour(
  landscape: LandscapeGrid,
  arrival: Float64Array,
  threshold: number,
): FirePerimeter[] {
  const { width, height } = landscape;
  // Edge midpoints of the square whose top-left cell is (x, y): top, right, bottom, left.
  const edgePoint = (x: number, y: number, edge: number): [number, number] =>
    edge === 0
      ? [x + 0.5, y]
      : edge === 1
        ? [x + 1, y + 0.5]
        : edge === 2
          ? [x + 0.5, y + 1]
          : [x, y + 0.5];
  const key = (p: [number, number]) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;

  const starts = new Map<string, [number, number][]>();
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const burnedAt = (cx: number, cy: number) => (arrival[cy * width + cx] <= threshold ? 1 : 0);
      const index =
        burnedAt(x, y) * 8 +
        burnedAt(x + 1, y) * 4 +
        burnedAt(x + 1, y + 1) * 2 +
        burnedAt(x, y + 1);
      for (const [from, to] of EDGE_TABLE[index]) {
        const a = edgePoint(x, y, from);
        const b = edgePoint(x, y, to);
        const bucket = starts.get(key(a));
        if (bucket) bucket.push(b);
        else starts.set(key(a), [b]);
      }
    }
  }

  const rings: [number, number][][] = [];
  for (const [startKey, ends] of starts) {
    while (ends.length > 0) {
      const ring: [number, number][] = [];
      let current = parseKey(startKey);
      let next: [number, number] | undefined = ends.pop();
      while (next) {
        ring.push(current);
        current = next;
        const bucket = starts.get(key(current));
        next = bucket && bucket.length > 0 ? bucket.pop() : undefined;
        if (ring.length > 4 * width * height) break;
        if (next && key(current) === startKey) break;
      }
      ring.push(current);
      if (ring.length >= 4) rings.push(ring);
    }
  }

  return assemblePolygons(landscape, rings, threshold);
}

function parseKey(k: string): [number, number] {
  const [a, b] = k.split(",");
  return [Number(a) / 2, Number(b) / 2];
}

function assemblePolygons(
  landscape: LandscapeGrid,
  rings: [number, number][][],
  threshold: number,
): FirePerimeter[] {
  const geographic = rings.map((ring) =>
    ring.map(([x, y]): Position => {
      const mercatorX = landscape.originX + x * landscape.cellSizeX;
      const mercatorY = landscape.originY + y * landscape.cellSizeY;
      const [longitude, latitude] = mercatorToLonLat(mercatorX, mercatorY);
      return [longitude, latitude];
    }),
  );

  // Depth by containment, so holes are identified without relying on winding order.
  const depth = geographic.map((ring, i) =>
    geographic.reduce(
      (count, other, j) => (i !== j && containsPoint(other, ring[0]) ? count + 1 : count),
      0,
    ),
  );

  const polygons: FirePerimeter[] = [];
  geographic.forEach((ring, i) => {
    if (depth[i] % 2 !== 0) return;
    const holes = geographic.filter(
      (other, j) => depth[j] === depth[i] + 1 && containsPoint(ring, other[0]),
    );
    polygons.push({
      type: "Feature",
      properties: { elapsedMinutes: threshold },
      geometry: {
        type: "Polygon",
        coordinates: [orient(ring, true), ...holes.map((hole) => orient(hole, false))],
      },
    });
  });
  return polygons;
}

function signedArea(ring: Position[]): number {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    total += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return total / 2;
}

/** GeoJSON wants counterclockwise exteriors and clockwise holes. */
function orient(ring: Position[], counterclockwise: boolean): Position[] {
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]];
  const area = signedArea(closed);
  return area < 0 === counterclockwise ? [...closed].reverse() : closed;
}

function containsPoint(ring: Position[], point: Position): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Elapsed simulation time as `T+H:MM`. */
export function formatElapsed(minutes: number): string {
  return `T+${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Bearing in degrees clockwise from true north, from one point toward another. */
export function bearingBetween(from: GeoPoint, to: GeoPoint): number {
  const fromLatitude = from.latitude * RADIANS_PER_DEGREE;
  const toLatitude = to.latitude * RADIANS_PER_DEGREE;
  const delta = (to.longitude - from.longitude) * RADIANS_PER_DEGREE;
  const y = Math.sin(delta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(delta);
  return (Math.atan2(y, x) / RADIANS_PER_DEGREE + 360) % 360;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];
export function compassPoint(degrees: number): string {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % COMPASS.length];
}
