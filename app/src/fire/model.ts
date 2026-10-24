import type { Feature, Polygon } from "geojson";

/**
 * Deterministic wind-driven fire growth on flat, uniform fuel.
 *
 * Coordinates are WGS84 decimal degrees; GeoJSON positions are [longitude, latitude].
 * Distances are meters, rates are meters per minute, and all times are elapsed
 * simulation-clock minutes from ignition, never wall-clock time.
 *
 * This is a demonstration model, not a calibrated wildfire prediction. It ignores fuel
 * type and moisture, terrain and slope, spotting, suppression, and barriers such as
 * rivers, ridgelines, and roads. Treat every perimeter as a simulated result.
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface WindInput {
  /** Sustained open wind speed, miles per hour. */
  speedMph: number;
  /** Meteorological bearing the wind blows FROM, degrees clockwise from true north. */
  fromDegrees: number;
}

export interface FireScenario {
  origin: GeoPoint;
  wind: WindInput;
  /** Simulation clock step, minutes. */
  stepMinutes: number;
  /** Simulation clock horizon, minutes from ignition. */
  horizonMinutes: number;
}

export const FIRE_STEP_MINUTES = 15;
export const FIRE_HORIZON_MINUTES = 180;
export const MAX_WIND_SPEED_MPH = 60;

export const FIRE_MODEL = {
  id: "uniform-fuel-ellipse",
  version: "1.0.0",
  /** Head-fire rate of spread with no wind, meters per minute. */
  noWindSpreadMetersPerMinute: 2.4,
  /** Added head-fire spread per meter per second of midflame wind, meters per minute. */
  windResponseMetersPerMinutePerMetersPerSecond: 13,
  /** Share of the open wind speed assumed to reach midflame height. */
  midflameWindFraction: 0.5,
  /** Cap on the Anderson (1983) length-to-breadth ratio, to keep extreme winds finite. */
  maxLengthToBreadth: 8,
  /** Vertices used to draw each elliptical perimeter. */
  ringSegments: 96,
} as const;

export interface PerimeterProperties {
  /** Simulation-clock minutes from ignition at which the fire reaches this perimeter. */
  elapsedMinutes: number;
}

export type FirePerimeter = Feature<Polygon, PerimeterProperties>;

export interface FireFrame {
  elapsedMinutes: number;
  /** Null at ignition, when the burned area is still a point. */
  perimeter: FirePerimeter | null;
  /** Downwind distance from the ignition point to the head of the fire, meters. */
  headDistanceMeters: number;
  burnedAreaSquareMeters: number;
}

export interface FireRun {
  model: typeof FIRE_MODEL;
  scenario: FireScenario;
  /** Ellipse elongation; 1 is a circle. */
  lengthToBreadth: number;
  headRateMetersPerMinute: number;
  backingRateMetersPerMinute: number;
  frames: FireFrame[];
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_SECOND_PER_MPH = 0.44704;
const RADIANS_PER_DEGREE = Math.PI / 180;
/** Beyond this latitude the local ellipse approximation and the basemap both degrade. */
const MAX_ABSOLUTE_LATITUDE = 80;

export const SQUARE_METERS_PER_HECTARE = 10_000;
export const SQUARE_METERS_PER_ACRE = 4046.8564224;
export const METERS_PER_MILE = 1609.344;

/**
 * Anderson (1983) length-to-breadth ratio for a wind-driven elliptical fire,
 * given midflame wind speed in meters per second.
 */
function lengthToBreadthRatio(midflameMetersPerSecond: number): number {
  const ratio =
    0.936 * Math.exp(0.2566 * midflameMetersPerSecond) +
    0.461 * Math.exp(-0.1548 * midflameMetersPerSecond) -
    0.397;
  return Math.min(Math.max(ratio, 1), FIRE_MODEL.maxLengthToBreadth);
}

/** Head-to-back rate ratio implied by an ellipse ignited at its rear focus. */
function headToBackRatio(lengthToBreadth: number): number {
  const eccentricTerm = Math.sqrt(Math.max(lengthToBreadth * lengthToBreadth - 1, 0));
  const denominator = lengthToBreadth - eccentricTerm;
  if (denominator <= 0) return Number.POSITIVE_INFINITY;
  return (lengthToBreadth + eccentricTerm) / denominator;
}

/**
 * Great-circle destination from an origin, given local east/north offsets in meters.
 * Longitude stays continuous around the origin so a perimeter near the antimeridian
 * does not stretch across the whole map.
 */
function destination(origin: GeoPoint, eastMeters: number, northMeters: number): [number, number] {
  const angularDistance = Math.hypot(eastMeters, northMeters) / EARTH_RADIUS_METERS;
  const bearing = Math.atan2(eastMeters, northMeters);
  const latitude = origin.latitude * RADIANS_PER_DEGREE;
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const longitudeDelta = Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(nextLatitude),
  );
  return [
    origin.longitude + longitudeDelta / RADIANS_PER_DEGREE,
    nextLatitude / RADIANS_PER_DEGREE,
  ];
}

/** Point reached by travelling `distanceMeters` from `origin` along a compass bearing. */
export function pointAtBearing(
  origin: GeoPoint,
  bearingDegrees: number,
  distanceMeters: number,
): GeoPoint {
  const bearing = bearingDegrees * RADIANS_PER_DEGREE;
  const [longitude, latitude] = destination(
    origin,
    distanceMeters * Math.sin(bearing),
    distanceMeters * Math.cos(bearing),
  );
  return { latitude, longitude };
}

