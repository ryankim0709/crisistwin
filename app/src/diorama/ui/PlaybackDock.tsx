import type { KeyboardEvent } from "react";
import type { Phase, PhaseId } from "../types";
import { formatClock } from "./format";
import { PLAYBACK_SPEEDS, type Playback } from "./usePlayback";

/** Arrow-key seek on the timeline, in scenario seconds (Shift for the larger step). */
const SEEK_STEP_S = 2;
const SEEK_BIG_STEP_S = 10;
/** One-word names keep short phases legible on the timeline; full labels stay in titles. */
const PHASE_SHORT_LABELS: Record<PhaseId, string> = {
  ignition: "Ignition",
  spread: "Spread",
  evacuation: "Evacuation",
  congestion: "Congestion",
  response: "Response",
  resolution: "Resolution",
};

type PlaybackDockProps = {
  playback: Playback;
  duration: number;
  phases: readonly Phase[];
  currentPhase: PhaseId;
  onResetView: () => void;
  resetViewDisabled: boolean;
};

export default function PlaybackDock({
  playback,
  duration,
  phases,
  currentPhase,
  onResetView,
  resetViewDisabled,
}: PlaybackDockProps) {
  const { t, playing, speed, ended } = playback;
  const progress = duration > 0 ? (t / duration) * 100 : 0;
  const phaseLabel = phases.find((phase) => phase.id === currentPhase)?.label ?? "";

  const onSliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.shiftKey ? SEEK_BIG_STEP_S : SEEK_STEP_S;
    const now = playback.getTime();
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = now - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = now + step;
    else if (event.key === "PageDown") next = now - SEEK_BIG_STEP_S;
    else if (event.key === "PageUp") next = now + SEEK_BIG_STEP_S;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = duration;
    if (next === null) return;
    event.preventDefault();
    playback.seek(next);
  };

  return (
    <section className="dio-dock dio-panel" aria-label="Scenario playback">
      <div className="dio-dock-buttons">
        <button
          type="button"
          className="dio-btn dio-btn--play"
          onClick={playback.toggle}
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
        <button type="button" className="dio-btn" onClick={playback.restart} aria-label="Restart" title="Restart">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M3 2.5v3.2h3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="dio-scrub">
        <div className="dio-scrub-rail" aria-hidden="true">
          {phases.map((phase) => (
            <span
              key={phase.id}
              className={`dio-scrub-segment${phase.id === currentPhase ? " is-current" : ""}`}
              style={{
                left: `${(phase.start / duration) * 100}%`,
                width: `${((phase.end - phase.start) / duration) * 100}%`,
              }}
            />
          ))}
          <span className="dio-scrub-fill" style={{ width: `${progress}%` }} />
        </div>
        <input
          type="range"
          className="dio-scrub-input"
          min={0}
          max={duration}
          step={0.1}
          value={t}
          onChange={(event) => playback.seek(Number(event.target.value))}
          onKeyDown={onSliderKey}
          aria-label="Scenario time"
          aria-valuetext={`${formatClock(t)} of ${formatClock(duration)}, ${phaseLabel}`}
        />
        <ol className="dio-phase-labels" aria-label="Scenario phases">
          {phases.map((phase) => (
            <li
              key={phase.id}
              style={{
                left: `${(phase.start / duration) * 100}%`,
                width: `${((phase.end - phase.start) / duration) * 100}%`,
              }}
            >
              <button
                type="button"
                className={phase.id === currentPhase ? "is-current" : undefined}
                aria-current={phase.id === currentPhase ? "step" : undefined}
                onClick={() => playback.seek(phase.start)}
                title={`Jump to ${phase.label}`}
                aria-label={`Jump to ${phase.label}`}
              >
                {PHASE_SHORT_LABELS[phase.id]}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <p className="dio-time" aria-hidden="true">
        <span className="dio-time-phase">{phaseLabel}</span>
        <span>
          {formatClock(t)} <span className="dio-time-total">/ {formatClock(duration)}</span>
        </span>
      </p>

      <div className="dio-dock-end">
        <div className="dio-speed" role="group" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => playback.setSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className="dio-btn dio-btn--text"
          onClick={onResetView}
          disabled={resetViewDisabled}
          title="Return the camera to the starting view"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          </svg>
          <span>Reset view</span>
        </button>
      </div>
    </section>
  );
}
