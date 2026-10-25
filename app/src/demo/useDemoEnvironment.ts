/**
 * Loads the /demo board's physical inputs (docs/command-demo-realism.md) and builds a
 * `DemoEnvironment`: wind (GET /api/demo/wind), the drill centre and carless households (GET
 * /api/demo/environment; every call carries `incident` for a non-Camp drill), CAL FIRE bases (GET
 * /api/suppression/bases), and the LANDFIRE landscape the fire solver runs on (also the 3D
 * diorama's board, DemoDiorama.tsx). A Studio drill names the Studio board it was run on
 * (`region_id`, "<region>@<N>km"; `studioBoard`): that exact landscape is loaded, as Studio
 * loads it (same centre, radius and cell size, so the same MongoDB cache entry). Otherwise it is
 * the prebuilt region covering the drill (GET /api/landscapes)
 * or, when none covers it or the store is unavailable, the same fuel, canopy and terrain loaded
 * live from LANDFIRE and 3DEP, as Simulation Studio does (studio/useRegionBoard.ts), read back
 * from the MongoDB landscape cache when an identical board was loaded before. With no covering
 * region the live square is the board radius (`radiusMeters`, default
 * DEFAULT_BOARD_RADIUS_METERS; the shared world's region), widened when the drill's zones need
 * more room. Inputs other than the landscape fall back to labelled assumptions in realism.ts /
 * model.ts; without a landscape there is no fire model, so a landscape failure is an error
 * state, not a fallback. The board starts once everything has answered; the inputs other than
 * the landscape give up after INPUT_TIMEOUT_MS (their labelled fallbacks), so they never hold
 * the board longer than the landscape does. Units, stations and
 * household counts come from the drill's resource snapshot (useCommandBoard loads it); the bases
 * and carless counts here are the fallback when there is none.
 */

import { useEffect, useRef, useState } from "react";
import { cellAt } from "../fire/spread";
import { CALIFORNIA_REGIONS } from "../fire/regions";
import { RegionUnavailableError, fetchRegionCatalog, fetchRegionLandscape } from "../fire/landscapePackage";
import type { LandscapeGrid } from "../fire/landscape";
import type { LandscapeRegion } from "../fire/regions";
import { DEFAULT_BOARD_RADIUS_METERS, boardCellMetersFor, clampBoardRadiusMeters } from "../fire/boardSize";
import { loadLandscapeCached, type CachedLandscapeResult } from "../fire/landscapeCache";
import type { LonLat } from "../live/types";
import { CREW_TYPES, STATION_TYPES, SUPPRESSION_BASES_URL, parseBases, type SuppressionBases } from "../studio/suppressionBases";
import { studioBoardId } from "../studio/useRegionBoard";
import { ENVIRONMENT_URL, WIND_URL, demoUrl, type EnvironmentResponse, type WindResponse } from "./contracts";
import { IGNITION_OUTSIDE_MAX_M, type DemoEnvironment, type Station } from "./model";
import { FALLBACK_WIND, type Ground, type WindSeries } from "./realism";

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

/** Centre of the zones' bounding box and its larger half-width in ground metres, or null. */
export function zonesExtent(zones: readonly { geometry: { type: string; coordinates: unknown } }[]): { center: LonLat; halfWidthMeters: number } | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]);
      minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
    } else c.forEach(walk);
  };
  for (const z of zones) walk(z.geometry.coordinates);
  if (!Number.isFinite(minLon)) return null;
  const center: LonLat = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const kx = METERS_PER_DEG * Math.cos((center[1] * Math.PI) / 180);
  return { center, halfWidthMeters: Math.max(((maxLon - minLon) * kx) / 2, ((maxLat - minLat) * METERS_PER_DEG) / 2) };
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
const METERS_PER_DEG = 111_320;
/**
 * ASSUMPTION: ground loaded beyond the outermost possible scheduled ignition (zones' half-width
 * plus model.ts IGNITION_OUTSIDE_MAX_M) when the drill has no prebuilt region, so a fire can run
 * a few kilometres before it reaches the edge of the modelled area (the solver stops there).
 */
