/**
 * Landscape fire growth: Rothermel rate of spread per 30 m cell, propagated as a
 * minimum-travel-time arrival field (after Finney 2002), then contoured into perimeters.
 *
 * A cell's fire spreads to its neighbours at the elliptical rate for the direction of
 * travel, so heading, flanking, and backing spread all fall out of one field.
 *
 * Two wildland-urban-interface mechanisms sit on top of that surface model. Both are
 * coarse assumptions rather than physics, both can be switched off, and both are
 * accounted for separately in the run output so a caller can say how much of a burn
 * came from where:
 *
 *   - Ember spotting carries fire downwind over unvegetated ground into the first fuel
 *     beyond it, so a road, a block of houses or a river is a delay rather than a wall.
 *   - Structure-to-structure spread gives developed ground (FBFM40 91) its own spread
 *     rate, so a subdivision burns instead of acting as a firebreak.
 *
 * Open water (98), snow or ice (92), agricultural land (93) and bare ground (99) still
 * carry no fire and are never assigned an arrival time by either mechanism.
 *
 * Nothing here uses randomness, so a scenario plus a landscape reproduces a run exactly
 * and no seed has to be recorded.
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
  /** Ember transport across non-burnable gaps. `DEFAULT_SPOTTING` applies when omitted. */
  spotting?: SpottingOptions;
  /**
   * Urban conflagration through developed ground. `DEFAULT_STRUCTURE_SPREAD` applies
   * when omitted.
   */
  structureSpread?: StructureSpreadOptions;
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

/**
 * LANDFIRE FBFM40 code for urban or developed ground: roads, parking lots, and
 * residential subdivisions all carry it. In a wildland-urban interface box it is the
 * overwhelming majority of the non-burnable area, which is why it gets its own mechanism
 * while the other non-burnable codes do not.
 */
export const DEVELOPED_FUEL_CODE = 91;

export interface SpottingOptions {
  enabled: boolean;
  /** Ceiling on how far downwind a firebrand may start a new fire, ground metres. */
  maxDistanceMeters: number;
}

export interface StructureSpreadOptions {
  enabled: boolean;
  /**
   * Downwind structure-to-structure head rate at `STRUCTURE_SPREAD_REFERENCE_WIND_MPH`,
   * metres per minute.
   */
  rateMetersPerMinute: number;
}

/**
 * Spotting is on by default. In the fires this tool is aimed at — Tubbs (2017), Camp
 * (2018), Marshall (2021) — embers crossing roads into receptive fuel were a primary
 * spread mechanism rather than an edge case, and without it a wildland-urban interface
 * run stops at the first street.
 *
 * 500 m is a ceiling, not a typical distance. Surface fires and intermittent torching
 * produce maximum spot distances of a few hundred metres (Albini, "Spot fire distance
 * from burning trees", USDA Forest Service INT-56, 1979). The kilometre-plus spots
 * reported on Camp and Tubbs came from plume-dominated crown fire, which this surface
 * model does not represent, so claiming that reach here would not be supported.
 */
export const DEFAULT_SPOTTING: SpottingOptions = { enabled: true, maxDistanceMeters: 500 };

/**
 * Structure-to-structure spread is on by default for the same reason: with it off, the
 * model asserts that a subdivision is a firebreak, which the historical record
 * contradicts.
 *
 * 4 m/min is the downwind head rate at the reference wind. Anchor: the Tubbs Fire crossed
 * US-101 into Coffey Park around 01:30 on 9 October 2017 and had consumed most of a tract
 * roughly 1.2 km across by dawn, which is of order 5 m/min of front progression. Part of
 * that progression was ember transport, which this model counts separately through
 * spotting, so the structure-to-structure rate on its own is set below the observed
 * figure rather than at it.
 */
export const DEFAULT_STRUCTURE_SPREAD: StructureSpreadOptions = {
  enabled: true,
  rateMetersPerMinute: 4,
};

