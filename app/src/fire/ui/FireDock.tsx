import type { KeyboardEvent } from "react";
import { FIRE_STEP_MINUTES } from "../spread";
import {
  PLAYBACK_SPEEDS,
  modelMinutesPerSecond,
  type FirePlayback,
  type PlaybackSpeed,
} from "../useFirePlayback";
import { Button, IconButton, SegmentedControl, type SegmentedOption } from "../../ui";
import { formatDuration } from "./format";

const HOUR_MINUTES = 60;
const SEEK_STEP_MINUTES = FIRE_STEP_MINUTES;
const SEEK_BIG_STEP_MINUTES = HOUR_MINUTES;
/** Per-frame minor ticks crowd the rail beyond this many frames. */
const MAX_MINOR_TICK_FRAMES = 30;

const SPEED_OPTIONS: readonly SegmentedOption<string>[] = PLAYBACK_SPEEDS.map((value) => ({
  value: String(value),
  label: `${value}×`,
}));

/** Spacing of labelled hour marks: every 1 h up to 6 h, every 3 h for 12 h, every 6 h beyond. */
function labelIntervalMinutes(horizonMinutes: number): number {
  if (horizonMinutes <= 6 * HOUR_MINUTES) return HOUR_MINUTES;
  if (horizonMinutes <= 12 * HOUR_MINUTES) return 3 * HOUR_MINUTES;
  return 6 * HOUR_MINUTES;
}

type FireDockProps = {
  playback: FirePlayback;
  horizonMinutes: number;
  hasRun: boolean;
  canFocusFire: boolean;
  sceneReady: boolean;
  onResetView: () => void;
  onFocusFire: () => void;
};

