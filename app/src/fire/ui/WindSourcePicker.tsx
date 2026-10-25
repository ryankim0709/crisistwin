import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LoadingState, Notice, SegmentedControl, Tag, type TagTone } from "../../ui";
import {
  evidenceWord,
  fetchScenarioWind,
  stationLabel,
  windSummary,
  type ScenarioWeatherQuery,
  type ScenarioWindRecord,
  type WindCandidate,
} from "../scenarioWeather";
import { MAX_WEATHER_HOURS } from "../horizon";
import {
  fetchAllConditionPresets,
  fetchConditions,
  type Conditions,
  type RegionConditionsPresets,
} from "../../world/conditions";
import "./windPicker.css";

const OPTIONS = [
  { value: "historical", label: "Historical" },
  { value: "custom", label: "Custom" },
] as const;
type PickerMode = (typeof OPTIONS)[number]["value"];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Camp Fire ignition hour, UTC (2018-11-08 14:29Z): the validation case in docs. */
const DEFAULT_HISTORICAL = "2018-11-08T14:00";
const FALLBACK_YEAR = "2025";
/** Assumed peak-season date when the presets service is unreachable. */
const FALLBACK_SEASON_DATE = "09-15";
const TYPICAL_HOUR_UTC = "20";

interface PresetChoice {
  id: string;
  label: string;
  query: Omit<ScenarioWeatherQuery, "hours" | "lon" | "lat">;
}

