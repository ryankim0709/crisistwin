import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../diorama/ui/format";
import type { FireDioramaSceneApi, GroundClickMode } from "./diorama/types";
import { FireDioramaScene } from "./diorama/FireDioramaScene";
import AreaPicker, { AREA_PRESETS, DEFAULT_AREA } from "./ui/AreaPicker";
import {
  AREA_SIZES,
  DEFAULT_AREA_SIZE,
  effectiveRadiusMeters,
  type AreaSizeId,
} from "./ui/areaSize";
import FireDock from "./ui/FireDock";
import FireLegend from "./ui/FireLegend";
import { formatDuration } from "./ui/format";
import { useFirePlayback } from "./useFirePlayback";
import {
  LANDFIRE_ATTRIBUTION,
  TERRAIN_ATTRIBUTION,
  landscapeCellMetersFor,
  loadLandscape,
  type LandscapeGrid,
} from "./landscape";
import type { FuelMoisture } from "./rothermel";
import {
  DEFAULT_MIDFLAME_ADJUSTMENT,
  DEFAULT_SPOTTING,
  DEFAULT_STRUCTURE_SPREAD,
  FIRE_HORIZON_MINUTES,
  FIRE_STEP_MINUTES,
  HORIZON_CHOICES,
  METERS_PER_MILE,
  MOISTURE_PRESETS,
  NonBurnableIgnitionError,
  SQUARE_METERS_PER_ACRE,
  SQUARE_METERS_PER_HECTARE,
  STRUCTURE_SPREAD_REFERENCE_WIND_MPH,
  bearingBetween,
  cellAt,
  compassPoint,
  simulateFireSpread,
  type FireFrame,
  type FireRun,
  type GeoPoint,
} from "./spread";
import { NWS_ATTRIBUTION, fetchNwsWind, type NwsWindReading } from "./weather";
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

// Bounds for the two new mechanism parameters. Wide enough to explore, narrow enough that a
// stray keystroke cannot hand the model an absurd value.
const MAX_SPOTTING_DISTANCE_METERS = 2000;
const MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE = 20;
/**
 * Past the model's own default, a spot distance implies plume-dominated crown fire, which
 * this surface model does not represent. Still allowed, but labelled rather than silent.
 */
const SUPPORTED_SPOTTING_DISTANCE_METERS = DEFAULT_SPOTTING.maxDistanceMeters;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Which optional mechanisms are in play, spelled out so the disclaimer stays truthful. */
function mechanismsSentence(spotting: boolean, structures: boolean): string {
  if (spotting && structures) {
    return (
      "Ember spotting and structure-to-structure spread are switched on; both are simplified " +
      "add-ons, not validated models."
    );
  }
  if (spotting) {
    return (
      "Ember spotting is switched on as a simplified add-on, not a validated model; " +
      "structure-to-structure spread is off."
    );
  }
  if (structures) {
    return (
      "Structure-to-structure spread is switched on as a simplified add-on, not a validated " +
      "model; ember spotting is off."
    );
  }
  return "Ember spotting and structure-to-structure spread are both switched off.";
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
    `Observed — ${reading.locationLabel}, US National Weather Service hourly forecast for the ` +
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

// Short labels: the advanced grid gives each field about 90px.
const MOISTURE_FIELDS: { key: keyof FuelMoisture; label: string; title: string }[] = [
  { key: "dead1h", label: "1-h", title: "1-hour timelag dead fuel moisture" },
  { key: "dead10h", label: "10-h", title: "10-hour timelag dead fuel moisture" },
  { key: "dead100h", label: "100-h", title: "100-hour timelag dead fuel moisture" },
  { key: "liveHerb", label: "Herb", title: "Live herbaceous fuel moisture" },
  { key: "liveWoody", label: "Woody", title: "Live woody fuel moisture" },
];

type LandscapeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; grid: LandscapeGrid }
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
  return preset
    ? preset.label
    : `${center.latitude.toFixed(2)}, ${center.longitude.toFixed(2)}`;
}