function assertValidScenario({ origin, wind, stepMinutes, horizonMinutes }: FireScenario): void {
  if (!Number.isFinite(origin.latitude) || Math.abs(origin.latitude) > MAX_ABSOLUTE_LATITUDE) {
    throw new RangeError(
      `Ignition latitude must be between ${-MAX_ABSOLUTE_LATITUDE} and ${MAX_ABSOLUTE_LATITUDE} degrees.`,
    );
  }
  if (!Number.isFinite(origin.longitude) || Math.abs(origin.longitude) > 180) {
    throw new RangeError("Ignition longitude must be between -180 and 180 degrees.");
  }
  if (!Number.isFinite(wind.speedMph) || wind.speedMph < 0 || wind.speedMph > MAX_WIND_SPEED_MPH) {
    throw new RangeError(`Wind speed must be between 0 and ${MAX_WIND_SPEED_MPH} mph.`);
  }
  if (!Number.isFinite(wind.fromDegrees) || wind.fromDegrees < 0 || wind.fromDegrees >= 360) {
    throw new RangeError("Wind direction must be at least 0 and less than 360 degrees.");
  }
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) {
    throw new RangeError("Step must be a positive number of minutes.");
  }
  if (!Number.isFinite(horizonMinutes) || horizonMinutes < stepMinutes) {
    throw new RangeError("Horizon must be at least one step.");
  }
}

/**
 * Grow an elliptical perimeter from a point ignition. The run is fully determined by
 * its scenario and the model constants above; no randomness is used, so no seed is needed.
 */
export function simulateFire(scenario: FireScenario): FireRun {
  assertValidScenario(scenario);
  const { origin, wind, stepMinutes, horizonMinutes } = scenario;

  const midflameMetersPerSecond =
    wind.speedMph * METERS_PER_SECOND_PER_MPH * FIRE_MODEL.midflameWindFraction;
  const headRate =
    FIRE_MODEL.noWindSpreadMetersPerMinute +
    FIRE_MODEL.windResponseMetersPerMinutePerMetersPerSecond * midflameMetersPerSecond;
  const lengthToBreadth = lengthToBreadthRatio(midflameMetersPerSecond);
  const backingRate = headRate / headToBackRatio(lengthToBreadth);

  // Ellipse growth rates: the ignition point stays at the rear, so the ellipse center
  // drifts downwind at half the difference between the head and backing rates.
  const semiMajorRate = (headRate + backingRate) / 2;
  const semiMinorRate = semiMajorRate / lengthToBreadth;
  const centerDriftRate = (headRate - backingRate) / 2;
  const windTowardRadians = ((wind.fromDegrees + 180) % 360) * RADIANS_PER_DEGREE;
  const towardSin = Math.sin(windTowardRadians);
  const towardCos = Math.cos(windTowardRadians);

  const frames: FireFrame[] = [
    { elapsedMinutes: 0, perimeter: null, headDistanceMeters: 0, burnedAreaSquareMeters: 0 },
  ];

  for (let minutes = stepMinutes; minutes <= horizonMinutes; minutes += stepMinutes) {
    const semiMajor = semiMajorRate * minutes;
    const semiMinor = semiMinorRate * minutes;
    const centerDrift = centerDriftRate * minutes;

    const ring: number[][] = [];
    for (let index = 0; index < FIRE_MODEL.ringSegments; index++) {
      const angle = (index / FIRE_MODEL.ringSegments) * 2 * Math.PI;
      const alongWind = centerDrift + semiMajor * Math.cos(angle);
      const acrossWind = semiMinor * Math.sin(angle);
      ring.push(
        destination(
          origin,
          alongWind * towardSin + acrossWind * towardCos,
          alongWind * towardCos - acrossWind * towardSin,
        ),
      );
    }
    // GeoJSON exterior rings are counterclockwise and explicitly closed.
    ring.reverse();
    ring.push([...ring[0]]);

    frames.push({
      elapsedMinutes: minutes,
      perimeter: {
        type: "Feature",
        properties: { elapsedMinutes: minutes },
        geometry: { type: "Polygon", coordinates: [ring] },
      },
      headDistanceMeters: headRate * minutes,
      burnedAreaSquareMeters: Math.PI * semiMajor * semiMinor,
    });
  }

  return {
    model: FIRE_MODEL,
    scenario: {
      ...scenario,
      origin: { ...origin },
      wind: { ...wind },
    },
    lengthToBreadth,
    headRateMetersPerMinute: headRate,
    backingRateMetersPerMinute: backingRate,
    frames,
  };
}

/** Bearing in degrees clockwise from true north, from one point toward another. */
export function bearingBetween(from: GeoPoint, to: GeoPoint): number {
  const fromLatitude = from.latitude * RADIANS_PER_DEGREE;
  const toLatitude = to.latitude * RADIANS_PER_DEGREE;
  const longitudeDelta = (to.longitude - from.longitude) * RADIANS_PER_DEGREE;
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) / RADIANS_PER_DEGREE + 360) % 360;
}

const COMPASS_POINTS = [
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
] as const;

export function compassPoint(degrees: number): string {
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index];
}

/** Elapsed simulation time as `T+H:MM`. */
export function formatElapsed(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `T+${hours}:${String(minutes % 60).padStart(2, "0")}`;
}
