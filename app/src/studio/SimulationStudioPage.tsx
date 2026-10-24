import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { GeoPoint } from "../fire/spread";
import type { ScheduledFireRun } from "../fire/scheduledTypes";
import { formatElapsed } from "../fire/spread";
import ConfigPanel from "./ConfigPanel";
import LiveDrillAction from "./LiveDrillAction";
import PlaybackBar from "./PlaybackBar";
import StudioDiorama, { type StudioEvacuationView } from "./StudioDiorama";
import EvacuationPanel, { type PlayPlan } from "./EvacuationPanel";
import { useEvacuationOptimizer } from "./useEvacuationOptimizer";
import {
  DEFAULT_ORDER_MINUTE,
  nearestEdge,
  simulateEvacuation,
  type EvacuationInputs,
} from "./evacuation";
import { computeExposure } from "../dispatch/fireExposure";
import { useBoardStreets } from "../fire/useBoardStreets";
import FirefightingFields from "./FirefightingFields";
import FirefightingResults, { type FireShown } from "./FirefightingResults";
import type { FirelineView } from "./FirelineOverlay";
import { useMapFireline } from "./useMapFireline";
import { useMapCrews } from "./useMapCrews";
import { planCrewDispatch } from "./crewDispatch";
import { crewHandoff, evacuationCrews } from "./crewHandoff";
import { resourceList } from "./firefighting";
import type { RunDispatch } from "./useStudioRun";
import { CREW_COLORS, FIRELINE_COLORS, firelineCss } from "./firelinePalette";
import type { Map as MapLibreMap } from "maplibre-gl";
import StudioMap from "./StudioMap";
import {
  DISPLAY_STEP_MINUTES,
  MAX_ENABLED_IGNITIONS,
  type IgnitionDisplayState,
  type MapMode,
  type ScenarioIssue,
  type ScheduledIgnition,
  type StudioRunResult,
  type StudioScenario,
} from "./contracts";
import { demoScenario } from "./demo";
import {
  DRAFT_STORAGE_KEY,
  clearDraft,
  draftStatusText,
  exportScenarioJson,
  loadDraft,
  saveDraft,
} from "./draft";
import {
  createIgnition,
  emptyScenario,
  parseScenario,
  solverInputChanged,
  validateScenario,
} from "./scenario";
import { Button, LoadingState, Notice, Panel, SegmentedControl, type SegmentedOption } from "../ui";
import { downloadJson, frameIndexAt } from "./playbackUtils";
import { useStudioRun } from "./useStudioRun";
import {
  STUDIO_DEFAULT_REGION_ID,
  findRegion,
  loadRegionId,
  saveRegionId,
  useRegionBoard,
} from "./useRegionBoard";
import { CALIFORNIA_REGIONS, REGION_AREAS } from "../fire/regions";
import type { DioramaIgnition, DioramaRun, FireDioramaSceneApi } from "../fire/diorama/types";
import "./studio.css";

type StudioView = "map" | "diorama";
const VIEW_OPTIONS: readonly SegmentedOption<StudioView>[] = [
  { value: "map", label: "Map" },
  { value: "diorama", label: "3D diorama" },
];
const VIEW_STORAGE_KEY = "crisistwin.studio.view";

export interface SimulationStudioPageProps {
  /** Accessible name of the page landmark. */
  label?: string;
  /**
   * Suffix for the device-local draft and view keys, so a page that reuses the studio
   * (/dispatch) keeps its own scenario instead of sharing the /simulation draft.
   */
  storageNamespace?: string;
  /**
   * A side panel driven by the run (the /dispatch console). It owns the 3D overlay, so the
   * studio's own evacuation panel is hidden; while it holds the lock, studio playback is paused
   * and disabled.
   */
  aside?: ComponentType<StudioAsideContext>;
}

/** What a side panel gets from the studio. */
export interface StudioAsideContext {
  result: StudioRunResult | null;
  stale: boolean;
  /** The 3D scene while the diorama view is shown. */
  scene: FireDioramaSceneApi | null;
  /** The smooth playback clock (minutes) the diorama draws; write it only while locked. */
  clockRef: { current: number };
  setLocked: (locked: boolean) => void;
  showDiorama: () => void;
  /**
   * Show this run of the current result instead of the studio's own choice (the dispatcher's
   * fire, re-solved when its engines put a fire out); null gives the choice back.
   */
  setRunOverride: (run: ScheduledFireRun | null) => void;
  /**
   * A click on the 3D board goes here first; return true to consume it (the dispatcher's road
   * tool). Write it from an effect and set it back to null on cleanup.
   */
  groundClickRef: { current: ((point: GeoPoint) => boolean) | null };
}
/** Gap kept between the floating panel and the framed 3D board, CSS px. */
const DIORAMA_PANEL_GAP_PX = 12;
/** Room kept clear at the bottom of the 3D view for the view toggle and legend, CSS px. */
const DIORAMA_BOTTOM_INSET_PX = 56;

function loadView(key: string): StudioView {
  try {
    return window.localStorage.getItem(key) === "diorama" ? "diorama" : "map";
  } catch {
    return "map";
  }
}

