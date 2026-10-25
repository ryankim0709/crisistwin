import { useEffect, useState } from "react";
import { ROAD_ACCESS_URL, demoUrl, type RoadAccessResponse } from "./contracts";

/** While the server is still fetching OSM tags (`status` not "ready"), ask again this often. */
const RETRY_MS = 20_000;
const MAX_TRIES = 12;

export interface RoadAccessState {
  data: RoadAccessResponse | null;
  error: string | null;
}

/**
 * Drill roads closed to each apparatus class (GET /api/demo/road_access), for the board map's
 * "Roads trucks can't use" layer. Fetched only while `enabled`; refetched until the server's OSM
 * tags are loaded (`status: "ready"`), then kept per incident.
 */
export function useRoadAccess(incidentId: string, enabled: boolean): RoadAccessState {
  const [state, setState] = useState<{ incidentId: string; data: RoadAccessResponse | null; error: string | null }>(
    { incidentId, data: null, error: null },
  );
  const ready = state.incidentId === incidentId && state.data?.status === "ready";

  useEffect(() => {
    if (!enabled || ready) return;
    let cancelled = false;
    let timer: number | undefined;
    let tries = 0;
    const load = () => {
      tries += 1;
      fetch(demoUrl(ROAD_ACCESS_URL, incidentId), { headers: { Accept: "application/json" } })
        .then(async (response) => {
          const data = (await response.json().catch(() => null)) as (RoadAccessResponse & { detail?: string }) | null;
          if (!response.ok || !data || !Array.isArray(data.classes)) {
            throw new Error(data?.detail ?? `The road access service returned HTTP ${response.status}.`);
          }
          if (cancelled) return;
          setState({ incidentId, data, error: null });
          if (data.status !== "ready" && tries < MAX_TRIES) timer = window.setTimeout(load, RETRY_MS);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState((s) => ({ incidentId, data: s.incidentId === incidentId ? s.data : null, error: error instanceof Error ? error.message : "Road access unavailable." }));
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [incidentId, enabled, ready]);

  return state.incidentId === incidentId ? { data: state.data, error: state.error } : { data: null, error: null };
}
