import { useEffect, useRef, useState } from "react";
import { Button, EvidenceTag, IconButton, LoadingState, Notice, Tag } from "../ui";
import { createTask, helpAction, triageReport } from "./api";
import { KIND_LABEL, answersLine, drillClock, elapsed, nf, plural, responderName, shortKey, shortZoneName, wallClock } from "./format";
import { distanceM } from "./geo";
import KindGlyph from "./Glyph";
import { impactLine } from "./ReviewQueue";
import { isEdited, isFixtureNote, priorVersions, type QueueItem } from "./queue";
import type { TaskRouteState } from "./useTaskRoute";
import type {
  CommandResponse,
  FieldReport,
  HelpStatus,
  ImpactChange,
  ImpactResponse,
  ResponderPosition,
  TwinMetrics,
} from "./types";

/** Runs one controller action at a time per key; resolves to an error message or null. */
export type RunAction = (key: string, action: (token: string, incidentId: string) => Promise<unknown>) => Promise<string | null>;

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
  withdrawn: "Withdrawn by reporter",
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
const HELP_WORD: Record<HelpStatus, string> = {
  open: "Not acknowledged",
  acknowledged: "Acknowledged",
  assigned: "Responder assigned",
  resolved: "Resolved",
};

function nearestResponder(coord: [number, number], responders: ResponderPosition[]): ResponderPosition | null {
  let best: ResponderPosition | null = null;
  for (const r of responders) if (!best || distanceM(coord, r.coord) < distanceM(coord, best.coord)) best = r;
  return best;
}

function signed(n: number): string {
  const r = Math.round(n);
  return r === 0 ? "0" : `${r > 0 ? "+" : "−"}${nf(Math.abs(r))}`;
}

