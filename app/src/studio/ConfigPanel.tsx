import { useId, useState, type ChangeEvent } from "react";
import {
  DEFAULT_MIDFLAME_ADJUSTMENT,
  DEFAULT_SPOTTING,
  DEFAULT_STRUCTURE_SPREAD,
  MOISTURE_PRESETS,
  STRUCTURE_SPREAD_REFERENCE_WIND_MPH,
  compassPoint,
} from "../fire/spread";
import type { FireSettings, IgnitionProblem } from "../fire/scheduledTypes";
import {
  MAX_ENABLED_IGNITIONS,
  MAX_WIND_SPEED_MPH,
  MIN_WIND_SPEED_MPH,
  STUDIO_HORIZON_CHOICES,
  type ConfigPanelProps,
  type MapMode,
  type RunPhase,
  type ScenarioIssue,
  type ScheduledIgnition,
} from "./contracts";
import "./studioControls.css";

const MIDFLAME_MIN = 0.1;
const MIDFLAME_MAX = 1;
const MIDFLAME_DEFAULT_EPSILON = 1e-6;
const MAX_SPOTTING_DISTANCE_METERS = 2000;
const MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE = 20;
const MAX_NAME_LENGTH = 40;
const MOISTURE_KEYS = ["dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"] as const;
const MOISTURE_MATCH_EPSILON = 1e-9;
const CUSTOM_MOISTURE_VALUE = "custom";

const PHASE_TEXT: Record<RunPhase, string> = {
  editing: "Not run yet",
  "loading-landscape": "Loading landscape…",
  computing: "Computing…",
  ready: "Ready",
  failed: "Failed",
  canceled: "Canceled",
};

