import { fetchCommand } from "./api";
import type { CommandResponse } from "./types";
import { usePoll, type PollState } from "./usePoll";

const POLL_MS = 3_000;

export type CommandState = PollState<CommandResponse>;

/** The controller's one poll (docs/live-reports.md "Command"). */
export function useCommand(token: string | null): CommandState & { refresh: () => void } {
  return usePoll(token, fetchCommand, POLL_MS, "Live API");
}
