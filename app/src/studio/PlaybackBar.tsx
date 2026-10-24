import type { KeyboardEvent } from "react";
import { SQUARE_METERS_PER_ACRE, SQUARE_METERS_PER_HECTARE } from "../fire/spread";
import type { IgnitionDisplayState, PlaybackBarProps } from "./contracts";
import "./studioControls.css";

const STATE_LABEL: Record<IgnitionDisplayState, string> = {
  draft: "draft",
  scheduled: "scheduled",
  triggered: "triggered",
  "reached-before-start": "reached by another fire before its start",
  disabled: "disabled",
  invalid: "invalid",
};

function pad2(value: number): string {
  return String(Math.floor(value)).padStart(2, "0");
}

/** Zero-padded HH:MM from elapsed minutes. */
function hhmm(minutes: number): string {
  return `${pad2(minutes / 60)}:${pad2(minutes % 60)}`;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** Under 10 of a unit, whole numbers would read a small but real footprint as 0. */
const SMALL_NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const SMALL_AREA_THRESHOLD = 10;

function formatArea(value: number): string {
  return (value < SMALL_AREA_THRESHOLD ? SMALL_NUMBER_FORMAT : NUMBER_FORMAT).format(value);
}

export default function PlaybackBar(props: PlaybackBarProps) {
  const {
    enabled,
    frameMinutes,
    frameIndex,
    horizonMinutes,
    playing,
    speed,
    speedChoices,
    events,
    metrics,
    onPlayPause,
    onStep,
    onRestart,
    onSpeedChange,
    onSeek,
  } = props;

  const lastIndex = Math.max(frameMinutes.length - 1, 0);
  const index = Math.min(Math.max(frameIndex, 0), lastIndex);
  const currentMinute = frameMinutes[index] ?? 0;
  const timeText = `T+${hhmm(currentMinute)} / ${hhmm(horizonMinutes)}`;
  const hectares = metrics.reachedAreaSquareMeters / SQUARE_METERS_PER_HECTARE;
  const acres = metrics.reachedAreaSquareMeters / SQUARE_METERS_PER_ACRE;

  /**
   * The slider moves over frame indices, which are not evenly spaced in time (ignition
   * minutes add frames). Ticks sit at their frame's slider position so each one lines up
   * with the thumb; a minute with no frame falls back to minute / horizon.
   */
  function tickFraction(minute: number): number {
    const frame = frameMinutes.indexOf(minute);
    if (frame >= 0 && lastIndex > 0) return frame / lastIndex;
    return horizonMinutes > 0 ? Math.min(Math.max(minute / horizonMinutes, 0), 1) : 0;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled || (event.key !== " " && event.code !== "Space")) return;
    const target = event.target as HTMLElement;
    // Buttons and selects already handle Space themselves; only the bar itself and the
    // scrubber should toggle play, and never anything outside the bar.
    const isBar = target === event.currentTarget;
    const isScrubber = target instanceof HTMLInputElement && target.type === "range";
    if (!isBar && !isScrubber) return;
    event.preventDefault();
    onPlayPause();
  }

  return (
    <div
      className="studio-playback"
      role="group"
      aria-label="Playback"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="studio-playback-main">
        <div className="studio-transport">
          <button
            type="button"
            className="studio-btn studio-btn-secondary"
            aria-label="Restart"
            title="Restart"
            disabled={!enabled}
            onClick={onRestart}
          >
            ⏮
          </button>
          <button
            type="button"
            className="studio-btn studio-btn-secondary"
            aria-label="Previous step"
            title="Previous step"
            disabled={!enabled || index <= 0}
            onClick={() => onStep(-1)}
          >
            ◀
          </button>
          <button
            type="button"
            className="studio-btn studio-btn-primary studio-play"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            disabled={!enabled}
            onClick={onPlayPause}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="studio-btn studio-btn-secondary"
            aria-label="Next step"
            title="Next step"
            disabled={!enabled || index >= lastIndex}
            onClick={() => onStep(1)}
          >
            ▶▶
          </button>
        </div>

        <div className="studio-scrub">
          <div className="studio-ticks" aria-hidden="true">
            {events.map((event) => (
              <span
                key={event.id}
                className={`studio-tick is-${event.state}`}
                style={{ ["--p" as string]: tickFraction(event.minute) }}
                title={`${event.name}: T+${hhmm(event.minute)} (${STATE_LABEL[event.state]})`}
              >
                <span className="studio-tick-label">{event.name}</span>
              </span>
            ))}
          </div>
          <input
            type="range"
            className="studio-range studio-scrubber"
            aria-label="Simulation time"
            aria-valuetext={`T+${hhmm(currentMinute)} of ${hhmm(horizonMinutes)}`}
            min={0}
            max={lastIndex}
            step={1}
            value={index}
            disabled={!enabled}
            onChange={(event) => onSeek(Number(event.target.value))}
          />
          <ul className="studio-visually-hidden" aria-label="Ignition events">
            {events.map((event) => (
              <li key={event.id}>
                {event.name} at T+{hhmm(event.minute)}, {STATE_LABEL[event.state]}
              </li>
            ))}
          </ul>
        </div>

        <div className="studio-time" aria-live="off">
          {timeText}
        </div>

        <div className="studio-speed">
          <label htmlFor="studio-speed-select">Viewing speed</label>
          <select
            id="studio-speed-select"
            className="studio-input"
            value={speed}
            disabled={!enabled}
            title="Changes how fast you watch the playback, not how fast the fire spreads."
            onChange={(event) => onSpeedChange(Number(event.target.value))}
          >
            {speedChoices.map((choice) => (
              <option key={choice} value={choice}>
                ×{choice} = {choice} sim-min/s
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="studio-metrics">
        <span>
          Ignitions triggered {metrics.ignitionsTriggered}/{metrics.ignitionsTotal}
        </span>
        <span>
          Modelled area reached {formatArea(hectares)} ha · {formatArea(acres)}{" "}
          ac
        </span>
        <span>
          {metrics.nextIgnition
            ? `Next ignition ${metrics.nextIgnition.name} at T+${hhmm(metrics.nextIgnition.minute)}`
            : "None scheduled"}
        </span>
        {!enabled && <span className="studio-hint">Run the simulation to enable playback</span>}
      </div>
    </div>
  );
}
