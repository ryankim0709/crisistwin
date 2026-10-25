import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveError, triageReport } from "../live/api";
import { labelPoint } from "../live/format";
import type { CommandResponse, LonLat } from "../live/types";
import { fetchSnapshot, type ScenarioSnapshot } from "../live/scenarioSnapshot";
import type { DemoOrder, LiveOrder } from "./contracts";
import { runLiveOrders } from "./liveOrders";
import type { Selection } from "./DemoMap";
import {
  activeFires,
  applyOrder,
  boardWind,
  closeFire,
  createBoard,
  fireAreaHa,
  ingestStudioFire,
  joinFieldReport,
  setRoutes,
  step,
  totals,
  zoneForecasts,
  type BaseZone,
  type Board,
  type BoardResourceInput,
} from "./model";
import { NO_SNAPSHOT_LABEL } from "./realism";
import { AUTO_SPEED, boardIsIdle, nextAutoSpeed, type AutoSpeedReason, type AutoSpeedState } from "./autoSpeed";
import type { PanelActions } from "./SelectedPanel";
import { createRoadLegHold, useCrewRoutes } from "./useCrewRoutes";
import { useDemoAgent, type AiPacing } from "./useDemoAgent";
import { DEFAULT_BOARD_RADIUS_METERS, boardCellMetersFor } from "../fire/boardSize";
import { parseStudioBoardId } from "../studio/useRegionBoard";
import type { World } from "../world/contracts";
import { useWorldSync } from "../world/useWorldSync";
import { WEATHER_PRESETS, useDemoEnvironmentState, zonesCenter, zonesExtent } from "./useDemoEnvironment";
import { useDemoRoutes } from "./useDemoRoutes";
import { useArrivalField } from "./useArrivalField";
import { useFireSolver } from "./useFireSolver";
import { clearStudioFires, studioBaseline, studioFiresToIngest, useStudioFires } from "./useStudioFires";
import type { BoardRunMode, RunTimeline, ScorePoint } from "./runContracts";
import { scorePoint } from "./scorePoint";
import { buildIncidentPicture } from "./incidentPicture";
import { usePeople } from "../live/people";
import { useParticipants } from "../appint/api";

/**
 * The simulated command board (fires, firefighting units, households) and the AI incident
 * commander, as one hook, so /live can run it beside the live drill. The logic is copied from
 * the former DemoPage.tsx and kept in the same order and with the same names.
 * Everything here is simulated in the browser on the drill's zones and roads. The board starts
 * no fires itself: they come from Simulation Studio publishes (useStudioFires.ts, ingest rule
 * there). Open fire_seen field reports from the live drill only join a fire already there, so
 * closing that fire resolves them. The commander also reads the drill's incident picture
 * (incidentPicture.ts: calls, help requests, roads, check-ins, stuck people, participants),
 * refreshed by the 3 s polls, and its live drill actions run through the live API (liveOrders.ts).
 * The live board is AI agent only: no rule-based dispatch (aiOnly below), and the clock runs only
 * while the AI agent is on, so a fresh board waits at T+00:00 until it is turned on.
 *
 * Run modes (runContracts.ts BoardRunMode; the /run page): "ai" (default) is the /live behaviour
 * above. "baseline" is the no-action run: the clock runs without the AI agent (no agent_off
 * pause), the agent is never called, nothing is dispatched (aiOnly) and no orders are taken (the
 * panel actions refuse). With no order, only self-evacuees leave (demo/selfEvacuation.ts:
 * households with their own vehicle on fire and social cues), so a baseline run is a fire race
 * where people leave only on their own cues, and fires burn uncontained. `restart(seed)` replays a
 * run from T+0 on a given seed with the incident's current Studio fire; the /run page starts each
 * run (baseline and AI) with it so both start identically. `timeline` samples scorePoint.ts once
 * per board minute (at most 2 minutes apart: a baseline or fixed-speed clock advances at most
 * RUN_TICK_MAX_MINUTES per tick) so a baseline and an AI run can be compared minute by minute.
 */

const TICK_MS = 200;
/**
 * Board minutes a baseline or fixed-speed (/run) clock advances per tick at most, so the score
 * timeline gets a point at least every 2 board minutes (600x is 2 minutes per 200 ms tick; a
 * stalled tab would otherwise jump up to 10). UI choice. /live (ai mode, no fixed speed) is uncapped.
 */
const RUN_TICK_MAX_MINUTES = 2;
/** Playback speed stops for the slider: simulated minutes per real minute (1 = real time). */
export const BOARD_SPEED_STEPS = [1, 2, 5, 10, 20, 30, 60, 120, 240, 600] as const;
export type BoardSpeed = (typeof BOARD_SPEED_STEPS)[number];
/**
 * Off by default: Claude is only called while monitoring is on (or by "Ask Claude now"). The live
 * board is AI agent only, so its clock runs only while monitoring is on (see `clockRunning`).
 */
