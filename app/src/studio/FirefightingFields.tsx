/**
 * Firefighting inputs in the Studio config panel: whether resources respond, how many of each
 * ground and air resource type (or the first-alarm preset), when T+0 is on the clock (for the
 * aviation daylight rules), and how resources reach the fire. These are user assumptions; the
 * plan itself is chosen by `planFirefighting` (studio/firefighting.ts). Resource numbers come
 * from tools/suppression_resources.json (docs/adr/0048-suppression-engine.md).
 */

import type { ReactNode } from "react";
import { formatElapsed } from "../fire/spread";
import { Button, Field, Fieldset } from "../ui";
import type { StudioScenario } from "./contracts";
import {
  DEFAULT_FIREFIGHTING,
  DEFAULT_START_LOCAL_ISO,
  FIRST_ALARM,
  MAX_RESOURCES_PER_KIND,
  RESPONSE_MINUTE_CHOICES,
  apparatusCounts,
  type FirefightingSettings,
} from "./firefighting";
import {
  AIR_KINDS,
  GROUND_APPARATUS,
  GROUND_KINDS,
  apparatusLabel,
  grassRateMetersPerHour,
  isAirKind,
  type ApparatusKind,
} from "./apparatus";
import { AIRCRAFT } from "./aircraft";
import { TURNOUT_MINUTES } from "./crewDispatch";

export interface FirefightingFieldsProps {
  scenario: StudioScenario;
  onScenarioChange: (scenario: StudioScenario) => void;
  idPrefix: string;
  /** Result of the last run, shown under the inputs. */
  result?: ReactNode;
}

function hintFor(kind: ApparatusKind): string {
  if (isAirKind(kind)) {
    const spec = AIRCRAFT[kind];
    return spec.gallons > 0 ? `${spec.gallons} gal · ${spec.cruiseKnots} kt` : `${spec.cruiseKnots} kt`;
  }
  const spec = GROUND_APPARATUS[kind];
  return spec.line
    ? `${Math.round(grassRateMetersPerHour(kind))} m/h in grass · holds ≤ ${spec.holdsFlameLengthFeet} ft`
    : "builds no line";
}

const sameCounts = (a: Partial<Record<string, number>>, b: Partial<Record<string, number>>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => (a[k] ?? 0) === (b[k] ?? 0));

/** "2026-08-15T13:00-07:00" -> the datetime-local part and the offset. */
function splitIso(iso: string): { local: string; offset: string } {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  return match ? { local: match[1], offset: match[2] } : splitIso(DEFAULT_START_LOCAL_ISO);
}

export default function FirefightingFields({
  scenario,
  onScenarioChange,
  idPrefix,
  result,
}: FirefightingFieldsProps) {
  const settings = scenario.firefighting ?? DEFAULT_FIREFIGHTING;
  const counts = apparatusCounts(settings);
  const set = (patch: Partial<FirefightingSettings>) =>
    onScenarioChange({ ...scenario, firefighting: { ...settings, ...patch } });
  const setCount = (kind: ApparatusKind, value: number) =>
    set({ resources: { ...counts, [kind]: Math.max(0, Math.min(MAX_RESOURCES_PER_KIND, Math.round(value))) } });
  const clock = splitIso(settings.startLocalIso ?? DEFAULT_START_LOCAL_ISO);
  const isFirstAlarm = sameCounts(counts, FIRST_ALARM);

  const countField = (kind: ApparatusKind) => (
    <Field key={kind} label={apparatusLabel(kind)} hint={hintFor(kind)}>
      <input
        type="number"
        className="ui-input studio-input-number"
        min={0}
        max={MAX_RESOURCES_PER_KIND}
        step={1}
        value={counts[kind] ?? 0}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) setCount(kind, value);
        }}
      />
    </Field>
  );

  return (
    <section className="studio-section" aria-labelledby={`${idPrefix}-ff`}>
      <h3 id={`${idPrefix}-ff`} className="studio-subtitle">
        Firefighters <span className="studio-subtitle-note">your assumptions</span>
      </h3>
      <label className="studio-row studio-ff-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => set({ enabled: event.target.checked })}
        />
        <span>Send resources</span>
      </label>
      {settings.enabled && (
        <>
          <div className="studio-row">
            <Button
              size="sm"
              variant={isFirstAlarm ? "primary" : "secondary"}
              aria-pressed={isFirstAlarm}
              onClick={() => set({ resources: { ...FIRST_ALARM } })}
            >
              First alarm
            </Button>
            <span className="studio-hint">3 engines, dozer, crew, chief; air attack, 2 airtankers, helicopter</span>
          </div>
          <Fieldset legend="Ground">
            <div className="studio-ff-grid">{GROUND_KINDS.map(countField)}</div>
          </Fieldset>
          <Fieldset legend="Air">
            <div className="studio-ff-grid">{AIR_KINDS.map(countField)}</div>
          </Fieldset>
          <Field label="T+0 local time" hint={`UTC offset ${clock.offset}; sets aircraft daylight`}>
            <input
              type="datetime-local"
              className="ui-input"
              value={clock.local}
              onChange={(event) => {
                if (event.target.value) set({ startLocalIso: `${event.target.value}${clock.offset}` });
              }}
            />
          </Field>
          <label className="studio-row studio-ff-toggle">
            <input
              type="checkbox"
              checked={settings.nightHelicopters === true}
              onChange={(event) => set({ nightHelicopters: event.target.checked })}
            />
            <span>Night-capable helicopters</span>
          </label>
          <Field
            label="Resources start work"
            hint={
              settings.fromStations !== false
                ? `Sent when the first fire is reported (its report time under Fires). ${(TURNOUT_MINUTES * 60).toFixed(0)} s turnout, then each vehicle class on the roads it can use. Falls back to ${settings.responseMinutes} min.`
                : "Counted from the first fire's start, or its report time when you set one."
            }
          >
            <select
              className="ui-input"
              value={
                settings.fromStations !== false ? "stations" : String(settings.responseMinutes)
              }
              onChange={(event) =>
                event.target.value === "stations"
                  ? set({ fromStations: true })
                  : set({ fromStations: false, responseMinutes: Number(event.target.value) })
              }
            >
              <option value="stations">Drive in from their bases</option>
              {RESPONSE_MINUTE_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min after the first fire ({formatElapsed(minutes)})
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      {result}
    </section>
  );
}
