// Shared world contract (docs/shared-world.md): the ground, date, conditions, fires and seed
// the workspace tabs (/fire, /simulation, /dispatch, /live) read and control together.
// Units: metres, minutes, UTC ISO-8601 strings ("…Z"), WGS84 [lon, lat]. The world is a
// configuration (user assumptions or a chosen historical case), never observed data or a
// simulation result.

export const WORLD_SCHEMA = "crisistwin.world/1";

/** Who wrote a revision. */
export type WorldWriter = "fire" | "simulation" | "dispatch" | "live" | "mcp" | "api";

/** WGS84 `[lon, lat]`. */
export type LonLat = [number, number];

export type RegionKind = "catalogue" | "custom" | "historical_fire" | "incident";

export interface WorldRegion {
  kind: RegionKind;
  /** Catalogue id (app/src/fire/regions.ts), fire id ("camp-2018"), incident id; null only for custom. */
  id: string | null;
  name: string;
  center: LonLat;
  /** Half-width of the square board, ground metres (1 000–60 000). */
  radiusMeters: number;
  /** Ground cell, metres: a multiple of 30 from 30 to 300. */
  cellMeters: number;
}

export type WeatherMode = "historical_replay" | "climatology_percentile" | "forecast" | "assumed";

export interface WorldWeather {
  mode: WeatherMode;
  /** climatology_percentile (required there), 0–100. */
  percentile?: number;
  /** assumed (required there): 20-ft wind speed, mph. */
  windSpeedMph?: number;
  /** assumed (required there): direction the wind blows from, degrees clockwise from north. */
  windFromDegrees?: number;
}

export type MoisturePreset = "critical" | "dry" | "moderate" | "wet";

export interface WorldMoisture {
  mode: "derived" | "preset";
  /** preset only (required there). */
  preset?: MoisturePreset;
}

export interface WorldConditions {
  /** Simulation minute 0, UTC ISO-8601 ("2025-08-15T20:00:00Z"). */
  startUtc: string;
  weather: WorldWeather;
  moisture: WorldMoisture;
}

export interface WorldIgnition {
  id: string;
  at: LonLat;
  /** Minutes after `conditions.startUtc` (0–10 080). */
  startMinute: number;
}

export interface WorldFire {
  /** At most 50; a PATCH replaces the whole array. */
  ignitions: WorldIgnition[];
  stochastic: { enabled: boolean; seed: number };
}

export interface World {
  schema: typeof WORLD_SCHEMA;
  /** Server-assigned, +1 on every write; 0 is the built-in default world (never stored). */
  revision: number;
  /** UTC ISO-8601; null for the default world. */
  updatedAt: string | null;
  updatedBy: WorldWriter | null;
  region: WorldRegion;
  conditions: WorldConditions;
  fire: WorldFire;
  /** The /live drill this world drives, or null. */
  liveIncidentId: string | null;
  /** Master seed (0–2^32−1); tabs derive sub-seeds from it. */
  seed: number;
}

type PatchValue<V> = V extends readonly unknown[] ? V : V extends object ? Patch<V> : V;
type Patch<T> = {
  [K in keyof T]?:
    | PatchValue<NonNullable<T[K]>>
    | (undefined extends T[K] ? null : never)
    | (null extends T[K] ? null : never);
};

/** A partial world for PATCH: objects merge key by key; arrays (ignitions, centres) and scalars
 * replace; `null` clears an optional field. Server fields (schema, revision, updatedAt,
 * updatedBy) are ignored. */
export type WorldChanges = Patch<Omit<World, "schema" | "revision" | "updatedAt" | "updatedBy">>;

export interface WorldPatchRequest {
  baseRevision: number;
  updatedBy: WorldWriter;
  changes: WorldChanges;
}

/** Per-tab opaque extras saved with a scenario (≤ 2 MB of JSON in total). */
export interface ScenarioExtras {
  fire?: unknown;
  simulation?: unknown;
  dispatch?: unknown;
  live?: unknown;
}
export type ScenarioTab = keyof ScenarioExtras;

/** A row of GET /api/world/scenarios (newest first). */
export interface ScenarioSummary {
  id: string;
  name: string;
  notes: string;
  tags: string[];
  createdAt: string;
  updatedBy: WorldWriter | null;
  region: WorldRegion;
  startUtc: string;
  /** Which tabs saved extras. */
  extrasKeys: ScenarioTab[];
}

/** GET /api/world/scenarios/<id>. */
export interface Scenario extends ScenarioSummary {
  world: World;
  extras: ScenarioExtras;
}

export interface CreateScenarioRequest {
  name: string;
  notes?: string;
  tags?: string[];
  updatedBy?: WorldWriter;
  world: World;
  extras?: ScenarioExtras;
}

/** POST /api/world/scenarios/<id>/load. */
export interface LoadScenarioResponse {
  world: World;
  scenario: Scenario;
}

/** The world written on the server until a tab writes one (revision 0). Mirrors DEFAULT_WORLD in
 * app/backend/api/world.py; used only before the first GET answers. */
export const DEFAULT_WORLD: World = {
  schema: WORLD_SCHEMA,
  revision: 0,
  updatedAt: null,
  updatedBy: null,
  region: {
    kind: "catalogue",
    id: "berkeley-hills-tilden",
    name: "Berkeley Hills & Tilden",
    center: [-122.23, 37.895],
    radiusMeters: 15000,
    cellMeters: 60,
  },
  conditions: {
    startUtc: "2025-08-15T20:00:00Z",
    weather: { mode: "historical_replay" },
    moisture: { mode: "derived" },
  },
  fire: { ignitions: [], stochastic: { enabled: false, seed: 1 } },
  liveIncidentId: null,
  seed: 1,
};