const MODE_HINT: Record<MapMode, string> = {
  select: "Select a fire to edit it; drag a marker to move it.",
  add: "Click the map to add a fire there.",
  move: "Click the map to move the selected fire there.",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isBusy(phase: RunPhase): boolean {
  return phase === "loading-landscape" || phase === "computing";
}

function numberFrom(event: ChangeEvent<HTMLInputElement>): number | null {
  const value = event.target.valueAsNumber;
  return Number.isFinite(value) ? value : null;
}

export default function ConfigPanel(props: ConfigPanelProps) {
  const {
    scenario,
    issues,
    problems,
    selectedId,
    mode,
    phase,
    stale,
    draftStatus,
    collapsed,
    onToggleCollapsed,
    onModeChange,
    onSelectIgnition,
    onScenarioChange,
    onRun,
    onCancel,
    onClear,
    onExport,
    onImport,
    onLoadDemo,
  } = props;

  const uid = useId();
  const [importText, setImportText] = useState("");
  const [importIssues, setImportIssues] = useState<ScenarioIssue[]>([]);

  const { settings, ignitions } = scenario;
  const horizon = settings.horizonMinutes;
  const enabledCount = ignitions.filter((ignition) => ignition.enabled).length;
  const atIgnitionLimit = enabledCount >= MAX_ENABLED_IGNITIONS;
  const busy = isBusy(phase);
  const runDisabled = issues.length > 0 || busy;
  const runLabel = stale ? "Rerun simulation" : "Run simulation";
  const selected = ignitions.find((ignition) => ignition.id === selectedId) ?? null;
  const scenarioIssues = issues.filter((issue) => !issue.ignitionId);
  const sorted = [...ignitions].sort((a, b) => a.startMinute - b.startMinute);

  const spotting = settings.spotting ?? DEFAULT_SPOTTING;
  const structure = settings.structureSpread ?? DEFAULT_STRUCTURE_SPREAD;
  const midflameIsDefault =
    Math.abs(settings.midflameAdjustment - DEFAULT_MIDFLAME_ADJUSTMENT) < MIDFLAME_DEFAULT_EPSILON;

  const matchedPreset = MOISTURE_PRESETS.find((preset) =>
    MOISTURE_KEYS.every(
      (key) => Math.abs(preset.moisture[key] - settings.moisture[key]) < MOISTURE_MATCH_EPSILON,
    ),
  );

  function setSettings(patch: Partial<FireSettings>) {
    onScenarioChange({ ...scenario, settings: { ...settings, ...patch } });
  }

  function updateIgnition(id: string, patch: Partial<ScheduledIgnition>) {
    onScenarioChange({
      ...scenario,
      ignitions: ignitions.map((ignition) =>
        ignition.id === id ? { ...ignition, ...patch } : ignition,
      ),
    });
  }

  function deleteIgnition(id: string) {
    onScenarioChange({
      ...scenario,
      ignitions: ignitions.filter((ignition) => ignition.id !== id),
    });
    if (selectedId === id) onSelectIgnition(null);
  }

  function runImport(text: string) {
    setImportIssues(onImport(text));
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      runImport(await file.text());
    } catch {
      setImportIssues([{ message: "That file could not be read." }]);
    }
  }

  const runButton = (
    <button
      type="button"
      className="studio-btn studio-btn-primary studio-btn-run"
      onClick={onRun}
      disabled={runDisabled}
      aria-describedby={issues.length > 0 ? `${uid}-run-note` : undefined}
    >
      {busy ? PHASE_TEXT[phase] : runLabel}
    </button>
  );

  const statusLine = [PHASE_TEXT[phase], stale ? "out of date" : null, draftStatus]
    .filter(Boolean)
    .join(" · ");

  if (collapsed) {
    return (
      <aside className="studio-panel studio-panel-collapsed" aria-label="Scenario settings">
        <button
          type="button"
          className="studio-btn studio-btn-secondary"
          onClick={onToggleCollapsed}
          aria-expanded={false}
        >
          Scenario ›
        </button>
        {runButton}
        <p className="studio-status" role="status">
          {PHASE_TEXT[phase]}
          {stale ? " · Out of date" : ""}
        </p>
      </aside>
    );
  }

  return (
    <aside className="studio-panel" aria-label="Scenario settings">
      <div className="studio-panel-body">
        <div className="studio-panel-head">
          <h2 className="studio-title">Scenario</h2>
          <button
            type="button"
            className="studio-btn studio-btn-ghost studio-btn-small"
            onClick={onToggleCollapsed}
            aria-expanded={true}
            aria-label="Hide scenario panel"
          >
            ‹ Hide
          </button>
        </div>
        <p className="studio-note">User assumptions, not observed data or a forecast.</p>

        <section className="studio-section" aria-labelledby={`${uid}-ign`}>
          <div className="studio-section-head">
            <h3 id={`${uid}-ign`} className="studio-subtitle">
              Fires{" "}
              <span className="studio-count">
                {enabledCount}/{MAX_ENABLED_IGNITIONS}
              </span>
            </h3>
            <div className="studio-segmented" role="group" aria-label="Map click mode">
              <button
                type="button"
                className="studio-btn studio-btn-toggle studio-btn-small"
                aria-pressed={mode === "add"}
                disabled={atIgnitionLimit && mode !== "add"}
                onClick={() => onModeChange(mode === "add" ? "select" : "add")}
              >
                + Add
              </button>
              <button
                type="button"
                className="studio-btn studio-btn-toggle studio-btn-small"
                aria-pressed={mode === "move"}
                disabled={!selected}
                title={selected ? undefined : "Select a fire in the list first"}
                onClick={() => onModeChange(mode === "move" ? "select" : "move")}
              >
                Move
              </button>
            </div>
          </div>
          <p className={`studio-hint${mode !== "select" ? " is-active" : ""}`} aria-live="polite">
            {atIgnitionLimit && mode !== "move"
              ? `Limit of ${MAX_ENABLED_IGNITIONS} enabled fires reached. Disable or delete one to add another.`
              : MODE_HINT[mode]}
          </p>

          {ignitions.length === 0 ? (
            <div className="studio-empty">
              <span>Choose + Add, then click the map.</span>
              <button
                type="button"
                className="studio-btn studio-btn-secondary studio-btn-small"
                onClick={onLoadDemo}
              >
                Load demo
              </button>
            </div>
          ) : (
            <ul className="studio-ignitions">
              {sorted.map((ignition) => {
                const rowIssues = issues.filter((issue) => issue.ignitionId === ignition.id);
                const rowProblems: IgnitionProblem[] = problems.filter(
                  (problem) => problem.sourceId === ignition.id,
                );
                const hasField = (field: ScenarioIssue["field"]) =>
                  rowIssues.some((issue) => issue.field === field);
                const isSelected = ignition.id === selectedId;
                const base = `${uid}-${ignition.id}`;
                const messageId = `${base}-msg`;
                const hasMessages = rowIssues.length + rowProblems.length > 0;
                const displayName = ignition.name || "ignition";
                return (
                  <li
                    key={ignition.id}
                    className={`studio-ignition${isSelected ? " is-selected" : ""}${
                      ignition.enabled ? "" : " is-disabled"
                    }`}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => {
                      if (!isSelected) onSelectIgnition(ignition.id);
                    }}
                    onFocusCapture={() => {
                      if (!isSelected) onSelectIgnition(ignition.id);
                    }}
                  >
                    <div className="studio-ignition-top">
                      <input
                        type="checkbox"
                        className="studio-ignition-enabled"
                        checked={ignition.enabled}
                        aria-label={`Enable ${displayName}`}
                        title={ignition.enabled ? "Enabled" : "Disabled"}
                        onChange={(event) =>
                          updateIgnition(ignition.id, { enabled: event.target.checked })
                        }
                      />
                      <label className="studio-visually-hidden" htmlFor={`${base}-name`}>
                        Ignition name
                      </label>
                      <input
                        id={`${base}-name`}
                        type="text"
                        className="studio-input studio-input-name"
                        value={ignition.name}
                        maxLength={MAX_NAME_LENGTH}
                        aria-invalid={hasField("name") || undefined}
                        aria-describedby={hasMessages ? messageId : undefined}
                        onChange={(event) =>
                          updateIgnition(ignition.id, { name: event.target.value })
                        }
                      />
                      <label className="studio-start" htmlFor={`${base}-start`}>
                        <span aria-hidden="true">T+</span>
                        <span className="studio-visually-hidden">Start, minutes after T+0</span>
                        <input
                          id={`${base}-start`}
                          type="number"
                          className="studio-input studio-input-minute"
                          min={0}
                          max={Math.max(horizon - 1, 0)}
                          step={1}
                          value={ignition.startMinute}
                          aria-invalid={hasField("startMinute") || undefined}
                          aria-describedby={hasMessages ? messageId : undefined}
                          onChange={(event) => {
                            const value = numberFrom(event);
                            if (value === null) return;
                            updateIgnition(ignition.id, {
                              startMinute: clamp(Math.round(value), 0, Math.max(horizon - 1, 0)),
                            });
                          }}
                        />
                        <span aria-hidden="true">m</span>
                      </label>
                      <button
                        type="button"
                        className="studio-btn studio-btn-ghost studio-btn-icon"
                        aria-label={`Delete ${displayName}`}
                        title="Delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteIgnition(ignition.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                    {(isSelected || hasField("location")) && (
                      <p
                        className={`studio-coords${hasField("location") ? " has-issue" : ""}`}
                        aria-label="Location, read only"
                      >
                        {ignition.location.latitude.toFixed(5)},{" "}
                        {ignition.location.longitude.toFixed(5)}
                      </p>
                    )}
                    {hasMessages && (
                      <ul id={messageId} className="studio-field-errors">
                        {rowIssues.map((issue, index) => (
                          <li key={`issue-${index}`}>Problem: {issue.message}</li>
                        ))}
                        {rowProblems.map((problem, index) => (
                          <li key={`problem-${index}`}>Problem: {problem.message}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {scenarioIssues.length > 0 && (
            <ul className="studio-alert" role="alert">
              {scenarioIssues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="studio-section" aria-labelledby={`${uid}-wx`}>
          <h3 id={`${uid}-wx`} className="studio-subtitle">
            Conditions <span className="studio-subtitle-note">constant for the run</span>
          </h3>

          <div className="studio-field">
            <label htmlFor={`${uid}-wind`}>Wind speed, mph (20-ft)</label>
            <div className="studio-row">
              <input
                id={`${uid}-wind`}
                type="range"
                className="studio-range"
                min={MIN_WIND_SPEED_MPH}
                max={MAX_WIND_SPEED_MPH}
                step={1}
                value={settings.windSpeedMph}
                onChange={(event) => {
                  const value = numberFrom(event);
                  if (value !== null) setSettings({ windSpeedMph: value });
                }}
              />
              <input
                type="number"
                className="studio-input studio-input-number"
                aria-label="Wind speed in miles per hour"
                min={MIN_WIND_SPEED_MPH}
                max={MAX_WIND_SPEED_MPH}
                step={1}
                value={settings.windSpeedMph}
                onChange={(event) => {
                  const value = numberFrom(event);
                  if (value !== null) {
                    setSettings({
                      windSpeedMph: clamp(value, MIN_WIND_SPEED_MPH, MAX_WIND_SPEED_MPH),
                    });
                  }
                }}
              />
            </div>
          </div>

          <div className="studio-field">
            <label htmlFor={`${uid}-dir`}>Wind from, degrees</label>
            <div className="studio-row">
              <input
                id={`${uid}-dir`}
                type="number"
                className="studio-input studio-input-number"
                min={0}
                max={359}
                step={1}
                value={settings.windFromDegrees}
                onChange={(event) => {
                  const value = numberFrom(event);
                  if (value === null) return;
                  setSettings({ windFromDegrees: ((Math.round(value) % 360) + 360) % 360 });
                }}
              />
              <span className="studio-hint">
                From {compassPoint(settings.windFromDegrees)}, blowing toward{" "}
                {compassPoint(settings.windFromDegrees + 180)}
              </span>
            </div>
          </div>

          <div className="studio-grid-2">
            <div className="studio-field">
              <label htmlFor={`${uid}-moisture`}>Fuel moisture</label>
              <select
                id={`${uid}-moisture`}
                className="studio-input"
                value={matchedPreset?.id ?? CUSTOM_MOISTURE_VALUE}
                aria-describedby={`${uid}-moisture-note`}
                onChange={(event) => {
                  const preset = MOISTURE_PRESETS.find((item) => item.id === event.target.value);
                  if (preset) setSettings({ moisture: { ...preset.moisture } });
                }}
              >
                {!matchedPreset && <option value={CUSTOM_MOISTURE_VALUE}>Custom</option>}
                {MOISTURE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="studio-field">
              <label htmlFor={`${uid}-horizon`}>Horizon</label>
              <select
                id={`${uid}-horizon`}
                className="studio-input"
                value={horizon}
                onChange={(event) => setSettings({ horizonMinutes: Number(event.target.value) })}
              >
                {!(STUDIO_HORIZON_CHOICES as readonly number[]).includes(horizon) && (
                  <option value={horizon}>{horizon} min</option>
                )}
                {STUDIO_HORIZON_CHOICES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes / 60} h
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p id={`${uid}-moisture-note`} className="studio-hint">
            {matchedPreset ? matchedPreset.description : "Moisture values differ from every preset."}
          </p>

          <details className="studio-advanced">
            <summary>Advanced model settings</summary>
            <div className="studio-field">
              <label htmlFor={`${uid}-midflame`}>Midflame wind factor</label>
              <div className="studio-row">
                <input
                  id={`${uid}-midflame`}
                  type="number"
                  className="studio-input studio-input-number"
                  min={MIDFLAME_MIN}
                  max={MIDFLAME_MAX}
                  step={0.05}
                  value={settings.midflameAdjustment}
                  onChange={(event) => {
                    const value = numberFrom(event);
                    if (value !== null) {
                      setSettings({ midflameAdjustment: clamp(value, MIDFLAME_MIN, MIDFLAME_MAX) });
                    }
                  }}
                />
                {!midflameIsDefault && (
                  <button
                    type="button"
                    className="studio-btn studio-btn-secondary studio-btn-small"
                    onClick={() => setSettings({ midflameAdjustment: DEFAULT_MIDFLAME_ADJUSTMENT })}
                  >
                    Reset to default
                  </button>
                )}
              </div>
              <p className="studio-hint">
                {midflameIsDefault
                  ? `Left at ${DEFAULT_MIDFLAME_ADJUSTMENT}: the model derives a factor per cell from canopy cover, canopy height and fuel bed depth.`
                  : `Overridden: ${settings.midflameAdjustment} is applied to every cell (midflame wind ${(
                      settings.windSpeedMph * settings.midflameAdjustment
                    ).toFixed(1)} mph).`}
              </p>
            </div>

            <div className="studio-field">
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={spotting.enabled}
                  onChange={(event) =>
                    setSettings({ spotting: { ...spotting, enabled: event.target.checked } })
                  }
                />
                Ember spotting
              </label>
              <label className="studio-inline-field" htmlFor={`${uid}-spot`}>
                Max distance (m)
                <input
                  id={`${uid}-spot`}
                  type="number"
                  className="studio-input studio-input-number"
                  min={0}
                  max={MAX_SPOTTING_DISTANCE_METERS}
                  step={50}
                  value={spotting.maxDistanceMeters}
                  disabled={!spotting.enabled}
                  onChange={(event) => {
                    const value = numberFrom(event);
                    if (value !== null) {
                      setSettings({
                        spotting: {
                          ...spotting,
                          maxDistanceMeters: clamp(value, 0, MAX_SPOTTING_DISTANCE_METERS),
                        },
                      });
                    }
                  }}
                />
              </label>
            </div>

            <div className="studio-field">
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={structure.enabled}
                  onChange={(event) =>
                    setSettings({ structureSpread: { ...structure, enabled: event.target.checked } })
                  }
                />
                Structure-to-structure spread
              </label>
              <label className="studio-inline-field" htmlFor={`${uid}-struct`}>
                Rate at {STRUCTURE_SPREAD_REFERENCE_WIND_MPH} mph (m/min)
                <input
                  id={`${uid}-struct`}
                  type="number"
                  className="studio-input studio-input-number"
                  min={0}
                  max={MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE}
                  step={0.5}
                  value={structure.rateMetersPerMinute}
                  disabled={!structure.enabled}
                  onChange={(event) => {
                    const value = numberFrom(event);
                    if (value !== null) {
                      setSettings({
                        structureSpread: {
                          ...structure,
                          rateMetersPerMinute: clamp(value, 0, MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE),
                        },
                      });
                    }
                  }}
                />
              </label>
            </div>
          </details>
        </section>

        <details className="studio-advanced">
          <summary>Scenario file</summary>
          <div className="studio-row studio-row-wrap">
            <button
              type="button"
              className="studio-btn studio-btn-secondary studio-btn-small"
              onClick={onLoadDemo}
            >
              Load demo
            </button>
            <button
              type="button"
              className="studio-btn studio-btn-secondary studio-btn-small"
              onClick={onExport}
            >
              Export JSON
            </button>
            <button
              type="button"
              className="studio-btn studio-btn-secondary studio-btn-small"
              onClick={onClear}
            >
              Clear all
            </button>
          </div>
          <div className="studio-field">
            <label htmlFor={`${uid}-file`}>Import a scenario file</label>
            <input
              id={`${uid}-file`}
              type="file"
              accept="application/json,.json"
              className="studio-file"
              onChange={(event) => void importFile(event)}
            />
          </div>
          <div className="studio-field">
            <label htmlFor={`${uid}-paste`}>Or paste scenario JSON</label>
            <textarea
              id={`${uid}-paste`}
              className="studio-input studio-textarea"
              rows={3}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <button
              type="button"
              className="studio-btn studio-btn-secondary studio-btn-small"
              disabled={importText.trim() === ""}
              onClick={() => runImport(importText)}
            >
              Import pasted JSON
            </button>
          </div>
          {importIssues.length > 0 && (
            <ul className="studio-alert" role="alert">
              {importIssues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          )}
          <p className="studio-status">
            A scenario file does not guarantee identical results later; source data can change.
          </p>
        </details>
      </div>

      <section className="studio-panel-foot" aria-label="Run">
        {stale && (
          <p className="studio-warning">Edited since the last run. Run again to update.</p>
        )}
        {issues.length > 0 && (
          <p id={`${uid}-run-note`} className="studio-hint">
            Fix the {issues.length === 1 ? "problem" : `${issues.length} problems`} above to run.
          </p>
        )}
        <div className="studio-row">
          {runButton}
          {busy && (
            <button type="button" className="studio-btn studio-btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        <p className="studio-status" role="status">
          {statusLine}
        </p>
      </section>
    </aside>
  );
}
