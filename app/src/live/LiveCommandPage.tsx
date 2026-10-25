import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  Button,
  EvidenceTag,
  Field,
  IconButton,
  Kbd,
  LoadingState,
  Metric,
  MetricGrid,
  Notice,
  SegmentedControl,
  Tag,
  type SegmentedOption,
} from "../ui";
import AgentConsole from "../demo/AgentConsole";
import BoardLists from "../demo/BoardLists";
import { attachBoardLayers, type BoardLayerInput, type BoardLayers, type BoardSelection } from "../demo/boardMapLayers";
import DemoDiorama from "../demo/DemoDiorama";
import { nf, simClock } from "../demo/format";
import { ACTIVITY } from "../demo/model";
import { CONGESTION_LABEL, TRAVEL_LABEL } from "../demo/observation";
import SelectedPanel from "../demo/SelectedPanel";
import { useCommandBoard } from "../demo/useCommandBoard";
import { WorldBar } from "../world/WorldBar";
import { useRoadAccess } from "../demo/useRoadAccess";
import "../demo/demo.css";
import ActivityLog from "./ActivityLog";
import { useTriageKeys } from "./useTriageKeys";
import "./activity.css";
import { useTaskRoute } from "./useTaskRoute";
import { fetchActive } from "./active";
import { DEFAULT_INCIDENT_ID, LiveError, readToken, runImpact, SERVER_TOKEN, writeToken } from "./api";
import CommandMap, { EXTRA_LAYERS_BEFORE_ID, LAYER_KEYS, type LayerKey, type MapFocus } from "./CommandMap";
import EvacuationPicture from "./EvacuationPicture";
import MapLegend from "./MapLegend";
import ProposalPanel from "./ProposalPanel";
import { buildQueue, matches, proposalFor, type QueueFilter } from "./queue";
import ResponseRecord from "./ResponseRecord";
import GroundRecord from "./GroundRecord";
import { labelPoint } from "./format";
import StalePanel from "./StalePanel";
import ReviewQueue from "./ReviewQueue";
import SelectedItem, { type ImpactState, type RunAction } from "./SelectedItem";
import { useCommand } from "./useCommand";
import { usePoll } from "./usePoll";
import { useTwin } from "./useTwin";
import { PeopleSummary, usePeople } from "./people";
import WorkspaceHeader, { BoardControls } from "./WorkspaceHeader";
import "./live.css";

const HIGHLIGHT_MS = 2_500;
const ACTIVE_POLL_MS = 30_000;
const LAYER_LABEL: Record<LayerKey, string> = {
  zones: "Zones",
  fire: "Fire",
  reports: "Reports",
  roads: "Roads",
  shelters: "Shelters",
  people: "People",
  noTruck: "Roads trucks can't use",
};
type LeftTab = "reports" | "board";
const LEFT_TABS: SegmentedOption<LeftTab>[] = [
  { value: "reports", label: "Reports", title: "Field reports from the live drill" },
  { value: "board", label: "Fires & units", title: "Simulated fires and firefighting units" },
];
type StageView = "map" | "diorama";
const VIEW_STORAGE_KEY = "crisistwin.live.view";

function loadView(): StageView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "diorama" ? "diorama" : "map";
  } catch {
    return "map";
  }
}

function TokenForm({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="lc-token" onSubmit={submit}>
      <Field label="Controller token">
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={!value.trim()}>
        Connect
      </Button>
      {error ? (
        <Notice tone="danger" compact>
          {error}
        </Notice>
      ) : null}
    </form>
  );
}

/** Map layer toggles; each one is also its legend entry. */
function LayerToggles({
  layers,
  onToggle,
}: {
  layers: Record<LayerKey, boolean>;
  onToggle: (key: LayerKey) => void;
}) {
  return (
    <div className="lc-layers" role="group" aria-label="Map layers">
      {LAYER_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          className="lc-layer"
          aria-pressed={layers[key]}
          onClick={() => onToggle(key)}
        >
          <span className={`lc-sw lc-sw--${key}`} aria-hidden="true" />
          {LAYER_LABEL[key]}
        </button>
      ))}
    </div>
  );
}

const KEY_HINTS: [string, string][] = [
  ["j / k", "Next, previous"],
  ["c", "Confirm"],
  ["d", "Dismiss"],
  ["r", "Resolve"],
  ["Esc", "Clear selection"],
];

