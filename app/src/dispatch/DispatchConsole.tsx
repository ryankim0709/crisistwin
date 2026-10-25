/**
 * The dispatcher's console beside the diorama: setup checklist, household totals against the
 * no-action baseline, the live monitor's cadence, the latest orders, and four tabs — the
 * evacuation board (zones in the order they were told to leave, staged waves, and the rest by
 * order slack), resident notices (simulated, never sent), fire crews and the agent log with the
 * monitor's quiet checks. Every number is engine output; the agent's text is labelled.
 */

import { FIRE_TACTICS, builtMeters, tacticBlocked, type FireTactic } from "./fireTactics";
import { useState, type ReactNode } from "react";
import { Button } from "../ui";
import type { DispatchArea } from "./area";
import type {
  DispatchEngine,
  NoticeKind,
  Order,
  ResidentNotice,
  Totals,
  UnitState,
  ZoneState,
} from "./engine";
import { CHECK_INTERVAL_CHOICES } from "./engine";
import { threatTier, tierLabel } from "./monitor";
import { HOME_COLORS, cssColor, exitColor } from "./scene/DispatchOverlay";
import type { DecisionLogEntry, MonitorCheck, SessionStatus } from "./useDispatchSession";
import { DISPATCH_SPEED_CHOICES, speedLabel } from "./useDispatchSession";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Standing by",
  running: "On shift · monitoring",
  thinking: "Deciding · clock running",
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

type Tab = "board" | "residents" | "crews" | "log";

