/**
 * Loads the /demo board's physical inputs (docs/command-demo-realism.md) and builds a
 * `DemoEnvironment`: wind (GET /api/demo/wind), the drill centre, Camp terrain and carless households (GET
 * /api/demo/environment; every call carries `incident` for a non-Camp drill), CAL FIRE bases (GET /api/suppression/bases), and a LANDFIRE
 * landscape when a prebuilt one covers the drill area (GET /api/landscapes; its grid is also the
 * 3D diorama's board, DemoDiorama.tsx). Every input that
 * fails falls back to the labelled assumption in realism.ts / model.ts, and the board starts
 * once all have answered or failed.
 */

import { useEffect, useRef, useState } from "react";
import { DEFAULT_INCIDENT_ID } from "../live/api";
import { cellAt } from "../fire/spread";
import { fetchRegionCatalog, fetchRegionLandscape } from "../fire/landscapePackage";
import type { LandscapeGrid } from "../fire/landscape";
import type { LonLat } from "../live/types";
import { CREW_TYPES, STATION_TYPES, SUPPRESSION_BASES_URL, parseBases, type SuppressionBases } from "../studio/suppressionBases";
import { ENVIRONMENT_URL, WIND_URL, demoUrl, type EnvironmentResponse, type WindResponse } from "./contracts";
import type { DemoEnvironment, Station } from "./model";
import { FALLBACK_WIND, SpreadCache, groundFrom, type Ground, type TerrainGrid, type WindSeries } from "./realism";

/** Mean of the zones' vertex bounding box, WGS84 [lon, lat]; the fallback when the server gives no centre. */
export function zonesCenter(zones: readonly { geometry: { type: string; coordinates: unknown } }[]): LonLat | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]);
      minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
    } else c.forEach(walk);
  };
  for (const z of zones) walk(z.geometry.coordinates);
  return Number.isFinite(minLon) ? [(minLon + maxLon) / 2, (minLat + maxLat) / 2] : null;
}

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
  { value: "week", label: "Nov 1-8", title: "Observed wind, 1-8 Nov 2018 (the week before the Camp Fire), at the nearest station to the drill", mode: "historical_replay", start: "2018-11-01T00:00:00Z", hours: 168 },
  { value: "camp", label: "8 Nov 2018", title: "Observed wind from 8 Nov 2018 12:00Z (the Camp Fire day), at the nearest station to the drill", mode: "historical_replay", start: "2018-11-08T12:00:00Z", hours: 72 },
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

export async function loadWind(preset: WeatherPreset, incidentId: string, signal: AbortSignal): Promise<WindSeries> {
  const q = new URLSearchParams({ mode: preset.mode, start: preset.start, hours: String(preset.hours) });
  const data = await getJson<WindResponse>(demoUrl(`${WIND_URL}?${q}`, incidentId), signal);
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

/**
 * Decoded region landscapes by region id, so a weather change (which reloads the environment)
 * keeps the same grid object and the 3D board is not rebuilt. A failed fetch is not kept.
 */
const regionGrids = new Map<string, Promise<LandscapeGrid>>();

function regionGrid(regionId: string, signal: AbortSignal): Promise<LandscapeGrid> {
  let cached = regionGrids.get(regionId);
  if (!cached) {
    // Not tied to this caller's signal: an aborted load must not poison the cache.
    cached = fetchRegionLandscape(regionId, new AbortController().signal).then((r) => r.grid);
    regionGrids.set(regionId, cached);
    cached.catch(() => regionGrids.delete(regionId));
  }
  const pending = cached;
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    pending.then(resolve, reject);
  });
}

/** A prebuilt landscape that covers `p`: its LANDFIRE fuel and terrain lookup, and the grid itself (the 3D board), or null. */
async function landscapeGround(
  p: LonLat,
  signal: AbortSignal,
): Promise<{ ground: Ground; grid: LandscapeGrid; region: { id: string; name: string } } | null> {
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
    grid = await regionGrid(region.id, signal);
  } catch {
    return null;
  }
  const index = (q: LonLat) => cellAt(grid, { longitude: q[0], latitude: q[1] });
  const ground: Ground = {
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
  return { ground, grid, region: { id: region.id, name: region.name } };
}

export function stationsFrom(bases: SuppressionBases | null): DemoEnvironment["bases"] {
  if (!bases?.available || bases.bases.length === 0) return null;
  const toStation = (b: SuppressionBases["bases"][number]): Station => ({
    id: b.id,
    name: b.name,
    location: [b.lon, b.lat],
    type: b.type,
    agency: b.agency,
    unit: b.unit,
    staffing: b.staffing ?? null,
  });
  const near = [...bases.bases].sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));
  const calfireStations = near.filter((b) => STATION_TYPES.has(b.type) && b.agency.startsWith("CAL FIRE")).map(toStation);
  const localStations = near.filter((b) => b.type === "FSA").map(toStation);
  const crewCamps = near.filter((b) => CREW_TYPES.has(b.type)).map(toStation);
  if (calfireStations.length === 0 || localStations.length === 0 || crewCamps.length === 0) return null;
  // Every facility with its metadata (stations, camps, helitack and air attack bases): the response fleet (response/fleet.ts).
  return { calfireStations, localStations, crewCamps, all: near.map(toStation) };
}

