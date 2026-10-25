import { Button, LoadingState, Notice, SegmentedControl, Spinner, Tag, type SegmentedOption } from "../ui";
import { STATUS, STATUS_TONE } from "./agentStatus";
import AgentSpend from "./AgentSpend";
import type { useDemoAgent } from "./useDemoAgent";

type Agent = ReturnType<typeof useDemoAgent>;
type OnOff = "off" | "on";

const OPTIONS: SegmentedOption<OnOff>[] = [
  { value: "off", label: "Off", title: "Claude is not called and the clock is paused" },
  {
    value: "on",
    label: "On",
    title:
      "The clock runs; Claude watches the board and is called when something changes: it may send teams or order evacuations",
  },
];

/**
 * The AI commander's switch, status and one-shot ask, as the first row of the /live "Controls"
 * block (its decisions are in the activity feed and the full audit log, labelled AI-generated
 * there). The live board is AI agent only (AI_ONLY_TEXT, in the block's Details drawer): the
 * switch also runs the board clock (useCommandBoard), and "Ask Claude now" while it is off is one
 * decision on the paused board.
 */
export default function AgentControl({
  agent,
  ready,
  autopilot,
  onAutopilot,
}: {
  agent: Agent;
  /** False until the simulated board has loaded; the controls wait for it. */
  ready: boolean;
  autopilot: boolean;
  onAutopilot: (on: boolean) => void;
}) {
  const status = agent.status === "watching" ? "Watching" : STATUS[agent.status];
  if (!ready) return <LoadingState>Loading the simulated board…</LoadingState>;
  return (
    <div className="lc-agent" role="group" aria-labelledby="lc-agent-title">
      <div className="lc-agent-row">
        <span id="lc-agent-title" className="lc-sim-label">
          AI agent
        </span>
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
      </div>
      <div className="lc-agent-row lc-agent-row--sub">
        <Button
          variant="secondary"
          size="sm"
          className="lc-agent-ask"
          disabled={agent.status === "thinking"}
          title={
            autopilot
              ? "Call Claude now, without waiting for a change on the board"
              : "One decision on the paused board: its orders apply now, the clock stays paused"
          }
          onClick={agent.decideNow}
        >
          Ask Claude now
        </Button>
        <AgentSpend spend={agent.spend} />
      </div>
      {agent.error ? (
        <Notice tone="danger" compact>
          {agent.error}
        </Notice>
      ) : null}
    </div>
  );
}
