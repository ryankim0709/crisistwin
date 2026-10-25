/**
 * Firefighting in the Studio config panel (and /dispatch, which reuses it): one on/off switch and
 * one plain line of what the map can send. The units are not an input: they are a pure function
 * of the fire stations, camps and air bases on and near the board (studio/mapResources.ts,
 * response/fleet.ts), drawn on the map too. Everything else (stations, counts per type and their
 * rates, units per facility, the T+0 clock that sets aircraft daylight) sits in a collapsed
 * "Details". See docs/response-model.md, "Resources come from the map".
 */

import type { ReactNode } from "react";
import { Field, LoadingState, Notice } from "../ui";
import type { StudioScenario } from "./contracts";
import { DEFAULT_FIREFIGHTING, DEFAULT_START_LOCAL_ISO, type FirefightingSettings } from "./firefighting";
import { FACILITY_INVENTORY, unitsText, type ResponseKind } from "../response/fleet";
import { GROUND_APPARATUS, apparatusLabel, grassRateMetersPerHour, isAirKind, type ApparatusKind } from "./apparatus";
import { AIRCRAFT } from "./aircraft";
import type { MapResources } from "./mapResources";

export interface FirefightingFieldsProps {
  scenario: StudioScenario;
  onScenarioChange: (scenario: StudioScenario) => void;
  idPrefix: string;
  /** Units from the facilities on the map, or null while the board or the facilities load. */
  resources?: MapResources | null;
  /** Result of the last run, shown under the inputs. */
  result?: ReactNode;
}

/** "2026-08-15T13:00-07:00" -> the datetime-local part and the offset. */
function splitIso(iso: string): { local: string; offset: string } {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  return match ? { local: match[1], offset: match[2] } : splitIso(DEFAULT_START_LOCAL_ISO);
}

/** Line rate and holding limit (ground) or load and speed (air), from studio/apparatus.ts and aircraft.ts. */
function rateOf(kind: ApparatusKind): string {
  if (isAirKind(kind)) {
    const spec = AIRCRAFT[kind];
    return spec.gallons > 0 ? `${spec.gallons} gal, ${spec.cruiseKnots} kt` : `${spec.cruiseKnots} kt`;
  }
  const spec = GROUND_APPARATUS[kind];
  return spec.line
    ? `${Math.round(grassRateMetersPerHour(kind))} m/h of line in grass, holds ≤ ${spec.holdsFlameLengthFeet} ft flames`
    : "builds no line";
}

function Details({ resources }: { resources: MapResources }) {
  const { fleet, summary } = resources;
  const counts = new Map<ResponseKind, number>();
  for (const u of [...fleet.units, ...fleet.aircraft]) counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
  const order = (f: MapResources["fleet"]["facilities"][number]) =>
    f.facility === "air_attack_base" || f.facility === "helitack_base" ? 2 : f.tier === "closest" ? 0 : 1;
  const facilities = [...fleet.facilities].sort((a, b) => order(a) - order(b) || (a.km ?? 0) - (b.km ?? 0));
  return (
    <>
      <p className="studio-hint">{summary.local}.</p>
      <p className="studio-hint">{summary.mutualAid}</p>
      {counts.size > 0 && (
        <ul className="studio-ff-list">
          {[...counts].map(([kind, n]) => (
            <li key={kind}>
              {n} × {apparatusLabel(kind)} <span className="studio-hint">{rateOf(kind)}</span>
            </li>
          ))}
        </ul>
      )}
      {facilities.length > 0 && (
        <ul className="studio-ff-list">
          {facilities.map((f) => (
            <li key={f.id}>
              {f.label}
              {f.tier === "mutual_aid" ? <span className="studio-hint"> · outside the area</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="studio-hint">{resources.sourceLabel}</p>
      <ul className="studio-ff-list">
        {Object.values(FACILITY_INVENTORY).map((row) => (
          <li key={row.covers}>
            {row.covers}: {unitsText(row.units)}. <span className="studio-hint">{row.evidence}.</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function FirefightingFields({
  scenario,
  onScenarioChange,
  idPrefix,
  resources = null,
  result,
}: FirefightingFieldsProps) {
  const settings = scenario.firefighting ?? DEFAULT_FIREFIGHTING;
  // Any edit here acknowledges that hand-set counts were dropped.
  const set = (patch: Partial<FirefightingSettings>) =>
    onScenarioChange({ ...scenario, firefighting: { ...settings, countsDropped: undefined, ...patch } });
  const clock = splitIso(settings.startLocalIso ?? DEFAULT_START_LOCAL_ISO);

  return (
    <section className="studio-section" aria-labelledby={`${idPrefix}-ff`}>
      <h3 id={`${idPrefix}-ff`} className="studio-subtitle">
        Firefighters
      </h3>
      <label className="studio-row studio-ff-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => set({ enabled: event.target.checked })}
        />
        <span>Firefighting</span>
      </label>
      {settings.enabled && (
        <>
          {settings.countsDropped && (
            <Notice tone="info" compact>
              Units now come from the stations on the map.
            </Notice>
          )}
          {resources ? (
            <p className="studio-ff-fleet" aria-live="polite">
              {resources.summary.short}
            </p>
          ) : (
            <LoadingState>Loading the stations on the map…</LoadingState>
          )}
          <details className="studio-advanced">
            <summary>Details</summary>
            {resources && <Details resources={resources} />}
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
          </details>
        </>
      )}
      {result}
    </section>
  );
}