function ShortcutHint() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="lc-keys" ref={ref}>
      <IconButton
        label="Keyboard shortcuts"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </IconButton>
      {open ? (
        <div className="lc-keys-pop" role="dialog" aria-label="Keyboard shortcuts">
          {KEY_HINTS.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <span>
                <Kbd>{k}</Kbd>
              </span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Re-renders every `ms` so clocks and ages advance between polls. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export default function LiveCommandPage() {
  const [token, setToken] = useState<string | null>(() => readToken());
  // The hosted instance's one active incident; re-read every 30 s and right after a switch. If it
  // cannot be read, the console falls back to the default incident rather than staying blank.
  const active = usePoll(token, fetchActive, ACTIVE_POLL_MS, "Live API");
  // A Studio package has no 2018 ground or response record (docs/adr/0047-active-incident.md).
  const isPackage = active.data?.source === "package";
  const incidentId = active.data?.incident_id ?? DEFAULT_INCIDENT_ID;
  const incidentToken = active.loading ? null : token;
  const command = useCommand(incidentToken, incidentId);
  const twin = useTwin(incidentToken, incidentId);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactState | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    zones: true,
    fire: true,
    reports: true,
    roads: true,
    shelters: true,
    people: true,
    noTruck: false,
  });
  // A different incident: drop the selection and per-incident panels (the polls restart themselves).
  useEffect(() => {
    setSelectedId(null);
    setFocus(null);
    setImpact(null);
    setActionError(null);
    setHighlight(null);
  }, [incidentId]);
  const now = useNow(1000);
  const busyRef = useRef(false);
  const { refresh } = command;

  const run = useCallback<RunAction>(
    async (key, action) => {
      if (!token || busyRef.current) return null;
      busyRef.current = true;
      setBusy(key);
      try {
        await action(token, incidentId);
        return null;
      } catch (error) {
        return error instanceof LiveError ? error.message : "Action failed.";
      } finally {
        busyRef.current = false;
        setBusy(null);
        refresh();
      }
    },
    [token, incidentId, refresh],
  );

  const unauthorized = command.error?.unauthorized ?? false;
  const data = unauthorized ? null : command.data;
  const twinData = data ? twin.data : null;
  // The simulated people picture polls only while its layer is on.
  const people = usePeople(data && layers.people ? incidentToken : null, incidentId);
  const peopleData = data && layers.people ? people.data : null;
  // The simulated board (fires, units, households) and the AI commander, on the drill's zones.
  const cb = useCommandBoard({ token, incidentId, data });
  const setBoardSelection = cb.setSelection;
  const [leftTab, setLeftTab] = useState<LeftTab>("reports");
  const [view, setView] = useState<StageView>(loadView);
  const chooseView = useCallback((next: StageView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this visit only.
    }
  }, []);
  const serverNow =
    data && command.receivedAt !== null
      ? new Date(data.generated_at).getTime() + (now - command.receivedAt)
      : now;
  // The queue re-sorts on each poll only, so rows do not jump while ages tick.
  const items = useMemo(
    () => (data ? buildQueue(data, new Date(data.generated_at).getTime()) : []),
    [data],
  );
  const selected = items.find((i) => i.id === selectedId) ?? null;
  // Hiding 2018 record items keeps the selected one listed, as filters do.
  const listed = useMemo(
    () => (showRecord ? items : items.filter((i) => !i.record || i.id === selectedId)),
    [items, showRecord, selectedId],
  );
  const routeTask =
    selected?.task && (selected.task.status === "open" || selected.task.status === "accepted")
      ? selected.task.id
      : null;
  const taskRoute = useTaskRoute(data ? token : null, routeTask);

  // A map click selects an item outside the current filter too; the queue keeps it listed.
  // Live items and board items are selected separately; selecting one clears the other.
  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setActionError(null);
      setFocus(null);
      setImpact((cur) => (cur && cur.itemId === id ? cur : null));
      if (id !== null) {
        setBoardSelection(null);
        setLeftTab("reports");
      }
    },
    [setBoardSelection],
  );
  const selectBoard = useCallback(
    (sel: BoardSelection | null) => {
      setBoardSelection(sel);
      if (sel) {
        select(null);
        if (sel.kind !== "zone") setLeftTab("board");
      }
    },
    [setBoardSelection, select],
  );

  // The board's map layers, drawn on the live map (demo/boardMapLayers.ts). The handlers and the
  // latest input sit in refs: CommandMap calls onMapReady once, at load.
  const boardLayers = useRef<BoardLayers | null>(null);
  const roadAccess = useRoadAccess(incidentId, !!cb.board);
  const boardInput: BoardLayerInput = {
    board: cb.board,
    forecasts: cb.forecasts,
    routes: cb.routes.routes,
    selection: cb.selection,
    igniteMode: cb.igniteMode,
    closedRoads: roadAccess.data?.closed_roads ?? null,
    showClosedRoads: layers.noTruck,
  };
  const boardInputRef = useRef(boardInput);
  const boardHandlers = useRef({ onSelect: selectBoard, onIgnite: cb.onIgnite });
  useEffect(() => {
    boardHandlers.current = { onSelect: selectBoard, onIgnite: cb.onIgnite };
  });
  useEffect(() => {
    boardInputRef.current = boardInput;
    boardLayers.current?.update(boardInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  }, [cb.board, cb.version, cb.forecasts, cb.routes.routes, cb.selection, cb.igniteMode, roadAccess.data, layers.noTruck]);
  const onMapReady = useCallback((map: MapLibreMap) => {
    const layers = attachBoardLayers(map, EXTRA_LAYERS_BEFORE_ID, {
      onSelect: (sel) => boardHandlers.current.onSelect(sel),
      onIgnite: (coord) => boardHandlers.current.onIgnite(coord),
    });
    boardLayers.current = layers;
    layers.update(boardInputRef.current);
    return () => {
      layers.dispose();
      boardLayers.current = null;
    };
  }, []);
  const interceptClick = useCallback(
    (e: Parameters<BoardLayers["claimsClick"]>[0]) => boardLayers.current?.claimsClick(e) ?? false,
    [],
  );

  const onRunImpact = async () => {
    if (!token || !selected?.segmentId) return;
    const itemId = selected.id;
    setImpact({ itemId, loading: true, result: null, error: null });
    try {
      const result = await runImpact(token, incidentId, { segment_id: selected.segmentId });
      setImpact((cur) =>
        cur?.itemId === itemId ? { itemId, loading: false, result, error: null } : cur,
      );
    } catch (error) {
      const message = error instanceof LiveError ? error.message : "Impact analysis failed.";
      setImpact((cur) =>
        cur?.itemId === itemId ? { itemId, loading: false, result: null, error: message } : cur,
      );
    }
  };

  const shown = useMemo(
    () => listed.filter((i) => matches(i, filter) || i.id === selectedId),
    [listed, filter, selectedId],
  );
  useTriageKeys({ shown, selected, busy, run, onSelect: select, onError: setActionError });

  const selectFromLog = (reportIds: string[]) => {
    const hit = items.find((i) => i.reports.some((r) => reportIds.includes(r.id)));
    if (hit) select(hit.id);
    return !!hit;
  };

  const reviewProposal = (id: string) => {
    setHighlight(id);
    const el = document.getElementById(`lc-prop-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!highlight) return;
    const id = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(id);
  }, [highlight]);

  const connect = (value: string) => {
    writeToken(value);
    if (value === token) refresh();
    else setToken(value);
  };
  const signOut = () => {
    writeToken(null);
    setToken(null);
  };

  let gate = null;
  if (!token || unauthorized) {
    gate = <TokenForm error={unauthorized ? command.error!.message : null} onSubmit={connect} />;
  } else if (!data) {
    gate = command.error ? (
      <div className="lc-token">
        <Notice tone="danger" compact>
          {command.error.message}
        </Notice>
        <Button variant="secondary" onClick={refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="lc-token">
        <LoadingState>Loading the incident…</LoadingState>
      </div>
    );
  }

  const impactResult = impact && selected && impact.itemId === selected.id ? impact.result : null;

  const board = cb.board;
  const t = cb.totals;
  // The 3D view draws the prebuilt LANDFIRE region covering the drill; without one only the map shows.
  const landscape = cb.landscape;
  const showDiorama = view === "diorama" && board !== null && landscape !== null;
  const viewOptions: SegmentedOption<StageView>[] = [
    { value: "map", label: "Map" },
    {
      value: "diorama",
      label: "3D diorama",
      disabled: !landscape,
      title: landscape
        ? `Stylized 3D miniature of ${board?.env.landscapeRegion?.name ?? "the drill region"} (simulated board only)`
        : board
          ? "No prebuilt 3D landscape covers this drill, so only the map is available"
          : "Waiting for the simulated board to load",
    },
  ];
  const drillName = data?.incident?.name ?? active.data?.name ?? "this drill";

  return (
    <div className={`lc-root dm-root${data ? "" : " lc-root--gate"}`}>
      <WorkspaceHeader
        data={data}
        twin={twinData}
        receivedAt={command.receivedAt}
        now={now}
        connectionError={data && command.error ? command.error.message : null}
        run={run}
        busy={busy}
        onSignOut={token && token !== SERVER_TOKEN ? signOut : null}
        token={token}
        active={active.data}
        onSwitched={active.refresh}
      >
        {data ? <BoardControls board={cb} /> : null}
        <WorldBar
          tab="live"
          sync={cb.world}
          getExtras={cb.getExtras}
          onLoaded={(saved) => cb.restoreExtras(saved.extras.live)}
        />
      </WorkspaceHeader>
      {data ? (
        <div className="lc-col lc-queue lc-left">
          <SegmentedControl label="Left column" options={LEFT_TABS} value={leftTab} onChange={setLeftTab} className="lc-left-tabs" />
          {leftTab === "reports" ? (
            <ReviewQueue
              items={listed}
              showRecord={showRecord}
              onShowRecord={setShowRecord}
              hasRecord={!isPackage}
              filter={filter}
              onFilter={setFilter}
              selectedId={selectedId}
              onSelect={select}
              serverNow={serverNow}
            />
          ) : (
            <BoardLists board={cb} onSelect={selectBoard} />
          )}
        </div>
      ) : null}
      <main className={`lc-stage${showDiorama ? " lc-stage--diorama" : ""}`}>
        <CommandMap
          data={data}
          twin={twinData}
          people={peopleData}
          items={items}
          selected={selected}
          focus={focus}
          layers={layers}
          impact={impactResult}
          taskRoute={taskRoute?.route?.route?.line ?? null}
          onSelect={select}
          onMapReady={onMapReady}
          interceptClick={interceptClick}
        />
        {data && !showDiorama ? (
          <div className="lc-map-top">
            {layers.people ? <PeopleSummary snapshot={peopleData} error={people.error} /> : null}
            <LayerToggles
              layers={layers}
              onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
            />
          </div>
        ) : null}
        {data && !showDiorama ? <MapLegend record={!isPackage} board={!!board} /> : null}
        {/* The map stays mounted under the diorama, so its view and board layers survive a switch. */}
        {showDiorama && board && landscape ? (
          <DemoDiorama
            board={board}
            version={cb.version}
            field={cb.field}
            landscape={landscape}
            regionName={board.env.landscapeRegion?.name ?? null}
            forecasts={cb.forecasts}
            wind={cb.windNow}
            selected={cb.selection}
            igniteMode={cb.igniteMode}
            onIgnite={cb.onIgnite}
          />
        ) : null}
        {data ? (
          <div className="dm-view">
            <SegmentedControl label="View" options={viewOptions} value={showDiorama ? "diorama" : "map"} onChange={chooseView} />
          </div>
        ) : null}
        {gate}
      </main>
      {data ? (
        <aside className="lc-col lc-right" aria-label="Decisions and evacuation picture">
          <div className="lc-col-scroll">
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 8px 0" }}>
              <ShortcutHint />
            </div>
            {board ? (
              <AgentConsole
                agent={cb.agent}
                autopilot={cb.autopilot}
                onAutopilot={cb.setAutopilot}
                hold={cb.hold}
                onHold={cb.setHold}
                name={cb.name}
              />
            ) : (
              <section className="dm-section" aria-label="AI incident commander">
                <LoadingState>Loading the simulated board…</LoadingState>
              </section>
            )}
            {cb.notice ? (
              <div className="dm-section">
                <Notice tone="warning" compact>
                  {cb.notice}
                </Notice>
              </div>
            ) : null}
            {cb.routes.error ? (
              <div className="dm-section">
                <Notice tone="danger" compact>
                  Board routes unavailable: {cb.routes.error}
                </Notice>
              </div>
            ) : null}
            {board && cb.selection ? (
              <p className="lc-board-note lc-board-sel-note">
                <EvidenceTag kind="simulated" /> Selected on the simulated board
              </p>
            ) : null}
            {board && cb.selection ? (
              <SelectedPanel
                board={board}
                selection={cb.selection}
                forecasts={cb.forecasts}
                routes={cb.routes.routes}
                actions={cb.actions}
                onClose={() => selectBoard(null)}
              />
            ) : null}
            <ProposalPanel
              data={data}
              twin={twinData}
              run={run}
              busy={busy}
              serverNow={serverNow}
              highlightId={highlight}
            />
            {actionError ? (
              <Notice tone="danger" compact>
                {actionError}
              </Notice>
            ) : null}
            {selected ? (
              <SelectedItem
                key={selected.id}
                item={selected}
                data={data}
                serverNow={serverNow}
                run={run}
                busy={busy}
                impact={impact}
                route={taskRoute}
                proposalId={proposalFor(selected, data)}
                onRunImpact={() => void onRunImpact()}
                onReviewProposal={reviewProposal}
                onClose={() => select(null)}
              />
            ) : null}
            <StalePanel
              items={data.stale_critical}
              tasks={data.tasks}
              serverNow={serverNow}
              onFocus={setFocus}
            />
            <EvacuationPicture
              data={data}
              twin={twinData}
              twinError={twin.error}
              onFocus={setFocus}
            />
            <GroundRecord
              record={data.ground_record}
              zones={data.zones}
              onFocusZone={(id) => {
                const zone = data.zones.find((z) => z.id === id);
                const coord = zone ? labelPoint(zone.geometry) : null;
                if (coord) setFocus({ id: `zone:${id}`, coord });
              }}
            />
            {isPackage ? null : <ResponseRecord items={data.response_record ?? []} />}
            <ActivityLog
              decisions={data.decisions ?? []}
              serverNow={serverNow}
              onSelect={selectFromLog}
            />
            {board && t ? (
              <>
                <details className="dm-section lc-board-sec" open>
                  <summary>
                    <h2>Simulated board totals</h2>
                    <EvidenceTag kind="simulated" />
                  </summary>
                  <MetricGrid>
                    <Metric label="Households out" value={nf(t.out)} detail={`${nf(t.enRoute)} on the road now`} />
                    <Metric label="At risk, no order" value={nf(cb.threatenedHome)} detail="households in zones fire may reach" />
                    <Metric label="Caught by fire" value={nf(t.caughtTotal)} detail="households, whole run" />
                    <Metric label="No vehicle, at risk" value={nf(t.noVehicleAtRisk)} detail="households needing transport" />
                    <Metric label="Fires out" value={nf(t.firesOutTotal)} detail={`${nf(t.burnedHa)} ha burned`} />
                  </MetricGrid>
                </details>
                <details className="dm-section lc-board-sec">
                  <summary>
                    <h2>Board activity</h2>
                    <EvidenceTag kind="simulated" />
                  </summary>
                  <ol className="dm-log">
                    {board.events.slice(0, 60).map((e, i) => (
                      <li key={`${e.minute}-${i}-${e.text}`}>
                        <span className="lc-num lc-dim">{simClock(e.minute)}</span>
                        <span>
                          {e.actor !== "board" ? (
                            <Tag tone={e.actor === "agent" ? "info" : "brand"}>{e.actor === "agent" ? "Claude" : "You"}</Tag>
                          ) : null}{" "}
                          {e.text}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
                <details className="dm-section lc-board-sec">
                  <summary>
                    <h2>Board model inputs</h2>
                  </summary>
                  <ul className="dm-note dm-inputs">
                    <li>Wind: {board.env.spread.wind.label}; {board.env.spread.wind.heightNote}.</li>
                    <li>Fuel: {board.env.spread.ground.fuelLabel}; moisture {ACTIVITY[cb.activity].moisture} (Scott &amp; Burgan 2005).</li>
                    <li>Terrain: {board.env.spread.ground.terrainLabel}.</li>
                    <li>Stations: {board.env.basesLabel}.</li>
                    <li>
                      Travel: {TRAVEL_LABEL}
                      {cb.crewRoutes.error ? ` (road times unavailable: ${cb.crewRoutes.error})` : ""}.
                    </li>
                    <li>Carless households: {board.env.noVehicleLabel}.</li>
                    <li>Congestion: {CONGESTION_LABEL}.</li>
                  </ul>
                </details>
                <p className="dm-note dm-footnote">
                  Simulated board: fires, units and households are simulated in this browser on the {drillName} zones and
                  roads; only fire reports come from the drill. Not operational guidance.
                </p>
              </>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