const SPEED_CHOICES = [1, 5, 10, 30, 60] as const;
const DEFAULT_SPEED = 10;
const AUTOSAVE_DELAY_MS = 600;
const NOTICE_MS = 4000;
const MAX_IMPORT_CHARACTERS = 1_000_000;
const METERS_PER_FOOT = 0.3048;
/**
 * Surface head-rate bands for the per-fire description, metres per minute. These are display
 * labels over modelled output, not model inputs: under 1 m/min a fire creeps (litter beneath
 * canopy, typically a few cells per hour at 24 m resolution); 1 to 10 m/min is typical shrub
 * or light grass behaviour; over 10 m/min is rapid (wind-driven grass).
 */
const SLOW_HEAD_RATE_METERS_PER_MINUTE = 1;
const FAST_HEAD_RATE_METERS_PER_MINUTE = 10;
/** Below this total reached area at the horizon, warn that modelled spread is small. */
const SMALL_SPREAD_HECTARES = 5;
const SQUARE_METERS_PER_HECTARE = 10_000;
const OPERATIONAL_DISCLAIMER = "Planning experiment; not an operational forecast.";

export default function SimulationStudioPage({
  label = "Simulation Studio",
  storageNamespace,
  aside: Aside,
}: SimulationStudioPageProps = {}) {
  const draftKey = storageNamespace
    ? `${DRAFT_STORAGE_KEY}.${storageNamespace}`
    : DRAFT_STORAGE_KEY;
  const viewKey = storageNamespace ? `${VIEW_STORAGE_KEY}.${storageNamespace}` : VIEW_STORAGE_KEY;
  const [initialDraft] = useState(() => loadDraft(draftKey));
  const [scenario, setScenario] = useState<StudioScenario>(
    () => initialDraft?.scenario ?? emptyScenario(),
  );
  const [savedAt, setSavedAt] = useState<Date | null>(initialDraft?.savedAt ?? null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>("select");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<StudioView>(() => loadView(viewKey));
  const chooseView = useCallback(
    (next: StudioView) => {
      setView(next);
      try {
        window.localStorage.setItem(viewKey, next);
      } catch {
        // Storage can be unavailable (private mode); the choice then lasts for this visit only.
      }
    },
    [viewKey],
  );

  // The 3D camera frames the board in the area the floating panel leaves uncovered.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelInset, setPanelInset] = useState(0);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const stage = panel.parentElement?.getBoundingClientRect();
      const box = panel.firstElementChild?.getBoundingClientRect();
      // Below 900px the panel spans the width, so it cannot be framed around; ignore it there.
      if (!stage || !box || box.width >= stage.width * 0.6) {
        setPanelInset(0);
        return;
      }
      setPanelInset(Math.round(box.right - stage.left + DIORAMA_PANEL_GAP_PX));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    if (panel.firstElementChild) observer.observe(panel.firstElementChild);
    return () => observer.disconnect();
  }, [panelCollapsed]);

  // Evacuation and road closures (3D view only). Closures are edge indices of one road area and
  // are dropped when the board's area changes; they never change the fire run.
  const [evacuationOn, setEvacuationOn] = useState(false);
  // Which evacuation plan the 3D view plays: the fastest-exit policy or the optimiser's best.
  const [playPlan, setPlayPlan] = useState<PlayPlan>("fastest");
  const [roadTool, setRoadTool] = useState(false);
  const [orderMinute, setOrderMinute] = useState(DEFAULT_ORDER_MINUTE);
  const [closures, setClosures] = useState<{ areaId: string; edges: ReadonlySet<number> }>({
    areaId: "",
    edges: new Set(),
  });

  const { state, run, cancel, markStale } = useStudioRun();
  const { result } = state;
  // Which fire to show when the run includes firefighting: direct attack once on site, the
  // best control-line plan, or the free run. Falls back to the free run when unavailable.
  const [fireShown, setFireShown] = useState<FireShown>("attack");
  const firefighting = result?.firefighting ?? null;
  const [runOverride, setRunOverride] = useState<ScheduledFireRun | null>(null);
  const shownRun = result
    ? runOverride && runOverride.input === result.run.input
      ? runOverride
      : fireShown === "attack" && firefighting?.initialAttack
        ? firefighting.initialAttack.run
        : fireShown === "line" && firefighting?.best
          ? firefighting.best.run
          : result.run
    : null;
  // Crews that cannot put the fire out leave it to help the evacuation (studio/crewHandoff.ts).
  // Only with the direct-attack fire shown: on the line plan they keep building line.
  const fireNames = useMemo(
    () =>
      Object.fromEntries(
        (result?.scenario.ignitions ?? []).map((ignition) => [
          ignition.id,
          ignition.name || ignition.id,
        ]),
      ),
    [result],
  );
  const handoff = useMemo(
    () =>
      result?.crewDispatch && firefighting?.initialAttack
        ? crewHandoff(result.crewDispatch, firefighting.initialAttack.estimate, fireNames)
        : null,
    [result, firefighting, fireNames],
  );
  const shownHandoff =
    handoff && firefighting?.initialAttack && shownRun === firefighting.initialAttack.run
      ? handoff
      : null;

  // Prebuilt region board (MongoDB), drawn in 3D before any run and used to solve fires on it.
  const [regionId, setRegionId] = useState(loadRegionId);
  const [boardAttempt, setBoardAttempt] = useState(0);
  const { catalog, board } = useRegionBoard(regionId, boardAttempt);
  const region = findRegion(regionId);
  const regionGrid = board.status === "ready" ? board.grid : null;

  // Playback. `clockRef` is the smooth simulation clock; React state only changes when the
  // clock crosses into a new frame, so the map is not re-rendered on every animation tick.
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [frameIndex, setFrameIndex] = useState(0);
  const clockRef = useRef(0);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [locked, setLockedState] = useState(false);
  const setLocked = useCallback((next: boolean) => {
    setLockedState(next);
    if (next) setPlaying(false);
  }, []);
  const showDiorama = useCallback(() => chooseView("diorama"), [chooseView]);
  const frameMinutes = useMemo(() => result?.frameMinutes ?? [], [result]);

  // A new result starts at T+0, paused. Adjusted during render rather than in an effect.
  const [playbackKey, setPlaybackKey] = useState<number | null>(null);
  const resultKey = result?.requestId ?? null;
  if (playbackKey !== resultKey) {
    setPlaybackKey(resultKey);
    setPlaying(false);
    setFrameIndex(0);
    clockRef.current = 0;
  }

  useEffect(() => {
    if (!playing || frameMinutes.length === 0) return;
    const end = frameMinutes[frameMinutes.length - 1];
    let handle = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsedSeconds = (now - last) / 1000;
      last = now;
      clockRef.current = Math.min(end, clockRef.current + elapsedSeconds * speed);
      setFrameIndex(frameIndexAt(frameMinutes, clockRef.current));
      if (clockRef.current >= end) {
        setPlaying(false);
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, speed, frameMinutes]);

  const seek = useCallback(
    (index: number) => {
      if (frameMinutes.length === 0) return;
      const clamped = Math.max(0, Math.min(frameMinutes.length - 1, index));
      clockRef.current = frameMinutes[clamped];
      setFrameIndex(clamped);
    },
    [frameMinutes],
  );

  const showNotice = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const handle = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(handle);
  }, [notice]);

  // Draft autosave, debounced; labelled "Saved on this device".
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const saved = saveDraft(scenario, draftKey);
      setSaveFailed(saved === null);
      if (saved) setSavedAt(saved);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [scenario, draftKey]);

  const issues = useMemo(() => validateScenario(scenario), [scenario]);

  /**
   * The one place a scenario edit lands. Edits that change the solver input pause playback and
   * mark the result stale (cancelling an in-flight run, whose result would no longer match);
   * names, selection, view and speed do not. An edit never starts a run.
   */
  const applyScenario = useCallback(
    (next: StudioScenario) => {
      if (solverInputChanged(scenario, next)) {
        setPlaying(false);
        cancel();
        markStale();
      }
      setScenario(next);
      const selectionSurvives =
        selectedId !== null && next.ignitions.some((ignition) => ignition.id === selectedId);
      if (!selectionSurvives) {
        setSelectedId(null);
        setMode((current) => (current === "move" ? "select" : current));
      }
    },
    [scenario, selectedId, cancel, markStale],
  );

  const updateIgnition = useCallback(
    (id: string, patch: Partial<ScheduledIgnition>) => {
      applyScenario({
        ...scenario,
        ignitions: scenario.ignitions.map((ignition) =>
          ignition.id === id ? { ...ignition, ...patch } : ignition,
        ),
      });
    },
    [scenario, applyScenario],
  );

  const handleMapClick = useCallback(
    (point: GeoPoint) => {
      if (mode === "add") {
        const enabledCount = scenario.ignitions.filter((ignition) => ignition.enabled).length;
        if (enabledCount >= MAX_ENABLED_IGNITIONS) {
          showNotice(
            `At most ${MAX_ENABLED_IGNITIONS} fires can be enabled. Disable or delete one to add another.`,
          );
          return;
        }
        const ignition = createIgnition(scenario.ignitions, point);
        applyScenario({ ...scenario, ignitions: [...scenario.ignitions, ignition] });
        setSelectedId(ignition.id);
      } else if (mode === "move" && selectedId) {
        updateIgnition(selectedId, { location: point });
        setMode("select");
      }
    },
    [mode, scenario, selectedId, applyScenario, updateIgnition, showNotice],
  );

  const handleImport = useCallback(
    (text: string): ScenarioIssue[] => {
      if (text.length > MAX_IMPORT_CHARACTERS) return [{ message: "The file is too large." }];
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return [{ message: "The file is not valid JSON." }];
      }
      const parsed = parseScenario(json);
      if (!parsed.scenario) return parsed.issues;
      const problems = validateScenario(parsed.scenario);
      if (problems.length > 0) return problems;
      applyScenario(parsed.scenario);
      setMode("select");
      return [];
    },
    [applyScenario],
  );

  const handleClear = useCallback(() => {
    clearDraft(draftKey);
    setSavedAt(null);
    applyScenario(emptyScenario());
    setMode("select");
  }, [applyScenario, draftKey]);

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id === null) setMode((current) => (current === "move" ? "select" : current));
  }, []);

  const handleExport = useCallback(() => {
    try {
      downloadJson(`${scenario.name || "scenario"}.json`, exportScenarioJson(scenario));
    } catch (cause) {
      showNotice(
        `Could not export the scenario${cause instanceof Error ? `: ${cause.message}` : "."}`,
      );
    }
  }, [scenario, showNotice]);

  const selectRegion = useCallback(
    (id: string) => {
      if (id === regionId || !findRegion(id)) return;
      setPlaying(false);
      cancel();
      markStale();
      setRegionId(id);
      saveRegionId(id);
    },
    [regionId, cancel, markStale],
  );

  const handleLoadDemo = useCallback(() => {
    applyScenario(demoScenario());
    setMode("select");
    // The demo's fires sit on the default board.
    selectRegion(STUDIO_DEFAULT_REGION_ID);
  }, [applyScenario, selectRegion]);

  // The 3D view shows the run only while the board it was started on is still selected.
  const dioramaShowsRun = result !== null && result.boardId === regionId;
  const dioramaLandscape = dioramaShowsRun ? result.landscape : regionGrid;
  // Without a board to click in 3D, placing a fire goes to the map.
  const dioramaHasBoard = dioramaLandscape !== null;
  const handleModeChange = useCallback(
    (next: MapMode) => {
      if (next !== "select" && view === "diorama" && !dioramaHasBoard) chooseView("map");
      if (next !== "select") setRoadTool(false);
      setMode(next);
    },
    [view, dioramaHasBoard, chooseView],
  );

  // ---- Evacuation and road closures -------------------------------------------------------

  const streets = useBoardStreets(dioramaLandscape);
  const area = streets.status === "ready" ? streets.area : null;
  const closedEdges = useMemo<ReadonlySet<number>>(
    () => (area && closures.areaId === area.id ? closures.edges : new Set()),
    [area, closures],
  );

  /**
   * With firefighting from stations, each resource is sent from the nearest OSM fire stations on
   * the board's roads to the first fire, reported when it ignites (studio/crewDispatch.ts).
   */
  const planCrews = useCallback((): RunDispatch | undefined => {
    const settings = scenario.firefighting;
    if (!settings?.enabled || settings.fromStations === false) return undefined;
    const first = scenario.ignitions
      .filter((ignition) => ignition.enabled)
      .sort((a, b) => a.startMinute - b.startMinute)[0];
    if (!first) return undefined;
    if (!area) {
      return {
        dispatch: null,
        note: `The board's roads and fire stations were not loaded, so crews were assumed on site after ${settings.responseMinutes} min.`,
      };
    }
    const { dispatch, note } = planCrewDispatch(
      area,
      [first.location.longitude, first.location.latitude],
      first.startMinute,
      resourceList(settings),
      (edge) => closedEdges.has(edge),
    );
    return {
      dispatch,
      note: note
        ? `${note} Crews were assumed on site after ${settings.responseMinutes} min.`
        : null,
    };
  }, [scenario, area, closedEdges]);

  const handleRun = useCallback(() => {
    setPlaying(false);
    run(scenario, { id: regionId, grid: regionGrid }, planCrews());
  }, [run, scenario, regionId, regionGrid, planCrews]);
  const toggleClosure = useCallback(
    (edge: number) => {
      if (!area) return;
      const next = new Set(closures.areaId === area.id ? closures.edges : []);
      if (next.has(edge)) next.delete(edge);
      else next.add(edge);
      setClosures({ areaId: area.id, edges: next });
    },
    [area, closures],
  );

  const asideClickRef = useRef<((point: GeoPoint) => boolean) | null>(null);
  const handleGroundClick = useCallback(
    (point: GeoPoint) => {
      if (asideClickRef.current?.(point)) return;
      if (!roadTool || !area) {
        handleMapClick(point);
        return;
      }
      const edge = nearestEdge(area, [point.longitude, point.latitude]);
      if (edge === null) showNotice("No road there. Click closer to a road to close it.");
      else toggleClosure(edge);
    },
    [roadTool, area, handleMapClick, toggleClosure, showNotice],
  );

  const exposure = useMemo(
    () =>
      area && dioramaShowsRun
        ? computeExposure(area, result.landscape, shownRun!.arrivalMinutes)
        : null,
    [area, dioramaShowsRun, result, shownRun],
  );
  const evacuationInputs = useMemo<EvacuationInputs | null>(
    () =>
      area && exposure && result
        ? {
            area,
            exposure,
            horizonMinutes: result.scenario.settings.horizonMinutes,
            closedEdges,
            orderMinute,
            crews:
              shownHandoff && result.crewDispatch
                ? evacuationCrews(area, result.crewDispatch, shownHandoff)
                : undefined,
          }
        : null,
    [area, exposure, result, closedEdges, orderMinute, shownHandoff],
  );
  const showEvacuation = evacuationOn && view === "diorama" && !Aside;

  const baselineSummary = useMemo(
    () =>
      showEvacuation && evacuationInputs
        ? simulateEvacuation({ ...evacuationInputs, closedEdges: new Set() })
        : null,
    // Not rerun when only the closures change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showEvacuation, area, exposure, result, orderMinute, shownHandoff],
  );
  const closuresSummary = useMemo(
    () =>
      showEvacuation && evacuationInputs && closedEdges.size > 0
        ? simulateEvacuation(evacuationInputs)
        : null,
    [showEvacuation, evacuationInputs, closedEdges],
  );
  // Re-optimised whenever the closures, order minute, run or crews change (debounced).
  const optimizer = useEvacuationOptimizer(evacuationInputs, showEvacuation && dioramaShowsRun);
  const optimizedPlan =
    playPlan === "optimized" && optimizer.status === "ready" ? optimizer.result?.best.plan : null;
  // The optimised plan plays only while its result matches the current inputs; otherwise the
  // default policy does. A new `inputs` object makes the diorama rebuild its EvacuationPlayer.
  const playedInputs = useMemo<EvacuationInputs | null>(
    () =>
      evacuationInputs && optimizedPlan
        ? { ...evacuationInputs, plan: optimizedPlan }
        : evacuationInputs,
    [evacuationInputs, optimizedPlan],
  );
  const evacuationView = useMemo<StudioEvacuationView | null>(
    () => (showEvacuation && area ? { area, exposure, closedEdges, inputs: playedInputs } : null),
    [showEvacuation, area, exposure, closedEdges, playedInputs],
  );
  const closedRoadList = useMemo(
    () => (area ? [...closedEdges].map((edge) => area.edges[edge]).filter(Boolean) : []),
    [area, closedEdges],
  );

  // ---- Derived display state -------------------------------------------------------------

  const stale = state.stale;
  const safeFrameIndex = Math.max(0, Math.min(frameIndex, frameMinutes.length - 1));
  const currentMinute = frameMinutes[safeFrameIndex] ?? 0;
  const running = state.phase === "loading-landscape" || state.phase === "computing";

  const problemIds = useMemo(
    () => new Set((state.error?.problems ?? []).map((problem) => problem.sourceId)),
    [state.error],
  );
  const issueIds = useMemo(
    () => new Set(issues.flatMap((issue) => (issue.ignitionId ? [issue.ignitionId] : []))),
    [issues],
  );

  /** States per the result at the current minute, regardless of staleness. */
  const resultStates = useMemo(() => {
    const states: Record<string, IgnitionDisplayState> = {};
    for (const entry of result?.run.ignitions ?? []) {
      if (entry.outcome.status === "ignited") {
        states[entry.sourceId] =
          entry.outcome.ignitedMinute <= currentMinute ? "triggered" : "scheduled";
      } else {
        states[entry.sourceId] =
          entry.outcome.reachedMinute <= currentMinute ? "reached-before-start" : "scheduled";
      }
    }
    return states;
  }, [result, currentMinute]);

  const ignitionStates = useMemo(() => {
    const states: Record<string, IgnitionDisplayState> = {};
    for (const ignition of scenario.ignitions) {
      if (!ignition.enabled) states[ignition.id] = "disabled";
      else if (issueIds.has(ignition.id) || problemIds.has(ignition.id))
        states[ignition.id] = "invalid";
      else if (!result || stale) states[ignition.id] = "draft";
      else states[ignition.id] = resultStates[ignition.id] ?? "draft";
    }
    return states;
  }, [scenario.ignitions, issueIds, problemIds, result, stale, resultStates]);

  const visibleFrames = useMemo(
    () => (shownRun ? shownRun.frames.slice(0, safeFrameIndex + 1) : []),
    [shownRun, safeFrameIndex],
  );

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (result && shownRun) {
      const solved = shownRun;
      if (solved.reachedEdgeMinute !== null && currentMinute >= solved.reachedEdgeMinute) {
        list.push(
          `Fire reached the edge of the modelled area at ${formatElapsed(Math.round(solved.reachedEdgeMinute))}; the footprint after that is incomplete.`,
        );
      }
      if (!solved.crownFire.modelled) list.push(solved.crownFire.unavailableReason);
      if (!result.elevationComplete) {
        list.push(
          "Elevation data was incomplete for part of the area, so slope is understated there.",
        );
      }
      const horizonFrame = solved.frames[solved.frames.length - 1];
      if (
        !stale &&
        horizonFrame &&
        horizonFrame.reachedAreaSquareMeters < SMALL_SPREAD_HECTARES * SQUARE_METERS_PER_HECTARE
      ) {
        const fuels = [
          ...new Set(
            solved.ignitions.map((entry) => entry.conditions.fuelLabel.split(/ — | \(/)[0]),
          ),
        ].join(", ");
        list.push(
          `Modelled spread is small: these fires are on slow-burning fuels (${fuels}). Try grass or shrub areas, or stronger wind/drier fuel.`,
        );
      }
      if (stale) list.push("Showing the previous run. Your edits have not been simulated yet.");
    }
    list.push(OPERATIONAL_DISCLAIMER);
    return list;
  }, [result, shownRun, currentMinute, stale]);

  /** Fuel and surface head rate per ignition, from the current (non-stale) result only. */
  const ignitionDetails = useMemo(() => {
    const details: Record<string, string> = {};
    if (!result || stale) return details;
    for (const entry of result.run.ignitions) {
      const { conditions } = entry;
      const headMetersPerMinute = conditions.spread.headRateFeetPerMinute * METERS_PER_FOOT;
      const band =
        headMetersPerMinute < SLOW_HEAD_RATE_METERS_PER_MINUTE
          ? "slow"
          : headMetersPerMinute > FAST_HEAD_RATE_METERS_PER_MINUTE
            ? "fast"
            : "moderate";
      const parts = [
        conditions.fuelLabel.replace(" — ", " · "),
        `head ${headMetersPerMinute < 10 ? headMetersPerMinute.toFixed(1) : Math.round(headMetersPerMinute)} m/min (${band})`,
      ];
      if (conditions.crown && conditions.crown.type !== "surface") {
        parts.push(`${conditions.crown.type} crown fire`);
      }
      parts.push(`midflame wind ${Math.round(conditions.midflameAdjustment * 100)}%`);
      details[entry.sourceId] = parts.join(" · ");
    }
    return details;
  }, [result, stale]);

  const attribution = useMemo(() => (result ? Object.values(result.attribution) : []), [result]);

  const playbackHorizon =
    result?.scenario.settings.horizonMinutes ?? scenario.settings.horizonMinutes;

  const dioramaRun = useMemo<DioramaRun | null>(
    () =>
      result && shownRun
        ? {
            arrivalMinutes: shownRun.arrivalMinutes,
            scenario: {
              horizonMinutes: result.scenario.settings.horizonMinutes,
              stepMinutes: DISPLAY_STEP_MINUTES,
            },
          }
        : null,
    [result, shownRun],
  );
  const dioramaIgnitions = useMemo<DioramaIgnition[]>(
    () =>
      scenario.ignitions
        .filter((ignition) => ignition.enabled)
        .map((ignition) => ({
          id: ignition.id,
          point: ignition.location,
          label: ignition.name || ignition.id,
        })),
    [scenario.ignitions],
  );

  const events = useMemo(
    () =>
      (result?.run.input.sources ?? []).map((source) => ({
        id: source.id,
        name:
          result?.scenario.ignitions.find((ignition) => ignition.id === source.id)?.name ??
          source.id,
        minute: source.startMinute,
        state: resultStates[source.id] ?? ("scheduled" as IgnitionDisplayState),
      })),
    [result, resultStates],
  );

  const metrics = useMemo(() => {
    const frame = shownRun?.frames[safeFrameIndex];
    const upcoming = events
      .filter((event) => event.minute > currentMinute)
      .sort((a, b) => a.minute - b.minute)[0];
    return {
      ignitionsTriggered: frame?.ignitedSourceIds.length ?? 0,
      ignitionsTotal: events.length || scenario.ignitions.filter((i) => i.enabled).length,
      reachedAreaSquareMeters: frame?.reachedAreaSquareMeters ?? 0,
      nextIgnition: upcoming ? { name: upcoming.name, minute: upcoming.minute } : null,
    };
  }, [shownRun, safeFrameIndex, events, currentMinute, scenario.ignitions]);

  // The best plan's control line, drawn while its fire is the one shown. On a page with an
  // aside (/dispatch) the dispatcher owns the 3D overlay, so the line is drawn on the map only.
  const firelineView = useMemo<FirelineView | null>(
    () =>
      result && fireShown === "line" && firefighting?.best
        ? {
            grid: result.landscape,
            line: firefighting.best.line,
            status: firefighting.best.status,
            arrival: firefighting.best.run.arrivalMinutes,
          }
        : null,
    [result, fireShown, firefighting],
  );
  const fireline = dioramaShowsRun && !Aside ? firelineView : null;
  const [studioMap, setStudioMap] = useState<MapLibreMap | null>(null);
  useMapFireline(view === "map" ? studioMap : null, firelineView, currentMinute);
  useMapCrews(view === "map" ? studioMap : null, result?.crewDispatch ?? null, clockRef);

  const handlePlayPause = useCallback(() => {
    if (frameMinutes.length === 0 || locked) return;
    if (!playing && safeFrameIndex >= frameMinutes.length - 1) seek(0);
    setPlaying(!playing);
  }, [frameMinutes, playing, safeFrameIndex, seek, locked]);

  const handleStep = useCallback(
    (delta: -1 | 1) => {
      setPlaying(false);
      seek(safeFrameIndex + delta);
    },
    [safeFrameIndex, seek],
  );

  return (
    <main
      className={`studio-page${Aside ? " studio-page--aside" : ""}`}
      id="main-content"
      aria-label={label}
    >
      <div className="studio-page-main">
        <div className="studio-stage">
          <div className="studio-page-map">
            {view === "diorama" ? (
              <StudioDiorama
                landscape={dioramaLandscape}
                run={dioramaShowsRun ? dioramaRun : null}
                ignitions={dioramaIgnitions}
                windFromDegrees={scenario.settings.windFromDegrees}
                windSpeedMph={scenario.settings.windSpeedMph}
                timeRef={clockRef}
                insets={{ top: 12, right: 12, bottom: DIORAMA_BOTTOM_INSET_PX, left: panelInset }}
                fitKey={dioramaShowsRun ? resultKey : null}
                warnings={warnings}
                attribution={
                  dioramaShowsRun ? attribution : Object.values(regionGrid?.attribution ?? {})
                }
                onGroundClick={handleGroundClick}
                onSceneChange={setScene}
                streets={streets}
                evacuation={evacuationView}
                fireline={fireline}
                crews={dioramaShowsRun && !Aside ? (result?.crewDispatch ?? null) : null}
                crewLeaveMinutes={shownHandoff?.leaveMinutes}
                evacuationPanel={
                  Aside ? undefined : (
                    <EvacuationPanel
                      streets={streets}
                      hasRun={dioramaShowsRun}
                      stale={stale}
                      enabled={evacuationOn}
                      onToggle={() => {
                        setEvacuationOn((on) => !on);
                        setRoadTool(false);
                      }}
                      roadTool={roadTool}
                      onRoadTool={() => {
                        setRoadTool((on) => !on);
                        setMode("select");
                      }}
                      orderMinute={orderMinute}
                      onOrderMinute={setOrderMinute}
                      closedEdges={closedRoadList}
                      onReopen={toggleClosure}
                      onReopenAll={() => setClosures({ areaId: "", edges: new Set() })}
                      baseline={baselineSummary}
                      withClosures={closuresSummary}
                      currentMinute={currentMinute}
                      area={area}
                      optimizer={optimizer}
                      playPlan={playPlan}
                      onPlayPlan={setPlayPlan}
                    />
                  )
                }
                boardControl={
                  <Panel glass compact className="studio-region">
                    <div className="studio-region__row">
                      <label htmlFor="studio-region">Region</label>
                      <select
                        id="studio-region"
                        className="ui-input"
                        value={regionId}
                        onChange={(event) => selectRegion(event.target.value)}
                      >
                        {REGION_AREAS.map((area) => (
                          <optgroup key={area} label={area}>
                            {CALIFORNIA_REGIONS.filter((entry) => entry.area === area).map(
                              (entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {entry.name}
                                  {catalog.status === "ready" && !catalog.ids.has(entry.id)
                                    ? " (not built)"
                                    : ""}
                                </option>
                              ),
                            )}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <p className="studio-region__note">
                      {board.status === "ready"
                        ? board.source === "stored"
                          ? "Stored board: LANDFIRE fuels and terrain, prebuilt."
                          : "Stored board unavailable; loaded live from LANDFIRE."
                        : board.status === "loading"
                          ? board.storedUnavailable
                            ? "Stored board unavailable; loading live from LANDFIRE…"
                            : "Loading stored board…"
                          : "Board could not be loaded."}{" "}
                      Fires on the board run on it; others download their own area.
                    </p>
                  </Panel>
                }
                emptyState={
                  board.status === "loading" ? (
                    <LoadingState>
                      {board.storedUnavailable
                        ? `Stored board unavailable; loading ${region?.name ?? "the region"} live from LANDFIRE. This takes longer…`
                        : `Loading the ${region?.name ?? "region"} board…`}
                    </LoadingState>
                  ) : board.status === "error" ? (
                    <>
                      <p className="studio-diorama__card-title">The board could not be loaded</p>
                      <p>{board.message}</p>
                      <div className="studio-row">
                        <Button size="sm" onClick={() => setBoardAttempt((value) => value + 1)}>
                          Retry
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => chooseView("map")}>
                          Use the map
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="studio-diorama__card-title">No landscape yet</p>
                      <p>
                        The 3D view is built from the fuel and terrain a run downloads.{" "}
                        {scenario.ignitions.length === 0
                          ? "Load the demo scenario, or place fires on the map, then run it."
                          : "Run the scenario to build it."}
                      </p>
                      <div className="studio-row">
                        {scenario.ignitions.length === 0 ? (
                          <>
                            <Button size="sm" onClick={handleLoadDemo}>
                              Load demo
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleModeChange("add")}
                            >
                              Place fires on map
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              onClick={handleRun}
                              disabled={issues.length > 0 || running}
                            >
                              {running ? "Running…" : "Run simulation"}
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => chooseView("map")}>
                              Back to map
                            </Button>
                          </>
                        )}
                      </div>
                    </>
                  )
                }
              />
            ) : (
              <StudioMap
                ignitions={scenario.ignitions}
                ignitionStates={ignitionStates}
                selectedId={selectedId}
                mode={mode}
                visibleFrames={visibleFrames}
                currentMinute={currentMinute}
                horizonMinutes={playbackHorizon}
                windSpeedMph={scenario.settings.windSpeedMph}
                windFromDegrees={scenario.settings.windFromDegrees}
                landscapeBox={result?.landscapeBox ?? null}
                footprintIsStale={stale}
                ignitionDetails={ignitionDetails}
                warnings={warnings}
                attribution={attribution}
                onMapClick={handleMapClick}
                onSelectIgnition={handleSelect}
                onMoveIgnition={(id, point) => updateIgnition(id, { location: point })}
                onMapReady={setStudioMap}
                legendExtra={
                  firelineView || result?.crewDispatch ? (
                    <div className="studio-map__legend-group">
                      <h3>Firefighters</h3>
                      <ul className="ui-legend studio-map__extras">
                        {result?.crewDispatch && (
                          <>
                            <li>
                              <span
                                className="studio-ff-dot is-lost"
                                style={{ background: firelineCss(CREW_COLORS.engine) }}
                              />
                              Engine (largest dot); dashed line: its route while driving
                            </li>
                            <li>
                              <span
                                className="studio-ff-dot is-lost"
                                style={{ background: firelineCss(CREW_COLORS.hand_crew) }}
                              />
                              Hand crew
                            </li>
                            <li>
                              <span
                                className="studio-ff-dot is-lost"
                                style={{ background: firelineCss(CREW_COLORS.dozer) }}
                              />
                              Dozer
                            </li>
                          </>
                        )}
                        {firelineView && (
                          <>
                            <li>
                              <span
                                className="studio-ff-dot"
                                style={{ background: firelineCss(FIRELINE_COLORS.held) }}
                              />
                              Control line built, holding so far (small dot)
                            </li>
                            <li>
                              <span
                                className="studio-ff-dot is-lost"
                                style={{ background: firelineCss(FIRELINE_COLORS.breached) }}
                              />
                              Line burned over by flames (large dot)
                            </li>
                            <li>
                              <span
                                className="studio-ff-dot is-lost"
                                style={{ background: firelineCss(FIRELINE_COLORS.outrun) }}
                              />
                              Line the fire reached before the crew (large dot)
                            </li>
                          </>
                        )}
                      </ul>
                    </div>
                  ) : undefined
                }
              />
            )}
          </div>

          <div className="studio-view">
            <SegmentedControl
              label="View"
              options={VIEW_OPTIONS}
              value={view}
              onChange={chooseView}
            />
          </div>

          <div className="studio-page-status" aria-live="polite">
            {state.phase === "loading-landscape" && (
              <div className="studio-chip">
                <LoadingState>Loading fuel and terrain data…</LoadingState>
              </div>
            )}
            {state.phase === "computing" && (
              <div className="studio-chip">
                <LoadingState>
                  {state.progress
                    ? `Testing firefighting plans… ${state.progress.done} of ${state.progress.total}`
                    : "Computing fire spread…"}
                </LoadingState>
              </div>
            )}
            {state.phase === "canceled" && (
              <Notice tone="info" className="studio-chip-notice">
                Run canceled.
              </Notice>
            )}
            {state.phase === "failed" && state.error && (
              <Notice tone="danger" className="studio-chip-notice">
                {state.error.message}
              </Notice>
            )}
            {/* In 3D the empty-state card carries this instead. */}
            {!running && scenario.ignitions.length === 0 && view === "map" && (
              <Notice tone="info" className="studio-chip-notice">
                Choose “Add ignition” and click the map to place a fire, or load the demo scenario.
              </Notice>
            )}
            {notice && (
              <Notice tone="info" className="studio-chip-notice">
                {notice}
              </Notice>
            )}
          </div>

          <div
            ref={panelRef}
            className={`studio-page-panel${panelCollapsed ? " is-collapsed" : ""}`}
          >
            <ConfigPanel
              scenario={scenario}
              issues={issues}
              problems={state.error?.problems ?? []}
              selectedId={selectedId}
              mode={mode}
              phase={state.phase}
              stale={stale}
              draftStatus={draftStatusText(savedAt, saveFailed)}
              collapsed={panelCollapsed}
              onToggleCollapsed={() => setPanelCollapsed((value) => !value)}
              onModeChange={handleModeChange}
              onSelectIgnition={handleSelect}
              onScenarioChange={applyScenario}
              onRun={handleRun}
              onCancel={cancel}
              onClear={handleClear}
              onExport={handleExport}
              onImport={handleImport}
              onLoadDemo={handleLoadDemo}
              liveDrill={<LiveDrillAction result={result} stale={stale} />}
              firefighting={
                <FirefightingFields
                  scenario={scenario}
                  onScenarioChange={applyScenario}
                  idPrefix="studio"
                  result={
                    firefighting ? (
                      <FirefightingResults
                        result={firefighting}
                        names={fireNames}
                        stale={stale}
                        handoff={handoff}
                        dispatch={result?.crewDispatch ?? null}
                        dispatchNote={result?.crewDispatchNote ?? null}
                        shown={fireShown}
                        onShownChange={setFireShown}
                      />
                    ) : null
                  }
                />
              }
            />
          </div>
        </div>

        <div className="studio-dock">
          {result && stale && (
            <Notice className="studio-previous">
              Playing the previous run; run again to include your edits.
            </Notice>
          )}
          <PlaybackBar
            enabled={!locked && result !== null && frameMinutes.length > 0}
            frameMinutes={frameMinutes}
            frameIndex={safeFrameIndex}
            horizonMinutes={playbackHorizon}
            playing={playing}
            speed={speed}
            speedChoices={SPEED_CHOICES}
            events={events}
            metrics={metrics}
            onPlayPause={handlePlayPause}
            onStep={handleStep}
            onRestart={() => seek(0)}
            onSpeedChange={setSpeed}
            onSeek={(index) => {
              setPlaying(false);
              seek(index);
            }}
          />
        </div>
      </div>
      {Aside && (
        <Aside
          result={result}
          stale={stale}
          scene={view === "diorama" ? scene : null}
          clockRef={clockRef}
          setLocked={setLocked}
          showDiorama={showDiorama}
          setRunOverride={setRunOverride}
          groundClickRef={asideClickRef}
        />
      )}
    </main>
  );
}