/** Open 20-foot wind that `StructureSpreadOptions.rateMetersPerMinute` is quoted at, mph. */
export const STRUCTURE_SPREAD_REFERENCE_WIND_MPH = 20;
/**
 * Bounds on the linear wind scaling of the structure rate. A structure is exposed at roof
 * height rather than inside a fuel bed, so the open wind drives it and no midflame
 * reduction is applied. The bounds stop a calm night from freezing the conflagration
 * outright and stop a 60 mph gust from extrapolating a single anchor point into nonsense.
 */
export const STRUCTURE_WIND_FACTOR_MIN = 0.25;
export const STRUCTURE_WIND_FACTOR_MAX = 3;
/**
 * Urban conflagration is much less elongated than a wind-driven wildland fire: it moves
 * building to building by radiation and short-range firebrands rather than through a
 * continuous fuel bed, and the spacing between structures, not the wind, sets much of the
 * rate. Hamada's urban spread model (Hamada 1951, still the basis of Japanese and
 * post-earthquake conflagration models) gives downwind spread of order three times the
 * upwind rate; that ratio sets both the ellipse and the floor below.
 */
export const STRUCTURE_LENGTH_TO_BREADTH = 3;
export const STRUCTURE_BACKING_RATE_FRACTION = 1 / 3;
/**
 * Assumed fireline intensity of burning developed ground, Btu/ft/s. Rothermel does not
 * apply to structures, so no intensity is computed for them. This value exists only to
 * size their ember reach and to report a flame length at a structure ignition, and is
 * deliberately kept in the same order as a high-intensity brush fire instead of modelling
 * a structure plume.
 */
export const STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND = 1000;

/**
 * Maximum spot distance grows with wind speed and with the square root of fireline
 * intensity, the form the Albini (1979, 1983) firebrand models and the Alexander & Cruz
 * (2006) fits take: a more intense fire lofts larger brands higher, and a stronger wind
 * carries them further. Units are metres per (mile per hour × sqrt(Btu/ft/s)).
 *
 * The coefficient is calibrated so that a strong 45 mph wind over a high-intensity
 * (≈2000 Btu/ft/s) shrubland fire reaches the 500 m ceiling, which is the reported order
 * of maximum short-range spotting for wind-driven fires that are not crowning. It then
 * gives about 140 m at 25 mph over a 500 Btu/ft/s brush fire — across a four-lane road,
 * not across a subdivision — and about 80 m from a timber-litter fire in the same wind.
 */
export const SPOTTING_DISTANCE_COEFFICIENT = 0.25;
/**
 * Below this fireline intensity the fire is not lofting firebrands worth modelling.
 * 100 Btu/ft/s is the long-standing 4-foot flame length threshold at which direct attack
 * by hand crews stops being possible (Andrews & Rothermel, USDA Forest Service INT-131,
 * 1982), which is a reasonable floor for a fire that can throw a spot across a road.
 */
export const SPOTTING_MIN_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND = 100;
/**
 * Horizontal firebrand speed as a share of the open wind. Brands lag the air that carries
 * them while they fall; half is a conservative round figure. Travel time is minor next to
 * incubation at these distances: 200 m at 25 mph works out near 20 seconds.
 */
export const SPOTTING_EMBER_SPEED_FRACTION = 0.5;
/**
 * Added delay between the fire reaching a launch cell and a spot fire spreading at the
 * receptor, minutes. It is the dominant term in a spot arrival time at these distances,
 * and it bundles three things: lofting and flight lag beyond plain advection, the
 * smouldering-to-flaming incubation of a landed brand, and — the largest of the three —
 * the wait for a brand that actually establishes. This model is deterministic, so every
 * receptive landing ignites, whereas the real per-brand ignition probability is far below
 * one; the delay is what keeps that simplification from turning into free spread.
 *
 * It is therefore set at the long end of observed incubation rather than the middle, so
 * that bridging a one-cell gap works out slower than burning through the same width of
 * fuel at the spread rates these fuels produce. Spotting then removes barriers without
 * accelerating the head, which is the behaviour the surface model can support.
 */
export const SPOTTING_IGNITION_DELAY_MINUTES = 10;
/**
 * Firebrand landings concentrate in a narrow cone about the wind vector. Five rays at
 * these offsets from the wind bearing sample that cone; more rays cost solver time
 * without changing which side of a road the fire lands on.
 */
