/**
 * World conditions client: `GET /api/conditions` and `GET /api/conditions/presets`
 * (app/backend/api/conditions.py, sim/fuel_moisture.py, sim/conditions_presets.py;
 * contract in docs/scenario-weather.md, "Fuel moisture from the date's weather").
 *
 * Units at this boundary:
 * - times: UTC ISO 8601 ending in `Z`, hourly bin centres;
 * - `windSpeed20ftMph`: open 20 ft wind, miles per hour, after the server's height conversion
 *   (the `FireScenario.windSpeedMph` contract); `windSpeed20ftMs` the same wind in m/s;
 * - `windFromDeg`: degrees true, the bearing the wind blows FROM (`FireScenario.windFromDegrees`);
 * - moisture: fractions of oven-dry weight (0.06 = 6 %), keyed exactly as `FuelMoisture`.
 *
 * Evidence stays separate: weather is observed / derived (climatology) / forecast; dead 1-h
 * moisture is derived; 10-h and 100-h are derived with an assumed forcing and starting state;
 * live moisture is derived from the NFDRS 2016 Growing Season Index over an ERA5 lead-in, or
 * assumed (phenology calendar) when that lead-in is unavailable (`evidence.live` says which).
 * Nothing here invents a missing value: an hour
 * without temperature/RH or wind cannot be applied, and `applyConditionsHour` says why.
 */

import type { FuelMoisture } from "../fire/rothermel";
import { fahrenheitOfCelsius, type FireWeatherSample, type FireWeatherSeries } from "../fire/weatherSeries";

export type ConditionsMode = "historical_replay" | "climatology_percentile" | "forecast";
export type ConditionsWeatherEvidence = "observed" | "derived" | "forecast";
export type Aspect = "N" | "E" | "S" | "W";
export type Shading = "exposed" | "shaded";
/** Projection point relative to the weather station: B 1000-2000 ft below, L within 1000 ft, A above. */
export type ElevationBand = "B" | "L" | "A";

export interface ConditionsSite {
  /** Cardinal aspect or a bearing in degrees (binned to the nearest cardinal by the server). */
  aspect?: Aspect | number;
  slopePct?: number;
  /** "shaded" = 50 % or more shading of surface fuels, by canopy or cloud. */
  shading?: Shading;
  elevation?: ElevationBand;
  /** Night only: apply Rothermel 1983 Table F (strong inversion). */
  nightInversion?: boolean;
  /** Table F only: aspect of the weather station. */
  stationAspect?: Aspect;
}

export interface ConditionsQuery {
  lon: number;
  lat: number;
  /** ISO UTC with Z. Optional for `forecast` (the server uses the current UTC hour). */
  startUtc?: string;
  /** 1 to 169; the answer has hours + 1 samples. Server default 24. */
  hours?: number;
  mode: ConditionsMode;
  /** 50 to 99.9, climatology only. Server default 95. */
  percentile?: number;
  /** Climatology only: wind-from sector [from, to] degrees clockwise. Server default [315, 90]. */
  sectorFromDeg?: [number, number];
  site?: ConditionsSite;
  /** Catalogue region or historical fire id; picks the live-moisture calendar. */
  region?: string;
  /** Explicit phenology class id (overrides region). */
  phenology?: string;
}

/** FuelMoisture, but any field may be null when the hour had no temperature/RH. */
export type NullableFuelMoisture = { [K in keyof FuelMoisture]: number | null };

export interface FineFuelDetail {
  moisturePct: number;
  period: "day" | "night";
  referencePct: number;
  correctionPct: number;
  /** Rothermel 1983 table(s) used: "A+B" | "A+C" | "A+D" | "E" | "E+F". */
  table: string;
  /** The reference cell was printed "25+". */
  referenceIsLowerBound: boolean;
  temperatureOutsideTable: boolean;
  /** Local mean solar time the tables were read at (analog time for climatology). */
  localSolarTime: string;
}

