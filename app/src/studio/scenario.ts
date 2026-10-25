/**
 * Pure scenario logic for Simulation Studio: defaults, validation, import parsing and the
 * conversion to solver input. No React, network or storage.
 */

import type { FireSettings, ScheduledFireInput } from "../fire/scheduledTypes";
import {
  DEFAULT_MIDFLAME_ADJUSTMENT,
  MOISTURE_PRESETS,
  type FuelMoisture,
  type GeoPoint,
} from "../fire/spread";
import { recordMatchesWind, type ScenarioWindRecord } from "../fire/scenarioWeather";
import { MAX_ROS_LOG_SIGMA } from "../fire/stochastic";
import { weatherSeriesProblems, type FireWeatherSample } from "../fire/weatherSeries";
import { spanProblem } from "./bounds";
import {
  DEFAULT_FIREFIGHTING,
  MAX_RESOURCES_PER_KIND,
  RESPONSE_MINUTE_CHOICES,
  hasHandSetCounts,
  type FirefightingSettings,
} from "./firefighting";
import { APPARATUS_KINDS } from "./apparatus";
import { MAX_HORIZON_MINUTES, MIN_HORIZON_MINUTES, isValidHorizonMinutes } from "../fire/horizon";
import {
  DISPLAY_STEP_MINUTES,
  MAX_ENABLED_IGNITIONS,
  MAX_WIND_SPEED_MPH,
  MIN_WIND_SPEED_MPH,
  studioDisplayStepMinutes,
  STUDIO_SCHEMA_VERSION,
  type ScenarioIssue,
  type ScheduledIgnition,
  type StudioScenario,
  type ValidateScenario,
} from "./contracts";

export const DEFAULT_HORIZON_MINUTES = 24 * 60;
export const DEFAULT_WIND_SPEED_MPH = 20;
export const DEFAULT_WIND_FROM_DEGREES = 45;
const MAX_MOISTURE_FRACTION = 3;
const MAX_SPOTTING_DISTANCE_METERS = 2000;
const MAX_STRUCTURE_RATE_METERS_PER_MINUTE = 1000;
const MAX_NAME_LENGTH = 80;

/**
 * Fuel moisture of a new scenario until a weather day loads (the Historical wind source, on by
 * default, replaces it with that date's hourly moisture from /api/conditions) and under Custom.
 * Scott & Burgan (2005) scenario D2L2 ("Dry", spread.ts MOISTURE_PRESETS). ASSUMPTION: which
 * standard scenario is the default is a choice, not a measurement; D1L1 "Critical — Red Flag"
 * is the extreme end and stays an explicit pick. With it the default 20 mph wind ran SH5 at
 * 75 m/min (7,300 ha in 6 h), Camp Fire growth on any day.
 */
export const DEFAULT_MOISTURE_PRESET_ID = "dry";
const DEFAULT_MOISTURE: FuelMoisture = (
  MOISTURE_PRESETS.find((preset) => preset.id === DEFAULT_MOISTURE_PRESET_ID) ?? MOISTURE_PRESETS[0]
).moisture;

export const MOISTURE_KEYS = ["dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"] as const;

function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function emptyScenario(): StudioScenario {
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: newId(),
    name: "Untitled scenario",
    ignitions: [],
    settings: {
      windSpeedMph: DEFAULT_WIND_SPEED_MPH,
      windFromDegrees: DEFAULT_WIND_FROM_DEGREES,
      moisture: { ...DEFAULT_MOISTURE },
      midflameAdjustment: DEFAULT_MIDFLAME_ADJUSTMENT,
      stepMinutes: DISPLAY_STEP_MINUTES,
      horizonMinutes: DEFAULT_HORIZON_MINUTES,
    },
  };
}

/**
 * The scenario with firefighting on (the Studio's default). Its units come from the facilities
 * on the map at run time (studio/mapResources.ts), not from the scenario.
 */
export function withFirefightingOn(scenario: StudioScenario): StudioScenario {
  const settings = scenario.firefighting ?? DEFAULT_FIREFIGHTING;
  return { ...scenario, firefighting: { ...settings, enabled: true } };
}

