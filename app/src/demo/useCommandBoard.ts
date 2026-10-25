import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveError, triageReport } from "../live/api";
import { labelPoint } from "../live/format";
import type { CommandResponse } from "../live/types";
import { fetchSnapshot, type ScenarioSnapshot } from "../live/scenarioSnapshot";
import type { DemoOrder } from "./contracts";
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
import { useDemoAgent } from "./useDemoAgent";
import { DEFAULT_BOARD_RADIUS_METERS, boardCellMetersFor } from "../fire/boardSize";
import { parseStudioBoardId } from "../studio/useRegionBoard";
import { useWorld } from "../world/useWorld";
import { WEATHER_PRESETS, useDemoEnvironmentState, zonesCenter, zonesExtent } from "./useDemoEnvironment";
import { useDemoRoutes } from "./useDemoRoutes";
import { useArrivalField } from "./useArrivalField";
import { useFireSolver } from "./useFireSolver";
import { clearStudioFires, studioBaseline, studioFiresToIngest, useStudioFires } from "./useStudioFires";

/**
 * The simulated command board (fires, firefighting units, households) and the AI incident
 * commander, as one hook, so /live can run it beside the live drill. The logic is copied from
 * the former DemoPage.tsx and kept in the same order and with the same names.
 * Everything here is simulated in the browser on the drill's zones and roads. The board starts
 * no fires itself: they come from Simulation Studio publishes (useStudioFires.ts, ingest rule
 * there). Open fire_seen field reports from the live drill only join a fire already there, so
 * closing that fire resolves them.
 * The live board is AI agent only: no rule-based dispatch (aiOnly below), and the clock runs only
 * while the AI agent is on, so a fresh board waits at T+00:00 until it is turned on.
 */

const TICK_MS = 200;
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
}