export interface ConditionsHour {
  tUtc: string;
  windSpeed20ftMs: number | null;
  windSpeed20ftMph: number | null;
  /** m/s at the station's reporting height, as reported. */
  windSpeedReportedMs: number | null;
  windFromDeg: number | null;
  gustMs: number | null;
  tempC: number | null;
  rhPct: number | null;
  moisture: NullableFuelMoisture;
  fineFuel: FineFuelDetail | null;
  live: { herbPct: number; woodyPct: number; herbStage: string; woodyStage: string };
  /** Temperature/RH for this hour were filled across a gap of at most 3 h. */
  metFilled: boolean;
}

export interface ConditionsStation {
  id: string;
  name: string;
  distanceKm: number | null;
  source: string;
}

export interface ConditionsEvidence {
  weather: ConditionsWeatherEvidence;
  wind20ft: string;
  dead1h: string;
  dead10hDead100h: string;
  live: string;
  site: string;
}

export interface Conditions {
  schema: "crisistwin.conditions/1";
  modelVersion: string;
  mode: ConditionsMode;
  startUtc: string;
  station: ConditionsStation | null;
  source: string;
  heightConversion: { fromHeight: string; factor: number; method: string } | null;
  site: Required<Omit<ConditionsSite, "aspect" | "slopePct" | "elevation">> & {
    aspect: Aspect;
    slopePct: number;
    elevation: ElevationBand;
    /** False when every site value is the server default (an assumption). */
    given: boolean;
  };
  phenology: { class: string; label: string; chosenBy: string };
  evidence: ConditionsEvidence;
  hours: ConditionsHour[];
  summary: {
    samples: number;
    hoursWithoutWind: number;
    hoursWithoutMoisture: number;
    peakWindHour: { tUtc: string; windSpeed20ftMph: number | null; windFromDeg: number | null } | null;
    maxGustMs: number | null;
    minDead1h: { tUtc: string; dead1h: number; rhPct: number | null; tempC: number | null } | null;
    minRhPct: number | null;
    maxTempC: number | null;
  };
  /** Server provenance (weather records, spin-up, table clock, model citations), kept opaque. */
  provenance: unknown;
  /** Plain-language caveats from the server (station, QC, live moisture), to show the user. */
  warnings: string[];
  cache: { hit: boolean; storedUtc: string | null; key: string } | null;
}

export interface ConditionsPreset {
  id: string;
  label: string;
  query: ConditionsQuery;
  /** Historical fires only. */
  ignitionUtc?: string;
  evidence: { date: string; weather: string };
  pointSource?: string;
}

export interface RegionConditionsPresets {
  region: {
    id: string;
    kind: "catalogue" | "historical_fire";
    name: string;
    area?: string;
    /** [lon, lat] WGS84. */
    center: [number, number];
  };
  weatherCoverage: string;
  phenologyClass: string;
  /** "MM-DD", an assumed peak-season date (the actual fire day for historical fires). */
  typicalSeasonDate: string;
  presets: ConditionsPreset[];
}

// ---------------------------------------------------------------------------------- fetch

interface ApiHour {
  t_utc: string;
  wind_speed_20ft_ms: number | null;
  wind_speed_20ft_mph: number | null;
  wind_speed_reported_ms: number | null;
  wind_from_deg: number | null;
  gust_ms: number | null;
  temp_c: number | null;
  rh_pct: number | null;
  moisture: NullableFuelMoisture;
  fine_fuel: {
    moisture_pct: number;
    period: "day" | "night";
    reference_pct: number;
    correction_pct: number;
    table: string;
    reference_is_lower_bound: boolean;
    temp_outside_table: boolean;
    local_solar_time: string;
  } | null;
  live: { herb_pct: number; woody_pct: number; herb_stage: string; woody_stage: string };
  met_filled: boolean;
}