/** New ignition named with the lowest unused F-number and a stable unique id. */
export function createIgnition(
  existing: readonly ScheduledIgnition[],
  location: GeoPoint,
  startMinute = 0,
): ScheduledIgnition {
  const used = new Set(existing.map((ignition) => ignition.name));
  let number = 1;
  while (used.has(`F${number}`)) number += 1;
  return { id: newId(), name: `F${number}`, location, startMinute, enabled: true };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function validateSettings(settings: FireSettings): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  const add = (message: string) => issues.push({ field: "settings", message });
  if (
    !isFiniteNumber(settings.windSpeedMph) ||
    !inRange(settings.windSpeedMph, MIN_WIND_SPEED_MPH, MAX_WIND_SPEED_MPH)
  ) {
    add(`Wind speed must be between ${MIN_WIND_SPEED_MPH} and ${MAX_WIND_SPEED_MPH} mph.`);
  }
  if (!isFiniteNumber(settings.windFromDegrees) || !inRange(settings.windFromDegrees, 0, 360)) {
    add("Wind direction must be a bearing from 0 to 360 degrees.");
  }
  for (const key of MOISTURE_KEYS) {
    const value = settings.moisture?.[key];
    if (!isFiniteNumber(value) || !inRange(value, 0.01, MAX_MOISTURE_FRACTION)) {
      add(`Fuel moisture "${key}" must be a fraction between 0.01 and ${MAX_MOISTURE_FRACTION}.`);
    }
  }
  if (
    !isFiniteNumber(settings.midflameAdjustment) ||
    !inRange(settings.midflameAdjustment, 0.01, 1)
  ) {
    add("Midflame wind adjustment must be between 0.01 and 1.");
  }
  if (!isValidHorizonMinutes(settings.horizonMinutes)) {
    add(
      `How long to simulate must be a whole number of minutes from ${MIN_HORIZON_MINUTES / 60} h to ${MAX_HORIZON_MINUTES / 60 / 24} days.`,
    );
  }
  const { spotting, structureSpread } = settings;
  if (
    spotting &&
    (typeof spotting.enabled !== "boolean" ||
      !isFiniteNumber(spotting.maxDistanceMeters) ||
      !inRange(spotting.maxDistanceMeters, 0, MAX_SPOTTING_DISTANCE_METERS))
  ) {
    add(`Spotting distance must be between 0 and ${MAX_SPOTTING_DISTANCE_METERS} m.`);
  }
  if (
    structureSpread &&
    (typeof structureSpread.enabled !== "boolean" ||
      !isFiniteNumber(structureSpread.rateMetersPerMinute) ||
      !inRange(structureSpread.rateMetersPerMinute, 0, MAX_STRUCTURE_RATE_METERS_PER_MINUTE))
  ) {
    add(
      `Structure spread rate must be between 0 and ${MAX_STRUCTURE_RATE_METERS_PER_MINUTE} m/min.`,
    );
  }
  const { stochastic } = settings;
  if (stochastic) {
    if (typeof stochastic.enabled !== "boolean" || !isFiniteNumber(stochastic.seed)) {
      add("Stochastic spread needs enabled true or false and a finite seed.");
    }
    if (
      stochastic.rosSigma !== undefined &&
      (!isFiniteNumber(stochastic.rosSigma) || !inRange(stochastic.rosSigma, 0, MAX_ROS_LOG_SIGMA))
    ) {
      add(`Rate-of-spread variability (log sigma) must be between 0 and ${MAX_ROS_LOG_SIGMA}.`);
    }
  }
  const { weatherSeries, fireInducedWind } = settings;
  if (weatherSeries) {
    if (typeof weatherSeries.enabled !== "boolean") add("A weather series needs enabled true or false.");
    else if (weatherSeries.enabled) for (const problem of weatherSeriesProblems(weatherSeries)) add(problem);
  }
  if (fireInducedWind && typeof fireInducedWind.enabled !== "boolean") {
    add("Fire-induced wind needs enabled true or false.");
  }
  return issues;
}

const RESOURCE_KEYS = ["handCrews", "engines", "dozers"] as const;

