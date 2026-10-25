/**
 * Wall-clock time of a run, for showing elapsed simulation minutes as local time with day and
 * night. Pure: no React. Sunrise and sunset are NOAA's (studio/daylight.ts).
 *
 * Units: UTC epoch milliseconds, simulation minutes from T+0, WGS84 degrees. Every board is in
 * California (the weather service covers California stations only), so local time is Pacific.
 */

import { flightWindows } from "../studio/daylight";

export const BOARD_TIME_ZONE = "America/Los_Angeles";
const MS_PER_MINUTE = 60_000;

export interface RunClock {
  /** T+0, UTC epoch ms. */
  startMs: number;
  /** Where the sun is computed (ignition or board centre). */
  latitude: number;
  longitude: number;
}

export interface DaySpan {
  startMinute: number;
  endMinute: number;
  night: boolean;
}

/**
 * Day and night over [0, horizonMinutes], in order and covering it exactly. Day is sunrise to
 * sunset at the official zenith (civil twilight counts as night).
 */
export function daySpans(clock: RunClock, horizonMinutes: number): DaySpan[] {
  const endMs = clock.startMs + horizonMinutes * MS_PER_MINUTE;
  const toMinute = (ms: number) =>
    Math.min(horizonMinutes, Math.max(0, (ms - clock.startMs) / MS_PER_MINUTE));
  const days = flightWindows(clock.startMs, endMs, clock.latitude, clock.longitude, 0, 0)
    .map((w) => ({ start: toMinute(w.startMs), end: toMinute(w.endMs) }))
    .filter((w) => w.end > w.start);
  const spans: DaySpan[] = [];
  let cursor = 0;
  for (const day of days) {
    if (day.start > cursor) spans.push({ startMinute: cursor, endMinute: day.start, night: true });
    spans.push({ startMinute: Math.max(cursor, day.start), endMinute: day.end, night: false });
    cursor = day.end;
  }
  if (cursor < horizonMinutes) {
    spans.push({ startMinute: cursor, endMinute: horizonMinutes, night: true });
  }
  return spans;
}

export function isNightAt(spans: readonly DaySpan[], minute: number): boolean {
  for (const span of spans) {
    if (minute >= span.startMinute && minute <= span.endMinute) return span.night;
  }
  return false;
}

const CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BOARD_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const OFFSET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: BOARD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

/**
 * A UTC instant as Pacific wall-clock time with its offset, "2022-10-29T13:00-07:00" (the form
 * `FirefightingSettings.startLocalIso` takes). Unparseable input comes back unchanged.
 */
export function pacificIso(utcIso: string): string {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return utcIso;
  const parts = Object.fromEntries(
    OFFSET_PARTS.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  const offset = /GMT([+-]\d{2}:\d{2})/.exec(parts.timeZoneName ?? "")?.[1] ?? "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${offset}`;
}

/** "Sat, Nov 8, 6:20 AM PST" for the run's minute. */
export function formatClock(clock: RunClock, minute: number): string {
  return CLOCK_FORMAT.format(new Date(clock.startMs + minute * MS_PER_MINUTE));
}