interface ApiConditions {
  schema: "crisistwin.conditions/1";
  model_version: string;
  mode: ConditionsMode;
  start_utc: string;
  station: { id: string; name: string; distance_km?: number | null; source: string } | null;
  source: string;
  height_conversion: { from_height: string; factor: number; method: string } | null;
  site: {
    aspect: Aspect;
    slope_pct: number;
    shading: Shading;
    elevation_band: ElevationBand;
    night_inversion: boolean;
    station_aspect: Aspect;
    given: boolean;
  };
  phenology: { class: string; label: string; chosen_by: string };
  evidence: {
    weather: ConditionsWeatherEvidence;
    wind_20ft: string;
    dead1h: string;
    dead10h_dead100h: string;
    live: string;
    site: string;
  };
  hours_series: ApiHour[];
  summary: {
    samples: number;
    hours_without_wind: number;
    hours_without_moisture: number;
    peak_wind_hour: { t_utc: string; wind_speed_20ft_mph: number | null; wind_from_deg: number | null } | null;
    max_gust_ms: number | null;
    min_dead1h: { t_utc: string; dead1h: number; rh_pct: number | null; temp_c: number | null } | null;
    min_rh_pct: number | null;
    max_temp_c: number | null;
  };
  provenance: unknown;
  warnings?: string[];
  cache?: { hit: boolean; stored_utc: string | null; key: string };
}

interface ApiPresetQuery {
  lon: number;
  lat: number;
  start: string;
  hours: number;
  mode: ConditionsMode;
  percentile?: number;
  sector?: [number, number];
}

interface ApiRegionPresets {
  region: RegionConditionsPresets["region"];
  weather_coverage: string;
  phenology_class: string;
  typical_season_date: string;
  presets: {
    id: string;
    label: string;
    query: ApiPresetQuery;
    ignition_utc?: string;
    evidence: { date: string; weather: string };
    point_source?: string;
  }[];
}

export function conditionsSearchParams(query: ConditionsQuery): URLSearchParams {
  const p = new URLSearchParams({ lon: String(query.lon), lat: String(query.lat), mode: query.mode });
  if (query.startUtc) p.set("start", query.startUtc);
  if (query.hours !== undefined) p.set("hours", String(query.hours));
  if (query.percentile !== undefined) p.set("percentile", String(query.percentile));
  if (query.sectorFromDeg) p.set("sector", query.sectorFromDeg.join(","));
  const s = query.site;
  if (s?.aspect !== undefined) p.set("aspect", String(s.aspect));
  if (s?.slopePct !== undefined) p.set("slope_pct", String(s.slopePct));
  if (s?.shading) p.set("shading", s.shading);
  if (s?.elevation) p.set("elevation", s.elevation);
  if (s?.nightInversion !== undefined) p.set("night_inversion", s.nightInversion ? "1" : "0");
  if (s?.stationAspect) p.set("station_aspect", s.stationAspect);
  if (query.region) p.set("region", query.region);
  if (query.phenology) p.set("phenology", query.phenology);
  return p;
}

async function getJson(url: string, signal: AbortSignal | undefined, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error(`The ${what} service could not be reached.`);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = (body as { detail?: string } | null)?.detail;
    throw new Error(detail ?? `The ${what} service returned HTTP ${response.status}.`);
  }
  return body;
}

/** Hourly weather and derived moisture for a place and date. Throws a readable Error. */
export async function fetchConditions(query: ConditionsQuery, signal?: AbortSignal): Promise<Conditions> {
  const body = await getJson(`/api/conditions?${conditionsSearchParams(query)}`, signal, "conditions");
  return toConditions(body as ApiConditions);
}

/** Date presets for one region or historical fire id. */
export async function fetchConditionPresets(
  region: string,
  signal?: AbortSignal,
): Promise<RegionConditionsPresets> {
  const body = await getJson(
    `/api/conditions/presets?${new URLSearchParams({ region })}`,
    signal,
    "conditions presets",
  );
  return toPresets(body as ApiRegionPresets);
}

