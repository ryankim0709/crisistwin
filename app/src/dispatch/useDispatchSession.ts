/**
 * The live agent loop: a simulation clock that advances the dispatch engine minute by minute
 * while a deterministic monitor (monitor.ts) checks the situation every `checkInterval`
 * simulated minutes, or sooner after an urgent alert (never closer than
 * MIN_DECISION_GAP_MINUTES to the last decision). A quiet check costs nothing; a check that
 * finds a material change, or MAX_QUIET_MINUTES without a decision, calls the agent with the
 * reasons.
 *
 * Like a real dispatch centre the clock does not stop for the agent: fire, traffic and engines
 * keep moving while it thinks, at the playback speed, so its thinking time costs simulated
 * time. It decides on the situation it was shown (minute m0); its orders take effect when the
 * answer arrives (minute m1), from wherever everything is then. Right after they apply the
 * monitor checks again against what the agent saw, so a change during its thinking wakes it
 * again. The what-if options it is shown already assume its orders land after its expected
 * thinking delay. Stopping aborts any in-flight decision so a late response cannot apply.
 * See docs/adr/0026-live-dispatch-clock.md.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DispatchArea } from "./area";
import { DecisionError, reportOutcome, requestDecision } from "./agentClient";
import type { WireOrder } from "./contracts";
import {
  DEFAULT_CHECK_INTERVAL_MINUTES,
  DispatchEngine,
  MIN_DECISION_GAP_MINUTES,
  type Alert,
  type IgnitionEvent,
  type OrderOutcome,
} from "./engine";
import type { FireAreaFrame, FireTarget } from "./fireAttack";
import type { FireExposure } from "./fireExposure";
import { detectChanges, takeBaseline, type MonitorBaseline } from "./monitor";
import { buildObservation, toEngineOrders, type FrameSummary } from "./observation";
import {
  evaluateTacticOptions,
  refreshFire as refreshTacticFire,
  type SolvedFire,
  type TacticSolver,
} from "./tacticOptions";

/**
 * Simulated minutes per real second: real time (1x), 10x, 30x and 60x. The agent's thinking
 * time is charged at this rate, so at 30x a 20 s decision costs 10 simulated minutes.
 */
export const DISPATCH_SPEED_CHOICES = [1 / 60, 1 / 6, 1 / 2, 1] as const;
export const DEFAULT_DISPATCH_SPEED = 1 / 2;

export function speedLabel(minutesPerSecond: number): string {
  const ratio = Math.round(minutesPerSecond * 60);
  return ratio === 1 ? "Real time" : `${ratio}×`;
}

