/**
 * The board's only fire source: runs Simulation Studio published for the active incident
 * (GET /api/live/incidents/<id>/studio-fires, contracts.ts StudioFire), polled every
 * STUDIO_POLL_MS through the live API client. Fetch and validation here; which publishes a
 * board ingests is `studioBaseline` (pure) and the ingest itself is model.ts ingestStudioFire.
 *
 * Ingest rule, per board: Studio is the source of truth, so the board runs Studio's newest run only.
 * - when a board first reads the feed it takes the newest publish stored for the incident (the
 *   server keeps only the newest anyway: a publish clears the older ones, api/live/studio_fires.py).
 *   A reload, a Studio run published while Live command was closed, or one published while the
 *   board was still loading its landscape all show it. "Restart board" also restarts on it;
 * - a publish that appears later (a new Studio run) restarts the board on that run alone, at T+0
 *   (useCommandBoard.ts); a board still at T+0 with no Studio fire just takes it;
 * - "Reset board" deletes the stored publishes and starts empty.
 */

import { useCallback } from "react";
import { LiveError, request } from "../live/api";
import { usePoll, type PollState } from "../live/usePoll";
import type { StudioFire, StudioFiresResponse } from "./contracts";

export const STUDIO_POLL_MS = 5_000;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const MOISTURE_KEYS = ["dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"] as const;

/** A well-formed publish with at least one well-formed ignition, or null (the server validates too). */
function parseFire(raw: unknown): StudioFire | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const wind = f.wind as Record<string, unknown> | null;
  const moisture = f.moisture as Record<string, unknown> | null;
  const values = (moisture?.values ?? null) as Record<string, unknown> | null;
  if (!isStr(f.fire_id) || !isStr(f.published_at) || Number.isNaN(Date.parse(f.published_at)) || !isStr(f.incident_id)) return null;
  if (!wind || !isNum(wind.speed_mph) || wind.speed_mph < 0 || !isNum(wind.from_deg)) return null;
  if (!moisture || !values || !MOISTURE_KEYS.every((k) => isNum(values[k]) && (values[k] as number) > 0)) return null;
  if (!Array.isArray(f.ignitions)) return null;
  const ignitions = f.ignitions.flatMap((i: unknown) => {
    const g = (typeof i === "object" && i !== null ? i : {}) as Record<string, unknown>;
    if (!(isStr(g.id) && isNum(g.lon) && isNum(g.lat) && isNum(g.start_minute))) return [];
    // A set report time before the start (or not a number) is treated as not set: modelled.
    const report = isNum(g.report_minute) && g.report_minute >= g.start_minute ? g.report_minute : null;
    return [{ id: g.id, name: isStr(g.name) ? g.name : g.id, lon: g.lon, lat: g.lat, start_minute: g.start_minute, report_minute: report }];
  });
  if (ignitions.length === 0) return null;
  return {
    fire_id: f.fire_id,
    published_at: f.published_at,
    incident_id: f.incident_id,
    name: isStr(f.name) && f.name.trim() ? f.name.trim() : "Studio scenario",
    scenario_id: isStr(f.scenario_id) ? f.scenario_id : f.fire_id,
    region_id: isStr(f.region_id) ? f.region_id : "",
    ignitions,
    wind: {
      speed_mph: wind.speed_mph,
      from_deg: ((wind.from_deg % 360) + 360) % 360,
      source: isStr(wind.source) && wind.source ? wind.source : "assumed",
      label: isStr(wind.label) ? wind.label : "",
    },
    moisture: {
      preset: isStr(moisture.preset) ? moisture.preset : "custom",
      label: isStr(moisture.label) ? moisture.label : "",
      values: {
        dead1h: values.dead1h as number,
        dead10h: values.dead10h as number,
        dead100h: values.dead100h as number,
        liveHerb: values.liveHerb as number,
        liveWoody: values.liveWoody as number,
      },
    },
    horizon_minutes: isNum(f.horizon_minutes) ? f.horizon_minutes : 0,
    outside_drill: Array.isArray(f.outside_drill) ? f.outside_drill.filter(isStr) : [],
    weather_series: parseSeries(f.weather_series),
  };
}

