import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, EvidenceTag, LinkButton, LoadingState, Notice, Page, Panel, Tag } from "../../ui";
import { drillClock, drillDate, shortZoneName, wallClock } from "../format";
import { fetchAar } from "./api";
import type { AarComponent, AarResponse, AarZone } from "./types";
import "./report.css";

const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "–" : v.toFixed(digits));

function rawText(c: AarComponent): string {
  if (c.raw === null) return "no data";
  if (c.id === "arrived_share") return `${(c.raw * 100).toFixed(1)}%`;
  if (c.id === "exposed_trapped") return `${c.raw.toFixed(2)} veh-min/veh`;
  if (c.id === "help_to_assign") return `${c.raw.toFixed(1)} min`;
  return `${c.raw > 0 ? "+" : ""}${c.raw.toFixed(1)} min`;
}

function ScoreCard({ data }: { data: AarResponse }) {
  const { score } = data;
  return (
    <Panel title="Drill score" aside={<Tag>{`${Math.round(score.coverage * 100)}% of weight counted`}</Tag>}>
      <div className="aar-score">
        <div className="aar-score-head">
          <span className="aar-score-value" aria-label={`Score ${score.value ?? "unavailable"} of ${score.max}`}>
            {score.value === null ? "–" : score.value.toFixed(1)}
            <small> / {score.max}</small>
          </span>
          <EvidenceTag kind="simulated" />
        </div>
        {data.twin.status !== "ok" ? (
          <Notice tone="warning" compact>
            Twin {data.twin.status}: simulated components are not counted yet.
          </Notice>
        ) : null}
        <ul className="aar-comps">
          {score.components.map((c) => (
            <li key={c.id} className="aar-comp">
              <span className="aar-comp-title">
                <strong>{c.label}</strong>
                <EvidenceTag kind={c.evidence_class} />
              </span>
              <span className="aar-num">
                {c.points === null ? "–" : c.points.toFixed(1)} pts
              </span>
              <span className="aar-bar" role="img" aria-label={`Component score ${fmt(c.score === null ? null : c.score * 100, 0)} of 100`}>
                <span style={{ width: `${(c.score ?? 0) * 100}%` }} />
              </span>
              <small>
                {rawText(c)} · weight {(c.weight * 100).toFixed(0)}%
                {c.effective_weight !== null && c.effective_weight !== c.weight
                  ? ` (counted ${(c.effective_weight * 100).toFixed(0)}%)`
                  : ""}
              </small>
              <small>{c.rule}</small>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

type SortKey = "name" | "vehicles" | "arrived_veh" | "first_leave_now_at" | "leave_now_vs_2018_min" | "guidance_changes" | "triage_median_min" | "help_to_assign_median_min";
const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "name", label: "Zone" },
  { key: "vehicles", label: "Vehicles", num: true },
  { key: "arrived_veh", label: "Arrived", num: true },
  { key: "first_leave_now_at", label: "Leave now" },
  { key: "leave_now_vs_2018_min", label: "vs 2018 (min)", num: true },
  { key: "guidance_changes", label: "Changes", num: true },
  { key: "triage_median_min", label: "Triage (min)", num: true },
  { key: "help_to_assign_median_min", label: "Help to assign (min)", num: true },
];

function compare(a: AarZone, b: AarZone, key: SortKey, dir: 1 | -1): number {
  const x = a[key] ?? null;
  const y = b[key] ?? null;
  if (x === null && y === null) return 0;
  if (x === null) return 1; // empty values last in either direction
  if (y === null) return -1;
  return (x < y ? -1 : x > y ? 1 : 0) * dir;
}

function vs2018(z: AarZone): string {
  if (z.leave_now_status === "missed") return "not ordered";
  if (z.leave_now_vs_2018_min === null) return "–";
  const m = z.leave_now_vs_2018_min;
  return `${m > 0 ? "+" : ""}${m.toFixed(1)} ${m < 0 ? "earlier" : m > 0 ? "later" : "same"}`;
}

function ZoneTable({ zones }: { zones: AarZone[] }) {
  const [key, setKey] = useState<SortKey>("name");
  const [dir, setDir] = useState<1 | -1>(1);
  const rows = useMemo(() => [...zones].sort((a, b) => compare(a, b, key, dir)), [zones, key, dir]);
  const sortBy = (k: SortKey) => {
    if (k === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setKey(k);
      setDir(1);
    }
  };
  return (
    <Panel title="Zones" aside={<EvidenceTag kind="historical" />}>
      <div className="ui-table-scroll">
        <table className="ui-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={c.num ? "num" : undefined}
                  aria-sort={c.key === key ? (dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <Button variant="ghost" size="sm" onClick={() => sortBy(c.key)}>
                    {c.label}
                    {c.key === key ? (dir === 1 ? " ▲" : " ▼") : ""}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((z) => (
              <tr key={z.zone_id}>
                <th scope="row">{shortZoneName(z.name)}</th>
                <td className="num">{z.vehicles}</td>
                <td className="num">{z.arrived_veh ?? "–"}</td>
                <td>{z.first_leave_now_at ? `${drillClock(z.first_leave_now_at)} UTC` : "–"}</td>
                <td className="num">{vs2018(z)}</td>
                <td className="num">{z.guidance_changes}</td>
                <td className="num">{fmt(z.triage_median_min)}</td>
                <td className="num">{fmt(z.help_to_assign_median_min)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Timeline({ entries }: { entries: AarResponse["timeline"] }) {
  return (
    <Panel title="Timeline" aside={<EvidenceTag kind="observed" />}>
      {entries.length === 0 ? (
        <EmptyState title="No decisions yet" />
      ) : (
        <ol className="aar-timeline">
          {entries.map((e, i) => (
            <li key={`${e.at}:${i}`}>
              <span className="aar-num">{e.drill_at ? `${drillClock(e.drill_at, true)}` : "–"}</span>
              <span className="aar-dim aar-num">{wallClock(e.at)}</span>
              <span>
                {e.action.replace(/_/g, " ")} <span className="aar-dim">{e.actor}</span>
                {e.note ? <span className="aar-dim">, {e.note}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function exportJson(data: AarResponse) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aar-${data.incident_id}-${data.generated_at.replace(/[:]/g, "")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AarPage() {
  const [data, setData] = useState<AarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    fetchAar(ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Could not load the report.");
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [tick]);

  return (
    <Page
      title="After-action report"
      action={
        <span className="ui-row">
          <LinkButton variant="ghost" href="/live">
            Live command
          </LinkButton>
          <Button variant="secondary" disabled={loading} onClick={refresh}>
            Refresh
          </Button>
          <Button variant="secondary" disabled={!data} onClick={() => data && exportJson(data)}>
            Export JSON
          </Button>
        </span>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {loading && !data ? <LoadingState>Loading report</LoadingState> : null}
      {data ? (
        <div className="ui-stack">
          <p className="aar-dim">
            Drill time {drillClock(data.drill.replay_now, true)} UTC {drillDate(data.drill.replay_now)}
          </p>
          <ScoreCard data={data} />
          <ZoneTable zones={data.zones} />
          <Timeline entries={data.timeline} />
        </div>
      ) : null}
    </Page>
  );
}
