/**
 * The /demo autopilot: watches the board on the simulation clock and calls the AI commander
 * (POST /api/demo/decide) only when the monitor (observation.ts wakeReasons) finds a reason. The
 * board is AI agent only (no automatic dispatch), so a newly reported fire calls it at once.
 * At most one call is in flight; the clock keeps running while it thinks, and its orders apply
 * at the board's minute when they arrive (the page's `apply`, which validates through
 * model.applyOrder). Disabling the autopilot or unmounting aborts the call so a late response
 * cannot apply. After a failed call the monitor waits ERROR_BACKOFF_MINUTES (or decideNow).
 * Monitoring also pauses while the browser tab is hidden, so a forgotten tab does not keep
 * calling Claude; it resumes when the tab is shown again.
 *
 * The live drill's incident picture (incidentPicture.ts) also wakes it, on wall time: a new help
 * request, road-blocked report, real-phone report or confirmation is checked PICTURE_DEBOUNCE_MS
 * after it arrives (bursts are batched) and at most once per PICTURE_MIN_GAP_MS, so phone
 * actions reach the commander within seconds even when the board clock runs slowly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionError, streamNdjson } from "../dispatch/agentClient";
import {
  DECIDE_URL,
  demoUrl,
  isLiveOrder,
  type CommanderOrder,
  type DecisionEvent,
  type DemoObservation,
  type DemoOrder,
  type LiveOrder,
} from "./contracts";
import type { Board, RouteOption, ZoneForecast } from "./model";
import { pictureWakeReasons, type PictureKeys, type PictureResult } from "./incidentPicture";
import {
  MONITOR_EVERY_MINUTES,
  buildObservation,
  newReportedFireIds,
  rememberDecision,
  wakeReasons,
  type MonitorMemory,
} from "./observation";

/** Simulated minutes the monitor stays quiet after a failed call. */
export const ERROR_BACKOFF_MINUTES = 10;
const MAX_DECISIONS = 30;
const MANUAL_REASON = "Operator asked for a decision now.";
/** Wall ms between a new picture item and the check that may call the agent (batches bursts). */
export const PICTURE_DEBOUNCE_MS = 2_000;
/** Wall ms between two picture-triggered calls (bounds Claude calls while phones are busy). */
export const PICTURE_MIN_GAP_MS = 15_000;

type FinalDecision = Extract<DecisionEvent, { type: "orders" }>;

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
}

export interface DemoAgent {
  /** paused: monitoring is on but the tab is hidden. */
  status: "off" | "paused" | "watching" | "thinking" | "error";
  /** Live streamed thinking summary for the current call (cleared per call). */
  thinking: string;
  /** Live streamed assessment text for the current call. */
  streamText: string;
  /** Newest first, last MAX_DECISIONS. */
  decisions: AgentDecision[];
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

  // Latest options for callbacks that run outside render (stream events, the monitor).
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const abortRef = useRef<AbortController | null>(null);
  const boardRef = useRef<Board | null>(null);
  const memoryRef = useRef<MonitorMemory | null>(null);
  const previousRef = useRef<DemoObservation["previous"]>(null);
  const lastBucketRef = useRef<number | null>(null);
  const backoffUntilRef = useRef(-Infinity);
  /** Reported fires already sent to the agent in an observation (each new fire triggers at most one immediate call). */
  const calledFireIdsRef = useRef(new Set<string>());
  const idRef = useRef(0);
  /** Picture items the agent has seen (at its last decision, or when monitoring started). */
  const seenPictureRef = useRef<PictureKeys | null>(null);
  const lastPictureCallRef = useRef(-Infinity);

