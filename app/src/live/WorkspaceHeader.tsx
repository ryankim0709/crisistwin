import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, EvidenceTag, IconButton, Notice, SegmentedControl, Tag, buttonClass } from "../ui";
import { simClock } from "../demo/format";
import { ACTIVITIES, ACTIVITY } from "../demo/model";
import { boardCellMetersFor } from "../fire/boardSize";
import { readinessLabel, useCachedBoards } from "../fire/useCachedBoards";
import { BOARD_SPEEDS, MONITORING, type CommandBoard } from "../demo/useCommandBoard";
import { WEATHER_PRESETS } from "../demo/useDemoEnvironment";
import { drillAction } from "./api";
import { drillClock, drillDate, drillNowAt, elapsed } from "./format";
import type { ActiveIncident } from "./active";
import DrillPicker from "./DrillPicker";
import InvitePhones from "./InvitePhones";
import InjectsPanel from "./InjectsPanel";
import type { RunAction } from "./SelectedItem";
import type { CommandResponse, TwinMonitor } from "./types";

const SPEEDS = ["0", "1", "5", "15", "30", "60"] as const;
type Speed = (typeof SPEEDS)[number];
const SPEED_OPTIONS = SPEEDS.map((s) => ({
  value: s,
  label: s === "0" ? "⏸" : `×${s}`,
  title: s === "0" ? "Pause" : `${s} drill seconds per second`,
}));
/** "Updated" shows only when the last poll is older than this. */
const STALE_AFTER_MS = 10_000;

