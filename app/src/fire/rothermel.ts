/**
 * Rothermel (1972) surface fire spread model, in the formulation given by
 * Andrews, "The Rothermel surface fire spread model and associated developments:
 * a comprehensive explanation" (USDA Forest Service RMRS-GTR-371, 2018).
 *
 * The model is written in the Imperial units it was published in and returns rate of
 * spread in feet per minute. Callers convert at their own boundary. It models surface
 * fire only: no crown fire, no spotting, no suppression.
 *
 * Symbols follow the source: I_R reaction intensity, xi propagating flux ratio,
 * phi_w and phi_s the wind and slope coefficients, beta packing ratio, sigma the
 * characteristic surface-area-to-volume ratio.
 */

import {
  EFFECTIVE_MINERAL_CONTENT,
  PARTICLE_DENSITY_LB_PER_FT3,
  SAV_DEAD_100H,
  SAV_DEAD_10H,
  TOTAL_MINERAL_CONTENT,
  type FuelModel,
} from "./fuelModels";

export interface FuelMoisture {
  /** Fractions of oven-dry weight: 0.06 is 6 percent. */
  dead1h: number;
  dead10h: number;
  dead100h: number;
  liveHerb: number;
  liveWoody: number;
}

export interface SpreadInputs {
  fuel: FuelModel;
  moisture: FuelMoisture;
  /** Midflame wind speed, feet per minute. */
  midflameWindFeetPerMinute: number;
  /** Compass bearing the wind blows TOWARD, degrees clockwise from true north. */
  windTowardDegrees: number;
  /** Slope steepness as rise over run (tangent of the slope angle). */
  slopeTangent: number;
  /** Compass bearing of the upslope direction, degrees clockwise from true north. */
  upslopeDegrees: number;
}

export interface SpreadResult {
  /** Maximum (heading) rate of spread, feet per minute. */
  headRateFeetPerMinute: number;
  /** Rate of spread with no wind and no slope, feet per minute. */
  noWindRateFeetPerMinute: number;
  reactionIntensityBtuPerFt2PerMinute: number;
  windCoefficient: number;
  slopeCoefficient: number;
  /** Combined wind and slope expressed as an equivalent wind speed, feet per minute. */
  effectiveWindFeetPerMinute: number;
  /**
   * True past the effective wind speed where Rothermel (1972) was validated. Reported
   * rather than enforced, following Andrews, Cruz & Rothermel (2013); FARSITE and FlamMap
   * do the same. Spread rates above it are extrapolation.
   */
  beyondValidatedWind: boolean;
  /** Compass bearing of maximum spread, degrees clockwise from true north. */
  headingDegrees: number;
  /** Ellipse elongation implied by the effective wind. */
  lengthToBreadth: number;
  flameLengthFeet: number;
  firelineIntensityBtuPerFootPerSecond: number;
}

interface Particle {
  load: number;
  sav: number;
  moisture: number;
}

const MIN_SAV = 1e-6;
const RADIANS_PER_DEGREE = Math.PI / 180;
/**
 * Rothermel's 1972 effective wind limit, as a multiple of reaction intensity. Reported,
 * not enforced: see `beyondValidatedWind`.
 */
export const VALIDATED_WIND_FACTOR = 0.9;
/** Anderson (1983) length-to-breadth is unbounded in strong wind; cap it as FARSITE does. */
export const MAX_LENGTH_TO_BREADTH = 8;

/**
 * Scott & Burgan dynamic fuel models move live herbaceous load into a dead herbaceous
 * class as the herb layer cures. Fully cured at 30 percent moisture, fully green at 120.
 */
export function herbaceousCuredFraction(liveHerbMoisture: number): number {
  const fraction = (1.2 - liveHerbMoisture) / 0.9;
  return Math.min(Math.max(fraction, 0), 1);
}

function weighted(particles: Particle[], values: number[], weights: number[]): number {
  let total = 0;
  for (let i = 0; i < particles.length; i++) total += weights[i] * values[i];
  return total;
}

/**
 * Everything about a fuel bed that does not depend on wind or slope. Computing it once
 * per fuel model instead of once per grid cell is what makes a landscape run tractable.
 */
