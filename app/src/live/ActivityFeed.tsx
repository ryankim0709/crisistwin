import { useMemo, useState } from "react";
import { Button, EmptyState, EvidenceTag, IconButton, Spinner, Tag, cx } from "../ui";
import { simClock } from "../demo/format";
import type { Board } from "../demo/model";
import type { DemoAgent } from "../demo/useDemoAgent";
import { FEED_SOURCE_LABEL, FEED_STATE_LABEL, buildActivityFeed, type FeedItem, type FeedState } from "./activityFeedModel";
import { elapsed } from "./format";
import type { Decision } from "./types";
import "./activity-feed.css";

const NO_BOARD = {};
/** Characters of the wake reasons shown under "Claude is deciding…" (the full list is in the decision's details). */
const WOKE_CHARS = 320;

/** The wake reasons on one readable line, cut at WOKE_CHARS. */
function wokeLine(reasons: string[]): string {
  const text = reasons.join("; ");
  return text.length <= WOKE_CHARS ? text : `${text.slice(0, WOKE_CHARS - 1)}…`;
}

/** Shape per state (with screen-reader text), so state never rests on colour. */
const STATE_MARK: Record<FeedState, string> = {
  proposed: "◌",
  in_progress: "◐",
  completed: "✓",
  info: "•",
};

function StateMark({ state }: { state: FeedState }) {
  return (
    <span className={`lc-feed-mark lc-feed-mark--${state}`} title={FEED_STATE_LABEL[state]}>
      <span aria-hidden="true">{STATE_MARK[state]}</span>
      <span className="lc-feed-sr">{FEED_STATE_LABEL[state]}: </span>
    </span>
  );
}

function Provenance({ item }: { item: FeedItem }) {
  if (item.source === "claude") {
    return (
      <span className="lc-feed-prov">
        <Tag tone="info">Claude</Tag>
        <EvidenceTag kind="ai_explanation" />
        <span>Orders run on the simulated board.</span>
      </span>
    );
  }
  if (item.source === "drill") {
    return (
      <span className="lc-feed-prov">
        <Tag>Live drill</Tag>
        {item.automatic ? <Tag tone="info">Automatic</Tag> : null}
      </span>
    );
  }
  return (
    <span className="lc-feed-prov">
      <EvidenceTag kind="simulated" />
      <span>{item.source === "studio" ? "Studio fire, simulated board." : item.source === "you" ? "Your order, simulated board." : "Simulated board."}</span>
    </span>
  );
}