  // Aborting rejects the stream; its `finally` then clears the in-flight state.
  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const call = useCallback((current: Board, reasons: string[]) => {
    if (abortRef.current) return;
    const { routes, forecasts, picture } = optsRef.current;
    const observation = buildObservation(current, routes, forecasts, reasons, previousRef.current, picture?.picture ?? null);
    const seenPicture = picture?.keys ?? null;
    for (const f of observation.fires) calledFireIdsRef.current.add(f.id);
    const seen = rememberDecision(current, forecasts);
    const minute = observation.clock.minute;
    const controller = new AbortController();
    abortRef.current = controller;
    setInFlight(true);
    setThinking("");
    setStreamText("");
    setLastWoke(reasons);
    let assessment = "";

    streamNdjson<FinalDecision>(
      demoUrl(DECIDE_URL, optsRef.current.incidentId),
      { observation },
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
        if (controller.signal.aborted || boardRef.current !== current) return;
        const board = decision.orders.filter((o): o is DemoOrder => !isLiveOrder(o));
        const live = decision.orders.filter(isLiveOrder);
        const boardErrors = optsRef.current.apply(board);
        const liveErrors = optsRef.current.applyLive?.(live) ?? live.map(() => "No live drill.");
        const applied = [
          ...board.map((order, i) => ({ order: order as CommanderOrder, error: boardErrors[i] ?? null })),
          ...live.map((order, i) => ({ order: order as CommanderOrder, error: liveErrors[i] ?? null })),
        ];
        memoryRef.current = seen;
        if (seenPicture) seenPictureRef.current = seenPicture;
        previousRef.current = {
          minute,
          summary: decision.summary,
          rejected: [
            ...decision.rejected.map((r) => r.reason),
            ...applied.filter((a) => a.error !== null).map((a) => `Not applied: ${a.error}`),
          ],
        };
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
        if (controller.signal.aborted || boardRef.current !== current) return;
        backoffUntilRef.current = current.minute + ERROR_BACKOFF_MINUTES;
        setError(
          cause instanceof DecisionError || cause instanceof Error ? cause.message : "The agent request failed.",
        );
      })
      .finally(() => {
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        setInFlight(false);
      });
  }, []);

  // A new board is a new run: forget the old one and drop any call made on it.
  useEffect(() => {
    if (boardRef.current === board) return;
    boardRef.current = board;
    cancel();
    memoryRef.current = null;
    previousRef.current = null;
    lastBucketRef.current = null;
    backoffUntilRef.current = -Infinity;
    seenPictureRef.current = null;
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

  const pictureReasons = useCallback(() => {
    const p = optsRef.current.picture;
    return pictureWakeReasons(p?.keys ?? null, seenPictureRef.current, p?.picture ?? null);
  }, []);

  // The monitor: once per MONITOR_EVERY_MINUTES of simulated time, while idle. A newly reported
  // fire the agent has not been shown yet is checked at once (on the board's next change, also
  // inside an error backoff): nothing dispatches initial attack on this board but the agent.
  useEffect(() => {
    if (!enabled || !board || abortRef.current) return;
    const urgent = newReportedFireIds(board, memoryRef.current).some((id) => !calledFireIdsRef.current.has(id));
    const bucket = Math.floor(board.minute / MONITOR_EVERY_MINUTES);
    if (bucket === lastBucketRef.current && !urgent) return;
    lastBucketRef.current = bucket;
    if (board.minute < backoffUntilRef.current && !urgent) return;
    const reasons = [...wakeReasons(board, optsRef.current.forecasts, memoryRef.current), ...pictureReasons()];
    if (reasons.length > 0) call(board, reasons);
  }, [board, version, enabled, call, pictureReasons]);

  // The picture monitor (wall time): new live items wake the agent within seconds.
  const pictureKeys = opts.picture?.keys ?? null;
  useEffect(() => {
    if (!enabled || !pictureKeys) return;
    // The backlog present when monitoring starts is in the first observation, not a wake reason.
    if (!seenPictureRef.current) {
      seenPictureRef.current = pictureKeys;
      return;
    }
    if (pictureReasons().length === 0) return;
    const wait = Math.max(PICTURE_DEBOUNCE_MS, lastPictureCallRef.current + PICTURE_MIN_GAP_MS - Date.now());
    const timer = window.setTimeout(() => {
      const current = optsRef.current.board;
      if (!current || abortRef.current || current.minute < backoffUntilRef.current) return;
      const reasons = pictureReasons();
      if (reasons.length === 0) return;
      lastPictureCallRef.current = Date.now();
      call(current, [...reasons, ...wakeReasons(current, optsRef.current.forecasts, memoryRef.current)]);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [pictureKeys, enabled, inFlight, call, pictureReasons]);

  const decideNow = useCallback(() => {
    const current = optsRef.current.board;
    if (!current || abortRef.current) return;
    backoffUntilRef.current = -Infinity;
    const reasons = [...wakeReasons(current, optsRef.current.forecasts, memoryRef.current), ...pictureReasons()];
    call(current, [MANUAL_REASON, ...reasons]);
  }, [call, pictureReasons]);

  const status: DemoAgent["status"] = inFlight
    ? "thinking"
    : !opts.enabled
      ? "off"
      : !visible
        ? "paused"
        : error
          ? "error"
          : "watching";
  return { status, thinking, streamText, decisions, error, lastWoke, decideNow };
}