export interface FuelBed {
  noWindRateFeetPerMinute: number;
  reactionIntensityBtuPerFt2PerMinute: number;
  residenceTimeMinutes: number;
  packingRatio: number;
  relativePacking: number;
  windC: number;
  windB: number;
  windE: number;
}

export const INERT_FUEL_BED: FuelBed = {
  noWindRateFeetPerMinute: 0,
  reactionIntensityBtuPerFt2PerMinute: 0,
  residenceTimeMinutes: 0,
  packingRatio: 0,
  relativePacking: 0,
  windC: 0,
  windB: 1,
  windE: 0,
};

export function prepareFuelBed(fuel: FuelModel, moisture: FuelMoisture): FuelBed {
  const cured = fuel.dynamic ? herbaceousCuredFraction(moisture.liveHerb) : 0;
  const deadHerbLoad = fuel.load.liveHerb * cured;
  const liveHerbLoad = fuel.load.liveHerb * (1 - cured);

  // Dead particles: 1-h, 10-h, 100-h, and the cured herbaceous share, which dries
  // with the 1-hour timelag class.
  const dead: Particle[] = [
    { load: fuel.load.dead1h, sav: fuel.savDead1hPerFoot, moisture: moisture.dead1h },
    { load: fuel.load.dead10h, sav: SAV_DEAD_10H, moisture: moisture.dead10h },
    { load: fuel.load.dead100h, sav: SAV_DEAD_100H, moisture: moisture.dead100h },
    { load: deadHerbLoad, sav: fuel.savLiveHerbPerFoot, moisture: moisture.dead1h },
  ];
  const live: Particle[] = [
    { load: liveHerbLoad, sav: fuel.savLiveHerbPerFoot, moisture: moisture.liveHerb },
    { load: fuel.load.liveWoody, sav: fuel.savLiveWoodyPerFoot, moisture: moisture.liveWoody },
  ];

  const totalLoad =
    dead.reduce((sum, p) => sum + p.load, 0) + live.reduce((sum, p) => sum + p.load, 0);
  if (totalLoad <= 0 || fuel.depthFeet <= 0) return INERT_FUEL_BED;

  // Surface-area weighting within and between the dead and live categories.
  const areaOf = (p: Particle) =>
    p.sav > MIN_SAV ? (p.sav * p.load) / PARTICLE_DENSITY_LB_PER_FT3 : 0;
  const deadAreas = dead.map(areaOf);
  const liveAreas = live.map(areaOf);
  const deadArea = deadAreas.reduce((a, b) => a + b, 0);
  const liveArea = liveAreas.reduce((a, b) => a + b, 0);
  const totalArea = deadArea + liveArea;
  if (totalArea <= 0) return INERT_FUEL_BED;

  const fDead = deadAreas.map((a) => (deadArea > 0 ? a / deadArea : 0));
  const fLive = liveAreas.map((a) => (liveArea > 0 ? a / liveArea : 0));
  const categoryDead = deadArea / totalArea;
  const categoryLive = liveArea / totalArea;

  const savDead = weighted(
    dead,
    dead.map((p) => p.sav),
    fDead,
  );
  const savLive = weighted(
    live,
    live.map((p) => p.sav),
    fLive,
  );
  const sigma = categoryDead * savDead + categoryLive * savLive;
  if (sigma <= MIN_SAV) return INERT_FUEL_BED;

  // Net (mineral-free) load carried into the reaction, by category.
  const netLoadDead =
    weighted(
      dead,
      dead.map((p) => p.load),
      fDead,
    ) *
    (1 - TOTAL_MINERAL_CONTENT);
  const netLoadLive =
    weighted(
      live,
      live.map((p) => p.load),
      fLive,
    ) *
    (1 - TOTAL_MINERAL_CONTENT);

  const bulkDensity = totalLoad / fuel.depthFeet;
  const packingRatio = bulkDensity / PARTICLE_DENSITY_LB_PER_FT3;
  const optimumPacking = 3.348 * Math.pow(sigma, -0.8189);
  const relativePacking = packingRatio / optimumPacking;

  // Reaction velocity.
  const aCoefficient = 133 * Math.pow(sigma, -0.7913);
  const maximumVelocity = Math.pow(sigma, 1.5) / (495 + 0.0594 * Math.pow(sigma, 1.5));
  const reactionVelocity =
    maximumVelocity *
    Math.pow(relativePacking, aCoefficient) *
    Math.exp(aCoefficient * (1 - relativePacking));

  // Live fuel moisture of extinction depends on how dry the fine dead fuel is
  // relative to its own extinction moisture (Albini 1976).
  let fineDeadLoad = 0;
  let fineDeadMoistureLoad = 0;
  for (const p of dead) {
    if (p.sav <= MIN_SAV) continue;
    const weight = p.load * Math.exp(-138 / p.sav);
    fineDeadLoad += weight;
    fineDeadMoistureLoad += weight * p.moisture;
  }
  let fineLiveLoad = 0;
  for (const p of live) {
    if (p.sav <= MIN_SAV) continue;
    fineLiveLoad += p.load * Math.exp(-500 / p.sav);
  }
  const deadMoisture = weighted(
    dead,
    dead.map((p) => p.moisture),
    fDead,
  );
  const liveMoisture = weighted(
    live,
    live.map((p) => p.moisture),
    fLive,
  );
  const fineDeadMoisture = fineDeadLoad > 0 ? fineDeadMoistureLoad / fineDeadLoad : 0;
  const liveExtinction =
    fineLiveLoad > 0
      ? Math.max(
          2.9 *
            (fineDeadLoad / fineLiveLoad) *
            (1 - fineDeadMoisture / fuel.deadMoistureOfExtinction) -
            0.226,
          fuel.deadMoistureOfExtinction,
        )
      : fuel.deadMoistureOfExtinction;

  const dampingOf = (m: number, mx: number) => {
    if (mx <= 0) return 0;
    const r = Math.min(m / mx, 1);
    return Math.max(1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r, 0);
  };
  const dampingDead = dampingOf(deadMoisture, fuel.deadMoistureOfExtinction);
  const dampingLive = liveArea > 0 ? dampingOf(liveMoisture, liveExtinction) : 0;
  const mineralDamping = Math.min(0.174 * Math.pow(EFFECTIVE_MINERAL_CONTENT, -0.19), 1);

  const reactionIntensity =
    reactionVelocity *
    fuel.heatContentBtuPerLb *
    mineralDamping *
    (netLoadDead * dampingDead * categoryDead + netLoadLive * dampingLive * categoryLive);

  // Propagating flux ratio: the share of reaction heat that reaches unburned fuel.
  const propagatingFlux =
    Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (packingRatio + 0.1)) / (192 + 0.2595 * sigma);

  // Heat sink.
  const heatOf = (p: Particle) =>
    p.sav > MIN_SAV ? Math.exp(-138 / p.sav) * (250 + 1116 * p.moisture) : 0;
  const heatSinkDead = weighted(dead, dead.map(heatOf), fDead);
  const heatSinkLive = weighted(live, live.map(heatOf), fLive);
  const heatSink = bulkDensity * (categoryDead * heatSinkDead + categoryLive * heatSinkLive);
  if (heatSink <= 0 || reactionIntensity <= 0) return INERT_FUEL_BED;

  const noWindRate = (reactionIntensity * propagatingFlux) / heatSink;

  return {
    noWindRateFeetPerMinute: noWindRate,
    reactionIntensityBtuPerFt2PerMinute: reactionIntensity,
    residenceTimeMinutes: 384 / sigma,
    packingRatio,
    relativePacking,
    windC: 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55)),
    windB: 0.02526 * Math.pow(sigma, 0.54),
    windE: 0.715 * Math.exp(-0.000359 * sigma),
  };
}

