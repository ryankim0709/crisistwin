// Simulated household picture on the live map: every house of the scenario snapshot with its status
// in the current board run (docs/live-reports.md, "Household state"). Every value is simulated: the
// houses are stand-ins from the scenario snapshot and which house carries which status is an
// allocation of the zone's simulated counts, not a record of a real household.
import { useEffect, useState } from "react";
import { LiveError, request } from "./api";

export type HouseholdStatus =
  | "home"
  | "waiting"
  | "evacuating"
  | "safe"
  | "needs_transport"
  | "not_leaving"
  | "caught"
  | "unknown";

export const HOUSEHOLD_STATUSES: HouseholdStatus[] = [
  "safe",
  "evacuating",
  "waiting",
  "home",
  "needs_transport",
  "not_leaving",
  "caught",
  "unknown",
];

export interface Household {
  household_id: string;
  zone_id: string;
  lon: number;
  lat: number;
  status: HouseholdStatus;
  /** Board minute the household entered this status; null when the server does not know. */
  since_minute: number | null;
  /** Null = unknown (never shown as zero). */
  occupants: number | null;
  vehicles: number | null;
}

/** GET /api/live/incidents/{id}/household-state (one page). */
interface HouseholdPage {
  incident_id: string;
  run_id: string | null;
  board_minute: number | null;
  /** False when the incident has no scenario snapshot of households; `reason` says why. */
  snapshot: boolean;
  reason?: string;
  households: Household[];
  next: string | null;
  evidence_class: "simulated";
  updated_at?: string | null;
}

/** GET /api/live/incidents/{id}/run-state: only the fields this hook reads. 404 when there is none. */
interface RunStateHead {
  run_id: string | null;
  board_minute: number | null;
  updated_at: string | null;
}

export interface HouseholdState {
  /** By household_id. A new Map on every change; unchanged households keep their object identity. */
  households: Map<string, Household>;
  runId: string | null;
  boardMinute: number | null;
  /** Null until the first page arrives. */
  snapshot: boolean | null;
  reason: string | null;
  /** True until the first full load finishes. */
  loading: boolean;
  error: LiveError | null;
}

const POLL_MS = 10_000;
const PAGE_LIMIT = 5_000;
/** Without a run-state `updated_at` to diff from, reload the whole set every this many polls. */
const FULL_RELOAD_EVERY = 3;
/** One poll (run-state head plus every page) gives up after this long. */
const CYCLE_TIMEOUT_MS = 30_000;
const EMPTY = new Map<string, Household>();
const KNOWN = new Set<string>(HOUSEHOLD_STATUSES);

const INITIAL: HouseholdState = {
  households: EMPTY,
  runId: null,
  boardMinute: null,
  snapshot: null,
  reason: null,
  loading: true,
  error: null,
};

const IDLE: HouseholdState = { ...INITIAL, loading: false };

function isPage(data: unknown): data is HouseholdPage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.snapshot === "boolean" && Array.isArray(d.households);
}

function clean(h: Household): Household | null {
  if (typeof h?.household_id !== "string" || !Number.isFinite(h.lon) || !Number.isFinite(h.lat)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    household_id: h.household_id,
    zone_id: String(h.zone_id ?? ""),
    lon: h.lon,
    lat: h.lat,
    status: KNOWN.has(h.status) ? h.status : "unknown",
    since_minute: num(h.since_minute),
    occupants: num(h.occupants),
    vehicles: num(h.vehicles),
  };
}

/** Pages through the household state (after/next) and returns every row plus the first page's head. */
async function fetchAllPages(
  token: string,
  incidentId: string,
  signal: AbortSignal,
  changedSince: string | null,
): Promise<{ head: HouseholdPage; rows: Household[] }> {
  const base = `incidents/${encodeURIComponent(incidentId)}/household-state`;
  const rows: Household[] = [];
  let head: HouseholdPage | null = null;
  let after: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const q = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (after) q.set("after", after);
    if (changedSince) q.set("changed_since", changedSince);
    const page = await request<unknown>(token, "GET", `${base}?${q}`, undefined, signal);
    if (!isPage(page)) throw new LiveError(200, "bad_response", "The household state returned an unexpected response.");
    head ??= page;
    for (const h of page.households) {
      const c = clean(h);
      if (c) rows.push(c);
    }
    if (!page.next || page.next === after) break;
    after = page.next;
  }
  return { head: head!, rows };
}

