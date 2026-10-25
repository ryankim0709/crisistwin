import { useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, EvidenceTag, LoadingState, Notice, Spinner, Tag, cx } from "../ui";
import { orderText } from "../live/auditEntries";
import { STATUS, STATUS_TONE } from "./agentStatus";
import AgentSpend from "./AgentSpend";
import {
  matchDecisions,
  digestInput,
  newestFirst,
  type CommsRow,
  type Delta,
  type DigestRow,
  type InputDigest,
  type ResourceRow,
} from "./agentInputsDigest";
import { simClock } from "./format";
import type { Board } from "./model";
import type { DecisionUsage, DemoObservation } from "./contracts";
import type { AgentInputSnapshot } from "./runContracts";
import type { CommandBoard } from "./useCommandBoard";
import type { AgentDecision } from "./useDemoAgent";
import "./agentInputs.css";

/** Characters of the live thinking / assessment text shown while a call is in flight. */
const LIVE_TAIL = 420;

const tail = (text: string, max = LIVE_TAIL) => (text.length <= max ? text : `…${text.slice(text.length - max)}`);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Agent fields lead B adds (`agent.inputs`, `agent.lastInput`), read through a cast until they land. */
type AgentWithInputs = { inputs?: AgentInputSnapshot[]; lastInput?: AgentInputSnapshot | null };

/** The recorded calls, newest first and without repeats; null when this build records none. */
function listInputs(raw: AgentInputSnapshot[] | undefined, last: AgentInputSnapshot | null | undefined): AgentInputSnapshot[] | null {
  const list = raw ?? (last ? [last] : null);
  if (!list) return null;
  const seen = new Set<string>();
  return newestFirst(list.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))));
}

// ---- small parts -------------------------------------------------------------------------

/** What changed since the previous call, as a shape plus words (never colour alone). */
function DeltaChip({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  const mark = { new: "NEW", up: "▲", down: "▼", changed: "◆" }[delta.kind];
  const word = { new: "New", up: "Up", down: "Down", changed: "Changed" }[delta.kind];
  return (
    <span className={`ais-delta ais-delta--${delta.kind}`} title={`${word}: ${delta.text}`}>
      <span aria-hidden="true">{mark}</span>
      <span className="ais-sr">{word}: </span>
      {delta.kind === "new" ? <span className="ais-sr">{delta.text}</span> : <span>{delta.text}</span>}
    </span>
  );
}

function Rows({ rows, empty }: { rows: DigestRow[]; empty: string }) {
  if (rows.length === 0) return <p className="ais-empty">{empty}</p>;
  return (
    <ul className="ais-rows">
      {rows.map((row) => (
        <li key={row.key} className={cx("ais-row", row.delta && "ais-row--changed")}>
          <div className="ais-row-head">
            <strong>{row.title}</strong>
            {row.tag ? <Tag tone={row.tag.tone}>{row.tag.text}</Tag> : null}
            <DeltaChip delta={row.delta} />
          </div>
          <p className="ais-row-detail">{row.detail}</p>
        </li>
      ))}
    </ul>
  );
}

/** A collapsible section of one call: title, a one-line summary, and "Changed" when anything moved. */
function Section({
  title,
  summary,
  changed,
  open = true,
  className,
  children,
}: {
  title: string;
  summary?: string;
  changed?: boolean;
  open?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cx("ais-sec", className)} open={open}>
      <summary>
        <h3>{title}</h3>
        {summary ? <span className="ais-sec-sum">{summary}</span> : null}
        {changed ? <Tag tone="info">Changed</Tag> : null}
      </summary>
      <div className="ais-sec-body">{children}</div>
    </details>
  );
}

