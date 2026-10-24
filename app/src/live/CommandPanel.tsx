import { useEffect, useMemo, useState } from "react";
import { approveProposal, createTask, drillAction, rejectProposal, replan, triageReport } from "./api";
import {
  CHANGE_LABEL,
  KIND_LABEL,
  LEVEL_LABEL,
  STATUS_LABEL,
  drillClock,
  elapsed,
  shortKey,
  wallClock,
} from "./format";
import type { MapFocus } from "./CommandMap";
import TwinEvidenceView, { controllerLabel } from "./TwinEvidenceView";
import type {
  CheckTask,
  CommandResponse,
  FieldReport,
  LonLat,
  PlanCause,
  Proposal,
  ProposalChange,
  ResponderPosition,
} from "./types";

/** Runs one controller action at a time per key; resolves to an error message or null. */
export type RunAction = (key: string, action: (token: string) => Promise<unknown>) => Promise<string | null>;

const SPEEDS = [0, 1, 5, 15, 30, 60] as const;
const CLOSED_REPORT = new Set(["dismissed", "resolved"]);
const CAUSE_LABEL: Record<PlanCause, string> = {
  road_block: "Road block",
  road_report: "Reported block",
  fire: "Fire",
  shelter_full: "Shelter full",
  manual: "Manual",
};
const PROPOSAL_STATUS: Record<Proposal["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  auto_approved: "Auto-approved",
  superseded: "Superseded",
};

function SectionError({ message }: { message: string | null }) {
  return message ? (
    <p className="lc-error" role="alert">
      {message}
    </p>
  ) : null;
}

// ---- Proposals ----

/** Evacuate-now changes older than this make the pending card raise an alert. */
const EVACUATE_WAIT_ALERT_MS = 60_000;
const UNCHANGED_STATUS_MS = 4_000;

type ChangeGroupKey = "evacuate_now" | "be_ready" | "none";
const GROUPS: { key: ChangeGroupKey; noun: string }[] = [
  { key: "evacuate_now", noun: "evacuate-now" },
  { key: "be_ready", noun: "be-ready" },
  { key: "none", noun: "cleared" },
];

function groupChanges(changes: ProposalChange[]) {
  return GROUPS.map((g) => ({
    ...g,
    // No-route zones first: they need the controller's attention most.
    changes: changes
      .filter((c) => c.to.level === g.key)
      .sort((a, b) => Number(b.to.no_route) - Number(a.to.no_route)),
  })).filter((g) => g.changes.length > 0);
}

function ChangeRow({ change, zoneName }: { change: ProposalChange; zoneName: string }) {
  const to = change.to;
  const from = change.from;
  const levelPart =
    change.kind === "level_change" && from
      ? `${LEVEL_LABEL[from.level]} → ${LEVEL_LABEL[to.level]}`
      : LEVEL_LABEL[to.level];
  const target = to.no_route
    ? "No open route"
    : to.destination
      ? `${to.destination.name}${to.route?.via.length ? ` via ${to.route.via.join(", ")}` : ""}${to.route ? `, ${to.route.eta_min} min` : ""}`
      : null;
  const fromVia =
    (change.kind === "reroute" || change.kind === "route_lost") && from?.via.length
      ? `was via ${from.via.join(", ")}`
      : null;
  return (
    <li className="lc-change">
      <div className="lc-change-head">
        <span className={`lc-kind lc-kind--${change.kind}`}>{CHANGE_LABEL[change.kind]}</span>
        <strong>{zoneName}</strong>
      </div>
      <div>
        <span className={`lc-level lc-level--${to.level}`}>{levelPart}</span>
        {target ? ` · ${target}` : ""}
      </div>
      {fromVia ? <div className="lc-dim">{fromVia}</div> : null}
    </li>
  );
}

