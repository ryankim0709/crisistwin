/**
 * Scenario weather client: `GET /api/weather/scenario` (app/backend/api/scenario_weather.py,
 * sim/weather.py, docs/scenario-weather.md).
 *
 * Units at this boundary: times UTC ISO 8601 `Z`; `speedMs` m/s as the station reported it;
 * `speed20ftMph` miles per hour after the server's 10 m to 20 ft height conversion; `fromDeg`
 * degrees true, the bearing the wind blows FROM (same contract as `FireScenario`).
 *
 * The fire solver takes ONE wind for the whole run (precomputed spread rates, see
 * docs/fire-simulator.md), so a series is reduced to its peak hour, and the record keeps the
 * whole series plus that choice so nothing is hidden.
 */

export type WindSourceMode = "assumed" | "historical" | "worst_case" | "forecast";
export type ApiWeatherMode = "historical_replay" | "climatology_percentile" | "forecast";
export type WeatherEvidenceClass = "observed" | "forecast" | "derived";

export interface WindSample {
  tUtc: string;
  /** m/s as reported (10 m ASOS/gridpoint, 20 ft RAWS). */
  speedMs: number | null;
  /** Open 20 ft wind, mph, after the height conversion. */
  speed20ftMph: number | null;
  fromDeg: number | null;
  gustMs: number | null;
}

export interface WindStation {
  id: string;
  name: string;
  distanceKm: number;
}

/** JSON-safe record of the weather a scenario's wind came from. Stored in the scenario. */
export interface ScenarioWindRecord {
  mode: ApiWeatherMode;
  evidenceClass: WeatherEvidenceClass;
  /** Query that produced it. */
  query: { lon: number; lat: number; startUtc: string; hours: number; percentile?: number };
  station: WindStation | null;
  /** NWS gridpoint, climatology analog, ... as the API names it. */
  source: string;
  /** Climatology only: the real episode replayed, from `provenance.analog`. */
  analog: unknown | null;
  heightConversion: { fromHeight: string; factor: number; method: string };
  /** The hourly series returned (hours + 1 samples). */
  series: WindSample[];
  /** What the run used: the series reduced to one value. */
  applied: {
    basis: "peak hour of the run window";
    tUtc: string;
    speed20ftMph: number;
    fromDeg: number;
    /** Set when the slider cap cut the value. */
    clampedFromMph: number | null;
  };
  rawSha256: string | null;
}

export const MAX_APPLIED_WIND_MPH = 60;

interface ApiSample {
  t_utc: string;
  speed_ms: number | null;
  speed_20ft_mph: number | null;
  from_deg: number | null;
  gust_ms: number | null;
}

interface ApiResponse {
  mode: ApiWeatherMode;
  evidence_class: WeatherEvidenceClass;
  lon: number;
  lat: number;
  start_utc: string;
  hours: number;
  source: string;
  station: { id: string; name: string; distance_km: number } | null;
  samples: ApiSample[];
  height_conversion: { from_height: string; factor: number; method: string };
  provenance: { analog?: unknown; raw?: { sha256?: string } };
}

export interface ScenarioWeatherQuery {
  mode: ApiWeatherMode;
  lon: number;
  lat: number;
  /** ISO UTC with Z. Omit for `forecast` (the server uses the current UTC hour). */
  startUtc?: string;
  hours: number;
  percentile?: number;
}

