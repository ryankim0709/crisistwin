/**
 * One incident per ignition for the Studio's firefighting run (used by /simulation and
 * /dispatch). Each fire reaches the dispatch centre after its own call-in delay
 * (response/report.ts via firefighting.ignitionReportDelayMinutes), gets its own run card for the
 * weather when it is reported (response/runCards.ts via studio/mapResources.ts), and is filled by
 * the closest units still available, in report order: a unit or aircraft committed to an earlier
 * incident is not sent again (closest-resource concept, Cal OES Operations Bulletin #1), so
 * stations are drawn down. Each incident's ground units are routed to its own fire
 * (studio/crewDispatch.ts). Pure.
 *
 * Not modelled (ASSUMPTIONS, labelled in the UI notes): a committed unit stays committed for the
 * whole run (Studio has no minute loop to release it at containment and send it on; /live does),
 * no move-up or cover of drawn-down stations, and no extended-attack orders (escalation needs the
 * board's minute loop, demo/boardResponse.ts).
 */

import type { DispatchArea, LonLat } from "../dispatch/area";
import type { LandscapeGrid } from "../fire/landscape";
import type { FireSettings } from "../fire/scheduledTypes";
import { seriesActive, weatherAtMinute } from "../fire/weatherSeries";
import type { FuelMoisture } from "../fire/rothermel";
import { GROUND_APPARATUS, type ApparatusCounts } from "./apparatus";
import type { AirBase } from "./aircraft";
import {
  helitackPlan,
  planCrewDispatch,
  type CrewDispatch,
  type CrewTrip,
  type IncidentDispatch,
  type NoAccess,
} from "./crewDispatch";
import { ignitionReportMinute, startMsOf, type FirefightingSettings } from "./firefighting";
import { planMapDispatch, type DispatchWeather, type MapResources } from "./mapResources";
import type { SuppressionBases } from "./suppressionBases";

/**
 * ASSUMPTION: the dispatcher sizes the card on the worst of the hour after the report (the
 * highest wind and the lowest 1-h moisture in the weather series over it), the series standing in
 * for the spot forecast a dispatcher reads. No source ties the window length to dispatch.
 */
export const DISPATCH_FORECAST_MINUTES = 60;
/** Sampling of the forecast window, minutes (the solver's weather step). */
const FORECAST_SAMPLE_MINUTES = 10;

export interface IncidentIgnition {
  id: string;
  name: string;
  location: { longitude: number; latitude: number };
  startMinute: number;
  /** User-set report minute (studio/contracts.ts `ScheduledIgnition.reportMinute`); absent/null = modelled. */
  reportMinute?: number | null;
}

export interface IncidentPlanInputs {
  resources: MapResources;
  area: DispatchArea;
  /** Enabled ignitions (any order). */
  ignitions: readonly IncidentIgnition[];
  /** The scenario's fire settings: base wind, moisture, optional weather series, horizon. */
  settings: FireSettings;
  firefighting: FirefightingSettings;
  grid: LandscapeGrid | null;
  blocked: (edge: number) => boolean;
  bases: SuppressionBases | null;
}

export interface IncidentPlan {
  /** Every incident's ground trips; null when no incident sent a ground unit. */
  dispatch: CrewDispatch | null;
  note: string | null;
  airBases: AirBase[];
  /** Units sent, summed over the incidents (FirefightingSettings.resources). */
  resources: ApparatusCounts;
  incidents: IncidentDispatch[];
}

/** Weather the dispatcher sizes the card on: the worst of the next hour after `reportMinute`. */
export function dispatchWeatherAt(settings: FireSettings, reportMinute: number): DispatchWeather {
  const series = seriesActive(settings.weatherSeries) ? settings.weatherSeries : null;
  if (!series) return { windSpeedMph: settings.windSpeedMph, moisture: settings.moisture };
  let windSpeedMph = 0;
  let moisture: FuelMoisture = settings.moisture;
  let driest = Infinity;
  for (let m = reportMinute; m <= reportMinute + DISPATCH_FORECAST_MINUTES; m += FORECAST_SAMPLE_MINUTES) {
    const step = weatherAtMinute(series, m);
    windSpeedMph = Math.max(windSpeedMph, step.windSpeedMph);
    const here = step.moisture ?? settings.moisture;
    if (here.dead1h < driest) {
      driest = here.dead1h;
      moisture = here;
    }
  }
  return {
    windSpeedMph,
    moisture,
    label: `worst of the hour after the report at T+${Math.round(reportMinute)}`,
  };
}