function AlertIcon() {
  return (
    <svg className="lc-alert-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M8 1.5 15 14H1L8 1.5Z" fill="currentColor" />
      <path d="M8 6v4M8 11.6v.4" stroke="#0c1117" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Long groups start collapsed so the card stays scannable. */
const GROUP_OPEN_MAX = 5;

function ChangeGroup({
  level,
  changes,
  zoneName,
  approve,
}: {
  level: ChangeGroupKey;
  changes: ProposalChange[];
  zoneName: (id: string) => string;
  approve: { label: string; disabled: boolean; onClick: () => void } | null;
}) {
  const [open, setOpen] = useState(changes.length <= GROUP_OPEN_MAX);
  return (
    <div className="lc-group">
      <div className="lc-group-head">
        <button type="button" className="lc-group-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="lc-group-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className={`lc-level lc-level--${level}`}>{LEVEL_LABEL[level]}</span>
          <span className="lc-dim">{changes.length}</span>
        </button>
        {approve ? (
          <button
            type="button"
            className="lc-btn lc-btn--group"
            aria-label={approve.label}
            disabled={approve.disabled}
            onClick={approve.onClick}
          >
            Approve
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="lc-changes">
          {changes.map((c) => (
            <ChangeRow key={c.zone_id} change={c} zoneName={zoneName(c.zone_id)} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function decisionTime(p: Proposal): string {
  return drillClock(p.decided_replay_at ?? p.replay_at);
}

function ProposalCard({
  proposal,
  zoneNames,
  run,
  busy,
  serverNow,
}: {
  proposal: Proposal;
  zoneNames: Map<string, string>;
  run: RunAction;
  busy: string | null;
  serverNow: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const pending = proposal.status === "pending";
  const ai = proposal.rationale.evidence_class === "ai_generated";
  const controller = controllerLabel(proposal.controller);
  const groups = useMemo(() => groupChanges(proposal.changes), [proposal.changes]);
  const ageMs = serverNow - new Date(proposal.created_at).getTime();
  const evacWaiting =
    pending && ageMs > EVACUATE_WAIT_ALERT_MS && proposal.changes.some((c) => c.to.level === "evacuate_now");
  const decide = async (approve: boolean, zoneIds?: string[]) =>
    setError(
      await run(`proposal:${proposal.id}`, (t) =>
        approve ? approveProposal(t, proposal.id, zoneIds) : rejectProposal(t, proposal.id),
      ),
    );
  const zoneName = (id: string) => zoneNames.get(id) ?? id;
  return (
    <article className={`lc-card${pending ? " lc-card--pending" : ""}`} aria-label={`Proposal ${proposal.id}`}>
      <header className="lc-card-head">
        <span className={`lc-status lc-status--${proposal.status}`}>{PROPOSAL_STATUS[proposal.status]}</span>
        <span className="lc-dim">
          {proposal.causes.map((c) => CAUSE_LABEL[c] ?? c).join(", ")} · {drillClock(proposal.replay_at)}
          {controller ? ` · ${controller}` : ""}
        </span>
        {pending ? (
          <span className="lc-age" title="Waiting for approval">
            {elapsed(ageMs)}
          </span>
        ) : null}
      </header>
      {evacWaiting ? (
        <p className="lc-alert" role="alert">
          <AlertIcon />
          Evacuate-now zones waiting over 1 min
        </p>
      ) : null}
      <p className="lc-rationale">
        <span
          className={`lc-chip ${ai ? "lc-chip--ai" : "lc-chip--template"}`}
          title={proposal.rationale.generated_by}
        >
          {ai ? "AI-written" : "Template"}
        </span>{" "}
        {proposal.rationale.text}
      </p>
      {proposal.twin ? <TwinEvidenceView twin={proposal.twin} /> : null}
      {groups.map((g) => (
        <ChangeGroup
          key={g.key}
          level={g.key}
          changes={g.changes}
          zoneName={zoneName}
          approve={
            pending && groups.length > 1
              ? {
                  label: `Approve ${g.changes.length} ${g.noun} zone${g.changes.length === 1 ? "" : "s"}`,
                  disabled: busy !== null,
                  onClick: () => void decide(true, g.changes.map((c) => c.zone_id)),
                }
              : null
          }
        />
      ))}
      {proposal.tasks.length ? (
        <ul className="lc-changes">
          {proposal.tasks.map((t, i) => (
            <li key={i} className="lc-change">
              <div className="lc-change-head">
                <span className="lc-kind lc-kind--task">Verify</span>
                <span>{t.assignee ? shortKey(t.assignee) : "Any responder"}</span>
              </div>
              <div>{t.reason}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {pending ? (
        <div className="lc-actions">
          <button
            type="button"
            className="lc-btn lc-btn--primary"
            disabled={busy !== null}
            onClick={() => void decide(true)}
          >
            Approve all
          </button>
          <button type="button" className="lc-btn" disabled={busy !== null} onClick={() => void decide(false)}>
            Reject
          </button>
        </div>
      ) : proposal.decided_by ? (
        <p className="lc-dim">
          {proposal.decided_by === "auto_policy" ? "Auto policy" : "Controller"} · {decisionTime(proposal)}
          {proposal.note ? ` · ${proposal.note}` : ""}
        </p>
      ) : null}
      <SectionError message={error} />
    </article>
  );
}

const DECISIONS = new Set<Proposal["status"]>(["approved", "rejected", "auto_approved"]);

/** The newest decision when it is an auto-approval: one line, expandable to its changes. */
function AutoRerouteLine({ data, zoneNames }: { data: CommandResponse; zoneNames: Map<string, string> }) {
  let latest: Proposal | null = null;
  for (const p of data.proposals) {
    if (!DECISIONS.has(p.status) || !p.decided_at) continue;
    if (!latest || p.decided_at > latest.decided_at!) latest = p;
  }
  if (!latest || latest.status !== "auto_approved" || latest.changes.length === 0) return null;
  const roadNames = new Map(data.road_state.map((r) => [r.segment_id, r.name]));
  const roads = [
    ...new Set((latest.cause_segment_ids ?? []).map((id) => roadNames.get(id)).filter((n): n is string => !!n)),
  ];
  const cause = roads.length
    ? `${roads.join(", ")} block`
    : latest.causes.map((c) => CAUSE_LABEL[c] ?? c).join(", ");
  const n = latest.changes.length;
  return (
    <details key={latest.id} className="lc-details lc-auto">
      <summary>
        <span className="lc-auto-mark" aria-hidden="true">
          ↻
        </span>
        Auto-rerouted {n} zone{n === 1 ? "" : "s"} · {cause} · {decisionTime(latest)}
      </summary>
      <ul className="lc-changes">
        {latest.changes.map((c) => (
          <ChangeRow key={c.zone_id} change={c} zoneName={zoneNames.get(c.zone_id) ?? c.zone_id} />
        ))}
      </ul>
    </details>
  );
}

function ProposalsSection({
  data,
  run,
  busy,
  serverNow,
}: {
  data: CommandResponse;
  run: RunAction;
  busy: string | null;
  serverNow: number;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const zoneNames = useMemo(() => new Map(data.zones.map((z) => [z.id, z.name])), [data.zones]);
  const pending = data.proposals.filter((p) => p.status === "pending");
  const decided = data.proposals.filter((p) => p.status !== "pending");
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), UNCHANGED_STATUS_MS);
    return () => window.clearTimeout(id);
  }, [status]);
  const onReplan = async () => {
    setMessage(null);
    setStatus(null);
    const before = new Set(pending.map((p) => p.id));
    let outcome: string | null = null;
    const error = await run("replan", async (t) => {
      const result = await replan(t);
      if (result.proposal === null && result.auto_approved === null) outcome = "No changes";
      else if (result.proposal && before.has(result.proposal.id) && !result.auto_approved) outcome = "Unchanged";
    });
    setMessage(error);
    setStatus(error ? null : outcome);
  };
  return (
    <section className="lc-section" aria-labelledby="lc-proposals">
      <div className="lc-section-head">
        <h2 id="lc-proposals">
          Proposals {pending.length ? <span className="lc-count">{pending.length}</span> : null}
        </h2>
        <div className="lc-actions">
          <span className="lc-dim lc-replan-status" role="status">
            {status}
          </span>
          <button type="button" className="lc-btn" disabled={busy !== null} onClick={() => void onReplan()}>
            {busy === "replan" ? "Planning…" : "Replan"}
          </button>
        </div>
      </div>
      <SectionError message={message} />
      {pending.length === 0 ? <p className="lc-empty">No pending proposals.</p> : null}
      {pending.map((p) => (
        <ProposalCard key={p.id} proposal={p} zoneNames={zoneNames} run={run} busy={busy} serverNow={serverNow} />
      ))}
      <AutoRerouteLine data={data} zoneNames={zoneNames} />
      {decided.length ? (
        <details className="lc-details">
          <summary>Decided ({decided.length})</summary>
          {decided.map((p) => (
            <ProposalCard key={p.id} proposal={p} zoneNames={zoneNames} run={run} busy={busy} serverNow={serverNow} />
          ))}
        </details>
      ) : null}
    </section>
  );
}

// ---- Reports ----

function distanceM(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function nearestResponder(coord: LonLat, responders: ResponderPosition[]): ResponderPosition | null {
  let best: ResponderPosition | null = null;
  let bestM = Infinity;
  for (const r of responders) {
    const m = distanceM(coord, r.coord);
    if (m < bestM) {
      best = r;
      bestM = m;
    }
  }
  return best;
}

function ReportRow({
  report,
  inDrill,
  task,
  responders,
  run,
  busy,
  onFocus,
}: {
  report: FieldReport;
  inDrill: boolean;
  task: CheckTask | undefined;
  responders: ResponderPosition[];
  run: RunAction;
  busy: string | null;
  onFocus: (focus: MapFocus) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const key = `report:${report.id}`;
  const confirmed = report.status === "confirmed";
  const ask = async () => {
    const nearest = nearestResponder(report.location.coord, responders);
    setError(
      await run(key, (t) =>
        createTask(t, {
          assignee: nearest?.party_key ?? null,
          target: {
            ...(report.road_ref ? { segment_id: report.road_ref.segment_id } : {}),
            coord: report.location.coord,
          },
          report_ids: [report.id],
        }),
      ),
    );
  };
  const where = report.road_ref?.name ?? report.location.coord.map((n) => n.toFixed(4)).join(", ");
  return (
    <li className="lc-report">
      <button
        type="button"
        className="lc-report-main"
        onClick={() => onFocus({ id: report.id, coord: report.location.coord })}
      >
        <span className="lc-report-title">
          <strong>{KIND_LABEL[report.kind] ?? report.kind}</strong>
          {report.severity ? <span className="lc-dim"> · {report.severity}</span> : null}
          <span className={`lc-status lc-status--${report.status}`}>{STATUS_LABEL[report.status]}</span>
        </span>
        <span className="lc-dim">
          {where} · {report.reporter.role}
          {inDrill ? (report.replay_at ? ` · ${drillClock(report.replay_at)}` : "") : ` · ${wallClock(report.observed_at)}`}
        </span>
        {report.note ? <span className="lc-note">{report.note}</span> : null}
      </button>
      <div className="lc-actions">
        {!confirmed ? (
          <button
            type="button"
            className="lc-btn lc-btn--primary"
            disabled={busy !== null}
            onClick={async () => setError(await run(key, (t) => triageReport(t, report.id, "confirm")))}
          >
            Confirm
          </button>
        ) : null}
        <button
          type="button"
          className="lc-btn"
          disabled={busy !== null}
          onClick={async () => setError(await run(key, (t) => triageReport(t, report.id, "dismiss")))}
        >
          Dismiss
        </button>
        {task ? (
          <span className="lc-dim">
            Task {task.status}
            {task.assignee ? ` · ${shortKey(task.assignee)}` : ""}
          </span>
        ) : !confirmed ? (
          <button type="button" className="lc-btn" disabled={busy !== null} onClick={() => void ask()}>
            Ask a responder
          </button>
        ) : null}
      </div>
      <SectionError message={error} />
    </li>
  );
}

function ReportsSection({
  data,
  run,
  busy,
  onFocus,
}: {
  data: CommandResponse;
  run: RunAction;
  busy: string | null;
  onFocus: (focus: MapFocus) => void;
}) {
  const open = useMemo(
    () =>
      data.reports
        .filter((r) => !CLOSED_REPORT.has(r.status))
        .sort((a, b) => b.received_at.localeCompare(a.received_at)),
    [data.reports],
  );
  const taskByReport = useMemo(() => {
    const map = new Map<string, CheckTask>();
    for (const t of data.tasks) {
      if (t.status !== "open" && t.status !== "accepted") continue;
      for (const id of t.report_ids) map.set(id, t);
    }
    return map;
  }, [data.tasks]);
  const field = useMemo(() => {
    const sum = { out: 0, need_help: 0, staying: 0 };
    for (const c of data.checkins.by_zone) {
      sum.out += c.out;
      sum.need_help += c.need_help;
      sum.staying += c.staying;
    }
    return [
      { key: "out", label: "Out", value: sum.out },
      { key: "need_help", label: "Need help", value: sum.need_help },
      { key: "staying", label: "Staying", value: sum.staying },
      { key: "responders", label: "Responders", value: data.responders.length },
    ];
  }, [data.checkins.by_zone, data.responders.length]);
  return (
    <section className="lc-section" aria-labelledby="lc-reports">
      <div className="lc-section-head">
        <h2 id="lc-reports">
          Field {open.length ? <span className="lc-count" title="Open reports">{open.length}</span> : null}
        </h2>
      </div>
      <dl className="lc-field">
        {field.map((f) => (
          <div key={f.key} className={`lc-field-item lc-field-item--${f.key}`}>
            <dt>{f.label}</dt>
            <dd>{f.value.toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
      {open.length === 0 ? <p className="lc-empty">No open reports.</p> : null}
      <ul className="lc-reports">
        {open.map((r) => (
          <ReportRow
            key={r.id}
            report={r}
            inDrill={data.drill.started_at !== null}
            task={taskByReport.get(r.id)}
            responders={data.responders}
            run={run}
            busy={busy}
            onFocus={onFocus}
          />
        ))}
      </ul>
    </section>
  );
}

// ---- Drill ----

function DrillSection({ drill, run, busy }: { drill: CommandResponse["drill"]; run: RunAction; busy: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const stopped = drill.started_at === null;
  const ended = !stopped && drill.speed > 0 && !drill.running;
  const state = stopped ? "Stopped" : ended ? "Ended" : drill.speed === 0 ? "Paused" : `Running ×${drill.speed}`;
  const setSpeed = async (speed: number) =>
    setError(
      await run("drill", (t) =>
        drillAction(t, stopped ? { action: "start", speed } : { action: "set_speed", speed }),
      ),
    );
  const reset = async () => {
    if (!window.confirm("Reset the drill? Guidance, proposals and check-ins are deleted.")) return;
    setError(await run("drill", (t) => drillAction(t, { action: "reset" })));
  };
  return (
    <section className="lc-section" aria-labelledby="lc-drill">
      <div className="lc-section-head">
        <h2 id="lc-drill">Drill</h2>
        <span className={`lc-status lc-status--drill-${stopped ? "stopped" : ended ? "ended" : drill.speed === 0 ? "paused" : "running"}`}>
          {state}
        </span>
      </div>
      <div className="lc-speeds" role="group" aria-label="Drill speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className="lc-btn lc-speed"
            aria-pressed={!stopped && drill.speed === s}
            disabled={busy !== null}
            onClick={() => void setSpeed(s)}
          >
            {s === 0 ? "Pause" : `×${s}`}
          </button>
        ))}
      </div>
      <div className="lc-actions">
        {stopped ? (
          <button
            type="button"
            className="lc-btn lc-btn--primary"
            disabled={busy !== null}
            onClick={async () => setError(await run("drill", (t) => drillAction(t, { action: "start" })))}
          >
            Start
          </button>
        ) : null}
        <button type="button" className="lc-btn" disabled={busy !== null} onClick={() => void reset()}>
          Reset
        </button>
      </div>
      <SectionError message={error} />
    </section>
  );
}

export default function CommandPanel({
  data,
  serverNow,
  run,
  busy,
  onFocus,
}: {
  data: CommandResponse;
  /** Server wall time (ms), advanced locally between polls. */
  serverNow: number;
  run: RunAction;
  busy: string | null;
  onFocus: (focus: MapFocus) => void;
}) {
  return (
    <>
      <ProposalsSection data={data} run={run} busy={busy} serverNow={serverNow} />
      <ReportsSection data={data} run={run} busy={busy} onFocus={onFocus} />
      <DrillSection drill={data.drill} run={run} busy={busy} />
    </>
  );
}
