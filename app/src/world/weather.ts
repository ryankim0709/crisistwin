// The shared world's weather choice (docs/shared-world.md `conditions`) and the pages' scenario
// weather records (fire/scenarioWeather.ts), in both directions. Pure except `fetchWorldWind`.
import { fetchScenarioWind, type ScenarioWindRecord } from "../fire/scenarioWeather";
import type { World, WorldWeather } from "./contracts";

/** `conditions.startUtc` + `weather` as a tab states them. */
export interface WorldWeatherChoice {
  startUtc?: string;
  weather: WorldWeather;
}

/** ISO-8601 UTC normalised as the server stores it ("YYYY-MM-DDTHH:MM:SSZ"); the input when unparsable. */
export function normalUtc(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : iso;
}

/** The world weather a fetched record stands for. */
export function choiceOfRecord(record: ScenarioWindRecord): WorldWeatherChoice {
  return {
    startUtc: normalUtc(record.query.startUtc),
    weather:
      record.mode === "climatology_percentile"
        ? { mode: record.mode, percentile: record.query.percentile ?? 95 }
        : { mode: record.mode },
  };
}

/** An assumed constant wind. */
export function assumedChoice(windSpeedMph: number, windFromDegrees: number): WorldWeatherChoice {
  return {
    weather: {
      mode: "assumed",
      windSpeedMph: Math.max(0, Math.min(150, windSpeedMph)),
      windFromDegrees: ((windFromDegrees % 360) + 360) % 360,
    },
  };
}

/**
 * A record fetched because the world asked for it keeps standing for exactly that request (the
 * server may relabel the start), so the tab never writes a near-copy back.
 */
export interface PinnedRecord {
  record: ScenarioWindRecord;
  choice: WorldWeatherChoice;
}

export function choiceOf(record: ScenarioWindRecord, pinned: PinnedRecord | null): WorldWeatherChoice {
  return pinned && pinned.record === record ? pinned.choice : choiceOfRecord(record);
}

/** The world's weather as a choice. */
export function worldChoice(world: World): WorldWeatherChoice {
  return { startUtc: world.conditions.startUtc, weather: world.conditions.weather };
}

/** True when the record already is the world's weather (same mode, start and percentile). */
export function recordMatchesWorld(record: ScenarioWindRecord | null, world: World, pinned: PinnedRecord | null): boolean {
  if (!record) return false;
  const have = choiceOf(record, pinned);
  const want = world.conditions;
  if (have.weather.mode !== want.weather.mode) return false;
  if (want.weather.mode === "forecast") return true;
  if (want.weather.mode === "climatology_percentile" && have.weather.percentile !== want.weather.percentile) return false;
  return normalUtc(have.startUtc ?? "") === normalUtc(want.startUtc);
}

/** Fetch the scenario weather a choice names, at a point; null for assumed weather. */
export async function fetchWorldWind(
  choice: WorldWeatherChoice,
  lon: number,
  lat: number,
  hours: number,
  signal?: AbortSignal,
): Promise<PinnedRecord | null> {
  const { weather } = choice;
  const startUtc = choice.startUtc ?? new Date().toISOString();
  if (weather.mode === "assumed") return null;
  const record = await fetchScenarioWind(
    {
      mode: weather.mode,
      lon,
      lat,
      hours: Math.max(1, Math.min(72, Math.ceil(hours))),
      ...(weather.mode === "forecast" ? {} : { startUtc: normalUtc(startUtc) }),
      ...(weather.mode === "climatology_percentile" ? { percentile: weather.percentile ?? 95 } : {}),
    },
    signal,
  );
  return { record, choice };
}
