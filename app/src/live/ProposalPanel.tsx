import { useEffect, useMemo, useState } from "react";
import { Button, EvidenceTag, Notice, Tag } from "../ui";
import { approveProposal, rejectProposal, replan } from "./api";
import { CHANGE_LABEL, LEVEL_LABEL, drillClock, elapsed, plural, shortZoneName } from "./format";
import Plate from "./Plate";
import type { RunAction } from "./SelectedItem";
import TwinEvidenceView, { controllerLabel } from "./TwinEvidenceView";
import type { CommandResponse, GuidanceLevel, PlanCause, Proposal, ProposalChange } from "./types";

const CAUSE_LABEL: Record<PlanCause, string> = {
  road_block: "Road block",
  road_report: "Reported block",
  fire: "Fire",
  shelter_full: "Shelter full",
  manual: "Manual",
};
/** Evacuate-now changes waiting longer than this raise an alert. */
const EVACUATE_WAIT_ALERT_MS = 60_000;
/** Changes shown per level before "Show all". */
const GROUP_PREVIEW = 2;
const STATUS_MS = 4_000;
const GROUPS: { key: GuidanceLevel; noun: string }[] = [
  { key: "evacuate_now", noun: "leave-now" },
  { key: "be_ready", noun: "be-ready" },
  { key: "none", noun: "cleared" },
];

/** "Exit south via Big Bend Road, 30 min" or "Via Fairview Dr to Walgreens, 2 min". */
export function wayOut(destination: string | null | undefined, via: string[] | undefined, eta?: number | null): string | null {
  if (!destination) return null;
  const roads = (via ?? []).slice(0, 2).join(", ");
  const head = / via /i.test(destination) || !roads ? destination : `Via ${roads} to ${destination}`;
  return eta != null ? `${head}, ${eta} min` : head;
}

function ChangeRow({ change, data }: { change: ProposalChange; data: CommandResponse }) {
  const zone = data.zones.find((z) => z.id === change.zone_id);
  const destName = (id: string | null) => (id ? (data.destinations.find((d) => d.id === id)?.name ?? id) : null);
  const to = change.to;
  const from = change.from;
  const toLine = to.no_route ? "No open route" : wayOut(to.destination?.name, to.route?.via, to.route?.eta_min);
  const fromLine = from ? wayOut(destName(from.destination_id), from.via) : null;
  return (
    <li className="lc-chg">
      <span className="lc-chg-zone">
        {shortZoneName(zone?.name ?? change.zone_id)}
        <span className="lc-dim">{CHANGE_LABEL[change.kind]}</span>
      </span>
      <span className="lc-chg-plates">
        {from ? <Plate level={from.level} line={fromLine} muted /> : <Plate level="none" verdict="No guidance" muted />}
        <span className="lc-chg-arrow" aria-label="becomes">
          →
        </span>
        <Plate level={to.level} line={toLine} />
      </span>
    </li>
  );
}

function ChangeGroup({
  level,
  noun,
  changes,
  data,
  approve,
}: {
  level: GuidanceLevel;
  noun: string;
  changes: ProposalChange[];
  data: CommandResponse;
  approve: (() => void) | null;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? changes : changes.slice(0, GROUP_PREVIEW);
  return (
    <div className="lc-grp">
      <div className="lc-grp-head">
        <h3>
          {LEVEL_LABEL[level]} <span className="lc-num lc-dim">{changes.length}</span>
        </h3>
        {approve ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Approve ${changes.length} ${noun} zone${changes.length === 1 ? "" : "s"}`}
            onClick={approve}
          >
            Approve {changes.length}
          </Button>
        ) : null}
      </div>
      <ul className="lc-chg-list">
        {shown.map((c) => (
          <ChangeRow key={c.zone_id} change={c} data={data} />
        ))}
      </ul>
      {changes.length > GROUP_PREVIEW ? (
        <Button variant="ghost" size="sm" className="lc-grp-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${changes.length}`}
        </Button>
      ) : null}
    </div>
  );
}

