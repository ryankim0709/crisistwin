import { useEffect, useId, useRef, useState } from "react";
import { Button, LoadingState, Notice, SegmentedControl, Tag, type TagTone } from "../../ui";
import {
  evidenceWord,
  fetchScenarioWind,
  stationLabel,
  windSummary,
  type ScenarioWindRecord,
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
};

function modeFromRecord(record: ScenarioWindRecord | null): WindSourceMode {
  if (!record) return "assumed";
  if (record.mode === "historical_replay") return "historical";
  if (record.mode === "climatology_percentile") return "worst_case";
  return "forecast";
}

/**
 * Wind source selector shared by /fire and the Studio. "Assumed" leaves the user's own wind
 * alone; the other three fetch hourly weather for the ignition point and hand back a record
 * whose peak hour the page applies (the solver takes one wind per run).
 */
export default function WindSourcePicker({
  lon,
  lat,
  horizonHours,
  record,
  onApply,
}: {
  /** Ignition point, WGS84. Null until one is placed. */
  lon: number | null;
  lat: number | null;
  /** Run length in whole hours; the series covers this window. */
  horizonHours: number;
  /** The weather behind the current wind, or null when it is the user's assumption. */
  record: ScenarioWindRecord | null;
  onApply: (record: ScenarioWindRecord | null) => void;
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
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: "loading" });
    const common = { lon, lat, hours };
    const query =
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
          <details className="fr-wp-details">
            <summary>How this wind is used</summary>
            <p className="fr-wp-note">
              The solver takes one wind per run, so the peak hour of the {record.query.hours} h
              window is used; all {record.series.length} hourly values are recorded. Height:{" "}
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