const NOTICE_ICON: Record<NoticeKind, string> = {
  leave_now: "📲",
  prepare: "⏳",
  redirect: "↪",
  hold: "⛔",
  all_clear: "✅",
};
const NOTICE_LABEL: Record<NoticeKind, string> = {
  leave_now: "Leave now",
  prepare: "Get ready, stay home",
  redirect: "New route",
  hold: "Hold",
  all_clear: "All clear",
};
const MAX_NOTICES_SHOWN = 80;

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
  checks: MonitorCheck[];
  checkInterval: number;
  nextCheckMinute: number | null;
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
  onCheckIntervalChange: (minutes: number) => void;
  onSelectZone: (zone: number | null) => void;
  /** Run settings shown under the controls before a session (household behaviour). */
  settings?: ReactNode;
  /** The road-closure tool (RoadClosures), shown above the console tabs. */
  roads?: ReactNode;
  /** Extra controls under the console (the resident app share toggle). */
  footer?: ReactNode;
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
    ["Reached by fire (not by choice)", totals.caught - (totals.caughtByChoice ?? 0), HOME_COLORS[5]],
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
  if (order.type === "stage_evacuation") {
    return {
      icon: "⏳",
      text: `Stage ${order.zone_id} after ${order.after_zone_id}, then via ${order.exit_id}`,
      color: exitColor(area, order.exit_id),
    };
  }
  if (order.type === "dispatch_unit") {
    return {
      icon: "🚒",
      text: `${order.unit_id} → ${order.zone_id}, ${order.task === "evacuation_support" ? "evacuation support" : "structure defense"}`,
    };
  }
  if (order.type === "attack_fire") {
    return {
      icon: "🔥",
      text: `${order.unit_id} → fire ${order.fire_id}, ${TACTIC_LABEL[order.tactic ?? "direct"]}`,
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
            ? "Dispatcher is deciding… (the fire keeps moving)"
            : entry.status === "failed"
              ? "Decision failed"
              : "Dispatcher orders"}
          {entry.appliedMinute !== null && entry.appliedMinute > entry.minute && (
            <span className="dsp-muted">
              {" "}
              · seen at {hhmm(entry.minute)}, in effect {hhmm(entry.appliedMinute)} (
              {entry.appliedMinute - entry.minute} min thinking)
            </span>
          )}
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
  const wave = engine.waveOf(zone.index);
  const stagedExit = zone.stage
    ? area.exits.find((candidate) => candidate.id === zone.stage!.exitId)
    : null;
  const tier =
    zone.status === "no_order" && !zone.stage
      ? threatTier(engine.orderSlackMinutes(zone.index))
      : "none";
  const slack = tier === "none" ? null : engine.orderSlackMinutes(zone.index);
  const outside = zone.status === "no_order" && engine.zoneImpact(zone.index) === "outside";
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
    ) : zone.stage ? (
      <span className="dsp-badge dsp-badge--staged" aria-label={`Staged, wave ${wave ?? "?"}`}>
        ⏳
      </span>
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
            {wave !== null && zone.status !== "overrun" && (
              <span className="dsp-chip dsp-chip--wave">Wave {wave}</span>
            )}
            {slack !== null && (tier === "soon" || tier === "urgent" || tier === "late") && (
              <span className={`dsp-chip dsp-chip--${tier}`}>
                {tier === "late"
                  ? `Late by ${Math.max(1, Math.round(-slack))} min`
                  : `Order within ${Math.round(slack)} min`}
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
          ) : zone.stage ? (
            <span className="dsp-zone__route">
              {stagedExit && (
                <span
                  className="dsp-swatch"
                  style={{ background: cssColor(exitColor(area, stagedExit.id)) }}
                  aria-hidden="true"
                />
              )}
              Waits for {area.zones[zone.stage.after].name}, then via {zone.stage.exitId}
              {stagedExit ? ` · ${stagedExit.name}` : ""}
            </span>
          ) : (
            <span className="dsp-zone__route dsp-muted">
              No evacuation order
              {outside
                ? " · outside the fire path"
                : tier !== "none"
                  ? ` · ${tierLabel(tier)}`
                  : ""}
            </span>
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
  const staged = engine.zones
    .filter((zone) => zone.orderRank === null && zone.stage !== null)
    .sort(
      (a, b) => (engine.waveOf(a.index) ?? 0) - (engine.waveOf(b.index) ?? 0) || a.index - b.index,
    );
  const slackOf = (zone: ZoneState) => engine.orderSlackMinutes(zone.index) ?? Infinity;
  const unordered = engine.zones
    .filter((zone) => zone.orderRank === null && zone.stage === null)
    .sort(
      (a, b) => slackOf(a) - slackOf(b) || contact[a.index] - contact[b.index] || a.index - b.index,
    );
  const waiting = unordered.filter((zone) => engine.zoneImpact(zone.index) !== "outside");
  const outside = unordered.filter((zone) => engine.zoneImpact(zone.index) === "outside");
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
      {staged.length > 0 && (
        <>
          <h3>
            Staged waves{" "}
            <span className="dsp-muted">· released when the zone ahead is on the road</span>
          </h3>
          <ul className="dsp-zones">
            {staged.map((zone) => (
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
      {waiting.length > 0 && (
        <>
          <h3>Not yet ordered · least time to order first</h3>
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
      {outside.length > 0 && (
        <>
          <h3>
            Outside the fire path{" "}
            <span className="dsp-muted">· fire not forecast to reach them, no evacuation</span>
          </h3>
          <ul className="dsp-zones">
            {outside.map((zone) => (
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
  const zone =
    unit.fire !== null
      ? engine.fires[unit.fire].target.name
      : unit.zone === null
        ? null
        : engine.area.zones[unit.zone].id;
  const task =
    unit.task === "evacuation_support"
      ? "evacuation support"
      : unit.task === "structure_defense"
        ? "structure defense"
        : unit.task === "fire_attack"
          ? unit.fire !== null
            ? TACTIC_LABEL[engine.fires[unit.fire].tactic ?? "direct"]
            : "fire attack"
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
    <>
      <FireCards engine={engine} />
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
    </>
  );
}

const TACTIC_LABEL: Record<FireTactic, string> = {
  direct: "direct attack",
  flank: "flank attack",
  indirect: "indirect attack",
};

/** Each fire: status, the tactic in effect, and which tactics engines can use (and why not). */
function FireCards({ engine }: { engine: DispatchEngine }) {
  const minute = engine.minute;
  const fires = engine.fires.filter(
    (fire) => fire.target.ignitedMinute !== null && fire.target.ignitedMinute <= minute,
  );
  if (fires.length === 0) return null;
  return (
    <ul className="dsp-fires" aria-label="Fires and how engines can fight them">
      {fires.map((fire) => {
        const index = engine.fires.indexOf(fire);
        const crews = engine.fireAttackers(index).map((unit) => unit.id);
        const hectares = engine.fireAreaSquareMeters(index) / 10_000;
        const status =
          fire.outMinute !== null
            ? `Out at ${hhmm(fire.outMinute)}`
            : fire.heldAnnounced && fire.heldMinute !== null
              ? `Held at ${hhmm(fire.heldMinute)}`
              : fire.tactic
                ? `${TACTIC_LABEL[fire.tactic]} by ${crews.join(", ") || "no crews"}`
                : "No engines on it";
        const outlook =
          fire.outMinute === null && !fire.heldAnnounced && fire.tactic
            ? fire.tactic === "direct"
              ? engine.projectedOutMinute(index)
              : fire.heldMinute
            : null;
        return (
          <li key={fire.target.id} className="dsp-fire">
            <span className="dsp-crew__id">🔥 {fire.target.name}</span>
            <span className="dsp-crew__body">
              <strong>
                {status}
                {outlook !== null && ` · simulator: contained ${hhmm(outlook)}`}
              </strong>
              <span className="dsp-muted">
                {hectares < 10 ? hectares.toFixed(1) : Math.round(hectares)} ha ·{" "}
                {fire.target.structureFire
                  ? "structure fire"
                  : Number.isFinite(fire.target.headFlameFeet)
                    ? `${fire.target.headFlameFeet.toFixed(1)} ft head flame`
                    : "crowning"}
                {fire.line &&
                  fire.line.cells.length > 0 &&
                  ` · line ${(builtMeters(fire.line, minute) / 1000).toFixed(1)} of ${(fire.line.plannedMeters / 1000).toFixed(1)} km built`}
              </span>
              <span className="dsp-fire__tactics">
                {FIRE_TACTICS.map((tactic) => {
                  const blocked = tacticBlocked(fire.target, tactic);
                  return (
                    <span
                      key={tactic}
                      className={`dsp-tag${blocked ? " dsp-tag--off" : ""}`}
                      title={blocked ?? `Engines can use ${TACTIC_LABEL[tactic]}`}
                    >
                      {blocked ? "✕" : "✓"} {tactic}
                    </span>
                  );
                })}
              </span>
              {tacticBlocked(fire.target, "direct") && (
                <span className="dsp-muted">
                  No direct attack: {tacticBlocked(fire.target, "direct")}.
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Residents({ engine }: { engine: DispatchEngine }) {
  const notices: ResidentNotice[] = engine.notices.slice(-MAX_NOTICES_SHOWN).reverse();
  const reached = new Set(engine.notices.map((notice) => notice.zone));
  const homes = engine.area.zones.reduce(
    (sum, zone, i) => sum + (reached.has(i) ? zone.homes : 0),
    0,
  );
  return (
    <div className="dsp-notices">
      <p className="dsp-note">
        What each zone's households would be told, and when: one targeted notice per zone and wave
        instead of one area-wide alert. <strong>Simulated: nothing is sent to anyone.</strong>
        {engine.notices.length > 0 &&
          ` ${engine.notices.length} notices so far, to ${NUMBER.format(homes)} homes in ${reached.size} zones.`}
      </p>
      {notices.length === 0 ? (
        <p className="dsp-note">No zone has been notified yet.</p>
      ) : (
        <ol className="dsp-notice-list" aria-label="Resident notices, newest first">
          {notices.map((notice) => {
            const zone = engine.area.zones[notice.zone];
            return (
              <li key={notice.id} className={`dsp-notice dsp-notice--${notice.kind}`}>
                <span className="dsp-notice__icon" aria-hidden="true">
                  {NOTICE_ICON[notice.kind]}
                </span>
                <span className="dsp-notice__body">
                  <span className="dsp-notice__head">
                    <span className="dsp-radio__time">{hhmm(notice.minute)}</span>
                    <strong>{zone.name}</strong>
                    <span className="dsp-tag">{NOTICE_LABEL[notice.kind]}</span>
                    <span className="dsp-muted">{NUMBER.format(notice.homes)} homes</span>
                  </span>
                  <span>{notice.text}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function QuietChecks({ checks }: { checks: MonitorCheck[] }) {
  if (checks.length === 0) return null;
  const first = checks[checks.length - 1].minute;
  const last = checks[0].minute;
  return (
    <li className="dsp-quiet">
      <span aria-hidden="true">◦ </span>
      {checks.length} monitor check{checks.length === 1 ? "" : "s"}
      {first === last ? ` at ${hhmm(first)}` : ` ${hhmm(first)}–${hhmm(last)}`}: no material change,
      agent not called.
    </li>
  );
}

/** Decisions newest first, with the quiet checks that followed each one above it. */
function AgentLog({
  log,
  checks,
  area,
}: {
  log: DecisionLogEntry[];
  checks: MonitorCheck[];
  area: DispatchArea;
}) {
  const quiet = checks.filter((check) => check.reasons.length === 0);
  return (
    <ol className="dsp-log" aria-label="Agent decisions and monitor checks, newest first">
      {log.map((entry, i) => {
        const newer = i > 0 ? log[i - 1].minute : Infinity;
        const after = quiet.filter((check) => check.minute > entry.minute && check.minute < newer);
        return [
          <QuietChecks key={`q${entry.id}`} checks={after} />,
          <LogEntry key={entry.id} entry={entry} area={area} />,
        ];
      })}
    </ol>
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
      {entry.reasons.length > 0 && (
        <div className="dsp-woke">
          <span className="dsp-woke__title">Monitor woke the agent because</span>
          <ul>
            {entry.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
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
      {entry.recalledRuns > 0 && (
        <p className="dsp-note">
          Recalled {entry.recalledRuns} earlier simulated run{entry.recalledRuns === 1 ? "" : "s"}{" "}
          on these roads from the run journal (MongoDB Atlas), as lessons.
        </p>
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
  const {
    area,
    steps,
    startBlocker,
    status,
    engine,
    log,
    checks,
    checkInterval,
    nextCheckMinute,
    baseline,
    speed,
    selectedZone,
  } = props;
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
                {speedLabel(choice)}
              </option>
            ))}
          </select>
        </label>
        <label className="dsp-speed">
          Check every
          <select
            className="ui-input"
            value={checkInterval}
            onChange={(event) => props.onCheckIntervalChange(Number(event.target.value))}
          >
            {CHECK_INTERVAL_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} min
              </option>
            ))}
          </select>
        </label>
      </div>

      {!engine && props.settings}
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
      {/* While a setup step is open, the checklist already says what is missing. */}
      {!engine && startBlocker && steps.every((step) => step.state === "done") && (
        <p className="dsp-note">{startBlocker}</p>
      )}
      {!engine && !startBlocker && baseline && (
        <p className="dsp-callout">
          With nobody told to leave, the fire model reaches{" "}
          <strong>{NUMBER.format(baseline.caught)}</strong> of {NUMBER.format(baseline.homes)} homes
          before their households get out. Start the dispatcher to see what orders change.
        </p>
      )}

      {engine && <Tiles totals={engine.totals()} baseline={baseline} />}
      {engine && (status === "running" || status === "thinking") && (
        <p
          className="dsp-note"
          title="The AI is called only when something changed: fire growth, a zone running out of time, a wave finishing, an urgent alert, or 30 min without a review. Orders take effect when its answer arrives."
        >
          {hhmm(engine.minute)} · checking every {checkInterval} min
          {nextCheckMinute !== null && status === "running" && ` · next ${hhmm(nextCheckMinute)}`}
          {checks.length > 0 &&
            ` · ${checks.filter((c) => c.reasons.length === 0).length} of ${checks.length} checks quiet`}
        </p>
      )}
      {engine && latest && area && <LatestOrders entry={latest} area={area} />}
      {area && props.roads}

      {engine && area && (
        <>
          <div className="dsp-tabs" role="tablist" aria-label="Console views">
            {(
              [
                ["board", "Evacuations"],
                ["residents", `Residents (${engine.notices.length})`],
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
            {tab === "residents" && <Residents engine={engine} />}
            {tab === "crews" && <Crews engine={engine} />}
            {tab === "log" && <AgentLog log={log} checks={checks} area={area} />}
          </div>
        </>
      )}

      {props.footer}

      <p className="dsp-disclaimer">
        Planning experiment. Homes and zones are synthetic; roads and stations © OpenStreetMap
        contributors.
      </p>
    </section>
  );
}
