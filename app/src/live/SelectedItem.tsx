import { useEffect, useRef, useState } from "react";
import { Button, EvidenceTag, IconButton, LoadingState, Notice, Tag } from "../ui";
import { createTask, triageReport } from "./api";
import { drillClock, elapsed, nf, plural, shortKey, shortZoneName, wallClock } from "./format";
import { distanceM } from "./geo";
import KindGlyph from "./Glyph";
import { impactLine } from "./ReviewQueue";
import { isFixtureNote, type QueueItem } from "./queue";
import type { CommandResponse, FieldReport, ImpactChange, ImpactResponse, ResponderPosition, TwinMetrics } from "./types";

/** Runs one controller action at a time per key; resolves to an error message or null. */
export type RunAction = (key: string, action: (token: string) => Promise<unknown>) => Promise<string | null>;

export interface ImpactState {
  itemId: string;
  loading: boolean;
  result: ImpactResponse | null;
  error: string | null;
}

const STATUS_WORD: Record<FieldReport["status"], string> = {
  unverified: "Received",
  corroborated: "Corroborated",
  responder_confirmed: "Responder confirmed",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
  resolved: "Resolved",
};
const CHANGE_WORD: Record<ImpactChange, string> = {
  slower: "Slower",
  rerouted: "Rerouted",
  route_lost: "No route",
  exposed: "Exposed route",
  unchanged: "Unchanged",
};
const TWIN_ROWS: { key: keyof TwinMetrics; label: string }[] = [
  { key: "arrived_in_window_veh", label: "Arrived in window" },
  { key: "remaining_at_horizon_veh", label: "Still to arrive" },
  { key: "blocked_at_horizon_veh", label: "Blocked at end" },
  { key: "trapped_by_fire_at_horizon_veh", label: "Trapped by fire" },
];
const ZONE_ROWS = 5;

function nearestResponder(coord: [number, number], responders: ResponderPosition[]): ResponderPosition | null {
  let best: ResponderPosition | null = null;
  for (const r of responders) if (!best || distanceM(coord, r.coord) < distanceM(coord, best.coord)) best = r;
  return best;
}

function signed(n: number): string {
  const r = Math.round(n);
  return r === 0 ? "0" : `${r > 0 ? "+" : "−"}${nf(Math.abs(r))}`;
}

