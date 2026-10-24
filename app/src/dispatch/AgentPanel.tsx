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
    ["Reached an exit", totals.arrived, "dispatch-metric--good"],
    ["On the road", totals.enRoute, ""],
    ["Ordered, not yet out", totals.waiting, ""],
    ["No order yet", totals.notOrdered, ""],
    ["Exposed to fire", totals.exposed, "dispatch-metric--bad"],
  ];
  return (
    <>
      <dl className="dispatch-metrics">
        {items.map(([label, value, tone]) => (
          <div key={label} className={`dispatch-metric ${tone}`}>
            <dt>{label}</dt>
            <dd>{NUMBER.format(value)}</dd>
          </div>
        ))}
      </dl>
      {baseline && (
        <p className="dispatch-help">
          With no orders at all the model exposes{" "}
          <strong>{NUMBER.format(baseline.exposed)}</strong> of {NUMBER.format(baseline.vehicles)} vehicles by the
          horizon. Vehicles are synthetic estimates; “exposed” means the modelled fire reached them, not a casualty count.
        </p>
      )}
    </>
  );
}

function ZoneDetail({ engine, zoneId, onClose }: { engine: DispatchEngine; zoneId: string; onClose: () => void }) {
  const index = engine.area.zones.findIndex((zone) => zone.id === zoneId);
  if (index < 0) return null;
  const zone = engine.area.zones[index];
  const state = engine.zones[index];
  const contact = engine.exposure.zoneContact[index];
  const core = engine.exposure.zoneCore[index];
  const units = engine.units.filter((unit) => unit.zone === index).map((unit) => `${unit.id} (${unit.status})`);
  return (
    <section className="dispatch-zone" aria-label={`Zone ${zone.id}`}>
      <header>
        <strong>{zone.name}</strong>
        <button type="button" className="studio-btn studio-btn-secondary studio-btn-small" onClick={onClose}>
          Close
        </button>
      </header>
      <dl className="dispatch-facts">
        <div><dt>Status</dt><dd>{state.status.replace("_", " ")}{state.routeBlocked ? " · route blocked" : ""}</dd></div>
        <div><dt>Exit</dt><dd>{state.exitId ?? "—"}</dd></div>
        <div><dt>Vehicles (synthetic)</dt><dd>{NUMBER.format(zone.vehicles)}</dd></div>
        <div><dt>Waiting / on road / out / exposed</dt><dd>{NUMBER.format(state.notReady + state.queued)} / {NUMBER.format(engine.enRoute(index))} / {NUMBER.format(state.arrived)} / {NUMBER.format(state.exposed)}</dd></div>
        <div><dt>Fire reaches edge / core (model)</dt><dd>{Number.isFinite(contact) ? hhmm(contact) : "not in horizon"} / {Number.isFinite(core) ? hhmm(core) : "not in horizon"}</dd></div>
        <div><dt>Engines</dt><dd>{units.length > 0 ? units.join(", ") : "none"}</dd></div>
      </dl>
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
    <li className={`dispatch-entry dispatch-entry--${entry.status}`}>
      <header>
        <span className="dispatch-entry__time">{hhmm(entry.minute)}</span>
        <span>{entry.status === "streaming" ? "Reasoning…" : entry.status === "failed" ? "Decision failed" : "Decision"}</span>
        <span className="dispatch-tag">AI decision</span>
      </header>
      {entry.alerts.length > 0 && (
        <ul className="dispatch-alerts" aria-label="Alerts since the previous decision">
          {entry.alerts.slice(-6).map((alert, i) => (
            <li key={`${alert.minute}-${i}`} className={alert.urgent ? "is-urgent" : ""}>
              <span aria-hidden="true">{alert.urgent ? "⚠ " : "• "}</span>
              {hhmm(alert.minute)} {alert.text}
            </li>
          ))}
        </ul>
      )}
      {entry.thinking && (
        <details className="dispatch-thinking" open={entry.status === "streaming" && !entry.text}>
          <summary>Reasoning summary</summary>
          <p>{entry.thinking}</p>
        </details>
      )}
      {entry.text && <p className="dispatch-assessment">{entry.text}</p>}
      {entry.error && (
        <p className="dispatch-error" role="alert">
          {entry.error}
        </p>
      )}
      {entry.status === "done" && (
        <ul className="dispatch-orders" aria-label="Orders">
          {entry.outcomes.length === 0 && <li className="dispatch-order">No new orders.</li>}
          {entry.outcomes.map((outcome, i) => (
            <li key={i} className={`dispatch-order ${outcome.accepted ? "" : "is-rejected"}`}>
              <strong>
                <span aria-hidden="true">{outcome.accepted ? "✓ " : "✕ "}</span>
                {orderText(outcome.order)}
              </strong>
              <span>{outcome.accepted ? outcome.note : `Rejected by the simulator: ${outcome.note}`}</span>
              {outcome.order.reason && <em>{outcome.order.reason}</em>}
            </li>
          ))}
          {entry.rejected.map((item, i) => (
            <li key={`r${i}`} className="dispatch-order is-rejected">
              <strong><span aria-hidden="true">✕ </span>Dropped by the server</strong>
              <span>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {entry.model && <p className="dispatch-model">Model: {entry.model}</p>}
    </li>
  );
}

export default function AgentPanel(props: AgentPanelProps) {
  const { area, areaError, startBlocker, status, engine, log, baseline, speed, selectedZoneId } = props;
  const active = status !== "idle";
  const live = status === "running" || status === "thinking";

  return (
    <section className="dispatch-panel" aria-label="Dispatch agent">
      <header className="dispatch-panel__header">
        <div>
          <p className="dispatch-eyebrow">AI dispatcher · simulated</p>
          <h2>Dispatch agent</h2>
        </div>
        <span className={`dispatch-status dispatch-status--${status}`} role="status" aria-live="polite">
          <span className="dispatch-status__dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </span>
      </header>

      {areaError && <p className="dispatch-error" role="alert">{areaError}</p>}
      {!area && !areaError && <p className="dispatch-help">Loading roads, zones and fire stations…</p>}

      <div className="dispatch-controls">
        {!active || status === "finished" ? (
          <button type="button" className="studio-btn studio-btn-primary" disabled={startBlocker !== null} onClick={props.onStart}>
            {status === "finished" ? "Run agent again" : "Start agent"}
          </button>
        ) : status === "paused" ? (
          <button type="button" className="studio-btn studio-btn-primary" onClick={props.onResume}>
            Resume
          </button>
        ) : status === "failed" ? (
          <>
            <button type="button" className="studio-btn studio-btn-primary" onClick={props.onRetry}>
              Retry decision
            </button>
            <button type="button" className="studio-btn studio-btn-secondary" onClick={props.onSkip}>
              Continue without orders
            </button>
          </>
        ) : (
          <button type="button" className="studio-btn studio-btn-secondary" onClick={props.onPause} disabled={status === "thinking"}>
            Pause
          </button>
        )}
        {active && (
          <button type="button" className="studio-btn studio-btn-secondary" onClick={props.onStop}>
            Stop
          </button>
        )}
        <label className="dispatch-speed">
          Speed
          <select
            className="studio-input"
            value={speed}
            onChange={(event) => props.onSpeedChange(Number(event.target.value))}
          >
            {DISPATCH_SPEED_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} min/s
              </option>
            ))}
          </select>
        </label>
      </div>
      {startBlocker && !active && <p className="dispatch-help">{startBlocker}</p>}
      {live && (
        <p className="dispatch-help">
          {hhmm(engine?.minute ?? 0)} · the clock stops at each decision (every {DECISION_INTERVAL_MINUTES} min, sooner on
          urgent alerts) until the agent's orders arrive.
        </p>
      )}

      {engine && <Metrics totals={engine.totals()} baseline={baseline} />}
      {!engine && baseline && (
        <p className="dispatch-help">
          Fire run ready. With no orders the model exposes <strong>{NUMBER.format(baseline.exposed)}</strong> of{" "}
          {NUMBER.format(baseline.vehicles)} synthetic vehicles. Start the agent to see what dispatch changes.
        </p>
      )}

      {engine && selectedZoneId && (
        <ZoneDetail engine={engine} zoneId={selectedZoneId} onClose={() => props.onSelectZone(null)} />
      )}

      {log.length > 0 && (
        <ol className="dispatch-log" aria-label="Agent decisions, newest first">
          {log.map((entry) => (
            <LogEntry key={entry.id} entry={entry} />
          ))}
        </ol>
      )}

      <p className="dispatch-disclaimer">
        Planning experiment. The agent chooses among options the simulator computes; it does not change the fire, and
        its orders are not operational instructions.
      </p>
    </section>
  );
}
