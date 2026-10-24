/**
 * Firefighting inputs in the Studio config panel: whether crews respond, how many of each
 * resource, and how long after the first ignition they start building line. These are user
 * assumptions; the plan itself is chosen by `planFirefighting` (studio/firefighting.ts).
 */

import type { ReactNode } from "react";
import { formatElapsed } from "../fire/spread";
import { Field } from "../ui";
import type { StudioScenario } from "./contracts";
import {
  DEFAULT_FIREFIGHTING,
  MAX_RESOURCES_PER_KIND,
  RESOURCE_TYPES,
  RESPONSE_MINUTE_CHOICES,
  type FirefightingSettings,
  type ResourceKind,
} from "./firefighting";

const FIELD_FOR: Record<ResourceKind, "handCrews" | "engines" | "dozers"> = {
  hand_crew: "handCrews",
  engine: "engines",
  dozer: "dozers",
};

export interface FirefightingFieldsProps {
  scenario: StudioScenario;
  onScenarioChange: (scenario: StudioScenario) => void;
  idPrefix: string;
  /** Result of the last run, shown under the inputs. */
  result?: ReactNode;
}

export default function FirefightingFields({
  scenario,
  onScenarioChange,
  idPrefix,
  result,
}: FirefightingFieldsProps) {
  const settings = scenario.firefighting ?? DEFAULT_FIREFIGHTING;
  const set = (patch: Partial<FirefightingSettings>) =>
    onScenarioChange({ ...scenario, firefighting: { ...settings, ...patch } });

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
        <span>Send crews to build control line</span>
      </label>
      {settings.enabled && (
        <>
          <div className="studio-ff-grid">
            {(Object.keys(RESOURCE_TYPES) as ResourceKind[]).map((kind) => {
              const key = FIELD_FOR[kind];
              const type = RESOURCE_TYPES[kind];
              return (
                <Field
                  key={kind}
                  label={type.label}
                  hint={`${type.metersPerHourInGrass} m/h in grass · holds ≤ ${type.holdsFlameLengthFeet} ft flames`}
                >
                  <input
                    type="number"
                    className="ui-input studio-input-number"
                    min={0}
                    max={MAX_RESOURCES_PER_KIND}
                    step={1}
                    value={settings[key]}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) return;
                      set({
                        [key]: Math.max(0, Math.min(MAX_RESOURCES_PER_KIND, Math.round(value))),
                      });
                    }}
                  />
                </Field>
              );
            })}
          </div>
          <Field label="Crews start work">
            <select
              className="ui-input"
              value={settings.responseMinutes}
              onChange={(event) => set({ responseMinutes: Number(event.target.value) })}
            >
              {RESPONSE_MINUTE_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min after the first fire ({formatElapsed(minutes)})
                </option>
              ))}
            </select>
          </Field>
          <p className="studio-hint">
            The run tries anchoring at the heel or the head of the fire and building around its
            outline at several distances, and keeps the plan that leaves the least burned area.
            Production rates are assumed; lines hold flames up to the Hauling-chart limit of the
            crew that built them, and crown fire breaks any line.
          </p>
        </>
      )}
      {result}
    </section>
  );
}
