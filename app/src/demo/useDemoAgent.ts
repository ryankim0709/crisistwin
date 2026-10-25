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
 *
 * The live drill's incident picture (incidentPicture.ts) also wakes it, on wall time: a new help
 * request, road-blocked report, real-phone report or confirmation is checked PICTURE_DEBOUNCE_MS
 * after it arrives (bursts are batched) and at most once per PICTURE_MIN_GAP_MS, so phone
 * actions reach the commander within seconds even when the board clock runs slowly. These are
 * urgent wakes (kind live_report) and go through the same single-call queue.
 *
 * Pacing (`pacing`, AiPacing). "auto" (default, /live): the cadence above; Auto speed
 * (autoSpeed.ts) slows the board while a call is in flight. "realtime" (/run's AI step, user
 * decision 2026-10-25 "clock keeps running"): the board runs at the page's speed while Claude
 * thinks, like a dispatcher under time pressure. Only a new reported fire, a zone newly too late
 * (no order, order slack spent: observation.ts lateZoneIds) or a new life-threat call (simComms
 * trapped / critical injury, one per injury or zone) calls at once; while a call is in flight such
 * an event queues one urgent follow-up. Every other wake (events and reviews alike) waits until
 * REALTIME_ROUTINE_GAP_MINUTES board minutes after the last call ended. Orders still apply when
 * they land, validated against the board then (model.applyOrder); a refusal that landed after the
 * board moved says so in the decision and in the board's audit log. Because model latency varies,
 * a realtime run is not bit-reproducible even on the same seed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionError, streamNdjson } from "../dispatch/agentClient";
import {
  DECIDE_URL,
  demoUrl,
  isLiveOrder,
  type CommanderOrder,
  type DecisionEvent,
  type DecisionUsage,
  type DemoObservation,
  type DemoOrder,
  type LiveOrder,
} from "./contracts";
import { logEvent, type Board, type RouteOption, type ZoneForecast } from "./model";
import { simClock } from "./format";
import { pictureWakeReasons, type PictureKeys, type PictureResult } from "./incidentPicture";
import {
  MONITOR_EVERY_MINUTES,
  REVIEW_KINDS,
  afterDecision,
  buildObservation,
  lateZoneIds,
  newReportedFireIds,
  rememberDecision,
  wakeReasons,
  type MonitorMemory,
  type Wake,
  type WakeTrigger,
  type WakeUrgency,
} from "./observation";
import type { AgentInputSnapshot, SimCommsState } from "./runContracts";

/** Simulated minutes the monitor stays quiet after a failed call. */
export const ERROR_BACKOFF_MINUTES = 10;
/** Decisions kept in the log (continuous reviews add many; quiet ones collapse in the feed). */
const MAX_DECISIONS = 80;
/** Observations kept for the "What the agent sees" panel (newest last). */
const MAX_INPUTS = 30;
const MANUAL_REASON = "Operator asked for a decision now.";
/** Wall ms between a new picture item and the check that may call the agent (batches bursts). */
export const PICTURE_DEBOUNCE_MS = 2_000;
/** Wall ms between two picture-triggered calls (bounds Claude calls while phones are busy). */
export const PICTURE_MIN_GAP_MS = 15_000;
/**
 * How the agent's calls are paced against the board clock (see the top comment). "auto": /live
 * (Auto speed slows the board while Claude decides). "realtime": the clock keeps running (/run).
 */
export type AiPacing = "auto" | "realtime";
/**
 * Realtime pacing: board minutes after a call ends before a routine (non-urgent) wake may call
 * again. UI/ops choice (user decision 2026-10-25: routine reviews spaced out so a 6 h run fits in
 * about 5-10 real minutes at 60×), not a sourced dispatch interval.
 */
export const REALTIME_ROUTINE_GAP_MINUTES = 10;
/** Life-threat calls named in one wake reason before "and n more". */
const MAX_LIFE_THREAT_LISTED = 3;

/**
 * Simulated life-threat calls on the board (simComms.ts: severity life_threat, or a trapped call),
 * keyed per injury (its reminders repeat) or else per zone, so one party wakes the agent once.
 */
