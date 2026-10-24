import type { KeyboardEvent } from "react";
import { FIRE_STEP_MINUTES } from "../spread";
import {
  MODEL_MINUTES_PER_SECOND,
  PLAYBACK_SPEEDS,
  type FirePlayback,
} from "../useFirePlayback";
import { formatDuration } from "./format";

const HOUR_MINUTES = 60;
const SEEK_STEP_MINUTES = FIRE_STEP_MINUTES;
const SEEK_BIG_STEP_MINUTES = HOUR_MINUTES;

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
  const frameTicks = Array.from(
    { length: Math.floor(horizonMinutes / FIRE_STEP_MINUTES) + 1 },
    (_, index) => index * FIRE_STEP_MINUTES,
  );

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
        <button
          type="button"
          className="fr-btn fr-btn--round fr-btn--play"
          onClick={playback.toggle}
          disabled={!hasRun}
          aria-label={playing ? "Pause" : ended ? "Replay from start" : "Play"}
          title="Play / pause (Space)"
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
        </button>
        <button
          type="button"
          className="fr-btn fr-btn--round"
          onClick={playback.restart}
          disabled={!hasRun}
          aria-label="Restart"
          title="Restart"
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
        </button>
        <button
          type="button"
          className="fr-btn fr-btn--round fr-dock-step"
          onClick={() => {
            if (!hasRun || t <= 0) return;
            playback.pause();
            playback.seek(Math.max(0, playback.getTime() - FIRE_STEP_MINUTES));
          }}
          aria-disabled={!hasRun || t <= 0}
          aria-label={`Back ${FIRE_STEP_MINUTES} minutes`}
          title={`Back ${FIRE_STEP_MINUTES} minutes`}
        >
          ‹
        </button>
        <button
          type="button"
          className="fr-btn fr-btn--round fr-dock-step"
          onClick={() => {
            if (!hasRun || ended) return;
            playback.pause();
            playback.seek(Math.min(horizonMinutes, playback.getTime() + FIRE_STEP_MINUTES));
          }}
          aria-disabled={!hasRun || ended}
          aria-label={`Forward ${FIRE_STEP_MINUTES} minutes`}
          title={`Forward ${FIRE_STEP_MINUTES} minutes`}
        >
          ›
        </button>
      </div>

      <div className="fr-scrub">
        <div className="fr-scrub-rail" aria-hidden="true">
          <span className="fr-scrub-fill" style={{ width: `${progress}%` }} />
          {frameTicks.map((minutes) => (
            <span
              key={minutes}
              className={`fr-scrub-tick${minutes % HOUR_MINUTES === 0 ? " is-hour" : ""}`}
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
          {frameTicks
            .filter((minutes) => minutes % HOUR_MINUTES === 0)
            .map((minutes) => (
              <li key={minutes} style={{ left: `${(minutes / horizonMinutes) * 100}%` }}>
                <button
                  type="button"
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
          of {formatDuration(horizonMinutes)} · frames every {FIRE_STEP_MINUTES} min
        </span>
      </p>

      <div className="fr-dock-end">
        <div className="fr-speed" role="group" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => playback.setSpeed(value)}
              title={`${value * MODEL_MINUTES_PER_SECOND} model minutes per second`}
            >
              {value}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className="fr-btn fr-btn--text"
          onClick={onResetView}
          disabled={!sceneReady}
          title="Return the camera to the view of the whole board"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          </svg>
          <span>Reset view</span>
        </button>
        <button
          type="button"
          className="fr-btn fr-btn--text"
          onClick={onFocusFire}
          disabled={!sceneReady || !canFocusFire}
          title="Frame the burned area"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 14c-2.8 0-4.2-1.9-3.6-4.1.4-1.2 1.4-2 1.7-3.6 1.3.8 1.7 1.7 1.9 2.7.5-.5.7-1.2.6-2.1 1.7 1.4 2.6 2.8 2.5 4.1C11 12.7 9.7 14 8 14z"
              fill="currentColor"
            />
          </svg>
          <span>Focus fire</span>
        </button>
      </div>
      <p className="fr-speed-note">
        1× = {MODEL_MINUTES_PER_SECOND} model minutes per second
      </p>
    </section>
  );
}
