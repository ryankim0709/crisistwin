import { simClock } from "../demo/format";
import type { RunStateSyncState } from "../demo/useRunStateSync";
import "./runState.css";

/**
 * One quiet line under the board clock: whether the board's run state (who is home, waiting,
 * evacuating, safe; demo/runState.ts) reached the database, and at which board minute. A failed
 * save (e.g. the database over quota) or another console owning the run state is stated, not
 * alarmed: the board keeps running.
 */
export default function RunStateStatus({ sync, ready }: { sync: RunStateSyncState; ready: boolean }) {
  if (!ready) return null;
  let text: string;
  // Short: "Saved to database · T+00:00" and its variants (the times are board time).
  if (sync.ownedElsewhere) {
    const since = sync.ownedElsewhere.sinceMinute === null ? "" : ` · since ${simClock(sync.ownedElsewhere.sinceMinute)}`;
    text = `Saved by another console${since}`;
  } else if (sync.error) {
    text = `Not saved: ${sync.error}`;
    if (sync.lastSavedMinute !== null) text += ` · last ${simClock(sync.lastSavedMinute)}`;
  } else if (sync.lastSavedMinute !== null) {
    text = `Saved to database · ${simClock(sync.lastSavedMinute)}`;
  } else {
    text = "Not saved yet";
  }
  return (
    <p className="lc-runstate" role="status" aria-live="polite">
      {text}
    </p>
  );
}