function parseMoisture(raw: unknown): StudioFire["moisture"]["values"] | null {
  const v = (typeof raw === "object" && raw !== null ? raw : null) as Record<string, unknown> | null;
  if (!v || !MOISTURE_KEYS.every((k) => isNum(v[k]) && (v[k] as number) > 0)) return null;
  return { dead1h: v.dead1h as number, dead10h: v.dead10h as number, dead100h: v.dead100h as number, liveHerb: v.liveHerb as number, liveWoody: v.liveWoody as number };
}

/** The publish's hourly series, or null when absent or malformed (the board then runs `wind`). */
function parseSeries(raw: unknown): StudioFire["weather_series"] {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.samples) || s.samples.length === 0) return null;
  const samples: NonNullable<StudioFire["weather_series"]>["samples"] = [];
  for (const item of s.samples as unknown[]) {
    const g = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (!isNum(g.minute) || !isNum(g.wind_speed_mph) || g.wind_speed_mph < 0 || !isNum(g.wind_from_deg)) return null;
    if (samples.length > 0 && g.minute <= samples[samples.length - 1].minute) return null;
    samples.push({ minute: g.minute, wind_speed_mph: g.wind_speed_mph, wind_from_deg: ((g.wind_from_deg % 360) + 360) % 360, moisture: parseMoisture(g.moisture) });
  }
  return { source: isStr(s.source) ? s.source : "", evidence: isStr(s.evidence) ? s.evidence : "", samples };
}

export async function fetchStudioFires(token: string, incidentId: string, signal: AbortSignal): Promise<StudioFire[]> {
  const data = await request<Partial<StudioFiresResponse> | null>(
    token,
    "GET",
    `incidents/${encodeURIComponent(incidentId)}/studio-fires`,
    undefined,
    signal,
  );
  if (!data || !Array.isArray(data.fires)) throw new LiveError(200, "bad_response", "The Studio fire feed returned an unexpected response.");
  return data.fires.flatMap((f) => {
    const fire = parseFire(f);
    return fire && fire.incident_id === incidentId ? [fire] : [];
  });
}

/** Controller reset: deletes every published Studio fire of `incidentId` on the server. */
export async function clearStudioFires(token: string, incidentId: string): Promise<number> {
  const data = await request<{ deleted?: number } | null>(token, "DELETE", `incidents/${encodeURIComponent(incidentId)}/studio-fires`);
  return typeof data?.deleted === "number" ? data.deleted : 0;
}

/** The Studio feed for `incidentId` (null token = not polling). */
export function useStudioFires(token: string | null, incidentId: string): PollState<StudioFire[]> {
  const fetcher = useCallback((t: string, signal: AbortSignal) => fetchStudioFires(t, incidentId, signal), [incidentId]);
  return usePoll(token, fetcher, STUDIO_POLL_MS, "Studio fire feed");
}

/**
 * The publishes a board ignores, fixed at its first read of the feed: everything listed except,
 * when `recent` is true, the newest publish (Studio's last run).
 */
export function studioBaseline(fires: readonly StudioFire[], recent: boolean): string[] {
  let newest: StudioFire | null = null;
  if (recent) {
    for (const f of fires) {
      if (!newest || Date.parse(f.published_at) > Date.parse(newest.published_at) || (f.published_at === newest.published_at && f.fire_id > newest.fire_id)) newest = f;
    }
  }
  return fires.filter((f) => f !== newest).map((f) => f.fire_id);
}

/** Publishes not yet ingested by the board and not in its baseline, oldest first. */
export function studioFiresToIngest(fires: readonly StudioFire[], baseline: readonly string[], ingested: readonly string[]): StudioFire[] {
  return fires
    .filter((f) => !baseline.includes(f.fire_id) && !ingested.includes(f.fire_id))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.fire_id.localeCompare(b.fire_id));
}
