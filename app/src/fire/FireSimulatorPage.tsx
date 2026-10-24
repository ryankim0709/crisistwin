import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../diorama/ui/format";
import type { FireDioramaSceneApi, GroundClickMode } from "./diorama/types";
import { FireDioramaScene } from "./diorama/FireDioramaScene";
import AreaPicker from "./ui/AreaPicker";
import { AREA_PRESETS, DEFAULT_AREA } from "./ui/areaPresets";
import {
  AREA_SIZES,
  DEFAULT_AREA_SIZE,
  effectiveRadiusMeters,
  type AreaSizeId,
} from "./ui/areaSize";
import SatelliteFireMap from "./SatelliteFireMap";
import FireDock from "./ui/FireDock";
import FireLegend from "./ui/FireLegend";
import { formatDuration } from "./ui/format";
import { useFirePlayback } from "./useFirePlayback";
import { LIVE_SNAPSHOT_VERSION, type LiveSnapshot } from "../live/contracts";
import { LiveShareToggle } from "../live/LiveShareToggle";
import { fireRings, hectares } from "../live/snapshot";
import { newSessionId, useLiveBroadcast } from "../live/useLiveBroadcast";
import {
  RegionUnavailableError,
  fetchRegionCatalog,
  fetchRegionLandscape,
} from "./landscapePackage";
import { DEFAULT_REGION_ID, CALIFORNIA_REGIONS, REGION_AREAS } from "./regions";
import { landscapeCellMetersFor, loadLandscape, type LandscapeGrid } from "./landscape";
import type { FuelMoisture } from "./rothermel";
import {
  DEFAULT_MIDFLAME_ADJUSTMENT,
  DEFAULT_SPOTTING,
  DEFAULT_STRUCTURE_SPREAD,
  FIRE_HORIZON_MINUTES,
  FIRE_STEP_MINUTES,
  METERS_PER_MILE,
  MOISTURE_PRESETS,
  NonBurnableIgnitionError,
  SQUARE_METERS_PER_ACRE,
  SQUARE_METERS_PER_HECTARE,
  bearingBetween,
  cellAt,
  compassPoint,
  simulateFireSpread,
  type FireFrame,
  type FireRun,
  type GeoPoint,
} from "./spread";
import { fetchNwsWind, type NwsWindReading } from "./weather";
import type { ScenarioWindRecord } from "./scenarioWeather";
import WindSourcePicker from "./ui/WindSourcePicker";
import {
  Button,
  EvidenceTag,
  Facts,
  IconButton,
  LoadingState,
  Notice,
  Panel,
  SegmentedControl,
  Spinner,
  type SegmentedOption,
} from "../ui";
import { useBoardStreets } from "./useBoardStreets";
import "./fire.css";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** The legend starts expanded only where a wide stage leaves room for it. */
const WIDE_QUERY = "(min-width: 1680px)";
/** Stage widths at or below this use the phone layout (matches the container query in fire.css). */
const PHONE_STAGE_MAX_WIDTH_PX = 720;
/** Elements whose own Space handling must win over the global play/pause shortcut. */
const SPACE_OWNERS =
  "button, a[href], select, textarea, summary, [contenteditable], input:not([type='range'])";
const MAX_WIND_SPEED_MPH = 60;
/** From this horizon on, constant weather is a material caveat. */
const LONG_HORIZON_MINUTES = 720;
/** LANDFIRE's native cell size; anything coarser is disclosed next to the area. */
const NATIVE_CELL_METERS = 30;

/**
 * Demo defaults. These are presentation choices, not calibrated parameters: they put the
 * simulator in peak fire weather on a first click so the run is visibly fast. No calibration
 * report was available when these were set, so treat the wind speed below as UNVALIDATED.
 * The midflame factor is left at the sourced default (Albini & Baughman 1979) rather than
 * tuned, because inventing a value there would quietly bias every spread rate on the page.
 */
const DEFAULT_PRESET = MOISTURE_PRESETS[0];
/** Dry downslope wind event, in the range of the Diablo/Santa Ana winds. Unvalidated. */
const DEFAULT_WIND_SPEED_MPH = 40;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * One line of provenance for an NWS reading: where it came from, when it is for, and the
 * source's own wording, so a reader can tell the observation from the slider value.
 */
function nwsProvenance(reading: NwsWindReading, clampedFromMph: number | null): string {
  const range = reading.windSpeedIsRangeUpperBound ? " (upper bound of the reported range)" : "";
  const clamped =
    clampedFromMph === null
      ? ""
      : ` Clamped from ${clampedFromMph} mph to the ${MAX_WIND_SPEED_MPH} mph slider maximum.`;
  return (
    `Forecast — ${reading.locationLabel}, US National Weather Service hourly forecast for the ` +
    `hour beginning ${reading.forecastTimeUtcIso}. Reported ${reading.windSpeedText}${range} ` +
    `from ${reading.windFromCompass}.${clamped}`
  );
}

function formatKm(meters: number): string {
  return String(Number((meters / 1000).toFixed(1)));
}

function formatArea(squareMeters: number): string {
  const hectares = squareMeters / SQUARE_METERS_PER_HECTARE;
  const acres = squareMeters / SQUARE_METERS_PER_ACRE;
  return `${hectares.toFixed(hectares < 10 ? 1 : 0)} ha · ${acres.toFixed(acres < 10 ? 1 : 0)} acres`;
}

function formatHectares(squareMeters: number): string {
  const hectares = squareMeters / SQUARE_METERS_PER_HECTARE;
  return `${hectares.toFixed(hectares < 10 ? 1 : 0)} ha`;
}

/** A share of the burn, never rounded down to a flat 0% while it is actually nonzero. */
function formatShare(part: number, total: number): string {
  if (total <= 0) return "0%";
  const percent = (part / total) * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${percent.toFixed(0)}%`;
}

function formatShareAndArea(squareMeters: number, total: number): string {
  return `${formatShare(squareMeters, total)} · ${formatHectares(squareMeters)}`;
}

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km · ${(meters / METERS_PER_MILE).toFixed(2)} mi`;
}

/** Where the board's data came from, shown next to the area. */
type Provenance =
  | { kind: "stored"; builtAt: string; cellMeters: number }
  | { kind: "live"; storedUnavailable: boolean };

/** A stored SoCal region, or a custom area loaded live. */
const CUSTOM_SELECTION = "custom";