function ResourceTable({ rows }: { rows: ResourceRow[] }) {
  if (rows.length === 0) return <p className="ais-empty">No units on the board.</p>;
  return (
    <table className="ais-table">
      <caption className="ais-sr">Units by type and what they are doing</caption>
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Available</th>
          <th scope="col">Assigned</th>
          <th scope="col">En route</th>
          <th scope="col">Other</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={cx(r.delta && "ais-row--changed")}>
            <th scope="row">
              {r.label}
              <span className="ais-table-sub">
                {r.total} total{r.detail ? `; ${r.detail}` : ""}
              </span>
              <DeltaChip delta={r.delta} />
            </th>
            <td>{r.available}</td>
            <td>
              {r.assigned}
              {r.onScene > 0 ? <span className="ais-table-sub">{r.onScene} on scene</span> : null}
            </td>
            <td>{r.enRoute}</td>
            <td>{r.other}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SEVERITY_TAG: Record<CommsRow["severity"], { text: string; tone: "neutral" | "warning" | "danger" } | null> = {
  info: null,
  urgent: { text: "Urgent", tone: "warning" },
  life_threat: { text: "Life threat", tone: "danger" },
};

function CommsTicker({ rows }: { rows: CommsRow[] }) {
  if (rows.length === 0) return <p className="ais-empty">No calls or radio traffic reached the agent in this call.</p>;
  return (
    <ul className="ais-comms" aria-label="Calls and radio traffic, newest first">
      {rows.map((m) => {
        const severity = SEVERITY_TAG[m.severity];
        return (
          <li key={m.key} className={cx("ais-comm", m.isNew && "ais-comm--new")}>
            <div className="ais-comm-head">
              <span className="ais-chan">
                <span aria-hidden="true">{m.glyph}</span> {m.channelLabel}
              </span>
              <span className="ais-comm-time">{simClock(m.minute)}</span>
              <span className="ais-comm-from">{m.from}</span>
              {severity ? <Tag tone={severity.tone}>{severity.text}</Tag> : null}
              {m.isNew ? <DeltaChip delta={{ kind: "new", text: "not in the previous call" }} /> : null}
              <Tag>{m.origin}</Tag>
            </div>
            <p className="ais-comm-text">{m.text}</p>
          </li>
        );
      })}
    </ul>
  );
}

// ---- decision --------------------------------------------------------------------------------

function nameResolver(obs: DemoObservation): (id: string) => string {
  const names = new Map<string, string>();
  for (const z of obs.zones) {
    names.set(z.id, z.name);
    for (const o of z.options) names.set(o.destination_id, o.name);
  }
  return (id) => names.get(id) ?? id;
}

function UsageLine({ usage }: { usage: DecisionUsage }) {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return (
    <p className="ais-usage">
      {usage.model}: {tokens(prompt)} prompt tokens ({tokens(usage.cache_read_input_tokens)} from cache), {tokens(usage.output_tokens)} output
      {usage.cost_usd !== null ? `, about $${usage.cost_usd.toFixed(3)}` : ", cost not priced"}.
    </p>
  );
}

function DecisionBlock({
  input,
  decision,
  inFlight,
  agent,
}: {
  input: AgentInputSnapshot;
  decision: AgentDecision | null;
  /** This is the newest call and Claude is still working on it. */
  inFlight: boolean;
  agent: CommandBoard["agent"];
}) {
  const nameOf = useMemo(() => nameResolver(input.observation), [input.observation]);
  if (decision) {
    const applied = decision.applied.filter((a) => a.error === null);
    const failed = decision.applied.filter((a) => a.error !== null);
    const usage = (decision as { usage?: DecisionUsage | null }).usage ?? null;
    return (
      <div className="ais-decision">
        <div className="ais-row-head">
          <Tag tone="info">Claude</Tag>
          <EvidenceTag kind="ai_explanation" />
          <span className="ais-meta">{decision.model}</span>
        </div>
        <p className="ais-summary">{decision.summary || "No summary."}</p>
        {decision.assessment ? (
          <details className="ais-more">
            <summary>Claude's assessment</summary>
            <p className="ais-assessment">{decision.assessment}</p>
          </details>
        ) : null}
        <p className="ais-orders-head">
          {applied.length === 0 ? "No orders applied." : `${applied.length} order${applied.length === 1 ? "" : "s"} applied to the simulated board:`}
        </p>
        {applied.length > 0 ? (
          <ul className="ais-orders">
            {applied.map((a, i) => (
              <li key={i}>
                <span aria-hidden="true">✓</span> <span className="ais-sr">Applied: </span>
                {orderText(a.order, nameOf)}
              </li>
            ))}
          </ul>
        ) : null}
        {failed.length > 0 || decision.rejected.length > 0 ? (
          <>
            <p className="ais-orders-head">Not applied:</p>
            <ul className="ais-orders ais-orders--rejected">
              {failed.map((a, i) => (
                <li key={`f${i}`}>
                  <span aria-hidden="true">✗</span> <span className="ais-sr">Not applied: </span>
                  {orderText(a.order, nameOf)} ({a.error})
                </li>
              ))}
              {decision.rejected.map((r, i) => (
                <li key={`r${i}`}>
                  <span aria-hidden="true">✗</span> <span className="ais-sr">Refused by the server: </span>
                  {r.reason}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {usage ? <UsageLine usage={usage} /> : null}
      </div>
    );
  }
  if (inFlight) {
    return (
      <div className="ais-decision" role="status" aria-live="polite">
        <p className="ais-summary">
          <Spinner /> Claude is deciding on this call{agent.urgency ? ` (${agent.urgency})` : ""}…
        </p>
        {agent.thinking ? <p className="ais-live">Thinking: {tail(agent.thinking)}</p> : null}
        {agent.streamText ? <p className="ais-live">Assessment so far: {tail(agent.streamText)}</p> : null}
      </div>
    );
  }
  if (agent.error && agent.status === "error") {
    return (
      <Notice tone="danger" compact>
        The last call failed: {agent.error}
      </Notice>
    );
  }
  return <p className="ais-empty">No decision was recorded for this call (it was cancelled, failed, or the board was reset).</p>;
}

// ---- exact input -----------------------------------------------------------------------------

function ExactInput({ input, sizeLabel }: { input: AgentInputSnapshot; sizeLabel: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Pretty-printed only while open, and once per call: the panel re-renders on every streamed token.
  const json = useMemo(() => (open ? JSON.stringify(input.observation, null, 2) : ""), [open, input.observation]);
  return (
    <details className="ais-sec ais-exact" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <h3>Exact input</h3>
        <span className="ais-sec-sum">The JSON posted to the agent, {sizeLabel}</span>
      </summary>
      <div className="ais-sec-body">
        {open ? (
          <>
            <div className="ais-exact-bar">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(json)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy JSON"}
              </Button>
              <span className="ais-meta">Simulated board data, shown unredacted; pretty-printed here ({sizeLabel} as sent).</span>
            </div>
            <pre className="ais-json" tabIndex={0} aria-label="Exact observation JSON">
              {json}
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

// ---- one call --------------------------------------------------------------------------------

function CallBody({
  input,
  previous,
  decision,
  inFlight,
  agent,
}: {
  input: AgentInputSnapshot;
  previous: AgentInputSnapshot | null;
  decision: AgentDecision | null;
  inFlight: boolean;
  agent: CommandBoard["agent"];
}) {
  const d: InputDigest = useMemo(() => digestInput(input, previous), [input, previous]);
  const changedRows = (rows: { delta: Delta | null }[]) => rows.some((r) => r.delta !== null);
  const trafficChanged = d.traffic.delta !== null || changedRows(d.traffic.closedRoads);
  return (
    <div className="ais-call-body">
      <Section title="Why Claude was called" summary={`${d.urgency === "urgent" ? "Urgent" : "Routine"} call at ${d.clockLabel}`}>
        <p className="ais-urgency">
          <Tag tone={d.urgency === "urgent" ? "warning" : "neutral"}>{d.urgency === "urgent" ? "Urgent: needs a decision now" : "Routine review"}</Tag>
          <span className="ais-meta">
            {d.firstCall ? "First call of this run." : `${d.minutesSincePrevious} board min after the previous call.`}
          </span>
        </p>
        {d.wake.reasons.length > 0 ? (
          <ul className="ais-bullets">
            {d.wake.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="ais-empty">No reason recorded.</p>
        )}
        {d.wake.sinceLast ? <p className="ais-since">{d.wake.sinceLast}</p> : null}
      </Section>

      <div className={cx("ais-changes", d.changes.length === 0 && "ais-changes--none")}>
        <h3>{d.firstCall ? "First call" : "Changed since the previous call"}</h3>
        {d.firstCall ? (
          <p className="ais-meta">Everything below is new to the agent.</p>
        ) : d.changes.length === 0 ? (
          <p className="ais-meta">No fires, zones, units, wind or messages changed enough to list.</p>
        ) : (
          <ul className="ais-bullets">
            {d.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
      </div>

      <Section title="Clock and weather" summary={`${d.clock.headline}; ${d.weather.headline}`} changed={d.weather.delta !== null}>
        <p className="ais-row-detail">{d.clock.detail}</p>
        <p className="ais-row-detail">
          {d.weather.headline}. <DeltaChip delta={d.weather.delta} />
        </p>
        <p className="ais-meta">Wind source: {d.weather.detail}</p>
      </Section>

      <Section title="Fires" summary={d.firesSummary} changed={changedRows(d.fires)}>
        <Rows rows={d.fires} empty="No fire has been reported to dispatch, so the agent sees none." />
      </Section>

      <Section title="Zones at risk" summary={d.zonesSummary} changed={changedRows(d.zones)}>
        <Rows rows={d.zones} empty="No zone is threatened or ordered." />
      </Section>

      <Section title="Traffic" summary={d.traffic.headline} changed={trafficChanged}>
        <p className="ais-row-detail">
          {d.traffic.headline} <DeltaChip delta={d.traffic.delta} />
        </p>
        {d.traffic.worst.length > 0 ? <Rows rows={d.traffic.worst} empty="" /> : null}
        {d.traffic.closedRoads.length > 0 ? (
          <>
            <p className="ais-orders-head">Closed roads (the agent's routes go around them):</p>
            <Rows rows={d.traffic.closedRoads} empty="" />
          </>
        ) : null}
      </Section>

      <Section title="Resources" summary={d.resourcesSummary} changed={changedRows(d.resources)}>
        <ResourceTable rows={d.resources} />
      </Section>

      <Section
        title="Radio and calls"
        summary={d.commsSummary}
        changed={d.comms.some((c) => c.isNew)}
      >
        {d.commsCounts.length > 0 ? (
          <p className="ais-counts" aria-label="Messages so far by channel">
            {d.commsCounts.map((c) => (
              <span key={c.channel} className="ais-chan">
                <span aria-hidden="true">{c.glyph}</span> {c.label}: {c.count}
              </span>
            ))}
          </p>
        ) : null}
        <CommsTicker rows={d.comms} />
      </Section>

      <Section title="Injuries waiting" summary={d.injuriesSummary} changed={changedRows(d.injuries)}>
        <Rows rows={d.injuries} empty="No injuries or help requests are open." />
      </Section>

      {d.extras.map((x) => (
        <Section key={x.key} title={x.title} summary={x.note} open={false}>
          <Rows rows={x.rows} empty="Nothing to show." />
        </Section>
      ))}

      {d.outcomes || d.previousDecision ? (
        <Section title="Score and last decision" summary={d.outcomes ?? undefined} open={false}>
          {d.outcomes ? <p className="ais-row-detail">{d.outcomes} Simulated.</p> : null}
          {d.previousDecision ? <p className="ais-row-detail">The agent was reminded of its previous decision. {d.previousDecision}</p> : null}
        </Section>
      ) : null}

      <Section title="Decision" summary={decision ? decision.summary : inFlight ? "Claude is deciding" : "No decision recorded"}>
        <DecisionBlock input={input} decision={decision} inFlight={inFlight} agent={agent} />
      </Section>

      <ExactInput input={input} sizeLabel={d.sizeLabel} />
    </div>
  );
}

function wallTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---- panel -----------------------------------------------------------------------------------

/**
 * "What the agent sees": the AI commander's inputs for each call, in plain language and newest call
 * on top, with what changed since the previous call highlighted, then the decision it produced.
 * The numbers are the simulated board's (DemoObservation: simulator output, sourced data and
 * labelled assumptions); the decision text is Claude's explanation (AI-generated). Each call's
 * exact JSON is under "Exact input". Reads `agent.inputs` / `agent.lastInput` (useDemoAgent, lead B)
 * and the decision log; sizes itself with CSS variable `--ais-max-height` (default 80vh), so a host
 * with its own scroll area can set it to `none` or `100%`.
 */
export default function AgentInputsPanel({ agent, board }: { agent: CommandBoard["agent"]; board: Board | null }) {
  const { inputs: rawInputs, lastInput } = agent as AgentWithInputs;
  const inputs = useMemo(() => listInputs(rawInputs, lastInput), [rawInputs, lastInput]);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const thinking = agent.status === "thinking";
  const newest = inputs?.[0] ?? null;
  const decided = useMemo(() => matchDecisions(inputs ?? [], agent.decisions), [inputs, agent.decisions]);

  return (
    <section className="ais-root" aria-labelledby="ais-title">
      <header className="ais-head">
        <div className="ais-head-row">
          <h2 id="ais-title">What the agent sees</h2>
          <span role="status" aria-live="polite">
            <Tag tone={STATUS_TONE[agent.status]}>
              {thinking ? <Spinner /> : null} {STATUS[agent.status]}
            </Tag>
          </span>
        </div>
        <p className="ais-head-note">
          What Claude was sent for each call, in plain words, newest first. Board numbers are <EvidenceTag kind="simulated" />; its decisions are{" "}
          <EvidenceTag kind="ai_explanation" />.
        </p>
        {board && newest ? (
          <p className="ais-meta">
            {inputs?.length} call{inputs?.length === 1 ? "" : "s"} kept. Board is at {simClock(board.minute)}
            {board.minute > newest.minute ? `, ${board.minute - newest.minute} min after the last call.` : "."}
          </p>
        ) : null}
      </header>

      {!board ? (
        <LoadingState>Loading the simulated board…</LoadingState>
      ) : !inputs || inputs.length === 0 ? (
        <EmptyState title="Agent hasn't been called yet" symbol="…">
          {agent.status === "off"
            ? "The AI agent is off. Switch it on, or press Ask Claude now, and every call's inputs appear here."
            : agent.status === "thinking"
              ? "Claude is being called now; its inputs appear as soon as the call starts."
              : agent.status === "error"
                ? `The first call failed: ${agent.error ?? "unknown error"}.`
                : "Claude is watching the board and is called when something needs a decision. Its inputs appear here."}
        </EmptyState>
      ) : (
        <ol className="ais-list" aria-label="Agent calls, newest first">
          {inputs.map((input, index) => {
            const open = toggled[input.id] ?? index === 0;
            const decision = decided.get(input.id) ?? null;
            const orders = decision ? decision.applied.filter((a) => a.error === null).length : null;
            const inFlight = thinking && index === 0 && !decision;
            return (
              <li key={input.id} className="ais-call">
                <details
                  open={open}
                  onToggle={(e) => {
                    const now = e.currentTarget.open;
                    if (now !== open) setToggled((t) => ({ ...t, [input.id]: now }));
                  }}
                >
                  <summary className="ais-call-sum">
                    <span className="ais-call-title">
                      {simClock(input.minute)}
                      {index === 0 ? <Tag tone="brand">Latest</Tag> : null}
                      <Tag tone={input.urgency === "urgent" ? "warning" : "neutral"}>{input.urgency === "urgent" ? "Urgent" : "Routine"}</Tag>
                      {inFlight ? (
                        <Tag tone="info">
                          <Spinner /> Deciding
                        </Tag>
                      ) : orders !== null ? (
                        <Tag tone={orders > 0 ? "success" : "neutral"}>{orders} order{orders === 1 ? "" : "s"}</Tag>
                      ) : null}
                    </span>
                    <span className="ais-call-why">{input.reasons[0] ?? "No reason recorded."}</span>
                    <span className="ais-meta">
                      {wallTime(input.sentAtMs)} · {(input.bytes / 1000).toFixed(1)} kB
                    </span>
                  </summary>
                  {open ? (
                    <CallBody input={input} previous={inputs[index + 1] ?? null} decision={decision} inFlight={inFlight} agent={agent} />
                  ) : null}
                </details>
              </li>
            );
          })}
        </ol>
      )}
      <AgentSpend spend={agent.spend} />
    </section>
  );
}