export default function FireDock({
  playback,
  horizonMinutes,
  hasRun,
  canFocusFire,
  sceneReady,
  onResetView,
  onFocusFire,
}: FireDockProps) {
  const { t, playing, speed } = playback;
  const ended = t >= horizonMinutes;
  const progress = horizonMinutes > 0 ? (t / horizonMinutes) * 100 : 0;
  const labelInterval = labelIntervalMinutes(horizonMinutes);
  const frameCount = Math.floor(horizonMinutes / FIRE_STEP_MINUTES);
  const tickStep = frameCount <= MAX_MINOR_TICK_FRAMES ? FIRE_STEP_MINUTES : labelInterval;
  const ticks = Array.from(
    { length: Math.floor(horizonMinutes / tickStep) + 1 },
    (_, index) => index * tickStep,
  );
  const labelMarks = Array.from(
    { length: Math.floor(horizonMinutes / labelInterval) + 1 },
    (_, index) => index * labelInterval,
  );
  const minutesPerSecond = modelMinutesPerSecond(horizonMinutes);

  const onSliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.shiftKey ? SEEK_BIG_STEP_MINUTES : SEEK_STEP_MINUTES;
    const now = playback.getTime();
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = now - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = now + step;
    else if (event.key === "PageDown") next = now - SEEK_BIG_STEP_MINUTES;
    else if (event.key === "PageUp") next = now + SEEK_BIG_STEP_MINUTES;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = horizonMinutes;
    if (next === null) return;
    event.preventDefault();
    playback.seek(next);
  };

  return (
    <section className="fr-dock fr-panel" aria-label="Fire playback">
      <div className="fr-dock-buttons">
        <IconButton
          variant="primary"
          label={playing ? "Pause" : ended ? "Replay from start" : "Play"}
          title="Play / pause (Space)"
          onClick={playback.toggle}
          disabled={!hasRun}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 2.5 13.5 8l-9 5.5z" />
            </svg>
          )}
        </IconButton>
        <IconButton
          variant="secondary"
          label="Restart"
          onClick={playback.restart}
          disabled={!hasRun}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d="M3 2.5v3.2h3.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </IconButton>
        <IconButton
          variant="secondary"
          className="fr-dock-step"
          label={`Back ${FIRE_STEP_MINUTES} minutes`}
          onClick={() => {
            if (!hasRun || t <= 0) return;
            playback.pause();
            playback.seek(Math.max(0, playback.getTime() - FIRE_STEP_MINUTES));
          }}
          aria-disabled={!hasRun || t <= 0}
        >
          ‹
        </IconButton>
        <IconButton
          variant="secondary"
          className="fr-dock-step"
          label={`Forward ${FIRE_STEP_MINUTES} minutes`}
          onClick={() => {
            if (!hasRun || ended) return;
            playback.pause();
            playback.seek(Math.min(horizonMinutes, playback.getTime() + FIRE_STEP_MINUTES));
          }}
          aria-disabled={!hasRun || ended}
        >
          ›
        </IconButton>
      </div>

      <div className="fr-scrub">
        <div className="fr-scrub-rail" aria-hidden="true">
          <span className="fr-scrub-fill" style={{ width: `${progress}%` }} />
          {ticks.map((minutes) => (
            <span
              key={minutes}
              className={`fr-scrub-tick${minutes % labelInterval === 0 ? " is-hour" : ""}`}
              style={{ left: `${(minutes / horizonMinutes) * 100}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          className="fr-scrub-input"
          min={0}
          max={horizonMinutes}
          step="any"
          value={t}
          disabled={!hasRun}
          onChange={(event) => {
            playback.pause();
            playback.seek(Number(event.target.value));
          }}
          onKeyDown={onSliderKey}
          aria-label="Elapsed time"
          aria-valuetext={`${formatDuration(t)} of ${formatDuration(horizonMinutes)}`}
        />
        <ol className="fr-scrub-labels" aria-label="Hours since ignition">
          {labelMarks.map((minutes) => (
            <li key={minutes} style={{ left: `${(minutes / horizonMinutes) * 100}%` }}>
              <button
                type="button"
                className="fr-scrub-label"
                disabled={!hasRun}
                onClick={() => {
                  playback.pause();
                  playback.seek(minutes);
                }}
                aria-label={`Jump to ${formatDuration(minutes)}`}
              >
                {minutes === 0 ? "0" : `${minutes / HOUR_MINUTES} h`}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <p className="fr-time">
        <span className="fr-time-now">{formatDuration(t)}</span>
        <span className="fr-time-total">
          of {formatDuration(horizonMinutes)}
          <span className="fr-time-frames"> · frames every {FIRE_STEP_MINUTES} min</span>
        </span>
      </p>

      <div className="fr-dock-end">
        <SegmentedControl
          className="fr-speed"
          label="Playback speed"
          options={SPEED_OPTIONS}
          value={String(speed)}
          onChange={(value) => playback.setSpeed(Number(value) as PlaybackSpeed)}
        />
        <Button
          variant="secondary"
          className="fr-dock-action"
          onClick={onResetView}
          disabled={!sceneReady}
          title="Return the camera to the view of the whole board"

          icon={
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="8" cy="8" r="1.6" fill="currentColor" />
            </svg>
          }
        >
          <span>Reset view</span>
        </Button>
        <Button
          variant="secondary"
          className="fr-dock-action"
          onClick={onFocusFire}
          disabled={!sceneReady || !canFocusFire}
          title="Frame the burned area"

          icon={
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 14c-2.8 0-4.2-1.9-3.6-4.1.4-1.2 1.4-2 1.7-3.6 1.3.8 1.7 1.7 1.9 2.7.5-.5.7-1.2.6-2.1 1.7 1.4 2.6 2.8 2.5 4.1C11 12.7 9.7 14 8 14z"
                fill="currentColor"
              />
            </svg>
          }
        >
          <span>Focus fire</span>
        </Button>
      </div>
      <p className="fr-speed-note">1× = {Math.round(minutesPerSecond)} model minutes per second</p>
    </section>
  );
}