function Details({ item, id }: { item: FeedItem; id: string }) {
  const c = item.claude;
  return (
    <div id={id} className="lc-feed-details">
      <Provenance item={item} />
      {c ? (
        <>
          {c.summary ? <p className="lc-feed-detail-text">{c.summary}</p> : null}
          {c.wokeBecause.length ? <p className="lc-feed-detail-muted">Woke because: {c.wokeBecause.join("; ")}</p> : null}
          {c.orders.length ? (
            <ul className="lc-feed-orders">
              {c.orders.map((o, i) => (
                <li key={i}>
                  <Tag tone={o.ok ? "success" : "warning"}>{o.ok ? "Applied" : "Refused"}</Tag> {o.text}
                  {o.error ? <span className="lc-feed-detail-muted"> · {o.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {item.records.length ? (
        <ol className="lc-feed-records" aria-label="Audit lines">
          {item.records.map((r, i) => (
            <li key={i}>
              {r.minute !== null ? <span className="lc-feed-time">{simClock(r.minute)}</span> : null}
              <span>{r.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {item.ids.length ? <p className="lc-feed-ids">Ids: {item.ids.join(", ")}</p> : null}
      {c?.reasoning ? (
        <div className="lc-feed-reasoning">
          <p className="lc-feed-detail-muted">Claude's reasoning{c.model ? ` (${c.model})` : ""}</p>
          <p>{c.reasoning}</p>
        </div>
      ) : null}
    </div>
  );
}

export default function ActivityFeed({
  board,
  version,
  agent,
  liveDecisions,
  serverNow,
  name,
  onSelectBoard,
  onSelectReports,
  onOpenAuditLog,
}: {
  board: Board | null;
  /** Board version; bumps on every in-place change. */
  version: number;
  agent: DemoAgent;
  liveDecisions: Decision[];
  /** The page's server-aligned clock (ms); drill times and first-seen stamps are in this frame. */
  serverNow: number;
  /** Zone / destination display name. */
  name: (id: string) => string;
  onSelectBoard?: (ref: { kind: "fire" | "zone" | "team"; id: string }) => void;
  onSelectReports?: (ids: string[]) => boolean | void;
  onOpenAuditLog?: () => void;
}) {
  // First-seen stamps per board object (a replaced board starts clean), in a stable holder.
  const [stamps] = useState(() => new WeakMap<object, Map<string, number>>());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const decisions = agent.decisions;

  const items = useMemo(() => {
    const owner = board ?? NO_BOARD;
    let seen = stamps.get(owner);
    if (!seen) {
      seen = new Map();
      stamps.set(owner, seen);
    }
    const stamp = (key: string): number => {
      let ms = seen.get(key);
      if (ms === undefined) {
        ms = serverNow;
        seen.set(key, ms);
      }
      return ms;
    };
    return buildActivityFeed({ board, decisions, liveDecisions, name, stamp });
    // `version` signals in-place board mutation; serverNow only stamps new items, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, version, decisions, liveDecisions, name, stamps]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const thinking = agent.status === "thinking";
  const agentError = agent.status === "error" ? agent.error : null;
  const pendingOpen = open.has("__pending");
  const live = agent.streamText || agent.thinking;

  return (
    <section className="lc-feed" aria-label="Activity">
      <header className="lc-feed-head">
        <h2>Activity</h2>
      </header>
      <div className="lc-feed-scroll">
        {thinking ? (
          <div className="lc-feed-item lc-feed-pending" aria-live="polite">
            <div className="lc-feed-row">
              <span className="lc-feed-mark lc-feed-mark--proposed">
                <Spinner />
                <span className="lc-feed-sr">Proposed: </span>
              </span>
              <div className="lc-feed-body">
                <p className="lc-feed-title">
                  {agent.urgency === "routine" ? "Claude is reviewing the board…" : "Claude is deciding (urgent)…"}
                </p>
                {agent.lastWoke.length ? <p className="lc-feed-sub">Woke because: {wokeLine(agent.lastWoke)}</p> : null}
                {agent.queued ? <p className="lc-feed-meta">Next: {agent.queued === "urgent" ? "urgent follow-up queued" : "follow-up queued"}</p> : null}
                <p className="lc-feed-meta">Claude · {board ? simClock(board.minute) : "now"}</p>
              </div>
              {live ? (
                <IconButton
                  label={pendingOpen ? "Hide Claude's live reasoning" : "Show Claude's live reasoning"}
                  size="sm"
                  aria-expanded={pendingOpen}
                  aria-controls="lc-feed-pending-details"
                  onClick={() => toggle("__pending")}
                >
                  {pendingOpen ? "▴" : "▾"}
                </IconButton>
              ) : null}
            </div>
            {pendingOpen && live ? (
              <div id="lc-feed-pending-details" className="lc-feed-details">
                <span className="lc-feed-prov">
                  <EvidenceTag kind="ai_explanation" />
                </span>
                {agent.streamText ? <p className="lc-feed-detail-text">{agent.streamText.slice(-600)}</p> : null}
                {agent.thinking ? <p className="lc-feed-detail-muted lc-feed-thinking">{agent.thinking.slice(-600)}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {agentError ? (
          <div className="lc-feed-item lc-feed-attn lc-feed-attn--danger" role="status">
            <div className="lc-feed-row">
              <StateMark state="info" />
              <div className="lc-feed-body">
                <p className="lc-feed-title">
                  <Tag tone="danger">Claude error</Tag> Claude could not decide.
                </p>
                <p className="lc-feed-sub">{agentError}</p>
                <p className="lc-feed-meta">Claude</p>
              </div>
            </div>
          </div>
        ) : null}
        {items.length === 0 && !thinking && !agentError ? (
          board ? (
            <EmptyState title="No activity yet" symbol="•">
              Fires start from Simulation Studio.
            </EmptyState>
          ) : (
            <EmptyState title="Simulated board unavailable" symbol="•">
              Drill actions appear here once they happen.
            </EmptyState>
          )
        ) : (
          <ol className="lc-feed-list">
            {items.map((item) => {
              const isOpen = open.has(item.id);
              const detailsId = `lc-feed-d-${item.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
              const reports = item.reportIds && onSelectReports ? item.reportIds : null;
              const ref = item.boardRef && onSelectBoard ? item.boardRef : null;
              const select = reports ? () => onSelectReports?.(reports) : ref ? () => onSelectBoard?.(ref) : null;
              const time = item.minute !== null ? simClock(item.minute) : `${elapsed(serverNow - item.wallMs)} ago · drill`;
              const title = (
                <>
                  {item.attention ? <Tag tone={item.attention.tone}>{item.attention.label}</Tag> : null}
                  <span>{item.title}</span>
                </>
              );
              return (
                <li
                  key={item.id}
                  className={cx(
                    "lc-feed-item",
                    `lc-feed-item--${item.state}`,
                    item.attention && "lc-feed-attn",
                    item.attention && `lc-feed-attn--${item.attention.tone}`,
                  )}
                >
                  <div className="lc-feed-row">
                    <StateMark state={item.state} />
                    <div className="lc-feed-body">
                      {select ? (
                        <Button variant="ghost" size="sm" className="lc-feed-title lc-feed-open" onClick={select}>
                          {title}
                        </Button>
                      ) : (
                        <p className="lc-feed-title">{title}</p>
                      )}
                      {item.sub ? <p className="lc-feed-sub">{item.sub}</p> : null}
                      <p className="lc-feed-meta">
                        <span className="lc-feed-time">{time}</span>
                        {item.source !== "drill" ? <span> · {FEED_SOURCE_LABEL[item.source]}</span> : null}
                        {item.count > 1 ? <span> · {item.count} updates</span> : null}
                      </p>
                    </div>
                    <IconButton
                      label={isOpen ? "Hide details" : "Show details"}
                      size="sm"
                      aria-expanded={isOpen}
                      aria-controls={detailsId}
                      onClick={() => toggle(item.id)}
                    >
                      {isOpen ? "▴" : "▾"}
                    </IconButton>
                  </div>
                  {isOpen ? <Details item={item} id={detailsId} /> : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {onOpenAuditLog ? (
        <footer className="lc-feed-foot">
          <Button variant="ghost" size="sm" onClick={onOpenAuditLog}>
            Full audit log
          </Button>
        </footer>
      ) : null}
    </section>
  );
}
