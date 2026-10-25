/**
 * How long a run simulates (its horizon), shared by /fire and Simulation Studio. Pure: no React.
 *
 * Times are simulation-clock minutes from T+0. A longer run keeps the number of output frames
 * bounded by spacing them further apart (`frameStepMinutes`): frames are contours of one
 * continuous arrival field, so a wider spacing only changes how finely playback and the
 * perimeters sample it, not the fire.
 */

const HOUR = 60;

/** The run lengths offered as one-click choices, hours. */
export const HORIZON_PRESET_HOURS = [3, 6, 12, 24, 48, 72] as const;
/** Shortest and longest run a page accepts, minutes (1 hour to 7 days). */
export const MIN_HORIZON_MINUTES = 1 * HOUR;
export const MAX_HORIZON_MINUTES = 168 * HOUR;
/**
 * Longest hourly weather window the weather APIs serve, hours (`MAX_HOURS` in
 * app/backend/api/scenario_weather.py). It covers `MAX_HORIZON_MINUTES` plus one hour.
 */
export const MAX_WEATHER_HOURS = 169;
/**
 * From this horizon on, a solve can take a few seconds on a large board (measured: a 72 h run
 * on a 30 km board burning to its edge, about 2 s; 7 days about 5 s).
 */
export const SLOW_SOLVE_HORIZON_MINUTES = 48 * HOUR;
/** Upper bound on output frames; the frame spacing grows to stay under it. */
export const MAX_FRAMES = 240;
/** Frame spacings tried in order, minutes. */
const FRAME_STEP_LADDER = [5, 10, 15, 30, 60, 120, 180] as const;

/** Whole minutes in [MIN, MAX]; non-finite input gives the minimum. */
export function clampHorizonMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return MIN_HORIZON_MINUTES;
  return Math.min(MAX_HORIZON_MINUTES, Math.max(MIN_HORIZON_MINUTES, Math.round(minutes)));
}

/** True when the horizon is a whole number of minutes within the accepted range. */
export function isValidHorizonMinutes(minutes: number): boolean {
  return (
    Number.isInteger(minutes) && minutes >= MIN_HORIZON_MINUTES && minutes <= MAX_HORIZON_MINUTES
  );
}

/**
 * Minutes between output frames for a run of `horizonMinutes`: the smallest spacing at least
 * `baseStepMinutes` that keeps the frame count at most `MAX_FRAMES` (plus T+0). /fire's base
 * is 15 min (a 48 h run keeps 15 min, 72 h gets 30 min); Studio's is 5 min.
 */
export function frameStepMinutes(horizonMinutes: number, baseStepMinutes: number): number {
  for (const step of FRAME_STEP_LADDER) {
    if (step < baseStepMinutes) continue;
    if (horizonMinutes / step <= MAX_FRAMES) return step;
  }
  return Math.max(baseStepMinutes, Math.ceil(horizonMinutes / MAX_FRAMES / HOUR) * HOUR);
}

/** "45 min", "6 h", "36 h", "3 days" (whole days from 48 h), "2 days 6 h". */
export function formatHorizon(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < HOUR) return `${whole} min`;
  const hours = Math.floor(whole / HOUR);
  const rest = whole % HOUR;
  if (rest !== 0) return `${hours} h ${rest} min`;
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const leftover = hours % 24;
  return leftover === 0 ? `${days} days` : `${days} days ${leftover} h`;
}