export const MONITORING = [
  { value: "off", label: "Off", title: "Claude is not called and the simulation is paused" },
  { value: "on", label: "On", title: "The simulation runs; Claude watches the board and acts when something changes" },
] as const;
/** Why the board clock is stopped: the AI agent is off, the tab is hidden (the agent pauses), or the Pause button. */
export type ClockPause = "agent_off" | "tab_hidden" | "operator";
/** Shown while the AI agent is off (the board clock waits for it). */
export const AGENT_OFF_PAUSE = "Simulation paused \u2014 turn on the AI agent to run it.";
/** The live board's rule: no run cards or automatic escalation; Claude or a person orders everything. */
export const AI_ONLY_TEXT = "AI agent only: nothing is dispatched or ordered unless the AI agent (or you) orders it.";
/** Shown when a panel order is tried on a baseline run. */
export const BASELINE_NO_ORDERS = "Baseline run: nobody acts, so no orders are taken.";
const OPEN_REPORT = new Set(["unverified", "corroborated", "responder_confirmed", "confirmed"]);

function baseZones(data: CommandResponse): BaseZone[] {
  return data.zones.flatMap((z) => {
    const polys = z.geometry.type === "Polygon" ? [z.geometry.coordinates] : z.geometry.coordinates;
    const ring = polys.map((p) => p[0] ?? []).sort((a, b) => b.length - a.length)[0];
    const core = labelPoint(z.geometry);
    return ring && ring.length >= 4 && core
      ? [{ id: z.id, name: z.name, households: z.households, vehicles: z.vehicles, ring, core }]
      : [];
  });
}

/** The board wind preset closest to the world's weather; null when none is close (assumed, forecast). */
function closestWeatherPreset(w: World): string | null {
  const { weather, startUtc } = w.conditions;
  if (weather.mode === "climatology_percentile") {
    return WEATHER_PRESETS.find((p) => p.mode === "climatology_percentile")?.value ?? null;
  }
  if (weather.mode !== "historical_replay") return null;
  const t = Date.parse(startUtc);
  let best: string | null = null;
  let gap = Infinity;
  for (const p of WEATHER_PRESETS) {
    if (p.mode !== "historical_replay") continue;
    const d = Math.abs(Date.parse(p.start) - t);
    if (d < gap) {
      gap = d;
      best = p.value;
    }
  }
  return best;
}