function PendingProposal({
  proposal,
  data,
  run,
  busy,
  serverNow,
  highlighted,
}: {
  proposal: Proposal;
  data: CommandResponse;
  run: RunAction;
  busy: string | null;
  serverNow: number;
  highlighted: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        changes: proposal.changes
          .filter((c) => c.to.level === g.key)
          .sort((a, b) => Number(b.to.no_route) - Number(a.to.no_route)),
      })).filter((g) => g.changes.length > 0),
    [proposal.changes],
  );
  const ageMs = serverNow - new Date(proposal.created_at).getTime();
  const evacWaiting = ageMs > EVACUATE_WAIT_ALERT_MS && proposal.changes.some((c) => c.to.level === "evacuate_now");
  const ai = proposal.rationale.evidence_class === "ai_generated";
  const controller = controllerLabel(proposal.controller);
  const decide = async (approve: boolean, zoneIds?: string[]) =>
    setError(
      await run(`proposal:${proposal.id}`, (t) =>
        approve ? approveProposal(t, proposal.id, zoneIds) : rejectProposal(t, proposal.id),
      ),
    );
  const disabled = busy !== null;
  return (
    <article
      id={`lc-prop-${proposal.id}`}
      tabIndex={-1}
      className={`lc-prop${highlighted ? " is-highlighted" : ""}`}
      aria-labelledby={`lc-prop-title-${proposal.id}`}
    >
      <header className="lc-prop-head">
        <h2 id={`lc-prop-title-${proposal.id}`}>Proposal</h2>
        <span className="lc-dim">
          {proposal.causes.map((c) => CAUSE_LABEL[c] ?? c).join(", ")}, {drillClock(proposal.replay_at)}
        </span>
        <span className={`lc-num lc-prop-age${evacWaiting ? " is-late" : ""}`} title="Waiting for approval">
          {elapsed(ageMs)}
        </span>
      </header>
      {evacWaiting ? (
        <Notice tone="danger" compact title="Waiting:">
          leave-now zones for over 1 min.
        </Notice>
      ) : null}
      <p className="lc-prop-why">
        <EvidenceTag kind={ai ? "ai_explanation" : "Template"} /> {proposal.rationale.text}
        {controller ? <span className="lc-dim"> {controller}.</span> : null}
      </p>
      {proposal.twin ? (
        <details className="lc-more" open={!!(proposal.twin as { worse_than_baseline?: boolean }).worse_than_baseline}>
          <summary>Twin what-if, {proposal.twin.horizon_min} min</summary>
          <TwinEvidenceView twin={proposal.twin} />
        </details>
      ) : null}
      {groups.map((g) => (
        <ChangeGroup
          key={g.key}
          level={g.key}
          noun={g.noun}
          changes={g.changes}
          data={data}
          approve={
            groups.length > 1 && !disabled ? () => void decide(true, g.changes.map((c) => c.zone_id)) : null
          }
        />
      ))}
      {proposal.tasks.length ? (
        <ul className="lc-prop-tasks">
          {proposal.tasks.map((t, i) => (
            <li key={i}>
              <Tag tone="info">Field check</Tag> {t.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="lc-prop-actions">
        <Button disabled={disabled} onClick={() => void decide(true)}>
          {busy === `proposal:${proposal.id}` ? "Publishing…" : groups.length > 1 ? "Approve all" : "Approve"}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => void decide(false)}>
          Reject
        </Button>
      </div>
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
    </article>
  );
}

const DECIDED = new Set<Proposal["status"]>(["approved", "rejected", "auto_approved"]);

/** The newest decision, one line, expandable to its changes. */
function LastDecision({ data }: { data: CommandResponse }) {
  let latest: Proposal | null = null;
  for (const p of data.proposals) {
    if (!DECIDED.has(p.status) || !p.decided_at) continue;
    if (!latest || p.decided_at > latest.decided_at!) latest = p;
  }
  if (!latest || latest.changes.length === 0) return null;
  const roads = new Map(data.road_state.map((r) => [r.segment_id, r.name]));
  const causeRoads = [
    ...new Set((latest.cause_segment_ids ?? []).map((id) => roads.get(id)).filter((n): n is string => !!n)),
  ];
  const cause = causeRoads.length ? `${causeRoads.join(", ")} block` : latest.causes.map((c) => CAUSE_LABEL[c] ?? c).join(", ");
  const verb =
    latest.status === "auto_approved" ? "Auto-rerouted" : latest.status === "approved" ? "Published" : "Rejected";
  return (
    <details className="lc-more lc-last">
      <summary>
        {verb} {plural(latest.changes.length, "zone")}, {cause}, {drillClock(latest.decided_replay_at ?? latest.replay_at)}
      </summary>
      <ul className="lc-chg-list">
        {latest.changes.map((c) => (
          <ChangeRow key={c.zone_id} change={c} data={data} />
        ))}
      </ul>
    </details>
  );
}

export default function ProposalPanel({
  data,
  run,
  busy,
  serverNow,
  highlightId,
}: {
  data: CommandResponse;
  run: RunAction;
  busy: string | null;
  serverNow: number;
  highlightId: string | null;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = data.proposals.filter((p) => p.status === "pending");
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), STATUS_MS);
    return () => window.clearTimeout(id);
  }, [status]);
  const onReplan = async () => {
    setStatus(null);
    let outcome: string | null = null;
    const err = await run("replan", async (t) => {
      const result = await replan(t);
      if (result.proposal === null && result.auto_approved === null) outcome = "No changes";
    });
    setError(err);
    setStatus(err ? null : outcome);
  };
  return (
    <div className="lc-props">
      {pending.map((p) => (
        <PendingProposal
          key={p.id}
          proposal={p}
          data={data}
          run={run}
          busy={busy}
          serverNow={serverNow}
          highlighted={p.id === highlightId}
        />
      ))}
      {pending.length === 0 ? (
        <div className="lc-props-idle">
          <span className="lc-dim" role="status">
            {status ?? "No pending proposal"}
          </span>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void onReplan()}>
            {busy === "replan" ? "Planning…" : "Replan"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
      <LastDecision data={data} />
    </div>
  );
}
