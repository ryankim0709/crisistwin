import { useMemo, useState, type ReactNode } from "react";
import { Button, Eyebrow, EvidenceTag, LoadingState, Notice, Spinner, Tag, cx } from "../ui";
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
import { describeActions, incidentStatus, knowsNow, tookText, type ActionLine, type IncidentStatus, type KnowsNow } from "./agentNowDigest";
import { minutesText, simClock } from "./format";
import type { Board, ZoneForecast } from "./model";
import type { DecisionUsage } from "./contracts";
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
              <span className="ais-comm-time">{m.timeLabel}</span>
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


// ---- decision usage ----------------------------------------------------------------------------

function UsageLine({ usage }: { usage: DecisionUsage }) {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return (
    <p className="ais-usage">
      {usage.model}: {tokens(prompt)} prompt tokens ({tokens(usage.cache_read_input_tokens)} from cache), {tokens(usage.output_tokens)} output
      {usage.cost_usd !== null ? `, about $${usage.cost_usd.toFixed(3)}` : ", cost not priced"}.
    </p>
  );
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
                disabled={typeof navigator === "undefined" || !navigator.clipboard}
                onClick={() => {
                  navigator.clipboard
                    .writeText(json)
                    .then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy JSON"}
              </Button>
              <span className="ais-meta">Simulated board data, shown unredacted; pretty-printed here ({sizeLabel} as sent).</span>
            </div>
            <pre className="ais-json" tabIndex={0} role="region" aria-label="Exact observation JSON">
              {json}
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

// ---- one call --------------------------------------------------------------------------------

function CallBody({ input, previous }: { input: AgentInputSnapshot; previous: AgentInputSnapshot | null }) {
  const d: InputDigest = useMemo(() => digestInput(input, previous), [input, previous]);
  const changedRows = (rows: { delta: Delta | null }[]) => rows.some((r) => r.delta !== null);
  const trafficChanged = d.traffic.delta !== null || changedRows(d.traffic.closedRoads);
  return (
    <div className="ais-call-body">
      <Section title="Why Claude was called" summary={`${d.urgency === "urgent" ? "Urgent" : "Routine"} call at ${d.clockLabel}`}>
        <p className="ais-urgency">
          <Tag tone={d.urgency === "urgent" ? "warning" : "neutral"}>{d.urgency === "urgent" ? "Urgent: needs a decision now" : "Routine review"}</Tag>
          <span className="ais-meta">
            {d.firstCall ? "First call of this run." : `${minutesText(d.minutesSincePrevious ?? 0).replace(/ min$/, "")} board min after the previous call.`}
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

      <ExactInput input={input} sizeLabel={d.sizeLabel} />
    </div>
  );
}


function wallTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Shared by blocks that have nothing to show in this phase. */
const EMPTY_FORECASTS: Map<string, ZoneForecast> = new Map();

/** The run step the host is in (/run: setup, baseline, ai). /live passes none. */
export type AgentPanelPhase = "setup" | "baseline" | "ai";

// ---- incident status (the live board) ---------------------------------------------------------

function IncidentBlock({ board, forecasts }: { board: Board | null; forecasts: Map<string, ZoneForecast> }) {
  const minute = board ? Math.floor(board.minute) : -1;
  // The board is mutated in place; its score is refreshed once per board minute (as the run timeline is).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const status: IncidentStatus | null = useMemo(() => (board ? incidentStatus(board, forecasts) : null), [board, minute, forecasts]);
  return (
    <section className="ais-block ais-incident" aria-labelledby="ais-incident-title">
      <header className="ais-block-head">
        <h3 id="ais-incident-title">Incident status</h3>
        <EvidenceTag kind="simulated" />
        {status ? <span className="ais-meta ais-block-time">board {status.clockLabel}</span> : null}
      </header>
      {!status ? (
        <p className="ais-empty">The board has not loaded yet.</p>
      ) : (
        <>
          {status.fires.length === 0 ? (
            <p className="ais-empty">No fire has started on the board yet.</p>
          ) : (
            <ul className="ais-lines" aria-label="Fires on the board">
              {status.fires.map((f) => (
                <li key={f.key} className="ais-fire">
                  <div className="ais-fire-head">
                    <strong className="ais-ellip" title={f.title}>
                      {f.title}
                    </strong>
                    {f.reported ? null : <Tag tone="warning">Not yet reported</Tag>}
                    <Tag tone={f.status.tone}>{f.status.text}</Tag>
                  </div>
                  <p className="ais-ellip ais-fire-line" title={`${f.size}; ${f.spread}`}>
                    <strong>{f.size}</strong> · {f.spread}
                  </p>
                </li>
              ))}
              {status.firesMore > 0 ? (
                <li className="ais-meta">
                  + {status.firesMore} more fire{status.firesMore === 1 ? "" : "s"} (contained or out)
                </li>
              ) : null}
            </ul>
          )}
          <dl className="ais-stats" aria-label="Incident totals">
            {status.stats.map((s) => (
              <div key={s.key} className="ais-stat" title={s.title}>
                <dt className="ais-ellip">{s.label}</dt>
                <dd>
                  <strong>{s.value}</strong>
                  {s.sub ? <small className="ais-ellip">{s.sub}</small> : null}
                </dd>
              </div>
            ))}
          </dl>
          <div className="ais-units" role="group" aria-label="Units committed, of the whole fleet">
            {status.units.map((u) => (
              <div key={u.key} className="ais-unit" title={u.title}>
                <span className="ais-ellip">{u.label}</span>
                <strong>
                  {u.committed}
                  <small> of {u.total}</small>
                </strong>
              </div>
            ))}
          </div>
          <p className="ais-meta">
            Units committed = sent to a fire or patient now. {status.caughtIsHouseholds ? "Caught counts households (people not known for every zone). " : ""}
            Board model output, not observed.
          </p>
        </>
      )}
    </section>
  );
}

// ---- what Claude knows now (the latest observation) --------------------------------------------

const SEVERITY_WORD: Record<CommsRow["severity"], string | null> = { info: null, urgent: "Urgent", life_threat: "Life threat" };

function KnowsBlock({
  phase,
  agent,
  newest,
  previous,
  board,
  inFlight,
  status,
}: {
  phase: AgentPanelPhase | undefined;
  agent: CommandBoard["agent"];
  newest: AgentInputSnapshot | null;
  previous: AgentInputSnapshot | null;
  board: Board | null;
  inFlight: boolean;
  /** The agent's status tag, drawn in the header when the panel has no header of its own. */
  status: ReactNode;
}) {
  const k: KnowsNow | null = useMemo(() => (newest ? knowsNow(newest, previous) : null), [newest, previous]);
  let body: ReactNode;
  if (phase === "setup" || phase === "baseline") {
    body = (
      <p className="ais-empty">
        {phase === "baseline"
          ? "Nobody acts in the baseline: the AI agent is off, so it is sent nothing and sees nothing. The incident status above is the board running on its own."
          : "The AI agent is called in step 3 (AI dispatch). Until then it is sent nothing."}
      </p>
    );
  } else if (!newest || !k) {
    body = (
      <p className="ais-empty">
        {agent.status === "off"
          ? "The AI agent is off. Switch it on, or press Ask Claude now, and what it is sent appears here."
          : agent.status === "thinking"
            ? "Claude is being called now; what it is sent appears as soon as the call starts."
            : agent.status === "error"
              ? `The first call failed: ${agent.error ?? "unknown error"}.`
              : "Claude is watching the board and is called when something needs a decision."}
      </p>
    );
  } else {
    body = (
      <>
        <div className="ais-why">
          <p className="ais-ellip2" title={k.reasons.join("; ")}>
            <Tag tone={k.urgency === "urgent" ? "warning" : "neutral"}>{k.urgency === "urgent" ? "Urgent" : "Routine"}</Tag> {k.reasons[0] ?? "No reason recorded."}
          </p>
          <p className="ais-meta">
            Last called at {k.clockLabel} ({wallTime(newest.sentAtMs)}){inFlight ? ", still deciding" : ""}
            {board && board.minute - newest.minute >= 1 ? `; the board has run ${minutesText(board.minute - newest.minute)} since` : ""}.
          </p>
        </div>
        <p className="ais-ellip" title={k.wind}>
          <span aria-hidden="true">≋ </span>
          {k.wind}
        </p>

        <div className="ais-sub">
          <Eyebrow>Fires</Eyebrow>
          {k.fires.length === 0 ? (
            <p className="ais-empty">No fire has been reported to dispatch, so Claude sees none.</p>
          ) : (
            <ul className="ais-lines">
              {k.fires.map((f) => (
                <li key={f.key} className="ais-fire">
                  <div className="ais-fire-head">
                    <strong className="ais-ellip" title={f.title}>
                      {f.title}
                    </strong>
                    <Tag tone={f.status.tone}>{f.status.text}</Tag>
                  </div>
                  <p className="ais-ellip ais-fire-line" title={`${f.size}; ${f.growth}`}>
                    <strong>{f.size}</strong> · {f.growth}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ais-sub">
          <Eyebrow>Zones at risk: forecast share burned</Eyebrow>
          {k.zones.length === 0 ? (
            <p className="ais-empty">No zone is threatened or ordered.</p>
          ) : (
            <div className="ais-zt" role="table" aria-label="Zones at risk with forecast share burned and order status">
              <div className="ais-zt-row ais-zt-head" role="row">
                <span role="columnheader">Zone</span>
                {k.zoneHorizons.map((h) => (
                  <span key={h} role="columnheader" className="ais-zt-num">
                    +{h}
                  </span>
                ))}
                <span role="columnheader">Order</span>
              </div>
              {k.zones.map((z) => (
                <div key={z.key} className="ais-zt-row" role="row">
                  <span role="cell" className="ais-zt-name">
                    <span className="ais-ellip" title={z.name}>
                      {z.name}
                    </span>
                    {z.eta ? (
                      <small className="ais-ellip" title={z.eta}>
                        {z.eta}
                      </small>
                    ) : null}
                  </span>
                  {z.burned.map((b, i) => (
                    <span key={i} role="cell" className="ais-zt-num">
                      {b}
                    </span>
                  ))}
                  <span role="cell" className="ais-zt-order" title={z.order.title}>
                    <Tag tone={z.order.tone}>{z.order.text}</Tag>
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="ais-meta">
            Columns: share of the zone burned that many minutes from now.
            {k.zonesMore > 0 ? ` + ${k.zonesMore} more zone${k.zonesMore === 1 ? "" : "s"} listed in the call.` : ""}
          </p>
        </div>

        <div className="ais-sub">
          <Eyebrow>Road load</Eyebrow>
          <p className="ais-ellip2" title={k.roadsNow}>
            {k.roadsNow}
          </p>
          {k.roads.map((r) => (
            <p key={r.key} className="ais-ellip" title={`${r.name}: ${r.detail}`}>
              <span aria-hidden="true">{r.danger ? "⚠" : "•"} </span>
              <strong>{r.name}</strong> {r.detail}
            </p>
          ))}
        </div>

        <div className="ais-sub">
          <Eyebrow>Units</Eyebrow>
          {k.units.length === 0 ? (
            <p className="ais-empty">No units on the board.</p>
          ) : (
            <div className="ais-ut" role="table" aria-label="Units by type: available, en route, on scene">
              <div className="ais-ut-row ais-zt-head" role="row">
                <span role="columnheader">Type</span>
                <span role="columnheader" className="ais-zt-num">
                  Free
                </span>
                <span role="columnheader" className="ais-zt-num">
                  En route
                </span>
                <span role="columnheader" className="ais-zt-num">
                  On scene
                </span>
              </div>
              {k.units.map((u) => (
                <div key={u.key} className="ais-ut-row" role="row">
                  <span role="cell" className="ais-ellip" title={`${u.label}: ${u.total} in all`}>
                    {u.label} <small>of {u.total}</small>
                  </span>
                  <span role="cell" className="ais-zt-num">
                    {u.available}
                  </span>
                  <span role="cell" className="ais-zt-num">
                    {u.enRoute}
                  </span>
                  <span role="cell" className="ais-zt-num">
                    {u.onScene}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ais-sub">
          <Eyebrow>Radio and calls (simulated)</Eyebrow>
          {k.comms.length === 0 ? (
            <p className="ais-empty">No calls or radio traffic reached the agent in this call.</p>
          ) : (
            <ul className="ais-lines" aria-label="Newest calls and radio traffic">
              {k.comms.map((m) => {
                const severity = SEVERITY_WORD[m.severity];
                return (
                  <li key={m.key} className="ais-ellip" title={`${m.channelLabel} ${m.timeLabel}, ${m.from}: ${m.text}`}>
                    <span aria-hidden="true">{m.glyph} </span>
                    <span className="ais-sr">{m.channelLabel}. </span>
                    <span className="ais-comm-time">{m.timeLabel}</span> {severity ? <strong className="ais-sev">{severity}. </strong> : null}
                    <span className="ais-comm-from">{m.from}:</span> {m.text}
                    {m.origin !== "Simulated" ? <span className="ais-meta"> ({m.origin})</span> : null}
                  </li>
                );
              })}
              {k.commsMore > 0 ? <li className="ais-meta">+ {k.commsMore} older in the call details below</li> : null}
            </ul>
          )}
        </div>
      </>
    );
  }
  return (
    <section className="ais-block ais-now" aria-labelledby="ais-now-title">
      <header className="ais-block-head">
        <h3 id="ais-now-title">What Claude knows now</h3>
        <EvidenceTag kind="simulated" />
        {status ? <span className="ais-block-time">{status}</span> : null}
      </header>
      {body}
    </section>
  );
}

// ---- what Claude did (the decision feed) -------------------------------------------------------

/** A <details> whose body is built only once opened (a call's full digest is heavy to render). */
function LazyDetails({ summary, className, children }: { summary: ReactNode; className?: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open ? children() : null}
    </details>
  );
}

function ActionList({ lines, rejected }: { lines: ActionLine[]; rejected: AgentDecision["rejected"] }) {
  return (
    <ul className="ais-acts" aria-label="Orders">
      {lines.map((l) => (
        <li key={l.key} className={cx("ais-ac", !l.ok && "ais-ac--no")}>
          <span className="ais-ac-mark" aria-hidden="true">
            {l.ok ? "✓" : "✗"}
          </span>
          <span className="ais-ac-text">
            <span className="ais-sr">{l.ok ? "Done: " : "Board refused: "}</span>
            {l.text}
            {l.error ? <small className="ais-ac-err">Board refused it: {l.error}</small> : null}
          </span>
        </li>
      ))}
      {rejected.map((r, i) => (
        <li key={`r${i}`} className="ais-ac ais-ac--no">
          <span className="ais-ac-mark" aria-hidden="true">
            ✗
          </span>
          <span className="ais-ac-text">
            <span className="ais-sr">Refused by the server: </span>
            An order was refused: <small className="ais-ac-err">{r.reason}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

function DecisionEntry({
  decision,
  input,
  previous,
  board,
  latest,
}: {
  decision: AgentDecision;
  input: AgentInputSnapshot | null;
  previous: AgentInputSnapshot | null;
  board: Board | null;
  latest: boolean;
}) {
  const lines = useMemo(() => describeActions(decision, input?.observation ?? null, board), [decision, input, board]);
  const done = lines.filter((l) => l.ok).length;
  const refused = lines.length - done + decision.rejected.length;
  const usage = (decision as { usage?: DecisionUsage | null }).usage ?? null;
  const reasons = lines.filter((l) => l.reasons.length > 0);
  return (
    <li className={cx("ais-act", latest && "ais-act--latest")}>
      <div className="ais-act-head">
        <strong className="ais-act-time">{simClock(decision.minute)}</strong>
        {latest ? <Tag tone="brand">Latest</Tag> : null}
        <Tag tone={done > 0 ? "success" : "neutral"}>
          {done} order{done === 1 ? "" : "s"}
        </Tag>
        {refused > 0 ? <Tag tone="danger">{refused} refused</Tag> : null}
        <span className="ais-meta ais-act-took">
          took {tookText(decision.latencyMs)}
          {decision.landedMinute > decision.minute ? `; landed ${simClock(decision.landedMinute)}` : ""}
        </span>
      </div>
      {lines.length === 0 && decision.rejected.length === 0 ? (
        <p className="ais-act-none">No orders: Claude reviewed the board and changed nothing.</p>
      ) : (
        <ActionList lines={lines} rejected={decision.rejected} />
      )}
      <p className="ais-act-why">
        <EvidenceTag kind="ai_explanation" /> {decision.summary || "No summary given."}
      </p>
      {decision.assessment || reasons.length > 0 ? (
        <details className="ais-more">
          <summary>Claude's reasons and assessment</summary>
          {reasons.length > 0 ? (
            <ul className="ais-bullets">
              {reasons.map((l) => (
                <li key={l.key}>
                  <strong>{l.text}:</strong> {l.reasons.join(" / ")}
                </li>
              ))}
            </ul>
          ) : null}
          {decision.assessment ? <p className="ais-assessment">{decision.assessment}</p> : null}
        </details>
      ) : null}
      {input ? (
        <LazyDetails className="ais-more ais-call-details" summary="What it was sent: why it was called, changes, full inputs">
          {() => (
            <>
              {usage ? <UsageLine usage={usage} /> : null}
              <CallBody input={input} previous={previous} />
            </>
          )}
        </LazyDetails>
      ) : (
        <p className="ais-meta">That call's inputs are no longer kept (the panel keeps the last calls).</p>
      )}
    </li>
  );
}

const FEED_SHOWN = 8;

function DidBlock({
  phase,
  agent,
  inputs,
  decided,
  board,
}: {
  phase: AgentPanelPhase | undefined;
  agent: CommandBoard["agent"];
  inputs: AgentInputSnapshot[] | null;
  decided: Map<string, AgentDecision>;
  board: Board | null;
}) {
  const [all, setAll] = useState(false);
  const thinking = agent.status === "thinking";
  const newest = inputs?.[0] ?? null;
  // Which call each decision answered (so its inputs sit under it).
  const inputOf = useMemo(() => {
    const m = new Map<AgentDecision, AgentInputSnapshot>();
    for (const i of inputs ?? []) {
      const d = decided.get(i.id);
      if (d) m.set(d, i);
    }
    return m;
  }, [inputs, decided]);
  const decisions = agent.decisions;
  const shown = all ? decisions : decisions.slice(0, FEED_SHOWN);
  const inFlight = thinking && newest !== null && !decided.has(newest.id);

  let body: ReactNode;
  if (phase === "setup" || phase === "baseline") {
    body = (
      <p className="ais-empty">
        {phase === "baseline"
          ? "Nothing: nobody acts in the baseline. No units are sent and no evacuation is ordered; the fire and traffic run on their own."
          : "Nothing yet. Claude's orders are listed here during step 3 (AI dispatch)."}
      </p>
    );
  } else if (decisions.length === 0 && !inFlight && !(agent.status === "error" && agent.error)) {
    body = (
      <p className="ais-empty">
        {agent.status === "off"
          ? "The AI agent is off, so it has issued no orders."
          : "Claude has not issued any orders yet. Each decision, its orders and its reason are listed here, newest first."}
      </p>
    );
  } else {
    body = (
      <>
        {agent.status === "error" && agent.error ? (
          <Notice tone="danger" compact>
            The last call failed: {agent.error}
          </Notice>
        ) : null}
        <ol className="ais-feed" aria-label="Claude's decisions, newest first">
          {inFlight && newest ? (
            <li className="ais-act ais-act--live">
              <div className="ais-act-head">
                <strong className="ais-act-time">{simClock(newest.minute)}</strong>
                <Tag tone="info">
                  <Spinner /> Deciding
                </Tag>
                <span className="ais-meta ais-act-took">
                  call sent {wallTime(newest.sentAtMs)}
                  {agent.urgency ? `, ${agent.urgency}` : ""}
                </span>
              </div>
              {/* Only this line is a live region: the streamed text below changes with every token. */}
              <p className="ais-act-none" role="status">
                Claude is working on this call; its orders appear here when they land.
              </p>
              {agent.thinking ? <p className="ais-live">Thinking: {tail(agent.thinking)}</p> : null}
              {agent.streamText ? <p className="ais-live">Assessment so far: {tail(agent.streamText)}</p> : null}
            </li>
          ) : null}
          {shown.map((d, index) => {
            const input = inputOf.get(d) ?? null;
            const at = input && inputs ? inputs.indexOf(input) : -1;
            return <DecisionEntry key={d.id} decision={d} input={input} previous={at >= 0 ? (inputs?.[at + 1] ?? null) : null} board={board} latest={index === 0 && !inFlight} />;
          })}
        </ol>
        {decisions.length > FEED_SHOWN ? (
          <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)} aria-expanded={all}>
            {all ? "Show fewer decisions" : `Show ${decisions.length - FEED_SHOWN} older decisions`}
          </Button>
        ) : null}
      </>
    );
  }
  return (
    <section className="ais-block ais-did" aria-labelledby="ais-did-title">
      <header className="ais-block-head">
        <h3 id="ais-did-title">What Claude did</h3>
        <EvidenceTag kind="ai_explanation" />
        {decisions.length > 0 ? (
          <span className="ais-meta ais-block-time">
            {decisions.length} decision{decisions.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </header>
      {body}
    </section>
  );
}

// ---- panel -----------------------------------------------------------------------------------

/**
 * The right-hand panel of /run and /live, top to bottom:
 * 1. Incident status: the live board (fires, acres burned, homes lost, people), shown in every
 *    phase, including the baseline where nobody acts;
 * 2. What Claude knows now: a compact picture of the LATEST observation it was sent (board
 *    numbers, simulated; DemoObservation in contracts.ts);
 * 3. What Claude did: its decisions, newest first, each with plain-language orders, its stated
 *    reason (AI explanation), anything the board or server refused, and the call's full inputs
 *    under a collapsible.
 * Board numbers are simulated; the reasons are Claude's explanation (AI-generated). Reads
 * `agent.inputs` / `agent.lastInput` (useDemoAgent) and the decision log. The panel never scrolls
 * sideways; it sizes itself with CSS variable `--ais-max-height` (default 80vh; `none` lets the
 * host scroll it).
 */
export default function AgentInputsPanel({
  agent,
  board,
  forecasts = EMPTY_FORECASTS,
  phase,
  embedded = false,
  showSpend = true,
}: {
  agent: CommandBoard["agent"];
  board: Board | null;
  /** The commander's zone forecasts (useCommandBoard `forecasts`); without them "still at risk" counts zones the fire has touched. */
  forecasts?: Map<string, ZoneForecast>;
  /** /run's step; "setup" and "baseline" say that the agent is off. Omit on /live. */
  phase?: AgentPanelPhase;
  /** The host draws the panel's title (/run), so the panel omits its own. */
  embedded?: boolean;
  /** The session spend line; /live hides it because AgentControl shows it. */
  showSpend?: boolean;
}) {
  const { inputs: rawInputs, lastInput } = agent as AgentWithInputs;
  const inputs = useMemo(() => listInputs(rawInputs, lastInput), [rawInputs, lastInput]);
  const thinking = agent.status === "thinking";
  const newest = inputs?.[0] ?? null;
  const decided = useMemo(() => matchDecisions(inputs ?? [], agent.decisions), [inputs, agent.decisions]);
  const inFlight = thinking && newest !== null && !decided.has(newest.id);
  const agentActive = phase !== "setup" && phase !== "baseline";

  // What the agent is doing, in words (never colour alone). The host's own title row (/run) has no room for it, so
  // embedded it sits in the "What Claude knows now" header; otherwise it is in this panel's header.
  const statusTag = agentActive ? (
    <span role="status" aria-live="polite">
      <Tag tone={STATUS_TONE[agent.status]}>
        {thinking ? <Spinner /> : null} {STATUS[agent.status]}
      </Tag>
    </span>
  ) : (
    <span title="Nobody acts in this step: the AI agent is off.">
      <Tag>Agent off</Tag>
    </span>
  );

  return (
    <section className={cx("ais-root", embedded && "ais-root--embedded")} aria-label={embedded ? "What the agent sees" : undefined} aria-labelledby={embedded ? undefined : "ais-title"}>
      {embedded ? null : (
        <header className="ais-head">
          <div className="ais-head-row">
            <h2 id="ais-title">What the agent sees</h2>
            {statusTag}
          </div>
          <p className="ais-head-note">
            The board now, what Claude was sent, and what it did. Board numbers are <EvidenceTag kind="simulated" />; its reasons are <EvidenceTag kind="ai_explanation" />.
          </p>
        </header>
      )}

      <IncidentBlock board={board} forecasts={forecasts} />

      {!board ? (
        <LoadingState>Loading the simulated board…</LoadingState>
      ) : (
        <>
          <KnowsBlock
            phase={phase}
            agent={agent}
            newest={agentActive ? newest : null}
            previous={inputs?.[1] ?? null}
            board={board}
            inFlight={inFlight}
            status={embedded ? statusTag : null}
          />
          <DidBlock phase={phase} agent={agent} inputs={inputs} decided={decided} board={board} />
        </>
      )}
      {showSpend && agentActive ? <AgentSpend spend={agent.spend} /> : null}
    </section>
  );
}
