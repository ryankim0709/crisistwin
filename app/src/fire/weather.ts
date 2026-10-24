/**
 * Observed/forecast surface wind for an ignition point, from the US National Weather
 * Service API (api.weather.gov): free, keyless, and limited to the United States and its
 * territories.
 *
 * This module only fetches and returns data. It owns no UI state: the page decides whether
 * to copy a reading into the wind controls, and the user can still override it by hand. A
 * reading here is OBSERVED/FORECAST data, not a user assumption, so every value carries the
 * provenance needed to label it honestly, and nothing is ever filled in with a guess — any
 * field that cannot be read raises an error instead of returning a plausible-looking number.
 *
 * Units match the rest of `app/src/fire`: `windSpeedMph` is miles per hour and
 * `windFromDegrees` is the meteorological bearing the wind blows FROM, degrees clockwise
 * from true north. That is the same contract as `FireScenario` in `spread.ts`, so a reading
 * can be copied straight into a scenario without conversion.
 *
 * One simplification kept visible rather than corrected away: the NWS gridded forecast wind
 * is the sustained wind at the standard 10 m height, while the Rothermel inputs call for the
 * open 20-foot wind. No height conversion is applied. The two differ by far less than the
 * forecast uncertainty, and applying an unsourced factor would misrepresent the source.
 */

export const NWS_SOURCE_NAME = "US National Weather Service forecast (api.weather.gov)";
export const NWS_ATTRIBUTION =
  "Wind, temperature, and humidity from the US National Weather Service API " +
  "(api.weather.gov), NOAA. Public domain.";
export const NWS_POINTS_URL = "https://api.weather.gov/points";
/**
 * api.weather.gov asks every client to identify itself. Deliberately generic: no email
 * address and no personal information, because this string is sent from the browser.
 */
export const NWS_USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)";

/** api.weather.gov rejects coordinates with more than 4 decimal places. */
const COORDINATE_DECIMALS = 4;
/** Above this the reading is treated as corrupt rather than as fire weather, miles per hour. */
const MAX_PLAUSIBLE_WIND_SPEED_MPH = 200;

/**
 * One hourly forecast period reduced to the fields the simulator and its labels need.
 * `null` means the source did not report the value; it never means zero.
 */
export interface NwsWindReading {
  /**
   * Sustained wind speed, miles per hour. Used directly as the open 20-foot wind
   * (`FireScenario.windSpeedMph`). When NWS reports a range such as "5 to 15 mph" this is
   * the UPPER bound, which is the gust-relevant value for fire behaviour and keeps the
   * scenario on the conservative side.
   */
  windSpeedMph: number;
  /**
   * Meteorological bearing the wind blows FROM, degrees clockwise from true north
   * (`FireScenario.windFromDegrees`). The NWS `windDirection` compass point is already the
   * direction the wind comes FROM, so no 180-degree flip is applied here; `spread.ts` does
   * that flip when it converts to a direction of travel.
   */
  windFromDegrees: number;
  /** Raw NWS wind speed text, e.g. "5 to 15 mph", for honest display of the source value. */
  windSpeedText: string;
  /** Raw NWS 16-point compass direction the wind blows FROM, e.g. "NE". */
  windFromCompass: string;
  /** True when NWS gave a range and `windSpeedMph` is its upper bound. */
  windSpeedIsRangeUpperBound: boolean;
  /** Human-readable place, e.g. "Berkeley, CA", or the queried coordinates if NWS gave none. */
  locationLabel: string;
  /** Start of the forecast hour, normalised to UTC. */
  forecastTimeUtcIso: string;
  /** Start of the forecast hour as NWS returned it, in local time with a UTC offset. */
  forecastTimeLocalIso: string;
  /** Air temperature in degrees Fahrenheit, converted once here, or null if not reported. */
  temperatureFahrenheit: number | null;
  /** Relative humidity, percent (0-100), or null if not reported. */
  relativeHumidityPercent: number | null;
  /** Coordinates actually sent to NWS, rounded to 4 decimal places. */
  queriedLatitude: number;
  queriedLongitude: number;
  source: string;
  attribution: string;
}

/**
 * The 16 compass points NWS uses for `windDirection`, as the bearing the wind blows FROM,
 * degrees clockwise from true north. Spelled out rather than computed so an unexpected
 * token fails the lookup instead of being rounded into a wrong bearing.
 */
const COMPASS_FROM_DEGREES: Readonly<Record<string, number | undefined>> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

