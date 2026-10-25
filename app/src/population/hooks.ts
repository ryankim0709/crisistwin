/**
 * Hooks of the shared population module: the snapshot households of a dispatch area, and an
 * engine player stepped to a playback clock.
 */

import { useEffect, useState } from "react";
import type { DispatchArea } from "../dispatch/area";
import { loadHouseholds, matchHouseholds, type ZoneHouseholds } from "./households";

export interface AreaHouseholds {
  status: "idle" | "loading" | "ready";
  /** Snapshot people per zone, or null when no snapshot covers the area (synthetic estimate). */
  zones: ZoneHouseholds | null;
}

/**
 * Scenario-snapshot households for `area` (GET /api/dispatch/households), matched to its zones.
 * Falls back to null zones (the synthetic estimate) when no snapshot covers it or the service
 * is unavailable.
 */
export function useZoneHouseholds(area: DispatchArea | null): AreaHouseholds {
  const [state, setState] = useState<{ area: DispatchArea; result: AreaHouseholds } | null>(null);
  useEffect(() => {
    if (!area) return;
    const controller = new AbortController();
    loadHouseholds(area.bbox, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ area, result: { status: "ready", zones: matchHouseholds(area, data) } });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ area, result: { status: "ready", zones: null } });
      });
    return () => controller.abort();
  }, [area]);
  if (!area) return { status: "idle", zones: null };
  return state?.area === area ? state.result : { status: "loading", zones: null };
}

/** Fewest wall milliseconds between two pictures while the clock runs. */
const MIN_REFRESH_MS = 180;

/**
 * Steps `player` to the whole minute of `clockRef` every animation frame (at most every
 * MIN_REFRESH_MS) and returns a counter bumped after each step, for PopulationView's `version`.
 */
export function useClockSteppedPlayer(
  player: { syncTo(minute: number): void } | null,
  clockRef: { readonly current: number },
): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!player) return;
    let handle = 0;
    let drawnMinute = Number.NaN;
    let lastWall = -Infinity;
    const tick = (now: number) => {
      handle = requestAnimationFrame(tick);
      const minute = Math.floor(clockRef.current);
      if (minute === drawnMinute || now - lastWall < MIN_REFRESH_MS) return;
      drawnMinute = minute;
      lastWall = now;
      player.syncTo(minute);
      setVersion((v) => v + 1);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [player, clockRef]);
  return version;
}
