import { useEffect, useMemo, useState } from "react";
import { approveProposal, createTask, drillAction, rejectProposal, replan, triageReport } from "./api";
import {
  CHANGE_LABEL,
  KIND_LABEL,
  LEVEL_LABEL,
  STATUS_LABEL,
  drillClock,
  drillDate,
  shortKey,
  wallClock,
} from "./format";
import type { MapFocus } from "./CommandMap";
import type {
  CheckTask,
  CommandResponse,
  DrillState,
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
const CAUSE_LABEL: Record<PlanCause, string> = { road_block: "Road block", fire: "Fire", manual: "Manual" };
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
  const fromVia = change.kind === "reroute" && from?.via.length ? `was via ${from.via.join(", ")}` : null;
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

function ProposalCard({
  proposal,
  zoneNames,
  run,
  busy,
}: {
  proposal: Proposal;
  zoneNames: Map<string, string>;
  run: RunAction;
  busy: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const pending = proposal.status === "pending";
  const ai = proposal.rationale.evidence_class === "ai_generated";
  const decide = async (approve: boolean) =>
    setError(
      await run(`proposal:${proposal.id}`, (t) =>
        approve ? approveProposal(t, proposal.id) : rejectProposal(t, proposal.id),
      ),
    );
  return (
    <article className={`lc-card${pending ? " lc-card--pending" : ""}`} aria-label={`Proposal ${proposal.id}`}>
      <header className="lc-card-head">
        <span className={`lc-status lc-status--${proposal.status}`}>{PROPOSAL_STATUS[proposal.status]}</span>
        <span className="lc-dim">
          {proposal.causes.map((c) => CAUSE_LABEL[c]).join(", ")} · {drillClock(proposal.replay_at)} drill
        </span>
      </header>
      <p className="lc-rationale">
        <span
          className={`lc-chip ${ai ? "lc-chip--ai" : "lc-chip--template"}`}
          title={proposal.rationale.generated_by}
        >
          {ai ? "AI-written" : "Template"}
        </span>{" "}
        {proposal.rationale.text}
      </p>
      {proposal.changes.length ? (
        <ul className="lc-changes">
          {proposal.changes.map((c) => (
            <ChangeRow key={c.zone_id} change={c} zoneName={zoneNames.get(c.zone_id) ?? c.zone_id} />
          ))}
        </ul>
      ) : null}
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
            Approve
          </button>
          <button type="button" className="lc-btn" disabled={busy !== null} onClick={() => void decide(false)}>
            Reject
          </button>
        </div>
      ) : proposal.decided_by ? (
        <p className="lc-dim">
          {proposal.decided_by === "auto_policy" ? "Auto policy" : "Controller"} · {wallClock(proposal.decided_at)}
          {proposal.note ? ` · ${proposal.note}` : ""}
        </p>
      ) : null}
      <SectionError message={error} />
    </article>
  );
}

function ProposalsSection({ data, run, busy }: { data: CommandResponse; run: RunAction; busy: string | null }) {
  const [message, setMessage] = useState<string | null>(null);
  const zoneNames = useMemo(() => new Map(data.zones.map((z) => [z.id, z.name])), [data.zones]);
  const pending = data.proposals.filter((p) => p.status === "pending");
  const decided = data.proposals.filter((p) => p.status !== "pending");
  const onReplan = async () => {
    setMessage(null);
    let noChanges = false;
    const error = await run("replan", async (t) => {
      const result = await replan(t);
      noChanges = result.proposal === null;
    });
    setMessage(error ?? (noChanges ? "No changes." : null));
  };
  return (
    <section className="lc-section" aria-labelledby="lc-proposals">
      <div className="lc-section-head">
        <h2 id="lc-proposals">
          Proposals {pending.length ? <span className="lc-count">{pending.length}</span> : null}
        </h2>
        <button type="button" className="lc-btn" disabled={busy !== null} onClick={() => void onReplan()}>
          {busy === "replan" ? "Planning…" : "Replan"}
        </button>
      </div>
      {message ? <p className="lc-dim" role="status">{message}</p> : null}
      {pending.length === 0 ? <p className="lc-empty">No pending proposals.</p> : null}
      {pending.map((p) => (
        <ProposalCard key={p.id} proposal={p} zoneNames={zoneNames} run={run} busy={busy} />
      ))}
      {decided.length ? (
        <details className="lc-details">
          <summary>Decided ({decided.length})</summary>
          {decided.map((p) => (
            <ProposalCard key={p.id} proposal={p} zoneNames={zoneNames} run={run} busy={busy} />
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
  task,
  responders,
  run,
  busy,
  onFocus,
}: {
  report: FieldReport;
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
          {where} · {report.reporter.role} · {wallClock(report.observed_at)}
          {report.replay_at ? ` · ${drillClock(report.replay_at)} drill` : ""}
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
  return (
    <section className="lc-section" aria-labelledby="lc-reports">
      <div className="lc-section-head">
        <h2 id="lc-reports">
          Reports {open.length ? <span className="lc-count">{open.length}</span> : null}
        </h2>
      </div>
      {open.length === 0 ? <p className="lc-empty">No open reports.</p> : null}
      <ul className="lc-reports">
        {open.map((r) => (
          <ReportRow
            key={r.id}
            report={r}
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

/** replay_now advanced locally between polls, with the server's formula and clamp. */
function useDrillNow(drill: DrillState, receivedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!drill.running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [drill.running]);
  if (!drill.running || receivedAt === null) return drill.replay_now;
  const base = new Date(drill.replay_now).getTime();
  const end = new Date(drill.clock.end).getTime();
  const advanced = Math.min(end, base + Math.max(0, now - receivedAt) * drill.speed);
  return new Date(advanced).toISOString();
}

function DrillSection({
  drill,
  receivedAt,
  run,
  busy,
}: {
  drill: DrillState;
  receivedAt: number | null;
  run: RunAction;
  busy: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const now = useDrillNow(drill, receivedAt);
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
      <p className="lc-clock" aria-live="off">
        <span className="lc-clock-time">{drillClock(now, true)}</span>
        <span className="lc-dim"> UTC · {drillDate(now)}</span>
      </p>
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
  receivedAt,
  run,
  busy,
  onFocus,
}: {
  data: CommandResponse;
  receivedAt: number | null;
  run: RunAction;
  busy: string | null;
  onFocus: (focus: MapFocus) => void;
}) {
  return (
    <>
      <ProposalsSection data={data} run={run} busy={busy} />
      <ReportsSection data={data} run={run} busy={busy} onFocus={onFocus} />
      <DrillSection drill={data.drill} receivedAt={receivedAt} run={run} busy={busy} />
    </>
  );
}
