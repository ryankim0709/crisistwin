/**
 * The agent run loop: a simulation clock that advances the dispatch engine minute by minute
 * and stops at each decision point until the agent's orders arrive. Decisions come every
 * DECISION_INTERVAL_MINUTES, or sooner after an urgent alert (never closer together than
 * MIN_DECISION_GAP_MINUTES). The clock is the simulation clock; wall time only sets how fast
 * it is played. Stopping aborts any in-flight decision so a late response cannot apply.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DispatchArea } from "./area";
import { DecisionError, requestDecision } from "./agentClient";
import type { WireOrder } from "./contracts";
import {
  DECISION_INTERVAL_MINUTES,
  DispatchEngine,
  MIN_DECISION_GAP_MINUTES,
  type Alert,
  type IgnitionEvent,
  type OrderOutcome,
} from "./engine";
import type { FireExposure } from "./fireExposure";
import { buildObservation, toEngineOrders, type FrameSummary } from "./observation";

/** Simulated minutes per real second; slow enough to read the streamed reasoning. */
export const DISPATCH_SPEED_CHOICES = [1, 2, 4] as const;
const MAX_LOG_ENTRIES = 60;

export type SessionStatus = "idle" | "running" | "thinking" | "paused" | "failed" | "finished";

export interface DecisionLogEntry {
  id: number;
  minute: number;
  status: "streaming" | "done" | "failed";
  thinking: string;
  text: string;
  summary: string;
  outcomes: OrderOutcome[];
  rejected: { order: unknown; reason: string }[];
  error: string | null;
  model: string | null;
  alerts: Alert[];
}

export interface SessionInputs {
  area: DispatchArea;
  exposure: FireExposure;
  frames: readonly FrameSummary[];
  baselineHomesExposed: number | null;
  horizonMinutes: number;
  ignitions: IgnitionEvent[];
  windFromDegrees: number;
  windSpeedMph: number;
  /**
   * Planner-confirmed live reported closures resolved to area edges (`liveClosures(area,
   * reports).closedEdges`, src/intel/closures.ts). Fixed for the run: changes apply on the next
   * start. Routing never uses these edges; optional.
   */
  closedEdges?: ReadonlySet<number>;
}

export interface DispatchSession {
  engine: DispatchEngine | null;
  status: SessionStatus;
  /** Bumped whenever the engine or log changes, to re-render readers. */
  version: number;
  log: DecisionLogEntry[];
  speed: number;
  setSpeed: (speed: number) => void;
  start: (inputs: SessionInputs) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** After a failed decision: try the same decision again. */
  retry: () => void;
  /** After a failed decision: keep the clock going with no new orders until the next one. */
  skip: () => void;
  /** Exact (fractional) session clock, minutes. */
  getClock: () => number;
}

/**
 * `onTime` receives the continuous session clock every animation frame while it runs (for the
 * fire animation), without a React render.
 */