function validateFirefighting(firefighting: FirefightingSettings): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  const add = (message: string) => issues.push({ field: "settings", message });
  if (typeof firefighting.enabled !== "boolean") add("Firefighting needs an enabled flag.");
  for (const key of RESOURCE_KEYS) {
    const value = firefighting[key];
    if (!Number.isInteger(value) || !inRange(value, 0, MAX_RESOURCES_PER_KIND)) {
      add(`Resource counts must be whole numbers from 0 to ${MAX_RESOURCES_PER_KIND}.`);
      break;
    }
  }
  if (firefighting.fromStations !== undefined && typeof firefighting.fromStations !== "boolean") {
    add("Firefighting fromStations must be true or false.");
  }
  if (firefighting.resources !== undefined) {
    const entries = Object.entries(firefighting.resources);
    if (
      entries.some(
        ([kind, count]) =>
          !(APPARATUS_KINDS as readonly string[]).includes(kind) ||
          !Number.isInteger(count) ||
          !inRange(count as number, 0, MAX_RESOURCES_PER_KIND),
      )
    ) {
      add(`Resource counts must be whole numbers from 0 to ${MAX_RESOURCES_PER_KIND}.`);
    }
  }
  if (
    firefighting.startLocalIso !== undefined &&
    !Number.isFinite(Date.parse(firefighting.startLocalIso))
  ) {
    add("The scenario clock must be an ISO 8601 date and time with a UTC offset.");
  }
  if (!(RESPONSE_MINUTE_CHOICES as readonly number[]).includes(firefighting.responseMinutes)) {
    add(`Response time must be one of ${RESPONSE_MINUTE_CHOICES.join(", ")} minutes.`);
  }
  return issues;
}

/** True when the ignition's coordinates are finite and on Earth. */
function locationIsValid(location: GeoPoint | undefined): boolean {
  return (
    !!location &&
    isFiniteNumber(location.latitude) &&
    isFiniteNumber(location.longitude) &&
    inRange(location.latitude, -90, 90) &&
    inRange(location.longitude, -180, 180)
  );
}

export const validateScenario: ValidateScenario = (scenario) => {
  const issues: ScenarioIssue[] = [];
  if (scenario.schemaVersion !== STUDIO_SCHEMA_VERSION) {
    issues.push({ message: `Unsupported scenario version ${String(scenario.schemaVersion)}.` });
  }
  issues.push(...validateSettings(scenario.settings));
  if (scenario.firefighting) issues.push(...validateFirefighting(scenario.firefighting));

  const horizon = scenario.settings.horizonMinutes;
  const seenIds = new Set<string>();
  let enabledCount = 0;
  let enabledLocationsOk = true;
  for (const ignition of scenario.ignitions) {
    const report = (field: ScenarioIssue["field"], message: string) =>
      issues.push({ ignitionId: ignition.id, field, message });
    if (typeof ignition.id !== "string" || ignition.id === "" || seenIds.has(ignition.id)) {
      report("ignitions", "This fire has a missing or duplicate id.");
    }
    seenIds.add(ignition.id);
    if (typeof ignition.name !== "string" || ignition.name.trim() === "") {
      report("name", "Give this fire a name.");
    }
    if (!locationIsValid(ignition.location)) {
      report("location", "Latitude must be -90 to 90 and longitude -180 to 180.");
      if (ignition.enabled) enabledLocationsOk = false;
    }
    if (!ignition.enabled) continue;
    enabledCount += 1;
    if (
      !Number.isInteger(ignition.startMinute) ||
      ignition.startMinute < 0 ||
      (Number.isFinite(horizon) && ignition.startMinute >= horizon)
    ) {
      report(
        "startMinute",
        `Start must be a whole number of minutes from 0 to ${Number.isFinite(horizon) ? horizon - 1 : "the horizon"}.`,
      );
    }
  }

  if (enabledCount < 1) {
    issues.push({ field: "ignitions", message: "Enable at least one fire." });
  } else if (enabledCount > MAX_ENABLED_IGNITIONS) {
    issues.push({
      field: "ignitions",
      message: `At most ${MAX_ENABLED_IGNITIONS} fires can be enabled; disable ${enabledCount - MAX_ENABLED_IGNITIONS} more.`,
    });
  } else if (enabledLocationsOk) {
    const span = spanProblem(scenario);
    if (span) issues.push({ field: "ignitions", message: span });
  }
  return issues;
};

