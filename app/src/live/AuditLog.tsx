import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, EvidenceTag, SegmentedControl, Spinner, Tag } from "../ui";
import { simClock } from "../demo/format";
import type { AuditEntry, AuditSource } from "./auditEntries";
import type { AuditPending } from "./useAuditLog";
import { elapsed } from "./format";
import "./audit.css";

type Filter = "all" | AuditSource;

const SOURCE_LABEL: Record<AuditSource, string> = { claude: "Claude", you: "You", board: "Board", studio: "Studio", drill: "Drill" };

function SourceTag({ entry }: { entry: AuditEntry }) {
  switch (entry.source) {
    case "claude":
      return (
        <>
          <Tag tone="info">Claude</Tag>
          <EvidenceTag kind="ai_explanation" />
        </>
      );
    case "you":
      return <Tag tone="brand">You</Tag>;
    case "board":
      return (
        <>
          <Tag tone="neutral">Board</Tag>
          <EvidenceTag kind="simulated" />
        </>
      );
    case "studio":
      return (
        <>
          <Tag tone="warning">Simulation Studio</Tag>
          <EvidenceTag kind="simulated" />
        </>
      );
    default:
      return (
        <>
          <Tag tone="neutral">Drill</Tag>
          {entry.automatic ? <Tag tone="info">Automatic</Tag> : null}
        </>
      );
  }
}

export default function AuditLog({
  entries,
  pending,
  now,
  onSelectReports,
  onSelectBoard,
}: {
  entries: AuditEntry[];
  pending: AuditPending | null;
  /** Clock the entries' `wallMs` are stamped in (the page's serverNow). Defaults to a ticking Date.now(). */
  now?: number;
  onSelectReports?: (ids: string[]) => void;
  onSelectBoard?: (ref: NonNullable<AuditEntry["boardRef"]>) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = window.setInterval(() => setTick(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, [now]);
  const clock = now ?? tick;

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: entries.length, claude: 0, you: 0, board: 0, studio: 0, drill: 0 };
    for (const e of entries) c[e.source] += 1;
    return c;
  }, [entries]);
  const shown = filter === "all" ? entries : entries.filter((e) => e.source === filter);
  const options = (["all", "claude", "you", "board", "studio", "drill"] as const).map((v) => ({
    value: v,
    label: `${v === "all" ? "All" : SOURCE_LABEL[v]} ${counts[v]}`,
  }));

  return (
    <section className="lc-audit" aria-label="Audit log">
      <header className="lc-audit-head">
        <h2>
          <span className="lc-audit-dot" aria-hidden="true" /> Audit log
        </h2>
        <span className="lc-audit-live">Live</span>
      </header>
      <SegmentedControl label="Filter audit log by source" options={options} value={filter} onChange={setFilter} className="lc-audit-filter" />
      <div className="lc-audit-scroll">
        {pending ? (
          <div className="lc-audit-pending" aria-live="polite">
            <span className="lc-audit-title">
              <Spinner /> Claude is deciding…
            </span>
            {pending.reasons.length ? <span className="lc-audit-detail">Woke because: {pending.reasons.join("; ")}</span> : null}
            {pending.text ? <span className="lc-audit-stream">{pending.text}</span> : null}
            {pending.thinking ? <span className="lc-audit-thinking">{pending.thinking.slice(-400)}</span> : null}
          </div>
        ) : null}
        {shown.length === 0 ? (
          <EmptyState title="Nothing logged yet" symbol="•">
            {filter === "all" ? "Board events, Claude's decisions and drill actions appear here as they happen." : "No entries from this source yet."}
          </EmptyState>
        ) : (
          <ol className="lc-audit-list">
            {shown.map((e) => {
              const reports = e.reportIds && onSelectReports ? e.reportIds : null;
              const ref = e.boardRef && onSelectBoard ? e.boardRef : null;
              const click = reports ? () => onSelectReports?.(reports) : ref ? () => onSelectBoard?.(ref) : null;
              const age = `${elapsed(clock - e.wallMs)} ago`;
              const body = (
                <>
                  <span className="lc-audit-meta">
                    {e.simMinute !== null ? <span className="lc-audit-time">{simClock(e.simMinute)}</span> : null}
                    <span className="lc-audit-rel">{age}</span>
                    <SourceTag entry={e} />
                    {e.outcome ? <Tag tone="success">{e.outcome === "contained" ? "✓ Contained" : "✓ Out"}</Tag> : null}
                  </span>
                  <span className="lc-audit-title">{e.title}</span>
                  {e.detail ? <span className="lc-audit-detail">{e.detail}</span> : null}
                </>
              );
              return (
                <li key={e.id} className={`lc-audit-item lc-audit-${e.source}`}>
                  {click ? (
                    <Button variant="ghost" size="sm" className="lc-audit-open" onClick={click}>
                      {body}
                    </Button>
                  ) : (
                    <div className="lc-audit-row">{body}</div>
                  )}
                  {e.orders?.length ? (
                    <ul className="lc-audit-orders">
                      {e.orders.map((o, i) => (
                        <li key={i}>
                          <Tag tone={o.ok ? "success" : "danger"}>{o.ok ? "Done" : "Refused"}</Tag> {o.text}
                          {o.error ? <span className="lc-audit-error"> · {o.error}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {e.reasoning ? (
                    <details className="lc-audit-reasoning">
                      <summary>Claude's reasoning</summary>
                      <p>{e.reasoning}</p>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