export function useDispatchSession(onTime?: (minutes: number) => void): DispatchSession {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [version, setVersion] = useState(0);
  const [log, setLog] = useState<DecisionLogEntry[]>([]);
  const [speed, setSpeed] = useState<number>(DISPATCH_SPEED_CHOICES[0]);

  const engineRef = useRef<DispatchEngine | null>(null);
  const inputsRef = useRef<SessionInputs | null>(null);
  const clockRef = useRef(0);
  const nextRegularRef = useRef(0);
  const lastDecisionRef = useRef(-1);
  const previousOutcomesRef = useRef<OrderOutcome[]>([]);
  const previousSummaryRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const entryIdRef = useRef(0);
  const statusRef = useRef<SessionStatus>("idle");
  const onTimeRef = useRef(onTime);
  useLayoutEffect(() => {
    onTimeRef.current = onTime;
  });

  const setSessionStatus = useCallback((next: SessionStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const updateEntry = useCallback(
    (id: number, patch: (entry: DecisionLogEntry) => DecisionLogEntry) => {
      setLog((entries) => entries.map((entry) => (entry.id === id ? patch(entry) : entry)));
    },
    [],
  );

  const decide = useCallback(() => {
    const engine = engineRef.current;
    const inputs = inputsRef.current;
    if (!engine || !inputs) return;
    setSessionStatus("thinking");
    const minute = engine.minute;
    const alerts = engine.alerts.filter((alert) => alert.minute > lastDecisionRef.current);
    const observation = buildObservation({
      engine,
      frames: inputs.frames,
      baselineHomesExposed: inputs.baselineHomesExposed,
      windFromDegrees: inputs.windFromDegrees,
      windSpeedMph: inputs.windSpeedMph,
      ignitions: inputs.ignitions,
      nextRegularDecisionMinute: minute + DECISION_INTERVAL_MINUTES,
      alerts,
      previousOutcomes: previousOutcomesRef.current,
      previousSummary: previousSummaryRef.current,
    });
    const id = ++entryIdRef.current;
    setLog((entries) =>
      [
        {
          id,
          minute,
          status: "streaming" as const,
          thinking: "",
          text: "",
          summary: "",
          outcomes: [],
          rejected: [],
          error: null,
          model: null,
          alerts,
        },
        ...entries,
      ].slice(0, MAX_LOG_ENTRIES),
    );

    const controller = new AbortController();
    abortRef.current = controller;
    requestDecision(
      observation,
      (event) =>
        updateEntry(id, (entry) =>
          event.type === "thinking"
            ? { ...entry, thinking: entry.thinking + event.text }
            : { ...entry, text: entry.text + event.text },
        ),
      controller.signal,
    )
      .then((decision) => {
        if (controller.signal.aborted || engineRef.current !== engine) return;
        const outcomes = engine.applyOrders(toEngineOrders(decision.orders as WireOrder[]));
        previousOutcomesRef.current = outcomes;
        previousSummaryRef.current = decision.summary;
        lastDecisionRef.current = minute;
        nextRegularRef.current = minute + DECISION_INTERVAL_MINUTES;
        updateEntry(id, (entry) => ({
          ...entry,
          status: "done",
          summary: decision.summary,
          outcomes,
          rejected: decision.rejected,
          model: decision.model,
        }));
        bump();
        if (statusRef.current === "thinking") setSessionStatus("running");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || engineRef.current !== engine) return;
        const message =
          cause instanceof DecisionError || cause instanceof Error
            ? cause.message
            : "The agent request failed.";
        updateEntry(id, (entry) => ({ ...entry, status: "failed", error: message }));
        setSessionStatus("failed");
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
      });
  }, [bump, setSessionStatus, updateEntry]);

  /** True when the engine has reached a point where the agent must decide. */
  const decisionDue = useCallback((engine: DispatchEngine): boolean => {
    if (engine.minute >= nextRegularRef.current) return true;
    const sinceLast = engine.minute - lastDecisionRef.current;
    if (lastDecisionRef.current < 0 || sinceLast < MIN_DECISION_GAP_MINUTES) return false;
    return engine.alerts.some((alert) => alert.urgent && alert.minute > lastDecisionRef.current);
  }, []);

  // The clock. Runs only while "running"; a due decision switches to "thinking".
  useEffect(() => {
    if (status !== "running") return;
    let handle = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      const elapsedSeconds = (now - last) / 1000;
      last = now;
      clockRef.current = Math.min(
        engine.horizonMinutes,
        clockRef.current + Math.min(0.1, elapsedSeconds) * speed,
      );
      let stepped = false;
      while (engine.minute < Math.floor(clockRef.current) && !engine.finished) {
        if (decisionDue(engine)) break;
        engine.step();
        stepped = true;
      }
      if (stepped) bump();
      // The fire is drawn at the clock, but never ahead of the engine's held minute.
      onTimeRef.current?.(Math.min(clockRef.current, engine.minute + 1));
      if (engine.finished) {
        setSessionStatus("finished");
        return;
      }
      if (decisionDue(engine)) {
        clockRef.current = engine.minute;
        decide();
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [status, speed, decide, decisionDue, bump, setSessionStatus]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    engineRef.current = null;
    inputsRef.current = null;
    setSessionStatus("idle");
    bump();
  }, [bump, setSessionStatus]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    (inputs: SessionInputs) => {
      abortRef.current?.abort();
      const engine = new DispatchEngine(
        inputs.area,
        inputs.exposure,
        inputs.horizonMinutes,
        inputs.ignitions,
        inputs.closedEdges,
      );
      engineRef.current = engine;
      inputsRef.current = inputs;
      clockRef.current = 0;
      onTimeRef.current?.(0);
      nextRegularRef.current = 0;
      lastDecisionRef.current = -1;
      previousOutcomesRef.current = [];
      previousSummaryRef.current = "";
      setLog([]);
      bump();
      decide();
    },
    [bump, decide],
  );

  const pause = useCallback(() => {
    if (statusRef.current === "running") setSessionStatus("paused");
  }, [setSessionStatus]);
  const resume = useCallback(() => {
    if (statusRef.current === "paused") setSessionStatus("running");
  }, [setSessionStatus]);
  const retry = useCallback(() => {
    if (statusRef.current === "failed") decide();
  }, [decide]);
  const skip = useCallback(() => {
    const engine = engineRef.current;
    if (statusRef.current !== "failed" || !engine) return;
    lastDecisionRef.current = engine.minute;
    nextRegularRef.current = engine.minute + DECISION_INTERVAL_MINUTES;
    previousOutcomesRef.current = [];
    setSessionStatus("running");
  }, [setSessionStatus]);

  return {
    engine: engineRef.current,
    status,
    version,
    log,
    speed,
    setSpeed,
    start,
    pause,
    resume,
    stop,
    retry,
    skip,
    getClock: useCallback(() => clockRef.current, []),
  };
}
