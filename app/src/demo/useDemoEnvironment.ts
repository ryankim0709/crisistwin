/**
 * Loads the /demo board's physical inputs (docs/command-demo-realism.md) and builds a
 * `DemoEnvironment`: wind (GET /api/demo/wind), Camp terrain and carless households (GET
 * /api/demo/environment), CAL FIRE bases (GET /api/suppression/bases), and a LANDFIRE
 * landscape when a prebuilt one covers the drill area (GET /api/landscapes). Every input that
 * fails falls back to the labelled assumption in realism.ts / model.ts, and the board starts
 * once all have answered or failed.
 */

import { useEffect, useState } from "react";
import { cellAt } from "../fire/spread";
import { fetchRegionCatalog, fetchRegionLandscape } from "../fire/landscapePackage";
import type { LandscapeGrid } from "../fire/landscape";
import type { LonLat } from "../live/types";
import { CREW_TYPES, STATION_TYPES, SUPPRESSION_BASES_URL, parseBases, type SuppressionBases } from "../studio/suppressionBases";
import { ENVIRONMENT_URL, WIND_URL, type EnvironmentResponse, type WindResponse } from "./contracts";
import type { DemoEnvironment, Station } from "./model";
import { FALLBACK_WIND, SpreadCache, groundFrom, type Ground, type TerrainGrid, type WindSeries } from "./realism";

/** Centre of the Camp drill zones (Paradise), WGS84 [lon, lat]: where bases and landscapes are looked up. */
export const DRILL_CENTER: LonLat = [-121.62, 39.77];

export interface WeatherPreset {
  value: string;
  label: string;
  title: string;
  mode: "historical_replay" | "climatology_percentile";
  start: string;
  hours: number;
}

/**
 * Wind scenarios (scenario choice, each labelled with its evidence class on the board):
 * - the week before the Camp Fire, observed at the nearest covering station (baseline);
 * - the Camp Fire day from 2.5 h before ignition, observed;
 * - a 95th-percentile November offshore episode (sim/weather.py climatology_percentile:
 *   real hours chosen statistically, relabelled to start at the scenario start).
 */
export const WEATHER_PRESETS: readonly WeatherPreset[] = [
  { value: "week", label: "Nov 1-8", title: "Observed wind, 1-8 Nov 2018 (the week before the Camp Fire)", mode: "historical_replay", start: "2018-11-01T00:00:00Z", hours: 168 },
  { value: "camp", label: "Camp day", title: "Observed wind from 8 Nov 2018 12:00Z (Camp Fire day)", mode: "historical_replay", start: "2018-11-08T12:00:00Z", hours: 72 },
  { value: "p95", label: "Nov P95", title: "95th-percentile November offshore episode (derived from observed hours)", mode: "climatology_percentile", start: "2018-11-08T12:00:00Z", hours: 72 },
];

const BASE_RADIUS_KM = 60;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function loadWind(preset: WeatherPreset, signal: AbortSignal): Promise<WindSeries> {
  const q = new URLSearchParams({ mode: preset.mode, start: preset.start, hours: String(preset.hours) });
  const data = await getJson<WindResponse>(`${WIND_URL}?${q}`, signal);
  if (!data || !Array.isArray(data.samples) || data.samples.length === 0) return FALLBACK_WIND;
  const station = data.station;
  const where = station ? `${station.name} (${station.id}, ${Math.round(station.distance_km)} km)` : "station unknown";
  const evidence = data.evidence_class === "observed" ? "observed" : "derived";
  const analog = (data.provenance?.analog as { source_start_utc?: string } | undefined)?.source_start_utc;
  return {
    evidence,
    label:
      evidence === "observed"
        ? `Observed hourly wind, ${where}, from ${data.start_utc}`
        : `Derived: real hours of a ${preset.label} episode${analog ? ` (from ${analog})` : ""}, ${where}`,
    station: station ? { id: station.id, name: station.name, distanceKm: station.distance_km } : null,
    startUtc: data.start_utc,
    samples: data.samples.map((s) => ({ speedMetersPerSecond: s.speed_ms, fromDegrees: s.from_deg })),
    heightNote:
      station?.source === "iem_hads"
        ? "RAWS 20-ft wind"
        : "Airport 10 m wind used as the 20-ft wind with no height conversion (sim/weather.py convention)",
  };
}