async function fetchRunHead(token: string, incidentId: string, signal: AbortSignal): Promise<RunStateHead | null> {
  try {
    const d = await request<Partial<RunStateHead>>(
      token,
      "GET",
      `incidents/${encodeURIComponent(incidentId)}/run-state`,
      undefined,
      signal,
    );
    return { run_id: d.run_id ?? null, board_minute: d.board_minute ?? null, updated_at: d.updated_at ?? null };
  } catch (error) {
    if (error instanceof LiveError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The simulated household picture. First load pages through every household; then every 10 s it reads
 * the run-state head and, when `updated_at` moved, fetches only `changed_since` the last one and
 * applies the diff. A new `run_id` replaces the whole set. A null token stops polling and clears it.
 */
export function useHouseholdState(token: string | null, incidentId: string): HouseholdState {
  // State is tagged with the token + incident it was read for, so a switch shows INITIAL at once
  // without a synchronous reset in the effect.
  const key = token ? `${token}\n${incidentId}` : null;
  const [tagged, setTagged] = useState<{ key: string | null; state: HouseholdState }>({ key: null, state: INITIAL });

  useEffect(() => {
    if (!token) return;
    const setState = (next: HouseholdState | ((s: HouseholdState) => HouseholdState)) =>
      setTagged((t) => {
        const prev = t.key === key ? t.state : INITIAL;
        return { key, state: typeof next === "function" ? next(prev) : next };
      });
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | null = null;
    let loaded = false;
    let runId: string | null = null;
    let updatedAt: string | null = null;
    let snapshot: boolean | null = null;
    let households = EMPTY;
    let polls = 0;

    const fullLoad = async (head: RunStateHead | null, cycleSignal: AbortSignal) => {
      const { head: page, rows } = await fetchAllPages(token, incidentId, cycleSignal, null);
      households = new Map(rows.map((h) => [h.household_id, h]));
      runId = page.run_id ?? head?.run_id ?? null;
      updatedAt = page.updated_at ?? head?.updated_at ?? null;
      snapshot = page.snapshot;
      loaded = true;
      setState({
        households,
        runId,
        boardMinute: page.board_minute ?? head?.board_minute ?? null,
        snapshot: page.snapshot,
        reason: page.snapshot ? null : (page.reason ?? "This incident has no household snapshot."),
        loading: false,
        error: null,
      });
    };

    const cycle = async () => {
      polls++;
      const cycleCtl = new AbortController();
      const abortCycle = () => cycleCtl.abort();
      signal.addEventListener("abort", abortCycle);
      const timeout = window.setTimeout(abortCycle, CYCLE_TIMEOUT_MS);
      const cs = cycleCtl.signal;
      try {
        const head = await fetchRunHead(token, incidentId, cs);
        const runChanged = loaded && (head?.run_id ?? null) !== runId;
        if (!loaded || runChanged || snapshot === false || (!updatedAt && polls % FULL_RELOAD_EVERY === 0)) {
          await fullLoad(head, cs);
        } else if (head?.updated_at && updatedAt && head.updated_at !== updatedAt) {
          const { head: page, rows } = await fetchAllPages(token, incidentId, cs, updatedAt);
          if (page.run_id && page.run_id !== runId) {
            await fullLoad(head, cs);
          } else {
            if (rows.length) {
              households = new Map(households);
              for (const h of rows) households.set(h.household_id, h);
            }
            updatedAt = head.updated_at;
            const next = households;
            setState((s) => ({ ...s, households: next, boardMinute: page.board_minute ?? head.board_minute ?? s.boardMinute, error: null }));
          }
        } else {
          setState((s) =>
            s.error || (head && head.board_minute !== s.boardMinute)
              ? { ...s, boardMinute: head?.board_minute ?? s.boardMinute, error: null }
              : s,
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        const err =
          error instanceof LiveError
            ? error
            : new LiveError(0, "network", cs.aborted ? "Household state timed out." : "Household state unreachable.");
        setState((s) => ({ ...s, loading: false, error: err }));
      } finally {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abortCycle);
      }
      if (!signal.aborted) timer = window.setTimeout(cycle, POLL_MS);
    };

    void cycle();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [token, incidentId, key]);

  if (!key) return IDLE;
  return tagged.key === key ? tagged.state : INITIAL;
}
