/**
 * The one place /run reads the board's run-mode API (lead B: demo/useCommandBoard.ts `runMode`,
 * `restart(seed)`, `seed`, `timeline`, `agent.inputs`). Until that lands in this tree the fields are
 * read through optional casts so the typecheck stays green; each helper says what it falls back to.
 */

import { useCommandBoard, type CommandBoard, type CommandBoardOptions } from "../demo/useCommandBoard";
import type { AgentInputSnapshot, BoardRunMode, RunTimeline } from "../demo/runContracts";

type RunModeOptions = CommandBoardOptions & { runMode?: BoardRunMode };
type RunModeBoard = CommandBoard & {
  seed?: number;
  timeline?: RunTimeline;
  restart: (...args: unknown[]) => unknown;
};

/** useCommandBoard with a run mode ("baseline": nobody acts; "ai": the AI commander drives). */
export function useRunBoard(options: CommandBoardOptions & { runMode: BoardRunMode }): CommandBoard {
  return (useCommandBoard as (o: RunModeOptions) => CommandBoard)(options);
}

/** True once the board hook has lead B's run-mode API (restart(seed), seed, timeline). */
export function hasRunModes(cb: CommandBoard): boolean {
  const b = cb as RunModeBoard;
  return typeof b.timeline === "object" && b.timeline !== null;
}

/** The seed of the board now (cb.seed, else the board's own). */
export function boardSeed(cb: CommandBoard): number | null {
  return (cb as RunModeBoard).seed ?? cb.board?.seed ?? null;
}

/** The board's score timeline for the current run, or null before lead B's timeline lands. */
export function boardTimeline(cb: CommandBoard): RunTimeline | null {
  return (cb as RunModeBoard).timeline ?? null;
}

/**
 * Restart the board at T+0 on the same Studio fire with `seed` (lead B's restart(seed)). Returns
 * false when this board hook has no seeded restart yet (the old restart(load, studio) would take a
 * number as its snapshot argument, so it is never called with one).
 */
export function restartBoard(cb: CommandBoard, seed: number): boolean {
  if (!hasRunModes(cb)) return false;
  (cb as RunModeBoard).restart(seed);
  return true;
}

/** What the AI agent was shown, newest last (lead B's agent.inputs), or an empty list. */
export function agentInputs(cb: CommandBoard): AgentInputSnapshot[] {
  return (cb.agent as CommandBoard["agent"] & { inputs?: AgentInputSnapshot[] }).inputs ?? [];
}
