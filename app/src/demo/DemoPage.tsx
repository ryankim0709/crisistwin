import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, EvidenceTag, LoadingState, Metric, MetricGrid, Notice, SegmentedControl, Tag, type SegmentedOption } from "../ui";
import { fetchActive } from "../live/active";
import { DEFAULT_INCIDENT_ID, LiveError, readToken, triageReport } from "../live/api";
import DrillPicker from "../live/DrillPicker";
import { labelPoint } from "../live/format";
import type { CommandResponse, LonLat } from "../live/types";
import { useCommand } from "../live/useCommand";
import { usePoll } from "../live/usePoll";
import "../live/live.css";
import AgentConsole from "./AgentConsole";
import type { DemoOrder } from "./contracts";
import DemoDiorama from "./DemoDiorama";
import DemoLegend from "./DemoLegend";
import DemoMap, { type Selection } from "./DemoMap";
import { FIRE_STATUS, SOURCE_LABEL, TEAM_STATUS, nf, simClock } from "./format";
import {
  ACTIVITIES,
  ACTIVITY,
  activeFires,
  addReportFire,
  applyOrder,
  closeFire,
  createBoard,
  currentContainment,
  fireAreaHa,
  headOnWildlandFuel,
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
import SelectedPanel, { type PanelActions } from "./SelectedPanel";
import { kindShort, windAt } from "./realism";
import { useCrewRoutes } from "./useCrewRoutes";
import { useDemoAgent } from "./useDemoAgent";
import { WEATHER_PRESETS, useDemoEnvironment, zonesCenter } from "./useDemoEnvironment";
import { useDemoRoutes } from "./useDemoRoutes";
import { useArrivalField } from "./useArrivalField";
import { CONGESTION_LABEL, TRAVEL_LABEL } from "./observation";
import "./demo.css";

const TICK_MS = 200;
const ACTIVE_POLL_MS = 30_000;
/** Playback speeds: simulated minutes per real minute. */
const SPEEDS = [
  { value: "1", label: "1×", title: "Real time" },
  { value: "10", label: "10×", title: "Ten simulated minutes per minute" },
  { value: "30", label: "30×", title: "Thirty simulated minutes per minute" },
  { value: "60", label: "60×", title: "One simulated minute per second" },
  { value: "120", label: "120×", title: "Two simulated minutes per second" },
] as const;
type Speed = (typeof SPEEDS)[number]["value"];
/** Off by default: Claude is only called while monitoring is on (or by "Ask Claude now"). */
const MONITORING = [
  { value: "off", label: "Off", title: "Claude is not called" },
  { value: "on", label: "On", title: "Claude watches the board and acts when something changes" },
] as const;
type StageView = "map" | "diorama";
const VIEW_STORAGE_KEY = "crisistwin.demo.view";

function loadView(): StageView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "diorama" ? "diorama" : "map";
  } catch {
    return "map";
  }
}
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

