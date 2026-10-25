import { compassPoint } from "../spread";
import { weatherAtMinute, type FireWeatherSeries } from "../weatherSeries";
import { formatDuration } from "./format";

const HOUR_MINUTES = 60;
/** Direction arrows every this many hours, so a 24 h strip shows 13, a 6 h strip 7, 72 h 13. */
function arrowIntervalMinutes(horizonMinutes: number): number {
  if (horizonMinutes <= 6 * HOUR_MINUTES) return HOUR_MINUTES;
  if (horizonMinutes <= 24 * HOUR_MINUTES) return 2 * HOUR_MINUTES;
  if (horizonMinutes <= 72 * HOUR_MINUTES) return 6 * HOUR_MINUTES;
  return 12 * HOUR_MINUTES;
}

/**
 * Wind over the run, drawn on the playback's time axis: the 20 ft wind speed the solver read
 * (the series as interpolated, before any natural-variation wander) and arrows pointing where
 * it blows, with a marker and readout at the playback time. Weather input, not model output.
 */
export default function WindStrip({
  series,
  horizonMinutes,
  t,
}: {
  series: FireWeatherSeries;
  horizonMinutes: number;
  /** Playback time, minutes from T+0. */
  t: number;
}) {
  const points: { minute: number; mph: number; from: number }[] = [];
  const stepMinutes = 10;
  for (let minute = 0; minute <= horizonMinutes; minute += stepMinutes) {
    const w = weatherAtMinute(series, minute);
    points.push({ minute, mph: w.windSpeedMph, from: w.windFromDegrees });
  }
  const maxMph = Math.max(10, ...points.map((p) => p.mph));
  const minMph = Math.min(...points.map((p) => p.mph));
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${((p.minute / horizonMinutes) * 1000).toFixed(1)},${(30 - (p.mph / maxMph) * 26).toFixed(1)}`)
    .join(" ");
  const interval = arrowIntervalMinutes(horizonMinutes);
  const arrows = points.filter((p) => p.minute % interval === 0);
  const now = weatherAtMinute(series, Math.max(0, Math.min(t, horizonMinutes)));
  const nowFrom = Math.round(now.windFromDegrees);
  const label = `Wind over the run: ${Math.round(minMph)} to ${Math.round(maxMph)} mph. At ${formatDuration(t)}: ${Math.round(now.windSpeedMph)} mph from ${nowFrom}° ${compassPoint(nowFrom)}.`;
  return (
    <div className="fr-wind-strip">
      <div className="fr-wind-strip-plot" role="img" aria-label={label}>
        <svg viewBox="0 0 1000 32" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        {arrows.map((p) => (
          <span
            key={p.minute}
            className="fr-wind-strip-arrow"
            style={{ left: `${(p.minute / horizonMinutes) * 100}%`, transform: `translateX(-50%) rotate(${(p.from + 180 - 90) % 360}deg)` }}
            aria-hidden="true"
          >
            →
          </span>
        ))}
        <span
          className="fr-wind-strip-now"
          style={{ left: `${(Math.max(0, Math.min(t, horizonMinutes)) / horizonMinutes) * 100}%` }}
          aria-hidden="true"
        />
      </div>
      <p className="fr-wind-strip-readout">
        <span>
          Wind now <strong>{Math.round(now.windSpeedMph)} mph</strong> from {nowFrom}° {compassPoint(nowFrom)}
        </span>
        <span className="fr-wind-strip-range">
          {Math.round(minMph)}–{Math.round(maxMph)} mph over the run · hourly weather input
        </span>
      </p>
    </div>
  );
}