export const LIVE_LANDSCAPE_MARGIN_M = 3000;
/**
 * ASSUMPTION: how long the board waits for an input other than the landscape (wind, drill
 * environment, bases) before using its labelled fallback. They answer in well under a second
 * normally (a climatology wind series in about 6 s); only the fire needs the landscape.
 */
export const INPUT_TIMEOUT_MS = 12_000;

/**
 * The Studio board a drill was run on (`GET /api/live/active` `region_id`, parsed by
 * studio/useRegionBoard.ts parseStudioBoardId): its region and half-width (ground metres; null =
 * the region's own prebuilt board).
 */
export interface StudioBoard {
  region: LandscapeRegion;
  radiusMeters: number | null;
}

/** The JSON body, or null on an error status, a network failure or after `timeoutMs`. */
async function getJson<T>(url: string, signal: AbortSignal, timeoutMs = INPUT_TIMEOUT_MS): Promise<T | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, timeout]), headers: { Accept: "application/json" } });
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

interface LoadedLandscape {
  grid: LandscapeGrid;
  region: { id: string; name: string };
  /** stored = prebuilt region; cached = MongoDB landscape cache; live = loaded from LANDFIRE now. */
  source: "stored" | "cached" | "live";
  /** UTC ISO time the cached copy was stored; only when `source` is "cached". */
  cachedAt?: string;
}

/** A cache-backed live load (fire/landscapeCache.ts) as a LoadedLandscape. */
function fromCached(loaded: CachedLandscapeResult, region: { id: string; name: string }): LoadedLandscape {
  return loaded.source === "cache"
    ? { grid: loaded.grid, region, source: "cached", cachedAt: loaded.cachedAt }
    : { grid: loaded.grid, region, source: "live" };
}

/**
 * Landscapes by key, so a weather change (which reloads the environment) keeps the same grid
 * object: the running board, its fire field and the 3D board stay on it. A failed load is not kept.
 */
const landscapes = new Map<string, Promise<LoadedLandscape>>();

function cached(key: string, load: () => Promise<LoadedLandscape>, signal: AbortSignal): Promise<LoadedLandscape> {
  let pending = landscapes.get(key);
  if (!pending) {
    pending = load();
    landscapes.set(key, pending);
    pending.catch(() => landscapes.delete(key));
  }
  const shared = pending;
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    shared.then(resolve, reject);
  });
}

/**
 * A prebuilt region's own board, as Studio loads it (studio/useRegionBoard.ts): read from the
 * store; if the store or API is unavailable, the same box loaded live (MongoDB cache first).
 */
function loadRegionBoard(
  region: Pick<LandscapeRegion, "id" | "name" | "center" | "radiusMeters" | "cellMeters">,
  onLive: () => void,
  signal: AbortSignal,
): Promise<LoadedLandscape> {
  const independent = new AbortController().signal;
  return cached(
    `region:${region.id}`,
    () =>
      fetchRegionLandscape(region.id, independent).then(
        ({ grid }): LoadedLandscape => ({ grid, region: { id: region.id, name: region.name }, source: "stored" }),
        (cause: unknown) => {
          if (!(cause instanceof RegionUnavailableError) && !(cause instanceof TypeError)) throw cause;
          onLive();
          return loadLandscapeCached(region.center.longitude, region.center.latitude, region.radiusMeters, independent, {
            cellMeters: region.cellMeters,
          }).then((loaded) => fromCached(loaded, { id: region.id, name: region.name }));
        },
      ),
    signal,
  );
}

/**
 * The landscape of a Studio board, loaded exactly as Studio loads it (studio/useRegionBoard.ts):
 * a chosen half-width is a live load around the region centre at boardCellMetersFor(radius),
 * which reads the MongoDB landscape cache entry Studio's own load wrote (same key); the
 * region's own board is the prebuilt package (`onLive` when that falls back to a live load).
 */