export default function DemoPage() {
  const [token] = useState(() => readToken());
  // The board runs on the hosted instance's one active incident (Camp or a Studio drill package),
  // exactly as /live follows it; if it cannot be read the page falls back to the Camp drill.
  const active = usePoll(token, fetchActive, ACTIVE_POLL_MS, "Live API");
  const incidentId = active.data?.incident_id ?? DEFAULT_INCIDENT_ID;
  const command = useCommand(active.loading ? null : token, incidentId);
  // The poll keeps the previous incident's data until the new answer lands; ignore it meanwhile.
  const data = command.data?.incident_id === incidentId ? command.data : null;
  const [picking, setPicking] = useState(false);
  const boardRef = useRef<Board | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<Speed>("60");
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
  const [view, setView] = useState<StageView>(loadView);
  const chooseView = useCallback((next: StageView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this visit only.
    }
  }, []);

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
  const showDiorama = view === "diorama" && board !== null && landscape !== null;
  const viewOptions: SegmentedOption<StageView>[] = [
    { value: "map", label: "Map" },
    {
      value: "diorama",
      label: "3D diorama",
      disabled: !landscape,
      title: landscape
        ? `Stylized 3D miniature of ${board?.env.landscapeRegion?.name ?? "the drill region"}`
        : board
          ? "No prebuilt 3D landscape covers this drill, so only the map is available"
          : "Waiting for the board to load",
    },
  ];
  const fires = board
    ? activeFires(board).sort((a, b) => (a.status === b.status ? fireAreaHa(b) - fireAreaHa(a) : a.status === "burning" ? -1 : 1))
    : [];
  const threatenedHome = board
    ? board.zones.reduce((sum, z) => {
        const f = forecasts.get(z.id);
        return f?.edgeEta != null && z.overrunAt === null && z.orderedAt === null ? sum + z.households : sum;
      }, 0)
    : 0;

  let gate = null;
  if (!data) {
    gate = command.error ? (
      <div className="lc-token">
        <Notice tone="danger" compact>
          {command.error.unauthorized
            ? "The live API needs the controller token. Open Live command once to enter it, then come back."
            : command.error.message}
        </Notice>
        <Button variant="secondary" onClick={command.refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="lc-token">
        <LoadingState>Loading the drill map…</LoadingState>
      </div>
    );
  } else if (!board) {
    gate = (
      <div className="lc-token">
        <LoadingState>Loading wind, terrain and fire stations…</LoadingState>
      </div>
    );
  }

  return (
    <div className={`lc-root dm-root${board ? "" : " lc-root--gate"}`}>
      <header className="lc-head dm-head">
        <h1>Command demo</h1>
        <EvidenceTag kind="simulated" />
        <span className="lc-dim dm-drill-name" title={active.data?.label || undefined}>
          {active.data?.name ?? "Camp Fire 2018 replay"}
        </span>
        <Button size="sm" variant="secondary" disabled={!token} onClick={() => setPicking(true)}>
          Drill
        </Button>
        {board ? (
          <>
            <span className="dm-monitor">
              <span className="dm-monitor-label" aria-hidden="true">
                AI monitoring
              </span>
              <SegmentedControl
                label="AI monitoring"
                options={MONITORING}
                value={autopilot ? "on" : "off"}
                onChange={(value) => setAutopilot(value === "on")}
              />
            </span>
            <span className="lc-clock" aria-label="Simulation clock">
              <span className="lc-num">{simClock(board.minute)}</span>
            </span>
            <Button size="sm" variant="secondary" onClick={() => setRunning((r) => !r)} aria-pressed={!running}>
              {running ? "Pause" : "Resume"}
            </Button>
            <SegmentedControl label="Clock speed" options={SPEEDS} value={speed} onChange={setSpeed} />
            <SegmentedControl
              label="Fire activity"
              options={ACTIVITIES.map((a) => ({ value: a, label: ACTIVITY[a].label, title: `${ACTIVITY[a].label} fire activity` }))}
              value={activity}
              onChange={changeActivity}
            />
            <SegmentedControl
              label="Wind"
              options={WEATHER_PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.title }))}
              value={weather}
              onChange={setWeather}
            />
            {windNow ? (
              <span className="lc-dim lc-num" title={board.env.spread.wind.label}>
                Wind {windNow.speedMetersPerSecond.toFixed(1)} m/s from {Math.round(windNow.fromDegrees)}°
              </span>
            ) : null}
            <span className="lc-head-end">
              <Button size="sm" variant={igniteMode ? "primary" : "secondary"} aria-pressed={igniteMode} onClick={() => setIgniteMode((m) => !m)}>
                {igniteMode ? "Click the map to start a fire" : "Add fire"}
              </Button>
              <Button size="sm" variant="ghost" onClick={restart} title={`Seed ${board.seed}`}>
                Restart
              </Button>
            </span>
          </>
        ) : null}
      </header>

      {board ? (
        <aside className="lc-col lc-queue" aria-label="Fires and firefighting units">
          <div className="lc-col-head">
            <h2>Active fires</h2>
            <span className="lc-dim lc-num">
              {t!.burning} burning, {t!.contained} contained
            </span>
          </div>
          <div className="lc-col-scroll">
            {fires.length === 0 ? (
              <p className="dm-empty">No active fires. Watching for ignitions and field reports.</p>
            ) : (
              <ul className="lc-q-list" role="listbox" aria-label="Active fires">
                {fires.map((f) => {
                  const crews = board.teams.filter((tm) => tm.fireId === f.id).map((tm) => tm.id);
                  const eta = f.status === "burning" ? currentContainment(board, f) : null;
                  const selected = selection?.kind === "fire" && selection.id === f.id;
                  return (
                    <li
                      key={f.id}
                      role="option"
                      aria-selected={selected}
                      tabIndex={0}
                      className={`lc-q-row dm-fire-row${selected ? " is-selected" : ""}`}
                      onClick={() => setSelection({ kind: "fire", id: f.id })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelection({ kind: "fire", id: f.id });
                        }
                      }}
                    >
                      <span className={`dm-fire-glyph dm-fire-glyph--${f.status}`} aria-hidden="true" />
                      <span className="lc-q-body">
                        <span className="lc-q-title">
                          <strong>{f.id}</strong>
                          <Tag tone={FIRE_STATUS[f.status].tone}>{FIRE_STATUS[f.status].label}</Tag>
                          <Tag>{SOURCE_LABEL[f.source]}</Tag>
                        </span>
                        <span className="lc-q-meta lc-num">
                          {fireAreaHa(f).toFixed(1)} ha · {f.headRate} m/min · flame {Math.round(f.rates.headFlameFeet)} ft
                          {f.status === "burning" && !headOnWildlandFuel(f) ? " · no wildland fuel at head" : ""} · started{" "}
                          {simClock(f.ignitedAt)}
                        </span>
                        <span className={`lc-q-meta${f.status === "burning" && (crews.length === 0 || eta === null) ? " lc-error" : ""}`}>
                          {f.status !== "burning"
                            ? "Mopping up"
                            : crews.length === 0
                              ? "No units assigned"
                              : `${crews.join(", ")} · ${eta === null ? "outrunning its units" : `contained in about ${eta} min`}`}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="lc-col-head">
              <h2>Units</h2>
              <span className="lc-dim lc-num">{board.teams.filter((tm) => tm.status === "available").length} free</span>
            </div>
            <ul className="dm-teams">
              {board.teams.map((tm) => (
                <li key={tm.id}>
                  <button type="button" className="dm-team" onClick={() => setSelection({ kind: "team", id: tm.id })}>
                    <strong>{tm.id}</strong>
                    <span className="lc-dim">{kindShort(tm.kind)}</span>
                    <span className={`dm-team-status dm-team-status--${tm.status}`}>{TEAM_STATUS[tm.status]}</span>
                    <span className="lc-dim">
                      {tm.fireId ?? board.stations.find((s) => s.id === tm.station)?.name}
                      {tm.status === "en_route" && tm.arriveAt !== null ? `, ${Math.ceil(tm.arriveAt - board.minute)} min` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      ) : null}

      <main className="lc-stage">
        {showDiorama ? (
          <DemoDiorama
            board={board}
            version={version}
            field={field}
            landscape={landscape}
            regionName={board.env.landscapeRegion?.name ?? null}
            forecasts={forecasts}
            wind={windNow}
            selected={selection}
            igniteMode={igniteMode}
            onIgnite={onIgnite}
          />
        ) : (
          <DemoMap
            zones={data?.zones ?? []}
            destinations={data?.destinations ?? []}
            board={board}
            version={version}
            forecasts={forecasts}
            selected={selection}
            igniteMode={igniteMode}
            onSelect={setSelection}
            onIgnite={onIgnite}
          />
        )}
        {board && !showDiorama ? <DemoLegend /> : null}
        {board ? (
          <div className="dm-view">
            <SegmentedControl label="View" options={viewOptions} value={showDiorama ? "diorama" : "map"} onChange={chooseView} />
          </div>
        ) : null}
        {gate}
      </main>

      {board && t ? (
        <aside className="lc-col lc-right" aria-label="Commander, selection and shift record">
          <div className="lc-col-scroll">
            {notice ? (
              <div className="dm-section">
                <Notice tone="warning" compact>
                  {notice}
                </Notice>
              </div>
            ) : null}
            {routes.error ? (
              <div className="dm-section">
                <Notice tone="danger" compact>
                  Routes unavailable: {routes.error}
                </Notice>
              </div>
            ) : null}
            {selection ? (
              <SelectedPanel
                board={board}
                selection={selection}
                forecasts={forecasts}
                routes={routes.routes}
                actions={actions}
                onClose={() => setSelection(null)}
              />
            ) : null}
            <AgentConsole agent={agent} autopilot={autopilot} onAutopilot={setAutopilot} hold={hold} onHold={setHold} name={name} />
            <section className="dm-section" aria-label="Shift totals">
              <div className="dm-section-head">
                <h2>Since monitoring started</h2>
              </div>
              <MetricGrid>
                <Metric label="Households out" value={nf(t.out)} detail={`${nf(t.enRoute)} on the road now`} />
                <Metric label="At risk, no order" value={nf(threatenedHome)} detail="households in zones fire may reach" />
                <Metric label="Caught by fire" value={nf(t.caughtTotal)} detail="households, whole run" />
                <Metric label="No vehicle, at risk" value={nf(t.noVehicleAtRisk)} detail="households needing transport" />
                <Metric label="Fires out" value={nf(t.firesOutTotal)} detail={`${nf(t.burnedHa)} ha burned`} />
              </MetricGrid>
            </section>
            <section className="dm-section" aria-label="Activity log">
              <div className="dm-section-head">
                <h2>Activity</h2>
              </div>
              <ol className="dm-log">
                {board.events.slice(0, 60).map((e, i) => (
                  <li key={`${e.minute}-${i}-${e.text}`}>
                    <span className="lc-num lc-dim">{simClock(e.minute)}</span>
                    <span>
                      {e.actor !== "board" ? <Tag tone={e.actor === "agent" ? "info" : "brand"}>{e.actor === "agent" ? "Claude" : "You"}</Tag> : null}{" "}
                      {e.text}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="dm-section" aria-label="Model inputs">
              <div className="dm-section-head">
                <h2>Model inputs</h2>
              </div>
              <ul className="dm-note dm-inputs">
                <li>Wind: {board.env.spread.wind.label}; {board.env.spread.wind.heightNote}.</li>
                <li>Fuel: {board.env.spread.ground.fuelLabel}; moisture {ACTIVITY[activity].moisture} (Scott &amp; Burgan 2005).</li>
                <li>Terrain: {board.env.spread.ground.terrainLabel}.</li>
                <li>Stations: {board.env.basesLabel}.</li>
                <li>
                  Travel: {TRAVEL_LABEL}
                  {crewRoutes.error ? ` (road times unavailable: ${crewRoutes.error})` : ""}.
                </li>
                <li>Carless households: {board.env.noVehicleLabel}.</li>
                <li>Congestion: {CONGESTION_LABEL}.</li>
              </ul>
            </section>
            <p className="dm-note dm-footnote">
              Planning demo: fires, units and households are simulated on the {active.data?.name ?? "Camp Fire 2018 replay"}{" "}
              drill zones and roads. Not operational guidance.
            </p>
          </div>
        </aside>
      ) : null}
      {picking && token ? (
        <DrillPicker token={token} active={active.data} onSwitched={active.refresh} onClose={() => setPicking(false)} />
      ) : null}
    </div>
  );
}
