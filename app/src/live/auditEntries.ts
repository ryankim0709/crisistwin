import type { DemoOrder } from "../demo/contracts";
import type { BoardEvent } from "../demo/model";
import type { AgentDecision } from "../demo/useDemoAgent";
import type { Decision } from "./types";

/** Where an audit entry came from. Shown as a labelled tag, never by colour alone. */
export type AuditSource = "claude" | "you" | "board" | "studio" | "drill";

export interface AuditEntry {
  /** Stable across renders. */
  id: string;
  /** claude = AI commander; you = operator actions on the board; board = simulation events; studio = Simulation Studio fires arriving and starting; drill = live drill decisions. */
  source: AuditSource;
  /** Sort key: wall-clock ms when it happened (drill) or was first seen (board, claude). */
  wallMs: number;
  /** Board clock minute for board/claude/you entries. */
  simMinute: number | null;
  title: string;
  /** Claude's summary or a drill note. */
  detail?: string;
  orders?: { text: string; ok: boolean; error: string | null }[];
  /** Claude's assessment text (collapsible). */
  reasoning?: string;
  /** Drill auto_policy decision. */
  automatic?: boolean;
  /** Drill entries that point at reports. */
  reportIds?: string[];
  boardRef?: { kind: "fire" | "zone" | "team"; id: string } | null;
  /** A board fire outcome worth a check mark in the log. */
  outcome?: "contained" | "out";
}

export const AUDIT_CAP = 300;

const DRILL_VERBS: Record<string, string> = {
  confirm: "Confirmed report",
  dismiss: "Dismissed report",
  merge: "Merged reports",
  resolve: "Resolved report",
  task_create: "Requested field check",
  task_cancel: "Cancelled field check",
  approve: "Approved guidance",
  reject: "Rejected guidance",
  auto_approve: "Auto-approved reroute",
  drill_start: "Drill started",
  drill_pause: "Drill paused",
  drill_resume: "Drill resumed",
  drill_reset: "Drill reset",
  help_acknowledge: "Acknowledged help request",
  help_assign: "Assigned responder to help request",
  help_resolve: "Resolved help request",
};

export function drillVerb(action: string): string {
  if (DRILL_VERBS[action]) return DRILL_VERBS[action];
  const words = action.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function orderText(order: DemoOrder, name: (id: string) => string): string {
  if (order.type === "send_crew") return `Send ${order.crew_id} to ${order.fire_id}`;
  if (order.type === "release_crew") return `Release ${order.crew_id}`;
  return `Evacuate ${name(order.zone_id)} to ${name(order.destination_id)}`;
}

function orderRef(order: DemoOrder): AuditEntry["boardRef"] {
  if (order.type === "send_crew") return { kind: "fire", id: order.fire_id };
  if (order.type === "release_crew") return { kind: "team", id: order.crew_id };
  return { kind: "zone", id: order.zone_id };
}

/** One Claude decision. `wallMs` is when the page first saw it. */
export function claudeEntry(d: AgentDecision, wallMs: number, name: (id: string) => string): AuditEntry {
  const orders = [
    ...d.applied.map((a) => ({
      text: orderText(a.order, name) + (a.order.reason ? ` · ${a.order.reason}` : ""),
      ok: !a.error,
      error: a.error,
    })),
    ...d.rejected.map((r) => ({ text: "Order rejected", ok: false, error: r.reason })),
  ];
  const first = d.applied[0]?.order;
  const title = d.applied.length
    ? `Claude issued ${d.applied.length} order${d.applied.length === 1 ? "" : "s"}`
    : "Claude reviewed the board";
  const reason = d.wokeBecause.length ? `Woke because: ${d.wokeBecause.join("; ")}` : "";
  const summary = d.summary || (d.assessment ? "" : "No change needed.");
  return {
    id: `claude-${d.id}`,
    source: "claude",
    wallMs,
    simMinute: d.minute,
    title,
    detail: [summary, reason].filter(Boolean).join("\n") || undefined,
    orders: orders.length ? orders : undefined,
    reasoning: d.assessment || undefined,
    boardRef: first ? orderRef(first) : null,
  };
}

/** Stable key for a board event: minute + kind + text + occurrence (counted oldest first). */
export function boardEventKeys(events: readonly BoardEvent[]): string[] {
  const seen = new Map<string, number>();
  const keys: string[] = new Array(events.length);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const base = `${e.minute}|${e.kind}|${e.text}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys[i] = `board-${base}|${n}`;
  }
  return keys;
}

/**
 * A board event as an entry, or null for actor "agent": those are the application of a Claude
 * order and already appear inside that decision's order list.
 */
export function boardEntry(e: BoardEvent, id: string, wallMs: number): AuditEntry | null {
  if (e.actor === "agent") return null;
  return {
    id,
    source: e.actor === "you" ? "you" : e.actor === "studio" ? "studio" : "board",
    wallMs,
    simMinute: e.minute,
    title: e.text,
    outcome: e.kind === "contained" ? "contained" : e.kind === "out" ? "out" : undefined,
  };
}

export function drillEntry(d: Decision, occurrence: number, fallbackMs: number): AuditEntry {
  const t = new Date(d.at).getTime();
  return {
    id: `drill-${d.at}-${d.action}-${d.report_ids.join(",")}-${d.proposal_id ?? ""}-${occurrence}`,
    source: "drill",
    wallMs: Number.isNaN(t) ? fallbackMs : t,
    simMinute: null,
    title: drillVerb(d.action),
    detail: d.note ?? undefined,
    automatic: d.actor === "auto_policy",
    reportIds: d.report_ids.length ? d.report_ids : undefined,
  };
}