/** "10 mph" or "5 to 15 mph"; anything else is rejected rather than guessed at. */
const WIND_SPEED_PATTERN = /^(\d+(?:\.\d+)?)(?:\s+to\s+(\d+(?:\.\d+)?))?\s*mph$/i;

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

function isWeatherGovUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "api.weather.gov";
  } catch {
    return false;
  }
}

/**
 * Fetch with the required identifying header. An aborted request propagates unchanged so the
 * caller can drop a stale lookup; a transport failure becomes an actionable error that keeps
 * the original as `cause`.
 */
async function requestWeatherGov(
  url: string,
  step: string,
  signal: AbortSignal,
): Promise<Response> {
  // Browsers strip User-Agent as a forbidden header name, so from the browser api.weather.gov
  // sees the browser's own identifier; the header still applies to non-browser callers.
  const headers = { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" };
  try {
    return await fetch(url, { signal, headers });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new Error(
      `Could not reach api.weather.gov for the ${step}. Check the network connection, or set ` +
        `the wind by hand.`,
      { cause },
    );
  }
}

async function readJson(response: Response, step: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new Error(
      `The National Weather Service ${step} returned a response that was not valid JSON.`,
      { cause },
    );
  }
}

/** "Berkeley, CA" when NWS supplies it, otherwise the queried coordinates. */
function locationLabelFrom(pointProperties: Record<string, unknown>, fallback: string): string {
  const relative = asRecord(asRecord(pointProperties.relativeLocation)?.properties);
  const city = relative?.city;
  const state = relative?.state;
  if (typeof city !== "string" || city.length === 0) return fallback;
  return typeof state === "string" && state.length > 0 ? `${city}, ${state}` : city;
}

/** Degrees Fahrenheit, converted once at this boundary. Unreported or unreadable gives null. */
function temperatureFahrenheitFrom(period: Record<string, unknown>): number | null {
  const value = period.temperature;
  const unit = period.temperatureUnit;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (unit === "F") return value;
  if (unit === "C") return Math.round((value * 1.8 + 32) * 10) / 10;
  // An unrecognised unit is reported as unavailable rather than assumed to be Fahrenheit.
  return null;
}

