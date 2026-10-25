/**
 * Which Studio region the Live command drill is on. `GET /api/live/active` names the active
 * incident and, for a Studio drill package, its `region_id` (the board id the package's run used,
 * docs/live-reports.md "Active incident"); older servers only give `package_id`, which is mapped
 * through the package summaries (`GET /api/live/packages`, `summary.region_id`).
 */

import {
  fetchPackages,
  parseActive,
  type ActiveIncident,
  type StoredPackage,
} from "../live/active";
import { LiveError, readToken, request, SERVER_TOKEN } from "../live/api";

export interface LiveDrill {
  active: ActiveIncident;
  /** Studio region id of the drill, or null (Camp replay, or a package without one). */
  regionId: string | null;
}

export const liveToken = (): string => readToken() ?? SERVER_TOKEN;

export function packageRegionId(pkg: StoredPackage): string | null {
  const id = pkg.summary.region_id;
  return typeof id === "string" && id ? id : null;
}

export async function fetchLiveDrill(signal: AbortSignal): Promise<LiveDrill> {
  const data = await request<unknown>(liveToken(), "GET", "active", undefined, signal);
  const active = parseActive(data);
  if (!active) {
    throw new LiveError(200, "bad_response", "The live API returned an unexpected response.");
  }
  const raw = (data as { region_id?: unknown }).region_id;
  let regionId = typeof raw === "string" && raw ? raw : null;
  if (
    regionId === null &&
    active.source === "package" &&
    active.package_id &&
    !("region_id" in (data as object))
  ) {
    const packages = await fetchPackages(liveToken(), signal);
    const pkg = packages.find((candidate) => candidate.package_id === active.package_id);
    regionId = pkg ? packageRegionId(pkg) : null;
  }
  return { active, regionId };
}
