import { useEffect, useState } from "react";
import { fetchTwin } from "./api";
import type { TwinMonitor, TwinTotals } from "./types";
import { usePoll, type PollState } from "./usePoll";

const POLL_MS = 5_000;
const MAX_POINTS = 1_500;
const STORE_KEY = "crisistwin.live.twinSeries";

export type SeriesKey = "not_departed_veh" | "en_route_veh" | "arrived_veh" | "blocked_veh" | "exposed_veh";
export interface SeriesPoint {
  atMs: number;
  values: Record<SeriesKey, number>;
}
interface Series {
  /** Identifies one twin session: a rebuild (reset, earlier start) starts a new series. */
  session: string;
  points: SeriesPoint[];
}

const KEYS: SeriesKey[] = ["not_departed_veh", "en_route_veh", "arrived_veh", "blocked_veh", "exposed_veh"];
const pick = (t: TwinTotals) => Object.fromEntries(KEYS.map((k) => [k, t[k]])) as Record<SeriesKey, number>;
const sessionOf = (twin: TwinMonitor) => `${twin.built_from}|${twin.model.inputs_fingerprint}`;

function load(): Series | null {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Series) : null;
    return parsed && typeof parsed.session === "string" && Array.isArray(parsed.points) ? parsed : null;
  } catch {
    return null;
  }
}

function save(series: Series): void {
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(series));
  } catch {
    // Storage blocked or full: the series still lives for this page view.
  }
}

/** Appends a polled snapshot; a clock that moves back or a new session starts over. */
function extend(prev: Series | null, twin: TwinMonitor): Series {
  const session = sessionOf(twin);
  const atMs = new Date(twin.clock.now).getTime();
  const point = { atMs, values: pick(twin.totals) };
  if (!prev || prev.session !== session) return { session, points: [point] };
  const last = prev.points[prev.points.length - 1];
  if (last && atMs < last.atMs) return { session, points: [point] };
  if (last && atMs === last.atMs) return prev;
  return { session, points: [...prev.points, point].slice(-MAX_POINTS) };
}

/**
 * Polls the traffic twin's monitor and keeps the totals it has seen as a time series. The twin
 * keeps no history in the live drill, so the series starts when this browser session first saw
 * it (kept in sessionStorage across reloads).
 */
export function useTwin(token: string | null): PollState<TwinMonitor> & { series: SeriesPoint[] } {
  const poll = usePoll(token, fetchTwin, POLL_MS, "Traffic twin");
  const [series, setSeries] = useState<Series | null>(() => load());
  const data = poll.data;
  useEffect(() => {
    if (!data) return;
    setSeries((prev) => {
      const next = extend(prev, data);
      if (next !== prev) save(next);
      return next;
    });
  }, [data]);
  const points = data && series?.session === sessionOf(data) ? series.points : [];
  return { ...poll, series: points };
}
