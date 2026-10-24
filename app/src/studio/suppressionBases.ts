/**
 * CAL FIRE stations, crew camps, helitack and air attack bases near a fire, from
 * `GET /api/suppression/bases` (app/backend/api/suppression_bases.py), which reads the
 * local-only tools/ca_fire_bases.json (CAL FIRE Facilities for Wildland Fire Protection; no
 * open licence stated, so the file is not in git). When the file is absent the endpoint answers
 * `available: false` and the model runs without aircraft bases or off-board mutual aid.
 *
 * Units: WGS84 degrees; distance in km (great circle, from the endpoint).
 */

import { useEffect, useState } from "react";
import type { AirBase } from "./aircraft";

export const SUPPRESSION_BASES_URL = "/api/suppression/bases";

export interface SuppressionBase {
  id: string;
  name: string;
  /** FSA, FSB, FSAB, FSL, FSCC, FSO (stations), CC, FCFFC (crews), HB, AAB. */
  type: string;
  agency: string;
  unit: string | null;
  lon: number;
  lat: number;
  distanceKm: number;
}

export interface SuppressionBases {
  available: boolean;
  bases: SuppressionBase[];
  attribution: string | null;
  detail: string | null;
}

export const STATION_TYPES = new Set(["FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"]);
export const CREW_TYPES = new Set(["CC", "FCFFC"]);

export function airBasesOf(bases: SuppressionBases | null): AirBase[] | null {
  if (!bases?.available) return null;
  return bases.bases
    .filter((b): b is SuppressionBase & { type: "HB" | "AAB" } => b.type === "HB" || b.type === "AAB")
    .map(({ id, name, type, lon, lat }) => ({ id, name, type, lon, lat }));
}

export function parseBases(json: unknown): SuppressionBases {
  const raw = (json ?? {}) as Record<string, unknown>;
  const list = Array.isArray(raw.bases) ? raw.bases : [];
  const bases: SuppressionBase[] = list.flatMap((value) => {
    const b = value as Record<string, unknown>;
    if (typeof b.lon !== "number" || typeof b.lat !== "number" || typeof b.type !== "string") return [];
    return [
      {
        id: String(b.id),
        name: String(b.name ?? b.id),
        type: b.type,
        agency: String(b.agency ?? ""),
        unit: typeof b.unit === "string" ? b.unit : null,
        lon: b.lon,
        lat: b.lat,
        distanceKm: Number(b.distanceKm ?? 0),
      },
    ];
  });
  return {
    available: raw.available === true,
    bases,
    attribution: typeof raw.attribution === "string" ? raw.attribution : null,
    detail: typeof raw.detail === "string" ? raw.detail : null,
  };
}

/** Bases around `point` ([lon, lat]); null while loading or when the request failed. */
export function useSuppressionBases(point: [number, number] | null): SuppressionBases | null {
  const key = point ? `${point[0].toFixed(3)},${point[1].toFixed(3)}` : null;
  const [state, setState] = useState<{ key: string | null; value: SuppressionBases | null }>({
    key: null,
    value: null,
  });
  useEffect(() => {
    if (!key) return;
    const [lon, lat] = key.split(",");
    const controller = new AbortController();
    fetch(`${SUPPRESSION_BASES_URL}?lon=${lon}&lat=${lat}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => setState({ key, value: json ? parseBases(json) : null }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, value: null });
      });
    return () => controller.abort();
  }, [key]);
  return state.key === key ? state.value : null;
}
