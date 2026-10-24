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
  select: "Map click: select a marker, or pan the map. Nothing is added.",
  add: "Map click: add a new ignition at that point.",
  move: "Map click: move the selected ignition to that point.",
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
      className="studio-btn studio-btn-primary"
      onClick={onRun}
      disabled={runDisabled}
      aria-describedby={issues.length > 0 ? `${uid}-run-note` : undefined}
    >
      {runLabel}
    </button>
  );

  if (collapsed) {
    return (
      <aside className="studio-panel studio-panel-collapsed" aria-label="Scenario settings">
        <button
          type="button"
          className="studio-btn studio-btn-secondary"
          onClick={onToggleCollapsed}
          aria-expanded={false}
        >
          Show scenario panel
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
      <div className="studio-panel-head">
        <div>
          <h2 className="studio-title">Scenario</h2>
          <p className="studio-note">
            Everything below is a user assumption, not observed data or a forecast.
          </p>
        </div>
        <button
          type="button"
          className="studio-btn studio-btn-secondary"
          onClick={onToggleCollapsed}
          aria-expanded={true}
        >
          Hide
        </button>
      </div>

      <section className="studio-section" aria-labelledby={`${uid}-ign`}>
        <h3 id={`${uid}-ign`} className="studio-subtitle">
          Ignitions ({enabledCount}/{MAX_ENABLED_IGNITIONS} enabled)
        </h3>
        <div className="studio-row">
          <button
            type="button"
            className="studio-btn studio-btn-toggle"
            aria-pressed={mode === "add"}
            disabled={atIgnitionLimit && mode !== "add"}
            onClick={() => onModeChange(mode === "add" ? "select" : "add")}
          >
            Add ignition
          </button>
          <button
            type="button"
            className="studio-btn studio-btn-toggle"
            aria-pressed={mode === "move"}
            disabled={!selected}
            onClick={() => onModeChange(mode === "move" ? "select" : "move")}
          >
            Move point
          </button>
        </div>
        <p className="studio-hint" aria-live="polite">
          {MODE_HINT[mode]}
        </p>
        {atIgnitionLimit && (
          <p className="studio-hint">
            Maximum of {MAX_ENABLED_IGNITIONS} enabled ignitions reached. Disable or delete one to
            add another.
          </p>
        )}
        {!selected && (
          <p className="studio-hint">Select an ignition in the list to enable Move point.</p>
        )}

        {ignitions.length === 0 ? (
          <p className="studio-empty">Select Add ignition, then click the map.</p>
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
                      onChange={(event) => updateIgnition(ignition.id, { name: event.target.value })}
                    />
                    {isSelected && <span className="studio-badge">Selected</span>}
                    <button
                      type="button"
                      className="studio-btn studio-btn-secondary studio-btn-small"
                      aria-label={`Delete ${ignition.name || "ignition"}`}
                      onClick={() => deleteIgnition(ignition.id)}
                    >
                      Delete
                    </button>
                  </div>
                  <div className="studio-ignition-fields">
                    <label className="studio-inline-field" htmlFor={`${base}-start`}>
                      Start (T+ min)
                      <input
                        id={`${base}-start`}
                        type="number"
                        className="studio-input studio-input-number"
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
                    </label>
                    <label className="studio-check">
                      <input
                        type="checkbox"
                        checked={ignition.enabled}
                        onChange={(event) =>
                          updateIgnition(ignition.id, { enabled: event.target.checked })
                        }
                      />
                      Enabled
                    </label>
                  </div>
                  <p
                    className={`studio-coords${hasField("location") ? " has-issue" : ""}`}
                    aria-label="Location, read only"
                  >
                    Lat {ignition.location.latitude.toFixed(5)}, Lon{" "}
                    {ignition.location.longitude.toFixed(5)}
                  </p>
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
          Conditions (constant for the whole run)
        </h3>

        <div className="studio-field">
          <label htmlFor={`${uid}-wind`}>Wind speed (20-ft, mph)</label>
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
                  setSettings({ windSpeedMph: clamp(value, MIN_WIND_SPEED_MPH, MAX_WIND_SPEED_MPH) });
                }
              }}
            />
          </div>
        </div>

        <div className="studio-field">
          <label htmlFor={`${uid}-dir`}>Wind direction (degrees, from)</label>
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
              From {compassPoint(settings.windFromDegrees)} → toward{" "}
              {compassPoint(settings.windFromDegrees + 180)}
            </span>
          </div>
        </div>

        <div className="studio-field">
          <label htmlFor={`${uid}-moisture`}>Fuel moisture</label>
          <select
            id={`${uid}-moisture`}
            className="studio-input"
            value={matchedPreset?.id ?? CUSTOM_MOISTURE_VALUE}
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
          <p className="studio-hint">
            {matchedPreset ? matchedPreset.description : "Moisture values differ from every preset."}
          </p>
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

      <section className="studio-section" aria-labelledby={`${uid}-run`}>
        <h3 id={`${uid}-run`} className="studio-subtitle">
          Run
        </h3>
        <div className="studio-row">
          {runButton}
          {busy && (
            <button type="button" className="studio-btn studio-btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        {issues.length > 0 && (
          <p id={`${uid}-run-note`} className="studio-hint">
            Fix the {issues.length === 1 ? "problem" : `${issues.length} problems`} listed above to
            run.
          </p>
        )}
        <p className="studio-status" role="status">
          Status: {PHASE_TEXT[phase]}
        </p>
        {stale && (
          <p className="studio-warning">
            Scenario changed. Results shown are from the previous run. Run again to update.
          </p>
        )}

        <div className="studio-row studio-row-wrap">
          <button type="button" className="studio-btn studio-btn-secondary" onClick={onClear}>
            Clear scenario
          </button>
          <button type="button" className="studio-btn studio-btn-secondary" onClick={onLoadDemo}>
            Load demo scenario
          </button>
          <button type="button" className="studio-btn studio-btn-secondary" onClick={onExport}>
            Export JSON
          </button>
        </div>

        <details className="studio-advanced">
          <summary>Import JSON</summary>
          <div className="studio-field">
            <label htmlFor={`${uid}-file`}>Scenario file</label>
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
              rows={4}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <button
              type="button"
              className="studio-btn studio-btn-secondary"
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
        </details>

        {draftStatus && <p className="studio-status">{draftStatus}</p>}
        <p className="studio-status">
          A scenario file does not guarantee identical results later; source data can change.
        </p>
      </section>
    </aside>
  );
}
