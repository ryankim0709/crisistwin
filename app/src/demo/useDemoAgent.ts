/**
 * The /demo autopilot: watches the board on the simulation clock and calls the AI commander
 * (POST /api/demo/decide) when the monitor (observation.ts wakeReasons) finds a reason. The
 * board is AI agent only (no automatic dispatch), so a newly reported fire calls it at once.
 *
 * Cadence (near-continuous while the incident is hot):
 * - Events wake it at once (new fire, escalation, outrun fire, freed crews, zone short of time,
 *   units arrived or standing at a fire with no work, line finished or breached, strategy failing,
 *   zone reached or newly threatened, road closure, orders refused last time); the monitor checks
 *   every MONITOR_EVERY_MINUTES board minute (a new reported fire on every board change).
 * - While a reported fire burns or a zone is threatened, it is called again CONTINUOUS_GAP_MINUTES
 *   after each decision's orders land (a continuous review), even when nothing fired; with only
 *   contained fires or leaving zones, every REVIEW_EVERY_MINUTES.
 * - At most one call is in flight. Events that happen while Claude thinks are compared with what
 *   that call saw, so they wake exactly one follow-up call as soon as it finishes (the queue);
 *   `queued` says one is waiting, and an urgent one raises the call's urgency for Auto speed.
 *
 * The clock keeps running while it thinks, and its orders apply at the board's minute when they
 * arrive (the page's `apply`, which validates through model.applyOrder). Disabling the autopilot
 * or unmounting aborts the call so a late response cannot apply. After a failed call the monitor
 * waits ERROR_BACKOFF_MINUTES (or decideNow). Monitoring also pauses while the browser tab is
 * hidden, so a forgotten tab does not keep calling Claude; it resumes when the tab is shown again.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionError, streamNdjson } from "../dispatch/agentClient";
import { DECIDE_URL, demoUrl, type DecisionEvent, type DecisionUsage, type DemoObservation, type DemoOrder } from "./contracts";
import type { Board, RouteOption, ZoneForecast } from "./model";
import {
  MONITOR_EVERY_MINUTES,
  REVIEW_KINDS,
  afterDecision,
  buildObservation,
  newReportedFireIds,
  rememberDecision,
  wakeReasons,
  type MonitorMemory,
  type Wake,
  type WakeUrgency,
} from "./observation";

/** Simulated minutes the monitor stays quiet after a failed call. */
export const ERROR_BACKOFF_MINUTES = 10;
/** Decisions kept in the log (continuous reviews add many; quiet ones collapse in the feed). */
const MAX_DECISIONS = 80;
const MANUAL_REASON = "Operator asked for a decision now.";

type FinalDecision = Extract<DecisionEvent, { type: "orders" }>;

/**
 * Claude spend of this page session (since load; a board reset keeps it): summed from each call's
 * `usage` (api/dispatch.py decision_usage, server list prices). Calls the server could not price
 * (an unlisted model) count in `unpricedCalls`, not in `costUsd`.
 */
