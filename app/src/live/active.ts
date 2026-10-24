// The one active wildfire of the hosted instance (GET/POST /api/live/active, GET /api/live/packages).
import { DEFAULT_INCIDENT_ID, LiveError, request } from "./api";

export interface ActiveIncident {
  incident_id: string;
  name: string;
  mode: "drill";
  label: string;
  join: { invite_required: boolean };
  source: "bundle" | "package";
  package_id: string | null;
  activated_at: string | null;
}

export interface StoredPackage {
  package_id: string;
  incident_id: string;
  created_at: string;
  summary: { name: string; place: string; zones: number; homes: number; [key: string]: unknown };
}

export const CAMP_OPTION = { incident_id: DEFAULT_INCIDENT_ID, name: "Camp Fire 2018 replay" } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseActive(data: unknown): ActiveIncident | null {
  if (!isObject(data) || typeof data.incident_id !== "string" || !data.incident_id) return null;
  return {
    incident_id: data.incident_id,
    name: typeof data.name === "string" && data.name ? data.name : data.incident_id,
    mode: "drill",
    label: typeof data.label === "string" ? data.label : "",
    join: { invite_required: isObject(data.join) && data.join.invite_required === true },
    source: data.source === "package" ? "package" : "bundle",
    package_id: typeof data.package_id === "string" ? data.package_id : null,
    activated_at: typeof data.activated_at === "string" ? data.activated_at : null,
  };
}

/** Drops malformed rows; keeps the server's newest-first order. */
export function parsePackages(data: unknown): StoredPackage[] {
  if (!isObject(data) || !Array.isArray(data.packages)) return [];
  const out: StoredPackage[] = [];
  for (const p of data.packages) {
    if (!isObject(p) || typeof p.package_id !== "string" || typeof p.incident_id !== "string") continue;
    const s = isObject(p.summary) ? p.summary : {};
    out.push({
      package_id: p.package_id,
      incident_id: p.incident_id,
      created_at: typeof p.created_at === "string" ? p.created_at : "",
      summary: {
        ...s,
        name: typeof s.name === "string" && s.name ? s.name : p.package_id,
        place: typeof s.place === "string" ? s.place : "",
        zones: typeof s.zones === "number" ? s.zones : 0,
        homes: typeof s.homes === "number" ? s.homes : 0,
      },
    });
  }
  return out;
}

export async function fetchActive(token: string, signal: AbortSignal): Promise<ActiveIncident> {
  const active = parseActive(await request<unknown>(token, "GET", "active", undefined, signal));
  if (!active) throw new LiveError(200, "bad_response", "The live API returned an unexpected response.");
  return active;
}

export async function fetchPackages(token: string, signal?: AbortSignal): Promise<StoredPackage[]> {
  return parsePackages(await request<unknown>(token, "GET", "packages", undefined, signal));
}

export type ActivateTarget = { package_id: string } | { incident_id: string };

export async function activate(
  token: string,
  target: ActivateTarget,
): Promise<{ active: ActiveIncident; changed: boolean }> {
  const data = await request<unknown>(token, "POST", "active", target);
  const active = isObject(data) ? parseActive(data.active) : null;
  if (!active) throw new LiveError(200, "bad_response", "The live API returned an unexpected response.");
  return { active, changed: isObject(data) && data.changed === true };
}

/** Whether `target` is the incident currently live. */
export const isCurrent = (active: ActiveIncident | null, target: ActivateTarget): boolean =>
  !!active &&
  ("package_id" in target
    ? active.package_id === target.package_id
    : active.package_id === null && active.incident_id === target.incident_id);
