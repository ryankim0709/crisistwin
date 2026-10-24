import { useEffect, useRef, useState } from "react";
import { Button, IconButton, Notice, SegmentedControl, Tag } from "../ui";
import { drillAction } from "./api";
import { drillClock, drillDate, drillNowAt, elapsed } from "./format";
import InvitePhones from "./InvitePhones";
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

function Menu({ twin, onSignOut }: { twin: TwinMonitor | null; onSignOut: (() => void) | null }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [inviting, setInviting] = useState(false);
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
          {onSignOut ? (
            <button type="button" role="menuitem" className="lc-menu-item" onClick={onSignOut}>
              Sign out
            </button>
          ) : null}
        </div>
      </details>
      {inviting ? <InvitePhones onClose={() => setInviting(false)} /> : null}
    </>
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
}: {
  data: CommandResponse | null;
  twin: TwinMonitor | null;
  receivedAt: number | null;
  now: number;
  connectionError: string | null;
  run: RunAction;
  busy: string | null;
  onSignOut: (() => void) | null;
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
      await run("drill", (tok) => drillAction(tok, { action: "set_speed", speed: Number(speed) })),
    );
  const start = async () =>
    setError(await run("drill", (tok) => drillAction(tok, { action: "start" })));
  const reset = async () => {
    if (!window.confirm("Reset the drill? Guidance, proposals and check-ins are deleted.")) return;
    setError(await run("drill", (tok) => drillAction(tok, { action: "reset" })));
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
        <Menu twin={twin} onSignOut={onSignOut} />
      </span>
    </header>
  );
}