/** Presets for every catalogue region and historical fire. */
export async function fetchAllConditionPresets(signal?: AbortSignal): Promise<RegionConditionsPresets[]> {
  const body = (await getJson("/api/conditions/presets", signal, "conditions presets")) as {
    regions: ApiRegionPresets[];
  };
  return body.regions.map(toPresets);
}

function toPresets(r: ApiRegionPresets): RegionConditionsPresets {
  return {
    region: r.region,
    weatherCoverage: r.weather_coverage,
    phenologyClass: r.phenology_class,
    typicalSeasonDate: r.typical_season_date,
    presets: r.presets.map((p) => ({
      id: p.id,
      label: p.label,
      query: {
        lon: p.query.lon,
        lat: p.query.lat,
        startUtc: p.query.start,
        hours: p.query.hours,
        mode: p.query.mode,
        ...(p.query.percentile !== undefined ? { percentile: p.query.percentile } : {}),
        ...(p.query.sector ? { sectorFromDeg: p.query.sector } : {}),
        region: r.region.id,
      },
      ...(p.ignition_utc ? { ignitionUtc: p.ignition_utc } : {}),
      evidence: p.evidence,
      ...(p.point_source ? { pointSource: p.point_source } : {}),
    })),
  };
}

/** The API body (snake_case) as `Conditions`; exported for Node scripts that read a saved response. */
export function toConditions(d: ApiConditions): Conditions {
  return {
    schema: d.schema,
    modelVersion: d.model_version,
    mode: d.mode,
    startUtc: d.start_utc,
    station: d.station
      ? { id: d.station.id, name: d.station.name, distanceKm: d.station.distance_km ?? null, source: d.station.source }
      : null,
    source: d.source,
    heightConversion: d.height_conversion
      ? {
          fromHeight: d.height_conversion.from_height,
          factor: d.height_conversion.factor,
          method: d.height_conversion.method,
        }
      : null,
    site: {
      aspect: d.site.aspect,
      slopePct: d.site.slope_pct,
      shading: d.site.shading,
      elevation: d.site.elevation_band,
      nightInversion: d.site.night_inversion,
      stationAspect: d.site.station_aspect,
      given: d.site.given,
    },
    phenology: { class: d.phenology.class, label: d.phenology.label, chosenBy: d.phenology.chosen_by },
    evidence: {
      weather: d.evidence.weather,
      wind20ft: d.evidence.wind_20ft,
      dead1h: d.evidence.dead1h,
      dead10hDead100h: d.evidence.dead10h_dead100h,
      live: d.evidence.live,
      site: d.evidence.site,
    },
    hours: d.hours_series.map((h) => ({
      tUtc: h.t_utc,
      windSpeed20ftMs: h.wind_speed_20ft_ms,
      windSpeed20ftMph: h.wind_speed_20ft_mph,
      windSpeedReportedMs: h.wind_speed_reported_ms,
      windFromDeg: h.wind_from_deg,
      gustMs: h.gust_ms,
      tempC: h.temp_c,
      rhPct: h.rh_pct,
      moisture: h.moisture,
      fineFuel: h.fine_fuel
        ? {
            moisturePct: h.fine_fuel.moisture_pct,
            period: h.fine_fuel.period,
            referencePct: h.fine_fuel.reference_pct,
            correctionPct: h.fine_fuel.correction_pct,
            table: h.fine_fuel.table,
            referenceIsLowerBound: h.fine_fuel.reference_is_lower_bound,
            temperatureOutsideTable: h.fine_fuel.temp_outside_table,
            localSolarTime: h.fine_fuel.local_solar_time,
          }
        : null,
      live: {
        herbPct: h.live.herb_pct,
        woodyPct: h.live.woody_pct,
        herbStage: h.live.herb_stage,
        woodyStage: h.live.woody_stage,
      },
      metFilled: h.met_filled,
    })),
    summary: {
      samples: d.summary.samples,
      hoursWithoutWind: d.summary.hours_without_wind,
      hoursWithoutMoisture: d.summary.hours_without_moisture,
      peakWindHour: d.summary.peak_wind_hour
        ? {
            tUtc: d.summary.peak_wind_hour.t_utc,
            windSpeed20ftMph: d.summary.peak_wind_hour.wind_speed_20ft_mph,
            windFromDeg: d.summary.peak_wind_hour.wind_from_deg,
          }
        : null,
      maxGustMs: d.summary.max_gust_ms,
      minDead1h: d.summary.min_dead1h
        ? {
            tUtc: d.summary.min_dead1h.t_utc,
            dead1h: d.summary.min_dead1h.dead1h,
            rhPct: d.summary.min_dead1h.rh_pct,
            tempC: d.summary.min_dead1h.temp_c,
          }
        : null,
      minRhPct: d.summary.min_rh_pct,
      maxTempC: d.summary.max_temp_c,
    },
    provenance: d.provenance,
    warnings: Array.isArray(d.warnings) ? d.warnings.filter((w): w is string => typeof w === "string") : [],
    cache: d.cache ? { hit: d.cache.hit, storedUtc: d.cache.stored_utc, key: d.cache.key } : null,
  };
}