/** Fetches and reduces a series to the one wind the solver can take. Throws a readable Error. */
export async function fetchScenarioWind(
  query: ScenarioWeatherQuery,
  signal?: AbortSignal,
): Promise<ScenarioWindRecord> {
  const params = new URLSearchParams({
    lon: String(query.lon),
    lat: String(query.lat),
    hours: String(query.hours),
    mode: query.mode,
  });
  if (query.startUtc) params.set("start", query.startUtc);
  if (query.percentile !== undefined) params.set("percentile", String(query.percentile));
  let response: Response;
  try {
    response = await fetch(`/api/weather/scenario?${params}`, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error("The weather service could not be reached.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = (body as { detail?: string } | null)?.detail;
    throw new Error(detail ?? `Weather service returned HTTP ${response.status}.`);
  }
  return toRecord(body as ApiResponse, query);
}

function toRecord(data: ApiResponse, query: ScenarioWeatherQuery): ScenarioWindRecord {
  const series: WindSample[] = data.samples.map((s) => ({
    tUtc: s.t_utc,
    speedMs: s.speed_ms,
    speed20ftMph: s.speed_20ft_mph,
    fromDeg: s.from_deg,
    gustMs: s.gust_ms,
  }));
  let peak: WindSample | null = null;
  for (const s of series) {
    if (s.speed20ftMph === null || s.fromDeg === null) continue;
    if (peak === null || s.speed20ftMph > (peak.speed20ftMph ?? 0)) peak = s;
  }
  if (peak === null || peak.speed20ftMph === null || peak.fromDeg === null) {
    throw new Error("The series has no hour with both wind speed and direction.");
  }
  const rounded = Math.round(peak.speed20ftMph * 10) / 10;
  const applied = Math.min(rounded, MAX_APPLIED_WIND_MPH);
  return {
    mode: data.mode,
    evidenceClass: data.evidence_class,
    query: {
      lon: data.lon,
      lat: data.lat,
      startUtc: data.start_utc,
      hours: data.hours,
      ...(query.percentile !== undefined ? { percentile: query.percentile } : {}),
    },
    station: data.station
      ? { id: data.station.id, name: data.station.name, distanceKm: data.station.distance_km }
      : null,
    source: data.source,
    analog: data.provenance?.analog ?? null,
    heightConversion: {
      fromHeight: data.height_conversion.from_height,
      factor: data.height_conversion.factor,
      method: data.height_conversion.method,
    },
    series,
    applied: {
      basis: "peak hour of the run window",
      tUtc: peak.tUtc,
      speed20ftMph: applied,
      fromDeg: Math.round(((peak.fromDeg % 360) + 360) % 360),
      clampedFromMph: applied === rounded ? null : rounded,
    },
    rawSha256: data.provenance?.raw?.sha256 ?? null,
  };
}

const EVIDENCE_WORD: Record<WeatherEvidenceClass, string> = {
  observed: "Observed",
  forecast: "Forecast",
  derived: "Derived",
};

export function evidenceWord(record: ScenarioWindRecord): string {
  return EVIDENCE_WORD[record.evidenceClass];
}

/** "JARBO GAP RAWS, 12.6 km from the ignition" or the forecast grid wording. */
export function stationLabel(record: ScenarioWindRecord): string {
  if (record.station) {
    return `${record.station.name} (${record.station.id}), ${record.station.distanceKm.toFixed(1)} km away`;
  }
  return "NWS gridpoint forecast at the ignition";
}

/** One line for the wind panel: evidence class, station, distance, the value used, and height. */
export function windSummary(record: ScenarioWindRecord): string {
  const a = record.applied;
  const hour = a.tUtc.slice(5, 16).replace("T", " ");
  const factor =
    record.heightConversion.factor === 1
      ? "already 20 ft"
      : `10 m x ${record.heightConversion.factor} to 20 ft`;
  const analog = record.analog as { source_start_utc?: string } | null;
  const analogText = analog?.source_start_utc
    ? `, replaying the real hours from ${analog.source_start_utc.slice(0, 10)}`
    : "";
  return (
    `${evidenceWord(record)}, ${stationLabel(record)}${analogText}. Peak hour ${hour} UTC: ` +
    `${a.speed20ftMph} mph from ${a.fromDeg}° (${factor}).` +
    (a.clampedFromMph !== null ? ` Capped from ${a.clampedFromMph} mph.` : "")
  );
}

/** The record is only valid while the wind in use still matches what it applied. */
export function recordMatchesWind(
  record: ScenarioWindRecord,
  speedMph: number,
  fromDegrees: number,
): boolean {
  return (
    Math.abs(record.applied.speed20ftMph - speedMph) < 0.05 &&
    Math.abs(record.applied.fromDeg - fromDegrees) < 0.5
  );
}