function Menu({
  data,
  twin,
  run,
  busy,
  onSignOut,
  token,
  active,
  onSwitched,
}: {
  data: CommandResponse | null;
  twin: TwinMonitor | null;
  run: RunAction;
  busy: string | null;
  onSignOut: (() => void) | null;
  token: string | null;
  active: ActiveIncident | null;
  onSwitched: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [inviting, setInviting] = useState(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const commands = twin ? [...twin.commands].reverse() : [];
  return (
    <>
      <details ref={ref} className="lc-menu">
        <summary aria-label="More" title="More">
          ⋯
        </summary>
        <div className="lc-menu-pop" role="menu">
          <a role="menuitem" className="lc-menu-item" href="/">
            Workspace
          </a>
          <a role="menuitem" className="lc-menu-item" href="/live/report">
            After-action report
          </a>
          <details className="lc-menu-sub">
            <summary className="lc-menu-item">
              Commands applied <span className="lc-num lc-dim">{commands.length}</span>
              {twin?.command_errors.length ? (
                <Tag tone="danger">{twin.command_errors.length} rejected</Tag>
              ) : null}
            </summary>
            <ul className="lc-menu-list">
              {twin?.command_errors.map((e) => (
                <li key={`err:${e.key}`} className="lc-error">
                  {e.detail ?? e.code ?? e.error}
                </li>
              ))}
              {commands.map((c) => (
                <li key={c.id}>
                  <span className="lc-num lc-dim">{drillClock(c.effective_at)}</span>{" "}
                  {c.label ?? c.type}
                </li>
              ))}
              {commands.length === 0 && !twin?.command_errors.length ? (
                <li className="lc-dim">None yet</li>
              ) : null}
            </ul>
          </details>
          {data ? (
            <details className="lc-menu-sub">
              <summary className="lc-menu-item">
                Injects <span className="lc-num lc-dim">{data.injects?.length ?? 0}</span>
              </summary>
              <InjectsPanel data={data} run={run} busy={busy} />
            </details>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="lc-menu-item"
            onClick={() => {
              if (ref.current) ref.current.open = false;
              setInviting(true);
            }}
          >
            Invite phones
          </button>
          <button
            type="button"
            role="menuitem"
            className="lc-menu-item"
            disabled={!token}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              setPicking(true);
            }}
          >
            Drill
          </button>
          {onSignOut ? (
            <button type="button" role="menuitem" className="lc-menu-item" onClick={onSignOut}>
              Sign out
            </button>
          ) : null}
        </div>
      </details>
      {inviting ? <InvitePhones onClose={() => setInviting(false)} /> : null}
      {picking && token ? (
        <DrillPicker
          token={token}
          active={active}
          onSwitched={onSwitched}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}

/** Closes a <details> popover on an outside click or Escape. */
function useDismiss(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [ref]);
}

/**
 * The simulated board's controls: AI monitoring, the board clock (its own simulated time, not
 * the drill clock), and a "Conditions" popover for fire activity, wind and restart.
 */
const BOARD_SIZES = [15, 30, 45, 60].map((km) => ({
  value: String(km),
  label: `${km} km`,
  title: `Board about ${km * 2} \u00d7 ${km * 2} km (${km} km from the centre to each edge)`,
}));

/** The drill environment's centre (GET /api/demo/environment), read once; null until known. */
let drillCentre: Promise<[number, number] | null> | null = null;
function useDrillCentre(): [number, number] | null {
  const [centre, setCentre] = useState<[number, number] | null>(null);
  useEffect(() => {
    drillCentre ??= fetch("/api/demo/environment")
      .then((r) => (r.ok ? (r.json() as Promise<{ center?: [number, number] }>) : null))
      .then((body) => body?.center ?? null)
      .catch(() => null);
    let live = true;
    void drillCentre.then((c) => live && setCentre(c));
    return () => {
      live = false;
    };
  }, []);
  return centre;
}

export function BoardControls({ board: cb }: { board: CommandBoard }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismiss(ref);
  const centre = useDrillCentre();
  const request = (km: number) => ({
    longitude: centre?.[0] ?? 0,
    latitude: centre?.[1] ?? 0,
    radiusMeters: km * 1000,
    cellMeters: boardCellMetersFor(km * 1000),
  });
  const sizeReady = useCachedBoards(centre ? BOARD_SIZES.map((s) => request(Number(s.value))) : [], cb.boardLoading);
  const ready = (km: number) => centre !== null && sizeReady(request(km));
  const { board, windNow } = cb;
  return (
    <div className="lc-board-ctl" role="group" aria-label="Simulated board">
      <EvidenceTag kind="simulated" />
      <span className="lc-board-monitor">
        <span className="lc-board-label" aria-hidden="true">
          AI monitoring
        </span>
        <SegmentedControl
          label="AI monitoring"
          options={MONITORING}
          value={cb.autopilot ? "on" : "off"}
          onChange={(value) => cb.setAutopilot(value === "on")}
        />
      </span>
      {board ? (
        <>
          <span className="lc-clock" aria-label={`Simulated board clock ${simClock(board.minute)}`} title="Simulated board clock">
            <span className="lc-num">{simClock(board.minute)}</span>
          </span>
          <Button size="sm" variant="secondary" onClick={() => cb.setRunning((r) => !r)} aria-pressed={!cb.running}>
            {cb.running ? "Pause" : "Resume"}
          </Button>
          <SegmentedControl label="Board clock speed" options={BOARD_SPEEDS} value={cb.speed} onChange={cb.setSpeed} />
          <Button
            size="sm"
            variant={cb.igniteMode ? "primary" : "secondary"}
            aria-pressed={cb.igniteMode}
            onClick={() => cb.setIgniteMode((m) => !m)}
          >
            {cb.igniteMode ? "Click the map to start a fire" : "Add fire"}
          </Button>
          <details ref={ref} className="lc-board-more">
            <summary className={buttonClass({ variant: "ghost", size: "sm" })}>Conditions</summary>
            <div className="lc-menu-pop lc-board-pop" role="group" aria-label="Simulated board conditions">
              <span className="lc-board-label">Fire activity</span>
              <SegmentedControl
                label="Fire activity"
                options={ACTIVITIES.map((a) => ({ value: a, label: ACTIVITY[a].label, title: `${ACTIVITY[a].label} fire activity` }))}
                value={cb.activity}
                onChange={cb.changeActivity}
              />
              <span className="lc-board-label">Wind</span>
              <SegmentedControl
                label="Wind"
                options={WEATHER_PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.title }))}
                value={cb.weather}
                onChange={cb.setWeather}
              />
              <span className="lc-board-label">Board size</span>
              <SegmentedControl
                label="Board size, km from the centre to each edge"
                options={BOARD_SIZES.map((s) => ({
                  ...s,
                  title: `${s.title}. ${readinessLabel(ready(Number(s.value)), Number(s.value) * 1000, boardCellMetersFor(Number(s.value) * 1000))}`,
                }))}
                value={String(cb.boardRadius / 1000)}
                onChange={(value) => cb.setBoardRadius(Number(value) * 1000)}
              />
              <span className="lc-dim">
                {cb.boardLoading
                  ? "Loading the board\u2026"
                  : `About ${cb.boardRadius / 500} \u00d7 ${cb.boardRadius / 500} km, ${boardCellMetersFor(cb.boardRadius)} m cells. ${readinessLabel(
                      ready(cb.boardRadius / 1000),
                      cb.boardRadius,
                      boardCellMetersFor(cb.boardRadius),
                    )}.`}
              </span>
              {windNow ? (
                <span className="lc-dim lc-num" title={board.env.spread.wind.label}>
                  Wind now {windNow.speedMetersPerSecond.toFixed(1)} m/s from {Math.round(windNow.fromDegrees)}°
                </span>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                title={`Seed ${board.seed}`}
                onClick={() => {
                  if (ref.current) ref.current.open = false;
                  cb.restart();
                }}
              >
                Restart board
              </Button>
            </div>
          </details>
        </>
      ) : (
        <span className="lc-dim">Board loading…</span>
      )}
    </div>
  );
}

export default function WorkspaceHeader({
  data,
  twin,
  receivedAt,
  now,
  connectionError,
  run,
  busy,
  onSignOut,
  token,
  active,
  onSwitched,
  children,
}: {
  data: CommandResponse | null;
  twin: TwinMonitor | null;
  receivedAt: number | null;
  now: number;
  connectionError: string | null;
  run: RunAction;
  busy: string | null;
  onSignOut: (() => void) | null;
  token: string | null;
  active: ActiveIncident | null;
  onSwitched: () => void;
  /** Extra header controls (the simulated board's), after the drill controls. */
  children?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const drill = data?.drill ?? null;
  const name = data?.incident?.name ?? "Live command";
  const exercise = data ? (data.incident?.mode ?? "exercise") !== "live" : false;
  const title = exercise ? name.replace(/\s+exercise$/i, "") : name;
  const t = drill ? drillNowAt(drill, receivedAt, now) : null;
  const stopped = drill?.started_at === null;
  const ended = drill && !stopped && drill.speed > 0 && !drill.running;
  const age = receivedAt === null ? 0 : now - receivedAt;
  const setSpeed = async (speed: Speed) =>
    setError(
      await run("drill", (tok, id) => drillAction(tok, id, { action: "set_speed", speed: Number(speed) })),
    );
  const start = async () =>
    setError(await run("drill", (tok, id) => drillAction(tok, id, { action: "start" })));
  const reset = async () => {
    if (!window.confirm("Reset the drill? Guidance, proposals and check-ins are deleted.")) return;
    setError(await run("drill", (tok, id) => drillAction(tok, id, { action: "reset" })));
  };
  return (
    <header className="lc-head">
      <h1>
        {title}
        {exercise ? <Tag tone="warning">Exercise</Tag> : null}
      </h1>
      {drill && t ? (
        <>
          <p
            className="lc-clock"
            aria-label={`Drill time ${drillClock(t, true)} UTC, ${drillDate(t)}`}
          >
            <span className="lc-num">{drillClock(t, true)}</span>
            <span className="lc-dim"> UTC {drillDate(t)}</span>
            {ended ? <Tag>Ended</Tag> : null}
          </p>
          <div className="lc-drill">
            {stopped ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void start()}
              >
                Start drill
              </Button>
            ) : (
              <SegmentedControl
                label="Drill speed"
                options={SPEED_OPTIONS}
                value={String(drill.speed) as Speed}
                onChange={(v) => void setSpeed(v)}
              />
            )}
            <IconButton
              label="Reset drill"
              size="sm"
              disabled={busy !== null}
              onClick={() => void reset()}
            >
              ↺
            </IconButton>
          </div>
        </>
      ) : null}
      {children}
      <span className="lc-head-end">
        {connectionError || age > STALE_AFTER_MS ? (
          <span className="lc-stale" role="status" title={connectionError ?? undefined}>
            {connectionError ? "Offline" : "Stale"}, {elapsed(age)}
          </span>
        ) : null}
        {error ? (
          <Notice tone="danger" compact className="lc-head-error">
            {error}
          </Notice>
        ) : null}
        <Menu
          data={data}
          twin={twin}
          run={run}
          busy={busy}
          onSignOut={onSignOut}
          token={token}
          active={active}
          onSwitched={onSwitched}
        />
      </span>
    </header>
  );
}
