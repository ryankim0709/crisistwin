import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, EvidenceTag, LoadingState, Metric, MetricGrid, Notice, SegmentedControl, Tag } from "../ui";
import { LiveError, readToken, triageReport } from "../live/api";
import { labelPoint } from "../live/format";
import type { CommandResponse, LonLat } from "../live/types";
import { useCommand } from "../live/useCommand";
import "../live/live.css";
import AgentConsole from "./AgentConsole";
import type { DemoOrder } from "./contracts";
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
  ignite,
  setActivity,
  step,
  totals,
  zoneForecasts,
  type Activity,
  type BaseZone,
  type Board,
} from "./model";
import SelectedPanel, { type PanelActions } from "./SelectedPanel";
import { useDemoAgent } from "./useDemoAgent";
import { useDemoRoutes } from "./useDemoRoutes";
import "./demo.css";

const TICK_MS = 200;
/** Playback speeds: simulated minutes per real minute. */
const SPEEDS = [
  { value: "1", label: "1×", title: "Real time" },
  { value: "10", label: "10×", title: "Ten simulated minutes per minute" },
  { value: "30", label: "30×", title: "Thirty simulated minutes per minute" },
  { value: "60", label: "60×", title: "One simulated minute per second" },
  { value: "120", label: "120×", title: "Two simulated minutes per second" },
] as const;
type Speed = (typeof SPEEDS)[number]["value"];
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
  const command = useCommand(token);
  const data = command.data;
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

  // Start the board once the drill zones arrive.
  useEffect(() => {
    if (!data || boardRef.current) return;
    const created = createBoard(baseZones(data), activity, newSeed());
    boardRef.current = created;
    setBoard(created);
  }, [data, activity]);

  const restart = () => {
    if (!data) return;
    const created = createBoard(baseZones(data), activity, Math.floor(Math.random() * 2 ** 31));
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

  const routes = useDemoRoutes(board, version);
  const routesRef = useRef(routes.routes);
  useEffect(() => {
    routesRef.current = routes.routes;
  }, [routes.routes]);

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
  const agent = useDemoAgent({ board, version, routes: routes.routes, forecasts, enabled: autopilot, apply });

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

  const t = board ? totals(board) : null;
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
  }

  return (
    <div className={`lc-root dm-root ui-theme-dark${board ? "" : " lc-root--gate"}`}>
      <header className="lc-head dm-head">
        <h1>Command demo</h1>
        <EvidenceTag kind="simulated" />
        {board ? (
          <>
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
        <aside className="lc-col lc-queue" aria-label="Fires and strike teams">
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
                          {fireAreaHa(f).toFixed(1)} ha · {f.headRate} m/min · started {simClock(f.ignitedAt)}
                        </span>
                        <span className={`lc-q-meta${f.status === "burning" && (crews.length === 0 || eta === null) ? " lc-error" : ""}`}>
                          {f.status !== "burning"
                            ? "Mopping up"
                            : crews.length === 0
                              ? "No teams assigned"
                              : `${crews.join(", ")} · ${eta === null ? "outrunning its teams" : `contained in about ${eta} min`}`}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="lc-col-head">
              <h2>Strike teams</h2>
              <span className="lc-dim lc-num">{board.teams.filter((tm) => tm.status === "available").length} free</span>
            </div>
            <ul className="dm-teams">
              {board.teams.map((tm) => (
                <li key={tm.id}>
                  <button type="button" className="dm-team" onClick={() => setSelection({ kind: "team", id: tm.id })}>
                    <strong>{tm.id}</strong>
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
        {board ? <DemoLegend /> : null}
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
            <p className="dm-note dm-footnote">
              Planning demo: fires, strike teams and households are simulated on the 2018 Camp Fire drill zones and roads.
              Stations are synthetic. Not operational guidance.
            </p>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
