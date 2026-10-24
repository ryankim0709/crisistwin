/**
 * Landscape fire growth: Rothermel rate of spread per landscape cell (LANDFIRE's native
 * 30 m, or a coarser resampled lattice for large areas — `LandscapeGrid.cellMeters`),
 * propagated as a minimum-travel-time arrival field (after Finney 2002), then contoured
 * into perimeters.
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
 * Above the surface model sits crown fire. A surface fire in forest is sheltered by the
 * stand it burns under, so the wind that drives it is a fraction of the open wind
 * (`windAdjustmentFactor`, Albini & Baughman 1979), and on its own that makes modelled
 * forest fires far slower than observed ones. Real forest fires get their speed by moving
 * into the canopy. `crownFire.ts` decides per cell whether the surface fire torches
 * (passive) or runs through the crowns (active) and returns the rate that results; this
 * module propagates that rate. Crown fire is evaluated only when
 * `LandscapeGrid.canopyComplete` says the canopy rasters actually loaded — missing canopy
 * runs surface-only and says so on the run rather than reading as treeless ground.
 *
 * A cell burns as crown fire for either of two reasons, and the distinction is the whole
 * reason crown state has to reach the relaxation loop:
 *
 *   - Its own surface fire initiates crowning. That is Van Wagner's (1977) intensity test
 *     against the cell's own surface fireline intensity, it depends on nothing outside the
 *     cell, and it is evaluated once per cell in the precompute.
 *   - An active crown fire is burning INTO it from the cell the fire arrives from, and its
 *     own canopy can carry an active crown fire (Van Wagner's critical mass flow criterion
 *     alone, `canSustainActiveCrown`). An established crown fire sustains itself through
 *     continuous canopy; requiring every cell to re-initiate from its own sheltered surface
 *     fire is exactly the under-prediction Cruz & Alexander (2010) identify in linked
 *     Rothermel/Van Wagner models, and with the midflame factor under a closed stand near
 *     0.10 it stopped every crown run dead at the edge of the timber. This half depends on
 *     which neighbour the fire arrives from, so it is decided during propagation.
 *
 * The precompute still evaluates no crown fire inside the loop: it stores both answers per
 * cell, and the loop only selects between them. A cell whose canopy cannot sustain crown
 * fire falls back to its surface rate, and a cell with no canopy is never touched.
 *
 * Nothing here uses randomness, so a scenario plus a landscape reproduces a run exactly
 * and no seed has to be recorded.
 *
 * Times are elapsed simulation-clock minutes from T+0: the single ignition on /fire, the
 * scenario start for `simulateScheduledFireSpread`. Distances inside the solver are
 * ground metres.
 */

import type { Feature, Polygon, Position } from "geojson";
import { FUEL_MODELS, NON_BURNABLE_CODES, fuelLabel, isBurnable } from "./fuelModels";
import { prepareFuelBed, spreadFromBed, type FuelMoisture, type SpreadResult } from "./rothermel";
import { mercatorToLonLat, type LandscapeGrid, type LandscapeResampling } from "./landscape";
// Re-exported because scenario builders (Simulation Studio) type moisture against this module.
export type { FuelMoisture } from "./rothermel";
import {
  DEFAULT_FOLIAR_MOISTURE_FRACTION,
  TEN_METER_WIND_PER_TWENTY_FOOT_WIND,
  activeCrownRateMetersPerMinute,
  canSustainActiveCrown,
  crownFireBehaviour,
  windAdjustmentFactor,
  type CanopyCell,
  type CrownFireResult,
} from "./crownFire";
// Type-only imports flow back from scheduledTypes.ts, so this is not a runtime cycle.
import {
  InvalidIgnitionsError,
  type FireSettings,
  type IgnitionOutcome,
  type ScheduledFireFrame,
  type ScheduledFireInput,
  type ScheduledFireRun,
} from "./scheduledTypes";

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
  /**
   * Share of the open wind that reaches midflame height, applied flat to every cell.
   *
   * This field is a user override, not the model's preferred input. While it is left at
   * `DEFAULT_MIDFLAME_ADJUSTMENT` and the landscape carries canopy data, the run derives
   * a factor per cell from canopy cover, canopy height and fuel bed depth instead
   * (`windAdjustmentFactor`, Albini & Baughman 1979). Set it to anything else and that
   * flat value is used everywhere. `FireRun.midflameWind` reports which applied and the
   * range of factors actually used.
   */
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

/**
 * Simulation-clock minutes between output frames. It is an output sampling interval, not
 * a solver time step: arrival times are continuous, and the frames are contours of the
 * same arrival field at multiples of this interval. It stays 15 minutes at every horizon
 * (a 24-hour run has 97 frames), so frame k is always at k x 15 minutes.
 */
export const FIRE_STEP_MINUTES = 15;
/**
 * Fixed horizon of every page run, minutes (24 hours). Wind, wind direction and fuel
 * moisture stay constant for the whole horizon — no diurnal cycle, no overnight humidity
 * recovery, no wind shift — so a run is a constant-weather stress test rather than a
 * forecast of a day's growth (docs/adr/0012-fire-large-areas.md).
 */
export const FIRE_HORIZON_MINUTES = 1440;
/**
 * Flat midflame fraction, kept as the scenario default, as the value the page's control
 * starts from, and as the fallback when no canopy data is available.
 *
 * Half the 20-foot wind is the round figure a BehavePlus user reaches for, but it is not
 * the Albini & Baughman (1979) value: their unsheltered factor depends on fuel bed depth
 * and comes out near 0.27 for a 0.2 ft conifer litter bed, 0.36 at 1 ft and 0.42 at 2 ft,
 * so 0.5 is 1.2 to 1.7 times too high across most of the Scott & Burgan set, and far more
 * than that under a closed canopy where the sheltered factor is a fraction of those. A run
 * that can see the canopy therefore derives the factor per cell and leaves this value
 * unused. Leaving the field at this default is what selects that behaviour; changing it
 * pins the flat value everywhere.
 */
export const DEFAULT_MIDFLAME_ADJUSTMENT = 0.5;
/**
 * Tolerance on the "has the user changed it?" test. The page's control steps in
 * hundredths, so anything this close to the default is the default rather than a
 * deliberate choice.
 */
const MIDFLAME_OVERRIDE_EPSILON = 1e-6;

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
/** Byram flame length of that assumed intensity, feet (about 10.4 ft). */
export const STRUCTURE_FLAME_LENGTH_FEET =
  0.45 * Math.pow(STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND, 0.46);

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
 * so the 500 m default ceiling binds first. The bound is in cells because it bounds work,
 * so in metres it grows with the cell (5.8 km at 120 m cells) and a coarse run honours a
 * page distance above 1.1 km that a native run would cut short; the effective ceiling is
 * reported as `FireRun.resolution.spottingReachCeilingMeters`. Coarse cells also make the
 * shortest spot longer: one gap cell and one landing cell is 240 m at 120 m cells.
 */
export const SPOTTING_MAX_PATH_CELLS = 48;

/**
 * Exact conversion from the Btu/ft/s that `rothermel.ts` reports to the kW/m the crown
 * model is formulated in: 1 Btu = 1055.05585262 J and 1 ft = 0.3048 m, so
 * 1 Btu/ft/s = 3.4613 kW/m. Getting this wrong by a factor of three and a half would move
 * every crown-initiation threshold without changing anything visible on screen, so the
 * conversion is named here and applied exactly once, at the call into `crownFireBehaviour`.
 */
export const KW_PER_METER_PER_BTU_PER_FOOT_PER_SECOND = 3.4613;
export const KILOMETERS_PER_MILE = 1.609344;

