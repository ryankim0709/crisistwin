import { useEffect, useId, useState } from "react";
import { Button, SegmentedControl, Tag } from "../ui";
import { simClock } from "../demo/format";
import { boardCellMetersFor } from "../fire/boardSize";
import { readinessLabel, useCachedBoards } from "../fire/useCachedBoards";
import { AUTO_REASON_TEXT, AUTO_SPEED_ACTIVE, AUTO_SPEED_IDLE, AUTO_SPEED_REVIEWING, AUTO_SPEED_THINKING } from "../demo/autoSpeed";
import { AGENT_OFF_PAUSE, BOARD_SPEED_STEPS, type ClockPause, type CommandBoard } from "../demo/useCommandBoard";

/** The clock's state in words (never colour alone). */
const PAUSE_TEXT: Record<ClockPause, string> = {
  agent_off: "Paused — turn on the AI agent",
  tab_hidden: "Paused (tab hidden)",
  operator: "Paused",
};

/** Running or why not, as a tag beside the board time. */
export function ClockState({ board: cb }: { board: CommandBoard }) {
  return (
    <span role="status" aria-live="polite">
      <Tag tone={cb.clockPause ? "warning" : "success"}>{cb.clockPause ? PAUSE_TEXT[cb.clockPause] : "Running"}</Tag>
    </span>
  );
}

/** Pause / Resume is available while AI monitoring is on. */
export function PauseButton({ board: cb, className }: { board: CommandBoard; className?: string }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className={className}
      disabled={!cb.autopilot}
      title={!cb.autopilot ? AGENT_OFF_PAUSE : undefined}
      onClick={() => cb.setRunning((r) => !r)}
      aria-pressed={!cb.running}
    >
      {cb.running ? "Pause" : "Resume"}
    </Button>
  );
}

/** "60× (1 min/s)": the speed-up and board minutes per real second (or minute). */
function speedText(speed: number): string {
  if (speed === 1) return "1× (real time)";
  const perSecond = speed / 60;
  return perSecond >= 1
    ? `${speed}× (${Number.isInteger(perSecond) ? perSecond : perSecond.toFixed(1)} min/s)`
    : `${speed}× (${speed} min/min)`;
}

/** The same for screen readers, in words. */
function speedWords(speed: number): string {
  if (speed === 1) return "real time";
  const perSecond = speed / 60;
  return perSecond >= 1
    ? `${speed} times real time, ${Number.isInteger(perSecond) ? perSecond : perSecond.toFixed(1)} board minutes per second`
    : `${speed} times real time, ${speed} board minutes per minute`;
}

/**
 * The speed slider (stepped stops, BOARD_SPEED_STEPS, so the useful range is not squashed) with
 * the Auto toggle (demo/autoSpeed.ts). While Auto is on the value says why ("60× · idle",
 * "1× · Claude deciding (urgent)", "1× · Claude reviewing", "20× · active"); moving the slider
 * picks a speed by hand and turns Auto off.
 */
export function BoardSpeedSlider({ board: cb }: { board: CommandBoard }) {
  const index = Math.max(0, BOARD_SPEED_STEPS.indexOf(cb.speed));
  const labelId = useId();
  const why = cb.agent.status === "thinking" ? "Claude deciding" : cb.autoSpeed ? AUTO_REASON_TEXT[cb.autoReason] : "manual";
  return (
    <div className="lc-speed" role="group" aria-labelledby={labelId}>
      <span className="lc-speed-label" id={labelId}>
        Speed
      </span>
      <Button
        size="sm"
        variant={cb.autoSpeed ? "secondary" : "ghost"}
        className="lc-speed-auto"
        aria-pressed={cb.autoSpeed}
        title={
          cb.autoSpeed
            ? `Auto speed on: ${AUTO_SPEED_IDLE}× while nothing is going on, ${AUTO_SPEED_THINKING}× while Claude decides on something urgent, ${AUTO_SPEED_REVIEWING}× while it reviews the board, ${AUTO_SPEED_ACTIVE}× otherwise. Move the slider to pick a speed by hand.`
            : "Auto speed off: click to let the speed follow the board and Claude again."
        }
        onClick={() => cb.setAutoSpeed(!cb.autoSpeed)}
      >
        {cb.autoSpeed ? "Auto on" : "Auto off"}
      </Button>
      <input
        type="range"
        className="lc-range"
        aria-labelledby={labelId}
        min={0}
        max={BOARD_SPEED_STEPS.length - 1}
        step={1}
        value={index}
        aria-valuetext={`${speedWords(cb.speed)}, ${cb.autoSpeed ? `auto, ${why}` : "set by hand"}`}
        onChange={(e) => cb.setSpeed(BOARD_SPEED_STEPS[Number(e.target.value)])}
      />
      <span className="lc-num lc-speed-value" role="status" aria-live="polite" title={speedText(cb.speed)}>
        {`${cb.speed}\u00d7 \u00b7 ${why}`}
      </span>
    </div>
  );
}

