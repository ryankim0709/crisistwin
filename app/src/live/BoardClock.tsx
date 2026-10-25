import { useState } from "react";
import { Button } from "../ui";
import { simClock } from "../demo/format";
import { BOARD_SPEED_STEPS, type CommandBoard } from "../demo/useCommandBoard";

/** "60×" plus what it means in simulated time. */
function speedText(speed: number): string {
  if (speed === 1) return "1× · real time";
  const perSecond = speed / 60;
  return perSecond >= 1
    ? `${speed}× · ${Number.isInteger(perSecond) ? perSecond : perSecond.toFixed(1)} sim min/s`
    : `${speed}× · ${speed} sim min/min`;
}

/** The speed slider alone: stepped stops (BOARD_SPEED_STEPS), so the useful range is not squashed. */
export function BoardSpeedSlider({ board: cb }: { board: CommandBoard }) {
  const index = Math.max(0, BOARD_SPEED_STEPS.indexOf(cb.speed));
  return (
    <label className="lc-speed">
      <span className="lc-speed-label">Speed</span>
      <input
        type="range"
        className="lc-range"
        min={0}
        max={BOARD_SPEED_STEPS.length - 1}
        step={1}
        value={index}
        aria-valuetext={speedText(cb.speed)}
        onChange={(e) => cb.setSpeed(BOARD_SPEED_STEPS[Number(e.target.value)])}
      />
      <span className="lc-num lc-speed-value">{speedText(cb.speed)}</span>
    </label>
  );
}

/**
 * The simulated board's clock in the sidebar: board time, pause, and a speed-up slider. Faster
 * playback only shows simulated minutes sooner; the clock still lands on every fire re-solve and
 * ignition, so the fire model's results do not change with speed.
 */
export default function BoardClock({ board: cb }: { board: CommandBoard }) {
  const [confirming, setConfirming] = useState(false);
  const board = cb.board;
  if (!board) return null;
  return (
    <section className="lc-board-clock" aria-label="Simulated board clock">
      <div className="lc-board-clock-head">
        <h2>Board clock</h2>
        <span className="lc-num lc-board-clock-time" aria-label={`Simulated board time ${simClock(board.minute)}`}>
          {simClock(board.minute)}
        </span>
        <Button size="sm" variant="secondary" onClick={() => cb.setRunning((r) => !r)} aria-pressed={!cb.running}>
          {cb.running ? "Pause" : "Resume"}
        </Button>
      </div>
      <BoardSpeedSlider board={cb} />
      {confirming ? (
        <div className="lc-board-reset" role="group" aria-label="Confirm reset">
          <span className="lc-board-reset-text">
            Clear every fire, the burned ground, the units' moves and the log, and delete this drill's published Studio
            fires?
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
    </section>
  );
}
