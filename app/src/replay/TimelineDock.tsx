import { memo, useMemo } from "react";
import { EVENT_CATEGORY_LABEL, EventGlyph } from "./parts";
import { clockParts, eventCategory, eventTicks, formatAge } from "./timeline";
import type { ReplayEvent } from "./types";

/** Playback speeds in simulated seconds per wall-clock second. */
export const SPEEDS = [
  { value: 60, label: "1 min/s" },
  { value: 600, label: "10 min/s" },
  { value: 3600, label: "1 h/s" },
] as const;

/** Scrubber tick positions; dense event streams collapse into one tick per bucket and category. */
const TICK_BUCKETS = 240;

const EventTicks = memo(function EventTicks({
  events,
  startMs,
  endMs,
}: {
  events: readonly ReplayEvent[];
  startMs: number;
  endMs: number;
}) {
  const ticks = useMemo(() => eventTicks(events, startMs, endMs, TICK_BUCKETS), [events, startMs, endMs]);
  return (
    <div className="rp-ticks" aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={tick.key}
          className={`rp-tick rp-tick--${tick.category}`}
          style={{ left: `${tick.fraction * 100}%` }}
          title={tick.count > 1 ? `${tick.count} × ${EVENT_CATEGORY_LABEL[tick.category]}` : tick.label}
        >
          <EventGlyph category={tick.category} size={10} />
        </span>
      ))}
    </div>
  );
});

function Clock({ ms, timeZone, label }: { ms: number; timeZone: string; label: string }) {
  const parts = clockParts(ms, timeZone);
  return (
    <div className="rp-clock-row">
      <span className="rp-clock-zone">{label}</span>
      <span className="rp-clock-time">{parts.time}</span>
      <span className="rp-clock-date">
        {parts.date} {parts.zone}
      </span>
    </div>
  );
}

export interface TimelineDockProps {
  simTimeMs: number;
  startMs: number;
  endMs: number;
  stepSeconds: number;
  timezone: string;
  events: readonly ReplayEvent[];
  playing: boolean;
  speed: number;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
  onStep: (direction: -1 | 1) => void;
  onReset: () => void;
  onSpeed: (speed: number) => void;
  stepLabel: string;
}

export default function TimelineDock({
  simTimeMs,
  startMs,
  endMs,
  stepSeconds,
  timezone,
  events,
  playing,
  speed,
  onTogglePlay,
  onSeek,
  onStep,
  onReset,
  onSpeed,
  stepLabel,
}: TimelineDockProps) {
  const local = clockParts(simTimeMs, timezone);
  const progress = ((simTimeMs - startMs) / (endMs - startMs)) * 100;
  const categories = useMemo(
    () => Array.from(new Set(events.map((e) => eventCategory(e.type)))),
    [events],
  );

  return (
    <section className="rp-dock" aria-label="Replay timeline">
      <div className="rp-clock" aria-live="off">
        <Clock ms={simTimeMs} timeZone={timezone} label="Local" />
        <Clock ms={simTimeMs} timeZone="UTC" label="UTC" />
        <span className="rp-clock-elapsed">T+{formatAge(simTimeMs - startMs)} on simulation clock</span>
      </div>

      <div className="rp-dock-main">
        <div className="rp-controls">
          <button type="button" className="rp-btn" onClick={onReset} aria-label="Reset to start" title="Reset (Home)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3v10M13 3 6 8l7 5z" /></svg>
          </button>
          <button
            type="button"
            className="rp-btn"
            onClick={() => onStep(-1)}
            aria-label={`Step back ${stepLabel}`}
            title={`Step back ${stepLabel} (←)`}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3 2 8l6 5zM14 3 8 8l6 5z" /></svg>
          </button>
          <button
            type="button"
            className="rp-btn rp-btn--play"
            onClick={onTogglePlay}
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            title="Play / pause (Space)"
          >
            {playing ? (
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h3v12H4zM9 2h3v12H9z" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z" /></svg>
            )}
          </button>
          <button
            type="button"
            className="rp-btn"
            onClick={() => onStep(1)}
            aria-label={`Step forward ${stepLabel}`}
            title={`Step forward ${stepLabel} (→)`}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3l6 5-6 5zM2 3l6 5-6 5z" /></svg>
          </button>

          <div className="rp-speed" role="group" aria-label="Playback speed">
            {SPEEDS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="rp-speed-btn"
                aria-pressed={speed === option.value}
                onClick={() => onSpeed(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rp-scrub">
          <div className="rp-scrub-track" aria-hidden="true">
            <div className="rp-scrub-fill" style={{ width: `${progress}%` }} />
          </div>
          <EventTicks events={events} startMs={startMs} endMs={endMs} />
          <input
            type="range"
            className="rp-scrub-input"
            min={startMs}
            max={endMs}
            step={stepSeconds * 1000}
            value={simTimeMs}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="Replay time"
            aria-valuetext={`${local.date} ${local.time} ${local.zone}`}
          />
        </div>

        <ul className="rp-tick-legend" aria-label="Timeline marker key">
          {categories.map((category) => (
            <li key={category}>
              <EventGlyph category={category} size={10} />
              {EVENT_CATEGORY_LABEL[category]}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