const BOARD_SIZE_KM = [15, 30, 45, 60];
const boardSizeOption = (km: number) => ({
  value: String(km),
  label: `${km} km`,
  title: `Board about ${km * 2} \u00d7 ${km * 2} km (${km} km from the centre to each edge)`,
});

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

/**
 * The board's area size (km from the centre to each edge, stored in the shared world), with
 * whether each size's landscape is already cached. Used in the sidebar's board clock and in
 * BoardControls' Conditions popover.
 */
export function BoardSizeControl({ board: cb }: { board: CommandBoard }) {
  const drillCentre = useDrillCentre();
  // A Studio drill's board is centred on its Studio region; its own size (e.g. 10 km) is offered too.
  const centre = cb.boardCentre ?? drillCentre;
  const current = cb.boardRadius / 1000;
  const sizes = (BOARD_SIZE_KM.includes(current) ? BOARD_SIZE_KM : [current, ...BOARD_SIZE_KM]).map(boardSizeOption);
  const request = (km: number) => ({
    longitude: centre?.[0] ?? 0,
    latitude: centre?.[1] ?? 0,
    radiusMeters: km * 1000,
    cellMeters: boardCellMetersFor(km * 1000),
  });
  const sizeReady = useCachedBoards(centre ? sizes.map((s) => request(Number(s.value))) : [], cb.boardLoading);
  const ready = (km: number) => centre !== null && sizeReady(request(km));
  return (
    <div className="lc-board-size" role="group" aria-label="Board size">
      <span className="lc-board-label">Board size</span>
      <SegmentedControl
        label="Board size, km from the centre to each edge"
        options={sizes.map((s) => ({
          ...s,
          disabled: cb.boardSizeLocked,
          title: cb.boardSizeLocked ? "Board size comes from Simulation Studio. Change it there and run the simulation again." : `${s.title}. ${readinessLabel(ready(Number(s.value)), Number(s.value) * 1000, boardCellMetersFor(Number(s.value) * 1000))}`,
        }))}
        value={String(cb.boardRadius / 1000)}
        onChange={(value) => cb.setBoardRadius(Number(value) * 1000)}
      />
      <span className="lc-dim">
        {cb.boardSizeLocked
          ? "Uses the simulator's landscape and cell size. Change the board in Simulation Studio and run it again."
          : cb.boardLoading
          ? "Loading the board\u2026"
          : `About ${cb.boardRadius / 500} \u00d7 ${cb.boardRadius / 500} km, ${boardCellMetersFor(cb.boardRadius)} m cells. ${readinessLabel(
              ready(cb.boardRadius / 1000),
              cb.boardRadius,
              boardCellMetersFor(cb.boardRadius),
            )}.`}
      </span>
    </div>
  );
}

/**
 * The board clock in the /live "Controls" block, under the AI agent row: board time (T+hh:mm),
 * one state tag (running, or why not), Pause/Resume and the speed-up slider, with the board size
 * and Reset board behind a disclosure. The clock runs only while AI monitoring is on.
 * Faster playback only shows board minutes
 * sooner; the clock still lands on every fire re-solve and ignition, so the fire model's results
 * do not change with speed.
 */
export default function BoardClock({ board: cb }: { board: CommandBoard }) {
  const [confirming, setConfirming] = useState(false);
  const board = cb.board;
  if (!board) return null;
  return (
    <div className="lc-board-clock" role="group" aria-label="Simulated board clock">
      <div className="lc-board-clock-head">
        <span className="lc-sim-label">Clock</span>
        <span className="lc-num lc-board-clock-time" aria-label={`Board time ${simClock(board.minute)}`}>
          {simClock(board.minute)}
        </span>
        <ClockState board={cb} />
        {cb.autopilot ? <PauseButton board={cb} className="lc-board-clock-pause" /> : null}
      </div>
      <BoardSpeedSlider board={cb} />
      <details className="lc-board-opts">
        <summary>Board size and reset</summary>
        <div className="lc-board-opts-body">
          <BoardSizeControl board={cb} />
          {confirming ? (
            <div className="lc-board-reset" role="group" aria-label="Confirm reset">
              <span className="lc-board-reset-text">
                Clear every fire, the burned ground, the units' moves and the log, and delete this drill's published
                Studio fires?
              </span>
              <Button
                size="sm"
                variant="danger"
                disabled={cb.resetting}
                onClick={() => void cb.reset().then(() => setConfirming(false))}
              >
                {cb.resetting ? "Resetting…" : "Reset board"}
              </Button>
              <Button size="sm" variant="ghost" disabled={cb.resetting} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="lc-board-reset-open" onClick={() => setConfirming(true)}>
              Reset board
            </Button>
          )}
        </div>
      </details>
    </div>
  );
}