/**
 * Length-to-breadth of a fully developed (active) crown fire, from the 20-foot open wind.
 *
 * UNITS. The relation below is published on the 10 m open wind in km/h, and
 * `FireScenario.windSpeedMph` is the 20-foot wind in mph, so this function converts twice:
 * 20-foot to 10 m by `TEN_METER_WIND_PER_TWENTY_FOOT_WIND` (Turner & Lawson 1978,
 * U_20ft = 0.87 * U_10m — the same constant `crownFire.ts` applies before its own Cruz
 * call, imported rather than restated so the two cannot drift), then mph to km/h. Skipping
 * the first conversion left this function 13 percent low on wind and disagreeing with the
 * rate of spread it was shaping; at a 40 mph 20-foot wind it returned 7.23 where the
 * relation gives 7.82.
 *
 * Shape has to be handled explicitly, not inherited. The surface ellipse uses the
 * Anderson (1983) relation driven by the *midflame* wind, and under a closed canopy that
 * wind is now a small fraction of the open wind — a 40 mph day over a dense stand gives a
 * midflame wind near 4 mph and an Anderson length-to-breadth near 2.5, which is the shape
 * of the sheltered surface fire and emphatically not the shape of a crown fire running on
 * the wind above the canopy. Leaving crowning cells on that ellipse would have made a
 * crown run almost circular and inflated its area several-fold.
 *
 * So actively crowning cells take the length-to-breadth relation that was fitted to
 * conifer forest fires driven by the open wind: `1 + 8.729 * (1 - exp(-0.030 * U))^2.155`
 * with U the 10 m open wind in km/h — Alexander, "Estimating the length-to-breadth ratio
 * of elliptical forest fire patterns" (Proc. 8th Conf. Fire and Forest Meteorology, 1985),
 * as adopted by the Canadian Forest Fire Behavior Prediction System (Forestry Canada Fire
 * Danger Group, Information Report ST-X-3, 1992, eq. 79) for its conifer fuel types. It is
 * asymptotic to 9.729 rather than growing without bound, and at 40 mph it gives 7.2 where
 * an unsheltered surface fire in the same wind would sit at the Anderson cap of 8 — the
 * less elongated, plume-influenced shape a crown fire is expected to take.
 *
 * Passively crowning cells keep the surface ellipse. In Scott & Reinhardt's formulation a
 * passive crown fire is a surface fire that torches individual trees; its perimeter is
 * still the surface fire's perimeter, and no source supports giving it a different shape.
 * The jump at the passive/active boundary is a real discontinuity in the classification,
 * and it is already present in the spread rate.
 */
export const CROWN_LENGTH_TO_BREADTH_ASYMPTOTE = 8.729;
export const CROWN_LENGTH_TO_BREADTH_WIND_COEFFICIENT_PER_KM_PER_HOUR = 0.03;
export const CROWN_LENGTH_TO_BREADTH_EXPONENT = 2.155;

export function crownLengthToBreadth(twentyFootWindSpeedMph: number): number {
  const kilometersPerHour =
    Math.max(twentyFootWindSpeedMph, 0) * TEN_METER_WIND_PER_TWENTY_FOOT_WIND * KILOMETERS_PER_MILE;
  return (
    1 +
    CROWN_LENGTH_TO_BREADTH_ASYMPTOTE *
      Math.pow(
        1 - Math.exp(-CROWN_LENGTH_TO_BREADTH_WIND_COEFFICIENT_PER_KM_PER_HOUR * kilometersPerHour),
        CROWN_LENGTH_TO_BREADTH_EXPONENT,
      )
  );
}

/**
 * Half-width of the square of integer offsets the solver may step along, in cells.
 *
 * This is not a cosmetic smoothing parameter. On a lattice, minimum travel time reaches
 * exactly the convex hull of the per-direction rate vectors, so the discrete fire is a
 * polygon *inscribed* in the ellipse the model intends, and its breadth is set by the
 * single finest off-axis direction the stencil owns. At the `MAX_LENGTH_TO_BREADTH` cap of
 * 8 the ellipse's widest point sits only 7.2 degrees off the heading, while a radius-2
 * stencil's finest off-axis direction is atan(1/2) = 26.6 degrees, where the directional
 * rate has already fallen to 6.9 percent of the head rate. A measured sweep over GR2, SH5
 * and TU5 at 5 to 60 mph found the shipped 16-offset stencil producing an effective
 * length-to-breadth of 16 to 19 against an intended 8, a breadth 44 percent of intended,
 * and an area 32 percent of intended; refining the cell size eightfold converged on 16.1,
 * not on 8, which is the signature of the direction set rather than of the grid. The same
 * argument applies along the heading: with 16 offsets a fire whose wind bearing falls
 * between lattice directions reached as little as 22 percent of its analytic head
 * distance, so the same scenario rotated gave a different answer.
 *
 * Required radius scales roughly as the length-to-breadth itself. Measured on a uniform
 * GR2 grid at 40 mph: radius 2 gives 18.1, radius 3 gives 12.0, radius 4 gives 10.3,
 * radius 6 gives 8.50, radius 8 gives 8.03 against an intended 8.00, and the worst-case
 * bearing recovers 81 percent of the head distance instead of 22. Radius 8 is where the
 * error stops being the dominant term, and it costs nothing measurable: a richer stencil
 * touches more neighbours per settle but settles each cell in fewer hops, and the run is
 * dominated by the per-frame grid scan and the contouring.
 *
 * What it does not fix: the remaining 19 percent worst-case head deficit, which needs
 * either a lower `MAX_LENGTH_TO_BREADTH` or a solver that advances along the per-cell
 * heading instead of along lattice directions. That is recorded, not claimed as solved.
 *
 * The radius stays in cells on coarse landscapes, deliberately. What it buys is angular:
 * the direction set, and with it the ellipse the lattice can draw, depends only on the
 * offsets, not on how many metres a cell is. The price grows with the cell: a step
 * carries its source cell's rate up to 10.6 cells (offset (8, 7), 1.28 km at 120 m
 * cells), and only the passability of the cells it crosses is checked, not their rates,
 * so in patchy fuel a long step can run fast fuel's rate through a slower patch.
 * Barriers still hold at any cell size. See docs/adr/0012-fire-large-areas.md.
 */
export const NEIGHBOUR_STENCIL_RADIUS = 8;

