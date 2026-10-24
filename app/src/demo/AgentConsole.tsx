import { Button, EvidenceTag, Notice, Spinner, Tag } from "../ui";
import type { DemoOrder } from "./contracts";
import { simClock } from "./format";
import type { useDemoAgent } from "./useDemoAgent";

type Agent = ReturnType<typeof useDemoAgent>;

function orderText(order: DemoOrder, name: (id: string) => string): string {
  if (order.type === "send_crew") return `Send ${order.crew_id} to ${order.fire_id}`;
  if (order.type === "release_crew") return `Release ${order.crew_id}`;
  return `Evacuate ${name(order.zone_id)} to ${name(order.destination_id)}`;
}

const STATUS: Record<Agent["status"], string> = {
  off: "Autopilot off",
  watching: "Watching",
  thinking: "Deciding",
  error: "Error",
};

export default function AgentConsole({
  agent,
  autopilot,
  onAutopilot,
  hold,
  onHold,
  name,
}: {
  agent: Agent;
  /** Display name for a zone or destination id. */
  name: (id: string) => string;
  autopilot: boolean;
  onAutopilot: (on: boolean) => void;
  hold: boolean;
  onHold: (on: boolean) => void;
}) {
  const latest = agent.decisions[0];
  return (
    <section className="dm-section" aria-label="AI incident commander">
      <div className="dm-section-head">
        <h2>AI incident commander</h2>
        <span className="dm-tags">
          <Tag tone={agent.status === "error" ? "danger" : agent.status === "thinking" ? "info" : "neutral"}>
            {agent.status === "thinking" ? <Spinner /> : null} {STATUS[agent.status]}
          </Tag>
          <EvidenceTag kind="ai_explanation" />
        </span>
      </div>
      <div className="dm-actions">
        <Button size="sm" variant={autopilot ? "primary" : "secondary"} aria-pressed={autopilot} onClick={() => onAutopilot(!autopilot)}>
          {autopilot ? "Autopilot on" : "Turn autopilot on"}
        </Button>
        <Button size="sm" variant="ghost" disabled={agent.status === "thinking"} onClick={agent.decideNow}>
          Ask Claude now
        </Button>
      </div>
      <label className="ui-check dm-check">
        <input type="checkbox" checked={hold} onChange={(e) => onHold(e.target.checked)} />
        Hold the clock while Claude decides
      </label>
      {agent.error ? (
        <Notice tone="danger" compact>
          {agent.error}
        </Notice>
      ) : null}
      {agent.status === "thinking" ? (
        <div className="dm-stream" aria-live="polite">
          {agent.lastWoke.length ? <p className="dm-woke">Woke because: {agent.lastWoke.join("; ")}</p> : null}
          {agent.streamText ? <p>{agent.streamText}</p> : null}
          {agent.thinking ? <p className="dm-thinking">{agent.thinking.slice(-600)}</p> : null}
        </div>
      ) : null}
      {agent.decisions.length === 0 && agent.status !== "thinking" ? (
        <p className="lc-dim dm-note">
          {autopilot
            ? "Claude is watching. It is called when something changes: a new fire, a fire its teams cannot hold, freed teams, a zone running out of time, or a periodic review."
            : "Turn autopilot on to let Claude send teams and order evacuations, or ask it once."}
        </p>
      ) : null}
      <ol className="dm-decisions">
        {agent.decisions.map((d) => (
          <li key={d.id} className={d === latest ? "is-latest" : undefined}>
            <div className="dm-decision-head">
              <span className="lc-num">{simClock(d.minute)}</span>
              {d.wokeBecause.length ? <span className="lc-dim">{d.wokeBecause.join("; ")}</span> : null}
            </div>
            <p>{d.summary || d.assessment || "No change needed."}</p>
            {d.applied.length ? (
              <ul className="dm-orders">
                {d.applied.map((a, i) => (
                  <li key={i}>
                    <Tag tone={a.error ? "danger" : "success"}>{a.error ? "Refused" : "Done"}</Tag>{" "}
                    {orderText(a.order, name)}
                    {a.order.reason ? <span className="lc-dim"> · {a.order.reason}</span> : null}
                    {a.error ? <span className="lc-error"> · {a.error}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {d.rejected.length ? (
              <ul className="dm-orders">
                {d.rejected.map((r, i) => (
                  <li key={i}>
                    <Tag tone="danger">Rejected</Tag> <span className="lc-error">{r.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