/** Apply a wind speed and a slope to a prepared fuel bed. */
export function spreadFromBed(
  bed: FuelBed,
  midflameWindFeetPerMinute: number,
  windTowardDegrees: number,
  slopeTangent: number,
  upslopeDegrees: number,
): SpreadResult {
  if (bed.noWindRateFeetPerMinute <= 0) return zeroSpread();
  const { windC, windB, windE, packingRatio, relativePacking } = bed;
  const packingTerm = Math.pow(relativePacking, -windE);

  const wind = Math.max(midflameWindFeetPerMinute, 0);
  const windCoefficient = wind > 0 ? windC * Math.pow(wind, windB) * packingTerm : 0;
  const slopeCoefficient =
    slopeTangent > 0 ? 5.275 * Math.pow(packingRatio, -0.3) * slopeTangent * slopeTangent : 0;

  // Wind and slope push in their own directions, so they combine as vectors rather than
  // as a plain sum. The resultant sets both the heading and the total coefficient.
  const windRadians = windTowardDegrees * RADIANS_PER_DEGREE;
  const slopeRadians = upslopeDegrees * RADIANS_PER_DEGREE;
  const east = windCoefficient * Math.sin(windRadians) + slopeCoefficient * Math.sin(slopeRadians);
  const north = windCoefficient * Math.cos(windRadians) + slopeCoefficient * Math.cos(slopeRadians);
  const combinedCoefficient = Math.hypot(east, north);
  const headingDegrees =
    combinedCoefficient > 0
      ? (Math.atan2(east, north) / RADIANS_PER_DEGREE + 360) % 360
      : windTowardDegrees;

  const headRate = bed.noWindRateFeetPerMinute * (1 + combinedCoefficient);
  const effectiveWind =
    combinedCoefficient > 0 && windC > 0
      ? Math.pow((combinedCoefficient * Math.pow(relativePacking, windE)) / windC, 1 / windB)
      : 0;
  const heatPerUnitArea = bed.reactionIntensityBtuPerFt2PerMinute * bed.residenceTimeMinutes;
  const firelineIntensity = (heatPerUnitArea * headRate) / 60;

  return {
    headRateFeetPerMinute: headRate,
    noWindRateFeetPerMinute: bed.noWindRateFeetPerMinute,
    reactionIntensityBtuPerFt2PerMinute: bed.reactionIntensityBtuPerFt2PerMinute,
    windCoefficient,
    slopeCoefficient,
    effectiveWindFeetPerMinute: effectiveWind,
    beyondValidatedWind:
      effectiveWind > VALIDATED_WIND_FACTOR * bed.reactionIntensityBtuPerFt2PerMinute,
    headingDegrees,
    lengthToBreadth: lengthToBreadthRatio(effectiveWind),
    flameLengthFeet: firelineIntensity > 0 ? 0.45 * Math.pow(firelineIntensity, 0.46) : 0,
    firelineIntensityBtuPerFootPerSecond: firelineIntensity,
  };
}