/** Ground distance between two WGS84 points, metres (equirectangular; fine at drill scale). */
function distanceMeters(a: LonLat, b: LonLat): number {
  const dx = (a[0] - b[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (a[1] - b[1]) * 110_540;
  return Math.hypot(dx, dy);
}

/** The resource snapshot answer for one incident: the snapshot, or why there is none. */
interface SnapshotLoad {
  incidentId: string;
  attempt: number;
  snapshot: ScenarioSnapshot | null;
  /** null with a snapshot; else the 404 no_snapshot detail or the network error, for the UI. */
  problem: string | null;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * GET /api/live/incidents/<id>/snapshot once (docs/scenario-snapshots.md). Never rejects: a 404
 * no_snapshot, a timeout or a network error comes back as `problem` (the board then falls back to
 * the assumed roster, labelled). Null when `signal` aborted it (the caller moved on).
 */
async function loadSnapshot(token: string, incidentId: string, attempt: number, signal: AbortSignal): Promise<SnapshotLoad | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const snapshot = await fetchSnapshot(token, incidentId, controller.signal);
    if (!snapshot) return { incidentId, attempt, snapshot: null, problem: "the snapshot answer could not be read" };
    if (snapshot.incident_id !== incidentId) return { incidentId, attempt, snapshot: null, problem: `the snapshot belongs to ${snapshot.incident_id}` };
    return { incidentId, attempt, snapshot, problem: null };
  } catch (error) {
    if (signal.aborted) return null;
    const problem =
      error instanceof LiveError && error.code === "no_snapshot"
        ? `404 no_snapshot: ${error.message}`
        : controller.signal.aborted
          ? "the snapshot request timed out"
          : `snapshot unavailable: ${error instanceof Error ? error.message : "Live API error"}`;
    return { incidentId, attempt, snapshot: null, problem };
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

function resourceInput(load: SnapshotLoad): BoardResourceInput {
  return { snapshot: load.snapshot, problem: load.problem };
}

/**
 * The live board is AI agent only: no rule-based run cards or escalation orders
 * (boardResponse.ts autoDispatch, autoEscalate), whatever the model's default is.
 */
function aiOnly(board: Board): Board {
  board.response.autoDispatch = false;
  board.response.autoEscalate = false;
  return board;
}

const AUTO_SPEED_KEY = "crisistwin.live.autoSpeed";

/** The Auto speed choice for this browser; on unless it was turned off here (storage may be blocked). */
function readAutoSpeedPref(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SPEED_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeAutoSpeedPref(on: boolean): void {
  try {
    window.localStorage.setItem(AUTO_SPEED_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

function newSeed(): number {
  const fromUrl = Number(new URLSearchParams(window.location.search).get("seed"));
  return Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : Math.floor(Math.random() * 2 ** 31);
}

export interface CommandBoardOptions {
  /** Controller token, used to resolve a closed fire's field reports on the live drill. */
  token: string | null;
  incidentId: string;
  /** The live drill's command picture; ignored while it still belongs to another incident. */
  data: CommandResponse | null;
  /**
   * The Studio board the drill was run on (`GET /api/live/active` `region_id`, "<region>@<N>km"),
   * or null. The board then runs on exactly that landscape (Studio's centre, radius and cells).
   */
  studioBoardId?: string | null;
  /** "ai" (default): today's /live board. "baseline": the clock runs with nobody acting (see the top comment). */
  runMode?: BoardRunMode;
  /**
   * A fixed clock speed (board minutes per real minute) that overrides Auto and the manual speed
   * without touching the browser's saved Auto choice (the /run page's fast baseline). Omit: /live behaviour.
   */
  speed?: BoardSpeed | null;
  /**
   * How Claude's calls are paced against the clock (useDemoAgent.ts AiPacing). "auto" (default,
   * /live): Auto speed slows the board while Claude decides. "realtime" (/run's AI step): the clock
   * keeps running at its speed while Claude decides; routine calls are spaced out, urgent ones call at once.
   */
  aiPacing?: AiPacing;
}

export function useCommandBoard({
  token,
  incidentId,
  data: commandData,
  studioBoardId = null,
  runMode = "ai",
  speed: fixedSpeed = null,
  aiPacing = "auto",
}: CommandBoardOptions) {
  const baseline = runMode === "baseline";
  // The poll keeps the previous incident's data until the new answer lands; ignore it meanwhile.
  const data = commandData?.incident_id === incidentId ? commandData : null;
  const boardRef = useRef<Board | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  // The Pause button's choice; the clock also waits for the AI agent (clockRunning below).
  const [running, setRunning] = useState(true);
  // The manual speed (used while Auto is off) and the Auto choice (autoSpeed.ts; on by default, per browser).
  const [manualSpeed, setManualSpeed] = useState<BoardSpeed>(60);
  const [autoSpeedOn, setAutoSpeedOn] = useState(readAutoSpeedPref);
  const [autoReason, setAutoReason] = useState<AutoSpeedReason>("idle");
  const [autopilot, setAutopilot] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [weather, setWeatherState] = useState<string>(WEATHER_PRESETS[0].value);
  const preset = WEATHER_PRESETS.find((p) => p.value === weather) ?? WEATHER_PRESETS[0];
  const zoneCentre = useMemo(() => (data ? zonesCenter(data.zones) : null), [data]);
  // Board size: the shared world's region radius (docs/shared-world.md); the live board never goes below 15 km.
  // A Studio drill instead starts on the board Studio ran it on (its region centre, radius and cells),
  // so the landscape is the one Studio loaded and cached; a size picked here then keeps that centre.
  // ASSUMPTION: a Studio board smaller than 15 km is still big enough, since the Studio fire was solved on it.
  const [radius, setRadius] = useState(DEFAULT_BOARD_RADIUS_METERS);
  // The seed the next board starts from when the shared world names one.
  const worldSeed = useRef<number | null>(null);

  // Shared world: this board takes the world's size, weather (closest preset), seed and, when the
  // world's area is this drill, its centre; it writes what its user changes here. A new world seed
  // (Studio's random scenario, natural-variation seed) is only kept for the next board: only a
  // Studio run (a publish) or this page's own restart changes the running board.
  const sync = useWorldSync({
    tab: "live",
    local: null,
    apply: (w, changed) => {
      if (changed.has("region")) setRadius(w.region.radiusMeters);
      const weatherChanged = [...changed].some((p) => p.startsWith("conditions.weather.") || p === "conditions.startUtc");
      const closest = weatherChanged ? closestWeatherPreset(w) : null;
      if (closest) setWeatherState(closest);
      if (changed.has("fire.stochastic.seed")) worldSeed.current = w.fire.stochastic.seed;
    },
  });
  const { write: writeWorld } = sync;
  const drillBoard = useMemo(() => (studioBoardId ? parseStudioBoardId(studioBoardId) : null), [studioBoardId]);
  const [picked, setPicked] = useState<{ incidentId: string; radiusMeters: number } | null>(null);
  const pickedRadius = picked?.incidentId === incidentId ? picked.radiusMeters : null;
  const studioRadius = drillBoard ? (pickedRadius ?? drillBoard.radiusMeters) : null;
  const boardRadius = drillBoard
    ? (studioRadius ?? drillBoard.region.radiusMeters)
    : Math.max(DEFAULT_BOARD_RADIUS_METERS, radius);
  const studioBoard = useMemo(
    () => (drillBoard ? { region: drillBoard.region, radiusMeters: studioRadius } : null),
    [drillBoard, studioRadius],
  );
  const r = sync.world.region;
  // The world's centre drives the board only when it is this drill's area (an incident region of
  // this drill, or a region centred within 20 km of the drill's zones) and the drill names no
  // Studio board (that board fixes the centre).
  const worldCentre: LonLat | null =
    !drillBoard &&
    sync.enabled && sync.loaded && sync.world.revision > 0 &&
    ((r.kind === "incident" && r.id === incidentId) ||
      (zoneCentre !== null && distanceMeters(zoneCentre, r.center) < 20_000))
      ? r.center
      : null;
  const setBoardRadius = useCallback(
    (radiusMeters: number) => {
      setPicked({ incidentId, radiusMeters });
      setRadius(radiusMeters);
      writeWorld({ region: { radiusMeters, cellMeters: boardCellMetersFor(radiusMeters) } });
    },
    [writeWorld, incidentId],
  );
  const setWeather = useCallback(
    (value: string) => {
      const next = WEATHER_PRESETS.find((p) => p.value === value);
      if (!next) return;
      setWeatherState(value);
      writeWorld({
        conditions: {
          startUtc: next.start,
          weather:
            next.mode === "climatology_percentile" ? { mode: next.mode, percentile: 95 } : { mode: next.mode },
        },
      });
    },
    [writeWorld],
  );
  // A drill switch (made in any /live tab) is the world's live drill from now on.
  const lastIncident = useRef(incidentId);
  useEffect(() => {
    if (lastIncident.current === incidentId) return;
    lastIncident.current = incidentId;
    writeWorld({ liveIncidentId: incidentId });
  }, [incidentId, writeWorld]);
  // The zones' half-width sizes the live LANDFIRE landscape when no prebuilt region covers the drill.
  const zonesHalfWidth = useMemo(() => (data ? (zonesExtent(data.zones)?.halfWidthMeters ?? null) : null), [data]);
  const [envAttempt, setEnvAttempt] = useState(0);
  const environment = useDemoEnvironmentState(preset, incidentId, zoneCentre, zonesHalfWidth, envAttempt, boardRadius, studioBoard, worldCentre);
  const env = environment.env;

  // A new board size or centre loads a new landscape: rebuild the board on it once it arrives.
  const boardKey = `${boardRadius}|${worldCentre?.join(",") ?? ""}`;
  const lastBoardKey = useRef(boardKey);
  useEffect(() => {
    if (lastBoardKey.current === boardKey) return;
    lastBoardKey.current = boardKey;
    boardRef.current = null;
    setBoard(null);
    setSelection(null);
    bump();
  }, [boardKey, bump]);

  // Simulation Studio's published runs for this incident: the board's only fire source.
  const studio = useStudioFires(data ? token : null, incidentId);
  const studioRef = useRef(studio.data);
  useEffect(() => {
    studioRef.current = studio.data;
  }, [studio.data]);
  // Boards that must not take the newest publish at their first read of the feed (Reset board).
  const [noRecent] = useState(() => new WeakSet<Board>());

  // The drill's resource snapshot (units, stations, households), read once per incident (and
  // again on Reset board). The board waits for it: a board is only built from the command data
  // and the snapshot answer (snapshot or why there is none) of the same incident.
  const [snapshotAttempt, setSnapshotAttempt] = useState(0);
  const [snapshotLoad, setSnapshotLoad] = useState<SnapshotLoad | null>(null);
  const hasData = data !== null;
  useEffect(() => {
    if (!hasData || !token) return;
    const controller = new AbortController();
    void loadSnapshot(token, incidentId, snapshotAttempt, controller.signal).then((load) => {
      if (load && !controller.signal.aborted) setSnapshotLoad(load);
    });
    return () => controller.abort();
  }, [hasData, token, incidentId, snapshotAttempt]);
  const snapshot = snapshotLoad?.incidentId === incidentId && snapshotLoad.attempt === snapshotAttempt ? snapshotLoad : null;

  // The seed restart(seed) asked for (/run): a later Studio publish or rebuilt board keeps it (not the world's).
  const pinnedSeed = useRef<number | null>(null);
  // A different drill: drop the board and selection; the effect below rebuilds it from the new data.
  useEffect(() => {
    pinnedSeed.current = null;
    boardRef.current = null;
    setBoard(null);
    setSelection(null);
    setNotice(null);
    bump();
  }, [incidentId, bump]);

  // Start the board once the drill zones, the fire inputs and the snapshot answer arrive.
  useEffect(() => {
    if (!data || !env || !snapshot || boardRef.current) return;
    const created = aiOnly(createBoard(baseZones(data), pinnedSeed.current ?? worldSeed.current ?? newSeed(), env, resourceInput(snapshot)));
    boardRef.current = created;
    setBoard(created);
    // One notice per board built without a snapshot (the label also stays in resourceNotice).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the board itself is set the same way
    if (created.resources.source !== "snapshot") setNotice(resourceNoticeOf(created));
  }, [data, env, snapshot]);

  // A new weather choice swaps the inputs under the running board; the landscape (and with it the
  // fire field) stays, since loads are cached per region. A different landscape starts a new board.
  useEffect(() => {
    const b = boardRef.current;
    if (!b || !env || b.env === env) return;
    if (b.env.landscape !== env.landscape) {
      const created = aiOnly(
        createBoard(
          b.zones.map((z) => ({ id: z.id, name: z.name, households: z.households, vehicles: z.vehicles, ring: z.ring, core: z.core })),
          b.seed,
          env,
          { snapshot: b.snapshotInput, problem: b.resources.problem },
        ),
      );
      boardRef.current = created;
      setBoard(created);
    } else b.env = env;
    bump();
  }, [env, bump]);

  // A restart rebuilds from the snapshot (clean unit states, every household home) at T+0; `load` is
  // a freshly read snapshot (Reset board), else the one already loaded. `studio` "newest": the new
  // board runs the newest Studio publish listed (Studio is the source of truth: "Restart board",
  // a new Studio run); "none": it starts empty and never takes the publishes listed now (Reset
  // board, which has just deleted them). Returns the new board (null when it cannot be built yet).
  const restartWith = (seed: number, load: SnapshotLoad | null = snapshot, studio: "newest" | "none" = "newest"): Board | null => {
    if (!data || !env || !load) return null;
    const created = aiOnly(createBoard(baseZones(data), seed, env, resourceInput(load)));
    const listed = studioRef.current;
    if (studio === "none") {
      if (listed) created.studioBaseline = listed.map((f) => f.fire_id);
      else noRecent.add(created);
    } else if (listed) created.studioBaseline = studioBaseline(listed, true);
    boardRef.current = created;
    setBoard(created);
    setSelection(null);
    if (created.resources.source !== "snapshot") setNotice(resourceNoticeOf(created));
    bump();
    return created;
  };
  const restartRef = useRef(restartWith);
  useEffect(() => {
    restartRef.current = restartWith;
  });
  /** "Restart board": a new seed (written to the shared world); `load` and `studio` as restartWith. */
  const restartNewSeed = (load: SnapshotLoad | null = snapshot, studio: "newest" | "none" = "newest") => {
    if (!data || !env || !load) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    pinnedSeed.current = null;
    restartWith(seed, load, studio);
    worldSeed.current = seed;
    writeWorld({ fire: { stochastic: { seed } } });
  };
  /**
   * Replays the run from T+0 on `seed` (default: the current board's seed) with the incident's
   * current Studio fire, ingested at once so the clock cannot run a fire-less minute first. A new
   * Board: the agent's memory, decisions and inputs and the timeline start over. The seed is not
   * written to the shared world (it would change Studio's stochastic seed). Returns the new board,
   * or null while the drill data, landscape or snapshot answer is still loading (the seed stays
   * pinned, so the board built when they arrive uses it).
   */
  const restartRun = (seed?: number): Board | null => {
    const s =
      typeof seed === "number" && Number.isInteger(seed) && seed > 0
        ? seed
        : (boardRef.current?.seed ?? worldSeed.current ?? newSeed());
    pinnedSeed.current = s;
    const created = restartWith(s);
    if (!created) return null;
    const listed = studioRef.current;
    if (listed) {
      const fresh = studioFiresToIngest(listed, created.studioBaseline ?? [], created.studioFireIds);
      const newest = fresh[fresh.length - 1];
      if (newest) {
        created.studioBaseline = listed.filter((f) => f.fire_id !== newest.fire_id).map((f) => f.fire_id);
        ingestStudioFire(created, newest);
      }
    }
    return created;
  };

  // Stable callbacks for the page (they run the newest closures).
  const runRestarts = useRef({ restartRun, restartNewSeed });
  useEffect(() => {
    runRestarts.current = { restartRun, restartNewSeed };
  });
  const restart = useCallback((seed?: number) => runRestarts.current.restartRun(seed), []);
  const restartFresh = useCallback(() => runRestarts.current.restartNewSeed(), []);

  // "Reset board": clear the incident's published Studio fires on the server (so no console or
  // reload starts them again), then start an empty board; the agent's log clears with it.
  const [resetting, setResetting] = useState(false);
  const reset = async () => {
    if (!token || resetting) return;
    setResetting(true);
    try {
      await clearStudioFires(token, incidentId);
      setNotice(null);
      // Read the snapshot again (it may have been re-seeded), then rebuild from it.
      const attempt = snapshotAttempt + 1;
      const load = await loadSnapshot(token, incidentId, attempt, new AbortController().signal);
      if (load) {
        setSnapshotLoad(load);
        setSnapshotAttempt(attempt);
      }
      restartNewSeed(load ?? snapshot, "none");
    } catch (error) {
      setNotice(`Reset failed: ${error instanceof Error ? error.message : "Live API error."}`);
    } finally {
      setResetting(false);
    }
  };

  // Studio publishes start fires on the board (ingest rule in useStudioFires.ts): the board runs
  // Studio's newest run only. A board still at T+0 with no Studio fire takes it as is; any other
  // board restarts on it (a new Board: new run id, lease and Claude memory; the seed is not
  // written to the shared world, so no other tab restarts), at T+0 like Studio.
  useEffect(() => {
    const b = boardRef.current;
    const fires = studio.data;
    if (!b || !fires) return;
    if (b.studioBaseline === null) b.studioBaseline = studioBaseline(fires, !noRecent.has(b));
    const fresh = studioFiresToIngest(fires, b.studioBaseline, b.studioFireIds);
    if (fresh.length === 0) return;
    const newest = fresh[fresh.length - 1];
    const older = fires.filter((f) => f.fire_id !== newest.fire_id).map((f) => f.fire_id);
    if (b.minute === 0 && b.studioFireIds.length === 0) {
      b.studioBaseline = [...new Set([...b.studioBaseline, ...older])];
      ingestStudioFire(b, newest);
      bump();
      return;
    }
    const replaced = b.studioFireIds.length > 0;
    const created = restartRef.current(pinnedSeed.current ?? worldSeed.current ?? b.seed);
    if (!created) return;
    created.studioBaseline = older;
    ingestStudioFire(created, newest, replaced);
    bump();
  }, [studio.data, board, noRecent, bump]);

  // Open fire_seen field reports from the live drill join the fire already there (they never start one).
  useEffect(() => {
    const b = boardRef.current;
    if (!b || !data) return;
    let changed = false;
    for (const r of data.reports) {
      if (r.kind === "fire_seen" && OPEN_REPORT.has(r.status) && !b.seenReports.includes(r.id)) {
        changed = joinFieldReport(b, r.id, r.location.coord) !== null || changed;
      }
    }
    if (changed) bump();
  }, [data, board, bump]);

  // The live incident picture for the commander: the command poll plus the people snapshot and the
  // participants list (each polled every 3 s while a controller token is present).
  const people = usePeople(data ? token : null, incidentId);
  const participants = useParticipants(data ? token : null, incidentId);
  const peopleData = people.data?.incident_id === incidentId ? people.data : null;
  const participantsData = participants.data?.incident_id === incidentId ? participants.data : null;
  const picture = useMemo(
    () => (data ? buildIncidentPicture(data, peopleData, participantsData) : null),
    [data, peopleData, participantsData],
  );

  const routes = useDemoRoutes(board, version, incidentId, data?.destinations);
  const routesRef = useRef(routes.routes);
  useEffect(() => {
    routesRef.current = routes.routes;
    if (boardRef.current) setRoutes(boardRef.current, routes.routes);
  }, [routes.routes, board]);
  const crewRoutes = useCrewRoutes(board, version, incidentId);
  // Fire spread: the simulator's cell solver in a worker. model.step holds the clock while a solve is due.
  const fireSolver = useFireSolver(board, version, bump);

  // The commander's picture: zone forecasts from reported fires only (model.ts ForecastScope; the
  // report rule in boardResponse.ts). Claude, the outcomes, the panels and the map tags all read
  // these, so an unreported fire threatens nothing they show; the board's physics still runs on every fire.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  const forecasts = useMemo(() => (board ? zoneForecasts(board, "reported") : new Map()), [board, version]);

  const apply = useCallback(
    (orders: DemoOrder[]) => {
      const b = boardRef.current;
      const out = orders.map((o) => (b ? applyOrder(b, o, routesRef.current, "agent") : "No board."));
      bump();
      return out;
    },
    [bump],
  );
  // The commander's live drill actions run as the controller on the newest command poll.
  const liveRef = useRef({ token, incidentId, data });
  useEffect(() => {
    liveRef.current = { token, incidentId, data };
  }, [token, incidentId, data]);
  const applyLive = useCallback((orders: LiveOrder[]) => {
    const { token: t, incidentId: id, data: d } = liveRef.current;
    return runLiveOrders(t, id, d, orders, setNotice, boardRef.current);
  }, []);
  const agentRun = useDemoAgent({ board, version, incidentId, routes: routes.routes, forecasts, enabled: autopilot && !baseline, apply, applyLive, picture, pacing: aiPacing });
  // A baseline run never calls the agent ("Ask Claude now" included).
  const agent = baseline ? { ...agentRun, decideNow: () => {} } : agentRun;
  // Turning the AI agent on starts the clock (clearing an earlier Pause); off stops it (below).
  const turnAgent = useCallback((on: boolean) => {
    setAutopilot(on);
    if (on) setRunning(true);
  }, []);

  // The simulation clock. The live board is AI agent only, so it runs only while the agent is
  // monitoring (on, tab shown) and not paused; nothing advances otherwise (fire, traffic, units).
  // It keeps running while Claude decides; orders apply when they arrive. Studio publishes are
  // still ingested while it waits: they are scheduled from the board minute (model.ingestStudioFire).
  // A baseline run has no agent to wait for: only the Pause button stops it.
  const clockPause: ClockPause | null = baseline
    ? !running
      ? "operator"
      : null
    : !autopilot
    ? "agent_off"
    : agent.status === "paused"
      ? "tab_hidden"
      : !running
        ? "operator"
        : null;
  const clockRunning = clockPause === null;
  // Auto speed (autoSpeed.ts): 1× while Claude decides on an urgent wake, 5× while it reviews
  // (routine wake), 60× while the board is idle (after a short hold), else 20×. It only sets how
  // many board minutes pass per real second; step() lands on the same minutes and events at any
  // rate. With the agent off it shows what it would pick.
  // Realtime pacing: the clock does not slow down for Claude (Auto then reads only the board).
  const thinking = aiPacing !== "realtime" && agent.status === "thinking" ? (agent.urgency ?? "urgent") : null;
  const autoState = useRef<{ board: Board | null; state: AutoSpeedState | null }>({ board: null, state: null });
  useEffect(() => {
    if (!board) return;
    const memo = autoState.current;
    const prev = memo.board === board ? memo.state : null;
    const next = nextAutoSpeed(prev, { minute: board.minute, idle: boardIsIdle(board), thinking });
    autoState.current = { board, state: next };
    setAutoReason(next.reason);
  }, [board, version, thinking]);
  const speed: BoardSpeed = fixedSpeed ?? (autoSpeedOn ? (AUTO_SPEED[autoReason] as BoardSpeed) : manualSpeed);
  // Picking a speed by hand turns Auto off and keeps that speed; turning Auto off keeps the current one.
  const setSpeed = useCallback((s: BoardSpeed) => {
    setManualSpeed(s);
    setAutoSpeedOn(false);
    writeAutoSpeedPref(false);
  }, []);
  const setAutoSpeed = useCallback(
    (on: boolean) => {
      if (!on) setManualSpeed(speed);
      setAutoSpeedOn(on);
      writeAutoSpeedPref(on);
    },
    [speed],
  );
  /** The board's settings a saved scenario restores beyond the shared world. */
  const getExtras = () => ({ speed: manualSpeed, autoSpeed: autoSpeedOn, running, weather });
  const restoreExtras = (raw: unknown) => {
    const extras = raw as { speed?: unknown; autoSpeed?: unknown; running?: unknown } | undefined;
    if (!extras || typeof extras !== "object") return;
    if (BOARD_SPEED_STEPS.some((v) => v === extras.speed)) setSpeed(extras.speed as BoardSpeed);
    if (typeof extras.autoSpeed === "boolean") setAutoSpeed(extras.autoSpeed);
    if (typeof extras.running === "boolean") setRunning(extras.running);
  };
  const maxTick = baseline || fixedSpeed !== null ? RUN_TICK_MAX_MINUTES : Infinity;
  const clock = useRef({ running: clockRunning, speed, maxTick });
  useEffect(() => {
    clock.current = { running: clockRunning, speed, maxTick };
  }, [clockRunning, speed, maxTick]);
  // The clock also holds while a unit on the road waits for its road leg (at most
  // ROAD_LEG_HOLD_MAX_MS per leg), as it does while a fire solve is due (useCrewRoutes.ts).
  const [legHold] = useState(() => createRoadLegHold());
  useEffect(() => {
    let last = performance.now();
    const holdForLegs = (b: Board) => legHold.holds(b);
    const id = window.setInterval(() => {
      const now = performance.now();
      const seconds = Math.min(1, (now - last) / 1000);
      last = now;
      const b = boardRef.current;
      const c = clock.current;
      if (!b || !c.running) return;
      step(b, Math.min(c.maxTick, (seconds * c.speed) / 60), holdForLegs);
      bump();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [bump, legHold]);

  const act = (fn: (b: Board) => string | null) => {
    const b = boardRef.current;
    if (!b) return;
    if (baseline) {
      setNotice(BASELINE_NO_ORDERS);
      return;
    }
    const error = fn(b);
    setNotice(error);
    bump();
  };

  const actions: PanelActions = {
    closeFire: (fireId) => {
      if (baseline) {
        setNotice(BASELINE_NO_ORDERS);
        return;
      }
      const b = boardRef.current;
      const reports = b?.fires.find((f) => f.id === fireId)?.reportIds ?? [];
      let refused: string | null = null;
      act((b) => (refused = closeFire(b, fireId)));
      // A refused close (e.g. a fire not yet reported, model.ts closeFire) resolves nothing.
      if (refused) return;
      for (const id of reports) {
        triageReport(token ?? "", id, "resolve").catch((error: unknown) =>
          setNotice(`Fire closed, but the field report could not be resolved: ${error instanceof LiveError ? error.message : "Live API error."}`),
        );
      }
    },
    sendTeam: (teamId, fireId, positionId) =>
      act((b) => applyOrder(b, { type: "send_crew", crew_id: teamId, fire_id: fireId, position_id: positionId ?? null }, routesRef.current, "you")),
    releaseTeam: (teamId) => act((b) => applyOrder(b, { type: "release_crew", crew_id: teamId }, routesRef.current, "you")),
    orderZone: (zoneId, destinationId) =>
      act((b) => applyOrder(b, { type: "order_evacuation", zone_id: zoneId, destination_id: destinationId }, routesRef.current, "you")),
    cancelZoneOrder: (zoneId) => act((b) => applyOrder(b, { type: "cancel_evacuation", zone_id: zoneId }, routesRef.current, "you")),
  };

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const z of data?.zones ?? []) m.set(z.id, z.name);
    for (const d of data?.destinations ?? []) m.set(d.id, d.name);
    return m;
  }, [data]);
  const name = useCallback((id: string) => names.get(id) ?? id, [names]);

  const t = board ? totals(board, forecasts) : null;
  const windNow = board ? boardWind(board) : null;
  // The 3D view draws the LANDFIRE landscape the fire solver runs on.
  const landscape = board?.env.landscape ?? null;
  const field = useArrivalField(board, version, landscape);
  const fires = board
    ? activeFires(board).sort((a, b) => (a.status === b.status ? fireAreaHa(b) - fireAreaHa(a) : a.status === "burning" ? -1 : 1))
    : [];
  const threatenedHome = board
    ? board.zones.reduce((sum, z) => {
        const f = forecasts.get(z.id);
        return f?.edgeEta != null && z.overrunAt === null && z.orderedAt === null ? sum + z.households : sum;
      }, 0)
    : 0;

  // The run's score timeline: one scorePoint per board minute the clock lands on (a fast clock
  // can step 2 minutes per tick, so points may be 2 minutes apart). A new board starts a new one.
  // The state names its board, so a new board never shows the old run's points (even for one render).
  const timelineRef = useRef<{ board: Board | null; points: ScorePoint[] }>({ board: null, points: [] });
  const [sampled, setSampled] = useState<{ board: Board | null; timeline: RunTimeline } | null>(null);
  useEffect(() => {
    if (timelineRef.current.board !== board) timelineRef.current = { board, points: [] };
    const points = timelineRef.current.points;
    if (board) {
      const minute = Math.floor(board.minute);
      if (points.length === 0 || minute > points[points.length - 1].minute) points.push(scorePoint(board, forecasts));
    }
    const seed = board?.seed ?? 0;
    setSampled((prev) =>
      prev && prev.board === board && prev.timeline.mode === runMode && prev.timeline.points.length === points.length
        ? prev
        : { board, timeline: { mode: runMode, seed, points: [...points] } },
    );
  }, [board, version, forecasts, runMode]);
  const timeline: RunTimeline =
    sampled && sampled.board === board && sampled.timeline.mode === runMode
      ? sampled.timeline
      : { mode: runMode, seed: board?.seed ?? 0, points: [] };

  return {
    /** The board, mutated in place; `version` changes whenever it does. Null until zones and inputs load. */
    board,
    version,
    /** Marks an in-place board change made outside this hook (live/useRoadClosures.ts road closures). */
    bump,
    // Clock: `running` is whether it runs (false while the AI agent is off, see clockPause);
    // setRunning is the Pause button's choice, which only counts while the agent is on.
    running: clockRunning,
    clockPause,
    setRunning,
    /** Board minutes per real minute now: Auto's pick while autoSpeed is on, else the manual speed. */
    speed,
    /** Manual speed: turns Auto off and keeps this speed. */
    setSpeed,
    /** Whether Auto picks the speed (autoSpeed.ts), and why it picked it (shown as text). */
    autoSpeed: autoSpeedOn,
    autoReason,
    setAutoSpeed,
    // Conditions: wind and moisture come from the newest Studio fire (board.conditions); `weather`
    // picks the station wind series, which only matters before any Studio fire.
    weather,
    setWeather,
    boardRadius,
    setBoardRadius,
    /** Centre of the board's landscape when the drill names its Studio board (WGS84 [lon, lat]); else null (the drill centre). */
    boardCentre: drillBoard ? ([drillBoard.region.center.longitude, drillBoard.region.center.latitude] as [number, number]) : null,
    /** True while the landscape for a new board size is still loading. */
    boardLoading: env === null,
    // Shared world (docs/shared-world.md): sync state and the board's saved-scenario extras
    world: sync,
    getExtras,
    restoreExtras,
    windNow,
    // AI commander (monitoring is off by default; Claude is only called while it is on, and the
    // board clock runs only then). setAutopilot(true) also starts the clock.
    /** The live drill's incident picture the commander reads (incidentPicture.ts), or null. */
    picture,
    autopilot: autopilot && !baseline,
    setAutopilot: turnAgent,
    agent,
    /** How this board runs (runContracts.ts BoardRunMode). */
    runMode,
    /** How Claude's calls are paced against the clock (CommandBoardOptions.aiPacing). */
    aiPacing,
    /** The current board's seed; null before the first board. */
    seed: board?.seed ?? null,
    /** Score samples of the current board's run (scorePoint.ts), oldest first; reset by every new board. */
    timeline,
    /** The Simulation Studio feed: its last error (404 until the server has the endpoint), whether it has answered. */
    studio: { error: studio.error, loaded: studio.data !== null },
    /** Alias of fireSolver (one solver hook; why a solve is running, last solve time, last error). */
    solver: fireSolver,
    // Map interaction
    selection,
    setSelection,
    notice,
    setNotice,
    // Derived pictures
    routes,
    crewRoutes,
    forecasts,
    actions,
    /** Replays the run from T+0 on `seed` (default: the current seed) with the current Studio fire. */
    restart,
    /** /live "Restart board": a new random seed, written to the shared world. */
    restartNewSeed: restartFresh,
    reset,
    resetting,
    name,
    totals: t,
    threatenedHome,
    fires,
    landscape,
    field,
    /** Fire solver status: why a solve is running (the clock holds meanwhile), its last time, a failure. */
    fireSolver,
    /** Board inputs loading state: live LANDFIRE load in progress, or why the landscape failed (no board then). */
    environment,
    /**
     * The drill's resource snapshot as loaded for this incident: `loading` until it answers (the
     * board waits for it), `data` the snapshot or null, `problem` why there is none (404
     * no_snapshot, network). The board itself carries what it was built from (board.snapshot,
     * board.resources); a snapshot re-seeded later is picked up by Reset board.
     */
    snapshot: { data: snapshot?.snapshot ?? null, problem: snapshot?.problem ?? null, loading: hasData && !snapshot },
    /** Shown while the board runs without a snapshot: NO_SNAPSHOT_LABEL and why; null with one. */
    resourceNotice: board ? resourceNoticeOf(board) : null,
    retryEnvironment: () => setEnvAttempt((a) => a + 1),
  };
}

export type CommandBoard = ReturnType<typeof useCommandBoard>;

/** The no-snapshot label with its reason, or null for a board built from a snapshot. */
function resourceNoticeOf(board: Board): string | null {
  if (board.resources.source === "snapshot") return null;
  return `${NO_SNAPSHOT_LABEL}${board.resources.problem ? ` (${board.resources.problem})` : ""}.`;
}
