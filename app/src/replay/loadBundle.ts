import type { ReplayModel } from "./types";
import { parseBundle } from "./validate";

export const REPLAY_BUNDLE_URL = "/replays/camp-2018.json";
export const BUNDLE_GENERATE_HINT =
  "python3 -m sim ... bundle --output app/public/replays/camp-2018.json";

export class BundleMissingError extends Error {
  constructor(url: string, detail: string) {
    super(`No replay bundle at ${url} (${detail}).`);
    this.name = "BundleMissingError";
  }
}

export async function fetchReplayBundle(
  signal: AbortSignal,
  url = REPLAY_BUNDLE_URL,
): Promise<ReplayModel> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 404) throw new BundleMissingError(url, "HTTP 404");
  if (!response.ok) throw new Error(`Replay bundle request returned HTTP ${response.status}.`);

  // The Vite dev server answers unknown paths with index.html, so a missing file looks like HTML.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) throw new BundleMissingError(url, "server returned HTML");

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("The replay bundle is not valid JSON.");
  }
  return parseBundle(data);
}

/** What a view route loads and how it labels itself. /replay and /simulate share components. */
export interface ViewConfig {
  kind: "replay" | "simulation";
  bundleUrl: string;
  /** What-if variants index; null hides the control. */
  variantsUrl: string | null;
  /** Stress-test results; null hides the tab. */
  stressUrl: string | null;
  eyebrow: string;
  generateHint: string;
  /** The other route, for the header link. */
  otherRoute: { href: string; label: string };
  /** "Town, ST" from the incidents index, used to name the distance reference; null if unknown. */
  place: string | null;
  /** The incidents-index id (also the historical-fire id for the 3D view); null for simulations. */
  incidentId: string | null;
}

export const REPLAY_VIEW: ViewConfig = {
  kind: "replay",
  bundleUrl: REPLAY_BUNDLE_URL,
  variantsUrl: "/replays/camp-2018.variants/index.json",
  stressUrl: null,
  eyebrow: "Historical replay",
  generateHint: BUNDLE_GENERATE_HINT,
  otherRoute: { href: "/simulate", label: "Agent simulation →" },
  place: "Paradise, CA",
  incidentId: "camp-2018",
};

/** A fire the replay picker offers. Its bundle may not be generated yet; the picker checks. */
export interface ReplayIncident {
  id: string;
  label: string;
  place: string | null;
  bundleUrl: string;
  variantsUrl: string | null;
  generateHint: string;
}

/** Fallback list when /replays/index.json is missing or invalid. */
export const REPLAY_INCIDENTS: ReplayIncident[] = [
  {
    id: "camp-2018",
    label: "Camp Fire · Paradise, CA · Nov 2018",
    place: "Paradise, CA",
    bundleUrl: REPLAY_BUNDLE_URL,
    variantsUrl: "/replays/camp-2018.variants/index.json",
    generateHint: BUNDLE_GENERATE_HINT,
  },
  {
    id: "kincade-2019",
    label: "Kincade Fire · Sonoma County, CA · Oct 2019",
    place: "Sonoma County, CA",
    bundleUrl: "/replays/kincade-2019.json",
    variantsUrl: null,
    generateHint:
      "app/public/replays/kincade-2019.json (the sim bundle command supports only Camp so far)",
  },
  {
    id: "marshall-2021",
    label: "Marshall Fire · Boulder County, CO · Dec 2021",
    place: "Boulder County, CO",
    bundleUrl: "/replays/marshall-2021.json",
    variantsUrl: null,
    generateHint:
      "app/public/replays/marshall-2021.json (the sim bundle command supports only Camp so far)",
  },
];

export const DEFAULT_INCIDENT_ID = REPLAY_INCIDENTS[0].id;

export function replayViewFor(incident: ReplayIncident): ViewConfig {
  return {
    ...REPLAY_VIEW,
    bundleUrl: incident.bundleUrl,
    variantsUrl: incident.variantsUrl,
    generateHint: incident.generateHint,
    place: incident.place,
    incidentId: incident.id,
  };
}

export const INCIDENTS_INDEX_URL = "/replays/index.json";

/**
 * The incidents index written by the sim (`app/public/replays/index.json`). Lenient: entries
 * without an id or bundle file are skipped; returns null when the index is missing or empty,
 * so callers fall back to REPLAY_INCIDENTS.
 */
export async function fetchIncidents(signal: AbortSignal): Promise<ReplayIncident[] | null> {
  const response = await fetch(INCIDENTS_INDEX_URL, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok || (response.headers.get("content-type") ?? "").includes("text/html"))
    return null;
  const data: unknown = await response.json();
  const list = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        Array.isArray((data as { incidents?: unknown }).incidents)
      ? (data as { incidents: unknown[] }).incidents
      : [];
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const base = INCIDENTS_INDEX_URL.slice(0, INCIDENTS_INDEX_URL.lastIndexOf("/") + 1);
  const resolve = (file: string) =>
    file.startsWith("/") || /^https?:/.test(file) ? file : base + file;
  const out: ReplayIncident[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const id = text(e.id);
    const file = text(e.bundle) ?? text(e.bundle_file) ?? text(e.file);
    if (!id || !file) continue;
    const name = text(e.name) ?? id;
    const place = text(e.place);
    const date = text(e.date);
    const variants = text(e.variants) ?? text(e.variants_index);
    out.push({
      id,
      label: [name, place, date].filter(Boolean).join(" · "),
      place,
      bundleUrl: resolve(file),
      variantsUrl: variants
        ? resolve(variants)
        : (REPLAY_INCIDENTS.find((i) => i.id === id)?.variantsUrl ?? null),
      generateHint: `app/public/replays/${file}`,
    });
  }
  return out.length > 0 ? out : null;
}

/** Whether a bundle file is served, without downloading it (the Camp bundle is ~15 MB). */
export async function bundleExists(url: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url, { method: "HEAD", signal });
  // The Vite dev server answers unknown paths with index.html.
  return response.ok && !(response.headers.get("content-type") ?? "").includes("text/html");
}

export const SIMULATION_VIEW: ViewConfig = {
  kind: "simulation",
  bundleUrl: "/simulations/camp-2018.agents.json",
  variantsUrl: null,
  stressUrl: "/simulations/camp-2018.stress.json",
  eyebrow: "Agent simulation",
  generateHint: "app/public/simulations/camp-2018.agents.json",
  otherRoute: { href: "/replay", label: "Historical replay →" },
  place: "Paradise, CA",
  incidentId: null,
};