export default function FireSimulatorPage() {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);

  const [areaCenter, setAreaCenter] = useState<GeoPoint>(DEFAULT_AREA.point);
  const [areaSize, setAreaSize] = useState<AreaSizeId>(DEFAULT_AREA_SIZE);
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [origin, setOrigin] = useState<GeoPoint | null>(null);
  const [windSpeedMph, setWindSpeedMph] = useState(DEFAULT_WIND_SPEED_MPH);
  const [windFromDegrees, setWindFromDegrees] = useState(45);
  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const [moisture, setMoisture] = useState<FuelMoisture>(DEFAULT_PRESET.moisture);
  const [midflameAdjustment, setMidflameAdjustment] = useState(DEFAULT_MIDFLAME_ADJUSTMENT);
  const [spottingEnabled, setSpottingEnabled] = useState(true);
  const [spottingDistanceMeters, setSpottingDistanceMeters] = useState(
    DEFAULT_SPOTTING.maxDistanceMeters,
  );
  const [structureSpreadEnabled, setStructureSpreadEnabled] = useState(true);
  const [structureSpreadRate, setStructureSpreadRate] = useState(
    DEFAULT_STRUCTURE_SPREAD.rateMetersPerMinute,
  );
  const [horizonMinutes, setHorizonMinutes] = useState<number>(FIRE_HORIZON_MINUTES);
  const [clickMode, setClickMode] = useState<GroundClickMode>("origin");
  const [showFuel, setShowFuel] = useState(false);
  const [landscape, setLandscape] = useState<LandscapeState>({ status: "idle" });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [windSource, setWindSource] = useState<WindSourceState>({ status: "idle" });

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
  const [noticeOpen, setNoticeOpen] = useState(false);

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

  const radiusMeters = effectiveRadiusMeters(horizonMinutes, areaSize);
  const requestedCellMeters = landscapeCellMetersFor(radiusMeters);

  // Fuel and terrain depend only on where and how far, so wind, moisture and ignition edits
  // never refetch. An older request can never overwrite a newer one.
  const resetScenarioRef = useRef<() => void>(() => undefined);
  const requestRef = useRef(0);
  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    setLandscape({ status: "loading" });
    loadLandscape(areaCenter.longitude, areaCenter.latitude, radiusMeters, controller.signal, {
      cellMeters: requestedCellMeters,
    })
      .then((grid) => {
        if (request !== requestRef.current) return;
        // A longer or shorter horizon changes the box; keep the ignition only if it is inside.
        const kept = originRef.current;
        if (kept && cellAt(grid, kept) < 0) resetScenarioRef.current();
        setLandscape({ status: "ready", grid });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setLandscape({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not load fuel and terrain data.",
        });
      });
    return () => controller.abort();
  }, [areaCenter, radiusMeters, requestedCellMeters, loadAttempt]);

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
    const host = sceneHostRef.current;
    if (!host) return;
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
  }, []);

  // Continuous model time, pushed to the scene every animation frame without a React render.
  const onTime = useCallback((minutes: number) => sceneRef.current?.setTime(minutes), []);
  const playback = useFirePlayback(horizonMinutes, onTime);
  const { getTime, pause, restart: restartPlayback, seek: seekPlayback } = playback;

  useEffect(() => {
    scene?.setLandscape(grid);
  }, [scene, grid]);
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
  }, []);

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
      // A reading belongs to one ignition point, so moving the point drops it.
      setOrigin(point);
      dropWindProvenance();
    },
    [clickMode, origin, editWindDirection, dropWindProvenance],
  );
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

  function editMoisture(key: keyof FuelMoisture, percent: number) {
    if (!Number.isFinite(percent)) return;
    setPresetId("custom");
    setMoisture((current) => ({ ...current, [key]: Math.min(Math.max(percent, 0), 400) / 100 }));
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
    setAreaCenter(center);
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
  const showHint = origin === null && landscape.status === "ready";
  useEffect(() => {
    const stage = stageRef.current;
    const overlay = stage?.querySelector<HTMLElement>(".fr-overlay");
    if (!stage || !overlay || !scene) return;
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
      scene.setViewInsets({ top, right: 0, bottom, left });
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

  const resetView = useCallback(() => sceneRef.current?.resetView(false), []);
  const focusFire = useCallback(() => sceneRef.current?.resetView(true), []);

  const windTowardDegrees = (windFromDegrees + 180) % 360;
  const frame = frameAtOrBefore(frames, playback.t);
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
    if (run.reachedEdge) {
      warnings.push({
        key: "edge",
        text:
          "The fire reached the edge of the modelled area. Results past that point are " +
          "truncated; try a larger area size or a longer horizon for a wider grid.",
      });
    }
  }

  const hintText = origin
    ? clickMode === "origin"
      ? "Click anywhere to move the ignition point."
      : "Click downwind of the ignition point to aim the wind that way."
    : "Click the landscape to place an ignition point on vegetated ground.";
  const sceneReady = sceneStatus.kind === "ready";
  // Report the resolution the loaded grid really has; the request is only a stand-in while loading.
  const displayedCellMeters = grid ? grid.groundCellSizeMeters : requestedCellMeters;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="fr-page"
      data-reduced-motion={reducedMotion ? "true" : undefined}
      aria-label="Fire spread model diorama"
    >
      <div className="fr-stage" ref={stageRef}>
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

        {sceneStatus.kind === "error" && (
          <div className="fr-error fr-panel" role="alert">
            <p className="fr-error-title">3D view unavailable in this browser</p>
            <p>
              The fire diorama needs WebGL, which appears to be disabled or unsupported here, so
              the landscape cannot be drawn. The scenario controls and the numeric results still
              work.
            </p>
            <p className="fr-error-detail">{sceneStatus.message}</p>
          </div>
        )}

        {landscape.status === "loading" && (
          <div className="fr-veil" role="status">
            <span className="fr-veil-dot" aria-hidden="true" />
            <div>
              <p>Sculpting terrain from LANDFIRE fuels and elevation…</p>
              <p className="fr-veil-note">
                {formatKm(radiusMeters)} km radius · {requestedCellMeters} m cells. Large areas
                take longer.
              </p>
            </div>
          </div>
        )}

        {landscape.status === "error" && (
          <div className="fr-error fr-panel" role="alert">
            <p className="fr-error-title">The landscape could not be loaded</p>
            <p>{landscape.message}</p>
            <div className="fr-error-actions">
              <button
                type="button"
                className="fr-btn fr-btn--primary"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                Retry
              </button>
              <button type="button" className="fr-btn" onClick={() => setAreaPickerOpen(true)}>
                Change area
              </button>
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
                <p className="fr-kicker">Simulated · illustrative, not operational</p>
              </div>
              <button
                type="button"
                className="fr-icon-btn"
                aria-expanded={scenarioOpen}
                aria-controls="fr-scenario-body"
                aria-label={scenarioOpen ? "Collapse scenario panel" : "Expand scenario panel"}
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
              </button>
            </header>

            <div className="fr-scenario-body" id="fr-scenario-body" hidden={!scenarioOpen}>
              <p className="fr-lede">
                Rothermel surface spread over real LANDFIRE fuels and terrain, stepped forward in{" "}
                {FIRE_STEP_MINUTES}-minute intervals, plus optional wildland-urban mechanisms you
                switch on as assumptions.
              </p>

              <div className="fr-field">
                <span className="fr-field-title">Area</span>
                <div className="fr-area-row">
                  <span className="fr-area-name">{areaLabel(areaCenter)}</span>
                  <button
                    type="button"
                    id="fr-change-area"
                    className="fr-btn fr-btn--small"
                    onClick={() => setAreaPickerOpen(true)}
                    aria-haspopup="dialog"
                  >
                    Change area
                  </button>
                </div>
                <div className="fr-field-inline fr-area-size">
                  <label htmlFor="area-size">Area size</label>
                  <select
                    id="area-size"
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
                <p className="fr-readout">
                  {areaCenter.latitude.toFixed(3)}, {areaCenter.longitude.toFixed(3)} ·{" "}
                  {formatKm(radiusMeters)} km radius · {displayedCellMeters} m cells
                </p>
                {displayedCellMeters > NATIVE_CELL_METERS && (
                  <p className="fr-hint">
                    Coarser cells smooth narrow fuel breaks and small neighbourhoods.
                  </p>
                )}
              </div>

              <fieldset className="fr-field">
                <legend>Clicking the landscape sets</legend>
                <div className="fr-segmented">
                  <label>
                    <input
                      type="radio"
                      name="click-mode"
                      checked={clickMode === "origin"}
                      onChange={() => setClickMode("origin")}
                    />
                    <span>Ignition point</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="click-mode"
                      checked={clickMode === "wind"}
                      disabled={!origin}
                      onChange={() => setClickMode("wind")}
                    />
                    <span>Wind direction</span>
                  </label>
                </div>
                <p className="fr-hint">{hintText}</p>
              </fieldset>

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
                <button
                  type="button"
                  className="fr-btn fr-btn--small fr-btn--block"
                  onClick={lookUpNwsWind}
                  disabled={!origin || windSource.status === "loading"}
                >
                  Use current NWS wind
                </button>
                {!origin && (
                  <p className="fr-hint">
                    Place an ignition point first: the forecast is looked up for that location.
                  </p>
                )}
                {windSource.status === "loading" && (
                  <div className="fr-loading" role="status">
                    <span className="fr-spinner" aria-hidden="true" />
                    Reading the National Weather Service hourly forecast…
                  </div>
                )}
                {windSource.status === "error" && (
                  <p className="fr-alert" role="alert">
                    {windSource.message}
                  </p>
                )}
                {windSource.status === "ready" ? (
                  <p className="fr-status">
                    {nwsProvenance(windSource.reading, windSource.clampedFromMph)}
                  </p>
                ) : (
                  <p className="fr-status">
                    Assumption — the wind above is a value you set, not an observation. Nothing
                    has been fetched for this scenario.
                  </p>
                )}
              </div>

              <div className="fr-field">
                <span className="fr-field-title">Fuel moisture</span>
                <div className="fr-preset-row">
                  {MOISTURE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={presetId === preset.id}
                      title={preset.description}
                      onClick={() => applyPreset(preset.id)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <details className="fr-advanced">
                  <summary>Advanced: moisture classes and spread parameters</summary>
                  <div className="fr-moisture-grid">
                    {MOISTURE_FIELDS.map(({ key, label, title }) => (
                      <div className="fr-moisture-field" key={key}>
                        <label htmlFor={`moisture-${key}`} title={title}>
                          {label} (%)
                        </label>
                        <input
                          id={`moisture-${key}`}
                          type="number"
                          min={0}
                          max={400}
                          step={1}
                          value={Math.round(moisture[key] * 100)}
                          onChange={(event) => editMoisture(key, Number(event.target.value))}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="fr-field fr-field-inline">
                    <label htmlFor="midflame">Midflame wind factor</label>
                    <input
                      id="midflame"
                      type="number"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={midflameAdjustment}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          setMidflameAdjustment(Math.min(Math.max(value, 0.1), 1));
                        }
                      }}
                    />
                    <span className="fr-readout">
                      Midflame wind {(windSpeedMph * midflameAdjustment).toFixed(1)} mph
                    </span>
                  </div>
                  <div className="fr-field fr-field-inline">
                    <label htmlFor="spotting-distance">Max spotting distance (m)</label>
                    <input
                      id="spotting-distance"
                      type="number"
                      min={0}
                      max={MAX_SPOTTING_DISTANCE_METERS}
                      step={50}
                      value={spottingDistanceMeters}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          setSpottingDistanceMeters(clamp(value, 0, MAX_SPOTTING_DISTANCE_METERS));
                        }
                      }}
                    />
                    <span className="fr-readout">
                      {!spottingEnabled
                        ? "Ember spotting is switched off, so this has no effect"
                        : spottingDistanceMeters > SUPPORTED_SPOTTING_DISTANCE_METERS
                          ? `${spottingDistanceMeters} m is past what surface-fire spotting supports`
                          : `Embers land up to ${spottingDistanceMeters} m downwind`}
                    </span>
                  </div>
                  <div className="fr-field fr-field-inline">
                    <label htmlFor="structure-spread-rate">
                      Structure spread rate at {STRUCTURE_SPREAD_REFERENCE_WIND_MPH} mph (m/min)
                    </label>
                    <input
                      id="structure-spread-rate"
                      type="number"
                      min={0}
                      max={MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE}
                      step={0.5}
                      value={structureSpreadRate}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          setStructureSpreadRate(
                            clamp(value, 0, MAX_STRUCTURE_SPREAD_METERS_PER_MINUTE),
                          );
                        }
                      }}
                    />
                    <span className="fr-readout">
                      {structureSpreadEnabled
                        ? "Assumed, not measured; the model scales it with wind speed"
                        : "Structure-to-structure spread is switched off, so this has no effect"}
                    </span>
                  </div>
                </details>
              </div>

              <div className="fr-field fr-field-inline">
                <label htmlFor="horizon">Horizon</label>
                <select
                  id="horizon"
                  value={horizonMinutes}
                  onChange={(event) => setHorizonMinutes(Number(event.target.value))}
                >
                  {HORIZON_CHOICES.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes / 60} h
                    </option>
                  ))}
                </select>
              </div>

              <div className="fr-field">
                <span className="fr-field-title">Extra spread mechanisms (your assumptions)</span>
                <div className="fr-toggle-row">
                  <input
                    id="spotting-enabled"
                    type="checkbox"
                    checked={spottingEnabled}
                    onChange={(event) => setSpottingEnabled(event.target.checked)}
                  />
                  <label htmlFor="spotting-enabled">Ember spotting</label>
                </div>
                <p className="fr-hint">
                  Burning embers are carried downwind and start new fires ahead of the front, so
                  the fire can cross a road, a river, or a firebreak instead of stopping at it.
                </p>
                <div className="fr-toggle-row">
                  <input
                    id="structure-spread-enabled"
                    type="checkbox"
                    checked={structureSpreadEnabled}
                    onChange={(event) => setStructureSpreadEnabled(event.target.checked)}
                  />
                  <label htmlFor="structure-spread-enabled">Structure-to-structure spread</label>
                </div>
                <p className="fr-hint">
                  Once fire reaches a built-up area, burning buildings ignite their neighbours, so
                  the fire keeps moving through streets and yards that carry no vegetation.
                </p>
              </div>

              {structureSpreadEnabled && (
                <p className="fr-warning" role="status">
                  Structure-to-structure spread is a coarse stand-in for urban conflagration, not
                  a validated structure-fire model. It ignores building materials, spacing,
                  defensible space, and suppression, and it will overstate losses in some
                  neighbourhoods and understate them in others. Treat any burned area it
                  contributes as an assumption you have switched on, not as a prediction of which
                  homes are lost.
                </p>
              )}

              <div className="fr-toggle-row">
                <input
                  id="show-fuel"
                  type="checkbox"
                  checked={showFuel}
                  onChange={(event) => setShowFuel(event.target.checked)}
                  disabled={!grid}
                />
                <label htmlFor="show-fuel">Show the fuel layer the model is using</label>
              </div>

              <button
                type="button"
                className="fr-btn fr-btn--small fr-btn--block"
                onClick={clearScenario}
                disabled={!origin}
              >
                Clear scenario
              </button>
            </div>
          </section>

          {!scenarioOpen && (
            <button
              type="button"
              className="fr-btn fr-scenario-open"
              aria-expanded={false}
              aria-controls="fr-scenario"
              onClick={() => setScenarioOpenChoice(true)}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              Scenario
            </button>
          )}

          <div className="fr-notice">
            <div className="fr-notice-bar fr-panel">
              <span className="fr-chip">Simulated · illustrative · not operational</span>
              <button
                type="button"
                className="fr-info-btn"
                aria-expanded={noticeOpen}
                aria-controls="fr-notice-note"
                aria-label="Sources and limits of this simulation"
                onClick={() => setNoticeOpen((open) => !open)}
              >
                i
              </button>
            </div>
            <div id="fr-notice-note" className="fr-notice-note fr-panel" hidden={!noticeOpen}>
              <div className="fr-sources">
                <p>Fuel: {LANDFIRE_ATTRIBUTION}</p>
                <p>Terrain: {TERRAIN_ATTRIBUTION}</p>
                <p>
                  Spread: Rothermel (1972) per Andrews RMRS-GTR-371; Scott &amp; Burgan (2005)
                  fuel models; minimum travel time after Finney (2002).
                </p>
                <p>Wind (only when fetched): {NWS_ATTRIBUTION}</p>
              </div>
              <div className="fr-disclaimer">
                <p>
                  Simulated result, not an observation. Rothermel surface fire with no
                  suppression;{" "}
                  {run
                    ? run.crownFire.modelled
                      ? "crown fire is estimated per cell from LANDFIRE canopy data."
                      : "crown fire was not modelled for this run (surface fire only)."
                    : "crown fire is estimated only where canopy data loads."}{" "}
                  {mechanismsSentence(spottingEnabled, structureSpreadEnabled)} Wind and fuel
                  moisture are uniform across the grid and constant in time. LANDFIRE fuel is a
                  mapped 2025 product, not today&rsquo;s vegetation.
                </p>
                <p>
                  The diorama is a stylized miniature of the loaded landscape: trees, houses and
                  vertical exaggeration are symbols for fuel classes and relief, not observed
                  detail.
                </p>
                <p>
                  The default moisture preset and wind speed on this page are demo settings chosen
                  to show peak fire weather, not values calibrated against a recorded fire.
                </p>
                <p>A planning experiment, not an operational evacuation instruction.</p>
              </div>
            </div>
          </div>

          {(run || result.error) && (
            <section className="fr-results fr-panel" aria-label="Fire results" data-open={detailsOpen}>
              {result.error && (
                <p className="fr-alert" role="alert">
                  {result.error}
                </p>
              )}
              {run && (
                <>
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
                  <button
                    type="button"
                    className="fr-details-toggle"
                    aria-expanded={detailsOpen}
                    aria-controls="fr-details"
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    {detailsOpen ? "Hide details" : "Details"}
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path
                        d={detailsOpen ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </button>
                  <div id="fr-details" className="fr-details" hidden={!detailsOpen}>
                    <div className="fr-card">
                      <div className="fr-card-row">
                        <span>Fuel at ignition</span>
                        <strong>{run.ignition.fuelLabel}</strong>
                      </div>
                      <div className="fr-card-row">
                        <span>Head rate of spread</span>
                        <strong>
                          {(run.ignition.spread.headRateFeetPerMinute * 0.3048).toFixed(1)} m/min
                        </strong>
                      </div>
                      <div className="fr-card-row">
                        <span>Flame length</span>
                        <strong>
                          {(run.ignition.spread.flameLengthFeet * 0.3048).toFixed(1)} m
                        </strong>
                      </div>
                      <div className="fr-card-row">
                        <span>Slope · elevation</span>
                        <strong>
                          {run.ignition.slopePercent.toFixed(0)}% ·{" "}
                          {run.ignition.elevationMeters.toFixed(0)} m
                        </strong>
                      </div>
                      <div className="fr-card-row">
                        <span>Burnable in modelled area</span>
                        <strong>{(run.burnableFraction * 100).toFixed(0)}%</strong>
                      </div>
                      <div className="fr-card-row">
                        <span>Ignition point (WGS84)</span>
                        <strong>
                          {run.scenario.origin.latitude.toFixed(5)},{" "}
                          {run.scenario.origin.longitude.toFixed(5)}
                        </strong>
                      </div>
                      <div className="fr-card-row">
                        <span>Grid · solve time</span>
                        <strong>
                          {run.cellSizeMeters.toFixed(0)} m · {run.computeMilliseconds.toFixed(0)}{" "}
                          ms
                        </strong>
                      </div>
                    </div>

                    <div className="fr-card">
                      <h2>How the fire spread (simulated)</h2>
                      <p>
                        Every burned cell is credited to whichever mechanism reached it first,
                        measured over the whole run to{" "}
                        {formatDuration(run.scenario.horizonMinutes)} rather than at the elapsed
                        time shown.
                      </p>
                      {spreadShares && breakdownTotal > 0 ? (
                        <>
                          <div className="fr-card-row">
                            <span>Surface spread through fuels (modelled)</span>
                            <strong>{spreadShares.surface}</strong>
                          </div>
                          <div className="fr-card-row">
                            <span>Ember spotting (assumption)</span>
                            <strong>{spreadShares.spotting}</strong>
                          </div>
                          <div className="fr-card-row">
                            <span>Structure-to-structure (assumption)</span>
                            <strong>{spreadShares.structure}</strong>
                          </div>
                          <div className="fr-card-row">
                            <span>Developed ground in modelled area</span>
                            <strong>{(run.developedFraction * 100).toFixed(0)}%</strong>
                          </div>
                          <p>
                            Only the surface line comes from the Rothermel physics. The spotting
                            and structure-to-structure lines are the assumptions you switched on:
                            the more of the burn they account for, the less of this run is a
                            validated fire model. Developed ground is read from the LANDFIRE fuel
                            map, not simulated.
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
                          <div className="fr-card-row">
                            <span>Surface fire</span>
                            <strong>
                              {formatShareAndArea(
                                run.crownFireBreakdown.surfaceSquareMeters,
                                crownTotal,
                              )}
                            </strong>
                          </div>
                          <div className="fr-card-row">
                            <span>Passive crown (torching)</span>
                            <strong>
                              {formatShareAndArea(
                                run.crownFireBreakdown.passiveCrownSquareMeters,
                                crownTotal,
                              )}
                            </strong>
                          </div>
                          <div className="fr-card-row">
                            <span>Active crown</span>
                            <strong>
                              {formatShareAndArea(
                                run.crownFireBreakdown.activeCrownSquareMeters,
                                crownTotal,
                              )}
                            </strong>
                          </div>
                          <div className="fr-card-row">
                            <span>Length-to-breadth of active crown cells</span>
                            <strong>{run.crownFire.activeCrownLengthToBreadth.toFixed(2)}</strong>
                          </div>
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
                <li className="fr-warning" key={warning.key} role="status">
                  {warning.text}
                </li>
              ))}
            </ul>
          )}

          {showHint && (
            <p className="fr-hint-chip fr-panel" role="status">
              Click the landscape to place an ignition point
            </p>
          )}

          <FireLegend windTowardDegrees={windTowardDegrees} showFuel={showFuel} defaultOpen={wide} />

          <FireDock
            playback={playback}
            horizonMinutes={horizonMinutes}
            hasRun={hasRun}
            canFocusFire={hasRun}
            sceneReady={sceneReady}
            onResetView={resetView}
            onFocusFire={focusFire}
          />
        </div>

        <p className="fr-attribution">
          Fuel: LANDFIRE · Terrain: AWS terrain tiles (USGS 3DEP and others)
          {windSource.status === "ready" ? " · Wind: NWS" : ""} · Simulated, not operational
        </p>

        {areaPickerOpen && (
          <AreaPicker
            current={areaCenter}
            onSelect={changeArea}
            onClose={() => setAreaPickerOpen(false)}
          />
        )}
      </div>
    </main>
  );
}