function loadStudioBoard(board: StudioBoard, onLive: () => void, signal: AbortSignal): Promise<LoadedLandscape> {
  const { region, radiusMeters } = board;
  if (radiusMeters === null) return loadRegionBoard(region, onLive, signal);
  const id = studioBoardId(region.id, radiusMeters);
  const cellMeters = boardCellMetersFor(radiusMeters);
  const name = `${region.name} (Studio board, ${(radiusMeters / 1000).toFixed(0)} km around its centre, ${cellMeters} m cells)`;
  const independent = new AbortController().signal;
  return cached(
    `studio:${id}`,
    () =>
      loadLandscapeCached(region.center.longitude, region.center.latitude, radiusMeters, independent, { cellMeters }).then((loaded) =>
        fromCached(loaded, { id, name }),
      ),
    signal,
  );
}

/**
 * The landscape the fire solver runs on. A prebuilt region whose centre is within 80% of its
 * radius of the drill centre is read from the store; if the store or API is unavailable that
 * region's box is loaded live (as studio/useRegionBoard.ts). With no covering region, a square
 * around the drill centre is loaded live from LANDFIRE: the board radius (`radiusMeters`, the
 * shared world's), or more when the zones need it (half-width + IGNITION_OUTSIDE_MAX_M +
 * LIVE_LANDSCAPE_MARGIN_M), at the cell size /fire uses for that radius (boardCellMetersFor).
 * Live loads go through the MongoDB landscape cache (loadLandscapeCached).
 * Not tied to the caller's signal: an aborted load must not poison the cache.
 */
async function loadDrillLandscape(
  center: LonLat,
  zonesHalfWidthMeters: number | null,
  radiusMeters: number,
  onLive: () => void,
  signal: AbortSignal,
): Promise<LoadedLandscape> {
  let catalog: Awaited<ReturnType<typeof fetchRegionCatalog>> = [];
  try {
    catalog = await fetchRegionCatalog(signal);
  } catch {
    // Store or API unavailable: the regions are still known statically.
  }
  const known = [...catalog.map((r) => ({ id: r.id, name: r.name, center: r.center, radiusMeters: r.radiusMeters, cellMeters: r.cellMeters })), ...CALIFORNIA_REGIONS];
  const region = known.find((r) => {
    const dx = (center[0] - r.center.longitude) * METERS_PER_DEG * Math.cos((center[1] * Math.PI) / 180);
    const dy = (center[1] - r.center.latitude) * METERS_PER_DEG;
    return Math.hypot(dx, dy) < r.radiusMeters * 0.8;
  });
  const independent = new AbortController().signal;
  if (region) return loadRegionBoard(region, onLive, signal);
  const boardRadius = clampBoardRadiusMeters(radiusMeters);
  const zonesRadius = zonesHalfWidthMeters === null ? 0 : zonesHalfWidthMeters + IGNITION_OUTSIDE_MAX_M + LIVE_LANDSCAPE_MARGIN_M;
  const radius = clampBoardRadiusMeters(Math.round(Math.max(boardRadius, zonesRadius)));
  const cellMeters = boardCellMetersFor(radius);
  const key = `live:${center[0].toFixed(4)},${center[1].toFixed(4)},${radius}`;
  onLive();
  return cached(
    key,
    () =>
      loadLandscapeCached(center[0], center[1], radius, independent, { cellMeters }).then((loaded) =>
        fromCached(loaded, { id: key, name: `the drill area (${(radius / 1000).toFixed(1)} km around its centre, ${cellMeters} m cells)` }),
      ),
    signal,
  );
}

