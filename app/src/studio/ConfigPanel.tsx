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
import { Button, EmptyState, Field, IconButton, Notice, Panel } from "../ui";
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
    liveDrill,
    firefighting,
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
  // With no fires yet the empty state already says what to do, so "Enable at least one fire" is
  // not shown as an error until there is a fire to enable.
  const nothingPlaced = ignitions.length === 0;
  const scenarioIssues = issues.filter(
    (issue) => !issue.ignitionId && !(nothingPlaced && issue.field === "ignitions"),
  );
  const shownIssueCount = nothingPlaced
    ? issues.filter((issue) => issue.field !== "ignitions").length
    : issues.length;
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
    <Button
      size="sm"
      className="studio-btn-run"
      onClick={onRun}
      disabled={runDisabled}
      aria-describedby={issues.length > 0 ? `${uid}-run-note` : undefined}
    >
      {busy ? PHASE_TEXT[phase] : runLabel}
    </Button>
  );

  const statusLine = [PHASE_TEXT[phase], stale ? "out of date" : null, draftStatus]
    .filter(Boolean)
    .join(" · ");

  if (collapsed) {
    return (
      <Panel
        glass
        compact
        className="studio-panel studio-panel-collapsed"
        aria-label="Scenario settings"
      >
        <Button variant="secondary" size="sm" onClick={onToggleCollapsed} aria-expanded={false}>
          Scenario ›
        </Button>
        {runButton}
        <p className="studio-status" role="status">
          {PHASE_TEXT[phase]}
          {stale ? " · Out of date" : ""}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      glass
      compact
      className="studio-panel"
      aria-label="Scenario settings"
      title="Scenario"
      aside={
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapsed}
          aria-expanded={true}
          aria-label="Hide scenario panel"
        >
          ‹ Hide
        </Button>
      }
    >
      <div className="studio-panel-body">
        <p className="studio-hint">User assumptions, not observed data or a forecast.</p>

        <section className="studio-section" aria-labelledby={`${uid}-ign`}>
          <div className="studio-section-head">
            <h3 id={`${uid}-ign`} className="studio-subtitle">
              Fires{" "}
              <span className="studio-count">
                {enabledCount}/{MAX_ENABLED_IGNITIONS}
              </span>
            </h3>
            <div className="studio-segmented" role="group" aria-label="Map click mode">
              <Button
                variant="secondary"
                size="sm"
                aria-pressed={mode === "add"}
                disabled={atIgnitionLimit && mode !== "add"}
                onClick={() => onModeChange(mode === "add" ? "select" : "add")}
              >
                + Add
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-pressed={mode === "move"}
                disabled={!selected}
                title={selected ? undefined : "Select a fire in the list first"}
                onClick={() => onModeChange(mode === "move" ? "select" : "move")}
              >
                Move
              </Button>
            </div>
          </div>
          <p className={`studio-hint${mode !== "select" ? " is-active" : ""}`} aria-live="polite">
            {atIgnitionLimit && mode !== "move"
              ? `Limit of ${MAX_ENABLED_IGNITIONS} enabled fires reached. Disable or delete one to add another.`
              : MODE_HINT[mode]}
          </p>

          {ignitions.length === 0 ? (
            <EmptyState
              title="No fires yet"
              symbol="+"
              action={
                <Button variant="secondary" size="sm" onClick={onLoadDemo}>
                  Load demo
                </Button>
              }
            >
              Choose + Add, then click the map.
            </EmptyState>
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
                      <input
                        id={`${base}-name`}
                        type="text"
                        aria-label="Ignition name"
                        className="ui-input studio-input-name"
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
                          className="ui-input studio-input-minute"
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
                      <IconButton
                        label={`Delete ${displayName}`}
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteIgnition(ignition.id);
                        }}
                      >
                        ×
                      </IconButton>
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
            <>
              {scenarioIssues.map((issue, index) => (
                <Notice key={index} tone="danger" className="studio-notice">
                  {issue.message}
                </Notice>
              ))}
            </>
          )}
        </section>

        <section className="studio-section" aria-labelledby={`${uid}-wx`}>
          <h3 id={`${uid}-wx`} className="studio-subtitle">
            Conditions <span className="studio-subtitle-note">constant for the run</span>
          </h3>

          <Field label="Wind speed, mph (20-ft)">
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
                className="studio-input-number"
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
          </Field>

          <div className="studio-field">
            <Field label="Wind from, degrees">
              <input
                id={`${uid}-dir`}
                type="number"
                className="studio-input-number"
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
            </Field>
            <p className="studio-hint">
              From {compassPoint(settings.windFromDegrees)}, blowing toward{" "}
              {compassPoint(settings.windFromDegrees + 180)}
            </p>
          </div>

          <div className="studio-grid-2">
            <Field label="Fuel moisture">
              <select
                id={`${uid}-moisture`}
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
            </Field>
            <Field label="Horizon">
              <select
                id={`${uid}-horizon`}
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
            </Field>
          </div>
          <p id={`${uid}-moisture-note`} className="studio-hint">
            {matchedPreset ? matchedPreset.description : "Moisture values differ from every preset."}
          </p>

          <details className="studio-advanced">
            <summary>Advanced model settings</summary>
            <div className="studio-field">
              <Field label="Midflame wind factor">
                <div className="studio-row">
                  <input
                    id={`${uid}-midflame`}
                    type="number"
                    className="studio-input-number"
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
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setSettings({ midflameAdjustment: DEFAULT_MIDFLAME_ADJUSTMENT })}
                    >
                      Reset to default
                    </Button>
                  )}
                </div>
              </Field>
              <p className="studio-hint">
                {midflameIsDefault
                  ? `Left at ${DEFAULT_MIDFLAME_ADJUSTMENT}: the model derives a factor per cell from canopy cover, canopy height and fuel bed depth.`
                  : `Overridden: ${settings.midflameAdjustment} is applied to every cell (midflame wind ${(
                      settings.windSpeedMph * settings.midflameAdjustment
                    ).toFixed(1)} mph).`}
              </p>
            </div>

            <div className="studio-field">
              <label className="ui-check">
                <input
                  type="checkbox"
                  checked={spotting.enabled}
                  onChange={(event) =>
                    setSettings({ spotting: { ...spotting, enabled: event.target.checked } })
                  }
                />
                Ember spotting
              </label>
              <Field label="Max distance (m)">
                <input
                  id={`${uid}-spot`}
                  type="number"
                  className="studio-input-number"
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
              </Field>
            </div>

            <div className="studio-field">
              <label className="ui-check">
                <input
                  type="checkbox"
                  checked={structure.enabled}
                  onChange={(event) =>
                    setSettings({ structureSpread: { ...structure, enabled: event.target.checked } })
                  }
                />
                Structure-to-structure spread
              </label>
              <Field label={`Rate at ${STRUCTURE_SPREAD_REFERENCE_WIND_MPH} mph (m/min)`}>
                <input
                  id={`${uid}-struct`}
                  type="number"
                  className="studio-input-number"
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
                          rateMetersPerMinute: clamp(
                            value,
                            0,
                            MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE,
                          ),
                        },
                      });
                    }
                  }}
                />
              </Field>
            </div>
          </details>
        </section>

        {firefighting}

        <details className="studio-advanced">
          <summary>Scenario file</summary>
          <div className="studio-row studio-row-wrap">
            <Button variant="secondary" size="sm" onClick={onLoadDemo}>
              Load demo
            </Button>
            <Button variant="secondary" size="sm" onClick={onExport}>
              Export JSON
            </Button>
            <Button variant="secondary" size="sm" onClick={onClear}>
              Clear all
            </Button>
          </div>
          {liveDrill}
          <div className="studio-field">
            <Field label="Import a scenario file">
              <input
                id={`${uid}-file`}
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importFile(event)}
              />
            </Field>
          </div>
          <div className="studio-field">
            <Field label="Or paste scenario JSON">
              <textarea
                id={`${uid}-paste`}
                className="studio-textarea"
                rows={3}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
            </Field>
            <Button
              variant="secondary"
              size="sm"
              disabled={importText.trim() === ""}
              onClick={() => runImport(importText)}
            >
              Import pasted JSON
            </Button>
          </div>
          {importIssues.length > 0 && (
            <div>
              {importIssues.map((issue, index) => (
                <Notice key={index} tone="danger" className="studio-notice">
                  {issue.message}
                </Notice>
              ))}
            </div>
          )}
          <p className="studio-status">
            A scenario file does not guarantee identical results later; source data can change.
          </p>
        </details>
      </div>

      <section className="studio-panel-foot" aria-label="Run">
        {stale && (
          <Notice compact className="studio-notice">
            Edited since the last run. Run again to update.
          </Notice>
        )}
        {issues.length > 0 && (
          <p id={`${uid}-run-note`} className="studio-hint">
            {shownIssueCount === 0
              ? "Add a fire or load the demo to run."
              : `Fix the ${shownIssueCount === 1 ? "problem" : `${shownIssueCount} problems`} above to run.`}
          </p>
        )}
        <div className="studio-row">
          {runButton}
          {busy && (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <p className="studio-status" role="status">
          {statusLine}
        </p>
      </section>
    </Panel>
  );
}