export function computeSpread({
  fuel,
  moisture,
  midflameWindFeetPerMinute,
  windTowardDegrees,
  slopeTangent,
  upslopeDegrees,
}: SpreadInputs): SpreadResult {
  return spreadFromBed(
    prepareFuelBed(fuel, moisture),
    midflameWindFeetPerMinute,
    windTowardDegrees,
    slopeTangent,
    upslopeDegrees,
  );
}

function zeroSpread(): SpreadResult {
  return {
    headRateFeetPerMinute: 0,
    noWindRateFeetPerMinute: 0,
    reactionIntensityBtuPerFt2PerMinute: 0,
    windCoefficient: 0,
    slopeCoefficient: 0,
    effectiveWindFeetPerMinute: 0,
    beyondValidatedWind: false,
    headingDegrees: 0,
    lengthToBreadth: 1,
    flameLengthFeet: 0,
    firelineIntensityBtuPerFootPerSecond: 0,
  };
}

const FEET_PER_MINUTE_PER_MPH = 88;

/** Anderson (1983) length-to-breadth ratio from effective wind speed in feet per minute. */
export function lengthToBreadthRatio(effectiveWindFeetPerMinute: number): number {
  const milesPerHour = effectiveWindFeetPerMinute / FEET_PER_MINUTE_PER_MPH;
  const ratio =
    0.936 * Math.exp(0.2566 * milesPerHour) + 0.461 * Math.exp(-0.1548 * milesPerHour) - 0.397;
  return Math.min(Math.max(ratio, 1), MAX_LENGTH_TO_BREADTH);
}

/**
 * Rate of spread at an angle from the heading direction, for an ellipse ignited at its
 * rear focus (Alexander 1985). `angleFromHead` is in radians.
 */
export function directionalRate(
  headRate: number,
  lengthToBreadth: number,
  angleFromHead: number,
): number {
  if (headRate <= 0) return 0;
  if (lengthToBreadth <= 1) return headRate;
  const eccentricity = Math.sqrt(lengthToBreadth * lengthToBreadth - 1) / lengthToBreadth;
  return (headRate * (1 - eccentricity)) / (1 - eccentricity * Math.cos(angleFromHead));
}