type ViewMode = "diorama" | "satellite";
const VIEW_OPTIONS: readonly SegmentedOption<ViewMode>[] = [
  { value: "diorama", label: "Diorama", title: "Diorama" },
  {
    value: "satellite",
    label: "Satellite",
    title: "Satellite (USGS aerial imagery, needs a network connection)",
  },
];
const CLICK_MODE_OPTIONS: readonly SegmentedOption<GroundClickMode>[] = [
  { value: "origin", label: "Ignition point" },
  { value: "wind", label: "Wind direction", title: "Needs an ignition point first" },
];
const VIEW_STORAGE_KEY = "crisistwin.fire.view";
/** How long the "outside the loaded region" hint stays up. */
const OUTSIDE_HINT_MS = 3500;

function readStoredView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "satellite" ? "satellite" : "diorama";
  } catch {
    return "diorama";
  }
}

type CatalogState =
  { status: "loading" } | { status: "ready"; ids: ReadonlySet<string> } | { status: "error" };

type LandscapeState =
  | { status: "idle" }
  | { status: "loading"; storedUnavailable: boolean }
  | { status: "ready"; grid: LandscapeGrid; provenance: Provenance }
  | { status: "error"; message: string };

/** Provenance for the wind inputs: either the user's own assumption, or an NWS reading. */
type WindSourceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; reading: NwsWindReading; clampedFromMph: number | null }
  | { status: "error"; message: string };

type SceneStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/** The last frame at or before `minutes`; null before the first frame. */
function frameAtOrBefore(frames: readonly FireFrame[], minutes: number): FireFrame | null {
  let found: FireFrame | null = null;
  for (const candidate of frames) {
    if (candidate.elapsedMinutes > minutes) break;
    found = candidate;
  }
  return found;
}

function areaLabel(center: GeoPoint): string {
  const preset = AREA_PRESETS.find(
    (candidate) =>
      candidate.point.latitude === center.latitude &&
      candidate.point.longitude === center.longitude,
  );
  return preset ? preset.label : `${center.latitude.toFixed(2)}, ${center.longitude.toFixed(2)}`;
}

