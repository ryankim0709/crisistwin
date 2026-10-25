/**
 * Step 1 of /run: pick a curated Berkeley preset, tweak wind, moisture, ignition and run length,
 * then "Prepare" (oneview/publishScenario.ts). Everything here is a simulated scenario input.
 */

import { Button, EvidenceTag, Field, Notice, Spinner } from "../ui";
import { MOISTURE_PRESETS } from "../fire/spread";
import type { DemoSeedPreset } from "../demo/runContracts";
import { draftFromPreset, type PrepareState, type ScenarioDraft } from "./types";
import { formatClock } from "./format";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const RUN_LENGTHS = [60, 120, 180, 240, 360];

function num(value: string, fallback: number): number {
  const n = Number(value);
  return value.trim() !== "" && Number.isFinite(n) ? n : fallback;
}

/** Progress while no stored package fits and the preset is solved and stored here (oneview/studioPackage.ts). */
const BUILD_STEP_TEXT = {
  terrain: "No stored Berkeley drill yet. Loading Berkeley terrain…",
  simulating: "Simulating the fire on the Berkeley board (Studio fire model, no firefighting)…",
  publishing: "Publishing the drill package (roads, zones and homes)…",
} as const;

function PrepareStatus({ prepare }: { prepare: PrepareState }) {
  switch (prepare.status) {
    case "idle":
      return null;
    case "checking":
    case "switching":
    case "sending":
    case "building":
      return (
        <p className="ov-status" role="status">
          <Spinner />
          {prepare.status === "checking"
            ? "Checking the live drill…"
            : prepare.status === "building"
              ? BUILD_STEP_TEXT[prepare.step]
              : prepare.status === "switching"
                ? `Switching the live drill to ${prepare.packageName}…`
                : "Starting the fire on the board…"}
        </p>
      );
    case "done":
      return (
        <Notice tone="success" compact>
          The fire is on the {prepare.incidentName} board
          {prepare.switchedTo ? ` (switched the live drill to the package “${prepare.switchedTo}”)` : " (already the live drill)"}.
          {prepare.outsideDrill.length > 0 ? ` ${prepare.outsideDrill.length} ignition(s) fall outside the drill area and will not burn.` : ""}
        </Notice>
      );
    case "failed":
      return (
        <Notice tone="danger" compact>
          {prepare.message}{" "}
          {prepare.needsStudioPackage ? (
            <a className="ui-text-link" href="/simulation">
              Open Simulation Studio
            </a>
          ) : null}
        </Notice>
      );
  }
}

export default function SetupPanel({
  presets,
  draft,
  onChange,
  onPrepare,
  prepare,
  disabled,
}: {
  presets: DemoSeedPreset[];
  draft: ScenarioDraft | null;
  onChange: (draft: ScenarioDraft) => void;
  onPrepare: () => void;
  prepare: PrepareState;
  disabled: boolean;
}) {
  if (presets.length === 0 || !draft) return <p className="ov-dim">No demo presets are available.</p>;
  const preset = presets.find((p) => p.id === draft.presetId) ?? presets[0];
  const busy = prepare.status === "checking" || prepare.status === "switching" || prepare.status === "sending" || prepare.status === "building";
  const lengths = [...new Set([...RUN_LENGTHS, preset.horizonMinutes, draft.horizonMinutes])].sort((a, b) => a - b);
  const set = (patch: Partial<ScenarioDraft>) => onChange({ ...draft, ...patch });
  const setIgnition = (n: number, patch: Partial<ScenarioDraft["ignitions"][number]>) =>
    set({ ignitions: draft.ignitions.map((ig, i) => (i === n ? { ...ig, ...patch } : ig)) });

  return (
    <div className="ov-setup">
      <Field label="Preset">
        <select
          value={preset.id}
          disabled={disabled || busy}
          onChange={(e) => {
            const next = presets.find((p) => p.id === e.target.value);
            if (next) onChange(draftFromPreset(next));
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="ov-blurb">{preset.blurb}</p>
      {preset.measured ? (
        <p className="ov-dim">
          <EvidenceTag kind="simulated" /> Headless harness, seed 1, nobody acting: {preset.measured.homesBurned} homes burned,{" "}
          {preset.measured.caughtPeople} people caught by {formatClock(preset.measured.atMinute)}. A run on this page can differ.
        </p>
      ) : null}
      <details className="ov-tweaks">
        <summary>Adjust the scenario</summary>
        <div className="ov-fields">
          <Field label="Wind speed (mph)">
            <input
              type="number"
              min={0}
              max={60}
              step={1}
              value={draft.windSpeedMph}
              disabled={disabled || busy}
              onChange={(e) => set({ windSpeedMph: Math.min(60, Math.max(0, num(e.target.value, draft.windSpeedMph))) })}
            />
          </Field>
          <Field label={`Wind from (°, ${compass(draft.windFromDeg)})`}>
            <input
              type="number"
              min={0}
              max={359}
              step={5}
              value={draft.windFromDeg}
              disabled={disabled || busy}
              onChange={(e) => set({ windFromDeg: ((num(e.target.value, draft.windFromDeg) % 360) + 360) % 360 })}
            />
          </Field>
          <Field label="Fuel moisture">
            <select
              value={draft.moisturePreset}
              disabled={disabled || busy}
              onChange={(e) => set({ moisturePreset: e.target.value as ScenarioDraft["moisturePreset"] })}
            >
              {MOISTURE_PRESETS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Run length">
            <select
              value={draft.horizonMinutes}
              disabled={disabled || busy}
              onChange={(e) => set({ horizonMinutes: Number(e.target.value) })}
            >
              {lengths.map((m) => (
                <option key={m} value={m}>
                  {m / 60} h
                </option>
              ))}
            </select>
          </Field>
          {draft.ignitions.map((ig, n) => (
            <fieldset className="ov-ignition" key={n}>
              <legend>Ignition {n + 1}</legend>
              <Field label="Latitude (°)">
                <input type="number" step={0.0005} value={ig.lat} disabled={disabled || busy} onChange={(e) => setIgnition(n, { lat: num(e.target.value, ig.lat) })} />
              </Field>
              <Field label="Longitude (°)">
                <input type="number" step={0.0005} value={ig.lon} disabled={disabled || busy} onChange={(e) => setIgnition(n, { lon: num(e.target.value, ig.lon) })} />
              </Field>
              <Field label="Starts at (min)">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={ig.startMinute}
                  disabled={disabled || busy}
                  onChange={(e) => setIgnition(n, { startMinute: Math.max(0, Math.round(num(e.target.value, ig.startMinute))) })}
                />
              </Field>
              <Field label="Reported at (min)" hint="Blank: the board models the report delay">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={ig.reportMinute ?? ""}
                  disabled={disabled || busy}
                  onChange={(e) => setIgnition(n, { reportMinute: e.target.value.trim() === "" ? null : Math.max(0, Math.round(num(e.target.value, 0))) })}
                />
              </Field>
            </fieldset>
          ))}
        </div>
      </details>
      <div className="ov-actions">
        <Button onClick={onPrepare} disabled={disabled || busy}>
          {prepare.status === "done" ? "Prepare again" : "Prepare"}
        </Button>
        <span className="ov-dim">
          <EvidenceTag kind="simulated" /> Puts this fire on the live drill&rsquo;s board.
        </span>
      </div>
      <PrepareStatus prepare={prepare} />
    </div>
  );
}
