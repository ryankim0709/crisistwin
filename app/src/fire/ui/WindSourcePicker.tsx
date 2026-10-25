import { useEffect, useId, useRef, useState } from "react";
import { Button, LoadingState, Notice, SegmentedControl, Tag, type TagTone } from "../../ui";
import {
  evidenceWord,
  fetchScenarioWind,
  stationLabel,
  windSummary,
  type ScenarioWeatherQuery,
  type ScenarioWindRecord,
  type WindCandidate,
  type WindSourceMode,
} from "../scenarioWeather";
import "./windPicker.css";

const OPTIONS = [
  { value: "assumed", label: "Assumed" },
  { value: "historical", label: "Historical" },
  { value: "worst_case", label: "Worst" },
  { value: "forecast", label: "Forecast" },
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const PERCENTILES = [90, 95, 99] as const;
/** Climatology uses the calendar month only; any year with archive coverage will do. */
const CLIMATOLOGY_YEAR = 2025;
/** Camp Fire ignition hour, UTC (2018-11-08 14:29Z): the validation case in docs. */
const DEFAULT_HISTORICAL = "2018-11-08T14:00";

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

function modeFromRecord(record: ScenarioWindRecord | null): WindSourceMode {
  if (!record) return "assumed";
  if (record.mode === "historical_replay") return "historical";
  if (record.mode === "climatology_percentile") return "worst_case";
  return "forecast";
}

/**
 * Wind source selector shared by /fire and the Studio. "Assumed" leaves the user's own wind
 * alone; the other three fetch hourly weather for the ignition point and hand back a record:
 * the page shows its peak hour on the wind controls and, unless the user holds the peak hour,
 * runs the whole hourly series (`weatherSeriesFromRecord`).
 */
export default function WindSourcePicker({
  lon,
  lat,
  horizonHours,
  record,
  onApply,
  usesSeries = false,
}: {
  /** Ignition point, WGS84. Null until one is placed. */
  lon: number | null;
  lat: number | null;
  /** Run length in whole hours; the series covers this window. */
  horizonHours: number;
  /** The weather behind the current wind, or null when it is the user's assumption. */
  record: ScenarioWindRecord | null;
  onApply: (record: ScenarioWindRecord | null) => void;
  /** True when the run follows the whole hourly series rather than the peak hour. */
  usesSeries?: boolean;
}) {
  const uid = useId();
  const [mode, setMode] = useState<WindSourceMode>(() => modeFromRecord(record));
  const [historical, setHistorical] = useState(DEFAULT_HISTORICAL);
  const [month, setMonth] = useState(11);
  const [percentile, setPercentile] = useState<number>(95);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Editing the wind by hand drops the record; the selector follows.
  const hadRecord = useRef(record !== null);
  useEffect(() => {
    if (record === null && hadRecord.current) setMode("assumed");
    hadRecord.current = record !== null;
  }, [record]);

  const hours = Math.max(1, Math.min(72, Math.ceil(horizonHours)));
  const noPoint = lon === null || lat === null;

  function choose(next: WindSourceMode) {
    setMode(next);
    setStatus({ kind: "idle" });
    abortRef.current?.abort();
    if (next === "assumed") onApply(null);
  }

  function apply() {
    if (lon === null || lat === null || mode === "assumed") return;
    const common = { lon, lat, hours };
    const query: ScenarioWeatherQuery =
      mode === "historical"
        ? { ...common, mode: "historical_replay" as const, startUtc: `${historical}:00Z` }
        : mode === "worst_case"
          ? {
              ...common,
              mode: "climatology_percentile" as const,
              startUtc: `${CLIMATOLOGY_YEAR}-${String(month).padStart(2, "0")}-01T00:00:00Z`,
              percentile,
            }
          : { ...common, mode: "forecast" as const };
    load(query);
  }

  /** Same window as the shown record, another station (or the reanalysis). */
  function pickStation(id: string) {
    if (!record || record.mode !== "historical_replay") return;
    const q = record.query;
    load({ mode: "historical_replay", lon: q.lon, lat: q.lat, startUtc: q.startUtc, hours: q.hours, station: id });
  }

  function load(query: ScenarioWeatherQuery) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: "loading" });
    fetchScenarioWind(query, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: "idle" });
        onApply(next);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          kind: "error",
          message: cause instanceof Error ? cause.message : "Could not load the weather.",
        });
      });
  }

  const showMode = record ? modeFromRecord(record) : mode;
  // Ranked alternatives, best first (sim/weather.py); stations without a wind sensor are left out.
  const pickable = (record?.candidates ?? []).filter((c) => c.status !== "no_wind_sensor");
  const chosenId =
    pickable.find((c) => c.status === "chosen")?.id ?? record?.station?.id ?? "reanalysis";
  return (
    <div className="fr-wp">
      <span className="fr-wp-title" id={`${uid}-title`}>
        Wind source
      </span>
      <SegmentedControl
        label="Wind source"
        options={OPTIONS}
        value={showMode}
        onChange={choose}
      />

      {mode === "historical" && (
        <label className="fr-wp-field" htmlFor={`${uid}-start`}>
          <span>Start (UTC)</span>
          <input
            id={`${uid}-start`}
            type="datetime-local"
            value={historical}
            onChange={(event) => setHistorical(event.target.value)}
          />
        </label>
      )}
      {mode === "worst_case" && (
        <div className="fr-wp-row">
          <label className="fr-wp-field" htmlFor={`${uid}-month`}>
            <span>Month</span>
            <select
              id={`${uid}-month`}
              value={month}
              onChange={(event) => setMonth(Number(event.target.value))}
            >
              {MONTHS.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="fr-wp-field" htmlFor={`${uid}-pct`}>
            <span>Offshore peak</span>
            <select
              id={`${uid}-pct`}
              value={percentile}
              onChange={(event) => setPercentile(Number(event.target.value))}
            >
              {PERCENTILES.map((value) => (
                <option key={value} value={value}>
                  P{value}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {mode === "forecast" && <p className="fr-wp-note">NWS forecast from the current hour.</p>}

      {mode !== "assumed" && (
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={apply}
          disabled={noPoint || status.kind === "loading"}
        >
          Apply wind
        </Button>
      )}
      {mode !== "assumed" && noPoint && <p className="fr-wp-note">Place an ignition first.</p>}
      {status.kind === "loading" && <LoadingState>Loading weather…</LoadingState>}
      {status.kind === "error" && <Notice tone="danger">{status.message}</Notice>}

      {record && (
        <div className="fr-wp-result">
          <div className="fr-wp-tags">
            <Tag tone={TONE[record.evidenceClass]}>{evidenceWord(record)}</Tag>
            <Tag>{stationLabel(record)}</Tag>
          </div>
          <p className="fr-wp-note">{windSummary(record)}</p>
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
              cell from canopy). Fuel moisture stays as set.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