function lifeThreatCalls(board: Board): { key: string; text: string }[] {
  const comms = (board as { simComms?: SimCommsState }).simComms;
  if (!comms) return [];
  const out = new Map<string, string>();
  for (const item of comms.items) {
    if (item.severity !== "life_threat" && item.kind !== "trapped") continue;
    const key = item.injuryId ?? (item.zoneId ? `zone:${item.zoneId}:${item.kind}` : item.id);
    if (!out.has(key)) out.set(key, `${item.from} (${item.channel}, ${simClock(item.minute)}${item.injuryId ? `, ${item.injuryId}` : ""}${item.zoneId ? `, ${item.zoneId}` : ""}): "${item.text}"`);
  }
  return [...out].map(([key, text]) => ({ key, text }));
}

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
  /** Board minute when its orders landed (applied); the board kept running from `minute` to here. */
  landedMinute: number;
  /** Wall ms from the request to the orders landing (model latency; display only). */
  latencyMs: number;
  wokeBecause: string[];
  /** Streamed "text" deltas. */
  assessment: string;
  summary: string;
  model: string;
  /** Page-side application result per order. */
  applied: { order: CommanderOrder; error: string | null }[];
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
  /** Runs live drill actions (liveOrders.ts); absent: they are refused. Returns a per-order error or null. */
  applyLive?: (orders: LiveOrder[]) => (string | null)[];
  /** The live drill's incident picture and its monitor keys; null without a live drill. */
  picture?: PictureResult | null;
  /** "auto" (default, /live) or "realtime" (/run: the clock keeps running while Claude decides). See the top comment. */
  pacing?: AiPacing;
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
  /** What each call was shown (the exact observation posted), newest last, last MAX_INPUTS; cleared with a new board. */
  inputs: AgentInputSnapshot[];
  /** The newest of `inputs`, or null. */
  lastInput: AgentInputSnapshot | null;
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

