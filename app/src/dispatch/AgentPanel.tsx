import {
  Button,
  Eyebrow,
  EvidenceTag,
  Facts,
  LoadingState,
  Metric,
  Notice,
  SegmentedControl,
  Spinner,
  Tag,
  type TagTone,
} from "../ui";
import type { DispatchArea } from "./area";
import type { DispatchEngine, Totals } from "./engine";
import { DECISION_INTERVAL_MINUTES } from "./engine";
import type { DecisionLogEntry, SessionStatus } from "./useDispatchSession";
import { DISPATCH_SPEED_CHOICES } from "./useDispatchSession";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Agent idle",
  running: "Agent running",
  thinking: "Agent thinking…",
  paused: "Paused",
  failed: "Agent needs attention",
  finished: "Run finished",
};

const STATUS_TONE: Record<SessionStatus, TagTone> = {
  idle: "neutral",
  running: "success",
  thinking: "info",
  paused: "neutral",
  failed: "danger",
  finished: "brand",
};

const SPEED_OPTIONS = DISPATCH_SPEED_CHOICES.map((choice) => ({
  value: String(choice),
  label: `${choice} min/s`,
}));

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `T+${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface AgentPanelProps {
  area: DispatchArea | null;
  areaError: string | null;
  /** Null when the agent can start; otherwise why not. */
  startBlocker: string | null;
  status: SessionStatus;
  engine: DispatchEngine | null;
  log: DecisionLogEntry[];
  baseline: Totals | null;
  speed: number;
  selectedZoneId: string | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onSpeedChange: (speed: number) => void;
  onSelectZone: (zoneId: string | null) => void;
}

function Metrics({ totals, baseline }: { totals: Totals; baseline: Totals | null }) {
  const items: [string, number, string][] = [
    ["Reached an exit", totals.arrived, "dsp-metric--good"],
    ["On the road", totals.enRoute, ""],
    ["Ordered, not yet out", totals.waiting, ""],
    ["No order yet", totals.notOrdered, ""],
    ["Exposed to fire", totals.exposed, "dsp-metric--bad"],
  ];
  return (
    <section className="dsp-section" aria-label="Simulated outcome">
      <div className="dsp-section__head">
        <h3>Outcome so far</h3>
        <EvidenceTag kind="simulated" />
      </div>
      <div className="dsp-metrics">
        {items.map(([label, value, tone]) => (
          <Metric
            key={label}
            className={`dsp-metric ${tone}`}
            label={label}
            value={NUMBER.format(value)}
          />
        ))}
      </div>
      {baseline && (
        <p className="dsp-help">
          With no orders at all the model exposes <strong>{NUMBER.format(baseline.exposed)}</strong>{" "}
          of {NUMBER.format(baseline.vehicles)} vehicles by the horizon. Vehicles are synthetic
          estimates; “exposed” means the modelled fire reached them, not a casualty count.
        </p>
      )}
    </section>
  );
}

function ZoneDetail({
  engine,
  zoneId,
  onClose,
}: {
  engine: DispatchEngine;
  zoneId: string;
  onClose: () => void;
}) {
  const index = engine.area.zones.findIndex((zone) => zone.id === zoneId);
  if (index < 0) return null;
  const zone = engine.area.zones[index];
  const state = engine.zones[index];
  const contact = engine.exposure.zoneContact[index];
  const core = engine.exposure.zoneCore[index];
  const units = engine.units
    .filter((unit) => unit.zone === index)
    .map((unit) => `${unit.id} (${unit.status})`);
  return (
    <section className="dsp-zone" aria-label={`Zone ${zone.id}`}>
      <header>
        <strong>{zone.name}</strong>
        <EvidenceTag kind="simulated" />
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      <Facts
        items={[
          {
            label: "Status",
            value: `${state.status.replace("_", " ")}${state.routeBlocked ? " · route blocked" : ""}`,
          },
          { label: "Exit", value: state.exitId ?? "—" },
          { label: "Vehicles (synthetic)", value: NUMBER.format(zone.vehicles) },
          {
            label: "Waiting / on road / out / exposed",
            value: `${NUMBER.format(state.notReady + state.queued)} / ${NUMBER.format(engine.enRoute(index))} / ${NUMBER.format(state.arrived)} / ${NUMBER.format(state.exposed)}`,
          },
          {
            label: "Fire reaches edge / core (model)",
            value: `${Number.isFinite(contact) ? hhmm(contact) : "not in horizon"} / ${Number.isFinite(core) ? hhmm(core) : "not in horizon"}`,
          },
          { label: "Engines", value: units.length > 0 ? units.join(", ") : "none" },
        ]}
      />
    </section>
  );
}

function orderText(entry: DecisionLogEntry["outcomes"][number]["order"]): string {
  if (entry.type === "order_evacuation") return `Evacuate ${entry.zone_id} via ${entry.exit_id}`;
  if (entry.type === "dispatch_unit") {
    return `${entry.unit_id} → ${entry.zone_id} (${entry.task === "evacuation_support" ? "evacuation support" : "structure defense"})`;
  }
  return `Recall ${entry.unit_id}`;
}

function LogEntry({ entry }: { entry: DecisionLogEntry }) {
  return (
    <li className={`dsp-entry dsp-entry--${entry.status}`}>
      <header>
        <span className="dsp-entry__time">{hhmm(entry.minute)}</span>
        <span>
          {entry.status === "streaming"
            ? "Reasoning…"
            : entry.status === "failed"
              ? "Decision failed"
              : "Decision"}
        </span>
        <span className="dsp-entry__tag">
          <EvidenceTag kind="ai_explanation" />
        </span>
      </header>
      {entry.alerts.length > 0 && (
        <ul className="dsp-alerts" aria-label="Simulator alerts since the previous decision">
          {entry.alerts.slice(-6).map((alert, i) => (
            <li key={`${alert.minute}-${i}`} className={alert.urgent ? "is-urgent" : ""}>
              <span aria-hidden="true">{alert.urgent ? "⚠ " : "• "}</span>
              {hhmm(alert.minute)} {alert.text}
            </li>
          ))}
        </ul>
      )}
      {entry.thinking && (
        <details className="dsp-thinking" open={entry.status === "streaming" && !entry.text}>
          <summary>AI reasoning summary</summary>
          <p>{entry.thinking}</p>
        </details>
      )}
      {entry.text && <p className="dsp-assessment">{entry.text}</p>}
      {entry.error && (
        <Notice tone="danger" className="dsp-notice">
          {entry.error}
        </Notice>
      )}
      {entry.status === "done" && (
        <>
          <div className="dsp-section__head">
            <h3>Orders, checked by the simulator</h3>
            <EvidenceTag kind="simulated" />
          </div>
          <ul className="dsp-orders" aria-label="Orders">
            {entry.outcomes.length === 0 && <li className="dsp-order">No new orders.</li>}
            {entry.outcomes.map((outcome, i) => (
              <li key={i} className={`dsp-order ${outcome.accepted ? "" : "is-rejected"}`}>
                <strong>
                  <span aria-hidden="true">{outcome.accepted ? "✓ " : "✕ "}</span>
                  {orderText(outcome.order)}
                </strong>
                <span>
                  {outcome.accepted ? outcome.note : `Rejected by the simulator: ${outcome.note}`}
                </span>
                {outcome.order.reason && <em>AI reason: {outcome.order.reason}</em>}
              </li>
            ))}
            {entry.rejected.map((item, i) => (
              <li key={`r${i}`} className="dsp-order is-rejected">
                <strong>
                  <span aria-hidden="true">✕ </span>Dropped by the server
                </strong>
                <span>{item.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {entry.model && <p className="dsp-model">Model: {entry.model}</p>}
    </li>
  );
}

export default function AgentPanel(props: AgentPanelProps) {
  const { area, areaError, startBlocker, status, engine, log, baseline, speed, selectedZoneId } =
    props;
  const active = status !== "idle";
  const live = status === "running" || status === "thinking";

  return (
    <section className="dsp-panel" id="dispatch-agent-panel" aria-label="Dispatch agent">
      <header className="dsp-panel__header">
        <div>
          <Eyebrow>AI dispatcher</Eyebrow>
          <h2>Dispatch agent</h2>
        </div>
        <span role="status" aria-live="polite">
          <Tag tone={STATUS_TONE[status]}>
            {status === "thinking" && <Spinner />}
            {STATUS_LABEL[status]}
          </Tag>
        </span>
      </header>
      <p className="dsp-provenance">
        <EvidenceTag kind="ai_explanation" /> <EvidenceTag kind="simulated" /> Reasoning and orders
        come from the AI; every number and outcome is computed by the simulator.
      </p>

      {areaError && (
        <Notice tone="danger" className="dsp-notice">
          {areaError}
        </Notice>
      )}
      {!area && !areaError && <LoadingState>Loading roads, zones and fire stations…</LoadingState>}

      <div className="dsp-controls">
        {!active || status === "finished" ? (
          <Button size="sm" disabled={startBlocker !== null} onClick={props.onStart}>
            {status === "finished" ? "Run agent again" : "Start agent"}
          </Button>
        ) : status === "paused" ? (
          <Button size="sm" onClick={props.onResume}>
            Resume
          </Button>
        ) : status === "failed" ? (
          <>
            <Button size="sm" onClick={props.onRetry}>
              Retry decision
            </Button>
            <Button variant="secondary" size="sm" onClick={props.onSkip}>
              Continue without orders
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={props.onPause}
            disabled={status === "thinking"}
          >
            Pause
          </Button>
        )}
        {active && (
          <Button variant="secondary" size="sm" onClick={props.onStop}>
            Stop
          </Button>
        )}
        <div className="dsp-speed">
          <SegmentedControl
            label="Agent run speed"
            options={SPEED_OPTIONS}
            value={String(speed)}
            onChange={(value) => props.onSpeedChange(Number(value))}
          />
        </div>
      </div>
      {startBlocker && !active && (
        <Notice tone="info" className="dsp-notice">
          {startBlocker}
        </Notice>
      )}
      {live && (
        <p className="dsp-help">
          {hhmm(engine?.minute ?? 0)} · the clock stops at each decision (every{" "}
          {DECISION_INTERVAL_MINUTES} min, sooner on urgent alerts) until the agent's orders arrive.
        </p>
      )}

      {engine && <Metrics totals={engine.totals()} baseline={baseline} />}
      {!engine && baseline && (
        <p className="dsp-help">
          Fire run ready. With no orders the model exposes{" "}
          <strong>{NUMBER.format(baseline.exposed)}</strong> of {NUMBER.format(baseline.vehicles)}{" "}
          synthetic vehicles. Start the agent to see what dispatch changes.
        </p>
      )}

      {engine && selectedZoneId && (
        <ZoneDetail
          engine={engine}
          zoneId={selectedZoneId}
          onClose={() => props.onSelectZone(null)}
        />
      )}

      {log.length > 0 && (
        <ol className="dsp-log" aria-label="Agent decisions, newest first">
          {log.map((entry) => (
            <LogEntry key={entry.id} entry={entry} />
          ))}
        </ol>
      )}

      <p className="dsp-disclaimer">
        Planning experiment. The agent picks among options the simulator computes; it does not
        change the fire.
      </p>
    </section>
  );
}
