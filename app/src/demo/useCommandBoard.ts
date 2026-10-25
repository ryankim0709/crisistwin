import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveError, triageReport } from "../live/api";
import { labelPoint } from "../live/format";
import type { CommandResponse, LonLat } from "../live/types";
import type { DemoOrder } from "./contracts";
import type { Selection } from "./DemoMap";
import {
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
import { WEATHER_PRESETS, useDemoEnvironment, zonesCenter } from "./useDemoEnvironment";
import { useDemoRoutes } from "./useDemoRoutes";
import { useFireSolver } from "./useFireSolver";
import { useArrivalField } from "./useArrivalField";

/**
 * The simulated command board (fires, firefighting units, households) and the AI incident
 * commander, as one hook, so /live can run it beside the live drill. The logic is copied from
 * DemoPage.tsx and kept in the same order and with the same names, so the two diff cleanly.
 * Everything here is simulated in the browser on the drill's zones and roads; only open
 * fire_seen field reports flow in from the live drill (and resolving a fire resolves them).
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
  const [weather, setWeather] = useState<string>(WEATHER_PRESETS[0].value);
  const preset = WEATHER_PRESETS.find((p) => p.value === weather) ?? WEATHER_PRESETS[0];
  const zoneCentre = useMemo(() => (data ? zonesCenter(data.zones) : null), [data]);
  const env = useDemoEnvironment(preset, incidentId, zoneCentre);

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
    const created = createBoard(baseZones(data), activity, newSeed(), env);
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

  const restart = () => {
    if (!data || !env) return;
    const created = createBoard(baseZones(data), activity, Math.floor(Math.random() * 2 ** 31), env);
    boardRef.current = created;
    setBoard(created);
    setSelection(null);
    bump();
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
  // Keeps the fire field solved in a worker; the board clock holds while a needed solve runs.
  const solver = useFireSolver(board, version, bump);
  const agent = useDemoAgent({ board, version, incidentId, routes: routes.routes, forecasts, enabled: autopilot, apply });

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
    windNow,
    // AI commander (monitoring is off by default; Claude is only called while it is on)
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
