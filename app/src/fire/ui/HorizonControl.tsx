import { useId, useState } from "react";
import {
  HORIZON_PRESET_HOURS,
  MAX_HORIZON_MINUTES,
  MIN_HORIZON_MINUTES,
  SLOW_SOLVE_HORIZON_MINUTES,
  clampHorizonMinutes,
  formatHorizon,
} from "../horizon";
import "./horizonControl.css";

const HOUR = 60;
const CUSTOM = "custom";

function presetLabel(hours: number): string {
  return hours >= 48 ? `${hours / 24} days (${hours} h)` : `${hours} hours`;
}

/**
 * "How long to simulate": one-click run lengths from 3 hours to 3 days, plus a custom number
 * of hours up to 7 days. Shared by /fire and Simulation Studio.
 */
export default function HorizonControl({
  value,
  onChange,
  frameStepMinutes,
  disabled = false,
}: {
  /** Horizon, minutes. */
  value: number;
  onChange: (minutes: number) => void;
  /** Spacing of the run's frames at this horizon, for the hint. */
  frameStepMinutes: number;
  disabled?: boolean;
}) {
  const uid = useId();
  const isPreset = (HORIZON_PRESET_HOURS as readonly number[]).includes(value / HOUR);
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const custom = customOpen || !isPreset;
  const [draft, setDraft] = useState(String(Math.round(value / HOUR)));
  // A horizon set from elsewhere (a loaded scenario) replaces the typed text.
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(String(Math.round(value / HOUR)));
  }

  /** Applies the typed hours (clamped) on blur or Enter, so typing "72" does not run 7 h first. */
  function commit() {
    const hours = Number(draft);
    const minutes =
      draft.trim() === "" || !Number.isFinite(hours) ? value : clampHorizonMinutes(hours * HOUR);
    setDraft(String(Math.round(minutes / HOUR)));
    if (minutes !== value) onChange(minutes);
  }

  const notes: string[] = [];
  if (custom) notes.push(`${formatHorizon(value)} (1 to ${MAX_HORIZON_MINUTES / HOUR / 24} days)`);
  if (value >= SLOW_SOLVE_HORIZON_MINUTES) notes.push("solving can take a few seconds");
  return (
    <div className="fr-hz">
      <label className="fr-hz-title" htmlFor={`${uid}-select`}>
        How long to simulate
      </label>
      <div className="fr-hz-row">
        <select
          id={`${uid}-select`}
          className="ui-input"
          value={custom ? CUSTOM : String(value)}
          disabled={disabled}
          title={`Frames every ${frameStepMinutes} min`}
          aria-describedby={notes.length > 0 ? `${uid}-note` : undefined}
          onChange={(event) => {
            if (event.target.value === CUSTOM) {
              setCustomOpen(true);
              setDraft(String(Math.round(value / HOUR)));
              return;
            }
            setCustomOpen(false);
            onChange(Number(event.target.value));
          }}
        >
          {HORIZON_PRESET_HOURS.map((hours) => (
            <option key={hours} value={hours * HOUR}>
              {presetLabel(hours)}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
        {custom && (
          <label className="fr-hz-custom" htmlFor={`${uid}-hours`}>
            <input
              id={`${uid}-hours`}
              type="number"
              className="ui-input"
              min={MIN_HORIZON_MINUTES / HOUR}
              max={MAX_HORIZON_MINUTES / HOUR}
              step={1}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
              }}
            />
            <span>hours</span>
          </label>
        )}
      </div>
      {notes.length > 0 && (
        <p className="fr-hz-note" id={`${uid}-note`}>
          {notes.join(" · ")}.
        </p>
      )}
    </div>
  );
}