function ImpactResult({ impact }: { impact: ImpactResponse }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [impact]);
  const s = impact.summary;
  const blockedNow = impact.target.state === "blocked";
  const rest = impact.zones.slice(ZONE_ROWS);
  const zoneRow = (z: ImpactResponse["zones"][number]) => {
    const before = z.unblocked?.route.eta_min;
    const after = z.blocked?.route.eta_min;
    return (
      <li key={z.zone_id}>
        <span className="lc-imp-zone">{shortZoneName(z.name)}</span>
        <span className="lc-imp-change">{CHANGE_WORD[z.change]}</span>
        <span className="lc-num">
          {before != null ? `${before}` : "—"} → {after != null ? `${after} min` : "no route"}
        </span>
      </li>
    );
  };
  return (
    <div ref={ref} className="lc-imp" aria-live="polite">
      <div className="lc-imp-head">
        <h3>{blockedNow ? "Blocked now vs reopened" : "Open now vs blocked"}</h3>
        {impact.twin ? <EvidenceTag kind="simulated" /> : null}
      </div>
      <dl className="lc-figures">
        <div>
          <dt>ETA</dt>
          <dd>{s.eta_delta_min == null ? "—" : `${s.eta_delta_min > 0 ? "+" : ""}${s.eta_delta_min} min`}</dd>
        </div>
        <div>
          <dt>Zones</dt>
          <dd>{nf(s.affected_zones)}</dd>
        </div>
        <div>
          <dt>{s.vehicles_at_risk_source === "twin" ? "Vehicles at risk" : "Vehicles in zones"}</dt>
          <dd>{nf(s.vehicles_at_risk)}</dd>
        </div>
      </dl>
      {s.zones_losing_route ? (
        <Notice tone="danger" compact title={plural(s.zones_losing_route, "zone")}>
          lose every open route when blocked.
        </Notice>
      ) : null}
      {impact.zones.length === 0 ? (
        <p className="lc-dim">No ordered zone routes over this road.</p>
      ) : (
        <>
          <ul className="lc-imp-zones" aria-label="Affected zones, ETA unblocked to blocked">
            {impact.zones.slice(0, ZONE_ROWS).map(zoneRow)}
          </ul>
          {rest.length ? (
            <details className="lc-more">
              <summary>{plural(rest.length, "more zone")}</summary>
              <ul className="lc-imp-zones">{rest.map(zoneRow)}</ul>
            </details>
          ) : null}
        </>
      )}
      {impact.twin ? (
        <table className="lc-imp-twin">
          <caption>
            Twin, {impact.twin.horizon_min} min{impact.twin.fire_ahead === "frozen" ? ", fire held" : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Open</th>
              <th scope="col">Blocked</th>
              <th scope="col">Δ</th>
            </tr>
          </thead>
          <tbody>
            {TWIN_ROWS.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td>{nf(impact.twin!.unblocked[r.key])}</td>
                <td>{nf(impact.twin!.blocked[r.key])}</td>
                <td>{signed(impact.twin!.delta[r.key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="lc-dim">Twin unavailable ({(impact.twin_fallback ?? "unknown").replace(/_/g, " ")}); planner routes only.</p>
      )}
    </div>
  );
}

export default function SelectedItem({
  item,
  data,
  serverNow,
  run,
  busy,
  impact,
  proposalId,
  onRunImpact,
  onReviewProposal,
  onClose,
}: {
  item: QueueItem;
  data: CommandResponse;
  serverNow: number;
  run: RunAction;
  busy: string | null;
  impact: ImpactState | null;
  proposalId: string | null;
  onRunImpact: () => void;
  onReviewProposal: (id: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  const key = `item:${item.id}`;
  const inDrill = data.drill.started_at !== null;
  const lead = item.reports.find((r) => r.kind === item.kind && r.status !== "confirmed") ?? item.reports[0];
  const act = async (fn: (t: string) => Promise<unknown>) => setError(await run(key, fn));
  const confirm = () => act((t) => triageReport(t, lead.id, "confirm"));
  const resolve = () =>
    act(async (t) => {
      for (const r of item.reports.filter((r) => r.status === "confirmed")) await triageReport(t, r.id, "resolve");
    });
  const dismiss = () =>
    act(async (t) => {
      for (const r of item.reports) await triageReport(t, r.id, "dismiss");
    });
  const fieldCheck = () =>
    act((t) =>
      createTask(t, {
        assignee: nearestResponder(item.coord, data.responders)?.party_key ?? null,
        target: { ...(item.segmentId ? { segment_id: item.segmentId } : {}), coord: item.coord },
        report_ids: item.reports.map((r) => r.id).slice(0, 50),
      }),
    );
  const impactLineText = impactLine(item);
  const mine = impact && impact.itemId === item.id ? impact : null;
  const disabled = busy !== null;

  return (
    <section ref={ref} className="lc-sel" aria-labelledby="lc-sel-title">
      <header className="lc-sel-head">
        <span className={`lc-q-glyph lc-q-glyph--${item.kind}`}>
          <KindGlyph kind={item.kind} />
        </span>
        <h2 id="lc-sel-title">{item.title}</h2>
        {item.fixture ? <EvidenceTag kind="fixture" /> : null}
        <IconButton label="Clear selection" size="sm" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <p className="lc-sel-meta">
        {plural(item.reports.length, "report")}, newest {elapsed(serverNow - new Date(item.newestObservedAt).getTime())} ago
        {impactLineText ? <span className="lc-sel-impact">{impactLineText}</span> : null}
      </p>
      {item.conflict ? (
        <Notice tone="warning" compact title="Conflicting:">
          {item.conflict}
        </Notice>
      ) : null}
      <ul className="lc-sel-reports">
        {item.reports.slice(0, 4).map((r) => (
          <li key={r.id}>
            <span>{r.reporter.role === "responder" ? `Responder ${shortKey(r.reporter.party_key)}` : "Civilian"}</span>
            <span className="lc-dim lc-num">{inDrill && r.replay_at ? drillClock(r.replay_at) : wallClock(r.observed_at)}</span>
            <span className={`lc-sel-status lc-sel-status--${r.status}`}>{STATUS_WORD[r.status]}</span>
            {isFixtureNote(r.note) ? (
              <span className="lc-sel-fixture">
                <Tag>Fixture</Tag>
              </span>
            ) : r.note ? (
              <q className="lc-q-quote">{r.note}</q>
            ) : null}
          </li>
        ))}
        {item.reports.length > 4 ? <li className="lc-dim">{plural(item.reports.length - 4, "older report")}</li> : null}
      </ul>
      {item.task ? (
        <p className="lc-sel-task">
          <Tag tone="info">Field check {item.task.status === "accepted" ? "accepted" : "requested"}</Tag>
          <span className="lc-dim">{item.task.assignee ? shortKey(item.task.assignee) : "Any responder"}</span>
        </p>
      ) : null}
      <div className="lc-sel-actions">
        {item.confirmed ? (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void resolve()}>
            Resolve
          </Button>
        ) : (
          <Button size="sm" disabled={disabled} onClick={() => void confirm()}>
            {busy === key ? "Confirming…" : "Confirm"}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void dismiss()}>
          Dismiss
        </Button>
        {/* Decisions on the first row, checks on the second, so no button is left alone on a wrapped row. */}
        {!item.task || item.segmentId || proposalId ? <span className="lc-sel-break" aria-hidden="true" /> : null}
        {item.task ? null : (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void fieldCheck()}>
            Request field check
          </Button>
        )}
        {item.segmentId ? (
          <Button variant="secondary" size="sm" disabled={mine?.loading} onClick={onRunImpact}>
            Run impact
          </Button>
        ) : null}
        {proposalId ? (
          <Button variant="secondary" size="sm" onClick={() => onReviewProposal(proposalId)}>
            Review proposal
          </Button>
        ) : null}
      </div>
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
      {mine?.loading ? <LoadingState>Running blocked and open plans…</LoadingState> : null}
      {mine?.error ? (
        <Notice tone="danger" compact>
          {mine.error}
        </Notice>
      ) : null}
      {mine?.result ? <ImpactResult impact={mine.result} /> : null}
    </section>
  );
}
