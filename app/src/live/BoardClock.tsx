import { useEffect, useState } from "react";
import { Button, SegmentedControl } from "../ui";
import { simClock } from "../demo/format";
import { boardCellMetersFor } from "../fire/boardSize";
import { readinessLabel, useCachedBoards } from "../fire/useCachedBoards";
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

/**
 * The board's area size (km from the centre to each edge, stored in the shared world), with
 * whether each size's landscape is already cached. Used in the sidebar's board clock and in
 * BoardControls' Conditions popover.
 */
export function BoardSizeControl({ board: cb }: { board: CommandBoard }) {
  const centre = useDrillCentre();
  const request = (km: number) => ({
    longitude: centre?.[0] ?? 0,
    latitude: centre?.[1] ?? 0,
    radiusMeters: km * 1000,
    cellMeters: boardCellMetersFor(km * 1000),
  });
  const sizeReady = useCachedBoards(centre ? BOARD_SIZES.map((s) => request(Number(s.value))) : [], cb.boardLoading);
  const ready = (km: number) => centre !== null && sizeReady(request(km));
  return (
    <div className="lc-board-size" role="group" aria-label="Board size">
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
    </div>
  );
}

/**
 * The simulated board's clock in the sidebar: board time, pause, a speed-up slider and the board size. Faster
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
      <BoardSizeControl board={cb} />
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