/** The responder's route to the open task: ETA, roads, and whether the twin's congestion is in it. */
function RouteLine({ state }: { state: TaskRouteState | null }) {
  if (!state) return null;
  if (state.error === "no_origin") return <p className="lc-sel-route lc-dim">Responder location unknown</p>;
  if (state.error) return <p className="lc-sel-route lc-dim">No route: {state.error}</p>;
  const route = state.route?.route;
  if (!route) return <p className="lc-sel-route lc-dim">No route: {state.route?.detail ?? state.route?.reason ?? "unavailable"}</p>;
  return (
    <p className="lc-sel-route">
      <strong className="lc-num">{route.eta_min} min</strong>
      {route.via.length ? <span>via {route.via.join(", ")}</span> : null}
      <Tag tone={route.congestion === "twin" ? "info" : "neutral"}>
        {route.congestion === "twin" ? "Congestion, simulated" : "Free-flow, no congestion"}
      </Tag>
      {route.exposure === "near_fire" ? <Tag tone="warning">Near fire</Tag> : null}
    </p>
  );
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

/** "Edited" tag and the reporter's earlier versions, newest first (docs/live-reports.md). */
function Revisions({ report, serverNow }: { report: FieldReport; serverNow: number }) {
  const prior = priorVersions(report);
  const editedAt = report.edited_at ? new Date(report.edited_at).getTime() : NaN;
  return (
    <div className="lc-sel-edited">
      <Tag>Edited</Tag>
      {Number.isNaN(editedAt) ? null : (
        <span className="lc-dim" title={wallClock(report.edited_at)}>
          {elapsed(serverNow - editedAt)} ago
        </span>
      )}
      {prior.length ? (
        <details className="lc-more">
          <summary>{prior.length === 1 ? "1 earlier version" : `${prior.length} earlier versions`}</summary>
          <ol className="lc-sel-revs" aria-label="Earlier versions, newest first">
            {prior.map((v, i) => (
              <li key={`${v.at}-${i}`}>
                <span>{KIND_LABEL[v.kind] ?? v.kind}</span>
                <time className="lc-dim lc-num" dateTime={v.at} title={`Replaced at ${wallClock(v.at)}`}>
                  replaced {elapsed(serverNow - new Date(v.at).getTime())} ago
                </time>
                {v.note ? <q className="lc-q-quote">{v.note}</q> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/** A need-help check-in: acknowledge it (the phone shows "Request seen"), send the nearest
 * responder (an assist task; the phone shows "Responder assigned"), or resolve it. */
function HelpDetail({
  item,
  data,
  serverNow,
  run,
  busy,
  route,
  onClose,
}: {
  item: QueueItem;
  data: CommandResponse;
  serverNow: number;
  run: RunAction;
  busy: string | null;
  route: TaskRouteState | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const help = item.help!;
  const status = help.help?.status ?? "open";
  const key = `item:${item.id}`;
  const shared = help.coord !== null;
  const nearest = shared ? nearestResponder(help.coord!, data.responders) : null;
  const act = async (fn: (t: string, incidentId: string) => Promise<unknown>) => setError(await run(key, fn));
  const disabled = busy !== null;
  const task = item.task;
  return (
    <section className="lc-sel" aria-labelledby="lc-sel-title">
      <header className="lc-sel-head">
        <span className="lc-q-glyph lc-q-glyph--help_needed">
          <KindGlyph kind="help_needed" />
        </span>
        <h2 id="lc-sel-title">{item.title}</h2>
        <IconButton label="Clear selection" size="sm" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <p className="lc-sel-meta">
        Check-in {elapsed(serverNow - new Date(help.at).getTime())} ago, {shared ? "location shared" : "no location shared"}
      </p>
      <p className="lc-sel-task">
        <Tag tone={status === "open" ? "danger" : "info"}>{HELP_WORD[status]}</Tag>
        {task ? (
          <span className="lc-dim">
            {task.assignee ? shortKey(task.assignee) : "Any responder"}, {task.status === "accepted" ? "on the way" : "not accepted yet"}
          </span>
        ) : null}
      </p>
      <RouteLine state={route} />
      <div className="lc-sel-actions">
        {status === "open" ? (
          <Button size="sm" disabled={disabled} onClick={() => void act((t) => helpAction(t, help.id, "acknowledge"))}>
            Acknowledge
          </Button>
        ) : null}
        {shared ? (
          <Button
            variant={status === "open" ? "secondary" : "primary"}
            size="sm"
            disabled={disabled}
            onClick={() => void act((t) => helpAction(t, help.id, "assign", nearest?.party_key ?? null))}
          >
            {task ? "Reassign" : "Send"} {nearest ? `${responderName(nearest)}, ${nf(distanceM(help.coord!, nearest.coord))} m` : "any responder"}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void act((t) => helpAction(t, help.id, "resolve"))}>
          Resolve
        </Button>
      </div>
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
    </section>
  );
}

export default function SelectedItem(props: Parameters<typeof ReportDetail>[0]) {
  return props.item.help ? <HelpDetail {...props} /> : <ReportDetail {...props} />;
}

function ReportDetail({
  item,
  data,
  serverNow,
  run,
  busy,
  route,
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
  route: TaskRouteState | null;
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
  const act = async (fn: (t: string, incidentId: string) => Promise<unknown>) => setError(await run(key, fn));
  const confirm = () =>
    act(async (t) => {
      if (!item.grouped) return triageReport(t, lead.id, "confirm");
      for (const r of item.reports.filter((r) => r.status !== "confirmed")) await triageReport(t, r.id, "confirm");
    });
  const resolve = () =>
    act(async (t) => {
      for (const r of item.reports.filter((r) => r.status === "confirmed")) await triageReport(t, r.id, "resolve");
    });
  const dismiss = () =>
    act(async (t) => {
      for (const r of item.reports) await triageReport(t, r.id, "dismiss");
    });
  const helpReport = item.kind === "help_needed";
  const nearest = nearestResponder(item.coord, data.responders);
  const fieldCheck = () =>
    act((t, incidentId) =>
      createTask(t, incidentId, {
        assignee: nearest?.party_key ?? null,
        target: { ...(item.segmentId ? { segment_id: item.segmentId } : {}), coord: item.coord },
        report_ids: item.reports.map((r) => r.id).slice(0, 50),
        ...(helpReport ? { kind: "assist" as const } : {}),
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
            <span>
              {r.evidence_class === "historical_record"
                ? `2018 ${r.record?.channel === "radio" ? "radio" : r.record?.channel === "911" ? "911 call" : "record"}`
                : r.reporter.role === "responder"
                  ? `Responder ${shortKey(r.reporter.party_key)}`
                  : "Civilian"}
            </span>
            <span className="lc-dim lc-num">{inDrill && r.replay_at ? drillClock(r.replay_at) : wallClock(r.observed_at)}</span>
            <span className={`lc-sel-status lc-sel-status--${r.status}`}>{STATUS_WORD[r.status]}</span>
            {r.method === "passive" ? (
              <Tag>{r.speed_class ? `Passive, ${r.speed_class}` : "Passive"}</Tag>
            ) : null}
            {isFixtureNote(r.note) ? (
              <span className="lc-sel-fixture">
                <Tag>Fixture</Tag>
              </span>
            ) : r.note ? (
              <q className="lc-q-quote">{r.note}</q>
            ) : null}
            {isEdited(r) ? <Revisions report={r} serverNow={serverNow} /> : null}
          </li>
        ))}
        {item.reports.length > 4 ? <li className="lc-dim">{plural(item.reports.length - 4, "older report")}</li> : null}
      </ul>
      {item.task ? (
        <p className="lc-sel-task">
          <Tag tone="info">
            {item.task.kind === "assist" ? "Responder sent" : "Field check"}{" "}
            {item.task.status === "accepted" ? "accepted" : "requested"}
          </Tag>
          {item.task.created_by === "priority" ? <Tag>Board</Tag> : null}
          <span className="lc-dim">{item.task.assignee ? shortKey(item.task.assignee) : "Any responder"}</span>
          {item.task.answers !== undefined ? (
            <span className="lc-dim lc-num">{answersLine(item.task.answers, serverNow)}</span>
          ) : null}
        </p>
      ) : null}
      <RouteLine state={route} />
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
            {helpReport
              ? `Send ${nearest ? `${responderName(nearest)}, ${nf(distanceM(item.coord, nearest.coord))} m` : "any responder"}`
              : "Request field check"}
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