/** Enabled ignitions only, in list order (order breaks exact solver ties). */
export function toSolverInput(scenario: StudioScenario): ScheduledFireInput {
  return {
    settings: scenario.settings,
    sources: scenario.ignitions
      .filter((ignition) => ignition.enabled)
      .map((ignition) => ({
        id: ignition.id,
        location: ignition.location,
        startMinute: ignition.startMinute,
      })),
    frameMinutes: frameMinutesFor(scenario),
  };
}

/**
 * T+0, every display step (`studioDisplayStepMinutes`: 5 min on short runs, wider on long ones so
 * a run keeps at most about 240 frames), every enabled ignition minute and the horizon: sorted,
 * unique.
 */
export function frameMinutesFor(scenario: StudioScenario): number[] {
  const horizon = scenario.settings.horizonMinutes;
  const step = studioDisplayStepMinutes(horizon);
  const minutes = new Set<number>([0, horizon]);
  for (let minute = step; minute < horizon; minute += step) {
    minutes.add(minute);
  }
  for (const ignition of scenario.ignitions) {
    if (ignition.enabled && ignition.startMinute >= 0 && ignition.startMinute <= horizon) {
      minutes.add(ignition.startMinute);
    }
  }
  return [...minutes].sort((a, b) => a - b);
}

/** True when the two scenarios give the solver the same input (names and ids aside). */
export function solverInputChanged(a: StudioScenario, b: StudioScenario): boolean {
  return JSON.stringify(solverFingerprint(a)) !== JSON.stringify(solverFingerprint(b));
}

function solverFingerprint(scenario: StudioScenario) {
  return {
    settings: scenario.settings,
    firefighting: scenario.firefighting?.enabled ? scenario.firefighting : null,
    ignitions: scenario.ignitions
      .filter((ignition) => ignition.enabled)
      .map((i) => [i.id, i.location.latitude, i.location.longitude, i.startMinute]),
  };
}

// ---------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseScenario(json: unknown): {
  scenario: StudioScenario | null;
  issues: ScenarioIssue[];
} {
  const issues: ScenarioIssue[] = [];
  const fail = (message: string, field?: ScenarioIssue["field"]) => issues.push({ message, field });

  if (!isRecord(json)) {
    return { scenario: null, issues: [{ message: "The file is not a scenario object." }] };
  }
  if (json.schemaVersion !== STUDIO_SCHEMA_VERSION) {
    return {
      scenario: null,
      issues: [
        {
          message: `Unsupported scenario version ${String(json.schemaVersion)}; this page reads version ${STUDIO_SCHEMA_VERSION}.`,
        },
      ],
    };
  }
  if (typeof json.id !== "string" || json.id === "") fail("Scenario id must be a string.");
  if (typeof json.name !== "string") fail("Scenario name must be a string.");

  const ignitions: ScheduledIgnition[] = [];
  if (!Array.isArray(json.ignitions)) {
    fail("Scenario needs an ignitions list.", "ignitions");
  } else {
    json.ignitions.forEach((raw: unknown, index: number) => {
      const label = `Ignition ${index + 1}`;
      if (!isRecord(raw)) return fail(`${label} is not an object.`, "ignitions");
      const location = raw.location;
      if (
        typeof raw.id !== "string" ||
        typeof raw.name !== "string" ||
        typeof raw.enabled !== "boolean" ||
        !isFiniteNumber(raw.startMinute) ||
        !isRecord(location) ||
        !isFiniteNumber(location.latitude) ||
        !isFiniteNumber(location.longitude)
      ) {
        return fail(
          `${label} needs a string id and name, a finite startMinute, a boolean enabled and a location with finite latitude and longitude.`,
          "ignitions",
        );
      }
      ignitions.push({
        id: raw.id,
        name: raw.name.slice(0, MAX_NAME_LENGTH),
        location: { latitude: location.latitude, longitude: location.longitude },
        startMinute: raw.startMinute,
        enabled: raw.enabled,
      });
    });
  }

  const settings = parseSettings(json.settings, fail);
  let firefighting: FirefightingSettings | undefined;
  if (json.firefighting !== undefined) {
    const raw = json.firefighting;
    if (
      !isRecord(raw) ||
      typeof raw.enabled !== "boolean" ||
      ![...RESOURCE_KEYS, "responseMinutes"].every((key) => isFiniteNumber(raw[key]))
    ) {
      fail(
        "Firefighting needs an enabled flag and numeric resource counts and response time.",
        "settings",
      );
    } else {
      // Units come from the facilities on the map: hand-set counts (and the old "start after N
      // min" and night-helicopter choices) from older drafts and files are dropped, and the
      // panel says so once (`countsDropped`).
      const dropped =
        raw.countsDropped === true ||
        hasHandSetCounts({
          handCrews: Number(raw.handCrews),
          engines: Number(raw.engines),
          dozers: Number(raw.dozers),
          resources: isRecord(raw.resources) ? (raw.resources as FirefightingSettings["resources"]) : undefined,
        });
      firefighting = {
        enabled: raw.enabled,
        handCrews: 0,
        engines: 0,
        dozers: 0,
        responseMinutes: raw.responseMinutes as number,
        fromStations: true,
        ...(typeof raw.startLocalIso === "string" ? { startLocalIso: raw.startLocalIso } : {}),
        ...(dropped ? { countsDropped: true } : {}),
      };
    }
  }
  // Weather provenance is kept only while the wind in settings still equals what it applied.
  const weather = settings ? parseWeather(json.weather, settings) : undefined;
  if (issues.length > 0 || !settings) {
    return { scenario: null, issues };
  }
  return {
    scenario: {
      schemaVersion: STUDIO_SCHEMA_VERSION,
      id: json.id as string,
      name: (json.name as string).slice(0, MAX_NAME_LENGTH),
      ignitions,
      settings,
      ...(firefighting ? { firefighting } : {}),
      ...(weather ? { weather } : {}),
    },
    issues,
  };
}

