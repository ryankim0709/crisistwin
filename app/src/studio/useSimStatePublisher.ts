/**
 * Publishes Studio's evacuation run to the backend for the resident app (docs/sim-state-api.md):
 * the run once per (area, inputs), then the zones' advice at the playback minute, at most one
 * tick per TICK_INTERVAL_MS, with only the zones that changed (all of them on the first tick).
 * Own `EvacuationPlayer`, so publishing does not depend on the drawn overlay. One request at a
 * time; a change of inputs abandons the old run and any request still in flight.
 */

import { useEffect, useRef, useState } from "react";
import { EvacuationPlayer, simulateEvacuation, type EvacuationInputs } from "./evacuation";
import {
  diffTick,
  homeAddresses,
  runPayload,
  zoneTick,
  type SimTickZone,
  type ZoneSchedule,
} from "./simState";

export const SIM_STATE_RUNS_URL = "/api/sim-state/runs";
export const TICK_INTERVAL_MS = 1000;

export type SimStatePublishStatus =
  | { state: "idle" }
  | { state: "publishing" }
  | { state: "live"; runId: string; minute: number | null }
  | { state: "error"; message: string };

async function post(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body: report the status.
  }
  if (!response.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${response.status}`);
  }
  return data;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Request failed.";
}

interface LiveRun {
  id: string;
  player: EvacuationPlayer;
  schedule: ZoneSchedule;
  cutOff: ReadonlySet<number>;
  sent: SimTickZone[] | null;
  lastMinute: number | null;
}

/** `inputs` null (no run yet) or `enabled` false leaves nothing published. */
export function useSimStatePublisher(
  enabled: boolean,
  inputs: EvacuationInputs | null,
  minute: number,
  label: string,
): SimStatePublishStatus {
  const [status, setStatus] = useState<SimStatePublishStatus>({ state: "idle" });
  const [live, setLive] = useState<LiveRun | null>(null);
  const minuteRef = useRef(minute);
  minuteRef.current = minute;
  const labelRef = useRef(label);
  labelRef.current = label;

  // Publish the run.
  useEffect(() => {
    setLive(null);
    if (!enabled || !inputs) {
      setStatus({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setStatus({ state: "publishing" });
    // Deferred a frame so the "publishing" state shows before the full-run simulation blocks.
    const handle = window.setTimeout(() => {
      try {
        const summary = simulateEvacuation(inputs);
        const player = new EvacuationPlayer(inputs);
        const body = runPayload(inputs.area, inputs, homeAddresses(inputs.area), labelRef.current);
        post(SIM_STATE_RUNS_URL, body, controller.signal)
          .then((data) => {
            const id = (data as { run_id?: unknown } | null)?.run_id;
            if (typeof id !== "string") throw new Error("The server returned no run id.");
            if (controller.signal.aborted) return;
            setLive({
              id,
              player,
              schedule: summary,
              cutOff: new Set(summary.cutOffZoneIndices),
              sent: null,
              lastMinute: null,
            });
            setStatus({ state: "live", runId: id, minute: null });
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted) setStatus({ state: "error", message: message(cause) });
          });
      } catch (cause) {
        setStatus({ state: "error", message: message(cause) });
      }
    }, 0);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [enabled, inputs]);

  // Tick as playback moves.
  useEffect(() => {
    if (!live) return;
    const run = live;
    const controller = new AbortController();
    let timer: number | null = null;
    let inFlight = false;
    let lastSentAt = 0;
    const send = () => {
      timer = null;
      const target = Math.floor(minuteRef.current);
      if (inFlight || (run.sent !== null && target === run.lastMinute)) return;
      run.player.syncTo(target);
      const tick = zoneTick(run.player.inputs.area, run.player.engine, run.cutOff, run.schedule);
      const zones = diffTick(run.sent, tick.zones);
      inFlight = true;
      lastSentAt = Date.now();
      post(
        `${SIM_STATE_RUNS_URL}/${encodeURIComponent(run.id)}/tick`,
        { minute: tick.minute, zones },
        controller.signal,
      )
        .then(() => {
          run.sent = tick.zones;
          run.lastMinute = tick.minute;
          setStatus({ state: "live", runId: run.id, minute: tick.minute });
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setStatus({ state: "error", message: message(cause) });
        })
        .finally(() => {
          inFlight = false;
          if (!controller.signal.aborted) schedule();
        });
    };
    const schedule = () => {
      if (timer !== null || inFlight) return;
      if (run.sent !== null && Math.floor(minuteRef.current) === run.lastMinute) return;
      timer = window.setTimeout(send, Math.max(0, TICK_INTERVAL_MS - (Date.now() - lastSentAt)));
    };
    schedule();
    const poll = window.setInterval(schedule, 250);
    return () => {
      controller.abort();
      window.clearInterval(poll);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [live]);

  return status;
}
