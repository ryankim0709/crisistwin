import type { KeyboardEvent } from "react";
import { SQUARE_METERS_PER_ACRE, SQUARE_METERS_PER_HECTARE } from "../fire/spread";
import { Field, IconButton } from "../ui";
import DayNightBand from "../fire/ui/DayNightBand";
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

/** "10 sim-min/s", or "4 sim-h/s" from an hour per second up. */
function speedText(minutesPerSecond: number): string {
  return minutesPerSecond >= 60
    ? `${Number((minutesPerSecond / 60).toFixed(1))} sim-h/s`
    : `${minutesPerSecond} sim-min/s`;
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
    speedLocked = false,
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
    clock,
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

  /** Slider position of any minute, interpolated between the frames around it. */
  function sliderFraction(minute: number): number {
    if (lastIndex <= 0) return 0;
    if (minute <= frameMinutes[0]) return 0;
    if (minute >= frameMinutes[lastIndex]) return 1;
    let i = 0;
    while (i < lastIndex - 1 && frameMinutes[i + 1] <= minute) i += 1;
    const span = frameMinutes[i + 1] - frameMinutes[i];
    const within = span > 0 ? (minute - frameMinutes[i]) / span : 0;
    return (i + within) / lastIndex;
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
          <IconButton
            label="Restart"
            variant="secondary"
            size="sm"
            disabled={!enabled}
            onClick={onRestart}
          >
            ⏮
          </IconButton>
          <IconButton
            label="Previous step"
            variant="secondary"
            size="sm"
            disabled={!enabled || index <= 0}
            onClick={() => onStep(-1)}
          >
            ◀
          </IconButton>
          <IconButton
            label={playing ? "Pause" : "Play"}
            variant="primary"
            size="sm"
            disabled={!enabled}
            onClick={onPlayPause}
          >
            {playing ? "❚❚" : "▶"}
          </IconButton>
          <IconButton
            label="Next step"
            variant="secondary"
            size="sm"
            disabled={!enabled || index >= lastIndex}
            onClick={() => onStep(1)}
          >
            ▶▶
          </IconButton>
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
          {clock && enabled && (
            <DayNightBand
              clock={clock}
              horizonMinutes={horizonMinutes}
              t={currentMinute}
              fraction={sliderFraction}
              note={clock.note}
            />
          )}
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
          <Field label="Viewing speed">
            <select
              value={speed}
              disabled={speedLocked}
              title={
                speedLocked
                  ? "The AI dispatcher session sets the pace; use Speed in the dispatch console."
                  : "Changes how fast you watch the playback, not how fast the fire spreads."
              }
              onChange={(event) => onSpeedChange(Number(event.target.value))}
            >
              {speedChoices.map((choice) => (
                <option key={choice} value={choice}>
                  ×{choice} = {speedText(choice)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      <div className="studio-metrics">
        <span>
          Ignitions triggered {metrics.ignitionsTriggered}/{metrics.ignitionsTotal}
        </span>
        <span>
          Modelled area reached {formatArea(hectares)} ha · {formatArea(acres)} ac
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
