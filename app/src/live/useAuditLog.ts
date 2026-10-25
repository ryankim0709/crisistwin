import { useMemo, useState } from "react";
import type { Board } from "../demo/model";
import type { useDemoAgent } from "../demo/useDemoAgent";
import { AUDIT_CAP, boardEntry, boardEventKeys, claudeEntry, drillEntry, type AuditEntry } from "./auditEntries";
import type { Decision } from "./types";

type Agent = ReturnType<typeof useDemoAgent>;

const NO_BOARD = {};

export interface AuditPending {
  reasons: string[];
  text: string;
  thinking: string;
}

/**
 * Merges Claude decisions, board events and live drill decisions into one newest-first list.
 * Board and Claude items only carry sim minutes, so each is stamped with `serverNow` the first
 * time it is seen (same clock frame as the drill's own `at`). The stamp map resets when the
 * board object is replaced; drill entries are kept.
 */
export function useAuditLog({
  agent,
  board,
  version,
  liveDecisions,
  serverNow,
  name,
}: {
  agent: Agent;
  board: Board | null;
  /** Board version; bumps on every in-place change. */
  version: number;
  liveDecisions: Decision[];
  serverNow: number;
  /** Display name for a zone or destination id. */
  name: (id: string) => string;
}): { entries: AuditEntry[]; pending: AuditPending | null } {
  // First-seen stamps live in a stable mutable holder (not state that re-renders).
  // One map per board object, so replacing the board (restart, incident switch) starts clean.
  const [stamps] = useState(() => new WeakMap<object, Map<string, number>>());
  const decisions = agent.decisions;

  const entries = useMemo(() => {
    const owner = board ?? NO_BOARD;
    let seen = stamps.get(owner);
    if (!seen) {
      seen = new Map();
      stamps.set(owner, seen);
    }
    const stamp = (id: string): number => {
      let ms = seen.get(id);
      if (ms === undefined) {
        ms = serverNow;
        seen.set(id, ms);
      }
      return ms;
    };
    const out: AuditEntry[] = [];
    for (const d of decisions) out.push(claudeEntry(d, stamp(`claude-${d.id}`), name));
    if (board) {
      const keys = boardEventKeys(board.events);
      board.events.forEach((e, i) => {
        const entry = boardEntry(e, keys[i], stamp(keys[i]));
        if (entry) out.push(entry);
      });
    }
    // Occurrence counted oldest first, so an id survives new decisions arriving at the front.
    const drillSeen = new Map<string, number>();
    for (let i = liveDecisions.length - 1; i >= 0; i--) {
      const d = liveDecisions[i];
      const k = `${d.at}|${d.action}|${d.report_ids.join(",")}|${d.proposal_id ?? ""}`;
      const n = (drillSeen.get(k) ?? 0) + 1;
      drillSeen.set(k, n);
      out.push(drillEntry(d, n, serverNow));
    }
    // Array.sort is stable, so equal stamps keep Claude, then board, then drill order.
    out.sort((a, b) => b.wallMs - a.wallMs);
    return out.slice(0, AUDIT_CAP);
    // `version` signals in-place board mutation; serverNow is read only to stamp new items, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, version, decisions, liveDecisions, name, stamps]);

  const thinking = agent.status === "thinking";
  const pending = useMemo<AuditPending | null>(
    () => (thinking ? { reasons: agent.lastWoke, text: agent.streamText, thinking: agent.thinking } : null),
    [thinking, agent.lastWoke, agent.streamText, agent.thinking],
  );
  return { entries, pending };
}
