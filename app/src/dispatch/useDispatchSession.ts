/**
 * The live agent loop: a simulation clock that advances the dispatch engine minute by minute
 * while a deterministic monitor (monitor.ts) checks the situation every `checkInterval`
 * simulated minutes, or sooner after an urgent alert (never closer than
 * MIN_DECISION_GAP_MINUTES to the last decision). A quiet check costs nothing and the clock
 * keeps running; a check that finds a material change, or MAX_QUIET_MINUTES without a
 * decision, stops the clock and calls the agent with the reasons. The clock is the simulation
 * clock; wall time only sets how fast it is played. Stopping aborts any in-flight decision so a
 * late response cannot apply.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DispatchArea } from "./area";
import { DecisionError, requestDecision } from "./agentClient";
import type { WireOrder } from "./contracts";
import {
  DEFAULT_CHECK_INTERVAL_MINUTES,
  DispatchEngine,
  MIN_DECISION_GAP_MINUTES,
  type Alert,
  type IgnitionEvent,
  type OrderOutcome,
} from "./engine";
import type { FireExposure } from "./fireExposure";
import { detectChanges, takeBaseline, type MonitorBaseline } from "./monitor";
import { buildObservation, toEngineOrders, type FrameSummary } from "./observation";

/** Simulated minutes per real second; slow enough to read the streamed reasoning. */
export const DISPATCH_SPEED_CHOICES = [1, 2, 4] as const;
const MAX_LOG_ENTRIES = 60;
const MAX_CHECKS = 240;
const SQUARE_METERS_PER_HECTARE = 10_000;
const FIRST_LOOK = "Shift start: first look at the situation.";

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
  /** What the monitor found that woke the agent. */
  reasons: string[];
}

/** One live-monitor check. Quiet checks did not call the agent. */
export interface MonitorCheck {
  id: number;
  minute: number;
  reasons: string[];
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
}

export interface DispatchSession {
  engine: DispatchEngine | null;
  status: SessionStatus;
  /** Bumped whenever the engine or log changes, to re-render readers. */
  version: number;
  log: DecisionLogEntry[];
  /** Live-monitor checks, newest first. */
  checks: MonitorCheck[];
  /** Simulated minutes between monitor checks. */
  checkInterval: number;
  setCheckInterval: (minutes: number) => void;
  /** Minute of the next scheduled check, or null when no run is active. */
  nextCheckMinute: number | null;
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
  const [checks, setChecks] = useState<MonitorCheck[]>([]);
  const [speed, setSpeed] = useState<number>(DISPATCH_SPEED_CHOICES[0]);
  const [checkInterval, setCheckIntervalState] = useState<number>(DEFAULT_CHECK_INTERVAL_MINUTES);
  const checkIntervalRef = useRef(checkInterval);
  const setCheckInterval = useCallback((minutes: number) => {
    checkIntervalRef.current = minutes;
    setCheckIntervalState(minutes);
  }, []);

  const engineRef = useRef<DispatchEngine | null>(null);
  const inputsRef = useRef<SessionInputs | null>(null);
  const clockRef = useRef(0);
  const lastCheckRef = useRef(0);
  const lastDecisionRef = useRef(-1);
  const baselineRef = useRef<MonitorBaseline | null>(null);
  const pendingReasonsRef = useRef<string[]>([]);
  const checkIdRef = useRef(0);
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

  const burnedHectaresAt = useCallback((minute: number): number => {
    const frames = inputsRef.current?.frames ?? [];
    const frame = [...frames].reverse().find((f) => f.elapsedMinutes <= minute);
    return (frame?.burnedAreaSquareMeters ?? 0) / SQUARE_METERS_PER_HECTARE;
  }, []);