function parseWeather(raw: unknown, settings: FireSettings): ScenarioWindRecord | undefined {
  if (!isRecord(raw) || !isRecord(raw.applied) || !Array.isArray(raw.series)) return undefined;
  const { applied } = raw;
  if (!isFiniteNumber(applied.speed20ftMph) || !isFiniteNumber(applied.fromDeg)) return undefined;
  if (typeof raw.mode !== "string" || typeof raw.evidenceClass !== "string") return undefined;
  const record = raw as unknown as ScenarioWindRecord;
  return recordMatchesWind(record, settings.windSpeedMph, settings.windFromDegrees)
    ? record
    : undefined;
}

function parseSettings(
  raw: unknown,
  fail: (message: string, field?: ScenarioIssue["field"]) => void,
): FireSettings | null {
  if (!isRecord(raw)) {
    fail("Scenario needs a settings object.", "settings");
    return null;
  }
  const numeric = (key: string): number | null => {
    const value = raw[key];
    if (isFiniteNumber(value)) return value;
    fail(`Setting "${key}" must be a finite number.`, "settings");
    return null;
  };
  const windSpeedMph = numeric("windSpeedMph");
  const windFromDegrees = numeric("windFromDegrees");
  const midflameAdjustment = numeric("midflameAdjustment");
  const horizonMinutes = numeric("horizonMinutes");
  // stepMinutes is ignored by the studio; tolerate its absence.
  const stepMinutes = isFiniteNumber(raw.stepMinutes) ? raw.stepMinutes : DISPLAY_STEP_MINUTES;

  const moistureRaw = raw.moisture;
  let moisture: FuelMoisture | null = null;
  if (!isRecord(moistureRaw)) {
    fail("Settings need a moisture object.", "settings");
  } else {
    const values = MOISTURE_KEYS.map((key) => moistureRaw[key]);
    if (values.every(isFiniteNumber)) {
      const [dead1h, dead10h, dead100h, liveHerb, liveWoody] = values as number[];
      moisture = { dead1h, dead10h, dead100h, liveHerb, liveWoody };
    } else {
      fail(`Moisture needs finite ${MOISTURE_KEYS.join(", ")} values.`, "settings");
    }
  }

  const settings: FireSettings | null =
    windSpeedMph === null ||
    windFromDegrees === null ||
    midflameAdjustment === null ||
    horizonMinutes === null ||
    moisture === null
      ? null
      : {
          windSpeedMph,
          windFromDegrees,
          moisture,
          midflameAdjustment,
          stepMinutes,
          horizonMinutes,
        };
  if (!settings) return null;

  if (raw.spotting !== undefined) {
    const s = raw.spotting;
    if (!isRecord(s) || typeof s.enabled !== "boolean" || !isFiniteNumber(s.maxDistanceMeters)) {
      fail("Spotting must be { enabled, maxDistanceMeters } with a finite distance.", "settings");
    } else {
      settings.spotting = { enabled: s.enabled, maxDistanceMeters: s.maxDistanceMeters };
    }
  }
  if (raw.structureSpread !== undefined) {
    const s = raw.structureSpread;
    if (!isRecord(s) || typeof s.enabled !== "boolean" || !isFiniteNumber(s.rateMetersPerMinute)) {
      fail(
        "Structure spread must be { enabled, rateMetersPerMinute } with a finite rate.",
        "settings",
      );
    } else {
      settings.structureSpread = { enabled: s.enabled, rateMetersPerMinute: s.rateMetersPerMinute };
    }
  }
  if (raw.stochastic !== undefined) {
    // Seeded stochastic spread (fire/stochastic.ts). Optional numbers are kept only when
    // finite; anything else falls back to the solver's documented defaults.
    const s = raw.stochastic;
    if (!isRecord(s) || typeof s.enabled !== "boolean" || !isFiniteNumber(s.seed)) {
      fail("Stochastic spread must be { enabled, seed, ... } with a finite seed.", "settings");
    } else {
      const optionalNumber = (value: unknown) => (isFiniteNumber(value) ? value : undefined);
      const optionalBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);
      settings.stochastic = {
        enabled: s.enabled,
        seed: s.seed,
        rosSigma: optionalNumber(s.rosSigma),
        rosCorrelationMeters: optionalNumber(s.rosCorrelationMeters),
        spotting: optionalBoolean(s.spotting),
        windWander: optionalBoolean(s.windWander),
        gustFactor: optionalNumber(s.gustFactor) ?? null,
        airTemperatureF: optionalNumber(s.airTemperatureF),
      };
    }
  }
  if (raw.weatherSeries !== undefined) {
    // Time-varying weather (fire/weatherSeries.ts); the numbers are checked by validation.
    const s = raw.weatherSeries;
    if (!isRecord(s) || typeof s.enabled !== "boolean" || !Array.isArray(s.samples)) {
      fail("A weather series must be { enabled, samples: [...] }.", "settings");
    } else {
      const samples: FireWeatherSample[] = [];
      let bad = false;
      for (const item of s.samples) {
        if (!isRecord(item) || !isFiniteNumber(item.minute) || !isFiniteNumber(item.windSpeedMph) || !isFiniteNumber(item.windFromDegrees)) {
          bad = true;
          break;
        }
        const sample: FireWeatherSample = {
          minute: item.minute,
          windSpeedMph: item.windSpeedMph,
          windFromDegrees: item.windFromDegrees,
        };
        if (isRecord(item.moisture)) {
          const m = item.moisture;
          if (!MOISTURE_KEYS.every((key) => isFiniteNumber(m[key]))) {
            bad = true;
            break;
          }
          sample.moisture = Object.fromEntries(MOISTURE_KEYS.map((key) => [key, m[key]])) as unknown as FuelMoisture;
        }
        if (isFiniteNumber(item.airTemperatureF)) sample.airTemperatureF = item.airTemperatureF;
        samples.push(sample);
      }
      if (bad) fail("Every weather sample needs a finite minute, windSpeedMph and windFromDegrees.", "settings");
      else {
        settings.weatherSeries = {
          enabled: s.enabled,
          samples,
          ...(typeof s.source === "string" ? { source: s.source } : {}),
          ...(s.evidence === "observed" || s.evidence === "forecast" || s.evidence === "derived" || s.evidence === "assumed"
            ? { evidence: s.evidence }
            : {}),
        };
      }
    }
  }
  if (raw.fireInducedWind !== undefined) {
    const s = raw.fireInducedWind;
    if (!isRecord(s) || typeof s.enabled !== "boolean") {
      fail("Fire-induced wind must be { enabled, seed? }.", "settings");
    } else {
      settings.fireInducedWind = { enabled: s.enabled, ...(isFiniteNumber(s.seed) ? { seed: s.seed } : {}) };
    }
  }
  return settings;
}
