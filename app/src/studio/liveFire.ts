/**
 * Studio run -> live fire. Pure payload builder and client for `POST /api/live/studio-fires`,
 * which starts the scenario's fires on the Live command page. Controller auth comes from the dev
 * proxy (vite.config.ts), like `postDrillPackage`.
 *
 * Units at this boundary: `lon`/`lat` WGS84 degrees; `start_minute` integer minutes from
 * scenario T+0; `report_minute` the integer minute on that clock the fire is reported to
 * dispatch, set by the user (start_minute <= report_minute <= 1440), or null when not set (Live
 * then models its own report delay); `wind.speed_mph` open 20 ft wind in mph; `wind.from_deg` bearing the wind blows
 * FROM, degrees true; moisture values are fractions (0.06 = 6%); `horizon_minutes` minutes.
 */

import { MOISTURE_PRESETS } from "../fire/spread";
import type { StudioRunResult } from "./contracts";

export interface LiveFirePayload {
  scenario_id: string;
  name: string;
  region_id: string;
  ignitions: {
    id: string;
    name: string;
    lon: number;
    lat: number;
    start_minute: number;
    report_minute: number | null;
  }[];
  wind: { speed_mph: number; from_deg: number; source: string; label: string };
  moisture: {
    preset: string;
    label: string;
    values: {
      dead1h: number;
      dead10h: number;
      dead100h: number;
      liveHerb: number;
      liveWoody: number;
    };
  };
  horizon_minutes: number;
}

export interface LiveFireResponse {
  fire_id: string;
  incident_id: string;
  incident_name: string;
  published_at: string;
  outside_drill: string[];
}

const MAX_NAME_LENGTH = 80;
const MOISTURE_MATCH_EPSILON = 1e-9;

const WEATHER_SOURCE = {
  historical_replay: { source: "historical", text: "historical wind" },
  climatology_percentile: { source: "worst_case", text: "worst-case wind" },
  forecast: { source: "forecast", text: "forecast wind" },
} as const;

/** The wind the run actually used (`settings`), described by where it came from. */
function windOf(result: StudioRunResult): LiveFirePayload["wind"] {
  const { settings, weather } = result.scenario;
  const speed = settings.windSpeedMph;
  const from = settings.windFromDegrees;
  if (!weather) {
    return {
      speed_mph: speed,
      from_deg: from,
      source: "assumed",
      label: "Assumed wind (set by hand in Simulation Studio)",
    };
  }
  const kind = WEATHER_SOURCE[weather.mode];
  const station = weather.station ? `, ${weather.station.name}` : "";
  return {
    speed_mph: speed,
    from_deg: from,
    source: kind.source,
    label: `Resolved ${kind.text} used by the run (peak hour, ${weather.source}${station})`,
  };
}

export function buildLiveFirePayload(result: StudioRunResult, regionId: string): LiveFirePayload {
  const { scenario } = result;
  const { moisture } = scenario.settings;
  const preset = MOISTURE_PRESETS.find((candidate) =>
    (Object.keys(candidate.moisture) as (keyof typeof moisture)[]).every(
      (key) => Math.abs(candidate.moisture[key] - moisture[key]) < MOISTURE_MATCH_EPSILON,
    ),
  );
  return {
    scenario_id: scenario.id,
    name: (scenario.name.trim() || "Studio scenario").slice(0, MAX_NAME_LENGTH),
    region_id: regionId,
    ignitions: scenario.ignitions
      .filter((ignition) => ignition.enabled)
      .map((ignition) => ({
        id: ignition.id,
        name: ignition.name,
        lon: ignition.location.longitude,
        lat: ignition.location.latitude,
        start_minute: Math.round(ignition.startMinute),
        report_minute:
          typeof ignition.reportMinute === "number" && Number.isFinite(ignition.reportMinute)
            ? Math.max(Math.round(ignition.reportMinute), Math.round(ignition.startMinute))
            : null,
      })),
    wind: windOf(result),
    moisture: {
      preset: preset?.id ?? "custom",
      label: preset?.label ?? "Custom",
      values: {
        dead1h: moisture.dead1h,
        dead10h: moisture.dead10h,
        dead100h: moisture.dead100h,
        liveHerb: moisture.liveHerb,
        liveWoody: moisture.liveWoody,
      },
    },
    horizon_minutes: scenario.settings.horizonMinutes,
  };
}

export async function postLiveFire(
  body: LiveFirePayload,
  signal?: AbortSignal,
): Promise<LiveFireResponse> {
  const response = await fetch("/api/live/studio-fires", {
    method: "POST",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const err = (data ?? {}) as { error?: string; detail?: string };
    if (response.status === 401 || response.status === 403) {
      throw new Error("The live server refused the controller request.");
    }
    throw new Error(
      err.detail ?? err.error?.replace(/_/g, " ") ?? `Live API returned HTTP ${response.status}.`,
    );
  }
  return data as LiveFireResponse;
}