/** Before the first answer, assume a decision takes this long in real time. */
const ASSUMED_DECISION_SECONDS = 15;
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
  /** Minute the orders took effect (the clock kept running while the agent thought). */
  appliedMinute: number | null;
  /** Earlier runs on these roads the agent was shown from the run journal. */
  recalledRuns: number;
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
  /** Fires engines can attack, and their burned area per frame. */
  fireTargets: readonly FireTarget[];
  fireFrames: readonly FireAreaFrame[];
  /**
   * Re-solves the fire with fires put out and control lines built (tacticOptions.ts), for the
   * live fire and for the what-if options the agent is shown.
   */
  solver: TacticSolver;
  /** Show a re-solved fire as the live one (the 3D view and playback). */
  showFire: (solved: SolvedFire) => void;
  /** Burned hectares and homes reached by the horizon with no fire fighting. */
  initialOutcome: { burnedHectares: number; homesReached: number };
  baselineHomesExposed: number | null;
  horizonMinutes: number;
  ignitions: IgnitionEvent[];
  windFromDegrees: number;
  windSpeedMph: number;
  /**
   * Roads closed from T+0: the planner's own closures, or planner-confirmed reported closures
   * resolved to area edges (src/intel/closures.ts). Routing never uses these edges; optional.
   * `setRoadClosed` changes them during the run.
   */
  closedEdges?: ReadonlySet<number>;
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
  /**
   * Close or reopen a road in the running session (docs/adr/0030-live-road-closures.md). The
   * monitor checks at once and wakes the agent; false when there is no session or nothing
   * changed.
   */
  setRoadClosed: (edge: number, closed: boolean) => boolean;
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
  const [speed, setSpeed] = useState<number>(DEFAULT_DISPATCH_SPEED);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  /** Simulated minutes the last decision took to come back (null before the first). */
  const decisionDelayRef = useRef<number | null>(null);
  /** Check the monitor as soon as the clock runs again (right after orders apply). */
  const recheckRef = useRef(false);
  const [checkInterval, setCheckIntervalState] = useState<number>(DEFAULT_CHECK_INTERVAL_MINUTES);
  const checkIntervalRef = useRef(checkInterval);
  const setCheckInterval = useCallback((minutes: number) => {
    checkIntervalRef.current = minutes;
    setCheckIntervalState(minutes);
  }, []);

  const engineRef = useRef<DispatchEngine | null>(null);
  const inputsRef = useRef<SessionInputs | null>(null);
  /** Burned hectares and homes reached by the horizon with the fire fighting in effect. */
  const outcomeRef = useRef({ burnedHectares: 0, homesReached: 0 });
  const clockRef = useRef(0);
  const lastCheckRef = useRef(0);
  const lastDecisionRef = useRef(-1);
  const baselineRef = useRef<MonitorBaseline | null>(null);
  const pendingReasonsRef = useRef<string[]>([]);
  const checkIdRef = useRef(0);
  const previousOutcomesRef = useRef<OrderOutcome[]>([]);
  const previousSummaryRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  /** Run journal id (dispatch_runs.py); a decision must land before an outcome is sent. */
  const sessionIdRef = useRef<string | null>(null);
  const journalledRef = useRef(false);
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

  /**
   * After engines put a fire out, or crews joined or left a line: re-plan the lines, re-solve
   * the fire and swap it into the engine and the view.
   */
  const refreshFire = useCallback((engine: DispatchEngine) => {
    const inputs = inputsRef.current;
    if (!inputs) return;
    const solved = refreshTacticFire(engine, inputs.solver);
    inputs.showFire(solved);
    outcomeRef.current = {
      burnedHectares: solved.burnedHectares,
      homesReached: solved.homesReached,
    };
    inputsRef.current = { ...inputs, exposure: solved.exposure, frames: solved.frames };
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
      // What the agent sees; later checks compare against it, not against the moment its
      // answer happened to arrive.
      const seen = takeBaseline(engine, burnedHectaresAt(minute));
      const expectedDelay = decisionDelayRef.current ?? ASSUMED_DECISION_SECONDS * speedRef.current;
      const observation = buildObservation({
        engine,
        decisionDelayMinutes: expectedDelay,
        tacticOptions: evaluateTacticOptions(engine, inputs.solver, expectedDelay),
        currentOutcome: outcomeRef.current,
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
            appliedMinute: null,
            recalledRuns: 0,
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
        sessionIdRef.current ?? undefined,
      )
        .then((decision) => {
          if (controller.signal.aborted || engineRef.current !== engine) return;
          // The clock kept running: the orders apply now, at the engine's current minute.
          const appliedMinute = engine.minute;
          const outcomes = engine.applyOrders(toEngineOrders(decision.orders as WireOrder[]));
          if (engine.linesDirty) refreshFire(engine);
          decisionDelayRef.current = Math.max(1, appliedMinute - minute);
          previousOutcomesRef.current = outcomes;
          previousSummaryRef.current = decision.summary;
          lastDecisionRef.current = minute;
          lastCheckRef.current = appliedMinute;
          baselineRef.current = seen;
          // Anything that changed while it was thinking can wake it again straight away.
          recheckRef.current = recheckRef.current || appliedMinute > minute;
          updateEntry(id, (entry) => ({
            ...entry,
            appliedMinute,
            status: "done",
            summary: decision.summary,
            outcomes,
            rejected: decision.rejected,
            model: decision.model,
            recalledRuns: decision.recalled_runs ?? 0,
          }));
          journalledRef.current = true;
          bump();
          if (statusRef.current === "thinking")
            setSessionStatus(engine.finished ? "finished" : "running");
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
    [bump, burnedHectaresAt, refreshFire, setSessionStatus, updateEntry],
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

  // The clock. Runs while "running" and while the agent is "thinking" (it does not wait for
  // the agent); the monitor only checks while running, and a change it finds starts a decision.
  useEffect(() => {
    if (status !== "running" && status !== "thinking") return;
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
      const monitoring = statusRef.current === "running";
      if (monitoring && recheckRef.current) {
        recheckRef.current = false;
        wake = check(engine);
      }
      while (
        wake.length === 0 &&
        engine.minute < Math.floor(clockRef.current) &&
        !engine.finished
      ) {
        const out = engine.fires.filter((fire) => fire.outMinute !== null).length;
        engine.step();
        stepped = true;
        if (
          engine.fires.filter((fire) => fire.outMinute !== null).length > out ||
          engine.linesDirty
        ) {
          refreshFire(engine);
        }
        if (monitoring && checkDue(engine)) {
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
        // While thinking, the answer still arrives and is applied; then the session finishes.
        if (statusRef.current === "running") setSessionStatus("finished");
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [status, speed, decide, check, checkDue, refreshFire, bump, setSessionStatus]);

  /** Send the run's outcome to the journal once, when it finishes or is stopped. */
  const journalOutcome = useCallback((finished: boolean) => {
    const engine = engineRef.current;
    const inputs = inputsRef.current;
    const sessionId = sessionIdRef.current;
    if (!engine || !inputs || !sessionId || !journalledRef.current) return;
    sessionIdRef.current = null;
    const totals = engine.totals();
    reportOutcome(sessionId, {
      area_id: inputs.area.id,
      minute: engine.minute,
      horizon_minutes: engine.horizonMinutes,
      finished,
      totals: {
        homes: totals.homes,
        not_ordered: totals.notOrdered,
        waiting: totals.waiting,
        en_route: totals.onRoad,
        out: totals.safe,
        exposed: totals.caught,
      },
      no_action_exposed: inputs.baselineHomesExposed,
    });
  }, []);
  useEffect(() => {
    if (status === "finished") journalOutcome(true);
  }, [status, journalOutcome]);

  const stop = useCallback(() => {
    journalOutcome(false);
    abortRef.current?.abort();
    abortRef.current = null;
    engineRef.current = null;
    inputsRef.current = null;
    setSessionStatus("idle");
    bump();
  }, [bump, journalOutcome, setSessionStatus]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    (inputs: SessionInputs) => {
      journalOutcome(false);
      abortRef.current?.abort();
      sessionIdRef.current = crypto.randomUUID();
      journalledRef.current = false;
      const engine = new DispatchEngine(
        inputs.area,
        inputs.exposure,
        inputs.horizonMinutes,
        inputs.ignitions,
        inputs.closedEdges,
      );
      engine.restrictToFirePath = true;
      engine.setFires(inputs.fireTargets, inputs.fireFrames);
      engineRef.current = engine;
      inputsRef.current = inputs;
      outcomeRef.current = inputs.initialOutcome;
      clockRef.current = 0;
      onTimeRef.current?.(0);
      lastCheckRef.current = 0;
      lastDecisionRef.current = -1;
      decisionDelayRef.current = null;
      recheckRef.current = false;
      baselineRef.current = null;
      previousOutcomesRef.current = [];
      previousSummaryRef.current = "";
      setLog([]);
      setChecks([]);
      bump();
      decide([FIRST_LOOK]);
    },
    [bump, decide, journalOutcome],
  );

  const pause = useCallback(() => {
    if (statusRef.current === "running") setSessionStatus("paused");
  }, [setSessionStatus]);
  const resume = useCallback(() => {
    if (statusRef.current === "paused") setSessionStatus("running");
  }, [setSessionStatus]);
  const setRoadClosed = useCallback(
    (edge: number, closed: boolean): boolean => {
      const engine = engineRef.current;
      if (!engine || !engine.setRoadClosed(edge, closed)) return false;
      // While running, look now; while thinking, the check after the answer compares the
      // closures against what the agent saw, so the change still wakes it.
      recheckRef.current = true;
      bump();
      return true;
    },
    [bump],
  );
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
    setRoadClosed,
  };
}
