/**
 * A /run preset's weather schedule (DemoSeedPreset.weatherSchedule) as the solver's weather series
 * (fire/weatherSeries.ts) and as the live publish's `weather_series` (studio/liveFire.ts). Pure.
 *
 * The series interpolates linearly between samples and a 10-minute weather step reads it at its
 * start minute (weatherSeries.ts), so each segment boundary gets two samples: the old value one
 * step before the boundary and the new value at it. A boundary on a step minute is then an exact
 * step change, and the board re-solves once per boundary, not every 10 minutes.
 * Units: minutes from T+0, open 20 ft wind mph, FROM degrees true, moisture fractions.
 */

import { MOISTURE_PRESETS } from "../fire/spread";
import { WEATHER_STEP_MINUTES, type FireWeatherSeries } from "../fire/weatherSeries";
import type { DemoSeedPreset } from "../demo/runContracts";
import type { LiveWeatherSeries } from "../studio/liveFire";

type Segment = NonNullable<DemoSeedPreset["weatherSchedule"]>[number];

const moistureOf = (id: Segment["moisturePreset"]) => ({ ...(MOISTURE_PRESETS.find((m) => m.id === id) ?? MOISTURE_PRESETS[0]).moisture });

function sample(minute: number, s: Segment): FireWeatherSeries["samples"][number] {
  return { minute, windSpeedMph: s.windSpeedMph, windFromDegrees: ((Math.round(s.fromDeg) % 360) + 360) % 360, moisture: moistureOf(s.moisturePreset) };
}

/** The schedule as solver samples, or null without one. */
export function presetWeatherSeries(preset: DemoSeedPreset): FireWeatherSeries | null {
  const segments = preset.weatherSchedule;
  if (!segments || segments.length === 0) return null;
  const samples: FireWeatherSeries["samples"] = [];
  segments.forEach((seg, i) => {
    if (i > 0) {
      const holdAt = seg.fromMinute - WEATHER_STEP_MINUTES;
      if (holdAt > samples[samples.length - 1].minute) samples.push(sample(holdAt, segments[i - 1]));
    }
    samples.push(sample(i === 0 ? 0 : seg.fromMinute, seg));
  });
  return { enabled: true, samples, source: `Demo preset weather schedule (${preset.id}), assumed`, evidence: "assumed" };
}

/** The schedule as the live publish's weather series, or null. */
export function presetLiveWeatherSeries(preset: DemoSeedPreset): LiveWeatherSeries | null {
  const series = presetWeatherSeries(preset);
  if (!series) return null;
  return {
    source: series.source ?? "assumed",
    evidence: "assumed",
    samples: series.samples.map((s) => ({
      minute: s.minute,
      wind_speed_mph: s.windSpeedMph,
      wind_from_deg: s.windFromDegrees,
      moisture: s.moisture ? { ...s.moisture } : null,
    })),
  };
}