function relativeHumidityPercentFrom(period: Record<string, unknown>): number | null {
  const value = asRecord(period.relativeHumidity)?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

/**
 * Look up the current-hour National Weather Service forecast wind for a point.
 *
 * Coordinates are decimal degrees in LATITUDE, LONGITUDE order, matching the api.weather.gov
 * path (note that `loadLandscape` in `landscape.ts` takes longitude first). They are rounded
 * to 4 decimal places before the request, and the returned forecast describes the NWS grid
 * cell containing the point, not the point itself.
 *
 * Throws, rather than returning a fallback wind, whenever the point is outside NWS coverage,
 * the service fails, or a field cannot be read. An AbortError from `signal` propagates
 * unchanged so the caller can ignore a stale request.
 */
export async function fetchNwsWind(
  latitude: number,
  longitude: number,
  signal: AbortSignal,
): Promise<NwsWindReading> {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new Error(
      `Wind lookup needs a latitude between -90 and 90 and a longitude between -180 and 180; ` +
        `received ${latitude}, ${longitude}.`,
    );
  }

  const queriedLatitude = roundCoordinate(latitude);
  const queriedLongitude = roundCoordinate(longitude);
  const pointLabel = `${queriedLatitude}, ${queriedLongitude}`;

  const pointResponse = await requestWeatherGov(
    `${NWS_POINTS_URL}/${queriedLatitude},${queriedLongitude}`,
    "point lookup",
    signal,
  );
  if (pointResponse.status === 404) {
    throw new Error(
      `The National Weather Service has no forecast grid for ${pointLabel}. api.weather.gov ` +
        `covers only the United States and its territories; set the wind by hand here.`,
    );
  }
  if (!pointResponse.ok) {
    throw new Error(
      `National Weather Service point lookup failed (${pointResponse.status}). Try again in a ` +
        `moment, or set the wind by hand.`,
    );
  }

  const pointBody = asRecord(await readJson(pointResponse, "point lookup"));
  const pointProperties = asRecord(pointBody?.properties);
  if (!pointProperties) {
    throw new Error(
      `The National Weather Service point lookup for ${pointLabel} returned an unexpected ` +
        `response shape.`,
    );
  }
  const locationLabel = locationLabelFrom(pointProperties, pointLabel);

  const forecastHourlyUrl = pointProperties.forecastHourly;
  if (typeof forecastHourlyUrl !== "string" || forecastHourlyUrl.length === 0) {
    throw new Error(
      `The National Weather Service point lookup for ${pointLabel} did not include an hourly ` +
        `forecast URL.`,
    );
  }
  if (!isWeatherGovUrl(forecastHourlyUrl)) {
    throw new Error(
      `The National Weather Service point lookup returned an hourly forecast URL outside ` +
        `https://api.weather.gov; refusing to follow it.`,
    );
  }

  const forecastResponse = await requestWeatherGov(forecastHourlyUrl, "hourly forecast", signal);
  if (!forecastResponse.ok) {
    throw new Error(
      `National Weather Service hourly forecast request failed (${forecastResponse.status}). ` +
        `Try again in a moment, or set the wind by hand.`,
    );
  }
  const forecastProperties = asRecord(
    asRecord(await readJson(forecastResponse, "hourly forecast"))?.properties,
  );
  const periods = forecastProperties?.periods;
  // The first period is the current hour.
  const period = Array.isArray(periods) ? asRecord(periods[0]) : null;
  if (!period) {
    throw new Error(
      `The National Weather Service hourly forecast for ${locationLabel} contained no forecast ` +
        `periods.`,
    );
  }

  const windSpeedText = period.windSpeed;
  if (typeof windSpeedText !== "string" || windSpeedText.trim().length === 0) {
    throw new Error(
      `The National Weather Service hourly forecast for ${locationLabel} did not report a wind ` +
        `speed. Set the wind speed by hand.`,
    );
  }
  const speedMatch = WIND_SPEED_PATTERN.exec(windSpeedText.trim());
  if (!speedMatch) {
    throw new Error(
      `Could not read the National Weather Service wind speed "${windSpeedText}" for ` +
        `${locationLabel} as miles per hour. Set the wind speed by hand.`,
    );
  }
  // For a range such as "5 to 15 mph", take the upper bound: it is the gust-relevant
  // sustained value and the conservative choice for fire spread.
  const rangeUpperBound: string | undefined = speedMatch[2];
  const windSpeedIsRangeUpperBound = rangeUpperBound !== undefined;
  const windSpeedMph = Number.parseFloat(rangeUpperBound ?? speedMatch[1]);
  if (!Number.isFinite(windSpeedMph) || windSpeedMph < 0) {
    throw new Error(
      `Could not read the National Weather Service wind speed "${windSpeedText}" for ` +
        `${locationLabel} as miles per hour. Set the wind speed by hand.`,
    );
  }
  if (windSpeedMph > MAX_PLAUSIBLE_WIND_SPEED_MPH) {
    throw new Error(
      `The National Weather Service reported an implausible wind speed of ${windSpeedMph} mph ` +
        `for ${locationLabel}. Set the wind speed by hand.`,
    );
  }

  const windDirection = period.windDirection;
  if (typeof windDirection !== "string" || windDirection.trim().length === 0) {
    throw new Error(
      `The National Weather Service hourly forecast for ${locationLabel} did not report a wind ` +
        `direction, which happens when the wind is calm or variable. Set the wind direction ` +
        `by hand.`,
    );
  }
  const windFromCompass = windDirection.trim().toUpperCase();
  const windFromDegrees = COMPASS_FROM_DEGREES[windFromCompass];
  if (windFromDegrees === undefined) {
    throw new Error(
      `Unrecognised National Weather Service wind direction "${windDirection}" for ` +
        `${locationLabel}. Expected a 16-point compass direction such as N, NE, or WSW. Set ` +
        `the wind direction by hand.`,
    );
  }

  const startTime = typeof period.startTime === "string" ? period.startTime : "";
  const startedAt = new Date(startTime);
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error(
      `The National Weather Service hourly forecast for ${locationLabel} had no readable start ` +
        `time, so the reading cannot be dated.`,
    );
  }

  return {
    windSpeedMph,
    windFromDegrees,
    windSpeedText: windSpeedText.trim(),
    windFromCompass,
    windSpeedIsRangeUpperBound,
    locationLabel,
    forecastTimeUtcIso: startedAt.toISOString(),
    forecastTimeLocalIso: startTime,
    temperatureFahrenheit: temperatureFahrenheitFrom(period),
    relativeHumidityPercent: relativeHumidityPercentFrom(period),
    queriedLatitude,
    queriedLongitude,
    source: NWS_SOURCE_NAME,
    attribution: NWS_ATTRIBUTION,
  };
}
