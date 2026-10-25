import type { ReactNode } from "react";
import { Button, EvidenceTag, LoadingState, Notice, SegmentedControl, Spinner, Tag, type SegmentedOption } from "../ui";
import { STATUS, STATUS_TONE } from "./agentStatus";
import type { useDemoAgent } from "./useDemoAgent";

type Agent = ReturnType<typeof useDemoAgent>;
type OnOff = "off" | "on";

const OPTIONS: SegmentedOption<OnOff>[] = [
  { value: "off", label: "Off", title: "Claude is not called" },
  {
    value: "on",
    label: "On",
    title:
      "Claude watches the simulated board and is called when something changes: it may send teams or order evacuations",
  },
];

/**
 * The AI commander's switch, status and one-shot ask, without its decision list (that lives in
 * the audit log). `aside` sits at the right of the header (page-level buttons such as Details).
 */
export default function AgentControl({
  agent,
  ready,
  autopilot,
  onAutopilot,
  aside,
}: {
  agent: Agent;
  /** False until the simulated board has loaded; the controls wait for it. */
  ready: boolean;
  autopilot: boolean;
  onAutopilot: (on: boolean) => void;
  aside?: ReactNode;
}) {
  const status = agent.status === "watching" ? "Watching" : STATUS[agent.status];
  return (
    <section className="lc-agent" aria-labelledby="lc-agent-title">
      <div className="lc-agent-head">
        <h2 id="lc-agent-title">AI agent</h2>
        <EvidenceTag kind="ai_explanation" />
        <span className="lc-agent-aside">{aside}</span>
      </div>
      {ready ? (
        <>
          <div className="lc-agent-row">
            <SegmentedControl
              label="AI agent"
              options={OPTIONS}
              value={autopilot ? "on" : "off"}
              onChange={(v) => onAutopilot(v === "on")}
            />
            <span role="status" aria-live="polite">
              <Tag tone={STATUS_TONE[agent.status]}>
                {agent.status === "thinking" ? <Spinner /> : null} {status}
              </Tag>
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="lc-agent-ask"
              disabled={agent.status === "thinking"}
              onClick={agent.decideNow}
            >
              Ask Claude now
            </Button>
          </div>
          {agent.error ? (
            <Notice tone="danger" compact>
              {agent.error}
            </Notice>
          ) : null}
        </>
      ) : (
        <LoadingState>Loading the simulated board…</LoadingState>
      )}
    </section>
  );
}