/** Plan every incident, in report order, drawing down the map's units. */
export function planIncidents(inputs: IncidentPlanInputs): IncidentPlan {
  const { resources, area, settings, firefighting, grid, blocked, bases } = inputs;
  const startMs = startMsOf(firefighting);
  const horizon = settings.horizonMinutes;
  const reported = inputs.ignitions
    .map((ignition) => {
      const report = ignitionReportMinute(grid, ignition, firefighting);
      return { ignition, reportMinute: report.minute, reportSource: report.source };
    })
    .sort((a, b) => a.reportMinute - b.reportMinute || a.ignition.id.localeCompare(b.ignition.id));

  const committedUnits = new Set<string>();
  const committedAircraft = new Set<string>();
  const usedHelitack = new Set<string>();
  const counters: Record<string, number> = {};
  const relabel = (kind: CrewTrip["kind"]) => {
    counters[kind] = (counters[kind] ?? 0) + 1;
    return `${GROUND_APPARATUS[kind].short} ${counters[kind]}`;
  };
  const resourcesSent: ApparatusCounts = {};
  const airBases: AirBase[] = [];
  const incidents: IncidentDispatch[] = [];
  const trips: CrewTrip[] = [];
  const noAccess: NoAccess[] = [];
  const notes: string[] = [];
  let lead: CrewDispatch | null = null;

  for (const { ignition, reportMinute, reportSource } of reported) {
    const fire: LonLat = [ignition.location.longitude, ignition.location.latitude];
    const weather = dispatchWeatherAt(settings, reportMinute);
    const plan = planMapDispatch(resources, area, fire, weather, grid, {
      units: committedUnits,
      aircraft: committedAircraft,
    });
    for (const key of plan.unitKeys) committedUnits.add(key);
    for (const key of plan.aircraftKeys) committedAircraft.add(key);
    for (const [kind, n] of Object.entries(plan.counts)) {
      resourcesSent[kind as keyof ApparatusCounts] = (resourcesSent[kind as keyof ApparatusCounts] ?? 0) + (n ?? 0);
    }
    for (const base of plan.airBases) if (!airBases.some((b) => b.id === base.id)) airBases.push(base);

    const { dispatch, note } =
      plan.units.length > 0
        ? planCrewDispatch(area, fire, reportMinute, plan.units, blocked, grid, bases)
        : { dispatch: null, note: null };
    const helitack = helitackPlan(bases, fire, reportMinute, { startMs, horizonMinutes: horizon }, usedHelitack);
    if (helitack?.baseId) usedHelitack.add(helitack.baseId);
    const mine = (dispatch?.trips ?? []).map((trip) => ({ ...trip, label: relabel(trip.kind), sourceId: ignition.id }));
    const blockedUnits = (dispatch?.noAccess ?? []).map((entry) => ({ ...entry, label: relabel(entry.kind) }));
    trips.push(...mine);
    noAccess.push(...blockedUnits);
    notes.push(`${ignition.name}: ${plan.text}`);
    for (const n of dispatch?.notes ?? []) if (!notes.includes(n)) notes.push(n);
    if (dispatch && !lead) lead = { ...dispatch, helitack };
    incidents.push({
      sourceId: ignition.id,
      name: ignition.name,
      fire,
      ignitionMinute: ignition.startMinute,
      reportMinute,
      reportSource,
      level: plan.level,
      structure: plan.structure,
      text: plan.text,
      tripLabels: mine.map((t) => t.label),
      aircraft: plan.aircraft.map((a) => ({ kind: a.kind, baseId: a.baseId, baseName: a.baseName, location: a.location })),
      helitack,
      noAccess: blockedUnits,
      note: plan.units.length === 0 ? "No ground unit on the card could be filled." : note,
    });
  }
  if (reported.length > 1) {
    notes.push(
      "One incident per fire, dispatched at its own report minute from the units still available; committed units stay committed for the run (no release, move-up or cover modelled).",
    );
  }

  const dispatch: CrewDispatch | null = lead
    ? {
        ...lead,
        // The first-reported incident's report minute, fire and road point; every incident's trips.
        reportMinute: incidents[0].reportMinute,
        reportSource: incidents[0].reportSource,
        reportedFire: incidents[0].name,
        trips,
        noAccess,
        notes,
        incidents,
      }
    : null;
  const anyGround = incidents.some((i) => i.tripLabels.length > 0);
  return {
    dispatch,
    note: anyGround
      ? null
      : incidents.map((i) => `${i.name}: ${i.note ?? i.text}`).join(" "),
    airBases,
    resources: resourcesSent,
    incidents,
  };
}