let allPresets: Promise<RegionConditionsPresets[]> | null = null;
/** The presets of the catalogue region or historical fire whose centre is nearest the point. */
async function presetsNear(lon: number, lat: number): Promise<RegionConditionsPresets | null> {
  allPresets ??= fetchAllConditionPresets().catch((cause) => {
    allPresets = null;
    throw cause;
  });
  const all = await allPresets;
  const k = Math.cos((lat * Math.PI) / 180);
  let best: RegionConditionsPresets | null = null;
  let bestD = Infinity;
  for (const r of all) {
    const d = ((r.region.center[0] - lon) * k) ** 2 + (r.region.center[1] - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

function dayLabel(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1] ?? ""}`;
}

function choicesFor(presets: RegionConditionsPresets | null): PresetChoice[] {
  const year = presets?.presets[0]?.query.startUtc?.slice(0, 4) ?? FALLBACK_YEAR;
  const mmdd = presets?.typicalSeasonDate ?? FALLBACK_SEASON_DATE;
  const start = `${year}-${mmdd}T${TYPICAL_HOUR_UTC}:00:00Z`;
  const out: PresetChoice[] = [
    {
      id: "typical",
      label: `Typical fire-season day (observed, ${dayLabel(start)})`,
      query: { mode: "historical_replay", startUtc: start },
    },
  ];
  for (const p of presets?.presets ?? []) {
    const q = p.query;
    if (p.id === "actual-ignition" && q.startUtc) {
      out.push({
        id: p.id,
        label: `Actual ignition day (observed, ${dayLabel(q.startUtc)})`,
        query: { mode: "historical_replay", startUtc: q.startUtc },
      });
    } else if (q.mode === "climatology_percentile" && q.startUtc) {
      const pct = q.percentile ?? 95;
      out.push({
        id: p.id,
        label: pct >= 90 ? `Bad fire-weather day (${pct}th percentile)` : `Median wind day (${pct}th percentile)`,
        query: { mode: "climatology_percentile", startUtc: q.startUtc, percentile: pct },
      });
    }
  }
  return out;
}

const TONE: Record<ScenarioWindRecord["evidenceClass"], TagTone> = {
  observed: "success",
  forecast: "info",
  derived: "warning",
  modelled: "neutral",
};

/** "OAKLAND NORTH RAWS (ONOC1), 3.4 km, +33 m, 100% of hours" for the station dropdown. */
function candidateLabel(c: WindCandidate): string {
  if (c.id === "reanalysis") return "ERA5 reanalysis (modelled)";
  const parts = [`${c.name} (${c.id})`];
  if (c.distanceKm !== null) parts.push(`${c.distanceKm.toFixed(1)} km`);
  if (c.elevationDiffM !== null) parts.push(`${c.elevationDiffM >= 0 ? "+" : ""}${Math.round(c.elevationDiffM)} m`);
  if (c.coverage !== null) parts.push(`${Math.round(c.coverage * 100)}% of hours`);
  return parts.join(", ");
}

const FORECAST_ID = "forecast";
const DATE_ID = "date";

function queryKey(q: ScenarioWeatherQuery): string {
  return [q.mode, q.lon.toFixed(3), q.lat.toFixed(3), q.startUtc ?? "", q.hours, q.percentile ?? ""].join("|");
}

/**
 * Wind source selector shared by /fire and the Studio. Two choices: "Historical" (default) loads
 * the real hourly weather for the nearest region's preset day (or a picked date, or the NWS
 * forecast) as soon as the region or preset changes, and the run follows that hourly series
 * (`weatherSeriesFromRecord`); "Custom" leaves the page's fixed wind sliders in charge.
 */
export default function WindSourcePicker({
  lon,
  lat,
  horizonHours,
  record,
  onApply,
  usesSeries = false,
  moistureFromWeather = false,
}: {
  /** Ignition point, WGS84. Null until one is placed. */
  lon: number | null;
  lat: number | null;
  /** Run length in whole hours; the series covers this window. */
  horizonHours: number;
  /** The weather behind the current wind, or null when it is the user's assumption. */
  record: ScenarioWindRecord | null;
  /**
   * `conditions`: the same window from /api/conditions (per-hour fuel moisture), or null when
   * that call failed. Pages that ignore it keep their own moisture.
   */
  onApply: (record: ScenarioWindRecord | null, conditions?: Conditions | null) => void;
  /** True when the run follows the whole hourly series rather than the peak hour. */
  usesSeries?: boolean;
  /** True when the page took fuel moisture from the date's weather too. */
  moistureFromWeather?: boolean;
}) {
  const uid = useId();
  const [mode, setMode] = useState<PickerMode>("historical");
  const [selection, setSelection] = useState<string>("typical");
  const [dateValue, setDateValue] = useState(DEFAULT_HISTORICAL);
  const [presets, setPresets] = useState<RegionConditionsPresets | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const lastKey = useRef<string | null>(null);
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  useEffect(() => () => abortRef.current?.abort(), []);

  const lonR = lon === null ? null : Math.round(lon * 1000) / 1000;
  const latR = lat === null ? null : Math.round(lat * 1000) / 1000;
  const noPoint = lonR === null || latR === null;
  const hours = Math.max(1, Math.min(MAX_WEATHER_HOURS, Math.ceil(horizonHours)));

  // The nearest region's presets, refreshed when the ignition moves to another region.
  useEffect(() => {
    if (lonR === null || latR === null) return;
    let live = true;
    presetsNear(lonR, latR)
      .then((next) => {
        if (live) setPresets((prev) => (prev?.region.id === next?.region.id ? prev : next));
      })
      .catch(() => {
        if (live) setPresets(null);
      });
    return () => {
      live = false;
    };
  }, [lonR, latR]);
  const choices = useMemo(() => choicesFor(presets), [presets]);

  // Editing the wind by hand drops the record; the selector follows. A record set from outside
  // (the shared world, a loaded scenario) shows its own date and preset here.
  const hadRecord = useRef(record !== null);
  useEffect(() => {
    if (record === null && hadRecord.current) setMode("custom");
    hadRecord.current = record !== null;
    if (!record) return;
    setMode("historical");
    setFallback(null);
    const key = queryKey({ ...record.query, mode: record.mode });
    if (key === lastKey.current) return;
    lastKey.current = key;
    const start = record.query.startUtc;
    if (record.mode === "forecast") setSelection(FORECAST_ID);
    else if (record.mode === "historical_replay") {
      const match = choices.find((c) => c.query.mode === "historical_replay" && c.query.startUtc === start);
      setSelection(match?.id ?? DATE_ID);
      if (!match && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start)) setDateValue(start.slice(0, 16));
    } else {
      const match = choices.find(
        (c) => c.query.mode === "climatology_percentile" && c.query.percentile === record.query.percentile,
      );
      if (match) setSelection(match.id);
    }
  }, [record, choices]);

  const episodeHours =
    record?.mode === "climatology_percentile"
      ? (record.analog as { episode_hours?: number } | null)?.episode_hours ?? null
      : null;

  let wanted: ScenarioWeatherQuery | null = null;
  if (lonR !== null && latR !== null) {
    const common = { lon: lonR, lat: latR, hours };
    if (selection === FORECAST_ID) wanted = { ...common, mode: "forecast" };
    else if (selection === DATE_ID) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateValue)) {
        wanted = { ...common, mode: "historical_replay", startUtc: `${dateValue}:00Z` };
      }
    } else {
      const choice = choices.find((c) => c.id === selection) ?? choices[0];
      if (choice) wanted = { ...common, ...choice.query };
    }
  }
  const wantedKey = wanted ? queryKey(wanted) : null;

  // Loads the weather automatically whenever the region, preset or run length changes.
  useEffect(() => {
    if (mode !== "historical" || !wanted || wantedKey === lastKey.current) return;
    lastKey.current = wantedKey;
    load(wanted, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, wantedKey]);

  function choose(next: PickerMode) {
    setMode(next);
    setStatus({ kind: "idle" });
    setFallback(null);
    abortRef.current?.abort();
    if (next === "custom") onApply(null);
    else lastKey.current = null;
  }

  /** Same window as the shown record, another station (or the reanalysis). */
  function pickStation(id: string) {
    if (!record || record.mode !== "historical_replay") return;
    const q = record.query;
    load({ mode: "historical_replay", lon: q.lon, lat: q.lat, startUtc: q.startUtc, hours: q.hours, station: id }, false);
  }

  function load(query: ScenarioWeatherQuery, fallBackToCustom: boolean) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: "loading" });
    // The same window's fuel moisture from the date's weather (/api/conditions). Wind still
    // comes from /api/weather/scenario (station choice, height conversion); a failed
    // conditions call leaves moisture as set rather than blocking the wind.
    const conditions = fetchConditions(
      {
        lon: query.lon,
        lat: query.lat,
        mode: query.mode,
        hours: query.hours,
        ...(query.startUtc ? { startUtc: query.startUtc } : {}),
        ...(query.percentile !== undefined ? { percentile: query.percentile } : {}),
      },
      controller.signal,
    ).catch(() => null);
    Promise.all([fetchScenarioWind(query, controller.signal), conditions])
      .then(([next, cond]) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: "idle" });
        setFallback(null);
        onApplyRef.current(next, cond);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (fallBackToCustom) {
          setStatus({ kind: "idle" });
          setMode("custom");
          setFallback(
            query.mode === "forecast"
              ? "No forecast available here right now — using a fixed wind."
              : "No weather records near here for that date — using a fixed wind.",
          );
          onApplyRef.current(null);
          return;
        }
        setStatus({
          kind: "error",
          message: cause instanceof Error ? cause.message : "Could not load the weather.",
        });
      });
  }

  const showMode: PickerMode = record ? "historical" : mode;
  // Ranked alternatives, best first (sim/weather.py); stations without a wind sensor are left out.
  const pickable = (record?.candidates ?? []).filter((c) => c.status !== "no_wind_sensor");
  const chosenId =
    pickable.find((c) => c.status === "chosen")?.id ?? record?.station?.id ?? "reanalysis";
  return (
    <div className="fr-wp">
      <span className="fr-wp-title" id={`${uid}-title`}>
        Wind source
      </span>
      <SegmentedControl label="Wind source" options={OPTIONS} value={showMode} onChange={choose} />

      {showMode === "historical" && (
        <>
          <label className="fr-wp-field" htmlFor={`${uid}-preset`}>
            <span>Weather day</span>
            <select
              id={`${uid}-preset`}
              value={selection}
              disabled={noPoint}
              onChange={(event) => setSelection(event.target.value)}
            >
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
              <option value={FORECAST_ID}>Next 3 days (forecast)</option>
              <option value={DATE_ID}>Pick a date…</option>
            </select>
          </label>
          {selection === DATE_ID && (
            <label className="fr-wp-field" htmlFor={`${uid}-start`}>
              <span>Start (UTC)</span>
              <input
                id={`${uid}-start`}
                type="datetime-local"
                value={dateValue}
                onChange={(event) => setDateValue(event.target.value)}
              />
            </label>
          )}
          {noPoint && <p className="fr-wp-note">Place an ignition to load the weather.</p>}
          {status.kind === "loading" && <LoadingState>Loading weather…</LoadingState>}
          {status.kind === "error" && <Notice tone="danger">{status.message}</Notice>}
        </>
      )}
      {showMode === "custom" && (
        <>
          <p className="fr-wp-note">One wind for the whole run: set speed and direction below.</p>
          {fallback && <Notice tone="warning">{fallback}</Notice>}
        </>
      )}

      {showMode === "historical" && record && (
        <div className="fr-wp-result">
          <div className="fr-wp-tags">
            <Tag tone={TONE[record.evidenceClass]}>{evidenceWord(record)}</Tag>
            <Tag>{stationLabel(record)}</Tag>
          </div>
          <p className="fr-wp-note">{windSummary(record)}</p>
          {episodeHours !== null && episodeHours < record.query.hours && (
            <p className="fr-wp-note">
              The offshore wind episode lasted {episodeHours} h. The rest of the run follows the
              real hours that came after it, so the wind usually eases.
            </p>
          )}
          {(record.warnings ?? []).length > 0 && (
            <Notice tone="warning">{(record.warnings ?? []).join(" ")}</Notice>
          )}
          {record.mode === "historical_replay" && pickable.length > 1 && (
            <label className="fr-wp-field" htmlFor={`${uid}-station`}>
              <span>Station</span>
              <select
                id={`${uid}-station`}
                value={chosenId}
                disabled={status.kind === "loading"}
                onChange={(event) => pickStation(event.target.value)}
              >
                {pickable.map((c) => (
                  <option key={c.id} value={c.id} title={c.reason}>
                    {candidateLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <details className="fr-wp-details">
            <summary>How this wind is used</summary>
            <p className="fr-wp-note">
              {usesSeries
                ? `The run follows all ${record.series.length} hourly values of the ${record.query.hours} h window: a cell spreads with the wind of the 10-minute step it ignites in (direction interpolated around the compass). The wind controls show the peak hour.`
                : `The peak hour of the ${record.query.hours} h window is held for the whole run; all ${record.series.length} hourly values are recorded.`}{" "}
              Height:{" "}
              {record.heightConversion.fromHeight} to open 20 ft, {record.heightConversion.method}.
              The midflame factor then cuts the 20 ft wind to flame height (default 0.5, or per
              cell from canopy).{" "}
              {moistureFromWeather
                ? "Fuel moisture follows the same hours: dead fuel from that day's temperature and humidity, live fuel from the season."
                : "Fuel moisture stays as set."}
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
