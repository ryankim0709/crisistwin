import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { GeoPoint } from "../fire/spread";
import type { ScheduledFireRun } from "../fire/scheduledTypes";
import { formatElapsed, cellAt } from "../fire/spread";
import {
  buildRandomScenario,
  PLACEMENT_LABELS,
  randomRegionId,
  type IgnitionPlacement,
} from "./randomScenario";
import ConfigPanel from "./ConfigPanel";
import LiveDrillAction from "./LiveDrillAction";
import PlaybackBar from "./PlaybackBar";
import StudioDiorama, { type StudioEvacuationView } from "./StudioDiorama";
import EvacuationPanel, { type PlayPlan } from "./EvacuationPanel";
import { useEvacuationOptimizer } from "./useEvacuationOptimizer";
import { useSimStatePublisher } from "./useSimStatePublisher";
import {
  DEFAULT_ORDER_MINUTE,
  nearestEdge,
  simulateEvacuation,
  type EvacuationInputs,
} from "./evacuation";
import { computeExposure } from "../dispatch/fireExposure";
import { useBoardStreets } from "../fire/useBoardStreets";
import { seriesActive, weatherAtStep, weatherStepAt } from "../fire/weatherSeries";
import FirefightingFields from "./FirefightingFields";
import FirefightingResults, { type FireShown } from "./FirefightingResults";
import type { FirelineView } from "./FirelineOverlay";
import { useMapFireline } from "./useMapFireline";
import { useMapCrews } from "./useMapCrews";
import { planCrewDispatch } from "./crewDispatch";
import { crewHandoff, evacuationCrews } from "./crewHandoff";
import { DEFAULT_FIREFIGHTING, ignitionReportDelayMinutes, startMsOf } from "./firefighting";
import StudioPeople from "./StudioPeople";
import {
  behaviorLabel,
  householdDepartureDelays,
  type HouseholdBehaviorMode,
} from "../population/householdBehavior";
import { useSuppressionBases } from "./suppressionBases";
import { mapResources, planMapDispatch } from "./mapResources";
import { useMapStations } from "./useMapStations";
import type { RunDispatch } from "./useStudioRun";
import { CREW_COLORS, FIRELINE_COLORS, firelineCss } from "./firelinePalette";
import type { Map as MapLibreMap } from "maplibre-gl";
import StudioMap from "./StudioMap";
import {
  studioDisplayStepMinutes,
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
  FIREFIGHTING_ON_DEFAULTS_VERSION,
  HORIZON_24H_DEFAULTS_VERSION,
  DRAFT_STORAGE_KEY,
  clearDraft,
  draftStatusText,
  exportScenarioJson,
  loadDraft,
  saveDraft,
} from "./draft";
import {
  DEFAULT_HORIZON_MINUTES,
  createIgnition,
  emptyScenario,
  parseScenario,
  solverInputChanged,
  validateScenario,
  withFirefightingOff,
  withFirefightingOn,
} from "./scenario";
import { Button, LoadingState, Notice, Panel, SegmentedControl, type SegmentedOption } from "../ui";
import { downloadJson, frameIndexAt } from "./playbackUtils";
import { useStudioRun } from "./useStudioRun";
import {
  STUDIO_DEFAULT_REGION_ID,
  findRegion,
  loadRegionId,
  saveRegionId,
  STUDIO_BOARD_SIZES,
  useRegionBoard,
} from "./useRegionBoard";
import { firstLoadSeconds, readinessLabel, useCachedBoards } from "../fire/useCachedBoards";
import { boardCellMetersFor } from "../fire/boardSize";
import { WorldBar } from "../world/WorldBar";
import { useStudioWorldSync } from "./useStudioWorldSync";
import { announceRandom } from "../world/randomScenario";
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
  /** The 2D map while the Map view is shown, else null (the aside's people layer). */
  map: MapLibreMap | null;
  /** A slot above the playback bar for the aside's strip (its people summary); portal into it. */
  dock: HTMLElement | null;
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