  const decide = useCallback(
    (reasons: string[]) => {
      const engine = engineRef.current;
      const inputs = inputsRef.current;
      if (!engine || !inputs) return;
      setSessionStatus("thinking");
      pendingReasonsRef.current = reasons;
      const minute = engine.minute;
      const alerts = engine.alerts.filter((alert) => alert.minute > lastDecisionRef.current);
      const observation = buildObservation({
        engine,
        frames: inputs.frames,
        baselineHomesExposed: inputs.baselineHomesExposed,
        windFromDegrees: inputs.windFromDegrees,
        windSpeedMph: inputs.windSpeedMph,
        ignitions: inputs.ignitions,
        nextCheckMinute: minute + checkIntervalRef.current,
        checkIntervalMinutes: checkIntervalRef.current,
        previousDecisionMinute: lastDecisionRef.current < 0 ? null : lastDecisionRef.current,
        wokeBecause: reasons,
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
            reasons,
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
          lastCheckRef.current = minute;
          // Compare later checks against the situation with these orders in effect.
          baselineRef.current = takeBaseline(engine, burnedHectaresAt(minute));
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
    },
    [bump, burnedHectaresAt, setSessionStatus, updateEntry],
  );

  /** True when the monitor should look at the engine now. */
  const checkDue = useCallback((engine: DispatchEngine): boolean => {
    if (engine.minute - lastCheckRef.current >= checkIntervalRef.current) return true;
    if (engine.minute - lastDecisionRef.current < MIN_DECISION_GAP_MINUTES) return false;
    return engine.alerts.some((alert) => alert.urgent && alert.minute > lastCheckRef.current);
  }, []);

  /** Run one monitor check; returns the reasons to wake the agent (empty when quiet). */
  const check = useCallback(
    (engine: DispatchEngine): string[] => {
      const baseline = baselineRef.current;
      lastCheckRef.current = engine.minute;
      if (!baseline) return [FIRST_LOOK];
      const reasons = detectChanges(
        engine,
        baseline,
        burnedHectaresAt(engine.minute),
        engine.alerts.filter((alert) => alert.minute > baseline.minute),
      );
      const entry: MonitorCheck = { id: ++checkIdRef.current, minute: engine.minute, reasons };
      setChecks((list) => [entry, ...list].slice(0, MAX_CHECKS));
      return reasons;
    },
    [burnedHectaresAt],
  );

  // The clock. Runs only while "running"; a check that finds a change switches to "thinking".
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
      let wake: string[] = [];
      while (engine.minute < Math.floor(clockRef.current) && !engine.finished) {
        engine.step();
        stepped = true;
        if (checkDue(engine)) {
          wake = check(engine);
          if (wake.length > 0) break;
        }
      }
      if (stepped) bump();
      // The fire is drawn at the clock, but never ahead of the engine's held minute.
      onTimeRef.current?.(Math.min(clockRef.current, engine.minute + 1));
      if (wake.length > 0) {
        clockRef.current = engine.minute;
        onTimeRef.current?.(engine.minute);
        decide(wake);
        return;
      }
      if (engine.finished) {
        setSessionStatus("finished");
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [status, speed, decide, check, checkDue, bump, setSessionStatus]);

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
      );
      engineRef.current = engine;
      inputsRef.current = inputs;
      clockRef.current = 0;
      onTimeRef.current?.(0);
      lastCheckRef.current = 0;
      lastDecisionRef.current = -1;
      baselineRef.current = null;
      previousOutcomesRef.current = [];
      previousSummaryRef.current = "";
      setLog([]);
      setChecks([]);
      bump();
      decide([FIRST_LOOK]);
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
    if (statusRef.current === "failed") decide(pendingReasonsRef.current);
  }, [decide]);
  const skip = useCallback(() => {
    const engine = engineRef.current;
    if (statusRef.current !== "failed" || !engine) return;
    lastDecisionRef.current = engine.minute;
    lastCheckRef.current = engine.minute;
    baselineRef.current = takeBaseline(engine, burnedHectaresAt(engine.minute));
    previousOutcomesRef.current = [];
    setSessionStatus("running");
  }, [burnedHectaresAt, setSessionStatus]);

  return {
    engine: engineRef.current,
    status,
    version,
    log,
    checks,
    checkInterval,
    setCheckInterval,
    nextCheckMinute:
      status === "idle"
        ? null
        : Math.max(checks[0]?.minute ?? 0, log[0]?.minute ?? 0) + checkInterval,
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