// ---------------------------------------------------------------------------------- apply (pure)

const HOUR_MS = 3_600_000;

/** The hour whose bin (centre +/- 30 min) contains `tUtc`, or null outside the series. */
export function conditionsHourAt(conditions: Conditions, tUtc: string | Date): ConditionsHour | null {
  const t = typeof tUtc === "string" ? Date.parse(tUtc) : tUtc.getTime();
  if (!Number.isFinite(t)) return null;
  for (const h of conditions.hours) {
    const c = Date.parse(h.tUtc);
    if (t >= c - HOUR_MS / 2 && t < c + HOUR_MS / 2) return h;
  }
  return null;
}

/** The hour with the highest 20 ft wind (earliest of ties) among hours that can be applied. */
export function peakWindHour(conditions: Conditions): ConditionsHour | null {
  let best: ConditionsHour | null = null;
  for (const h of conditions.hours) {
    if (!applyConditionsHour(h).ok) continue;
    if (best === null || (h.windSpeed20ftMph ?? 0) > (best.windSpeed20ftMph ?? 0)) best = h;
  }
  return best;
}

/** The Rothermel run inputs one conditions hour sets (`FireScenario` wind and moisture fields). */
export interface RothermelConditionsInputs {
  /** Open 20 ft wind, mph (FireScenario.windSpeedMph). */
  windSpeedMph: number;
  /** Bearing the wind blows FROM, degrees true in [0, 360) (FireScenario.windFromDegrees). */
  windFromDegrees: number;
  moisture: FuelMoisture;
}

export type ApplyConditionsResult =
  | {
      ok: true;
      tUtc: string;
      inputs: RothermelConditionsInputs;
      /** Zero wind: the direction is irrelevant to spread and set to 0, not observed. */
      calm: boolean;
      /** Set when `maxWindMph` cut the speed. */
      clampedFromMph: number | null;
    }
  | { ok: false; tUtc: string; missing: string[] };

/**
 * Turns one conditions hour into the wind and moisture a Rothermel run takes. Pure. Refuses
 * (ok: false, listing the fields) rather than filling a missing wind or moisture with a guess.
 */