/** Simulation minutes per real second; ×240 watches a 72 h run in 18 s. */
const SPEED_CHOICES = [1, 5, 10, 30, 60, 120, 240] as const;
const DEFAULT_SPEED = 10;
/** A new result plays at the slowest speed that shows its whole run in about this long. */
const TARGET_PLAYBACK_SECONDS = 40;

/** Speed for a new run: the default, or faster for a long horizon. Never above the largest choice. */
function speedForHorizon(horizonMinutes: number): number {
  const wanted = horizonMinutes / TARGET_PLAYBACK_SECONDS;
  if (wanted <= DEFAULT_SPEED) return DEFAULT_SPEED;
  return SPEED_CHOICES.find((choice) => choice >= wanted) ?? SPEED_CHOICES[SPEED_CHOICES.length - 1];
}
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
  // The Studio's defaults (not /dispatch's, which reuses this page with an aside): firefighting
  // on, the first-alarm package from real stations.
  const studioDefaults = !Aside;
  const freshScenario = useCallback(
    // Studio: the fire spreads unchecked. Dispatch agent (aside): fire departments respond.
    (base: StudioScenario) => (studioDefaults ? withFirefightingOff(base) : withFirefightingOn(base)),
    [studioDefaults],
  );
  const [scenario, setScenario] = useState<StudioScenario>(() => {
    if (!initialDraft) return freshScenario(emptyScenario());
    // A draft saved before firefighting was on by default picks it up once; the autosave then
    // records the new defaults version, so turning it off later sticks.
    // (Version 3, units from the map, needs nothing here: parseScenario already dropped counts.)
    let next =
      initialDraft.defaultsVersion < FIREFIGHTING_ON_DEFAULTS_VERSION
        ? freshScenario(initialDraft.scenario)
        : initialDraft.scenario;
    // Drafts still on the old 3 h default move to the 24 h default once.
    if (initialDraft.defaultsVersion < HORIZON_24H_DEFAULTS_VERSION && next.settings.horizonMinutes === 180) {
      next = { ...next, settings: { ...next.settings, horizonMinutes: DEFAULT_HORIZON_MINUTES } };
    }
    return studioDefaults ? withFirefightingOff(next) : next;
  });
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

  // Evacuation and road closures, shown on both views (closures are set in 3D). Closures are edge
  // indices of one road area and are dropped when the board's area changes; they never change
  // the fire run.
  const [evacuationOn, setEvacuationOn] = useState(true);
  // How households respond to the order (population/householdBehavior.ts).
  const [householdBehavior, setHouseholdBehavior] = useState<HouseholdBehaviorMode>("grounded");
  // Which evacuation plan the 3D view plays: the fastest-exit policy or the optimiser's best.
  const [playPlan, setPlayPlan] = useState<PlayPlan>("fastest");
  const [roadTool, setRoadTool] = useState(false);
  const [orderMinute, setOrderMinute] = useState<number | null>(DEFAULT_ORDER_MINUTE);
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
  // Area size lives in the shared world (region.radiusMeters), so other tabs follow it.
  // Area size (null: the region's own board); shared through the world's region radius.
  // Default board: about 30 × 30 km (15 km half-width).
  const [boardRadius, setBoardRadius] = useState<number | null>(15_000);
  const { catalog, board } = useRegionBoard(regionId, boardAttempt, boardRadius);
  const region = findRegion(regionId);
  const sizeReady = useCachedBoards(
    region
      ? STUDIO_BOARD_SIZES.flatMap((size) =>
          size.radiusMeters === null
            ? []
            : [{ longitude: region.center.longitude, latitude: region.center.latitude, radiusMeters: size.radiusMeters, cellMeters: boardCellMetersFor(size.radiusMeters) }],
        )
      : [],
    board.status,
  );
  // Identity of the board a run was solved on: a different size is a different board.
  const boardId = boardRadius === null ? regionId : `${regionId}@${boardRadius / 1000}km`;
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
  const [asideDock, setAsideDock] = useState<HTMLDivElement | null>(null);

  // A new result starts at T+0, paused. Adjusted during render rather than in an effect.
  const [playbackKey, setPlaybackKey] = useState<number | null>(null);
  const resultKey = result?.requestId ?? null;
  if (playbackKey !== resultKey) {
    setPlaybackKey(resultKey);
    setPlaying(false);
    setFrameIndex(0);
    clockRef.current = 0;
    // A long run starts at a speed that shows it in about 40 s (a 72 h run at ×120).
    if (result && speed < speedForHorizon(result.scenario.settings.horizonMinutes)) {
      setSpeed(speedForHorizon(result.scenario.settings.horizonMinutes));
    }
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

  // While an aside holds the lock it drives `clockRef` (the dispatcher's session clock): follow
  // it so the 2D map's fire and the playback bar show the same minute.
  useEffect(() => {
    if (!locked || frameMinutes.length === 0) return;
    let handle = 0;
    const tick = () => {
      setFrameIndex(frameIndexAt(frameMinutes, clockRef.current));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [locked, frameMinutes]);

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
    applyScenario(freshScenario(emptyScenario()));
    setMode("select");
  }, [applyScenario, draftKey, freshScenario]);

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

  // The area size is part of the shared world's region (useStudioWorldSync writes it).
  const selectBoardSize = useCallback(
    (radiusMeters: number | null) => {
      if (radiusMeters === boardRadius) return;
      setPlaying(false);
      cancel();
      markStale();
      setBoardRadius(radiusMeters);
    },
    [boardRadius, cancel, markStale],
  );
  /** Region and size together (the shared world, a restored scenario). */
  const selectBoard = useCallback(
    (id: string, radiusMeters: number | null) => {
      selectRegion(id);
      selectBoardSize(radiusMeters);
    },
    [selectRegion, selectBoardSize],
  );

  const handleLoadDemo = useCallback(() => {
    applyScenario(freshScenario(demoScenario()));
    setMode("select");
    // The demo's fires sit on the default board.
    selectRegion(STUDIO_DEFAULT_REGION_ID);
  }, [applyScenario, selectRegion, freshScenario]);

  // The 3D view shows the run only while the board it was started on is still selected.
  const dioramaShowsRun = result !== null && result.boardId === boardId;
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

  // Fire facilities around the board (CAL FIRE layer; local-only data, may be absent): the
  // firefighting resources are a pure function of them (studio/mapResources.ts).
  const basesPoint = useMemo((): [number, number] | null => {
    if (!scenario.firefighting?.enabled) return null;
    if (area) return [(area.bbox[0] + area.bbox[2]) / 2, (area.bbox[1] + area.bbox[3]) / 2];
    const first = scenario.ignitions
      .filter((ignition) => ignition.enabled)
      .sort((a, b) => a.startMinute - b.startMinute)[0];
    return first ? [first.location.longitude, first.location.latitude] : null;
  }, [scenario, area]);
  const suppressionBases = useSuppressionBases(basesPoint);
  const fromMap = useMemo(() => mapResources(area, suppressionBases), [area, suppressionBases]);

  /**
   * The run card from the units on the map (studio/mapResources.ts), each ground unit driven from
   * its own base over the board's roads on its access class's graph to the first fire, reported
   * after its call-in delay (studio/crewDispatch.ts); aircraft fly from the air bases in reach.
   */
  const planCrews = useCallback((): RunDispatch | undefined => {
    const settings = scenario.firefighting;
    if (!settings?.enabled) return undefined;
    const first = scenario.ignitions
      .filter((ignition) => ignition.enabled)
      .sort((a, b) => a.startMinute - b.startMinute)[0];
    if (!first) return undefined;
    if (!area || !fromMap) {
      return {
        dispatch: null,
        note: "The board's roads and fire stations were not loaded, so no units were sent.",
        airBases: null,
        resources: {},
      };
    }
    const fire: [number, number] = [first.location.longitude, first.location.latitude];
    const plan = planMapDispatch(fromMap, area, fire, scenario.settings, dioramaLandscape);
    // Dispatched after the call-in and processing delay (response/report.ts), not at ignition.
    const { dispatch, note } =
      plan.units.length > 0
        ? planCrewDispatch(
            area,
            fire,
            first.startMinute + ignitionReportDelayMinutes(dioramaLandscape, first.location, first.startMinute, settings),
            plan.units,
            (edge) => closedEdges.has(edge),
            dioramaLandscape,
            suppressionBases,
          )
        : { dispatch: null, note: null };
    dispatch?.notes.unshift(plan.text);
    return {
      dispatch,
      note: note
        ? `${note} Crews were assumed on site after ${settings.responseMinutes} min.`
        : plan.units.length === 0
          ? plan.text
          : null,
      airBases: plan.airBases,
      resources: plan.counts,
    };
  }, [scenario, area, closedEdges, dioramaLandscape, suppressionBases, fromMap]);

  const handleRun = useCallback(() => {
    setPlaying(false);
    run(studioDefaults ? withFirefightingOff(scenario) : scenario, { id: boardId, grid: regionGrid }, planCrews());
  }, [run, scenario, boardId, regionGrid, planCrews]);
  // "Random scenario" (studio/randomScenario.ts): one seed picks the region, date, ignitions,
  // weather source and natural variation. Stages: switch board, wait for it and its roads, build
  // (weather fetch), apply, then run once the first fire's crew bases have loaded.
  const [keepArea, setKeepArea] = useState(false);
  const [placement, setPlacement] = useState<IgnitionPlacement>("away");
  const [seedText, setSeedText] = useState("");
  const [randomSummary, setRandomSummary] = useState<string | null>(null);
  const [recenterKey, setRecenterKey] = useState<string | null>(null);
  const [randomJob, setRandomJob] = useState<{
    seed: number;
    regionId: string;
    building: boolean;
    waited: boolean;
  } | null>(null);
  const [pendingRun, setPendingRun] = useState<{ scenario: StudioScenario; waited: boolean } | null>(null);

  // Shared world (docs/shared-world.md): region, size, date, weather, fires, variation and seed.
  const worldTab = storageNamespace === "dispatch" ? "dispatch" : "simulation";
  const world = useStudioWorldSync({
    tab: worldTab,
    scenario,
    applyScenario,
    regionId,
    boardRadius,
    selectBoard,
    showNotice,
  });
  const { noteRandom } = world;

  const handleRandomScenario = useCallback((forceKeepArea?: boolean) => {
    if (randomJob) return;
    const typed = Number(seedText.trim());
    const seed =
      seedText.trim() !== "" && Number.isInteger(typed) && typed > 0 && typed <= 2_147_483_647
        ? typed
        : Math.floor(Math.random() * 2_147_483_646) + 1;
    setSeedText(String(seed));
    const target = keepArea || forceKeepArea === true ? regionId : randomRegionId(seed);
    setRandomSummary(null);
    if (target !== regionId) selectRegion(target);
    setRandomJob({ seed, regionId: target, building: false, waited: false });
  }, [randomJob, seedText, keepArea, regionId, selectRegion]);

  // Give up waiting for roads after a while; a board that failed to load ends the job.
  useEffect(() => {
    if (!randomJob || randomJob.building) return;
    if (board.status === "error" && regionId === randomJob.regionId) {
      setRandomJob(null);
      showNotice("The region board did not load, so no random scenario was built.");
      return;
    }
    const handle = window.setTimeout(() => setRandomJob((j) => (j ? { ...j, waited: true } : j)), 15000);
    return () => window.clearTimeout(handle);
  }, [randomJob, board.status, regionId, showNotice]);

  useEffect(() => {
    if (!randomJob || randomJob.building) return;
    const target = findRegion(randomJob.regionId);
    if (!target || regionId !== randomJob.regionId || !regionGrid) return;
    // The board of the previous region stays in state for a render after the switch.
    if (cellAt(regionGrid, { longitude: target.center.longitude, latitude: target.center.latitude }) < 0) return;
    const roadsSettled = streets.status !== "idle" && streets.status !== "loading";
    if (!roadsSettled && !randomJob.waited) return;
    const job = randomJob;
    setRandomJob({ ...job, building: true });
    void buildRandomScenario({
      seed: job.seed,
      region: target,
      grid: regionGrid,
      area,
      // Every streets tile's road vertices: `area` is only the centre tile of a large board.
      roadNodes: streets.status === "ready" ? streets.scenery.edges.flatMap((edge) => edge.coords) : null,
      base: freshScenario(emptyScenario()),
      placement,
    }).then((built) => {
      setRandomJob(null);
      if (!built) {
        showNotice("No burnable ground found on this board.");
        return;
      }
      setEvacuationOn(true);
      noteRandom({
        series: built.scenario.settings.weatherSeries,
        choice: built.conditions,
        seed: job.seed,
      });
      applyScenario(built.scenario);
      setSelectedId(null);
      setRandomSummary(built.summary);
      announceRandom(worldTab, job.seed);
      setRecenterKey(built.scenario.id);
      showNotice("Random scenario built (simulated).");
      setPendingRun({ scenario: built.scenario, waited: false });
    });
  }, [randomJob, regionId, regionGrid, streets, area, placement, applyScenario, showNotice, noteRandom, worldTab]);

  // Run once the first fire's crew bases are in (or after a short wait).
  useEffect(() => {
    if (!pendingRun) return;
    if (pendingRun.scenario === scenario && (suppressionBases || pendingRun.waited)) {
      setPendingRun(null);
      handleRun();
      return;
    }
    if (pendingRun.waited) return;
    const handle = window.setTimeout(() => setPendingRun((p) => (p ? { ...p, waited: true } : p)), 3000);
    return () => window.clearTimeout(handle);
  }, [pendingRun, scenario, suppressionBases, handleRun]);

  const randomControls = (
    <div className="studio-random">
      <div className="studio-row">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleRandomScenario()}
          disabled={state.phase === "loading-landscape" || state.phase === "computing" || randomJob !== null}
          title="Pick a seeded random place, date and fire, then run it. Simulated; ignition placement near roads is an assumption."
        >
          {randomJob ? "Building…" : "Random scenario"}
        </Button>
        <label className="studio-hint">
          <input type="checkbox" checked={keepArea} onChange={(e) => setKeepArea(e.target.checked)} /> Keep this area
        </label>
      </div>
      <label className="studio-hint">
        Fire starts{" "}
        <select
          value={placement}
          onChange={(e) => setPlacement(e.target.value as IgnitionPlacement)}
          aria-label="Where random fires start"
        >
          {(Object.keys(PLACEMENT_LABELS) as IgnitionPlacement[]).map((key) => (
            <option key={key} value={key}>
              {PLACEMENT_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <label className="studio-hint">
        Seed{" "}
        <input
          type="text"
          inputMode="numeric"
          value={seedText}
          placeholder="new each time"
          onChange={(e) => setSeedText(e.target.value)}
          aria-label="Random scenario seed"
          style={{ width: "9em" }}
        />
      </label>
      {randomSummary && <p className="studio-hint">{randomSummary} (simulated)</p>}
    </div>
  );

  const quickSetup = (
    <div className="studio-random">
      <div className="studio-field">
        <label htmlFor="studio-quick-region">Location</label>
        <select
          id="studio-quick-region"
          className="ui-input"
          value={regionId}
          onChange={(event) => selectRegion(event.target.value)}
        >
          {REGION_AREAS.map((areaName) => (
            <optgroup key={areaName} label={areaName}>
              {CALIFORNIA_REGIONS.filter((entry) => entry.area === areaName).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="studio-field">
        <label htmlFor="studio-quick-size">Map size</label>
        <select
          id="studio-quick-size"
          className="ui-input"
          value={boardRadius ?? ""}
          onChange={(event) => selectBoardSize(event.target.value === "" ? null : Number(event.target.value))}
        >
          {STUDIO_BOARD_SIZES.map((size) => (
            <option key={size.label} value={size.radiusMeters ?? ""}>
              {size.label}
            </option>
          ))}
        </select>
      </div>
      <div className="studio-field">
        <label htmlFor="studio-quick-placement">Fire starts</label>
        <select
          id="studio-quick-placement"
          className="ui-input"
          value={placement}
          onChange={(e) => setPlacement(e.target.value as IgnitionPlacement)}
        >
          {(Object.keys(PLACEMENT_LABELS) as IgnitionPlacement[]).map((key) => (
            <option key={key} value={key}>
              {PLACEMENT_LABELS[key]}
            </option>
          ))}
        </select>
      </div>
      <Button
        onClick={() => handleRandomScenario(true)}
        disabled={state.phase === "loading-landscape" || state.phase === "computing" || randomJob !== null}
        title="Build a seeded random fire in this area and run it. Simulated."
      >
        {randomJob ? "Building…" : "Generate random scenario"}
      </Button>
      <details>
        <summary className="studio-hint">Seed {seedText || "(new each time)"}</summary>
        <label className="studio-hint">
          Use seed…{" "}
          <input
            type="text"
            inputMode="numeric"
            value={seedText}
            placeholder="new each time"
            onChange={(e) => setSeedText(e.target.value)}
            aria-label="Random scenario seed"
            style={{ width: "9em" }}
          />
        </label>
      </details>
      {randomSummary && <p className="studio-hint">{randomSummary} (simulated)</p>}
    </div>
  );

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
            ...(studioDefaults && householdBehavior === "grounded"
              ? { departureDelays: householdDepartureDelays(area) }
              : {}),
          }
        : null,
    [area, exposure, result, closedEdges, orderMinute, shownHandoff, studioDefaults, householdBehavior],
  );
  const [publishOn, setPublishOn] = useState(false);
  // The evacuation plays on both views; the /dispatch page draws its own.
  const showEvacuation = evacuationOn && !Aside;
  // The summaries feed the 3D view's evacuation panel only.
  const panelShown = showEvacuation && view === "diorama";

  const baselineSummary = useMemo(
    () =>
      panelShown && evacuationInputs
        ? simulateEvacuation({ ...evacuationInputs, closedEdges: new Set() })
        : null,
    // Not rerun when only the closures change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelShown, area, exposure, result, orderMinute, shownHandoff, householdBehavior],
  );
  const closuresSummary = useMemo(
    () =>
      panelShown && evacuationInputs && closedEdges.size > 0
        ? simulateEvacuation(evacuationInputs)
        : null,
    [panelShown, evacuationInputs, closedEdges],
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
    () => (panelShown && area ? { area, exposure, closedEdges, inputs: playedInputs } : null),
    [panelShown, area, exposure, closedEdges, playedInputs],
  );
  const closedRoadList = useMemo(
    () => (area ? [...closedEdges].map((edge) => area.edges[edge]).filter(Boolean) : []),
    [area, closedEdges],
  );

  // ---- Derived display state -------------------------------------------------------------

  const stale = state.stale;
  const safeFrameIndex = Math.max(0, Math.min(frameIndex, frameMinutes.length - 1));
  const currentMinute = frameMinutes[safeFrameIndex] ?? 0;
  // Wind shown at the playback minute: the weather step the solver used there (10-min steps),
  // or the scenario's constant wind when no hourly series is active.
  const weatherSeries = scenario.settings.weatherSeries;
  const baseWindSpeedMph = scenario.settings.windSpeedMph;
  const baseWindFromDegrees = scenario.settings.windFromDegrees;
  const displayWind = useMemo(() => {
    if (seriesActive(weatherSeries)) {
      const w = weatherAtStep(weatherSeries, weatherStepAt(currentMinute));
      return { speedMph: w.windSpeedMph, fromDegrees: w.windFromDegrees };
    }
    return { speedMph: baseWindSpeedMph, fromDegrees: baseWindFromDegrees };
  }, [weatherSeries, currentMinute, baseWindSpeedMph, baseWindFromDegrees]);
  const publishStatus = useSimStatePublisher(
    publishOn && !Aside,
    evacuationInputs,
    currentMinute,
    `Studio run · ${area?.name ?? "area"} · ${orderMinute === null ? "threat-based orders" : `order everyone at T+${orderMinute}`}`,
  );
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
        const largest = STUDIO_BOARD_SIZES[STUDIO_BOARD_SIZES.length - 1].radiusMeters;
        const bigger =
          result.boardId === null
            ? "Put the fires on the region board and choose a larger Area size, or shorten the run."
            : boardRadius === largest
              ? "This is already the largest board: shorten the run to stay inside it."
              : "Choose a larger Area size and run again, or shorten the run.";
        list.push(
          `Fire reached the edge of the modelled area at ${formatElapsed(Math.round(solved.reachedEdgeMinute))}; the footprint after that is incomplete. ${bigger}`,
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
  }, [result, shownRun, currentMinute, stale, boardRadius]);

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

  // Local clock and day/night on the playback bar: the scenario's T+0 (the Firefighting start
  // time, which also sets the aircraft's daylight windows), with sun times at the first fire.
  const playbackClock = useMemo(() => {
    const first = result?.scenario.ignitions.find((ignition) => ignition.enabled);
    if (!result || !first) return undefined;
    const startMs = startMsOf(result.scenario.firefighting ?? DEFAULT_FIREFIGHTING);
    const weatherStart = result.scenario.settings.weatherSeries?.enabled
      ? Date.parse(result.scenario.weather?.query.startUtc ?? "")
      : Number.NaN;
    const mismatch = Number.isFinite(weatherStart) && Math.abs(weatherStart - startMs) > 3_600_000;
    return {
      startMs,
      latitude: first.location.latitude,
      longitude: first.location.longitude,
      note: mismatch
        ? "The weather starts at another time: set T+0 local time under Firefighting to match"
        : "T+0 local time is set under Firefighting",
    };
  }, [result]);

  const dioramaRun = useMemo<DioramaRun | null>(
    () =>
      result && shownRun
        ? {
            arrivalMinutes: shownRun.arrivalMinutes,
            scenario: {
              horizonMinutes: result.scenario.settings.horizonMinutes,
              stepMinutes: studioDisplayStepMinutes(result.scenario.settings.horizonMinutes),
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
  // Every facility that can respond, labelled: what is on the map is what can respond.
  useMapStations(view === "map" ? studioMap : null, scenario.firefighting?.enabled ? (fromMap?.fleet.facilities ?? null) : null);

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
                startMs={startMsOf(result?.scenario.firefighting ?? DEFAULT_FIREFIGHTING)}
                landscape={dioramaLandscape}
                run={dioramaShowsRun ? dioramaRun : null}
                ignitions={dioramaIgnitions}
                windFromDegrees={displayWind.fromDegrees}
                windSpeedMph={displayWind.speedMph}
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
                      publish={publishOn}
                      onPublish={setPublishOn}
                      publishStatus={publishStatus}
                      behavior={householdBehavior}
                      onBehavior={setHouseholdBehavior}
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
                    <div className="studio-region__row">
                      <label htmlFor="studio-area-size">Area size</label>
                      <select
                        id="studio-area-size"
                        className="ui-input"
                        value={boardRadius ?? ""}
                        onChange={(event) =>
                          selectBoardSize(event.target.value === "" ? null : Number(event.target.value))
                        }
                      >
                        {STUDIO_BOARD_SIZES.map((size) => (
                          <option key={size.label} value={size.radiusMeters ?? ""}>
                            {size.label}
                            {size.radiusMeters !== null && region
                              ? ` \u2014 ${readinessLabel(
                                  sizeReady({ longitude: region.center.longitude, latitude: region.center.latitude, radiusMeters: size.radiusMeters, cellMeters: boardCellMetersFor(size.radiusMeters) }),
                                  size.radiusMeters,
                                  boardCellMetersFor(size.radiusMeters),
                                )}`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    {boardRadius !== null && (
                      <p className="studio-region__note">
                        {boardCellMetersFor(boardRadius)} m cells
                        {boardCellMetersFor(boardRadius) > 30 ? " (coarser than the 30 m region boards)" : ""}.
                        {region &&
                        sizeReady({ longitude: region.center.longitude, latitude: region.center.latitude, radiusMeters: boardRadius, cellMeters: boardCellMetersFor(boardRadius) })
                          ? "This size is cached and loads right away."
                          : `The first load of this size takes about ${firstLoadSeconds(boardRadius, boardCellMetersFor(boardRadius))} s; later loads are cached.`}
                        {boardRadius > 13_000
                          ? " Evacuation and roads cover the centre of the board only."
                          : ""}
                      </p>
                    )}
                    <p className="studio-region__note">
                      {board.status === "ready"
                        ? board.source === "stored"
                          ? "Stored board: LANDFIRE fuels and terrain, prebuilt."
                          : board.source === "cached"
                            ? "Cached board: LANDFIRE fuels and terrain from an earlier live load."
                            : boardRadius !== null
                              ? "LANDFIRE fuels and terrain at the chosen size."
                              : "Stored board unavailable; loaded live from LANDFIRE."
                        : board.status === "loading"
                          ? board.storedUnavailable
                            ? "Stored board unavailable; loading live from LANDFIRE…"
                            : boardRadius !== null
                              ? "Loading the larger board from LANDFIRE…"
                              : "Loading stored board…"
                          : "Board could not be loaded."}{" "}
                      Fires on the board run on it; others download their own area.
                    </p>
                  </Panel>
                }
                emptyState={
                  board.status === "loading" ? (
                    <LoadingState>
                      {boardRadius !== null
                        ? `Loading a ${boardRadius / 500} km wide board around ${region?.name ?? "the region"}. A new size takes a while the first time; later loads are cached.`
                        : board.storedUnavailable
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
                recenterKey={recenterKey}
                ignitions={scenario.ignitions}
                ignitionStates={ignitionStates}
                selectedId={selectedId}
                mode={mode}
                visibleFrames={visibleFrames}
                currentMinute={currentMinute}
                horizonMinutes={playbackHorizon}
                windSpeedMph={displayWind.speedMph}
                windFromDegrees={displayWind.fromDegrees}
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
            <WorldBar
              className="studio-world"
              tab={worldTab}
              sync={world.sync}
              getExtras={world.getExtras}
              onLoaded={(saved) => world.restoreExtras(saved.extras[worldTab])}
              placement="up"
              align="start"
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
              randomScenario={randomControls}
              quickSetup={quickSetup}
              onCancel={cancel}
              onClear={handleClear}
              onExport={handleExport}
              onImport={handleImport}
              onLoadDemo={handleLoadDemo}
              liveDrill={<LiveDrillAction result={result} stale={stale} />}
              firefighting={
                studioDefaults ? undefined : <FirefightingFields
                  scenario={scenario}
                  onScenarioChange={applyScenario}
                  idPrefix="studio"
                  resources={fromMap}
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
          {showEvacuation && dioramaShowsRun && (
            <StudioPeople
              map={view === "map" ? studioMap : null}
              inputs={playedInputs}
              pending={!playedInputs && streets.status === "loading"}
              clockRef={clockRef}
              playing={playing}
              speed={speed}
              startMs={startMsOf(result.scenario.firefighting ?? DEFAULT_FIREFIGHTING)}
              behavior={behaviorLabel(householdBehavior === "grounded")}
            />
          )}
          {Aside && <div className="studio-aside-dock" ref={setAsideDock} />}
          <PlaybackBar
            enabled={!locked && result !== null && frameMinutes.length > 0}
            speedLocked={locked}
            frameMinutes={frameMinutes}
            frameIndex={safeFrameIndex}
            horizonMinutes={playbackHorizon}
            playing={playing}
            speed={speed}
            speedChoices={SPEED_CHOICES}
            clock={playbackClock}
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
          map={view === "map" ? studioMap : null}
          dock={asideDock}
        />
      )}
    </main>
  );
}
