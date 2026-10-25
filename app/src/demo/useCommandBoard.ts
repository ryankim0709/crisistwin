import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveError, triageReport } from "../live/api";
import { labelPoint } from "../live/format";
import type { CommandResponse, LonLat } from "../live/types";
import type { DemoOrder, LiveOrder } from "./contracts";
import { runLiveOrders } from "./liveOrders";
import type { Selection } from "./DemoMap";
import {
  ACTIVITY,
  activeFires,
  addReportFire,
  applyOrder,
  closeFire,
  createBoard,
  fireAreaHa,
  ignite,
  setActivity,
  setRoutes,
  step,
  totals,
  zoneForecasts,
  type Activity,
  type BaseZone,
  type Board,
} from "./model";
import type { PanelActions } from "./SelectedPanel";
import { windAt } from "./realism";
import { useCrewRoutes } from "./useCrewRoutes";
import { useDemoAgent } from "./useDemoAgent";
import { DEFAULT_BOARD_RADIUS_METERS, boardCellMetersFor } from "../fire/boardSize";
import type { World } from "../world/contracts";
import { useWorldSync } from "../world/useWorldSync";
import { WEATHER_PRESETS, useDemoEnvironment, zonesCenter } from "./useDemoEnvironment";
import { useDemoRoutes } from "./useDemoRoutes";
import { useFireSolver } from "./useFireSolver";
import { useArrivalField } from "./useArrivalField";
import { buildIncidentPicture } from "./incidentPicture";
import { usePeople } from "../live/people";
import { useParticipants } from "../appint/api";

/**
 * The simulated command board (fires, firefighting units, households) and the AI incident
 * commander, as one hook, so /live can run it beside the live drill. The logic is copied from
 * DemoPage.tsx and kept in the same order and with the same names, so the two diff cleanly.
 * Everything here is simulated in the browser on the drill's zones and roads; open fire_seen
 * field reports flow in from the live drill as fires (and resolving a fire resolves them), and
 * the commander also reads the drill's incident picture (incidentPicture.ts: calls, help
 * requests, roads, check-ins, stuck people, participants), refreshed by the 3 s polls.
 */

const TICK_MS = 200;
/** Playback speeds: simulated minutes per real minute. */
export const BOARD_SPEEDS = [
  { value: "1", label: "1×", title: "Real time" },
  { value: "10", label: "10×", title: "Ten simulated minutes per minute" },
  { value: "30", label: "30×", title: "Thirty simulated minutes per minute" },
  { value: "60", label: "60×", title: "One simulated minute per second" },
  { value: "120", label: "120×", title: "Two simulated minutes per second" },
] as const;
export type BoardSpeed = (typeof BOARD_SPEEDS)[number]["value"];
/** Off by default: Claude is only called while monitoring is on (or by "Ask Claude now"). */
export const MONITORING = [
  { value: "off", label: "Off", title: "Claude is not called" },
  { value: "on", label: "On", title: "Claude watches the board and acts when something changes" },
] as const;
const OPEN_REPORT = new Set(["unverified", "corroborated", "responder_confirmed", "confirmed"]);

