/**
 * Official sunrise and sunset from date and location, for the aviation daylight rules of the
 * suppression model (docs/adr/0048-suppression-engine.md).
 *
 * Equations: NOAA Global Monitoring Laboratory, "General Solar Position Calculations"
 * (gml.noaa.gov/grad/solcalc/solareqns.PDF): fractional year, equation of time and solar
 * declination as Fourier series, and the sunrise/sunset hour angle at the official zenith of
 * 90.833 degrees (refraction and solar radius). Stated accuracy is about a minute at mid
 * latitudes, which is far finer than the 30-minute flight-window margins.
 *
 * Units: angles in degrees unless named radians; times in UTC epoch milliseconds or minutes
 * after UTC midnight as named. Longitude east positive.
 */

const DEG = Math.PI / 180;
/** NOAA: zenith for official sunrise/sunset, degrees (0.833 deg below the horizon). */
export const OFFICIAL_ZENITH_DEGREES = 90.833;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export interface SunTimes {
  /** UTC epoch ms; null when the sun does not rise or set that day (polar day or night). */
  sunriseMs: number | null;
  sunsetMs: number | null;
}

function dayOfYear(utcMidnightMs: number): number {
  const date = new Date(utcMidnightMs);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((utcMidnightMs - start) / MS_PER_DAY) + 1;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Sunrise and sunset on the UTC calendar date that contains `utcMidnightMs` (pass a UTC
 * midnight), NOAA general solar position equations evaluated at solar noon of that date.
 */
export function sunTimesUtc(utcMidnightMs: number, latitude: number, longitude: number): SunTimes {
  const year = new Date(utcMidnightMs).getUTCFullYear();
  const days = isLeap(year) ? 366 : 365;
  const doy = dayOfYear(utcMidnightMs);
  // NOAA: gamma = 2 pi / 365 (day_of_year - 1 + (hour - 12) / 24); hour = 12 (noon).
  const gamma = ((2 * Math.PI) / days) * (doy - 1);
  // NOAA: equation of time, minutes.
  const eqTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  // NOAA: solar declination, radians.
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const lat = latitude * DEG;
  // NOAA: cos(ha) = cos(zenith) / (cos(lat) cos(decl)) - tan(lat) tan(decl).
  const cosHa =
    Math.cos(OFFICIAL_ZENITH_DEGREES * DEG) / (Math.cos(lat) * Math.cos(decl)) -
    Math.tan(lat) * Math.tan(decl);
  if (cosHa > 1 || cosHa < -1) return { sunriseMs: null, sunsetMs: null };
  const haDegrees = Math.acos(cosHa) / DEG;
  // NOAA: sunrise = 720 - 4 (longitude + ha) - eqtime; sunset = 720 - 4 (longitude - ha) - eqtime
  // (minutes after UTC midnight, longitude east positive).
  const sunriseMinutes = 720 - 4 * (longitude + haDegrees) - eqTimeMinutes;
  const sunsetMinutes = 720 - 4 * (longitude - haDegrees) - eqTimeMinutes;
  return {
    sunriseMs: utcMidnightMs + sunriseMinutes * MS_PER_MINUTE,
    sunsetMs: utcMidnightMs + sunsetMinutes * MS_PER_MINUTE,
  };
}

export interface Window {
  startMs: number;
  endMs: number;
}

/**
 * Flight windows covering [fromMs, toMs]: for each solar day, [sunrise + before, sunset +
 * after] (minutes; negative `before` opens the window before sunrise). Solar days are taken
 * from the UTC dates around the interval, so a window that straddles UTC midnight (the US
 * west coast's evening) is still found.
 */
export function flightWindows(
  fromMs: number,
  toMs: number,
  latitude: number,
  longitude: number,
  sunriseOffsetMinutes: number,
  sunsetOffsetMinutes: number,
): Window[] {
  const windows: Window[] = [];
  const first = Math.floor(fromMs / MS_PER_DAY) - 1;
  const last = Math.floor(toMs / MS_PER_DAY) + 1;
  for (let day = first; day <= last; day += 1) {
    const sun = sunTimesUtc(day * MS_PER_DAY, latitude, longitude);
    if (sun.sunriseMs === null || sun.sunsetMs === null) continue;
    windows.push({
      startMs: sun.sunriseMs + sunriseOffsetMinutes * MS_PER_MINUTE,
      endMs: sun.sunsetMs + sunsetOffsetMinutes * MS_PER_MINUTE,
    });
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}

/** The first time >= `ms` inside a window, or null when none of `windows` is later. */
export function nextInWindow(windows: readonly Window[], ms: number): number | null {
  for (const w of windows) {
    if (ms <= w.endMs) return Math.max(ms, w.startMs);
  }
  return null;
}

export function inWindow(windows: readonly Window[], ms: number): boolean {
  return windows.some((w) => ms >= w.startMs && ms <= w.endMs);
}
