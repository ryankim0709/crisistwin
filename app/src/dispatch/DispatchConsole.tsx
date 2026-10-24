/**
 * The dispatcher's console beside the diorama: setup checklist, household totals against the
 * no-action baseline, the latest orders, and three tabs — the evacuation board (zones in the
 * order they were told to leave, with route, progress and a check when clear), fire crews and
 * the agent's decision log. Every number is engine output; the agent's text is labelled.
 */

import { useState } from "react";
import { Button } from "../ui";
import type { DispatchArea } from "./area";
import type { DispatchEngine, Order, Totals, UnitState, ZoneState } from "./engine";
import { DECISION_INTERVAL_MINUTES } from "./engine";
import { HOME_COLORS, cssColor, exitColor } from "./scene/DispatchOverlay";
import type { DecisionLogEntry, SessionStatus } from "./useDispatchSession";
import { DISPATCH_SPEED_CHOICES } from "./useDispatchSession";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Standing by",
  running: "On shift",
  thinking: "Deciding…",
  paused: "Paused",
  failed: "Needs attention",
  finished: "Run finished",
};

export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `T+${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export type SetupStep = {
  label: string;
  detail: string;
  state: "done" | "active" | "waiting" | "error";
};

type Tab = "board" | "crews" | "log";

export interface DispatchConsoleProps {
  area: DispatchArea | null;
  steps: SetupStep[];
  /** Null when the agent can start; otherwise why not. */
  startBlocker: string | null;
  status: SessionStatus;
  engine: DispatchEngine | null;
  /** Bumped on every engine step so the console re-reads it. */
  version: number;
  log: DecisionLogEntry[];
  baseline: Totals | null;
  speed: number;
  selectedZone: number | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onSpeedChange: (speed: number) => void;
  onSelectZone: (zone: number | null) => void;
}

function etaText(arrival: number, now: number): string {
  if (!Number.isFinite(arrival)) return "No fire forecast";
  const minutes = Math.round(arrival - now);
  return minutes <= 0 ? "Fire in zone" : `Fire in ${minutes} min`;
}

function Tiles({ totals, baseline }: { totals: Totals; baseline: Totals | null }) {
  const tiles: [string, number, number][] = [
    ["Safe", totals.safe, HOME_COLORS[4]],
    ["Driving out", totals.onRoad, HOME_COLORS[3]],
    ["Ordered, still home", totals.waiting, HOME_COLORS[1]],
    ["Caught by fire", totals.caught, HOME_COLORS[5]],
  ];
  const segments: [number, number][] = [
    [totals.safe, HOME_COLORS[4]],
    [totals.onRoad, HOME_COLORS[3]],
    [totals.waiting, HOME_COLORS[1]],
    [totals.notOrdered, HOME_COLORS[0]],
    [totals.caught, HOME_COLORS[5]],
  ];
  return (
    <section className="dsp-kpis" aria-label="Households">
      <dl className="dsp-tiles">
        {tiles.map(([label, value, color]) => (
          <div key={label} className="dsp-tile">
            <dt>
              <span
                className="dsp-dot"
                style={{ background: cssColor(color) }}
                aria-hidden="true"
              />
              {label}
            </dt>
            <dd>{NUMBER.format(value)}</dd>
          </div>
        ))}
      </dl>
      <div
        className="dsp-bar"
        role="img"
        aria-label={`${totals.safe} of ${totals.homes} homes safe`}
      >
        {segments.map(([value, color], i) =>
          value > 0 ? (
            <span key={i} style={{ flexGrow: value, background: cssColor(color) }} />
          ) : null,
        )}
      </div>
      <p className="dsp-note">
        {NUMBER.format(totals.homes)} synthetic homes · {NUMBER.format(totals.notOrdered)} without
        an order yet.
        {baseline && (
          <>
            {" "}
            With no orders the fire model catches <strong>
              {NUMBER.format(baseline.caught)}
            </strong>{" "}
            by the horizon.
          </>
        )}
      </p>
    </section>
  );
}

function orderLine(
  order: Order,
  area: DispatchArea,
): { icon: string; text: string; color?: number } {
  if (order.type === "order_evacuation") {
    const exit = area.exits.find((candidate) => candidate.id === order.exit_id);
    return {
      icon: "📣",
      text: `Evacuate ${order.zone_id} via ${order.exit_id}${exit ? ` · ${exit.name}` : ""}`,
      color: exitColor(area, order.exit_id),
    };
  }
  if (order.type === "dispatch_unit") {
    return {
      icon: "🚒",
      text: `${order.unit_id} → ${order.zone_id}, ${order.task === "evacuation_support" ? "evacuation support" : "structure defense"}`,
    };
  }
  return { icon: "↩", text: `Recall ${order.unit_id} to station` };
}

function LatestOrders({ entry, area }: { entry: DecisionLogEntry; area: DispatchArea }) {
  return (
    <section
      className={`dsp-radio dsp-radio--${entry.status}`}
      aria-label="Latest decision"
      aria-live="polite"
    >
      <header>
        <span className="dsp-radio__time">{hhmm(entry.minute)}</span>
        <span>
          {entry.status === "streaming"
            ? "Dispatcher is deciding…"
            : entry.status === "failed"
              ? "Decision failed"
              : "Dispatcher orders"}
        </span>
        <span className="dsp-tag">AI decision</span>
      </header>
      {entry.status === "streaming" && (
        <p className="dsp-radio__text">
          {entry.text || entry.thinking.slice(-220) || "Reading the situation…"}
        </p>
      )}
      {entry.status === "failed" && entry.error && <p className="dsp-error">{entry.error}</p>}
      {entry.status === "done" && (
        <ul>
          {entry.outcomes.length === 0 && (
            <li className="dsp-radio__none">No new orders: everything in effect stands.</li>
          )}
          {entry.outcomes.map((outcome, i) => {
            const line = orderLine(outcome.order, area);
            return (
              <li key={i} className={outcome.accepted ? "" : "is-rejected"}>
                <span aria-hidden="true">{outcome.accepted ? line.icon : "✕"}</span>
                {line.color !== undefined && (
                  <span
                    className="dsp-swatch"
                    style={{ background: cssColor(line.color) }}
                    aria-hidden="true"
                  />
                )}
                <span>
                  {line.text}
                  {!outcome.accepted && <em> — rejected: {outcome.note}</em>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ZoneProgress({ zone, homes }: { zone: ZoneState; homes: number }) {
  const parts: [number, number][] = [
    [zone.safe, HOME_COLORS[4]],
    [zone.onRoad, HOME_COLORS[3]],
    [zone.queued, HOME_COLORS[2]],
    [zone.atHome, zone.status === "no_order" ? HOME_COLORS[0] : HOME_COLORS[1]],
    [zone.caught, HOME_COLORS[5]],
  ];
  return (
    <div
      className="dsp-bar dsp-bar--small"
      role="img"
      aria-label={`${zone.safe} of ${homes} homes safe`}
    >
      {parts.map(([value, color], i) =>
        value > 0 ? (
          <span key={i} style={{ flexGrow: value, background: cssColor(color) }} />
        ) : null,
      )}
    </div>
  );
}

function ZoneRow({
  engine,
  zone,
  selected,
  onSelect,
}: {
  engine: DispatchEngine;
  zone: ZoneState;
  selected: boolean;
  onSelect: () => void;
}) {
  const area = engine.area;
  const info = area.zones[zone.index];
  const exit = zone.exitId ? area.exits.find((candidate) => candidate.id === zone.exitId) : null;
  const minutes = zone.route ? Math.max(1, Math.round(zone.route.seconds / 60)) : null;
  const contact = engine.exposure.zoneContact[zone.index];
  const badge =
    zone.status === "cleared" ? (
      <span className="dsp-badge dsp-badge--done" aria-label="Cleared">
        ✓
      </span>
    ) : zone.status === "overrun" ? (
      <span className="dsp-badge dsp-badge--bad" aria-label="Overrun">
        ✕
      </span>
    ) : zone.orderRank !== null ? (
      <span className="dsp-badge dsp-badge--rank">{zone.orderRank}</span>
    ) : (
      <span className="dsp-badge" aria-hidden="true">
        ·
      </span>
    );
  return (
    <li>
      <button
        type="button"
        className={`dsp-zone${selected ? " is-selected" : ""}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {badge}
        <span className="dsp-zone__body">
          <span className="dsp-zone__head">
            <strong>{info.name}</strong>
            {zone.status !== "cleared" && zone.status !== "overrun" && (
              <span
                className={`dsp-chip${Number.isFinite(contact) && contact - engine.minute <= 30 ? " dsp-chip--hot" : ""}`}
              >
                {etaText(contact, engine.minute)}
              </span>
            )}
          </span>
          {exit ? (
            <span className="dsp-zone__route">
              <span
                className="dsp-swatch"
                style={{ background: cssColor(exitColor(area, exit.id)) }}
                aria-hidden="true"
              />
              via {exit.id} · {exit.name}
              {minutes !== null && !zone.routeBlocked && ` · ${minutes} min drive`}
              {zone.routeBlocked && <span className="dsp-warn"> · route blocked, holding</span>}
            </span>
          ) : (
            <span className="dsp-zone__route dsp-muted">No evacuation order</span>
          )}
          <ZoneProgress zone={zone} homes={info.homes} />
          <span className="dsp-zone__counts">
            {zone.safe}/{info.homes} homes safe
            {zone.onRoad > 0 && ` · ${zone.onRoad} driving`}
            {zone.status === "ordered" &&
              zone.atHome + zone.queued > 0 &&
              ` · ${zone.atHome + zone.queued} still leaving`}
            {zone.caught > 0 && <span className="dsp-bad"> · {zone.caught} caught</span>}
            {zone.status === "cleared" &&
              zone.clearedMinute !== null &&
              ` · clear at ${hhmm(zone.clearedMinute)}`}
          </span>
        </span>
      </button>
    </li>
  );
}