export default function FireSimulatorPage() {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);

  const [areaCenter, setAreaCenter] = useState<GeoPoint>(DEFAULT_AREA.point);
  const [view, setView] = useState<ViewMode>(readStoredView);
  const [fitSignal, setFitSignal] = useState(0);
  const [outsideHint, setOutsideHint] = useState(false);
  const [selection, setSelection] = useState<string>(DEFAULT_REGION_ID);
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [areaSize, setAreaSize] = useState<AreaSizeId>(DEFAULT_AREA_SIZE);
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [origin, setOrigin] = useState<GeoPoint | null>(null);
  const [windSpeedMph, setWindSpeedMph] = useState(DEFAULT_WIND_SPEED_MPH);
  const [windFromDegrees, setWindFromDegrees] = useState(45);
  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const [moisture, setMoisture] = useState<FuelMoisture>(DEFAULT_PRESET.moisture);
  const midflameAdjustment = DEFAULT_MIDFLAME_ADJUSTMENT;
  const [spottingEnabled, setSpottingEnabled] = useState(true);
  const spottingDistanceMeters = DEFAULT_SPOTTING.maxDistanceMeters;
  const [structureSpreadEnabled, setStructureSpreadEnabled] = useState(true);
  const structureSpreadRate = DEFAULT_STRUCTURE_SPREAD.rateMetersPerMinute;
  const horizonMinutes = FIRE_HORIZON_MINUTES;
  const [clickMode, setClickMode] = useState<GroundClickMode>("origin");
  const [showFuel, setShowFuel] = useState(false);
  const [landscape, setLandscape] = useState<LandscapeState>({ status: "idle" });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [windSource, setWindSource] = useState<WindSourceState>({ status: "idle" });
  // Scenario weather (historical, worst case, forecast series) behind the current wind, if any.
  const [scenarioWind, setScenarioWind] = useState<ScenarioWindRecord | null>(null);

  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [sceneStatus, setSceneStatus] = useState<SceneStatus>({ kind: "loading" });
  const [phone, setPhone] = useState(
    () =>
      typeof window !== "undefined" &&
      "matchMedia" in window &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const [scenarioOpenChoice, setScenarioOpenChoice] = useState<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FireDioramaSceneApi | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  const originRef = useRef<GeoPoint | null>(origin);
  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  // The scenario panel starts open on wide stages and closed on phones until the user decides.
  const scenarioOpen = scenarioOpenChoice ?? !phone;

  const region = CALIFORNIA_REGIONS.find((candidate) => candidate.id === selection) ?? null;
  // Stored regions are fixed boards; only a custom area is sized by the horizon and area size.
  const radiusMeters = region
    ? region.radiusMeters
    : effectiveRadiusMeters(horizonMinutes, areaSize);
  const requestedCellMeters = region ? region.cellMeters : landscapeCellMetersFor(radiusMeters);
  const centerLatitude = region ? region.center.latitude : areaCenter.latitude;
  const centerLongitude = region ? region.center.longitude : areaCenter.longitude;

  // Which regions are stored is advisory: a load still tries the store directly.
  useEffect(() => {
    const controller = new AbortController();
    fetchRegionCatalog(controller.signal)
      .then((regions) => setCatalog({ status: "ready", ids: new Set(regions.map((r) => r.id)) }))
      .catch(() => {
        if (!controller.signal.aborted) setCatalog({ status: "error" });
      });
    return () => controller.abort();
  }, [loadAttempt]);

  // Fuel and terrain depend only on where and how far, so wind, moisture and ignition edits
  // never refetch. An older request can never overwrite a newer one.
  const resetScenarioRef = useRef<() => void>(() => undefined);
  const requestRef = useRef(0);
  useEffect(() => {
    // One request id covers the stored and the live path, so neither can overwrite a newer load.
    const request = ++requestRef.current;
    const controller = new AbortController();
    const stale = () => controller.signal.aborted || request !== requestRef.current;
    setLandscape({ status: "loading", storedUnavailable: false });

    const finish = (grid: LandscapeGrid, provenance: Provenance) => {
      // A longer or shorter horizon changes a custom box; keep the ignition only if inside.
      const kept = originRef.current;
      if (kept && cellAt(grid, kept) < 0) resetScenarioRef.current();
      setLandscape({ status: "ready", grid, provenance });
    };
    const live = (storedUnavailable: boolean) =>
      loadLandscape(centerLongitude, centerLatitude, radiusMeters, controller.signal, {
        cellMeters: requestedCellMeters,
      }).then((grid) => {
        if (!stale()) finish(grid, { kind: "live", storedUnavailable });
      });

    const work = region
      ? fetchRegionLandscape(region.id, controller.signal).then(
          ({ grid, header }) => {
            if (!stale()) {
              finish(grid, {
                kind: "stored",
                builtAt: header.builtAt,
                cellMeters: header.cellMeters,
              });
            }
          },
          (cause: unknown) => {
            if (stale()) return;
            // A missing store or a dead API is expected; a corrupt package is not.
            if (!(cause instanceof RegionUnavailableError) && !(cause instanceof TypeError)) {
              throw cause;
            }
            setLandscape({ status: "loading", storedUnavailable: true });
            return live(true);
          },
        )
      : live(false);
    work.catch((cause: unknown) => {
      if (stale()) return;
      setLandscape({
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not load fuel and terrain data.",
      });
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, centerLatitude, centerLongitude, radiusMeters, requestedCellMeters, loadAttempt]);

  const scenario = useMemo(
    () =>
      origin
        ? {
            origin,
            windSpeedMph,
            windFromDegrees,
            moisture,
            midflameAdjustment,
            stepMinutes: FIRE_STEP_MINUTES,
            horizonMinutes,
            spotting: {
              enabled: spottingEnabled,
              maxDistanceMeters: spottingDistanceMeters,
            },
            structureSpread: {
              enabled: structureSpreadEnabled,
              rateMetersPerMinute: structureSpreadRate,
            },
          }
        : null,
    [
      origin,
      windSpeedMph,
      windFromDegrees,
      moisture,
      midflameAdjustment,
      horizonMinutes,
      spottingEnabled,
      spottingDistanceMeters,
      structureSpreadEnabled,
      structureSpreadRate,
    ],
  );
  // Solving takes ~100 ms, so let the controls stay responsive while dragging.
  const deferredScenario = useDeferredValue(scenario);
  const grid = landscape.status === "ready" ? landscape.grid : null;
  // OSM roads and synthetic homes along residential streets for the diorama board.
  const streets = useBoardStreets(grid);
  const streetArea = streets.status === "ready" ? streets.area : null;

  const result = useMemo<{ run: FireRun | null; error: string | null }>(() => {
    if (!grid || !deferredScenario) return { run: null, error: null };
    // The deferred scenario can lag a grid swap; never solve an ignition outside the grid.
    if (cellAt(grid, deferredScenario.origin) < 0) return { run: null, error: null };
    try {
      return { run: simulateFireSpread(grid, deferredScenario), error: null };
    } catch (cause) {
      return {
        run: null,
        error:
          cause instanceof NonBurnableIgnitionError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : "This scenario could not be simulated.",
      };
    }
  }, [grid, deferredScenario]);

  const run = result.run;
  const frames = useMemo(() => run?.frames ?? [], [run]);

  // Scene creation: StrictMode-safe (the cleanup disposes, the re-run builds a fresh scene).
  useEffect(() => {
    // The diorama host only exists in the diorama view; the scene is rebuilt on return and the
    // effects below re-push every piece of state because `scene` changes.
    const host = sceneHostRef.current;
    if (view !== "diorama" || !host) return;
    let created: FireDioramaSceneApi;
    try {
      created = new FireDioramaScene(host, { reducedMotion: reducedMotionRef.current });
    } catch (error) {
      console.error("Fire diorama scene could not start", error);
      setSceneStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "WebGL could not be initialised.",
      });
      return;
    }
    sceneRef.current = created;
    setScene(created);
    setSceneStatus({ kind: "ready" });
    return () => {
      sceneRef.current = null;
      setScene(null);
      created.dispose();
    };
  }, [view]);

  // Continuous model time, pushed to the scene every animation frame without a React render.
  const onTime = useCallback((minutes: number) => sceneRef.current?.setTime(minutes), []);
  const playback = useFirePlayback(horizonMinutes, onTime);
  const { getTime, pause, restart: restartPlayback, seek: seekPlayback } = playback;

  useEffect(() => {
    scene?.setLandscape(grid);
  }, [scene, grid]);
  useEffect(() => {
    scene?.setStreets(streetArea);
  }, [scene, streetArea]);
  useEffect(() => {
    scene?.setRun(run);
    scene?.setTime(getTime());
  }, [scene, run, getTime]);
  useEffect(() => {
    scene?.setIgnition(origin);
  }, [scene, origin]);
  useEffect(() => {
    scene?.setWind(windFromDegrees, windSpeedMph);
  }, [scene, windFromDegrees, windSpeedMph]);
  useEffect(() => {
    scene?.setFuelOverlay(showFuel);
  }, [scene, showFuel]);
  useEffect(() => {
    scene?.setClickMode(clickMode);
  }, [scene, clickMode]);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    scene?.setReducedMotion(reducedMotion);
  }, [scene, reducedMotion]);

  // Start playback once a freshly placed ignition has a solved run.
  const runKey = run ? `${run.scenario.origin.latitude},${run.scenario.origin.longitude}` : null;
  const lastStartKey = useRef<string | null>(null);
  useEffect(() => {
    if (!runKey) {
      lastStartKey.current = null;
      return;
    }
    if (runKey === lastStartKey.current) return;
    lastStartKey.current = runKey;
    restartPlayback();
    setFitSignal((value) => value + 1);
  }, [runKey, restartPlayback]);

  // An NWS reading belongs to one ignition point and to wind values nobody has overridden.
  // Both the request id and the controller guard against a slow lookup landing after the
  // user has moved on.
  const windRequestRef = useRef(0);
  const windAbortRef = useRef<AbortController | null>(null);

  const dropWindProvenance = useCallback(() => {
    windRequestRef.current++;
    windAbortRef.current?.abort();
    windAbortRef.current = null;
    setWindSource((current) => (current.status === "idle" ? current : { status: "idle" }));
    setScenarioWind(null);
  }, []);

  const applyScenarioWind = useCallback(
    (record: ScenarioWindRecord | null) => {
      dropWindProvenance();
      if (record === null) return;
      setWindSpeedMph(record.applied.speed20ftMph);
      setWindFromDegrees(record.applied.fromDeg);
      setScenarioWind(record);
    },
    [dropWindProvenance],
  );

  useEffect(
    () => () => {
      windRequestRef.current++;
      windAbortRef.current?.abort();
      windAbortRef.current = null;
    },
    [],
  );

  const lookUpNwsWind = useCallback(() => {
    if (!origin) return;
    windAbortRef.current?.abort();
    const controller = new AbortController();
    windAbortRef.current = controller;
    const request = ++windRequestRef.current;
    setWindSource({ status: "loading" });
    fetchNwsWind(origin.latitude, origin.longitude, controller.signal)
      .then((reading) => {
        if (request !== windRequestRef.current) return;
        const rounded = Math.round(reading.windSpeedMph);
        const applied = clamp(rounded, 0, MAX_WIND_SPEED_MPH);
        setScenarioWind(null);
        setWindSpeedMph(applied);
        setWindFromDegrees(Math.round(((reading.windFromDegrees % 360) + 360) % 360));
        setWindSource({
          status: "ready",
          reading,
          clampedFromMph: applied === rounded ? null : rounded,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || request !== windRequestRef.current) return;
        setWindSource({
          status: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Could not read the National Weather Service wind forecast.",
        });
      });
  }, [origin]);

  const editWindSpeed = useCallback(
    (mph: number) => {
      if (!Number.isFinite(mph)) return;
      setWindSpeedMph(clamp(Math.round(mph), 0, MAX_WIND_SPEED_MPH));
      dropWindProvenance();
    },
    [dropWindProvenance],
  );

  const editWindDirection = useCallback(
    (degrees: number) => {
      if (!Number.isFinite(degrees)) return;
      setWindFromDegrees(((degrees % 360) + 360) % 360);
      dropWindProvenance();
    },
    [dropWindProvenance],
  );

  // Clicking the board never refetches: it only moves the ignition point or aims the wind.
  const handleGroundClick = useCallback(
    (point: GeoPoint) => {
      if (clickMode === "wind") {
        if (origin) editWindDirection(Math.round((bearingBetween(origin, point) + 180) % 360));
        return;
      }
      // The satellite map can be clicked anywhere; the model only covers the loaded board.
      if (grid && cellAt(grid, point) < 0) {
        setOutsideHint(true);
        return;
      }
      // A reading belongs to one ignition point, so moving the point drops it.
      setOrigin(point);
      dropWindProvenance();
    },
    [clickMode, origin, editWindDirection, dropWindProvenance, grid],
  );
  useEffect(() => {
    if (!outsideHint) return;
    const timer = window.setTimeout(() => setOutsideHint(false), OUTSIDE_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [outsideHint]);

  function chooseView(next: ViewMode) {
    if (next === view) return;
    setView(next);
    setOutsideHint(false);
    if (next === "satellite" && hasRun) setFitSignal((value) => value + 1);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice just is not remembered.
    }
  }
  const groundClickRef = useRef(handleGroundClick);
  useEffect(() => {
    groundClickRef.current = handleGroundClick;
  }, [handleGroundClick]);
  useEffect(() => {
    scene?.onGroundClick((point) => groundClickRef.current(point));
  }, [scene]);

  function applyPreset(id: string) {
    const preset = MOISTURE_PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;
    setPresetId(id);
    setMoisture(preset.moisture);
  }

  function clearScenario() {
    setOrigin(null);
    pause();
    seekPlayback(0);
    setClickMode("origin");
    setDetailsOpen(false);
    dropWindProvenance();
  }
  // The load effect runs outside render, so it reaches the latest reset through a ref.
  useEffect(() => {
    resetScenarioRef.current = clearScenario;
  });

  function changeArea(center: GeoPoint, size?: AreaSizeId) {
    setAreaPickerOpen(false);
    clearScenario();
    if (size) setAreaSize(size);
    setSelection(CUSTOM_SELECTION);
    setAreaCenter(center);
  }

  function selectRegion(id: string) {
    if (id === selection) return;
    clearScenario();
    setSelection(id);
  }

  // Track the stage width for the phone layout, independent of whether WebGL started.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() =>
      setPhone(stage.getBoundingClientRect().width <= PHONE_STAGE_MAX_WIDTH_PX),
    );
    observer.observe(stage);
    setPhone(stage.getBoundingClientRect().width <= PHONE_STAGE_MAX_WIDTH_PX);
    return () => observer.disconnect();
  }, []);

  // Frame the board inside the part of the stage the floating overlay leaves uncovered.
  const hasRun = run !== null;

  // Resident app broadcast: the footprint of the latest 15-minute frame at the playback time.
  const liveSessionId = useMemo(() => (run ? newSessionId() : null), [run]);
  const liveMinute = Math.floor(playback.t);
  const playing = playback.playing;
  const getLiveSnapshot = useCallback((): LiveSnapshot | null => {
    if (!run || !liveSessionId) return null;
    const minute = Math.min(getTime(), horizonMinutes);
    const frame = [...run.frames].reverse().find((f) => f.elapsedMinutes <= minute);
    return {
      version: LIVE_SNAPSHOT_VERSION,
      source: "fire_model",
      session_id: liveSessionId,
      evidence_class: "simulated",
      playback: playing ? "playing" : minute >= horizonMinutes ? "finished" : "paused",
      area_name: region?.name ?? "Custom area",
      minute: Math.round(minute),
      horizon_minutes: horizonMinutes,
      wind: { from_degrees: run.scenario.windFromDegrees, speed_mph: run.scenario.windSpeedMph },
      bbox: null,
      fire: {
        perimeters: frame ? fireRings(frame.perimeters) : [],
        burned_area_ha: hectares(frame?.burnedAreaSquareMeters ?? 0),
      },
      zones: [],
      agent: null,
    };
  }, [run, liveSessionId, getTime, playing, horizonMinutes, region]);
  const liveBroadcast = useLiveBroadcast(
    getLiveSnapshot,
    `${liveSessionId}:${liveMinute}:${playing}`,
  );
  useEffect(() => {
    const stage = stageRef.current;
    const overlay = stage?.querySelector<HTMLElement>(".fr-overlay");
    if (!stage || !overlay) return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      let top = 0;
      let bottom = 0;
      let left = 0;
      for (const child of Array.from(overlay.children)) {
        const r = child.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (child.classList.contains("fr-scenario")) {
          if (phone) bottom = Math.max(bottom, box.bottom - r.top);
          else left = Math.max(left, r.right - box.left);
        } else if (r.top + r.height / 2 < middle) top = Math.max(top, r.bottom - box.top);
        else bottom = Math.max(bottom, box.bottom - r.top);
      }
      scene?.setViewInsets({ top, right: 0, bottom, left });
      // The satellite map's own controls are kept clear of the floating panels with these.
      stage.style.setProperty("--fr-inset-top", `${top}px`);
      stage.style.setProperty("--fr-inset-bottom", `${bottom}px`);
      stage.style.setProperty("--fr-inset-left", `${left}px`);
    };
    const observer = new ResizeObserver(measure);
    const observeChildren = () => {
      observer.disconnect();
      observer.observe(stage);
      for (const child of Array.from(overlay.children)) observer.observe(child);
      measure();
    };
    // Panels that mount later (errors, warnings) are picked up as they appear.
    const mutations = new MutationObserver(observeChildren);
    mutations.observe(overlay, { childList: true });
    observeChildren();
    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [scene, phone]);

  // Space toggles playback unless the focused control owns the key.
  const { toggle: togglePlayback } = playback;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!(event.key === " " || event.code === "Space")) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(SPACE_OWNERS) || target?.closest("[role='dialog']")) return;
      if (!hasRun) return;
      event.preventDefault();
      togglePlayback();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlayback, hasRun]);

  const resetView = useCallback(() => {
    if (view === "satellite") setFitSignal((value) => value + 1);
    else sceneRef.current?.resetView(false);
  }, [view]);
  const focusFire = useCallback(() => {
    if (view === "satellite") setFitSignal((value) => value + 1);
    else sceneRef.current?.resetView(true);
  }, [view]);

  const windTowardDegrees = (windFromDegrees + 180) % 360;
  const frame = frameAtOrBefore(frames, playback.t);
  let satelliteFrameIndex = 0;
  for (let index = 0; index < frames.length; index++) {
    if (frames[index].elapsedMinutes > playback.t) break;
    satelliteFrameIndex = index;
  }
  // Attribution covers the whole run, so the three mechanisms sum to the final burned area.
  const breakdownTotal = run
    ? run.arrivalBreakdown.surfaceSquareMeters +
      run.arrivalBreakdown.spottingSquareMeters +
      run.arrivalBreakdown.structureSquareMeters
    : 0;
  const crownTotal = run
    ? run.crownFireBreakdown.surfaceSquareMeters +
      run.crownFireBreakdown.passiveCrownSquareMeters +
      run.crownFireBreakdown.activeCrownSquareMeters
    : 0;
  const crownShareSquareMeters = run
    ? run.crownFireBreakdown.passiveCrownSquareMeters +
      run.crownFireBreakdown.activeCrownSquareMeters
    : 0;
  const spreadShares = run
    ? {
        surface: formatShareAndArea(run.arrivalBreakdown.surfaceSquareMeters, breakdownTotal),
        spotting: run.appliedOptions.spotting.enabled
          ? formatShareAndArea(run.arrivalBreakdown.spottingSquareMeters, breakdownTotal)
          : "Switched off",
        structure: run.appliedOptions.structureSpread.enabled
          ? formatShareAndArea(run.arrivalBreakdown.structureSquareMeters, breakdownTotal)
          : "Switched off",
      }
    : null;
  // A run that stops growing before the horizon is fuel-limited, not finished.
  const stalledAt = useMemo(() => {
    if (!frames.length) return null;
    const final = frames[frames.length - 1].burnedAreaSquareMeters;
    if (final <= 0) return null;
    const stalled = frames.find((candidate) => candidate.burnedAreaSquareMeters >= final);
    return stalled && stalled.elapsedMinutes < frames[frames.length - 1].elapsedMinutes
      ? stalled.elapsedMinutes
      : null;
  }, [frames]);

  const warnings: { key: string; text: string }[] = [];
  if (grid && !grid.elevationComplete) {
    warnings.push({
      key: "elevation",
      text: "A terrain tile was unavailable, so slope is understated in places.",
    });
  }
  if (grid && !grid.canopyComplete) {
    warnings.push({
      key: "canopy",
      text: "A canopy raster could not be loaded, so crown fire is not modelled.",
    });
  }
  if (run) {
    if (!run.crownFire.modelled && run.crownFire.unavailableReason) {
      warnings.push({
        key: "crown",
        text: `Crown fire was not modelled: ${run.crownFire.unavailableReason}`,
      });
    }
    if (run.ignition.spread.beyondValidatedWind) {
      warnings.push({
        key: "wind",
        text:
          "Effective wind is past the range Rothermel (1972) was validated against. Spread " +
          "rates here are extrapolation.",
      });
    }
    if (stalledAt !== null) {
      warnings.push({
        key: "stall",
        text:
          `The fire stops growing at ${formatDuration(stalledAt)}: it is fuel-limited, boxed in by ` +
          "non-burnable ground. " +
          (structureSpreadEnabled
            ? "Structure-to-structure spread is on, so this is where the model ran out of " +
              "built-up ground to carry fire, not where real risk ends."
            : "Structure-to-structure spread is switched off, so this understates risk at the " +
              "wildland-urban edge."),
      });
    }
    if (run.scenario.horizonMinutes >= LONG_HORIZON_MINUTES) {
      warnings.push({
        key: "constant-weather",
        text: "Wind and fuel moisture are held constant for the whole run; no day–night change is modelled.",
      });
    }
    if (run.reachedEdge) {
      warnings.push({
        key: "edge",
        text:
          "The fire reached the edge of the modelled area. Results past that point are " +
          "truncated; try a larger area size or a longer horizon for a wider grid.",
      });
    }
  }

  const sceneReady = sceneStatus.kind === "ready";
  const provenance = landscape.status === "ready" ? landscape.provenance : null;
  const storedUnavailable =
    landscape.status === "loading"
      ? landscape.storedUnavailable
      : provenance?.kind === "live" && provenance.storedUnavailable;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="fr-page"
      data-reduced-motion={reducedMotion ? "true" : undefined}
      aria-label="Fire spread model diorama"
    >
      <div className="fr-stage" ref={stageRef}>
        {view === "diorama" ? (
          <div
            className="fr-scene"
            ref={sceneHostRef}
            aria-hidden={sceneStatus.kind === "error"}
            role="group"
            aria-label={
              clickMode === "origin"
                ? "3D landscape. Click to place the ignition point."
                : "3D landscape. Click to aim the wind from the ignition point toward that location."
            }
          />
        ) : (
          <div className="fr-satellite">
            <SatelliteFireMap
              origin={origin}
              windFromDegrees={windFromDegrees}
              frames={frames as FireFrame[]}
              frameIndex={satelliteFrameIndex}
              landscape={grid}
              showFuel={showFuel}
              fitSignal={fitSignal}
              clickMode={clickMode}
              onMapClick={handleGroundClick}
            />
          </div>
        )}

        {view === "diorama" && sceneStatus.kind === "error" && (
          <div className="fr-error fr-panel" role="alert">
            <p className="fr-error-title">3D view unavailable in this browser</p>
            <p>
              The fire diorama needs WebGL, which appears to be disabled or unsupported here, so the
              landscape cannot be drawn. The scenario controls and the numeric results still work.
            </p>
            <p className="fr-error-detail">{sceneStatus.message}</p>
          </div>
        )}

        {landscape.status === "loading" && (
          <div className="fr-veil" role="status">
            <Spinner size="lg" />
            <div>
              <p>Sculpting terrain from LANDFIRE fuels and elevation…</p>
              <p className="fr-veil-note">
                {formatKm(radiusMeters)} km radius · {requestedCellMeters} m cells. Large areas take
                longer.
              </p>
              {storedUnavailable && (
                <p className="fr-veil-note">
                  Stored region unavailable — loading live from LANDFIRE; this takes longer.
                </p>
              )}
            </div>
          </div>
        )}

        {landscape.status === "error" && (
          <div className="fr-error fr-panel" role="alert">
            <p className="fr-error-title">The landscape could not be loaded</p>
            <p>{landscape.message}</p>
            <div className="fr-error-actions">
              <Button onClick={() => setLoadAttempt((value) => value + 1)}>Retry</Button>
              <Button variant="secondary" onClick={() => setAreaPickerOpen(true)}>
                Change area
              </Button>
            </div>
          </div>
        )}

        <div className="fr-overlay">
          <section
            className="fr-scenario fr-panel"
            id="fr-scenario"
            aria-labelledby="fire-controls-title"
            data-open={scenarioOpen}
          >
            <header className="fr-scenario-head">
              <div>
                <h1 id="fire-controls-title">Fire spread simulator</h1>
              </div>
              <IconButton
                label={scenarioOpen ? "Collapse scenario panel" : "Expand scenario panel"}
                aria-expanded={scenarioOpen}
                aria-controls="fr-scenario-body"
                onClick={() => setScenarioOpenChoice(!scenarioOpen)}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path
                    d={scenarioOpen ? "M2.5 4.5 6 8l3.5-3.5" : "M2.5 7.5 6 4l3.5 3.5"}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </IconButton>
            </header>

            <div className="fr-scenario-body" id="fr-scenario-body" hidden={!scenarioOpen}>
              <div className="fr-field">
                <div className="fr-region-row">
                  <label htmlFor="region">Region</label>
                  <select
                    id="region"
                    className="ui-input"
                    value={region ? region.id : ""}
                    onChange={(event) => {
                      const id = event.target.value;
                      if (id) selectRegion(id);
                    }}
                  >
                    {!region && <option value="">Custom: {areaLabel(areaCenter)}</option>}
                    {REGION_AREAS.map((area) => (
                      <optgroup key={area} label={area}>
                        {CALIFORNIA_REGIONS.filter((entry) => entry.area === area).map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                            {catalog.status === "ready" && !catalog.ids.has(entry.id)
                              ? " (not built)"
                              : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <Button
                    id="fr-change-area"
                    variant="secondary"
                    size="sm"
                    onClick={() => setAreaPickerOpen(true)}
                    aria-haspopup="dialog"
                  >
                    Custom…
                  </Button>
                </div>
                {!region && (
                  <div className="fr-field-inline fr-area-size">
                    <label htmlFor="area-size">Area size</label>
                    <select
                      id="area-size"
                      className="ui-input"
                      value={areaSize}
                      onChange={(event) => setAreaSize(event.target.value as AreaSizeId)}
                    >
                      {AREA_SIZES.map((size) => (
                        <option key={size.id} value={size.id}>
                          {size.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {storedUnavailable && (
                  <Notice className="fr-compact-notice">
                    Stored region unavailable — loading live from LANDFIRE instead.
                  </Notice>
                )}
              </div>

              <div className="fr-field">
                <span className="fr-field-title">Clicking the landscape sets</span>
                <SegmentedControl
                  className="fr-click-mode"
                  label="Clicking the landscape sets"
                  options={CLICK_MODE_OPTIONS.map((option) =>
                    option.value === "wind" && !origin ? { ...option, disabled: true } : option,
                  )}
                  value={clickMode}
                  onChange={setClickMode}
                />
                {!origin && (
                  <p className="fr-hint">
                    Place an ignition point before aiming the wind by click.
                  </p>
                )}
              </div>

              <WindSourcePicker
                lon={origin?.longitude ?? null}
                lat={origin?.latitude ?? null}
                horizonHours={horizonMinutes / 60}
                record={scenarioWind}
                onApply={applyScenarioWind}
              />

              <div className="fr-field">
                <label htmlFor="wind-speed">
                  Wind speed (20-foot) <strong>{windSpeedMph} mph</strong>
                </label>
                <input
                  id="wind-speed"
                  type="range"
                  min={0}
                  max={MAX_WIND_SPEED_MPH}
                  step={1}
                  value={windSpeedMph}
                  onChange={(event) => editWindSpeed(Number(event.target.value))}
                />
              </div>

              <div className="fr-field fr-field-inline">
                <label htmlFor="wind-direction">Wind from (°)</label>
                <input
                  id="wind-direction"
                  className="ui-input"
                  type="number"
                  min={0}
                  max={359}
                  step={5}
                  value={windFromDegrees}
                  onChange={(event) => editWindDirection(Number(event.target.value))}
                />
                <span className="fr-readout">
                  {compassPoint(windFromDegrees)} → toward {Math.round(windTowardDegrees)}°{" "}
                  {compassPoint(windTowardDegrees)}
                </span>
              </div>

              <div className="fr-field">
                <Button
                  variant="secondary"
                  size="sm"
                  block
                  onClick={lookUpNwsWind}
                  disabled={!origin || windSource.status === "loading"}
                >
                  Use current NWS wind
                </Button>
                {windSource.status === "loading" && (
                  <LoadingState>Reading the National Weather Service hourly forecast…</LoadingState>
                )}
                {windSource.status === "error" && (
                  <Notice tone="danger" className="fr-compact-notice">
                    {windSource.message}
                  </Notice>
                )}
                {windSource.status === "ready" && (
                  <p className="fr-status">
                    {nwsProvenance(windSource.reading, windSource.clampedFromMph)}
                  </p>
                )}
              </div>

              <div className="fr-field">
                <span className="fr-field-title">Fuel moisture</span>
                <div className="fr-preset-row">
                  {MOISTURE_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      variant="secondary"
                      size="sm"
                      aria-pressed={presetId === preset.id}
                      title={preset.description}
                      onClick={() => applyPreset(preset.id)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="fr-field">
                <span className="fr-field-title">Spread mechanisms</span>
                <div className="fr-toggle-row">
                  <input
                    id="spotting-enabled"
                    type="checkbox"
                    checked={spottingEnabled}
                    onChange={(event) => setSpottingEnabled(event.target.checked)}
                  />
                  <label htmlFor="spotting-enabled">Ember spotting</label>
                </div>
                <div className="fr-toggle-row">
                  <input
                    id="structure-spread-enabled"
                    type="checkbox"
                    checked={structureSpreadEnabled}
                    onChange={(event) => setStructureSpreadEnabled(event.target.checked)}
                  />
                  <label htmlFor="structure-spread-enabled">Structure-to-structure spread</label>
                </div>
              </div>

              <div className="fr-toggle-row">
                <input
                  id="show-fuel"
                  type="checkbox"
                  checked={showFuel}
                  onChange={(event) => setShowFuel(event.target.checked)}
                  disabled={!grid}
                />
                <label htmlFor="show-fuel">Show fuel layer</label>
              </div>

              <LiveShareToggle
                id="fire-live-share"
                className="fr-toggle-row live-share"
                enabled={liveBroadcast.enabled}
                onChange={liveBroadcast.setEnabled}
                status={liveBroadcast.status}
                idleText="Shares the fire with the resident app once you place an ignition."
              />

              <Button
                variant="secondary"
                size="sm"
                block
                onClick={clearScenario}
                disabled={!origin}
              >
                Clear scenario
              </Button>
            </div>
          </section>

          {!scenarioOpen && (
            <Button
              variant="secondary"
              className="fr-scenario-open"
              aria-expanded={false}
              aria-controls="fr-scenario"
              onClick={() => setScenarioOpenChoice(true)}
              icon={
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              }
            >
              Scenario
            </Button>
          )}

          <div className="fr-notice">
            <Panel glass className="fr-view" aria-label="Map view">
              <SegmentedControl
                label="View"
                options={VIEW_OPTIONS}
                value={view}
                onChange={chooseView}
              />
            </Panel>
          </div>

          {(run || result.error) && (
            <section
              className="fr-results fr-panel"
              aria-label="Fire results"
              data-open={detailsOpen}
            >
              {result.error && (
                <Notice tone="danger" className="fr-compact-notice">
                  {result.error}
                </Notice>
              )}
              {run && (
                <>
                  <div className="fr-results-tag">
                    <EvidenceTag kind="simulated" />
                    <span>Model output, not an observed fire</span>
                  </div>
                  <dl className="fr-metrics">
                    <div>
                      <dt>Burned area (simulated)</dt>
                      <dd>{frame ? formatArea(frame.burnedAreaSquareMeters) : "0 ha · 0 acres"}</dd>
                    </div>
                    <div>
                      <dt>Furthest reach</dt>
                      <dd>{frame ? formatDistance(frame.maxReachMeters) : "0.00 km · 0.00 mi"}</dd>
                    </div>
                    <div>
                      <dt>Elapsed</dt>
                      <dd>{formatDuration(playback.t)}</dd>
                    </div>
                    <div className="fr-metric-mix">
                      <dt>Whole-run mix</dt>
                      <dd>
                        Spotting{" "}
                        {run.appliedOptions.spotting.enabled
                          ? formatShare(run.arrivalBreakdown.spottingSquareMeters, breakdownTotal)
                          : "off"}{" "}
                        · Structures{" "}
                        {run.appliedOptions.structureSpread.enabled
                          ? formatShare(run.arrivalBreakdown.structureSquareMeters, breakdownTotal)
                          : "off"}{" "}
                        · Crown{" "}
                        {run.crownFire.modelled
                          ? formatShare(crownShareSquareMeters, crownTotal)
                          : "n/a"}
                      </dd>
                    </div>
                  </dl>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="fr-details-toggle"
                    aria-expanded={detailsOpen}
                    aria-controls="fr-details"
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    <span className="fr-details-label">
                      {detailsOpen ? "Hide details" : "Details"}
                    </span>
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path
                        d={detailsOpen ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </Button>
                  <div id="fr-details" className="fr-details" hidden={!detailsOpen}>
                    <div className="fr-card">
                      <div className="fr-mix-row">
                        <Facts
                          items={[
                            {
                              label: "Whole-run mix",
                              value: (
                                <>
                                  Spotting{" "}
                                  {run.appliedOptions.spotting.enabled
                                    ? formatShare(
                                        run.arrivalBreakdown.spottingSquareMeters,
                                        breakdownTotal,
                                      )
                                    : "off"}{" "}
                                  · Structures{" "}
                                  {run.appliedOptions.structureSpread.enabled
                                    ? formatShare(
                                        run.arrivalBreakdown.structureSquareMeters,
                                        breakdownTotal,
                                      )
                                    : "off"}{" "}
                                  · Crown{" "}
                                  {run.crownFire.modelled
                                    ? formatShare(crownShareSquareMeters, crownTotal)
                                    : "n/a"}
                                </>
                              ),
                            },
                          ]}
                        />
                      </div>
                      <Facts
                        items={[
                          {
                            label: "Fuel at ignition",
                            value: run.ignition.fuelLabel,
                          },
                          {
                            label: "Head rate of spread",
                            value: (
                              <>
                                {(run.ignition.spread.headRateFeetPerMinute * 0.3048).toFixed(1)}{" "}
                                m/min
                              </>
                            ),
                          },
                          {
                            label: "Flame length",
                            value: (
                              <>{(run.ignition.spread.flameLengthFeet * 0.3048).toFixed(1)} m</>
                            ),
                          },
                          {
                            label: "Slope · elevation",
                            value: (
                              <>
                                {run.ignition.slopePercent.toFixed(0)}% ·{" "}
                                {run.ignition.elevationMeters.toFixed(0)} m
                              </>
                            ),
                          },
                          {
                            label: "Burnable in modelled area",
                            value: <>{(run.burnableFraction * 100).toFixed(0)}%</>,
                          },
                          {
                            label: "Ignition point (WGS84)",
                            value: (
                              <>
                                {run.scenario.origin.latitude.toFixed(5)},{" "}
                                {run.scenario.origin.longitude.toFixed(5)}
                              </>
                            ),
                          },
                          {
                            label: "Grid · solve time",
                            value: (
                              <>
                                {run.cellSizeMeters.toFixed(0)} m ·{" "}
                                {run.computeMilliseconds.toFixed(0)} ms
                              </>
                            ),
                          },
                        ]}
                      />
                    </div>

                    <div className="fr-card">
                      <h2>Resolution</h2>
                      <p>
                        {run.resolution.cellMeters} m cells (
                        {run.resolution.groundCellSizeMeters.toFixed(0)} m on the ground), fuels{" "}
                        {run.resolution.resampling === "native"
                          ? "at LANDFIRE's native resolution"
                          : run.resolution.resampling === "mode"
                            ? "resampled by majority"
                            : "resampled by nearest cell"}
                        .
                        {run.resolution.cellMeters > NATIVE_CELL_METERS &&
                          " Coarse cells lose narrow firebreaks and roads, small urban patches and parks, and smooth slope, so spread across them can be over- or understated."}
                        {run.resolution.spottingReachCeilingMeters > 0 &&
                          ` Spotting is capped at ${(run.resolution.spottingReachCeilingMeters / 1000).toFixed(1)} km by the cell size and path-length limit.`}
                      </p>
                    </div>

                    <div className="fr-card">
                      <h2>How the fire spread (simulated)</h2>
                      <p>
                        Every burned cell is credited to whichever mechanism reached it first,
                        measured over the whole run to {formatDuration(run.scenario.horizonMinutes)}{" "}
                        rather than at the elapsed time shown.
                      </p>
                      {spreadShares && breakdownTotal > 0 ? (
                        <>
                          <Facts
                            items={[
                              {
                                label: "Surface spread through fuels (modelled)",
                                value: spreadShares.surface,
                              },
                              {
                                label: "Ember spotting (assumption)",
                                value: spreadShares.spotting,
                              },
                              {
                                label: "Structure-to-structure (assumption)",
                                value: spreadShares.structure,
                              },
                              {
                                label: "Developed ground in modelled area",
                                value: <>{(run.developedFraction * 100).toFixed(0)}%</>,
                              },
                            ]}
                          />
                          <p>
                            Only the surface line comes from the Rothermel physics. The spotting and
                            structure-to-structure lines are the assumptions you switched on: the
                            more of the burn they account for, the less of this run is a validated
                            fire model. Developed ground is read from the LANDFIRE fuel map, not
                            simulated.
                          </p>
                        </>
                      ) : (
                        <p>
                          Nothing burned, so there is no breakdown to show. Check the fuel at the
                          ignition point and the horizon.
                        </p>
                      )}
                    </div>

                    <div className="fr-card">
                      <h2>Kind of fire (simulated)</h2>
                      {run.crownFire.modelled ? (
                        <>
                          <Facts
                            items={[
                              {
                                label: "Surface fire",
                                value: formatShareAndArea(
                                  run.crownFireBreakdown.surfaceSquareMeters,
                                  crownTotal,
                                ),
                              },
                              {
                                label: "Passive crown (torching)",
                                value: formatShareAndArea(
                                  run.crownFireBreakdown.passiveCrownSquareMeters,
                                  crownTotal,
                                ),
                              },
                              {
                                label: "Active crown",
                                value: formatShareAndArea(
                                  run.crownFireBreakdown.activeCrownSquareMeters,
                                  crownTotal,
                                ),
                              },
                              {
                                label: "Length-to-breadth of active crown cells",
                                value: run.crownFire.activeCrownLengthToBreadth.toFixed(2),
                              },
                            ]}
                          />
                          <p>
                            Foliar moisture assumed at{" "}
                            {(run.crownFire.foliarMoistureFraction * 100).toFixed(0)}%. Crown
                            initiation is estimated per cell from LANDFIRE canopy rasters.
                          </p>
                        </>
                      ) : (
                        <p>
                          Crown fire was not modelled for this run, so it is a surface-fire-only
                          result. {run.crownFire.unavailableReason}
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {warnings.length > 0 && (
            <ul className="fr-warnings" aria-label="Run warnings">
              {warnings.map((warning) => (
                <li key={warning.key} role="status">
                  <Notice className="fr-compact-notice">{warning.text}</Notice>
                </li>
              ))}
            </ul>
          )}

          {outsideHint && (
            <p className="fr-hint-chip fr-panel" role="status">
              That spot is outside the loaded region. Click inside the shaded board.
            </p>
          )}

          <FireLegend
            view={view}
            windTowardDegrees={windTowardDegrees}
            showFuel={showFuel}
            defaultOpen={wide}
          />

          <FireDock
            playback={playback}
            horizonMinutes={horizonMinutes}
            hasRun={hasRun}
            canFocusFire={hasRun}
            sceneReady={sceneReady || view === "satellite"}
            onResetView={resetView}
            onFocusFire={focusFire}
          />
        </div>

        <p className="fr-attribution">
          Fuel: LANDFIRE · Terrain: AWS terrain tiles (USGS 3DEP and others)
          {view === "satellite" ? " · Imagery: USGS The National Map" : ""}
          {windSource.status === "ready" ? " · Wind: NWS forecast" : ""}
          {scenarioWind ? ` · Wind: ${scenarioWind.station?.name ?? "NWS gridpoint"} (${scenarioWind.evidenceClass})` : ""}
          {view === "diorama" && streetArea
            ? " · Roads: © OpenStreetMap contributors · Homes along streets: synthetic"
            : ""}
          {view === "diorama" && streets.status === "loading" ? " · Loading roads…" : ""}
        </p>

        {areaPickerOpen && (
          <AreaPicker
            current={region ? region.center : areaCenter}
            onSelect={changeArea}
            onClose={() => setAreaPickerOpen(false)}
          />
        )}
      </div>
    </main>
  );
}
