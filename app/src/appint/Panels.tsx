// Side panels of the App integration tab: who is on the app, what waits for the controller's OK,
// the message timeline and what the simulated people did.
import { useState, type KeyboardEvent } from "react";
import { Button, EmptyState, Notice, Panel, Tag } from "../ui";
import { drillClock, wallClock } from "../live/format";
import type { PeopleSnapshot } from "../live/people";
import type { CommandResponse, HelpRequest } from "../live/types";
import { ago, BEHAVIOURS, behaviourOf, flagTone, isJoinedNow, nf, peopleInZones, plainProposal, zoneLabel } from "./plain";
import type { Participant, ParticipantMessage } from "./types";

/** Solid dot = real phone, hollow = simulated; a square for a responder (shape, not only colour). */
export function PersonGlyph({ p, size = 14 }: { p: Pick<Participant, "kind" | "role">; size?: number }) {
  const fill = p.kind === "real" ? "var(--ct-app-user)" : "var(--ct-surface)";
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="aix-glyph">
      {p.role === "responder" ? (
        <rect x="2" y="2" width="10" height="10" rx="2" fill={fill} stroke="var(--ct-app-user)" strokeWidth="2" />
      ) : (
        <circle cx="7" cy="7" r="5" fill={fill} stroke="var(--ct-app-user)" strokeWidth="2" />
      )}
    </svg>
  );
}

// ---- On our app ----