function baseZones(data: CommandResponse): BaseZone[] {
  return data.zones.flatMap((z) => {
    const polys = z.geometry.type === "Polygon" ? [z.geometry.coordinates] : z.geometry.coordinates;
    const ring = polys.map((p) => p[0] ?? []).sort((a, b) => b.length - a.length)[0];
    const core = labelPoint(z.geometry);
    return ring && ring.length >= 4 && core ? [{ id: z.id, name: z.name, households: z.households, ring, core }] : [];
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
}

export function useCommandBoard({ token, incidentId, data: commandData }: CommandBoardOptions) {
  // The poll keeps the previous incident's data until the new answer lands; ignore it meanwhile.
  const data = commandData?.incident_id === incidentId ? commandData : null;
  const boardRef = useRef<Board | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<BoardSpeed>("60");
  const [activity, setActivityState] = useState<Activity>("active");
  const [autopilot, setAutopilot] = useState(false);
  const [hold, setHold] = useState(true);
  const [igniteMode, setIgniteMode] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [weather, setWeatherState] = useState<string>(WEATHER_PRESETS[0].value);
  const preset = WEATHER_PRESETS.find((p) => p.value === weather) ?? WEATHER_PRESETS[0];
  const zoneCentre = useMemo(() => (data ? zonesCenter(data.zones) : null), [data]);
  // Board size: the shared world's region radius (docs/shared-world.md); never below 15 km here.
  const [radius, setRadius] = useState(DEFAULT_BOARD_RADIUS_METERS);
  const boardRadius = Math.max(DEFAULT_BOARD_RADIUS_METERS, radius);
  // The seed the next board starts from when the shared world names one.
  const worldSeed = useRef<number | null>(null);

  // Shared world: this board takes the world's size, weather (closest preset), seed and, when the
  // world's area is this drill, its centre; it writes what its user changes here.
  const sync = useWorldSync({
    tab: "live",
    local: null,
    apply: (w, changed) => {
      if (changed.has("region")) setRadius(w.region.radiusMeters);
      const weatherChanged = [...changed].some((p) => p.startsWith("conditions.weather.") || p === "conditions.startUtc");
      const closest = weatherChanged ? closestWeatherPreset(w) : null;
      if (closest) setWeatherState(closest);
      if (changed.has("fire.stochastic.seed")) {
        worldSeed.current = w.fire.stochastic.seed;
        const b = boardRef.current;
        if (b && b.seed !== w.fire.stochastic.seed) restartRef.current(w.fire.stochastic.seed);
      }
    },
  });
  const { write: writeWorld } = sync;
  const r = sync.world.region;
  // The world's centre drives the board only when it is this drill's area: an incident region of
  // this drill, or a region centred within 20 km of the drill's zones.
  const worldCentre: LonLat | null =
    sync.enabled && sync.loaded && sync.world.revision > 0 &&
    ((r.kind === "incident" && r.id === incidentId) ||
      (zoneCentre !== null && distanceMeters(zoneCentre, r.center) < 20_000))
      ? r.center
      : null;
  const setBoardRadius = useCallback(
    (radiusMeters: number) => {
      setRadius(radiusMeters);
      writeWorld({ region: { radiusMeters, cellMeters: boardCellMetersFor(radiusMeters) } });
    },
    [writeWorld],
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
  const env = useDemoEnvironment(preset, incidentId, zoneCentre, boardRadius, worldCentre);

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

  // A different drill: drop the board and selection; the effect below rebuilds it from the new data.
  useEffect(() => {
    boardRef.current = null;
    setBoard(null);
    setSelection(null);
    setNotice(null);
    setIgniteMode(false);
    bump();
  }, [incidentId, bump]);

  // Start the board once the drill zones and the fire inputs arrive.
  useEffect(() => {
    if (!data || !env || boardRef.current) return;
    const created = createBoard(baseZones(data), activity, worldSeed.current ?? newSeed(), env);
    boardRef.current = created;
    setBoard(created);
  }, [data, env, activity]);

  // A new weather choice swaps the inputs under the running board (fires keep their shape).
  useEffect(() => {
    const b = boardRef.current;
    if (!b || !env || b.env === env) return;
    b.env = env;
    bump();
  }, [env, bump]);

  const restartWith = (seed: number) => {
    if (!data || !env) return;
    const created = createBoard(baseZones(data), activity, seed, env);
    boardRef.current = created;
    setBoard(created);
    setSelection(null);
    bump();
  };
  const restartRef = useRef(restartWith);
  useEffect(() => {
    restartRef.current = restartWith;
  });
  /** "Restart board": a new seed, shared with the other tabs. */
  const restart = () => {
    if (!data || !env) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    restartWith(seed);
    worldSeed.current = seed;
    writeWorld({ fire: { stochastic: { seed } } });
  };
  /** The board's settings a saved scenario restores beyond the shared world. */
  const getExtras = () => ({ speed, activity, running, weather });
  const restoreExtras = (raw: unknown) => {
    const extras = raw as { speed?: unknown; activity?: unknown; running?: unknown } | undefined;
    if (!extras || typeof extras !== "object") return;
    if (BOARD_SPEEDS.some((s) => s.value === extras.speed)) setSpeed(extras.speed as BoardSpeed);
    if (typeof extras.running === "boolean") setRunning(extras.running);
    if (typeof extras.activity === "string" && extras.activity in ACTIVITY) changeActivity(extras.activity as Activity);
  };

  // Open fire_seen field reports from the live drill become fires (each report once).
  useEffect(() => {
    const b = boardRef.current;
    if (!b || !data) return;
    let changed = false;
    for (const r of data.reports) {
      if (r.kind === "fire_seen" && OPEN_REPORT.has(r.status) && !b.seenReports.includes(r.id)) {
        addReportFire(b, r.id, r.location.coord);
        changed = true;
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

  const routes = useDemoRoutes(board, version, incidentId);
  const routesRef = useRef(routes.routes);
  useEffect(() => {
    routesRef.current = routes.routes;
    if (boardRef.current) setRoutes(boardRef.current, routes.routes);
  }, [routes.routes, board]);
  const crewRoutes = useCrewRoutes(board, version, incidentId);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  const forecasts = useMemo(() => (board ? zoneForecasts(board) : new Map()), [board, version]);

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
    return runLiveOrders(t, id, d, orders, setNotice);
  }, []);
  // Keeps the fire field solved in a worker; the board clock holds while a needed solve runs.
  const solver = useFireSolver(board, version, bump);
  const agent = useDemoAgent({ board, version, incidentId, routes: routes.routes, forecasts, enabled: autopilot, apply, applyLive, picture });

  // The simulation clock. Holds while Claude decides, if asked to.
  const clock = useRef({ running, speed, hold, thinking: false });
  useEffect(() => {
    clock.current = { running, speed, hold, thinking: agent.status === "thinking" };
  }, [running, speed, hold, agent.status]);
  useEffect(() => {
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const seconds = Math.min(1, (now - last) / 1000);
      last = now;
      const b = boardRef.current;
      const c = clock.current;
      if (!b || !c.running || (c.hold && c.thinking)) return;
      step(b, (seconds * Number(c.speed)) / 60);
      bump();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [bump]);

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
      act((b) => closeFire(b, fireId));
      for (const id of reports) {
        triageReport(token ?? "", id, "resolve").catch((error: unknown) =>
          setNotice(`Fire closed, but the field report could not be resolved: ${error instanceof LiveError ? error.message : "Live API error."}`),
        );
      }
    },
    sendTeam: (teamId, fireId) => act((b) => applyOrder(b, { type: "send_crew", crew_id: teamId, fire_id: fireId }, routesRef.current, "you")),
    releaseTeam: (teamId) => act((b) => applyOrder(b, { type: "release_crew", crew_id: teamId }, routesRef.current, "you")),
    orderZone: (zoneId, destinationId) =>
      act((b) => applyOrder(b, { type: "order_evacuation", zone_id: zoneId, destination_id: destinationId }, routesRef.current, "you")),
  };

  const onIgnite = (coord: LonLat) => {
    act((b) => (ignite(b, coord, "manual", "you") ? null : "Too many active fires on the board."));
    setIgniteMode(false);
  };

  /** Rule-based response (run cards on new fires, extended-attack orders on IA failure); on by default. */
  const ruleResponse = board?.response.autoDispatch ?? true;
  const setRuleResponse = (on: boolean) => {
    const b = boardRef.current;
    if (!b) return;
    b.response.autoDispatch = on;
    b.response.autoEscalate = on;
    bump();
  };

  const changeActivity = (value: Activity) => {
    setActivityState(value);
    const b = boardRef.current;
    if (b) {
      setActivity(b, value);
      bump();
    }
  };

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const z of data?.zones ?? []) m.set(z.id, z.name);
    for (const d of data?.destinations ?? []) m.set(d.id, d.name);
    return m;
  }, [data]);
  const name = useCallback((id: string) => names.get(id) ?? id, [names]);

  const t = board ? totals(board, forecasts) : null;
  const windNow = board ? windAt(board.env.spread.wind, board.minute) : null;
  // The 3D view draws the prebuilt LANDFIRE region covering the drill; without one only the map shows.
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
    // Clock
    running,
    setRunning,
    speed,
    setSpeed,
    // Conditions
    activity,
    changeActivity,
    weather,
    setWeather,
    boardRadius,
    setBoardRadius,
    /** True while the landscape for a new board size is still loading. */
    boardLoading: env === null,
    // Shared world (docs/shared-world.md): sync state and the board's saved-scenario extras
    world: sync,
    getExtras,
    restoreExtras,
    windNow,
    // AI commander (monitoring is off by default; Claude is only called while it is on)
    picture,
    autopilot,
    setAutopilot,
    hold,
    setHold,
    agent,
    // Fire solver state (why a solve is running, last solve time, last error)
    solver,
    // Rule-based dispatch and escalation (demo/boardResponse.ts)
    ruleResponse,
    setRuleResponse,
    // Map interaction
    igniteMode,
    setIgniteMode,
    onIgnite,
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
    name,
    totals: t,
    threatenedHome,
    fires,
    landscape,
    field,
  };
}

export type CommandBoard = ReturnType<typeof useCommandBoard>;