export interface AgentSpend {
  calls: number;
  costUsd: number;
  unpricedCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export const NO_SPEND: AgentSpend = {
  calls: 0,
  costUsd: 0,
  unpricedCalls: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

function addUsage(spend: AgentSpend, usage: DecisionUsage): AgentSpend {
  return {
    calls: spend.calls + 1,
    costUsd: spend.costUsd + (usage.cost_usd ?? 0),
    unpricedCalls: spend.unpricedCalls + (usage.cost_usd === null ? 1 : 0),
    inputTokens: spend.inputTokens + usage.input_tokens,
    cacheReadTokens: spend.cacheReadTokens + usage.cache_read_input_tokens,
    cacheWriteTokens: spend.cacheWriteTokens + usage.cache_creation_input_tokens,
    outputTokens: spend.outputTokens + usage.output_tokens,
  };
}

export interface AgentDecision {
  id: number;
  /** Board minute of the observation the agent decided on. */
  minute: number;
  wokeBecause: string[];
  /** Streamed "text" deltas. */
  assessment: string;
  summary: string;
  model: string;
  /** Page-side application result per order. */
  applied: { order: DemoOrder; error: string | null }[];
  /** Server-side rejections. */
  rejected: { reason: string }[];
}

export interface DemoAgentOptions {
  /** Mutated in place; `version` bumps on every change. */
  board: Board | null;
  version: number;
  /** Incident the board runs on (sent as ?incident=). */
  incidentId: string;
  routes: ReadonlyMap<string, RouteOption[]>;
  forecasts: Map<string, ZoneForecast>;
  /** Autopilot toggle. */
  enabled: boolean;
  /** Applies orders (model.applyOrder, actor "agent"); returns a per-order error or null. */
  apply: (orders: DemoOrder[]) => (string | null)[];
}

export interface DemoAgent {
  /** paused: monitoring is on but the tab is hidden. */
  status: "off" | "paused" | "watching" | "thinking" | "error";
  /**
   * While thinking: how pressing the call is (observation.ts WakeUrgency), raised to urgent when an
   * urgent event is queued behind it. Auto speed runs 1× for urgent, the reviewing speed for routine.
   */
  urgency: WakeUrgency | null;
  /** An event happened while Claude thinks: one follow-up call starts when this one finishes. */
  queued: WakeUrgency | null;
  /** Live streamed thinking summary for the current call (cleared per call). */
  thinking: string;
  /** Live streamed assessment text for the current call. */
  streamText: string;
  /** Newest first, last MAX_DECISIONS. */
  decisions: AgentDecision[];
  /** Claude spend of this page session (calls that returned usage). */
  spend: AgentSpend;
  error: string | null;
  lastWoke: string[];
  /** Force a call now; works with the autopilot off (one-off call). */
  decideNow: () => void;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function useDemoAgent(opts: DemoAgentOptions): DemoAgent {
  const { board, version } = opts;
  const visible = usePageVisible();
  const enabled = opts.enabled && visible;
  const [inFlight, setInFlight] = useState(false);
  const [thinking, setThinking] = useState("");
  const [streamText, setStreamText] = useState("");
  const [decisions, setDecisions] = useState<AgentDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastWoke, setLastWoke] = useState<string[]>([]);
  const [urgency, setUrgency] = useState<WakeUrgency | null>(null);
  const [queued, setQueued] = useState<WakeUrgency | null>(null);
  const [spend, setSpend] = useState<AgentSpend>(NO_SPEND);

  // Latest options for callbacks that run outside render (stream events, the monitor).
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const abortRef = useRef<AbortController | null>(null);
  const boardRef = useRef<Board | null>(null);
  const memoryRef = useRef<MonitorMemory | null>(null);
  /** What the call in flight saw (the queue compares events with it). */
  const seenRef = useRef<MonitorMemory | null>(null);
  const previousRef = useRef<DemoObservation["previous"]>(null);
  const lastBucketRef = useRef<number | null>(null);
  const backoffUntilRef = useRef(-Infinity);
  /** Reported fires already sent to the agent in an observation (each new fire triggers at most one immediate call). */
  const calledFireIdsRef = useRef(new Set<string>());
  const idRef = useRef(0);

  // Aborting rejects the stream; its `finally` then clears the in-flight state.
  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const call = useCallback((current: Board, wake: Wake) => {
    if (abortRef.current) return;
    const { routes, forecasts } = optsRef.current;
    const reasons = wake.reasons;
    const observation = buildObservation(current, routes, forecasts, reasons, previousRef.current, wake.urgency);
    for (const f of observation.fires) calledFireIdsRef.current.add(f.id);
    const seen = rememberDecision(current, forecasts);
    seenRef.current = seen;
    const wokeOnRefusal = wake.triggers.some((t) => t.kind === "refused");
    const minute = observation.clock.minute;
    const controller = new AbortController();
    abortRef.current = controller;
    setInFlight(true);
    setUrgency(wake.urgency);
    setQueued(null);
    setThinking("");
    setStreamText("");
    setLastWoke(reasons);
    let assessment = "";

    streamNdjson<FinalDecision>(
      demoUrl(DECIDE_URL, optsRef.current.incidentId),
      { observation, urgency: wake.urgency },
      (event) => event.type === "orders",
      (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "thinking") setThinking((t) => t + event.text);
        else {
          assessment += event.text;
          setStreamText(assessment);
        }
      },
      controller.signal,
    )
      .then((decision) => {
        // Billed even when the answer comes too late to apply.
        const usage = decision.usage;
        if (usage) setSpend((s) => addUsage(s, usage));
        if (controller.signal.aborted || boardRef.current !== current) return;
        const errors = optsRef.current.apply(decision.orders);
        const applied = decision.orders.map((order, i) => ({ order, error: errors[i] ?? null }));
        const refused = [
          ...decision.rejected.map((r) => r.reason),
          ...applied.filter((a) => a.error !== null).map((a) => `Not applied: ${a.error}`),
        ];
        memoryRef.current = afterDecision(
          seen,
          current,
          applied.filter((a) => a.error === null).map((a) => a.order),
          refused.length,
          wokeOnRefusal,
        );
        previousRef.current = { minute, summary: decision.summary, rejected: refused };
        idRef.current += 1;
        const entry: AgentDecision = {
          id: idRef.current,
          minute,
          wokeBecause: reasons,
          assessment,
          summary: decision.summary,
          model: decision.model,
          applied,
          rejected: decision.rejected.map((r) => ({ reason: r.reason })),
        };
        setDecisions((list) => [entry, ...list].slice(0, MAX_DECISIONS));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DecisionError && cause.usage) {
          const usage = cause.usage;
          setSpend((s) => addUsage(s, usage));
        }
        if (controller.signal.aborted || boardRef.current !== current) return;
        backoffUntilRef.current = current.minute + ERROR_BACKOFF_MINUTES;
        setError(
          cause instanceof DecisionError || cause instanceof Error ? cause.message : "The agent request failed.",
        );
      })
      .finally(() => {
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        seenRef.current = null;
        // Check again on the next board change: a queued event starts its follow-up call at once.
        lastBucketRef.current = null;
        setInFlight(false);
        setUrgency(null);
        setQueued(null);
      });
  }, []);