/** Fuel and slope lookups on the solver's landscape grid. */
function groundOf(loaded: LoadedLandscape): Ground {
  const { grid, region, source } = loaded;
  const index = (q: LonLat) => cellAt(grid, { longitude: q[0], latitude: q[1] });
  const where =
    source === "stored"
      ? `the prebuilt landscape "${region.name}"`
      : source === "cached"
      ? `${region.name}, a cached copy of a LANDFIRE load stored ${loaded.cachedAt?.slice(0, 10) ?? "earlier"}`
      : `${region.name}, loaded live from LANDFIRE`;
  return {
    fuelLabel: `LANDFIRE FBFM40 fuel and canopy from ${where}`,
    fuelEvidence: "landfire",
    terrainLabel: `Terrain from ${where} (${grid.attribution.terrain})`,
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

/**
 * CAL FIRE bases by roster pool, nearest the drill first. With a resource snapshot the board's
 * engines and stations come from the snapshot (model.ts createBoard); these bases then only
 * place the assumed hand crews (crew camps) and dozer (state stations). Without a snapshot they
 * hold the whole assumed ROSTER.
 */
export function stationsFrom(bases: SuppressionBases | null): DemoEnvironment["bases"] {
  if (!bases?.available || bases.bases.length === 0) return null;
  const toStation = (b: SuppressionBases["bases"][number]): Station => ({
    id: b.id,
    name: b.name,
    location: [b.lon, b.lat],
    type: b.type,
    source: "calfire_bases",
    basis: null,
    engines: [],
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
 * Only used for the fallback roster (no resource snapshot): the snapshot already lists these
 * OSM stations with their engines.
 * OSM carries no agency or facility type, so the nearest-first stations fill all three pools
 * (the board's unit types and counts per station stay assumed); crew camps reuse the nearest ones.
 */
export function stationsFromPackage(stations: EnvironmentResponse["stations"], center: LonLat | null): DemoEnvironment["bases"] {
  if (!stations || stations.length === 0) return null;
  const cos = center ? Math.cos((center[1] * Math.PI) / 180) : 1;
  const d2 = (s: { lon: number; lat: number }) => (center ? ((s.lon - center[0]) * cos) ** 2 + (s.lat - center[1]) ** 2 : 0);
  const near = [...stations].sort((a, b) => d2(a) - d2(b) || a.id.localeCompare(b.id));
  const all: Station[] = near.map((s) => ({
    id: s.id,
    name: s.name,
    location: [s.lon, s.lat],
    type: OSM_STATION_TYPE,
    source: "package_osm",
    basis: null,
    engines: [],
  }));
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
  zonesHalfWidthMeters: number | null = null,
  onLiveLandscape: () => void = () => {},
  radiusMeters: number = DEFAULT_BOARD_RADIUS_METERS,
  studioBoard: StudioBoard | null = null,
): Promise<DemoEnvironment> {
  // The wind and the environment answer independently; the centre (environment `center`, else the
  // zones' centroid, else the Studio board's centre) is needed for the bases lookup, and for the
  // landscape unless the drill names its Studio board (that load starts at once).
  const studioLandscape = studioBoard ? loadStudioBoard(studioBoard, onLiveLandscape, signal) : null;
  // Keep a rejection from surfacing as unhandled while the other inputs are still loading.
  studioLandscape?.catch(() => undefined);
  const envPromise = getJson<EnvironmentResponse>(demoUrl(ENVIRONMENT_URL, incidentId), signal);
  const windPromise = loadWind(preset, incidentId, signal);
  const envData = await envPromise;
  const studioCenter: LonLat | null = studioBoard ? [studioBoard.region.center.longitude, studioBoard.region.center.latitude] : null;
  const center: LonLat | null = envData?.center ?? fallbackCenter ?? studioCenter;
  if (!center) throw new Error("The drill has no centre to load its landscape around.");
  const [wind, basesJson, landscape] = await Promise.all([
    windPromise,
    getJson<unknown>(`${SUPPRESSION_BASES_URL}?lon=${center[0]}&lat=${center[1]}&radius_km=${BASE_RADIUS_KM}`, signal),
    studioLandscape ?? loadDrillLandscape(center, zonesHalfWidthMeters, radiusMeters, onLiveLandscape, signal),
  ]);
  const parsed = basesJson ? parseBases(basesJson) : null;
  const calfire = stationsFrom(parsed);
  const packageBases = calfire ? null : stationsFromPackage(envData?.stations, center);
  const bases = calfire ?? packageBases;
  const noVehicle = new Map(Object.entries(envData?.households_no_vehicle ?? {}));
  return {
    spread: { ground: groundOf(landscape), wind },
    bases,
    basesSource: calfire ? "calfire" : packageBases ? "package" : null,
    basesLabel: packageBases
      ? `${envData?.stations_source ?? "Fire stations from OpenStreetMap (drill package)"}; CAL FIRE bases unavailable, so unit types and counts per station are assumed, and crew camps reuse the nearest ${OSM_CREW_CAMPS} stations`
      : bases
      ? `CAL FIRE facilities layer (${parsed?.attribution ?? "CAL FIRE"}); unit counts per base are assumed`
      : "Synthetic stations (assumed: CAL FIRE bases file unavailable)",
    noVehicle,
    noVehicleLabel: envData?.households_no_vehicle_source ?? "Carless households unknown (counted as 0)",
    landscape: landscape.grid,
    landscapeRegion: landscape.region,
    landscapeSource: landscape.source,
    ...(landscape.source === "cached" && landscape.cachedAt ? { landscapeCachedAt: landscape.cachedAt } : {}),
  };
}

export interface DemoEnvironmentState {
  /** The environment, or null while loading or after a failure. */
  env: DemoEnvironment | null;
  /** True while loading the landscape live from LANDFIRE (slower than the store). */
  liveLandscape: boolean;
  /** Why the environment could not be built (no landscape means no fire model), or null. */
  error: string | null;
}

/**
 * The environment for a weather preset on an incident, with its loading and error state. Waits
 * for the zones (their centre and half-width choose the landscape when no prebuilt region
 * covers the drill); both are read when the load starts. `attempt` retries a failed load.
 * `radiusMeters` is the board radius (the shared world's region, docs/shared-world.md); a new
 * radius reloads the environment. `studioBoard` is the Studio board the drill was run on: its
 * landscape is loaded as Studio loads it, without waiting for the zones (a different board
 * reloads the environment).
 */
export function useDemoEnvironmentState(
  preset: WeatherPreset,
  incidentId: string,
  fallbackCenter: LonLat | null,
  zonesHalfWidthMeters: number | null = null,
  attempt = 0,
  radiusMeters: number = DEFAULT_BOARD_RADIUS_METERS,
  studioBoard: StudioBoard | null = null,
): DemoEnvironmentState {
  const radius = clampBoardRadiusMeters(radiusMeters);
  const [state, setState] = useState<{ key: string } & DemoEnvironmentState>({ key: "", env: null, liveLandscape: false, error: null });
  const studioId = studioBoard ? studioBoardId(studioBoard.region.id, studioBoard.radiusMeters) : "";
  const key = `${incidentId}|${preset.value}|${radius}|${studioId}|${attempt}`;
  const zones = useRef({ fallbackCenter, zonesHalfWidthMeters, studioBoard });
  zones.current = { fallbackCenter, zonesHalfWidthMeters, studioBoard };
  const ready = fallbackCenter !== null || studioBoard !== null;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const { fallbackCenter: center, zonesHalfWidthMeters: half, studioBoard: board } = zones.current;
    setState({ key, env: null, liveLandscape: false, error: null });
    loadEnvironment(
      preset,
      incidentId,
      center,
      controller.signal,
      half,
      () => {
        if (!controller.signal.aborted) setState((s) => (s.key === key ? { ...s, liveLandscape: true } : s));
      },
      radius,
      board,
    ).then(
      (env) => {
        if (!controller.signal.aborted) setState({ key, env, liveLandscape: env.landscapeSource === "live", error: null });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        const detail = cause instanceof Error ? cause.message : "unknown error";
        setState({ key, env: null, liveLandscape: false, error: `Could not load the LANDFIRE landscape for this drill (${detail}). The fire model needs it, so the board cannot start.` });
      },
    );
    return () => controller.abort();
  }, [preset, incidentId, key, ready, radius]);
  return state.key === key ? state : { env: null, liveLandscape: false, error: null };
}

/**
 * The environment only (null while loading or failed); see useDemoEnvironmentState.
 * `radiusMeters` is the board radius (shared world); `zonesHalfWidthMeters` widens a live square.
 */
export function useDemoEnvironment(
  preset: WeatherPreset,
  incidentId: string,
  fallbackCenter: LonLat | null,
  radiusMeters: number = DEFAULT_BOARD_RADIUS_METERS,
  zonesHalfWidthMeters: number | null = null,
): DemoEnvironment | null {
  return useDemoEnvironmentState(preset, incidentId, fallbackCenter, zonesHalfWidthMeters, 0, radiusMeters).env;
}
