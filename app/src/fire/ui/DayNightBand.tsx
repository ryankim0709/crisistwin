import { useMemo } from "react";
import { daySpans, formatClock, isNightAt, type RunClock } from "../runClock";
import "./dayNight.css";

/** Spans narrower than this share of the bar carry no "Night" word. */
const MIN_LABEL_FRACTION = 0.07;

/**
 * Day and night on a playback time axis: night spans shaded and labelled "Night" (so colour is
 * not the only cue), with the local clock at the playback time. `fraction` maps a minute to a
 * position on the bar (default minute / horizon).
 */
export default function DayNightBand({
  clock,
  horizonMinutes,
  t,
  fraction,
  note,
}: {
  clock: RunClock;
  horizonMinutes: number;
  /** Playback time, minutes from T+0. */
  t: number;
  fraction?: (minute: number) => number;
  /** Where the clock comes from, e.g. "weather start" or "scenario clock (assumed)". */
  note?: string;
}) {
  const spans = useMemo(() => daySpans(clock, horizonMinutes), [clock, horizonMinutes]);
  const at = (minute: number) =>
    fraction ? fraction(minute) : horizonMinutes > 0 ? minute / horizonMinutes : 0;
  const now = Math.max(0, Math.min(t, horizonMinutes));
  const night = isNightAt(spans, now);
  return (
    <div className="fr-dn">
      <div className="fr-dn-band" aria-hidden="true">
        {spans
          .filter((span) => span.night)
          .map((span) => {
            const left = at(span.startMinute);
            const width = at(span.endMinute) - left;
            return (
              <span
                key={span.startMinute}
                className="fr-dn-night"
                style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
              >
                {width >= MIN_LABEL_FRACTION ? "Night" : ""}
              </span>
            );
          })}
        <span className="fr-dn-now" style={{ left: `${at(now) * 100}%` }} />
      </div>
      <p className="fr-dn-readout">
        <span>
          {formatClock(clock, now)} · <strong>{night ? "night" : "day"}</strong>
        </span>
        {note && <span className="fr-dn-note">{note}</span>}
      </p>
    </div>
  );
}