export function terrainGrid(data: EnvironmentResponse["terrain"]): TerrainGrid | null {
  if (!data || data.slope_milli.length !== data.ncols * data.nrows) return null;
  return {
    originLon: data.origin_lon,
    originLat: data.origin_lat,
    cellMeters: data.cell_m,
    ncols: data.ncols,
    nrows: data.nrows,
    metersPerDegLon: data.m_per_deg_lon,
    metersPerDegLat: data.m_per_deg_lat,
    slopeTangent: Float32Array.from(data.slope_milli, (v) => v / 1000),
    upslopeDegrees: Float32Array.from(data.upslope_deg),
    label: `Observed terrain: ${data.source}`,
  };
}

/** LANDFIRE fuel and terrain from a prebuilt landscape that covers `p`, or null. */
async function landscapeGround(p: LonLat, signal: AbortSignal): Promise<Ground | null> {
  let catalog;
  try {
    catalog = await fetchRegionCatalog(signal);
  } catch {
    return null;
  }
  const region = catalog.find((r) => {
    const dx = (p[0] - r.center.longitude) * 111_320 * Math.cos((p[1] * Math.PI) / 180);
    const dy = (p[1] - r.center.latitude) * 111_320;
    return Math.hypot(dx, dy) < r.radiusMeters * 0.8;
  });
  if (!region) return null;
  let grid: LandscapeGrid;
  try {
    grid = (await fetchRegionLandscape(region.id, signal)).grid;
  } catch {
    return null;
  }
  const index = (q: LonLat) => cellAt(grid, { longitude: q[0], latitude: q[1] });
  return {
    fuelLabel: `LANDFIRE FBFM40 from the prebuilt landscape "${region.name}"`,
    fuelEvidence: "landfire",
    terrainLabel: `Terrain from the prebuilt landscape "${region.name}"`,
    terrainEvidence: "observed",
    fuelCodeAt: (q) => {
      const i = index(q);
      return i < 0 ? 0 : grid.fuelCodes[i];
    },
    slopeAt: (q) => {
      const i = index(q);
      return i < 0 ? { slopeTangent: 0, upslopeDegrees: 0, cell: -1 } : { slopeTangent: grid.slopeTangent[i], upslopeDegrees: grid.upslopeDegrees[i], cell: i };
    },
  };
}

export function stationsFrom(bases: SuppressionBases | null): DemoEnvironment["bases"] {
  if (!bases?.available || bases.bases.length === 0) return null;
  const toStation = (b: SuppressionBases["bases"][number]): Station => ({ id: b.id, name: b.name, location: [b.lon, b.lat], type: b.type });
  const near = [...bases.bases].sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));
  const calfireStations = near.filter((b) => STATION_TYPES.has(b.type) && b.agency.startsWith("CAL FIRE")).map(toStation);
  const localStations = near.filter((b) => b.type === "FSA").map(toStation);
  const crewCamps = near.filter((b) => CREW_TYPES.has(b.type)).map(toStation);
  if (calfireStations.length === 0 || localStations.length === 0 || crewCamps.length === 0) return null;
  return { calfireStations, localStations, crewCamps };
}

export async function loadEnvironment(preset: WeatherPreset, signal: AbortSignal): Promise<DemoEnvironment> {
  const [wind, envData, basesJson, landscape] = await Promise.all([
    loadWind(preset, signal),
    getJson<EnvironmentResponse>(ENVIRONMENT_URL, signal),
    getJson<unknown>(`${SUPPRESSION_BASES_URL}?lon=${DRILL_CENTER[0]}&lat=${DRILL_CENTER[1]}&radius_km=${BASE_RADIUS_KM}`, signal),
    landscapeGround(DRILL_CENTER, signal),
  ]);
  const ground = landscape ?? groundFrom(terrainGrid(envData?.terrain ?? null));
  const parsed = basesJson ? parseBases(basesJson) : null;
  const bases = stationsFrom(parsed);
  const noVehicle = new Map(Object.entries(envData?.households_no_vehicle ?? {}));
  return {
    spread: new SpreadCache(ground, wind),
    bases,
    basesLabel: bases
      ? `CAL FIRE facilities layer (${parsed?.attribution ?? "CAL FIRE"}); unit counts per base are assumed`
      : "Synthetic stations (assumed: CAL FIRE bases file unavailable)",
    noVehicle,
    noVehicleLabel: envData?.households_no_vehicle_source ?? "Carless households unknown (counted as 0)",
  };
}

/** The environment for a weather preset; null while loading. */
export function useDemoEnvironment(preset: WeatherPreset): DemoEnvironment | null {
  const [state, setState] = useState<{ key: string; env: DemoEnvironment } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    loadEnvironment(preset, controller.signal).then((env) => {
      if (!controller.signal.aborted) setState({ key: preset.value, env });
    });
    return () => controller.abort();
  }, [preset]);
  return state?.key === preset.value ? state.env : null;
}