function EvacuationBoard({
  engine,
  selectedZone,
  onSelectZone,
}: {
  engine: DispatchEngine;
  selectedZone: number | null;
  onSelectZone: (zone: number | null) => void;
}) {
  const ordered = engine.zones
    .filter((zone) => zone.orderRank !== null)
    .sort((a, b) => a.orderRank! - b.orderRank!);
  const contact = engine.exposure.zoneContact;
  const waiting = engine.zones
    .filter((zone) => zone.orderRank === null)
    .sort((a, b) => contact[a.index] - contact[b.index] || a.index - b.index);
  const select = (index: number) => onSelectZone(selectedZone === index ? null : index);
  return (
    <div className="dsp-board">
      <h3>
        Evacuation order{" "}
        {ordered.length > 0 && (
          <span className="dsp-muted">
            · {ordered.filter((z) => z.status === "cleared").length}/{ordered.length} clear
          </span>
        )}
      </h3>
      {ordered.length === 0 ? (
        <p className="dsp-note">No zone has been told to leave yet.</p>
      ) : (
        <ol className="dsp-zones">
          {ordered.map((zone) => (
            <ZoneRow
              key={zone.index}
              engine={engine}
              zone={zone}
              selected={selectedZone === zone.index}
              onSelect={() => select(zone.index)}
            />
          ))}
        </ol>
      )}
      {waiting.length > 0 && (
        <>
          <h3>Not yet ordered · nearest fire first</h3>
          <ul className="dsp-zones">
            {waiting.map((zone) => (
              <ZoneRow
                key={zone.index}
                engine={engine}
                zone={zone}
                selected={selectedZone === zone.index}
                onSelect={() => select(zone.index)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function unitStatusText(engine: DispatchEngine, unit: UnitState): string {
  const zone = unit.zone === null ? null : engine.area.zones[unit.zone].id;
  const task =
    unit.task === "evacuation_support"
      ? "evacuation support"
      : unit.task === "structure_defense"
        ? "structure defense"
        : "";
  const eta = engine.unitEtaMinutes(unit);
  switch (unit.status) {
    case "available":
      return "At station, available";
    case "en_route":
      return `Responding to ${zone} (${task})${eta !== null ? ` · ${Math.ceil(eta)} min out` : ""}`;
    case "on_scene":
      return `On scene at ${zone} · ${task}${unit.arrivedMinute !== null ? ` since ${hhmm(unit.arrivedMinute)}` : ""}`;
    case "returning":
      return `Returning to station${eta !== null ? ` · ${Math.ceil(eta)} min` : ""}`;
    case "stranded":
      return "Cut off by fire";
  }
}

function Crews({ engine }: { engine: DispatchEngine }) {
  if (engine.units.length === 0) {
    return (
      <p className="dsp-note">
        OpenStreetMap lists no fire station within reach of this area, so there are no engines to
        dispatch.
      </p>
    );
  }
  const stations = new Map(engine.area.stations.map((station) => [station.id, station]));
  return (
    <ul className="dsp-crews">
      {engine.units.map((unit) => {
        const station = stations.get(unit.stationId);
        return (
          <li key={unit.id} className={`dsp-crew dsp-crew--${unit.status}`}>
            <span className="dsp-crew__id">🚒 {unit.id}</span>
            <span className="dsp-crew__body">
              <strong>{unitStatusText(engine, unit)}</strong>
              <span className="dsp-muted">
                {station?.name ?? unit.stationId}
                {station &&
                  station.approachMeters > 200 &&
                  ` · ${(station.approachMeters / 1000).toFixed(1)} km outside the area`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function LogEntry({ entry, area }: { entry: DecisionLogEntry; area: DispatchArea }) {
  return (
    <li className={`dsp-entry dsp-entry--${entry.status}`}>
      <header>
        <span className="dsp-radio__time">{hhmm(entry.minute)}</span>
        <span>
          {entry.status === "streaming"
            ? "Reasoning…"
            : entry.status === "failed"
              ? "Decision failed"
              : "Decision"}
        </span>
        {entry.model && <span className="dsp-muted">{entry.model}</span>}
      </header>
      {entry.alerts.length > 0 && (
        <ul className="dsp-alerts" aria-label="Alerts since the previous decision">
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
          <summary>Reasoning summary</summary>
          <p>{entry.thinking}</p>
        </details>
      )}
      {entry.text && <p className="dsp-assessment">{entry.text}</p>}
      {entry.error && (
        <p className="dsp-error" role="alert">
          {entry.error}
        </p>
      )}
      {entry.status === "done" && (
        <ul className="dsp-orders">
          {entry.outcomes.map((outcome, i) => (
            <li key={i} className={outcome.accepted ? "" : "is-rejected"}>
              <strong>
                {outcome.accepted ? "✓ " : "✕ "}
                {orderLine(outcome.order, area).text}
              </strong>
              <span>
                {outcome.accepted ? outcome.note : `Rejected by the simulator: ${outcome.note}`}
              </span>
              {outcome.order.reason && <em>“{outcome.order.reason}”</em>}
            </li>
          ))}
          {entry.rejected.map((item, i) => (
            <li key={`r${i}`} className="is-rejected">
              <strong>✕ Dropped by the server</strong>
              <span>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function DispatchConsole(props: DispatchConsoleProps) {
  const { area, steps, startBlocker, status, engine, log, baseline, speed, selectedZone } = props;
  const [tab, setTab] = useState<Tab>("board");
  const active = status !== "idle";
  const latest = log[0];

  return (
    <section className="dsp-console" id="dispatch-console" aria-label="AI dispatcher">
      <header className="dsp-console__head">
        <div>
          <p className="dsp-eyebrow">AI dispatcher · simulated</p>
          <h2>Dispatch console</h2>
        </div>
        <span className={`dsp-status dsp-status--${status}`} role="status" aria-live="polite">
          <span className="dsp-status__dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </span>
      </header>

      <div className="dsp-controls">
        {!active || status === "finished" ? (
          <Button className="dsp-start" disabled={startBlocker !== null} onClick={props.onStart}>
            {status === "finished" ? "Run the dispatcher again" : "Start the AI dispatcher"}
          </Button>
        ) : status === "paused" ? (
          <Button onClick={props.onResume}>Resume</Button>
        ) : status === "failed" ? (
          <>
            <Button onClick={props.onRetry}>Retry decision</Button>
            <Button variant="secondary" onClick={props.onSkip}>
              Continue without orders
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={props.onPause} disabled={status === "thinking"}>
            Pause
          </Button>
        )}
        {active && (
          <Button variant="secondary" onClick={props.onStop}>
            Stop
          </Button>
        )}
        <label className="dsp-speed">
          Speed
          <select
            className="ui-input"
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

      {!engine && (
        <ol className="dsp-steps" aria-label="Setup">
          {steps.map((step, i) => (
            <li key={step.label} className={`dsp-step dsp-step--${step.state}`}>
              <span className="dsp-step__mark" aria-hidden="true">
                {step.state === "done" ? "✓" : step.state === "error" ? "!" : i + 1}
              </span>
              <span>
                <strong>{step.label}</strong>
                <span className="dsp-muted">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {!engine && startBlocker && <p className="dsp-note">{startBlocker}</p>}
      {!engine && !startBlocker && baseline && (
        <p className="dsp-callout">
          With nobody told to leave, the fire model reaches{" "}
          <strong>{NUMBER.format(baseline.caught)}</strong> of {NUMBER.format(baseline.homes)} homes
          before their households get out. Start the dispatcher to see what orders change.
        </p>
      )}

      {engine && <Tiles totals={engine.totals()} baseline={baseline} />}
      {engine && (status === "running" || status === "thinking") && (
        <p className="dsp-note">
          {hhmm(engine.minute)} · the clock stops at every decision (each{" "}
          {DECISION_INTERVAL_MINUTES} min, sooner on urgent alerts) until the orders arrive.
        </p>
      )}
      {engine && latest && area && <LatestOrders entry={latest} area={area} />}

      {engine && area && (
        <>
          <div className="dsp-tabs" role="tablist" aria-label="Console views">
            {(
              [
                ["board", "Evacuations"],
                ["crews", `Fire crews (${engine.units.length})`],
                ["log", `Agent log (${log.length})`],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "is-active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="dsp-tabpanel" role="tabpanel">
            {tab === "board" && (
              <EvacuationBoard
                engine={engine}
                selectedZone={selectedZone}
                onSelectZone={props.onSelectZone}
              />
            )}
            {tab === "crews" && <Crews engine={engine} />}
            {tab === "log" && (
              <ol className="dsp-log" aria-label="Agent decisions, newest first">
                {log.map((entry) => (
                  <LogEntry key={entry.id} entry={entry} area={area} />
                ))}
              </ol>
            )}
          </div>
        </>
      )}

      <p className="dsp-disclaimer">
        Planning experiment. The AI picks among options the simulator computes; it does not change
        the fire. Homes and zones are synthetic; roads and stations © OpenStreetMap contributors.
      </p>
    </section>
  );
}
