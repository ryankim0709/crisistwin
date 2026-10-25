/**
 * The board's only fire source: runs Simulation Studio published for the active incident
 * (GET /api/live/incidents/<id>/studio-fires, contracts.ts StudioFire), polled every
 * STUDIO_POLL_MS through the live API client. Fetch and validation here; which publishes a
 * board ingests is `studioBaseline` (pure) and the ingest itself is model.ts ingestStudioFire.
 *
 * Ingest rule, per board (each publish is ingested at most once per board, by fire_id):
 * - every publish that appears after the board first read the feed is ingested when it appears;
 * - when a board first reads the feed, the publishes already stored for the incident are
 *   ingested too, the newest per Studio scenario only (re-running one scenario supersedes its
 *   earlier runs). The stored feed is the drill's fire: a reload, a Studio run published while
 *   Live command was closed, or one published while the board was still loading its landscape
 *   all show it. "Reset board" deletes the stored publishes;
 * - "Restart board" ingests none of the publishes already listed: a restart starts empty.
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
  };
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
 * when `recent` is true, the newest publish per scenario.
 */
export function studioBaseline(fires: readonly StudioFire[], recent: boolean): string[] {
  const keep = new Set<string>();
  if (recent) {
    const newestByScenario = new Map<string, StudioFire>();
    for (const f of fires) {
      const cur = newestByScenario.get(f.scenario_id);
      if (!cur || Date.parse(f.published_at) > Date.parse(cur.published_at)) newestByScenario.set(f.scenario_id, f);
    }
    for (const f of newestByScenario.values()) keep.add(f.fire_id);
  }
  return fires.filter((f) => !keep.has(f.fire_id)).map((f) => f.fire_id);
}

/** Publishes not yet ingested by the board and not in its baseline, oldest first. */
export function studioFiresToIngest(fires: readonly StudioFire[], baseline: readonly string[], ingested: readonly string[]): StudioFire[] {
  return fires
    .filter((f) => !baseline.includes(f.fire_id) && !ingested.includes(f.fire_id))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.fire_id.localeCompare(b.fire_id));
}
