import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  Button,
  EvidenceTag,
  Field,
  IconButton,
  Kbd,
  LoadingState,
  Notice,
  Panel,
  SegmentedControl,
  type SegmentedOption,
} from "../ui";
import AgentControl from "../demo/AgentControl";
import AgentInputsPanel from "../demo/AgentInputsPanel";
import BoardClock from "./BoardClock";
import { attachBoardLayers, type BoardLayerInput, type BoardLayers, type BoardSelection } from "../demo/boardMapLayers";
import DemoDiorama from "../demo/DemoDiorama";
import { CONGESTION_LABEL, TRAVEL_LABEL, fireModelLabel, studioMoistureLabel, studioWindLabel } from "../demo/observation";
import SelectedPanel from "../demo/SelectedPanel";
import { AI_ONLY_TEXT, useCommandBoard } from "../demo/useCommandBoard";
import { usePredictedFire } from "../demo/usePredictedFire";
import { WorldBar } from "../world/WorldBar";
import { useRoadAccess } from "../demo/useRoadAccess";
import RoadClosureTool from "./RoadClosureTool";
import { useRoadClosures } from "./useRoadClosures";
import "../demo/demo.css";
// Explicit extension: on a case-insensitive disk "./ActivityFeed" could resolve to a sibling .ts module.
import ActivityFeed from "./ActivityFeed.tsx";
import AuditLog from "./AuditLog";
import DetailsDrawer from "./DetailsDrawer";
import ScenarioResources, { snapshotInputsLine } from "./ScenarioResources";
import { useScenarioSnapshot } from "./scenarioSnapshot";
import { useAuditLog } from "./useAuditLog";
import { useTriageKeys } from "./useTriageKeys";
// The keyboard shortcut popover's styles (lc-keys).
import "./activity.css";
import { useTaskRoute } from "./useTaskRoute";
import { fetchActive } from "./active";
import { DEFAULT_INCIDENT_ID, INCIDENT_GONE_EVENT, LiveError, readToken, runImpact, writeToken } from "./api";
import CommandMap, { EXTRA_LAYERS_BEFORE_ID, LAYER_KEYS, type LayerKey, type MapFocus } from "./CommandMap";
import EvacuationPicture from "./EvacuationPicture";
import MapLegend from "./MapLegend";
import { buildQueue, matches, type QueueFilter } from "./queue";
import ResponseRecord from "./ResponseRecord";
import GroundRecord from "./GroundRecord";
import { labelPoint } from "./format";
import StalePanel from "./StalePanel";
import SelectedItem, { type ImpactState, type RunAction } from "./SelectedItem";
import { useCommand } from "./useCommand";
import { usePoll } from "./usePoll";
import type { Decision } from "./types";
import { useTwin } from "./useTwin";
import Outcomes from "./Outcomes";
import RunStateStatus from "./RunStateStatus";
import { useRunStateSync } from "../demo/useRunStateSync";
import { PeopleSummary, usePeople } from "./people";
import HouseholdSummary from "./HouseholdSummary";
import { useHouseholdState } from "./useHouseholdState";
import { LiveBadge } from "./WorkspaceHeader";
import "./live.css";