export const SPOTTING_BEARING_OFFSETS_DEGREES = [-30, -15, 0, 15, 30] as const;
/**
 * Hard bound on how many cells one spotting ray may walk, so that a caller raising
 * `maxDistanceMeters` cannot turn the solver quadratic. Effective reach is the smaller of
 * this and the distance limit; at the 23.7 m Berkeley ground cell this is about 1.1 km,
 * so the 500 m default ceiling binds first.
 */
export const SPOTTING_MAX_PATH_CELLS = 48;

export const SPREAD_MODEL = {
  id: "rothermel-1972-mtt",
  version: "3.0.0",
  surfaceSpread: "Rothermel (1972), per Andrews RMRS-GTR-371 (2018)",
  fuelModels: "Scott & Burgan (2005) 40 standard fire behavior fuel models",
  ellipse: "Anderson (1983) length-to-breadth; Alexander (1985) elliptical spread",
  propagation: "Minimum travel time over a 30 m grid (after Finney 2002)",
  backingRate:
    "Directional rate floored at the no-wind, no-slope rate, as BehavePlus computes backing spread (Andrews RMRS-GTR-371, 2018)",
  spotting:
    "Assumption: deterministic ember transport across non-burnable gaps downwind, reach scaled by wind and fireline intensity after Albini (1979)",
  structureSpread:
    "Assumption: fixed-rate urban conflagration through FBFM40 91, wind-scaled, Hamada (1951) directionality — not a structure fire model",
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

/**
 * How fire actually got to the ground that burned, so a caller can separate what the
 * surface physics produced from what the two interface assumptions produced. Each burned
 * cell is attributed once, to the mechanism that set its final (earliest) arrival time.
 */
export interface ArrivalBreakdown {
  /** Reached by an ordinary Rothermel neighbour step from vegetated ground. */
  surfaceCells: number;
  /** Reached by an ember jump across a non-burnable gap. */
  spottingCells: number;
  /** Reached by a neighbour step out of a burning developed cell. */
  structureCells: number;
  surfaceSquareMeters: number;
  spottingSquareMeters: number;
  structureSquareMeters: number;
}

export interface FireRun {
  model: typeof SPREAD_MODEL;
  scenario: FireScenario;
  frames: FireFrame[];
  ignition: IgnitionConditions;
  /** Share of the modelled area holding a vegetated fuel model, with or without spotting. */
  burnableFraction: number;
  /** Share of the modelled area mapped as urban or developed, FBFM40 91. */
  developedFraction: number;
  /** Share of the modelled area that can carry fire under the options actually applied. */
  fireCarryingFraction: number;
  /** The two interface options after defaults were filled in, for reproducibility. */
  appliedOptions: { spotting: SpottingOptions; structureSpread: StructureSpreadOptions };
  /** Burned ground at the horizon, split by the mechanism that delivered fire to it. */
  arrivalBreakdown: ArrivalBreakdown;
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

/** Mechanism that set a cell's final arrival time; indexes the `ArrivalBreakdown`. */
const ARRIVAL_SURFACE = 0;
const ARRIVAL_SPOTTING = 1;
const ARRIVAL_STRUCTURE = 2;

function eccentricityOf(lengthToBreadth: number): number {
  return lengthToBreadth > 1
    ? Math.sqrt(lengthToBreadth * lengthToBreadth - 1) / lengthToBreadth
    : 0;
}

export function simulateFireSpread(landscape: LandscapeGrid, scenario: FireScenario): FireRun {
  const startedAt = performance.now();
  const { width, height, fuelCodes, slopeTangent, upslopeDegrees, groundCellSizeMeters } =
    landscape;
  const cellCount = width * height;
  const spotting = scenario.spotting ?? DEFAULT_SPOTTING;
  const structureSpread = scenario.structureSpread ?? DEFAULT_STRUCTURE_SPREAD;

  // Structures are exposed at roof height, so the open wind drives them directly and no
  // midflame reduction is applied. The scaling is linear in wind and bounded.
  const structureWindFactor = Math.min(
    Math.max(
      scenario.windSpeedMph / STRUCTURE_SPREAD_REFERENCE_WIND_MPH,
      STRUCTURE_WIND_FACTOR_MIN,
    ),
    STRUCTURE_WIND_FACTOR_MAX,
  );
  const structureHeadRate = structureSpread.enabled
    ? Math.max(structureSpread.rateMetersPerMinute, 0) * structureWindFactor
    : 0;

  const originCell = cellAt(landscape, scenario.origin);
  if (originCell < 0) throw new Error("The ignition point is outside the modelled area.");
  const originFuel = fuelCodes[originCell];
  // Developed ground carries fire in this model whenever structure spread is on, so
  // refusing to ignite there would contradict the rest of the run. Every other
  // non-burnable code still refuses, and so does developed ground at a zero rate.
  const originIsStructure = originFuel === DEVELOPED_FUEL_CODE && structureHeadRate > 0;
  if (!isBurnable(originFuel) && !originIsStructure) throw new NonBurnableIgnitionError(originFuel);

  // One fuel bed per distinct fuel model present, reused by every cell that uses it.
  const midflameWind =
    scenario.windSpeedMph * FEET_PER_MINUTE_PER_MPH * scenario.midflameAdjustment;
  const windToward = (scenario.windFromDegrees + 180) % 360;
  const windTowardRadians = windToward * RADIANS_PER_DEGREE;
  const beds = new Map<number, ReturnType<typeof prepareFuelBed>>();
  for (const [code, fuel] of FUEL_MODELS) beds.set(code, prepareFuelBed(fuel, scenario.moisture));

  /** Maximum ember reach for a cell of this fireline intensity, ground metres. */
  const spotReachFor = (firelineIntensity: number): number => {
    if (!spotting.enabled || spotting.maxDistanceMeters <= 0) return 0;
    if (firelineIntensity < SPOTTING_MIN_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND) return 0;
    const reach =
      SPOTTING_DISTANCE_COEFFICIENT * scenario.windSpeedMph * Math.sqrt(firelineIntensity);
    return Math.min(reach, spotting.maxDistanceMeters);
  };

  // Per-cell spread: metres per minute at the head, heading, ellipse eccentricity, a
  // floor on the directional rate, and how far this cell can throw a firebrand.
  const headRate = new Float32Array(cellCount);
  const headingRadians = new Float32Array(cellCount);
  const eccentricity = new Float32Array(cellCount);
  const minDirectionalRate = new Float32Array(cellCount);
  const spotReach = new Float32Array(cellCount);
  /**
   * 1 where a cell holds a vegetated fuel model. Firebrands fly over everything else —
   * roads, parking lots, roofs, water, bare ground — and land in vegetation, so this is
   * both the ember-transparency mask and the set of cells a spot may ignite.
   */
  const vegetated = new Uint8Array(cellCount);
  const structureEccentricity = eccentricityOf(STRUCTURE_LENGTH_TO_BREADTH);
  const structureSpotReach = spotReachFor(STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND);
  let burnableCells = 0;
  let developedCells = 0;
  for (let i = 0; i < cellCount; i++) {
    const code = fuelCodes[i];
    if (code === DEVELOPED_FUEL_CODE) {
      developedCells++;
      if (structureHeadRate <= 0) continue;
      headRate[i] = structureHeadRate;
      headingRadians[i] = windTowardRadians;
      eccentricity[i] = structureEccentricity;
      minDirectionalRate[i] = structureHeadRate * STRUCTURE_BACKING_RATE_FRACTION;
      spotReach[i] = structureSpotReach;
      continue;
    }
    const bed = beds.get(code);
    if (!bed) continue;
    burnableCells++;
    vegetated[i] = 1;
    const spread = spreadFromBed(bed, midflameWind, windToward, slopeTangent[i], upslopeDegrees[i]);
    headRate[i] = spread.headRateFeetPerMinute * METERS_PER_FOOT;
    headingRadians[i] = spread.headingDegrees * RADIANS_PER_DEGREE;
    eccentricity[i] = eccentricityOf(spread.lengthToBreadth);
    // The rear-focus ellipse (Alexander 1985) drives the rate away from the head to
    // almost nothing once the fire is elongated: at the Anderson (1983) length-to-breadth
    // cap of 8 the flank rate is 0.8 percent of the head rate and the backing rate 0.4
    // percent, so one barrier cell directly downwind could stall an entire run. Observed
    // backing spread is not that slow, and Rothermel-based systems do not compute it that
    // way: BehavePlus takes the backing rate of spread to be the no-wind, no-slope rate
    // (Andrews, RMRS-GTR-371, 2018, section on directional spread). Flooring every
    // directional rate at that no-wind rate puts flanking and backing at roughly 2 to 5
    // percent of the head rate in these fuels. The cap of 8 itself is left alone: FARSITE
    // uses the same value and observed wind-driven ratios reach it, so lowering it would
    // be less supported than fixing the floor.
    minDirectionalRate[i] = spread.noWindRateFeetPerMinute * METERS_PER_FOOT;
    spotReach[i] = spotReachFor(spread.firelineIntensityBtuPerFootPerSecond);
  }

  const arrival = new Float64Array(cellCount).fill(Number.POSITIVE_INFINITY);
  arrival[originCell] = 0;
  const arrivalMechanism = new Uint8Array(cellCount);
  const settled = new Uint8Array(cellCount);
  const heap = new TimeHeap(Math.min(cellCount, 1 << 16));
  heap.push(0, originCell);

  const bearings = NEIGHBOURS.map(([dx, dy]) => Math.atan2(dx, -dy));
  const distances = NEIGHBOURS.map(([dx, dy]) => Math.hypot(dx, dy) * groundCellSizeMeters);

  // Downwind unit vector in grid space: +x is east, +y is south, so north is -y.
  const windStepX = Math.round(Math.sin(windTowardRadians));
  const windStepY = Math.round(-Math.cos(windTowardRadians));
  const spotRayX = SPOTTING_BEARING_OFFSETS_DEGREES.map((offset) =>
    Math.sin(windTowardRadians + offset * RADIANS_PER_DEGREE),
  );
  const spotRayY = SPOTTING_BEARING_OFFSETS_DEGREES.map(
    (offset) => -Math.cos(windTowardRadians + offset * RADIANS_PER_DEGREE),
  );
  const emberSpeedMetersPerMinute =
    ((scenario.windSpeedMph * METERS_PER_MILE) / 60) * SPOTTING_EMBER_SPEED_FRACTION;
  const spottingActive = spotting.enabled && emberSpeedMetersPerMinute > 0;
  const maxSpotCells = Math.min(
    SPOTTING_MAX_PATH_CELLS,
    Math.floor(Math.max(spotting.maxDistanceMeters, 0) / groundCellSizeMeters),
  );

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
    const sourceMechanism =
      fuelCodes[cell] === DEVELOPED_FUEL_CODE ? ARRIVAL_STRUCTURE : ARRIVAL_SURFACE;
    const floor = minDirectionalRate[cell];

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
      let rateToward =
        e > 0 ? (rate * (1 - e)) / (1 - e * Math.cos(bearings[n] - headingRadians[cell])) : rate;
      if (rateToward < floor) rateToward = floor;
      if (rateToward <= 0) continue;
      const candidate = time + distances[n] / rateToward;
      if (candidate < arrival[neighbour]) {
        arrival[neighbour] = candidate;
        arrivalMechanism[neighbour] = sourceMechanism;
        heap.push(candidate, neighbour);
      }
    }

    // Ember spotting, deliberately scoped to crossing unvegetated ground. A cell launches
    // only when the ground one step directly downwind holds no fuel model — a street, a
    // subdivision, a parking lot, a field, a river — and a ray ignites only the first
    // vegetated cell it finds after passing over at least one such cell. So firebrands
    // turn a gap into a delay instead of a wall, and can outrun a slow burn-through by
    // flying over a whole block, but they never leapfrog continuous wildland fuel, which
    // would inflate the head rate past anything the surface model supports.
    const reach = spotReach[cell];
    if (!spottingActive || reach <= 0 || maxSpotCells < 2) continue;
    const gapX = x + windStepX;
    const gapY = y + windStepY;
    if (gapX < 0 || gapY < 0 || gapX >= width || gapY >= height) continue;
    if (vegetated[gapY * width + gapX] === 1) continue;

    const rayCells = Math.min(maxSpotCells, Math.floor(reach / groundCellSizeMeters));
    for (let r = 0; r < spotRayX.length; r++) {
      const ux = spotRayX[r];
      const uy = spotRayY[r];
      let crossedGap = false;
      for (let step = 1; step <= rayCells; step++) {
        const sx = x + Math.round(ux * step);
        const sy = y + Math.round(uy * step);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) break;
        const target = sy * width + sx;
        if (vegetated[target] === 0) {
          crossedGap = true;
          continue;
        }
        // The first vegetated cell on this ray is where the brands land; past it the
        // ordinary surface solver takes over.
        if (!crossedGap || settled[target] || headRate[target] <= 0) break;
        const flightMeters = step * groundCellSizeMeters;
        const candidate =
          time + flightMeters / emberSpeedMetersPerMinute + SPOTTING_IGNITION_DELAY_MINUTES;
        if (candidate < arrival[target]) {
          arrival[target] = candidate;
          arrivalMechanism[target] = ARRIVAL_SPOTTING;
          heap.push(candidate, target);
        }
        break;
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

  let surfaceCells = 0;
  let spottingCells = 0;
  let structureCells = 0;
  for (let i = 0; i < cellCount; i++) {
    if (arrival[i] > scenario.horizonMinutes) continue;
    const mechanism = arrivalMechanism[i];
    if (mechanism === ARRIVAL_SPOTTING) spottingCells++;
    else if (mechanism === ARRIVAL_STRUCTURE) structureCells++;
    else surfaceCells++;
  }

  const originBed = beds.get(originFuel);
  return {
    model: SPREAD_MODEL,
    scenario,
    frames,
    ignition: {
      fuelCode: originFuel,
      fuelLabel: fuelLabel(originFuel),
      slopePercent: slopeTangent[originCell] * 100,
      elevationMeters: landscape.elevationMeters[originCell],
      spread: originBed
        ? spreadFromBed(
            originBed,
            midflameWind,
            windToward,
            slopeTangent[originCell],
            upslopeDegrees[originCell],
          )
        : structureIgnitionSpread(structureHeadRate, windToward),
    },
    burnableFraction: burnableCells / cellCount,
    developedFraction: developedCells / cellCount,
    fireCarryingFraction:
      (burnableCells + (structureHeadRate > 0 ? developedCells : 0)) / cellCount,
    appliedOptions: { spotting, structureSpread },
    arrivalBreakdown: {
      surfaceCells,
      spottingCells,
      structureCells,
      surfaceSquareMeters: surfaceCells * cellArea,
      spottingSquareMeters: spottingCells * cellArea,
      structureSquareMeters: structureCells * cellArea,
    },
    reachedEdge,
    cellSizeMeters: groundCellSizeMeters,
    computeMilliseconds: performance.now() - startedAt,
  };
}

/**
 * Ignition conditions for a fire started on developed ground. Rothermel does not describe
 * a burning subdivision, so every quantity the surface model would compute is reported as
 * zero rather than invented; only the assumed head rate, heading, ellipse, and the flame
 * length implied by `STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND` are filled in.
 */
function structureIgnitionSpread(
  structureHeadRateMetersPerMinute: number,
  windTowardDegrees: number,
): SpreadResult {
  const intensity = STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND;
  return {
    headRateFeetPerMinute: structureHeadRateMetersPerMinute / METERS_PER_FOOT,
    noWindRateFeetPerMinute: 0,
    reactionIntensityBtuPerFt2PerMinute: 0,
    windCoefficient: 0,
    slopeCoefficient: 0,
    effectiveWindFeetPerMinute: 0,
    beyondValidatedWind: false,
    headingDegrees: windTowardDegrees,
    lengthToBreadth: STRUCTURE_LENGTH_TO_BREADTH,
    flameLengthFeet: 0.45 * Math.pow(intensity, 0.46),
    firelineIntensityBtuPerFootPerSecond: intensity,
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
