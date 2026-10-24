import type { FeatureCollection, Polygon } from "geojson";

export interface FireInputs {
  origin: { latitude: number; longitude: number };
  windSpeedMph: number;
  /** Meteorological direction: degrees clockwise from north that wind comes FROM. */
  windFromDegrees: number;
}

export const FIRE_STEP_MINUTES = 15;
export const FIRE_HORIZON_MINUTES = 120;
export const FIRE_MODEL = {
  id: "uniform-fuel-ellipse",
  version: "1.0.0",
  baseSpreadMetersPerSecond: 0.1,
  headWindGainPerMeterPerSecond: 0.35,
  backingWindReductionPerMeterPerSecond: 0.15,
} as const;

export type FirePerimeter = FeatureCollection<Polygon, { elapsedMinutes: number }>;
export interface FireFrame {
  elapsedMinutes: number;
  perimeter: FirePerimeter;
}
export interface FireRun {
  model: typeof FIRE_MODEL;
  inputs: FireInputs;
  stepMinutes: number;
  horizonMinutes: number;
  frames: FireFrame[];
}

export const EMPTY_PERIMETER: FirePerimeter = { type: "FeatureCollection", features: [] };
const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_SECOND_PER_MPH = 0.44704;
const RING_SEGMENTS = 72;
const RADIANS_PER_DEGREE = Math.PI / 180;

// Project local east/north offsets along a great-circle arc. Keep longitude continuous
// around the origin so a perimeter crossing the date line does not span the whole map.
function geographicPoint(origin: FireInputs["origin"], east: number, north: number): number[] {
  const distance = Math.hypot(east, north) / EARTH_RADIUS_METERS;
  const bearing = Math.atan2(east, north);
  const latitude = origin.latitude * RADIANS_PER_DEGREE;
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(distance) +
      Math.cos(latitude) * Math.sin(distance) * Math.cos(bearing),
  );
  const longitudeDelta = Math.atan2(
    Math.sin(bearing) * Math.sin(distance) * Math.cos(latitude),
    Math.cos(distance) - Math.sin(latitude) * Math.sin(nextLatitude),
  );
  return [
    origin.longitude + longitudeDelta / RADIANS_PER_DEGREE,
    nextLatitude / RADIANS_PER_DEGREE,
  ];
}

/** Deterministic geometric demo, not a calibrated wildfire prediction model. */
export function simulateFire(inputs: FireInputs): FireRun {
  const { origin, windSpeedMph, windFromDegrees } = inputs;
  if (
    !Number.isFinite(origin.latitude) ||
    Math.abs(origin.latitude) > 80 ||
    !Number.isFinite(origin.longitude) ||
    Math.abs(origin.longitude) > 180
  ) {
    throw new Error("Choose an origin between 80° south and 80° north.");
  }
  if (!Number.isFinite(windSpeedMph) || windSpeedMph < 0 || windSpeedMph > 40) {
    throw new Error("Wind speed must be between 0 and 40 mph.");
  }
  if (!Number.isFinite(windFromDegrees) || windFromDegrees < 0 || windFromDegrees >= 360) {
    throw new Error("Wind direction must be between 0° and 359°.");
  }

  const windMetersPerSecond = windSpeedMph * METERS_PER_SECOND_PER_MPH;
  const headRate =
    FIRE_MODEL.baseSpreadMetersPerSecond *
    (1 + FIRE_MODEL.headWindGainPerMeterPerSecond * windMetersPerSecond);
  const backRate =
    FIRE_MODEL.baseSpreadMetersPerSecond /
    (1 + FIRE_MODEL.backingWindReductionPerMeterPerSecond * windMetersPerSecond);
  const windToward = ((windFromDegrees + 180) % 360) * RADIANS_PER_DEGREE;
  const frames: FireFrame[] = [{ elapsedMinutes: 0, perimeter: EMPTY_PERIMETER }];

  for (
    let minutes = FIRE_STEP_MINUTES;
    minutes <= FIRE_HORIZON_MINUTES;
    minutes += FIRE_STEP_MINUTES
  ) {
    const seconds = minutes * 60;
    const semiMajor = ((headRate + backRate) / 2) * seconds;
    const centerOffset = ((headRate - backRate) / 2) * seconds;
    const semiMinor = FIRE_MODEL.baseSpreadMetersPerSecond * seconds;
    const ring: number[][] = [];
    for (let index = 0; index < RING_SEGMENTS; index++) {
      const angle = (index / RING_SEGMENTS) * 2 * Math.PI;
      const alongWind = centerOffset + semiMajor * Math.cos(angle);
      const acrossWind = semiMinor * Math.sin(angle);
      ring.push(
        geographicPoint(
          origin,
          alongWind * Math.sin(windToward) + acrossWind * Math.cos(windToward),
          alongWind * Math.cos(windToward) - acrossWind * Math.sin(windToward),
        ),
      );
    }
    // GeoJSON exterior rings are counterclockwise and explicitly closed.
    ring.reverse();
    ring.push([...ring[0]]);
    frames.push({
      elapsedMinutes: minutes,
      perimeter: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { elapsedMinutes: minutes },
            geometry: { type: "Polygon", coordinates: [ring] },
          },
        ],
      },
    });
  }

  return {
    model: FIRE_MODEL,
    inputs: { ...inputs, origin: { ...origin } },
    stepMinutes: FIRE_STEP_MINUTES,
    horizonMinutes: FIRE_HORIZON_MINUTES,
    frames,
  };
}
