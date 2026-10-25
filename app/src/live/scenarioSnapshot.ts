/**
 * Scenario resource snapshot of the active drill (GET /api/live/incidents/<id>/snapshot;
 * contract and assumptions: docs/scenario-snapshots.md). Households, occupants and vehicles per
 * zone, and fire stations with their engines and which are available at the drill's start.
 * Values carry a basis (observed / estimated / synthetic / unknown); null means unknown, never 0.
 * Coordinates are WGS84 [lon, lat]; counts are households, persons and vehicles.
 */

import { useCallback } from "react";
import { request } from "./api";
import type { LonLat } from "./types";
import { usePoll, type PollState } from "./usePoll";

export type SnapshotBasis = "observed" | "estimated" | "synthetic" | "unknown";
export type EngineKind = "type1_engine" | "type3_engine";
export type EngineStatus = "available" | "committed" | "out_of_service";

export interface SnapshotEngine {
  engine_id: string;
  kind: EngineKind;
  status_at_start: EngineStatus;
  basis: SnapshotBasis;
}

export interface SnapshotStation {
  station_id: string;
  name: string;
  location: LonLat;
  basis: SnapshotBasis;
  station_class: string | null;
  source_id: string | null;
  engines: SnapshotEngine[];
  engines_total: number;
  engines_available: number;
}

export interface SnapshotZone {
  zone_id: string;
  name: string;
  households: number;
  /** null when any household's occupants are unknown (see known_occupants / unknown_households). */
  occupants: number | null;
  known_occupants: number;
  unknown_households: number;
  vehicles: number | null;
  evacuating_vehicles: number;
  needs_transport_households: number;
  needs_transport_occupants: number;
  drill_vehicles: number | null;
}

export interface SnapshotTotals {
  households: number;
  occupants: number | null;
  known_occupants: number;
  unknown_occupant_households: number;
  vehicles: number | null;
  unknown_vehicle_households: number;
  evacuating_vehicles: number;
  no_vehicle_households: number;
  needs_transport_households: number;
  needs_transport_occupants: number;
  stations: number;
  engines_total: number;
  engines_available: number;
  engines_committed: number;
  engines_out_of_service: number;
}

export interface ScenarioSnapshot {
  incident_id: string;
  snapshot_id: string;
  version: string;
  /** Drill start (T+0), ISO UTC. */
  scenario_time: string;
  created_at: string;
  label: string;
  sources: { id: string; name: string; url: string | null; license: string | null }[];
  /** The effective assumptions config, verbatim (tools/snapshot_assumptions.json). */
  assumptions: Record<string, unknown>;
  /** The assumptions file the snapshot was built with (path inside the backend, sha256). */
  config?: { path: string; sha256: string };
  basis: Record<string, SnapshotBasis | SnapshotBasis[]>;
  notes: string[];
  totals: SnapshotTotals;
  zones: SnapshotZone[];
  stations: SnapshotStation[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function pointOf(v: unknown): LonLat | null {
  if (!isObject(v) || !Array.isArray(v.coordinates)) return null;
  const [lon, lat] = v.coordinates as unknown[];
  return typeof lon === "number" && typeof lat === "number" ? [lon, lat] : null;
}

/** Validates the response shape; drops stations without a usable location. */
export function parseSnapshot(data: unknown): ScenarioSnapshot | null {
  if (!isObject(data) || typeof data.snapshot_id !== "string" || !isObject(data.totals)) return null;
  if (!Array.isArray(data.zones) || !Array.isArray(data.stations)) return null;
  const stations: SnapshotStation[] = [];
  for (const s of data.stations as unknown[]) {
    if (!isObject(s) || typeof s.station_id !== "string" || !Array.isArray(s.engines)) continue;
    const location = pointOf(s.location);
    if (!location) continue;
    stations.push({ ...(s as unknown as SnapshotStation), location });
  }
  return { ...(data as unknown as ScenarioSnapshot), stations };
}

export async function fetchSnapshot(token: string, incidentId: string, signal: AbortSignal): Promise<ScenarioSnapshot | null> {
  const data = await request<unknown>(token, "GET", `incidents/${encodeURIComponent(incidentId)}/snapshot`, undefined, signal);
  return parseSnapshot(data);
}

/**
 * The active drill's snapshot (null token = not loading). A snapshot changes only when it is
 * re-seeded, so this polls slowly; a 404 `no_snapshot` is an error the caller can show.
 */
export const SNAPSHOT_POLL_MS = 5 * 60_000;
export function useScenarioSnapshot(token: string | null, incidentId: string): PollState<ScenarioSnapshot | null> {
  const fetcher = useCallback((t: string, signal: AbortSignal) => fetchSnapshot(t, incidentId, signal), [incidentId]);
  return usePoll(token, fetcher, SNAPSHOT_POLL_MS, "Live API");
}