export const SPREAD_MODEL = {
  id: "rothermel-1972-mtt",
  version: "4.1.0",
  surfaceSpread: "Rothermel (1972), per Andrews RMRS-GTR-371 (2018)",
  fuelModels: "Scott & Burgan (2005) 40 standard fire behavior fuel models",
  ellipse:
    "Anderson (1983) length-to-breadth; Alexander (1985) elliptical spread; Alexander (1985) / Canadian FBP System conifer length-to-breadth for actively crowning cells",
  crownFire:
    "Van Wagner (1977) crown initiation and critical mass flow rate, Cruz, Alexander & Wakimoto (2005) active crown rate of spread, Scott & Reinhardt (2001) crown fraction burned and surface/passive/active classification",
  midflameWind:
    "Albini & Baughman (1979) wind adjustment factor per cell from canopy cover, canopy height and fuel bed depth; a scenario midflame factor moved off its default overrides it everywhere",
  propagation:
    "Minimum travel time over the landscape grid (LANDFIRE 30 m, or a coarser mode-resampled lattice for large areas) (after Finney 2002), stepped along every integer offset within 8 cells with no common factor (176 directions)",
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
  /**
   * Crown fire behaviour at the ignition cell, or null when crown fire was not modelled
   * (no canopy data) or the cell carries no wildland fuel bed. `spread` stays the surface
   * result in every case, so the two can be compared.
   */
  crown: CrownFireResult | null;
  /** Share of the open wind that reached midflame height in this cell, 0 to 1. */
  midflameAdjustment: number;
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

/**
 * What kind of fire burned the ground that burned, as distinct from how fire got there.
 * Same shape as `ArrivalBreakdown` and over the same set of cells, so the two sets of
 * areas add up to the same total and can be shown side by side.
 *
 * Every cell with no canopy is surface by definition, and that includes grass, brush and
 * burning developed ground. When `CrownFireStatus.modelled` is false the whole burn is
 * reported as surface, because nothing else was evaluated.
 */
export interface CrownFireBreakdown {
  /** Burned without the fire entering the canopy. */
  surfaceCells: number;
  /** Surface fire torching individual trees or groups (Scott & Reinhardt passive). */
  passiveCrownCells: number;
  /** Fire carried through the canopy as a solid flame front (active). */
  activeCrownCells: number;
  surfaceSquareMeters: number;
  passiveCrownSquareMeters: number;
  activeCrownSquareMeters: number;
}

export interface CrownFireStatus {
  /** True when the canopy rasters loaded, so crown initiation was evaluated per cell. */
  modelled: boolean;
  /**
   * Why crown fire was not modelled, for the UI to show verbatim. Empty when it was.
   * Never left implicit: a run with no canopy data is a surface-only run, not a run over
   * treeless ground.
   */
  unavailableReason: string;
  /** Foliar moisture `crownFireBehaviour` assumes, fraction of oven-dry weight. */
  foliarMoistureFraction: number;
  /** Length-to-breadth applied to actively crowning cells at this scenario's wind. */
  activeCrownLengthToBreadth: number;
}

/** Which of the two midflame-wind behaviours a run used, and what it produced. */
export type MidflameWindSource =
  "per-cell-canopy" | "scenario-override" | "scenario-default-no-canopy";

export interface MidflameWindSummary {
  source: MidflameWindSource;
  /** The scenario's flat factor, whether or not it was the one applied. */
  scenarioAdjustment: number;
  /** Mean, minimum and maximum of the factors actually applied over fuel-bearing cells. */
  appliedMeanAdjustment: number;
  appliedMinAdjustment: number;
  appliedMaxAdjustment: number;
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
  /** Whether crown fire was modelled at all, and under what assumptions. */
  crownFire: CrownFireStatus;
  /** The same burned ground at the horizon, split by surface, passive and active crown. */
  crownFireBreakdown: CrownFireBreakdown;
  /** Which midflame-wind behaviour applied, and the factors it produced. */
  midflameWind: MidflameWindSummary;
  /** True when fire reached the edge of the modelled area, so the run is truncated. */
  reachedEdge: boolean;
  /** Ground metres per cell, same as `resolution.groundCellSizeMeters`. */
  cellSizeMeters: number;
  /**
   * Resolution the run was solved at, for the page to state. Copied from the landscape so
   * a run carries it wherever it is read.
   */
  resolution: FireRunResolution;
  computeMilliseconds: number;
  /**
   * Fire arrival time per landscape cell, minutes since ignition, in the same row-major
   * order as `LandscapeGrid.fuelCodes`; `Infinity` where fire never arrives. Arrivals past
   * the horizon are kept so renderers can clamp them consistently with the frames.
   */
  arrivalMinutes: Float32Array;
}

export interface FireRunResolution {
  /** `LandscapeGrid.cellMeters`: 30 for LANDFIRE's native lattice, else the coarse cell. */
  cellMeters: number;
  /** Ground metres per cell actually used for distances, areas and slope. */
  groundCellSizeMeters: number;
  /** `LandscapeGrid.resampling`: "native", or how coarse cells were filled. */
  resampling: LandscapeResampling;
  /** Longest straight step the solver takes, ground metres (offset (8, 7) x cell). */
  maxStepMeters: number;
  /**
   * Furthest a firebrand could travel in this run, ground metres: the scenario's
   * `maxDistanceMeters` cut to `SPOTTING_MAX_PATH_CELLS` cells. 0 when spotting is off.
   */
  spottingReachCeilingMeters: number;
}

export class NonBurnableIgnitionError extends Error {
  constructor(readonly fuelCode: number) {
    super(
      `The ignition point is on ${(NON_BURNABLE_CODES.get(fuelCode) ?? "unmapped ground").toLowerCase()}, which carries no fire. Place it on vegetated ground.`,
    );
    this.name = "NonBurnableIgnitionError";
  }
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * Every integer offset inside the `NEIGHBOUR_STENCIL_RADIUS` square whose components share
 * no common factor. Dropping offsets with a common factor drops only duplicates of a
 * shorter step in the same direction, which carry no information and cost solver time.
 * At radius 8 this is 176 directions, the finest of them 7.1 degrees off axis.
 */
function buildStencil(radius: number): readonly (readonly [number, number])[] {
  const offsets: (readonly [number, number])[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (greatestCommonDivisor(Math.abs(dx), Math.abs(dy)) !== 1) continue;
      offsets.push([dx, dy]);
    }
  }
  return offsets;
}

const NEIGHBOURS = buildStencil(NEIGHBOUR_STENCIL_RADIUS);

/**
 * Cells a step passes over, as offsets from its origin: the nearest cell to the straight
 * line at each intermediate position, `round(dx * s / steps), round(dy * s / steps)` for
 * s from 1 to steps - 1 with steps the Chebyshev length of the offset.
 *
 * Every one of them has to be passable, not just one of them. The radius-2 stencil's
 * guard accepted a two-cell step when *either* candidate midpoint was passable, and
 * generalising that to long offsets leaks badly: at radius 8 a one-cell water barrier let
 * 417 cells ignite behind it, which is fire crossing up to 190 m of road, river or
 * firebreak in a single hop. Requiring the whole line was re-tested at radius 2, 6 and 8
 * against 1, 2, 4, 8 and 9-cell walls with nothing beyond the wall in any case.
 *
 * "Passable" is a positive head rate, not a vegetated fuel model, so developed ground
 * carries a step through exactly when structure spread has given it a rate. Ember
 * spotting is unaffected: it is a separate mechanism with its own rules and it is the
 * only thing in this model that may cross a barrier.
 */
function buildBarrierPath(
  offset: readonly [number, number],
): readonly (readonly [number, number])[] {
  const [dx, dy] = offset;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const path: (readonly [number, number])[] = [];
  for (let s = 1; s < steps; s++) {
    path.push([Math.round((dx * s) / steps), Math.round((dy * s) / steps)]);
  }
  return path;
}

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

/** Fire type in a cell; indexes the `CrownFireBreakdown`. */
const CROWN_SURFACE = 0;
const CROWN_PASSIVE = 1;
const CROWN_ACTIVE = 2;

/** Said verbatim on a run whose landscape could not supply canopy data. */
export const CROWN_FIRE_UNAVAILABLE_REASON =
  "Canopy data did not load for this area, so this run is surface fire only. Forest spread is understated: it is modelled as a sheltered surface fire with no torching or crowning.";

function eccentricityOf(lengthToBreadth: number): number {
  return lengthToBreadth > 1
    ? Math.sqrt(lengthToBreadth * lengthToBreadth - 1) / lengthToBreadth
    : 0;
}

/** Said verbatim when an ignition point falls off the landscape grid. */
const OUTSIDE_LANDSCAPE_MESSAGE = "The ignition point is outside the modelled area.";

/** A point fire source as the solver core sees it: where, and from which T+0 minute. */
interface SolverSource {
  location: GeoPoint;
  startMinute: number;
}

/** A source that cannot ignite, by its position in the source list. */
type SolverSourceProblem =
  | { sourceIndex: number; reason: "outside-landscape" }
  | { sourceIndex: number; reason: "non-burnable"; fuelCode: number };

/** Run-level fields `FireRun` and `ScheduledFireRun` share, as totals at the horizon. */
type SpreadRunTotals = Pick<
  FireRun,
  | "burnableFraction"
  | "developedFraction"
  | "fireCarryingFraction"
  | "appliedOptions"
  | "arrivalBreakdown"
  | "crownFire"
  | "crownFireBreakdown"
  | "midflameWind"
  | "cellSizeMeters"
>;

/** What the solver core hands both public entry points. */
/**
 * Control lines built by firefighters, per landscape cell (row-major like `fuelCodes`).
 * Planned outside the solver (studio/firefighting.ts); the solver only enforces them.
 *
 * A cell with `holdFromMinute[i] <= t` is a constructed line at time t, judged at the time
 * fire would arrive there (not when the cell behind it caught). Fire never crosses a built
 * line on a multi-cell step. It may burn into it from an adjacent cell
 * only when the flame facing the line in that direction is longer than
 * `holdsFlameLengthFeet[i]` (the line is breached there), and then spreads on from it.
 * Judging breaches on adjacent steps only keeps a fire running along a line from cutting
 * across it at a shallow angle with head-fire intensity. Embers do not land in a built
 * line cell but still fly over it.
 */
export interface ControlLines {
  /** Minute from which the cell is built line; `Infinity` where there is no line. */
  holdFromMinute: Float32Array;
  /** Longest flame, feet, the crew that built this cell can hold (direct-attack limit). */
  holdsFlameLengthFeet: Float32Array;
}

/**
 * Byram (1959): flame length L = 0.45 I^0.46 (feet, Btu/ft/s), and fireline intensity I is
 * proportional to the rate of spread for a given fuel consumption, so the flame facing a
 * line in a direction spreading at rate R is L_head (R / R_head)^0.46. A flank or backing
 * fire therefore meets a line with a far shorter flame than the head.
 */
export const BYRAM_FLAME_EXPONENT = 0.46;

interface SpreadSolution {
  /** Arrival per cell, minutes from T+0; +Infinity where fire never arrived. */
  arrival: Float64Array;
  /**
   * Index into the source list of the source whose fire set each cell's arrival, -1 where
   * none did. Final for every settled cell, since a settled cell is never relaxed again.
   */
  firstSource: Int32Array;
  /** Cells in the order they settled, which is nondecreasing arrival; first `settledCount`. */
  settledOrder: Int32Array;
  settledCount: number;
  /** Grid cell of each source, same order as the sources. */
  sourceCells: number[];
  /** Fuel, slope and spread at each source's cell, same order as the sources. */
  ignitions: IgnitionConditions[];
  reachedEdge: boolean;
  /** Arrival time of the first edge cell settled, minutes from T+0, or null. */
  reachedEdgeMinute: number | null;
  totals: SpreadRunTotals;
  /** Resolution the field was solved at; only `FireRun` reports it today. */
  resolution: FireRunResolution;
}

/** Inclusive bounding box of reached cells, grid columns and rows. */
interface CellBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface FrameTally {
  elapsedMinutes: number;
  /** Cells with arrival <= elapsedMinutes. */
  reachedCells: number;
  /** The same cells split by `SpreadSolution.firstSource`. Live: read it inside `visit`. */
  reachedCellsBySource: Int32Array;
  /** Greatest ground distance of a reached cell from `reachFromCell`, metres. */
  maxReachMeters: number;
  /** Null when no cell has been reached. */
  box: CellBox | null;
}

/**
 * Single-origin run for /fire: one source at minute 0, a frame every `stepMinutes` to the
 * horizon. A thin wrapper over the same core as `simulateScheduledFireSpread`, with the
 * refusals /fire has always thrown.
 */
export function simulateFireSpread(landscape: LandscapeGrid, scenario: FireScenario): FireRun {
  const startedAt = performance.now();
  const solution = solveSpread(
    landscape,
    scenario,
    [{ location: scenario.origin, startMinute: 0 }],
    null,
    null,
    (problems) => {
      const problem = problems[0];
      if (problem.reason === "non-burnable") throw new NonBurnableIgnitionError(problem.fuelCode);
      throw new Error(OUTSIDE_LANDSCAPE_MESSAGE);
    },
  );

  const cellArea = landscape.groundCellSizeMeters * landscape.groundCellSizeMeters;
  const frameMinutes: number[] = [];
  for (let minutes = 0; minutes <= scenario.horizonMinutes; minutes += scenario.stepMinutes) {
    frameMinutes.push(minutes);
  }
  const frames: FireFrame[] = [];
  tallyFrames(landscape, solution, frameMinutes, 1, solution.sourceCells[0], (tally) => {
    frames.push({
      elapsedMinutes: tally.elapsedMinutes,
      perimeters:
        tally.elapsedMinutes === 0
          ? []
          : contour(landscape, solution.arrival, tally.elapsedMinutes, tally.box),
      burnedAreaSquareMeters: tally.reachedCells * cellArea,
      maxReachMeters: tally.maxReachMeters,
    });
  });

  return {
    model: SPREAD_MODEL,
    scenario,
    frames,
    ignition: solution.ignitions[0],
    ...solution.totals,
    reachedEdge: solution.reachedEdge,
    resolution: solution.resolution,
    computeMilliseconds: performance.now() - startedAt,
    arrivalMinutes: Float32Array.from(solution.arrival),
  };
}

/**
 * Several point fires, each with its own start minute, on one landscape grid and one
 * arrival field. Semantics are in docs/adr/0011-simulation-studio.md, "Solver semantics".
 *
 * Throws `InvalidIgnitionsError` listing every source that is off the grid or on ground
 * that carries no fire, and a plain `Error` for input that breaks the contract in
 * `scheduledTypes.ts` (no sources, duplicate ids, bad start or frame minutes).
 */
export function simulateScheduledFireSpread(
  landscape: LandscapeGrid,
  input: ScheduledFireInput,
  controlLines: ControlLines | null = null,
  outFromMinuteBySource: readonly number[] | null = null,
): ScheduledFireRun {
  const startedAt = performance.now();
  assertScheduledInput(input);
  const { settings, sources, frameMinutes } = input;
  const solution = solveSpread(
    landscape,
    settings,
    sources,
    controlLines,
    outFromMinuteBySource,
    (problems) => {
      throw new InvalidIgnitionsError(
        problems.map((problem) =>
          problem.reason === "non-burnable"
            ? {
                sourceId: sources[problem.sourceIndex].id,
                reason: problem.reason,
                message: new NonBurnableIgnitionError(problem.fuelCode).message,
                fuelCode: problem.fuelCode,
              }
            : {
                sourceId: sources[problem.sourceIndex].id,
                reason: problem.reason,
                message: OUTSIDE_LANDSCAPE_MESSAGE,
              },
        ),
      );
    },
  );

  // Every source cell was seeded at its start minute, so its final arrival is either that
  // minute (the source ignited, including an exact tie with another fire) or strictly
  // earlier, set by whichever fire got there first.
  const ignitions = sources.map((source, index) => {
    const cell = solution.sourceCells[index];
    const arrivalMinutes = solution.arrival[cell];
    const outcome: IgnitionOutcome =
      arrivalMinutes < source.startMinute
        ? {
            status: "reached-before-start",
            reachedMinute: arrivalMinutes,
            reachedBySourceId: sources[solution.firstSource[cell]].id,
          }
        : { status: "ignited", ignitedMinute: source.startMinute };
    return { sourceId: source.id, outcome, conditions: solution.ignitions[index] };
  });

  const cellArea = landscape.groundCellSizeMeters * landscape.groundCellSizeMeters;
  const frames: ScheduledFireFrame[] = [];
  tallyFrames(landscape, solution, frameMinutes, sources.length, null, (tally) => {
    frames.push({
      elapsedMinutes: tally.elapsedMinutes,
      perimeters: contour(landscape, solution.arrival, tally.elapsedMinutes, tally.box),
      reachedAreaSquareMeters: tally.reachedCells * cellArea,
      // fromEntries, not assignment into `{}`, so an id such as "__proto__" stays a key.
      reachedAreaBySourceSquareMeters: Object.fromEntries(
        sources.map((source, index) => [source.id, tally.reachedCellsBySource[index] * cellArea]),
      ),
      ignitedSourceIds: ignitions
        .filter(
          ({ outcome }) =>
            outcome.status === "ignited" && outcome.ignitedMinute <= tally.elapsedMinutes,
        )
        .map(({ sourceId }) => sourceId),
    });
  });

  return {
    model: SPREAD_MODEL,
    input,
    frames,
    ignitions,
    ...solution.totals,
    reachedEdge: solution.reachedEdge,
    reachedEdgeMinute: solution.reachedEdgeMinute,
    computeMilliseconds: performance.now() - startedAt,
    arrivalMinutes: Float32Array.from(solution.arrival),
    sourceIndexByCell: Int8Array.from(solution.firstSource, (source, cell) =>
      solution.arrival[cell] <= settings.horizonMinutes ? source : -1,
    ),
  };
}

/** Contract checks from `scheduledTypes.ts` that do not need the landscape. */
function assertScheduledInput({ settings, sources, frameMinutes }: ScheduledFireInput): void {
  const horizon = settings.horizonMinutes;
  if (!Number.isFinite(horizon) || horizon <= 0) {
    throw new Error(`The horizon must be a positive number of minutes, not ${horizon}.`);
  }
  if (sources.length === 0) throw new Error("A scheduled run needs at least one ignition.");
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`Ignition id "${source.id}" is used twice.`);
    ids.add(source.id);
    const { latitude, longitude } = source.location;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Ignition "${source.id}" has no valid location.`);
    }
    const start = source.startMinute;
    if (!Number.isInteger(start) || start < 0 || start >= horizon) {
      throw new Error(
        `Ignition "${source.id}" starts at minute ${start}; it must be a whole minute from 0 to before the ${horizon}-minute horizon.`,
      );
    }
  }
  frameMinutes.forEach((minutes, index) => {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > horizon) {
      throw new Error(`Frame minute ${minutes} is outside 0 to ${horizon}.`);
    }
    if (index > 0 && minutes <= frameMinutes[index - 1]) {
      throw new Error("Frame minutes must be strictly ascending.");
    }
  });
}

/**
 * Walks the settled cells once, in arrival order, emitting one tally per frame minute.
 *
 * For any m within the horizon, a cell has arrival <= m exactly when it settled at a time
 * <= m: the heap settles in nondecreasing arrival order, a cell's settle time is its final
 * arrival, and the loop stops only once every remaining arrival is past the horizon. So
 * this produces the same cell sets, counts and maxima as a full-grid scan per frame, in
 * one pass instead of one pass per frame. `frameMinutes` must be ascending.
 */
function tallyFrames(
  landscape: LandscapeGrid,
  solution: SpreadSolution,
  frameMinutes: readonly number[],
  sourceCount: number,
  reachFromCell: number | null,
  visit: (tally: FrameTally) => void,
): void {
  const { width, groundCellSizeMeters } = landscape;
  const { arrival, firstSource, settledOrder, settledCount } = solution;
  const fromX = reachFromCell === null ? 0 : reachFromCell % width;
  const fromY = reachFromCell === null ? 0 : (reachFromCell - fromX) / width;
  const reachedCellsBySource = new Int32Array(sourceCount);
  let next = 0;
  let reachedCells = 0;
  let maxReachMeters = 0;
  let minX = width;
  let maxX = -1;
  let minY = landscape.height;
  let maxY = -1;
  for (const minutes of frameMinutes) {
    while (next < settledCount) {
      const cell = settledOrder[next];
      if (arrival[cell] > minutes) break;
      next++;
      reachedCells++;
      reachedCellsBySource[firstSource[cell]]++;
      const x = cell % width;
      const y = (cell - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (reachFromCell !== null) {
        const reach = Math.hypot(x - fromX, y - fromY) * groundCellSizeMeters;
        if (reach > maxReachMeters) maxReachMeters = reach;
      }
    }
    visit({
      elapsedMinutes: minutes,
      reachedCells,
      reachedCellsBySource,
      maxReachMeters,
      box: reachedCells > 0 ? { minX, maxX, minY, maxY } : null,
    });
  }
}

/**
 * The shared solver: precompute per-cell spread, seed every source at its start minute,
 * and relax one minimum-travel-time arrival field to the horizon. Calls `rejectSources`
 * with every source that cannot ignite before doing any work.
 */
function solveSpread(
  landscape: LandscapeGrid,
  scenario: FireSettings,
  sources: readonly SolverSource[],
  controlLines: ControlLines | null,
  outFromMinuteBySource: readonly number[] | null,
  rejectSources: (problems: readonly SolverSourceProblem[]) => never,
): SpreadSolution {
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

  // Every source is checked and every problem collected before any work is done.
  const sourceCells = sources.map((source) => cellAt(landscape, source.location));
  const isSourceCell = new Uint8Array(cellCount);
  const sourceProblems: SolverSourceProblem[] = [];
  sourceCells.forEach((originCell, sourceIndex) => {
    if (originCell < 0) {
      sourceProblems.push({ sourceIndex, reason: "outside-landscape" });
      return;
    }
    isSourceCell[originCell] = 1;
    const originFuel = fuelCodes[originCell];
    // Developed ground carries fire in this model whenever structure spread is on, so
    // refusing to ignite there would contradict the rest of the run. Every other
    // non-burnable code still refuses, and so does developed ground at a zero rate.
    const originIsStructure = originFuel === DEVELOPED_FUEL_CODE && structureHeadRate > 0;
    if (!isBurnable(originFuel) && !originIsStructure) {
      sourceProblems.push({ sourceIndex, reason: "non-burnable", fuelCode: originFuel });
    }
  });
  if (sourceProblems.length > 0) rejectSources(sourceProblems);

  // Midflame wind: per cell from the canopy, or flat from the scenario. The precedence is
  // deliberate and is reported on the run. The scenario field wins whenever the user has
  // moved it off its default, because that is the only signal available that a number
  // chosen by hand should not be silently replaced by a derived one. Otherwise, when the
  // canopy rasters loaded, each cell gets the Albini & Baughman (1979) factor for its own
  // cover, stand height and fuel bed depth. When they did not load, the flat default is
  // used unchanged: without canopy data there is no honest way to tell a sheltered cell
  // from an open one, and applying the unsheltered formula everywhere would be asserting
  // that the landscape has no trees.
  const canopyModelled = landscape.canopyComplete;
  const userOverrodeMidflame =
    Math.abs(scenario.midflameAdjustment - DEFAULT_MIDFLAME_ADJUSTMENT) > MIDFLAME_OVERRIDE_EPSILON;
  const midflameWindSource: MidflameWindSource = userOverrodeMidflame
    ? "scenario-override"
    : canopyModelled
      ? "per-cell-canopy"
      : "scenario-default-no-canopy";
  const deriveMidflamePerCell = midflameWindSource === "per-cell-canopy";
  const scenarioMidflameWind =
    scenario.windSpeedMph * FEET_PER_MINUTE_PER_MPH * scenario.midflameAdjustment;

  // One fuel bed per distinct fuel model present, reused by every cell that uses it.
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
  /** Surface head-fire flame length, feet (Byram), for testing control lines. */
  const headFlameFeet = new Float32Array(cellCount);
  /**
   * 1 where a cell holds a vegetated fuel model. Firebrands fly over everything else —
   * roads, parking lots, roofs, water, bare ground — and land in vegetation, so this is
   * both the ember-transparency mask and the set of cells a spot may ignite.
   */
  const vegetated = new Uint8Array(cellCount);
  /** Fire type per cell, one of `CROWN_SURFACE`, `CROWN_PASSIVE`, `CROWN_ACTIVE`. */
  const crownType = new Uint8Array(cellCount).fill(CROWN_SURFACE);
  /**
   * Whether this cell's own canopy can sustain an active crown fire arriving from
   * outside (Van Wagner's critical mass flow criterion alone, independent of this cell's
   * own surface intensity). Set once per cell in this precompute, same as `crownType`;
   * the relaxation loop only reads it, it never calls `canSustainActiveCrown` itself.
   */
  const canSustainCrown = new Uint8Array(cellCount);
  /**
   * The rate this cell would run at if reason (b) applies — fire arrives already
   * actively crowning and this canopy can carry it onward. Floored at the surface rate,
   * same construction as the self-initiated active rate, so the two are directly
   * comparable. 0 where `canSustainCrown` is 0.
   */
  const sustainedCrownRateMetersPerMinute = new Float32Array(cellCount);
  const structureEccentricity = eccentricityOf(STRUCTURE_LENGTH_TO_BREADTH);
  const structureSpotReach = spotReachFor(STRUCTURE_FIRELINE_INTENSITY_BTU_PER_FOOT_PER_SECOND);

  // One mutable canopy record, rewritten per cell rather than allocated per cell: a
  // 600 x 600 grid would otherwise make 360,000 short-lived objects in the precompute.
  // `crownFireBehaviour` reads it and returns plain numbers, so nothing retains it.
  const canopy: CanopyCell = {
    baseHeightMeters: 0,
    bulkDensityKgPerM3: 0,
    coverFraction: 0,
    heightMeters: 0,
  };
  const activeCrownLengthToBreadth = crownLengthToBreadth(scenario.windSpeedMph);
  const activeCrownEccentricity = eccentricityOf(activeCrownLengthToBreadth);
  let midflameSum = 0;
  let midflameMin = Number.POSITIVE_INFINITY;
  let midflameMax = 0;
  let midflameCells = 0;
  // Conditions the precompute produced at each source cell, keyed by cell.
  const sourceSpread = new Map<number, SpreadResult>();
  const sourceCrown = new Map<number, CrownFireResult>();
  const sourceMidflameAdjustment = new Map<number, number>();

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
      headFlameFeet[i] = STRUCTURE_FLAME_LENGTH_FEET;
      continue;
    }
    const bed = beds.get(code);
    const fuel = FUEL_MODELS.get(code);
    if (!bed || !fuel) continue;
    burnableCells++;
    vegetated[i] = 1;

    canopy.baseHeightMeters = landscape.canopyBaseHeightMeters[i];
    canopy.bulkDensityKgPerM3 = landscape.canopyBulkDensityKgPerM3[i];
    canopy.coverFraction = landscape.canopyCoverFraction[i];
    canopy.heightMeters = landscape.canopyHeightMeters[i];

    // `windAdjustmentFactor` returns a bounded share of the open wind, sheltered under a
    // stand and unsheltered where there is none, so it needs no clamping here.
    const midflameAdjustment = deriveMidflamePerCell
      ? windAdjustmentFactor(canopy, fuel.depthFeet)
      : scenario.midflameAdjustment;
    const midflameWind = deriveMidflamePerCell
      ? scenario.windSpeedMph * FEET_PER_MINUTE_PER_MPH * midflameAdjustment
      : scenarioMidflameWind;
    midflameSum += midflameAdjustment;
    if (midflameAdjustment < midflameMin) midflameMin = midflameAdjustment;
    if (midflameAdjustment > midflameMax) midflameMax = midflameAdjustment;
    midflameCells++;

    const spread = spreadFromBed(bed, midflameWind, windToward, slopeTangent[i], upslopeDegrees[i]);
    const surfaceRateMetersPerMinute = spread.headRateFeetPerMinute * METERS_PER_FOOT;
    let rateMetersPerMinute = surfaceRateMetersPerMinute;
    let cellEccentricity = eccentricityOf(spread.lengthToBreadth);

    // Crown fire. Evaluated here, once per cell, and never in the relaxation loop: the
    // loop reads only the rate, heading and eccentricity this block writes.
    if (canopyModelled) {
      const crown = crownFireBehaviour(
        surfaceRateMetersPerMinute,
        spread.firelineIntensityBtuPerFootPerSecond * KW_PER_METER_PER_BTU_PER_FOOT_PER_SECOND,
        canopy,
        scenario.windSpeedMph,
        scenario.moisture.dead1h,
      );
      if (isSourceCell[i]) sourceCrown.set(i, crown);
      if (crown.type !== "surface") {
        crownType[i] = crown.type === "active" ? CROWN_ACTIVE : CROWN_PASSIVE;
        // A crown fire is driven by the surface fire beneath it, so it cannot be slower
        // than that surface fire. Enforced rather than assumed; a non-finite rate is a
        // contract violation in crownFire.ts and falls back to the surface rate instead
        // of poisoning the cell with NaN, which would silently make it unburnable.
        rateMetersPerMinute = Number.isFinite(crown.rateMetersPerMinute)
          ? Math.max(surfaceRateMetersPerMinute, crown.rateMetersPerMinute)
          : surfaceRateMetersPerMinute;
        if (crown.type === "active") cellEccentricity = activeCrownEccentricity;
      }

      // Reason (b), stored but not selected here. This is a property of the canopy and
      // the weather alone (Van Wagner's critical mass flow criterion), independent of
      // whether THIS cell's own surface fire is intense enough to initiate crowning, so
      // it is computed unconditionally rather than only when `crown.type !== "surface"`.
      if (canSustainActiveCrown(canopy, scenario.windSpeedMph, scenario.moisture.dead1h)) {
        canSustainCrown[i] = 1;
        sustainedCrownRateMetersPerMinute[i] = Math.max(
          surfaceRateMetersPerMinute,
          activeCrownRateMetersPerMinute(
            scenario.windSpeedMph,
            canopy.bulkDensityKgPerM3,
            scenario.moisture.dead1h,
          ),
        );
      }
    }

    if (isSourceCell[i]) {
      sourceSpread.set(i, spread);
      sourceMidflameAdjustment.set(i, midflameAdjustment);
    }

    headRate[i] = rateMetersPerMinute;
    headingRadians[i] = spread.headingDegrees * RADIANS_PER_DEGREE;
    eccentricity[i] = cellEccentricity;
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
    //
    // The floor stays the *surface* no-wind rate in a crowning cell. A crown fire does
    // not back; what spreads against the wind behind it is the surface fire, and that is
    // what this floor represents.
    minDirectionalRate[i] = spread.noWindRateFeetPerMinute * METERS_PER_FOOT;
    // Ember reach likewise stays on the surface fireline intensity, deliberately. The
    // spotting coefficient and the 500 m ceiling were both set for fires that are not
    // crowning, and the kilometre-plus spots reported from Camp and Tubbs came from
    // plume-dominated crown fire. Feeding crown intensity through a relation calibrated
    // on non-crowning fires would manufacture that reach rather than model it, so this
    // model still understates spotting wherever it is now predicting crown fire. That is
    // a known conservative simplification, not an oversight.
    spotReach[i] = spotReachFor(spread.firelineIntensityBtuPerFootPerSecond);
    headFlameFeet[i] = spread.flameLengthFeet;
  }

  const arrival = new Float64Array(cellCount).fill(Number.POSITIVE_INFINITY);
  const arrivalMechanism = new Uint8Array(cellCount);
  const firstSource = new Int32Array(cellCount).fill(-1);
  /**
   * Whether the edge that currently holds each cell's best-known (possibly still
   * provisional) arrival time came from a source that was itself spreading as an active
   * crown fire. Updated in lockstep with `arrival` and `arrivalMechanism` every time a
   * candidate improves on the stored arrival time, so it always describes the same edge
   * `arrival` does. Because Dijkstra over nonnegative edge weights pops each cell for the
   * first time at its final minimal arrival time, the value read back when a cell is
   * popped is the value belonging to the path that actually won — never a later, losing
   * update — which is what lets the relaxation loop select this cell's outgoing crown
   * state once, at settle time, and never revisit it.
   */
  const arrivedFromActiveCrown = new Uint8Array(cellCount);
  const settled = new Uint8Array(cellCount);
  const settledOrder = new Int32Array(cellCount);
  let settledCount = 0;
  const heap = new TimeHeap(Math.min(cellCount, 1 << 16));
  // Each source enters the field at its own start minute, in input order. Strict `<` keeps
  // the earlier-listed of two sources on one cell at one minute, and the relaxation below
  // also uses strict `<`, so a fire arriving exactly at a source's start leaves the cell
  // with that source: the "ignited" tie rule in scheduledTypes.ts.
  sourceCells.forEach((originCell, sourceIndex) => {
    const startMinute = sources[sourceIndex].startMinute;
    if (startMinute < arrival[originCell]) {
      arrival[originCell] = startMinute;
      firstSource[originCell] = sourceIndex;
      // An ignition starts as a surface fire; only an arrival from an already actively
      // crowning neighbour may carry crown state into the cell (see the settle step).
      arrivedFromActiveCrown[originCell] = 0;
      heap.push(startMinute, originCell);
    }
  });

  const bearings = NEIGHBOURS.map(([dx, dy]) => Math.atan2(dx, -dy));
  const distances = NEIGHBOURS.map(([dx, dy]) => Math.hypot(dx, dy) * groundCellSizeMeters);

  // Barrier paths as flat relative cell indices, built once for this grid width. The
  // intermediate cells of an offset always lie inside its bounding box, so once the
  // destination is known to be on the grid these indices need no further bounds check.
  const barrierStart = new Int32Array(NEIGHBOURS.length + 1);
  const barrierOffsets: number[] = [];
  for (let n = 0; n < NEIGHBOURS.length; n++) {
    barrierStart[n] = barrierOffsets.length;
    for (const [dx, dy] of buildBarrierPath(NEIGHBOURS[n])) barrierOffsets.push(dy * width + dx);
  }
  barrierStart[NEIGHBOURS.length] = barrierOffsets.length;
  const barrierPath = Int32Array.from(barrierOffsets);

  const holdFrom = controlLines?.holdFromMinute ?? null;
  const adjacentStep = NEIGHBOURS.map(([dx, dy]) => Math.max(Math.abs(dx), Math.abs(dy)) === 1);
  const holdsFeet = controlLines?.holdsFlameLengthFeet ?? null;
  /** True when a built line cell (at `time`) is the destination or on the step's path. */
  const lineCrossed = (
    cell: number,
    destination: number,
    pathStart: number,
    pathEnd: number,
    time: number,
  ): boolean => {
    if (holdFrom![destination] <= time) return true;
    for (let b = pathStart; b < pathEnd; b++)
      if (holdFrom![cell + barrierPath[b]] <= time) return true;
    return false;
  };
  /** True when some built line cell on the step holds against `flame` feet. */
  const lineHolds = (
    destination: number,
    pathStart: number,
    pathEnd: number,
    cell: number,
    time: number,
    flame: number,
  ): boolean => {
    if (holdFrom![destination] <= time && flame <= holdsFeet![destination]) return true;
    for (let b = pathStart; b < pathEnd; b++) {
      const c = cell + barrierPath[b];
      if (holdFrom![c] <= time && flame <= holdsFeet![c]) return true;
    }
    return false;
  };

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
  let reachedEdgeMinute: number | null = null;

  while (heap.length > 0) {
    const { time, cell } = heap.pop();
    if (settled[cell]) continue;
    // A fire put out at minute m spreads no further: a cell it would reach after m is
    // dropped, and stays free for another, still burning fire to reach later. Stale heap
    // entries for a dropped cell are skipped by the exact-time check.
    if (outFromMinuteBySource) {
      if (time !== arrival[cell]) continue;
      const out = outFromMinuteBySource[firstSource[cell]] ?? Number.POSITIVE_INFINITY;
      if (time > out) {
        arrival[cell] = Number.POSITIVE_INFINITY;
        firstSource[cell] = -1;
        continue;
      }
    }
    if (time > scenario.horizonMinutes) break;
    settled[cell] = 1;
    settledOrder[settledCount++] = cell;

    // Select this cell's outgoing crown state exactly once, right here at settle time:
    // self-initiated (already in `headRate`/`eccentricity`/`crownType` from the
    // precompute) unless an active crown fire arrived from outside AND this cell's own
    // canopy can sustain it, in which case it continues as active. `arrival[cell]` itself
    // is never touched by this; only the rate it goes on to spread OUT at is decided
    // here, and because this code runs once per cell (guarded by `settled`), nothing
    // after this point can change that cell's outgoing rate again.
    if (canSustainCrown[cell] === 1 && arrivedFromActiveCrown[cell] === 1) {
      headRate[cell] = Math.max(headRate[cell], sustainedCrownRateMetersPerMinute[cell]);
      eccentricity[cell] = activeCrownEccentricity;
      crownType[cell] = CROWN_ACTIVE;
    }

    const rate = headRate[cell];
    if (rate <= 0) continue;
    const x = cell % width;
    const y = (cell - x) / width;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      // Cells settle in arrival order, so the first edge cell is the earliest.
      if (!reachedEdge) reachedEdgeMinute = time;
      reachedEdge = true;
    }
    const sourceMechanism =
      fuelCodes[cell] === DEVELOPED_FUEL_CODE ? ARRIVAL_STRUCTURE : ARRIVAL_SURFACE;
    const sourceIsActiveCrown = crownType[cell] === CROWN_ACTIVE;
    const floor = minDirectionalRate[cell];

    for (let n = 0; n < NEIGHBOURS.length; n++) {
      const [dx, dy] = NEIGHBOURS[n];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
      if (settled[neighbour] || headRate[neighbour] <= 0) continue;
      // A multi-cell step must not hop a barrier, so every cell the step passes over has
      // to be passable. See `buildBarrierPath`: one passable cell somewhere along the
      // line is not enough once steps are eight cells long.
      const barrierEnd = barrierStart[n + 1];
      let blocked = false;
      for (let b = barrierStart[n]; b < barrierEnd; b++) {
        if (headRate[cell + barrierPath[b]] <= 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      // Elliptical spread from the cell's heading, inlined: this is the hot loop.
      const e = eccentricity[cell];
      let rateToward =
        e > 0 ? (rate * (1 - e)) / (1 - e * Math.cos(bearings[n] - headingRadians[cell])) : rate;
      if (rateToward < floor) rateToward = floor;
      if (rateToward <= 0) continue;
      const candidate = time + distances[n] / rateToward;
      // Built control line on the step (destination or any cell stepped over) stops it. An
      // adjacent step may still burn into the line when the flame facing it in this
      // direction is longer than the line holds (see `ControlLines`). Crown fire (passive or
      // active) is taken to breach any line. A line counts as built when it is finished by
      // the time the fire would arrive (`candidate`), not when the cell behind it caught:
      // across a 30 m cell a flank or backing fire takes an hour or more. Blocking only gets
      // stricter for later arrivals, so arriving later is never faster and the
      // minimum-travel-time order stays valid.
      if (
        holdFrom &&
        lineCrossed(cell, neighbour, barrierStart[n], barrierStart[n + 1], candidate)
      ) {
        if (!adjacentStep[n]) continue;
        const flame =
          crownType[cell] !== CROWN_SURFACE
            ? Number.POSITIVE_INFINITY
            : headFlameFeet[cell] * Math.pow(Math.min(1, rateToward / rate), BYRAM_FLAME_EXPONENT);
        if (lineHolds(neighbour, barrierStart[n], barrierStart[n + 1], cell, candidate, flame))
          continue;
      }
      if (candidate < arrival[neighbour]) {
        arrival[neighbour] = candidate;
        arrivalMechanism[neighbour] = sourceMechanism;
        firstSource[neighbour] = firstSource[cell];
        arrivedFromActiveCrown[neighbour] = sourceIsActiveCrown ? 1 : 0;
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
        // Embers do not take hold in line built by the time they would ignite.
        if (holdFrom && holdFrom[target] <= candidate) break;
        if (candidate < arrival[target]) {
          arrival[target] = candidate;
          arrivalMechanism[target] = ARRIVAL_SPOTTING;
          firstSource[target] = firstSource[cell];
          // An ember crossing a gap breaks canopy continuity by construction (the gap is
          // unvegetated ground), so a spot ignition is never a continuation of an active
          // crown fire, regardless of what a losing surface-neighbour relaxation set.
          arrivedFromActiveCrown[target] = 0;
          heap.push(candidate, target);
        }
        break;
      }
    }
  }

  const cellArea = groundCellSizeMeters * groundCellSizeMeters;

  // One pass over the burned set, credited two ways: by the mechanism that delivered fire
  // to the cell, and by the kind of fire that burned it. Both cover the same cells, so
  // the two sets of areas sum to the same total.
  let surfaceCells = 0;
  let spottingCells = 0;
  let structureCells = 0;
  let surfaceFireCells = 0;
  let passiveCrownCells = 0;
  let activeCrownCells = 0;
  for (let i = 0; i < cellCount; i++) {
    if (arrival[i] > scenario.horizonMinutes) continue;
    const mechanism = arrivalMechanism[i];
    if (mechanism === ARRIVAL_SPOTTING) spottingCells++;
    else if (mechanism === ARRIVAL_STRUCTURE) structureCells++;
    else surfaceCells++;
    const fireType = crownType[i];
    if (fireType === CROWN_ACTIVE) activeCrownCells++;
    else if (fireType === CROWN_PASSIVE) passiveCrownCells++;
    else surfaceFireCells++;
  }

  const ignitions = sourceCells.map((originCell): IgnitionConditions => {
    const originFuel = fuelCodes[originCell];
    const originBed = beds.get(originFuel);
    return {
      fuelCode: originFuel,
      fuelLabel: fuelLabel(originFuel),
      slopePercent: slopeTangent[originCell] * 100,
      elevationMeters: landscape.elevationMeters[originCell],
      // Reuse what the precompute already produced for this cell, so the reported
      // ignition conditions are the ones the solver actually propagated, midflame wind
      // and all, rather than a second evaluation that could drift from them.
      spread:
        sourceSpread.get(originCell) ??
        (originBed
          ? spreadFromBed(
              originBed,
              scenarioMidflameWind,
              windToward,
              slopeTangent[originCell],
              upslopeDegrees[originCell],
            )
          : structureIgnitionSpread(structureHeadRate, windToward)),
      crown: sourceCrown.get(originCell) ?? null,
      midflameAdjustment: sourceMidflameAdjustment.get(originCell) ?? scenario.midflameAdjustment,
    };
  });

  const totals: SpreadRunTotals = {
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
    crownFire: {
      modelled: canopyModelled,
      unavailableReason: canopyModelled ? "" : CROWN_FIRE_UNAVAILABLE_REASON,
      foliarMoistureFraction: DEFAULT_FOLIAR_MOISTURE_FRACTION,
      activeCrownLengthToBreadth,
    },
    crownFireBreakdown: {
      surfaceCells: surfaceFireCells,
      passiveCrownCells,
      activeCrownCells,
      surfaceSquareMeters: surfaceFireCells * cellArea,
      passiveCrownSquareMeters: passiveCrownCells * cellArea,
      activeCrownSquareMeters: activeCrownCells * cellArea,
    },
    midflameWind: {
      source: midflameWindSource,
      scenarioAdjustment: scenario.midflameAdjustment,
      appliedMeanAdjustment: midflameCells > 0 ? midflameSum / midflameCells : 0,
      appliedMinAdjustment: midflameCells > 0 ? midflameMin : 0,
      appliedMaxAdjustment: midflameCells > 0 ? midflameMax : 0,
    },
    cellSizeMeters: groundCellSizeMeters,
  };

  return {
    arrival,
    firstSource,
    settledOrder,
    settledCount,
    sourceCells,
    ignitions,
    reachedEdge,
    reachedEdgeMinute,
    totals,
    resolution: {
      cellMeters: landscape.cellMeters,
      groundCellSizeMeters,
      resampling: landscape.resampling,
      maxStepMeters: Math.max(...distances),
      spottingReachCeilingMeters: spottingActive ? maxSpotCells * groundCellSizeMeters : 0,
    },
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

/**
 * `box` bounds the cells with arrival <= threshold. Only squares that touch it are
 * scanned; every other square is all unburned and emits nothing, and the squares that are
 * scanned are visited in the same row-major order as a full scan, so the rings and their
 * order are identical to scanning the whole grid.
 */
function contour(
  landscape: LandscapeGrid,
  arrival: Float64Array,
  threshold: number,
  box: CellBox | null,
): FirePerimeter[] {
  const { width, height } = landscape;
  if (!box) return [];
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
  // Square (x, y) covers cells x..x+1 and y..y+1, so it touches the box from one before
  // its first column/row through its last, clipped to the squares that exist.
  const lastY = Math.min(box.maxY, height - 2);
  const lastX = Math.min(box.maxX, width - 2);
  for (let y = Math.max(box.minY - 1, 0); y <= lastY; y++) {
    for (let x = Math.max(box.minX - 1, 0); x <= lastX; x++) {
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

  // Depth by containment, so holes are identified without relying on winding order. A
  // bounding-box test first: a point outside a ring's box is outside the ring, so this
  // only skips work and never changes the answer. Long runs produce hundreds of rings.
  const boxes = geographic.map(ringBounds);
  const inside = (j: number, point: Position) =>
    point[0] >= boxes[j][0] &&
    point[0] <= boxes[j][2] &&
    point[1] >= boxes[j][1] &&
    point[1] <= boxes[j][3] &&
    containsPoint(geographic[j], point);
  const depth = geographic.map((ring, i) =>
    geographic.reduce((count, _other, j) => (i !== j && inside(j, ring[0]) ? count + 1 : count), 0),
  );

  const polygons: FirePerimeter[] = [];
  geographic.forEach((ring, i) => {
    if (depth[i] % 2 !== 0) return;
    const holes = geographic.filter((other, j) => depth[j] === depth[i] + 1 && inside(i, other[0]));
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

function ringBounds(ring: Position[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
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