/** Two wakes as one call: triggers and reasons joined, urgent if either is. */
function mergeWakes(a: Wake, b: Wake): Wake {
  const triggers = [...a.triggers, ...b.triggers];
  return {
    triggers,
    reasons: [...a.reasons, ...b.reasons],
    urgency: triggers.some((t) => t.urgency === "urgent") ? "urgent" : a.triggers.length ? a.urgency : b.urgency,
  };
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
  // Tagged with its board, so a new board never shows the old run's inputs (even for one render).
  const [inputLog, setInputLog] = useState<{ board: Board | null; list: AgentInputSnapshot[] }>({ board: null, list: [] });

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
  /** Calls made on this page (input snapshot ids). */
  const callCountRef = useRef(0);
  /** Picture items the agent has seen (at its last decision, or when monitoring started). */
  const seenPictureRef = useRef<PictureKeys | null>(null);
  const lastPictureCallRef = useRef(-Infinity);
  /** Realtime pacing: board minute the last call ended (routine wakes wait REALTIME_ROUTINE_GAP_MINUTES after it). */
  const lastEndMinuteRef = useRef(-Infinity);
  /** Realtime pacing: late zones and life-threat calls already shown to the agent (each calls at once only once). */
  const calledLateZoneIdsRef = useRef(new Set<string>());
  const calledLifeKeysRef = useRef(new Set<string>());

  // Aborting rejects the stream; its `finally` then clears the in-flight state.
  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const call = useCallback((current: Board, wake: Wake) => {
    if (abortRef.current) return;
    const { routes, forecasts, picture } = optsRef.current;
    const reasons = wake.reasons;
    const observation = buildObservation(current, routes, forecasts, reasons, previousRef.current, wake.urgency, picture?.picture ?? null);
    const seenPicture = picture?.keys ?? null;
    callCountRef.current += 1;
    const snapshot: AgentInputSnapshot = {
      id: `${current.seed}-${observation.clock.minute}-${callCountRef.current}`,
      minute: observation.clock.minute,
      sentAtMs: Date.now(),
      urgency: wake.urgency,
      reasons,
      observation,
      bytes: new TextEncoder().encode(JSON.stringify(observation)).length,
    };
    setInputLog((log) => ({ board: current, list: [...(log.board === current ? log.list : []), snapshot].slice(-MAX_INPUTS) }));
    for (const f of observation.fires) calledFireIdsRef.current.add(f.id);
    if (optsRef.current.pacing === "realtime") {
      for (const id of lateZoneIds(current, forecasts)) calledLateZoneIdsRef.current.add(id);
      for (const c of lifeThreatCalls(current)) calledLifeKeysRef.current.add(c.key);
    }
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
        const boardOrders = decision.orders.filter((o): o is DemoOrder => !isLiveOrder(o));
        const live = decision.orders.filter(isLiveOrder);
        const boardErrors = optsRef.current.apply(boardOrders);
        const liveErrors = optsRef.current.applyLive?.(live) ?? live.map(() => "No live drill.");
        const applied = [
          ...boardOrders.map((order, i) => ({ order: order as CommanderOrder, error: boardErrors[i] ?? null })),
          ...live.map((order, i) => ({ order: order as CommanderOrder, error: liveErrors[i] ?? null })),
        ];
        // Realtime pacing: the board kept running while Claude decided, so an order can land on a
        // board that has moved on (zone overrun or already leaving, fire out, unit busy). applyOrder
        // validated it against the board now; say when it landed and keep it in the audit log.
        const landedMinute = current.minute;
        const lag = Math.floor(landedMinute) - minute;
        if (optsRef.current.pacing === "realtime" && lag >= 1) {
          const late = applied.filter((a) => a.error !== null);
          for (const a of late) a.error = `${a.error} (decided on the ${simClock(minute)} board, landed at ${simClock(landedMinute)})`;
          if (late.length > 0) {
            logEvent(
              current,
              "order",
              "agent",
              `${late.length} of Claude's order${late.length > 1 ? "s" : ""} not applied: decided on the ${simClock(minute)} board, landed ${lag} board min later. ${late.map((a) => `${a.order.type}: ${a.error}`).join(" ")}`,
            );
          }
        }
        const refused = [
          ...decision.rejected.map((r) => r.reason),
          ...applied.filter((a) => a.error !== null).map((a) => `Not applied: ${a.error}`),
        ];
        memoryRef.current = afterDecision(
          seen,
          current,
          boardOrders.filter((_, i) => (boardErrors[i] ?? null) === null),
          refused.length,
          wokeOnRefusal,
        );
        if (seenPicture) seenPictureRef.current = seenPicture;
        previousRef.current = { minute, summary: decision.summary, rejected: refused };
        idRef.current += 1;
        const entry: AgentDecision = {
          id: idRef.current,
          minute,
          landedMinute,
          latencyMs: Date.now() - snapshot.sentAtMs,
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
        if (boardRef.current === current) lastEndMinuteRef.current = current.minute;
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
    seenPictureRef.current = null;
    calledFireIdsRef.current = new Set();
    lastEndMinuteRef.current = -Infinity;
    calledLateZoneIdsRef.current = new Set();
    calledLifeKeysRef.current = new Set();
    // A new board (reset, drill switch) starts a clean log.
    setDecisions([]);
    setInputLog({ board, list: [] });
    setError(null);
    setThinking("");
    setStreamText("");
    setLastWoke([]);
  }, [board, cancel]);

  // A different incident: the log and error name the old drill's zones, fires and units.
  const { incidentId } = opts;
  useEffect(() => {
    setDecisions([]);
    setInputLog((log) => ({ board: log.board, list: [] }));
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

  /** New live-drill items since the agent last saw the picture, as urgent wake triggers. */
  const pictureWake = useCallback((): Wake => {
    const p = optsRef.current.picture;
    const texts = pictureWakeReasons(p?.keys ?? null, seenPictureRef.current, p?.picture ?? null);
    const triggers = texts.map((text) => ({ kind: "live_report" as const, urgency: "urgent" as const, text }));
    return { triggers, reasons: texts, urgency: "urgent" };
  }, []);

  // Realtime pacing (top comment): the board does not wait for Claude. Urgent events (a new reported
  // fire, a zone newly too late, a new life-threat call) call at once, or queue one urgent follow-up
  // while a call is in flight; every other wake waits REALTIME_ROUTINE_GAP_MINUTES after the last call ended.
  const realtimeMonitor = useCallback(
    (current: Board) => {
      const { forecasts } = optsRef.current;
      const memory = abortRef.current ? seenRef.current : memoryRef.current;
      const newFires = newReportedFireIds(current, memory).filter((id) => !calledFireIdsRef.current.has(id));
      const late = lateZoneIds(current, forecasts).filter((id) => !calledLateZoneIdsRef.current.has(id));
      const life = lifeThreatCalls(current).filter((c) => !calledLifeKeysRef.current.has(c.key));
      const urgent = newFires.length + late.length + life.length > 0;
      const bucket = Math.floor(current.minute / MONITOR_EVERY_MINUTES);
      if (bucket === lastBucketRef.current && !urgent) return;
      lastBucketRef.current = bucket;
      if (abortRef.current) {
        // One urgent follow-up starts when the call in flight ends; routine events wait for the gap.
        if (urgent) setQueued("urgent");
        return;
      }
      const lifeTriggers: WakeTrigger[] = life.length
        ? [
            {
              kind: "life_threat_call",
              urgency: "urgent",
              text:
                `New life-threat call${life.length > 1 ? "s" : ""} (simulated): ${life.slice(0, MAX_LIFE_THREAT_LISTED).map((c) => c.text).join("; ")}` +
                (life.length > MAX_LIFE_THREAT_LISTED ? `; and ${life.length - MAX_LIFE_THREAT_LISTED} more.` : "."),
            },
          ]
        : [];
      const lifeWake: Wake = { triggers: lifeTriggers, reasons: lifeTriggers.map((t) => t.text), urgency: "urgent" };
      const wake = mergeWakes(mergeWakes(lifeWake, wakeReasons(current, forecasts, memory)), pictureWake());
      if (urgent) {
        if (wake.triggers.length > 0) {
          call(current, { ...wake, urgency: "urgent" });
        } else {
          // Nothing to say about them (the monitor already knew): do not re-check them on every tick.
          for (const id of newFires) calledFireIdsRef.current.add(id);
          for (const id of late) calledLateZoneIdsRef.current.add(id);
        }
        return;
      }
      if (current.minute < backoffUntilRef.current) return;
      if (current.minute - lastEndMinuteRef.current < REALTIME_ROUTINE_GAP_MINUTES) return;
      if (wake.triggers.length > 0) call(current, wake);
    },
    [call, pictureWake],
  );

  // The monitor: once per MONITOR_EVERY_MINUTES of simulated time. A newly reported fire the
  // agent has not been shown yet is checked at once (on the board's next change, also inside an
  // error backoff): nothing dispatches initial attack on this board but the agent. While a call is
  // in flight it only notes whether an event is queued behind it (compared with what that call
  // saw); the follow-up starts when the call finishes (`finally` resets the bucket).
  useEffect(() => {
    if (!enabled || !board) return;
    if (optsRef.current.pacing === "realtime") {
      realtimeMonitor(board);
      return;
    }
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
    const live = pictureWake();
    const merged = mergeWakes(wake, live);
    if (merged.triggers.length > 0) call(board, merged);
  }, [board, version, enabled, call, pictureWake, realtimeMonitor]);

  // The picture monitor (wall time): new live items wake the agent within seconds.
  const pictureKeys = opts.picture?.keys ?? null;
  useEffect(() => {
    if (!enabled || !pictureKeys) return;
    // The backlog present when monitoring starts is in the first observation, not a wake reason.
    if (!seenPictureRef.current) {
      seenPictureRef.current = pictureKeys;
      return;
    }
    if (pictureWake().triggers.length === 0) return;
    if (abortRef.current) {
      // One urgent follow-up starts when the call in flight finishes.
      setQueued("urgent");
      return;
    }
    const wait = Math.max(PICTURE_DEBOUNCE_MS, lastPictureCallRef.current + PICTURE_MIN_GAP_MS - Date.now());
    const timer = window.setTimeout(() => {
      const current = optsRef.current.board;
      if (!current || abortRef.current || current.minute < backoffUntilRef.current) return;
      const live = pictureWake();
      if (live.triggers.length === 0) return;
      lastPictureCallRef.current = Date.now();
      call(current, mergeWakes(live, wakeReasons(current, optsRef.current.forecasts, memoryRef.current)));
    }, wait);
    return () => window.clearTimeout(timer);
  }, [pictureKeys, enabled, inFlight, call, pictureWake]);

  const decideNow = useCallback(() => {
    const current = optsRef.current.board;
    if (!current || abortRef.current) return;
    backoffUntilRef.current = -Infinity;
    const wake = mergeWakes(wakeReasons(current, optsRef.current.forecasts, memoryRef.current), pictureWake());
    call(current, { triggers: wake.triggers, reasons: [MANUAL_REASON, ...wake.reasons], urgency: "urgent" });
  }, [call, pictureWake]);

  const status: DemoAgent["status"] = inFlight
    ? "thinking"
    : !opts.enabled
      ? "off"
      : !visible
        ? "paused"
        : error
          ? "error"
          : "watching";
  const inputs = inputLog.board === board ? inputLog.list : [];
  const callUrgency: WakeUrgency | null = inFlight ? (queued === "urgent" ? "urgent" : (urgency ?? "urgent")) : null;
  return {
    status,
    urgency: callUrgency,
    queued: inFlight ? queued : null,
    thinking,
    streamText,
    decisions,
    spend,
    error,
    lastWoke,
    inputs,
    lastInput: inputs.length > 0 ? inputs[inputs.length - 1] : null,
    decideNow,
  };
}