export function useCommandBoard({ token, incidentId, data: commandData, studioBoardId = null }: CommandBoardOptions) {
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
  const [weather, setWeather] = useState<string>(WEATHER_PRESETS[0].value);
  const preset = WEATHER_PRESETS.find((p) => p.value === weather) ?? WEATHER_PRESETS[0];
  const zoneCentre = useMemo(() => (data ? zonesCenter(data.zones) : null), [data]);
  // Board size is the shared world's region radius (docs/shared-world.md); the live board never goes below 15 km.
  // A Studio drill instead starts on the board Studio ran it on (its region centre, radius and cells),
  // so the landscape is the one Studio loaded and cached; a size picked here then keeps that centre.
  // ASSUMPTION: a Studio board smaller than 15 km is still big enough, since the Studio fire was solved on it.
  const { world, update: updateWorld } = useWorld();
  const drillBoard = useMemo(() => (studioBoardId ? parseStudioBoardId(studioBoardId) : null), [studioBoardId]);
  const [picked, setPicked] = useState<{ incidentId: string; radiusMeters: number } | null>(null);
  const pickedRadius = picked?.incidentId === incidentId ? picked.radiusMeters : null;
  const studioRadius = drillBoard ? (pickedRadius ?? drillBoard.radiusMeters) : null;
  const boardRadius = drillBoard
    ? (studioRadius ?? drillBoard.region.radiusMeters)
    : Math.max(DEFAULT_BOARD_RADIUS_METERS, world.region.radiusMeters);
  const studioBoard = useMemo(
    () => (drillBoard ? { region: drillBoard.region, radiusMeters: studioRadius } : null),
    [drillBoard, studioRadius],
  );
  const setBoardRadius = useCallback(
    (radiusMeters: number) => {
      setPicked({ incidentId, radiusMeters });
      void updateWorld({ region: { radiusMeters, cellMeters: boardCellMetersFor(radiusMeters) } }, "live");
    },
    [updateWorld, incidentId],
  );
  // The zones' half-width sizes the live LANDFIRE landscape when no prebuilt region covers the drill.
  const zonesHalfWidth = useMemo(() => (data ? (zonesExtent(data.zones)?.halfWidthMeters ?? null) : null), [data]);
  const [envAttempt, setEnvAttempt] = useState(0);
  const environment = useDemoEnvironmentState(preset, incidentId, zoneCentre, zonesHalfWidth, envAttempt, boardRadius, studioBoard);
  const env = environment.env;

  // A new board size loads a new landscape: rebuild the board on it once it arrives.
  const lastRadius = useRef(boardRadius);
  useEffect(() => {
    if (lastRadius.current === boardRadius) return;
    lastRadius.current = boardRadius;
    boardRef.current = null;
    setBoard(null);
    setSelection(null);
    bump();
  }, [boardRadius, bump]);

  // Simulation Studio's published runs for this incident: the board's only fire source.
  const studio = useStudioFires(data ? token : null, incidentId);
  const studioRef = useRef(studio.data);
  useEffect(() => {
    studioRef.current = studio.data;
  }, [studio.data]);
  // Boards that must not take the recent publishes at their first read of the feed (a restart).
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

  // A different drill: drop the board and selection; the effect below rebuilds it from the new data.
  useEffect(() => {
    boardRef.current = null;
    setBoard(null);
    setSelection(null);
    setNotice(null);
    bump();
  }, [incidentId, bump]);

  // Start the board once the drill zones, the fire inputs and the snapshot answer arrive.
  useEffect(() => {
    if (!data || !env || !snapshot || boardRef.current) return;
    const created = aiOnly(createBoard(baseZones(data), newSeed(), env, resourceInput(snapshot)));
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

  // A restart rebuilds from the snapshot (clean unit states, every household home); `load` is a
  // freshly read snapshot (Reset board), else the one already loaded.
  const restart = (load: SnapshotLoad | null = snapshot) => {
    if (!data || !env || !load) return;
    const created = aiOnly(createBoard(baseZones(data), Math.floor(Math.random() * 2 ** 31), env, resourceInput(load)));
    // A restart starts empty: the publishes listed now are never ingested by this board.
    const listed = studioRef.current;
    if (listed) created.studioBaseline = listed.map((f) => f.fire_id);
    else noRecent.add(created);
    boardRef.current = created;
    setBoard(created);
    setSelection(null);
    if (created.resources.source !== "snapshot") setNotice(resourceNoticeOf(created));
    bump();
  };

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
      restart(load ?? snapshot);
    } catch (error) {
      setNotice(`Reset failed: ${error instanceof Error ? error.message : "Live API error."}`);
    } finally {
      setResetting(false);
    }
  };

  // Studio publishes start fires on the board (ingest rule in useStudioFires.ts).
  useEffect(() => {
    const b = boardRef.current;
    const fires = studio.data;
    if (!b || !fires) return;
    if (b.studioBaseline === null) b.studioBaseline = studioBaseline(fires, !noRecent.has(b));
    let changed = false;
    for (const f of studioFiresToIngest(fires, b.studioBaseline, b.studioFireIds)) changed = ingestStudioFire(b, f) || changed;
    if (changed) bump();
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

  const routes = useDemoRoutes(board, version, incidentId);
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
  const agent = useDemoAgent({ board, version, incidentId, routes: routes.routes, forecasts, enabled: autopilot, apply });
  // Turning the AI agent on starts the clock (clearing an earlier Pause); off stops it (below).
  const turnAgent = useCallback((on: boolean) => {
    setAutopilot(on);
    if (on) setRunning(true);
  }, []);

  // The simulation clock. The live board is AI agent only, so it runs only while the agent is
  // monitoring (on, tab shown) and not paused; nothing advances otherwise (fire, traffic, units).
  // It keeps running while Claude decides; orders apply when they arrive. Studio publishes are
  // still ingested while it waits: they are scheduled from the board minute (model.ingestStudioFire).
  const clockPause: ClockPause | null = !autopilot
    ? "agent_off"
    : agent.status === "paused"
      ? "tab_hidden"
      : !running
        ? "operator"
        : null;
  const clockRunning = clockPause === null;
  // Auto speed (autoSpeed.ts): 1× while Claude is deciding, 60× while the board is idle (after a
  // short hold), else 20×. It only sets how many board minutes pass per real second; step() lands
  // on the same minutes and events at any rate. With the agent off it shows what it would pick.
  const thinking = agent.status === "thinking";
  const autoState = useRef<{ board: Board | null; state: AutoSpeedState | null }>({ board: null, state: null });
  useEffect(() => {
    if (!board) return;
    const memo = autoState.current;
    const prev = memo.board === board ? memo.state : null;
    const next = nextAutoSpeed(prev, { minute: board.minute, idle: boardIsIdle(board), thinking });
    autoState.current = { board, state: next };
    setAutoReason(next.reason);
  }, [board, version, thinking]);
  const speed: BoardSpeed = autoSpeedOn ? (AUTO_SPEED[autoReason] as BoardSpeed) : manualSpeed;
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
  const clock = useRef({ running: clockRunning, speed });
  useEffect(() => {
    clock.current = { running: clockRunning, speed };
  }, [clockRunning, speed]);
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
      step(b, (seconds * c.speed) / 60, holdForLegs);
      bump();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [bump, legHold]);

  const act = (fn: (b: Board) => string | null) => {
    const b = boardRef.current;
    if (!b) return;
    const error = fn(b);
    setNotice(error);
    bump();
  };

  const actions: PanelActions = {
    closeFire: (fireId) => {
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
    windNow,
    // AI commander (monitoring is off by default; Claude is only called while it is on, and the
    // board clock runs only then). setAutopilot(true) also starts the clock.
    autopilot,
    setAutopilot: turnAgent,
    agent,
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
    restart,
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