const OSM_STATION_TYPE = "osm_fire_station";
const OSM_CREW_CAMPS = 2;
/** Most OSM stations the response fleet staffs (the CAL FIRE path is capped at 40 by the bases endpoint). */
const OSM_FLEET_STATIONS = 40;

/**
 * Bases from a drill package's OpenStreetMap fire stations when the CAL FIRE bases are unavailable.
 * OSM carries no agency or facility type, so the nearest-first stations fill all three pools
 * (the board's unit types and counts per station stay assumed); crew camps reuse the nearest ones.
 */
export function stationsFromPackage(stations: EnvironmentResponse["stations"], center: LonLat | null): DemoEnvironment["bases"] {
  if (!stations || stations.length === 0) return null;
  const cos = center ? Math.cos((center[1] * Math.PI) / 180) : 1;
  const d2 = (s: { lon: number; lat: number }) => (center ? ((s.lon - center[0]) * cos) ** 2 + (s.lat - center[1]) ** 2 : 0);
  const near = [...stations].sort((a, b) => d2(a) - d2(b) || a.id.localeCompare(b.id));
  const all: Station[] = near.map((s) => ({ id: s.id, name: s.name, location: [s.lon, s.lat], type: OSM_STATION_TYPE }));
  // Response fleet input: the stations (one Type 3 engine each, ASSUMPTION) and, as crew bases, the
  // nearest OSM_CREW_CAMPS stations again (ASSUMPTION; OSM has no conservation camps).
  const camps: Station[] = all.slice(0, OSM_CREW_CAMPS).map((s) => ({ ...s, id: `${s.id}-crew`, name: `${s.name} (crew base, assumed)`, type: "CC", agency: "Unknown" }));
  return { calfireStations: all, localStations: all, crewCamps: all.slice(0, OSM_CREW_CAMPS), all: [...all.slice(0, OSM_FLEET_STATIONS), ...camps] };
}

export async function loadEnvironment(
  preset: WeatherPreset,
  incidentId: string,
  fallbackCenter: LonLat | null,
  signal: AbortSignal,
): Promise<DemoEnvironment> {
  // The wind and the environment answer independently; the centre (environment `center`, else the
  // zones' centroid) is needed for the bases and landscape lookups.
  const envPromise = getJson<EnvironmentResponse>(demoUrl(ENVIRONMENT_URL, incidentId), signal);
  const windPromise = loadWind(preset, incidentId, signal);
  const envData = await envPromise;
  const center: LonLat | null = envData?.center ?? fallbackCenter;
  const [wind, basesJson, landscape] = await Promise.all([
    windPromise,
    center
      ? getJson<unknown>(`${SUPPRESSION_BASES_URL}?lon=${center[0]}&lat=${center[1]}&radius_km=${BASE_RADIUS_KM}`, signal)
      : Promise.resolve(null),
    center ? landscapeGround(center, signal) : Promise.resolve(null),
  ]);
  const ground = landscape?.ground ?? groundFrom(terrainGrid(envData?.terrain ?? null));
  const parsed = basesJson ? parseBases(basesJson) : null;
  const calfire = stationsFrom(parsed);
  const packageBases = calfire ? null : stationsFromPackage(envData?.stations, center);
  const bases = calfire ?? packageBases;
  const noVehicle = new Map(Object.entries(envData?.households_no_vehicle ?? {}));
  return {
    spread: new SpreadCache(ground, wind),
    bases,
    basesLabel: packageBases
      ? `${envData?.stations_source ?? "Fire stations from OpenStreetMap (drill package)"}; CAL FIRE bases unavailable, so unit types and counts per station are assumed, and crew camps reuse the nearest ${OSM_CREW_CAMPS} stations`
      : bases
      ? `CAL FIRE facilities layer (${parsed?.attribution ?? "CAL FIRE"}); unit counts per base are assumed`
      : "Synthetic stations (assumed: CAL FIRE bases file unavailable)",
    noVehicle,
    noVehicleLabel: envData?.households_no_vehicle_source ?? "Carless households unknown (counted as 0)",
    landscape: landscape?.grid ?? null,
    landscapeRegion: landscape?.region ?? null,
  };
}

/**
 * The environment for a weather preset on an incident; null while loading (and right after the
 * incident or preset changes). `fallbackCenter` (zones centroid) is read when the load starts.
 */
export function useDemoEnvironment(preset: WeatherPreset, incidentId: string, fallbackCenter: LonLat | null): DemoEnvironment | null {
  const [state, setState] = useState<{ key: string; env: DemoEnvironment } | null>(null);
  const key = `${incidentId}|${preset.value}`;
  const fallback = useRef(fallbackCenter);
  fallback.current = fallbackCenter;
  // Wait for the zones centroid on a non-Camp incident only until the command data arrives.
  const ready = incidentId === DEFAULT_INCIDENT_ID || fallbackCenter !== null;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    loadEnvironment(preset, incidentId, fallback.current, controller.signal).then((env) => {
      if (!controller.signal.aborted) setState({ key, env });
    });
    return () => controller.abort();
  }, [preset, incidentId, key, ready]);
  return state?.key === key ? state.env : null;
}