export function applyConditionsHour(
  hour: ConditionsHour,
  options: { maxWindMph?: number } = {},
): ApplyConditionsResult {
  const missing: string[] = [];
  const m = hour.moisture;
  for (const key of ["dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"] as const) {
    const v = m[key];
    if (v === null || !Number.isFinite(v) || v < 0) missing.push(`moisture.${key}`);
  }
  const speed = hour.windSpeed20ftMph;
  if (speed === null || !Number.isFinite(speed) || speed < 0) missing.push("windSpeed20ftMph");
  const calm = speed === 0;
  if (!calm && (hour.windFromDeg === null || !Number.isFinite(hour.windFromDeg))) missing.push("windFromDeg");
  if (missing.length > 0) return { ok: false, tUtc: hour.tUtc, missing };
  const raw = speed as number;
  const cap = options.maxWindMph;
  const windSpeedMph = cap !== undefined ? Math.min(raw, cap) : raw;
  return {
    ok: true,
    tUtc: hour.tUtc,
    inputs: {
      windSpeedMph,
      windFromDegrees: calm ? 0 : (((hour.windFromDeg as number) % 360) + 360) % 360,
      moisture: {
        dead1h: m.dead1h as number,
        dead10h: m.dead10h as number,
        dead100h: m.dead100h as number,
        liveHerb: m.liveHerb as number,
        liveWoody: m.liveWoody as number,
      },
    },
    calm,
    clampedFromMph: windSpeedMph === raw ? null : raw,
  };
}

/**
 * The conditions hours as the solver's time-varying weather (`FireScenario.weatherSeries`,
 * fire/weatherSeries.ts): wind, direction, all five moisture classes and air temperature per
 * hour. `t0Utc` is the run's T+0 (sample minutes are counted from it, and may be negative for
 * hours before it). Hours `applyConditionsHour` refuses (a missing wind, direction or moisture)
 * are skipped, never filled; the solver interpolates across them. Null when no hour applies.
 */
export function weatherSeriesFromConditions(
  conditions: Conditions,
  t0Utc: string,
  options: { maxWindMph?: number } = {},
): { series: FireWeatherSeries; skippedHours: string[] } | null {
  const t0 = Date.parse(t0Utc);
  if (!Number.isFinite(t0)) return null;
  const samples: FireWeatherSample[] = [];
  const skippedHours: string[] = [];
  for (const hour of conditions.hours) {
    const applied = applyConditionsHour(hour, options);
    const minute = (Date.parse(hour.tUtc) - t0) / 60_000;
    if (!applied.ok || !Number.isFinite(minute)) {
      skippedHours.push(hour.tUtc);
      continue;
    }
    if (samples.length > 0 && !(minute > samples[samples.length - 1].minute)) continue;
    samples.push({
      minute,
      windSpeedMph: applied.inputs.windSpeedMph,
      // A calm hour's direction is not observed (set to 0); carry the previous one so it does
      // not swing the interpolation either side of it.
      windFromDegrees:
        applied.calm && samples.length > 0 ? samples[samples.length - 1].windFromDegrees : applied.inputs.windFromDegrees,
      moisture: applied.inputs.moisture,
      ...(hour.tempC !== null && Number.isFinite(hour.tempC) ? { airTemperatureF: fahrenheitOfCelsius(hour.tempC) } : {}),
    });
  }
  if (samples.length === 0) return null;
  // Longest stretch with no kept sample: between samples, from T+0 to the first, and from the
  // last to the final hour the service returned.
  const lastHourMinute = conditions.hours.reduce((m, h) => {
    const minute = (Date.parse(h.tUtc) - t0) / 60_000;
    return Number.isFinite(minute) && minute > m ? minute : m;
  }, samples[samples.length - 1].minute);
  let longestGapMinutes = Math.max(0, samples[0].minute, lastHourMinute - samples[samples.length - 1].minute);
  for (let i = 1; i < samples.length; i++) {
    longestGapMinutes = Math.max(longestGapMinutes, samples[i].minute - samples[i - 1].minute);
  }
  return {
    series: {
      enabled: true,
      samples,
      source: `${conditions.mode}${conditions.station ? ` ${conditions.station.id}` : ""}`,
      evidence: conditions.evidence.weather,
      missing: {
        hours: skippedHours.length,
        longestGapHours: Math.round((longestGapMinutes / 60) * 10) / 10,
        startMissing: samples[0].minute > 0,
      },
    },
    skippedHours,
  };
}