export function ParticipantList({
  participants,
  selectedId,
  onSelect,
  nowMs,
  loading,
  error,
  adding,
  addError,
  onAdd,
  onInvite,
}: {
  participants: Participant[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  nowMs: number;
  loading: boolean;
  error: string | null;
  adding: boolean;
  addError: string | null;
  onAdd: () => void;
  onInvite: () => void;
}) {
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = participants.findIndex((p) => p.id === selectedId);
    const next = participants[Math.min(participants.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      onSelect(next.id);
      document.getElementById(`aix-p-${next.id}`)?.focus();
    }
  };
  return (
    <Panel title="On our app" compact className="aix-people" aria-label="People on our app">
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
      {loading && participants.length === 0 ? (
        <p className="aix-dim">Loading…</p>
      ) : participants.length === 0 ? (
        <EmptyState title="Nobody yet" symbol="○" action={<Button size="sm" variant="secondary" onClick={onInvite}>Invite phones</Button>}>
          Invite a phone or add a simulated person.
        </EmptyState>
      ) : (
        <ul className="aix-list" role="listbox" aria-label="People on our app" onKeyDown={onKey}>
          {participants.map((p) => {
            const on = p.id === selectedId;
            const stale = p.kind === "real" && !isJoinedNow(p, nowMs);
            return (
              <li
                key={p.id}
                id={`aix-p-${p.id}`}
                role="option"
                aria-selected={on}
                tabIndex={on || (!selectedId && p === participants[0]) ? 0 : -1}
                className={`aix-row${on ? " is-selected" : ""}`}
                onClick={() => onSelect(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(p.id);
                  }
                }}
              >
                <PersonGlyph p={p} />
                <span className="aix-row-body">
                  <span className="aix-row-name">
                    {p.name}
                    <span className="aix-visually-hidden">
                      {p.kind === "real" ? ", real person" : ", simulated person"}
                      {p.role === "responder" ? ", responder" : ""}
                    </span>
                  </span>
                  <span className="aix-row-status">{p.status || "No news yet"}</span>
                  {stale ? <span className="aix-row-status aix-dim">Last seen {ago(p.last_seen, nowMs)}</span> : null}
                </span>
                {p.flags.length ? (
                  <span className="aix-flags">
                    {p.flags.slice(0, 2).map((f) => (
                      <Tag key={f} tone={flagTone(f)}>
                        {f}
                      </Tag>
                    ))}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="secondary" size="sm" block onClick={onAdd} disabled={adding}>
        {adding ? "Adding…" : "+ Add a simulated person"}
      </Button>
      {addError ? (
        <Notice tone="warning" compact>
          {addError}
        </Notice>
      ) : null}
      <ul className="aix-key-list" aria-label="Key">
        <li>
          <PersonGlyph p={{ kind: "real", role: "resident" }} size={12} /> Real person
        </li>
        <li>
          <PersonGlyph p={{ kind: "simulated", role: "resident" }} size={12} /> Simulated, makes their own choices
        </li>
        <li>
          <PersonGlyph p={{ kind: "real", role: "responder" }} size={12} /> Responder
        </li>
      </ul>
    </Panel>
  );
}

// ---- Needs your OK ----

export type Decide = (key: string, action: () => Promise<unknown>) => Promise<void>;

export function NeedsOk({
  data,
  people,
  participants,
  busy,
  error,
  onDecide,
  approve,
  reject,
  assignHelp,
  acknowledgeHelp,
  nowMs,
}: {
  data: CommandResponse | null;
  people: PeopleSnapshot | null;
  participants: Participant[];
  busy: string | null;
  error: string | null;
  onDecide: Decide;
  approve: (id: string) => Promise<unknown>;
  reject: (id: string) => Promise<unknown>;
  assignHelp: (checkinId: string) => Promise<unknown>;
  acknowledgeHelp: (checkinId: string) => Promise<unknown>;
  nowMs: number;
}) {
  const pending = (data?.proposals ?? []).filter((p) => p.status === "pending" && p.changes.length + p.tasks.length > 0);
  const help = (data?.checkins.need_help ?? []).filter((h) => h.help?.status === "open" || h.help?.status === "acknowledged");
  if (!data) return null;
  const whoNeeds = (h: HelpRequest) =>
    participants.find((p) => p.position && h.coord && p.position[0] === h.coord[0] && p.position[1] === h.coord[1] && p.flags.includes("Needs help"));
  const appIn = (zoneIds: string[]) => {
    const ids = new Set(zoneIds);
    return participants.filter((p) => p.role === "resident" && p.zone_id && ids.has(p.zone_id)).length;
  };
  return (
    <Panel title="Needs your OK" compact className="aix-ok" aria-label="Needs your OK">
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
      {pending.length === 0 && help.length === 0 ? <p className="aix-dim">Nothing waiting. New messages to phones show here first.</p> : null}
      {pending.map((p) => {
        const plain = plainProposal(p, data);
        const n = peopleInZones(plain.zoneIds, people, data);
        const app = appIn(plain.zoneIds);
        return (
          <article key={p.id} className="aix-card" aria-label={plain.title}>
            <strong className="aix-card-title">{plain.title}</strong>
            {plain.lines.map((l) => (
              <span key={l} className="aix-card-line">
                {l}
              </span>
            ))}
            <span className="aix-card-detail">
              {n !== null ? `About ${nf(n)} people. ` : ""}
              {app ? `${app} of them use our app.` : "None of them use our app."}
            </span>
            <div className="aix-card-actions">
              <Button size="sm" disabled={busy !== null} onClick={() => void onDecide(`approve:${p.id}`, () => approve(p.id))}>
                {busy === `approve:${p.id}` ? "Sending…" : "Send"}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void onDecide(`reject:${p.id}`, () => reject(p.id))}>
                Don't send
              </Button>
            </div>
          </article>
        );
      })}
      {help.map((h) => {
        const who = whoNeeds(h);
        const where = h.zone_id ? zoneLabel(data, h.zone_id) : "an unknown zone";
        return (
          <article key={h.id} className="aix-card aix-card--help" aria-label={`Help request in ${where}`}>
            <strong className="aix-card-title">Send a responder to {who ? who.name : `someone in ${where}`}</strong>
            <span className="aix-card-detail">
              Asked for help {ago(h.at, nowMs)}
              {h.help?.status === "acknowledged" ? ", told we got it" : ""}
              {!h.coord ? ". No location shared." : "."}
            </span>
            <div className="aix-card-actions">
              <Button size="sm" disabled={busy !== null || !h.coord} onClick={() => void onDecide(`assign:${h.id}`, () => assignHelp(h.id))}>
                Send a responder
              </Button>
              {h.help?.status === "open" ? (
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void onDecide(`ack:${h.id}`, () => acknowledgeHelp(h.id))}>
                  Tell them we got it
                </Button>
              ) : null}
            </div>
          </article>
        );
      })}
    </Panel>
  );
}

// ---- Messages ----

export function MessagesPanel({ messages, loading }: { messages: ParticipantMessage[]; loading: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? messages : messages.slice(0, 12);
  return (
    <Panel title="Messages" compact className="aix-messages" aria-label="Messages">
      {loading && messages.length === 0 ? <p className="aix-dim">Loading…</p> : null}
      {!loading && messages.length === 0 ? <p className="aix-dim">Nothing sent or received yet.</p> : null}
      <ol className="aix-timeline">
        {shown.map((m, i) => (
          <li key={`${m.at}-${i}`} className={`aix-msg aix-msg--${m.direction}`}>
            <span className="aix-msg-time">{m.replay_at ? drillClock(m.replay_at) : wallClock(m.at)}</span>
            <span className="aix-msg-dir" aria-hidden="true">
              {m.direction === "to" ? "→" : "←"}
            </span>
            <span className="aix-msg-text">
              {m.text}
              {m.kind === "simulated" ? <span className="aix-dim"> (simulated)</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {messages.length > 12 ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${messages.length}`}
        </Button>
      ) : null}
      <p className="aix-note">Times are drill time (UTC).</p>
    </Panel>
  );
}

// ---- What simulated people did ----

export function BehaviourPanel({ participants, onAdd, adding }: { participants: Participant[]; onAdd: () => void; adding: boolean }) {
  const sims = participants.filter((p) => p.kind === "simulated" && p.role === "resident");
  const counts = new Map<string, number>();
  for (const p of sims) counts.set(behaviourOf(p), (counts.get(behaviourOf(p)) ?? 0) + 1);
  return (
    <Panel title="What simulated people did" compact className="aix-behaviour" aria-label="What simulated people did">
      {sims.length === 0 ? (
        <EmptyState
          title="No simulated people yet"
          symbol="○"
          action={
            <Button size="sm" variant="secondary" onClick={onAdd} disabled={adding}>
              + Add a simulated person
            </Button>
          }
        >
          Like real people, they don't always do what they're told.
        </EmptyState>
      ) : (
        <>
          <p className="aix-dim">Like real people, they don't always do what they're told.</p>
          <ul className="aix-bars">
            {BEHAVIOURS.map((b) => {
              const n = counts.get(b) ?? 0;
              return (
                <li key={b}>
                  <span>{b}</span>
                  <span className="aix-bar" aria-hidden="true">
                    <span style={{ width: `${(100 * n) / Math.max(1, sims.length)}%` }} />
                  </span>
                  <strong>{n}</strong>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}