  // A new board is a new run: forget the old one and drop any call made on it.
  useEffect(() => {
    if (boardRef.current === board) return;
    boardRef.current = board;
    cancel();
    memoryRef.current = null;
    seenRef.current = null;
    previousRef.current = null;
    lastBucketRef.current = null;
    backoffUntilRef.current = -Infinity;
    calledFireIdsRef.current = new Set();
    // A new board (reset, drill switch) starts a clean log.
    setDecisions([]);
    setError(null);
    setThinking("");
    setStreamText("");
    setLastWoke([]);
  }, [board, cancel]);

  // A different incident: the log and error name the old drill's zones, fires and units.
  const { incidentId } = opts;
  useEffect(() => {
    setDecisions([]);
    setError(null);
    setThinking("");
    setStreamText("");
    setLastWoke([]);
  }, [incidentId]);

  // Turning monitoring off (or hiding the tab) cancels its call; unmounting cancels any call.
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);
  useEffect(() => cancel, [cancel]);

  // The monitor: once per MONITOR_EVERY_MINUTES of simulated time. A newly reported fire the
  // agent has not been shown yet is checked at once (on the board's next change, also inside an
  // error backoff): nothing dispatches initial attack on this board but the agent. While a call is
  // in flight it only notes whether an event is queued behind it (compared with what that call
  // saw); the follow-up starts when the call finishes (`finally` resets the bucket).
  useEffect(() => {
    if (!enabled || !board) return;
    const memory = abortRef.current ? seenRef.current : memoryRef.current;
    const urgent = newReportedFireIds(board, memory).some((id) => !calledFireIdsRef.current.has(id));
    const bucket = Math.floor(board.minute / MONITOR_EVERY_MINUTES);
    if (bucket === lastBucketRef.current && !urgent) return;
    lastBucketRef.current = bucket;
    const wake = wakeReasons(board, optsRef.current.forecasts, memory);
    if (abortRef.current) {
      const events = wake.triggers.filter((t) => !REVIEW_KINDS.has(t.kind));
      const next: WakeUrgency | null = events.length === 0 ? null : events.some((t) => t.urgency === "urgent") ? "urgent" : "routine";
      setQueued((q) => (q === "urgent" ? q : next));
      return;
    }
    if (board.minute < backoffUntilRef.current && !urgent) return;
    if (wake.triggers.length > 0) call(board, wake);
  }, [board, version, enabled, call]);

  const decideNow = useCallback(() => {
    const current = optsRef.current.board;
    if (!current || abortRef.current) return;
    backoffUntilRef.current = -Infinity;
    const wake = wakeReasons(current, optsRef.current.forecasts, memoryRef.current);
    call(current, { triggers: wake.triggers, reasons: [MANUAL_REASON, ...wake.reasons], urgency: "urgent" });
  }, [call]);

  const status: DemoAgent["status"] = inFlight
    ? "thinking"
    : !opts.enabled
      ? "off"
      : !visible
        ? "paused"
        : error
          ? "error"
          : "watching";
  const callUrgency: WakeUrgency | null = inFlight ? (queued === "urgent" ? "urgent" : (urgency ?? "urgent")) : null;
  return { status, urgency: callUrgency, queued: inFlight ? queued : null, thinking, streamText, decisions, spend, error, lastWoke, decideNow };
}