const NO_DECISIONS: Decision[] = [];
// Fast, so the page follows Simulation Studio switching the live drill to its region quickly.
const ACTIVE_POLL_MS = 5_000;
const LAYER_LABEL: Record<LayerKey, string> = {
  zones: "Zones",
  fire: "Fire",
  reports: "Reports",
  roads: "Roads",
  shelters: "Shelters",
  people: "People",
  houses: "Houses",
  noTruck: "Roads trucks can't use",
  stations: "Fire stations",
};
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
        label="Help and keyboard shortcuts"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </IconButton>
      {open ? (
        <div className="lc-keys-pop" role="dialog" aria-label="Help and keyboard shortcuts">
          <p className="lc-keys-note">{AI_ONLY_TEXT}</p>
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
  // The hosted instance's one active incident; re-read every 5 s and right after a switch. If it
  // cannot be read, the console falls back to the default incident rather than staying blank.
  const active = usePoll(token, fetchActive, ACTIVE_POLL_MS, "Live API");
  // A request for an incident the server no longer knows means the drill was switched (e.g. by a
  // Studio run): re-read the active incident now instead of showing "Unknown incident" until the next poll.
  const refreshActive = active.refresh;
  useEffect(() => {
    window.addEventListener(INCIDENT_GONE_EVENT, refreshActive);
    return () => window.removeEventListener(INCIDENT_GONE_EVENT, refreshActive);
  }, [refreshActive]);
  // A Studio package has no 2018 ground or response record (docs/adr/0047-active-incident.md).
  const isPackage = active.data?.source === "package";
  const incidentId = active.data?.incident_id ?? DEFAULT_INCIDENT_ID;
  const incidentToken = active.loading ? null : token;
  const command = useCommand(incidentToken, incidentId);
  const twin = useTwin(incidentToken, incidentId);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  // No queue list on the page: keyboard triage walks the new items, 2018 record ones included.
  const filter: QueueFilter = "new";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const showRecord = true;
  const [actionError, setActionError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactState | null>(null);
  // One slide-over at a time: Details (right of the map) or the full audit log (left, by the feed).
  const [drawer, setDrawer] = useState<"details" | "audit" | null>(null);
  const detailsOpen = drawer === "details";
  const auditOpen = drawer === "audit";
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    zones: true,
    fire: true,
    reports: true,
    roads: true,
    shelters: true,
    // Off by default: the right column's outcomes are the board's people picture; this layer is the
    // drill traffic twin's separate one (its strip over the map has the counts and key when on).
    people: false,
    // Off by default: ~20k simulated houses are a heavy load and a busy map; fetched only while on.
    houses: false,
    noTruck: false,
    stations: true,
  });
  // A different incident: drop the selection and per-incident panels (the polls restart themselves).
  useEffect(() => {
    setSelectedId(null);
    setFocus(null);
    setImpact(null);
    setActionError(null);
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
  // Simulated household statuses (stand-ins from the scenario snapshot); polls only while Houses is on.
  const households = useHouseholdState(data && layers.houses ? incidentToken : null, incidentId);
  // The simulated board (fires, units, households) and the AI commander, on the drill's zones.
  const cb = useCommandBoard({ token, incidentId, data, studioBoardId: active.data?.region_id ?? null });
  const predictedFire = usePredictedFire(cb.board);
  // Controller drill road closures (close / reopen on the map); the board's units and zones route around them.
  const roadClosures = useRoadClosures({ token: unauthorized ? null : token, incidentId, board: cb.board, routes: cb.routes, bump: cb.bump });
  const { attach: attachClosures, claimsClick: claimsClosureClick, claimedClick: closureClaimed } = roadClosures;
  // The board's run state (who is home, waiting, evacuating, safe) saved to the database (demo/useRunStateSync.ts).
  const runState = useRunStateSync({ token: unauthorized ? null : token, incidentId, board: cb.board, forecasts: cb.forecasts });
  // The drill's resource snapshot (households, engines): drawer and zone panel.
  const snapshotState = useScenarioSnapshot(incidentToken, incidentId);
  const snapshot = snapshotState.data;
  const setBoardSelection = cb.setSelection;
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
  // One newest-first record of Claude's decisions, board events and live drill decisions.
  const audit = useAuditLog({
    agent: cb.agent,
    board: cb.board,
    version: cb.version,
    liveDecisions: data?.decisions ?? NO_DECISIONS,
    serverNow,
    name: cb.name,
  });
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
      if (id !== null) setBoardSelection(null);
    },
    [setBoardSelection],
  );
  const selectBoard = useCallback(
    (sel: BoardSelection | null) => {
      setBoardSelection(sel);
      if (sel) select(null);
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
    closedRoads: roadAccess.data?.closed_roads ?? null,
    showClosedRoads: layers.noTruck,
  };
  const boardInputRef = useRef(boardInput);
  const boardHandlers = useRef({ onSelect: selectBoard });
  useEffect(() => {
    // A click the road closure tool took (picking a road, a closed road) selects nothing on the board.
    boardHandlers.current = { onSelect: (sel) => (closureClaimed() ? undefined : selectBoard(sel)) };
  });
  useEffect(() => {
    boardInputRef.current = boardInput;
    boardLayers.current?.update(boardInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  }, [cb.board, cb.version, cb.forecasts, cb.routes.routes, cb.selection, roadAccess.data, layers.noTruck]);
  const onMapReady = useCallback((map: MapLibreMap) => {
    // First, so its click listener runs before the board layers' (they skip a click it took).
    const detachClosures = attachClosures(map);
    const layers = attachBoardLayers(map, EXTRA_LAYERS_BEFORE_ID, {
      onSelect: (sel) => boardHandlers.current.onSelect(sel),
    });
    boardLayers.current = layers;
    layers.update(boardInputRef.current);
    return () => {
      layers.dispose();
      boardLayers.current = null;
      detachClosures();
    };
  }, [attachClosures]);
  const interceptClick = useCallback(
    (e: Parameters<BoardLayers["claimsClick"]>[0]) => claimsClosureClick(e) || (boardLayers.current?.claimsClick(e) ?? false),
    [claimsClosureClick],
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

  const connect = (value: string) => {
    writeToken(value);
    if (value === token) refresh();
    else setToken(value);
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
  // Fires come only from Simulation Studio; a broken feed shows under "Needs you".
  const studioError = cb.studio.error
    ? cb.studio.error.status === 404
      ? "The Studio fire feed is not available on this server yet."
      : `Studio fire feed: ${cb.studio.error.message}`
    : null;
  // Live follows the AI agent: no twin-controller proposals here, only board and feed problems.
  const needsYou = !!cb.notice || !!cb.routes.error || !!studioError || (!!actionError && !selected);

  // Over the map it heads the column of map controls (people strip, layer toggles); over the 3D view it floats alone.
  const liveBadge = data ? (
    <LiveBadge
      data={data}
      receivedAt={command.receivedAt}
      now={now}
      connectionError={command.error ? command.error.message : null}
    />
  ) : null;

  return (
    <div className={`lc-root dm-root${data ? "" : " lc-root--gate"}`}>
      {data ? (
        <aside className="lc-col lc-feed" aria-label="Activity">
          <ActivityFeed
            board={board}
            version={cb.version}
            agent={cb.agent}
            liveDecisions={data.decisions ?? NO_DECISIONS}
            serverNow={serverNow}
            name={cb.name}
            onSelectBoard={selectBoard}
            onSelectReports={selectFromLog}
            onOpenAuditLog={() => setDrawer("audit")}
          />
        </aside>
      ) : null}
      <main className={`lc-stage${showDiorama ? " lc-stage--diorama" : ""}`}>
        {data && showDiorama ? liveBadge : null}
        <CommandMap
          data={data}
          twin={twinData}
          people={peopleData}
          households={layers.houses ? households : null}
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
            {liveBadge}
            {layers.people ? <PeopleSummary snapshot={peopleData} error={people.error} /> : null}
            {layers.houses ? <HouseholdSummary state={households} /> : null}
            <LayerToggles
              layers={layers}
              onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
            />
          </div>
        ) : null}
        {data && !showDiorama && board ? <RoadClosureTool state={roadClosures} /> : null}
        {data && !showDiorama ? <MapLegend record={!isPackage} board={!!board} houses={layers.houses} /> : null}
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
            predictedFire={predictedFire}
          />
        ) : null}
        {data ? (
          <div className="dm-view">
            <SegmentedControl label="View" options={viewOptions} value={showDiorama ? "diorama" : "map"} onChange={chooseView} />
          </div>
        ) : null}
        {data && (selected || (board && cb.selection)) ? (
          <Panel glass compact className="lc-float" aria-label="Selection">
            {selected ? (
              <>
                {actionError ? (
                  <Notice tone="danger" compact>
                    {actionError}
                  </Notice>
                ) : null}
                <SelectedItem
                  key={selected.id}
                  item={selected}
                  data={data}
                  serverNow={serverNow}
                  run={run}
                  busy={busy}
                  impact={impact}
                  route={taskRoute}
                  onRunImpact={() => void onRunImpact()}
                  onClose={() => select(null)}
                />
              </>
            ) : null}
            {board && cb.selection ? (
              <>
                <p className="lc-board-note lc-board-sel-note">
                  <EvidenceTag kind="simulated" /> Selected on the simulated board
                </p>
                <SelectedPanel
                  board={board}
                  selection={cb.selection}
                  forecasts={cb.forecasts}
                  routes={cb.routes.routes}
                  actions={cb.actions}
                  snapshot={snapshot}
                  onClose={() => selectBoard(null)}
                />
              </>
            ) : null}
          </Panel>
        ) : null}
        {data ? (
          <DetailsDrawer open={detailsOpen} onClose={() => setDrawer(null)}>
            <ScenarioResources state={snapshotState} />
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
            <div className="dm-section lc-drawer-audit">
              <Button variant="secondary" size="sm" onClick={() => setDrawer("audit")}>
                Open the full audit log
              </Button>
              <span className="lc-dim">Every decision and board event, newest first, with filters.</span>
            </div>
            {board ? (
              <>
                <details className="dm-section lc-board-sec">
                  <summary>
                    <h2>Board model inputs</h2>
                  </summary>
                  <ul className="dm-note dm-inputs">
                    <li>Fire spread: {fireModelLabel(board)}.</li>
                    <li>
                      Wind: {studioWindLabel(board) ?? "none yet; it comes from the Simulation Studio run that starts a fire"}.
                    </li>
                    <li>
                      Fuel: {board.env.spread.ground.fuelLabel}; moisture{" "}
                      {studioMoistureLabel(board) ?? "none yet; it comes from the Simulation Studio run that starts a fire"}.
                    </li>
                    <li>Terrain: {board.env.spread.ground.terrainLabel}.</li>
                    <li>Stations: {board.env.basesLabel}.</li>
                    <li>
                      Travel: {TRAVEL_LABEL}
                      {cb.crewRoutes.error ? ` (road times unavailable: ${cb.crewRoutes.error})` : ""}.
                    </li>
                    <li>Carless households: {board.env.noVehicleLabel}.</li>
                    <li>
                      Households and engines:{" "}
                      {snapshot ? snapshotInputsLine(snapshot) : "no resource snapshot loaded (see Scenario resources)"}.
                    </li>
                    <li>Congestion: {CONGESTION_LABEL}.</li>
                  </ul>
                </details>
                <p className="dm-note dm-footnote">
                  Simulated board: fires, units and households are simulated in this browser on the {drillName} zones and
                  roads. Fires start only from Simulation Studio runs; drill fire reports only join a fire already there.
                  {" "}{AI_ONLY_TEXT} The board clock runs only while the AI agent is on. Not operational guidance.
                </p>
              </>
            ) : null}
          </DetailsDrawer>
        ) : null}
        {data ? (
          <DetailsDrawer open={auditOpen} onClose={() => setDrawer(null)} title="Full audit log" side="left" fill>
            <AuditLog
              entries={audit.entries}
              pending={audit.pending}
              now={serverNow}
              onSelectReports={selectFromLog}
              onSelectBoard={selectBoard}
            />
          </DetailsDrawer>
        ) : null}
        {gate}
      </main>
      {data ? (
        <aside className="lc-col lc-right" aria-label="Evacuation outcomes and simulation controls">
          <div className="lc-right-scroll">
            {needsYou ? (
              <section className="lc-needs" aria-labelledby="lc-needs-title">
                <header className="lc-needs-head">
                  <h2 id="lc-needs-title">Needs you</h2>
                </header>
                {studioError ? (
                  <Notice tone="warning" compact>
                    {studioError}
                  </Notice>
                ) : null}
                {cb.notice ? (
                  <div className="lc-needs-notice">
                    <Notice tone="warning" compact>
                      {cb.notice}
                    </Notice>
                    <Button variant="ghost" size="sm" onClick={() => cb.setNotice(null)}>
                      Dismiss
                    </Button>
                  </div>
                ) : null}
                {cb.routes.error ? (
                  <Notice tone="danger" compact>
                    Board routes unavailable: {cb.routes.error}
                  </Notice>
                ) : null}
                {actionError && !selected ? (
                  <Notice tone="danger" compact>
                    {actionError}
                  </Notice>
                ) : null}
              </section>
            ) : null}
            <Outcomes board={board} version={cb.version} forecasts={cb.forecasts} />
            <AgentInputsPanel agent={cb.agent} board={board} forecasts={cb.forecasts} showSpend={false} />
          </div>
          <section className="lc-sim" aria-labelledby="lc-sim-title">
            <header className="lc-sim-head">
              <h2 id="lc-sim-title">Controls</h2>
              <span className="lc-sim-aside">
                <ShortcutHint />
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={detailsOpen}
                  aria-haspopup="dialog"
                  onClick={() => setDrawer((d) => (d === "details" ? null : "details"))}
                >
                  Details
                </Button>
              </span>
            </header>
            {/* The AI agent first: it drives the clock (AI agent only, useCommandBoard clockPause). */}
            <AgentControl agent={cb.agent} ready={!!board} autopilot={cb.autopilot} onAutopilot={cb.setAutopilot} />
            <BoardClock board={cb} />
            <RunStateStatus sync={runState} ready={!!cb.board} />
            {/* Shared world (docs/shared-world.md): this tab's size, weather, seed and saved scenarios. */}
            <WorldBar
              tab="live"
              sync={cb.world}
              getExtras={cb.getExtras}
              onLoaded={(saved) => cb.restoreExtras(saved.extras.live)}
              placement="up"
              align="end"
            />
          </section>
        </aside>
      ) : null}
    </div>
  );
}
