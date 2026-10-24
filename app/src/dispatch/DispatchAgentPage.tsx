/**
 * Dispatch agent (/dispatch): the fire spread model's 3D diorama for any stored region or
 * custom US area, with an AI dispatcher that orders evacuations and sends fire engines while
 * the run plays. The road network, synthetic homes and fire stations are built from
 * OpenStreetMap for the box the fire threatens. See docs/adr/0014-dispatch-agent.md and
 * docs/adr/0016-dispatch-anywhere.md.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../diorama/ui/format";
import { FireDioramaScene } from "../fire/diorama/FireDioramaScene";
import type { FireDioramaSceneApi } from "../fire/diorama/types";
import { RegionUnavailableError, fetchRegionLandscape } from "../fire/landscapePackage";
import { landscapeCellMetersFor, loadLandscape, type LandscapeGrid } from "../fire/landscape";
import { CALIFORNIA_REGIONS, REGION_AREAS } from "../fire/regions";
import {
  DEFAULT_MIDFLAME_ADJUSTMENT,
  DEFAULT_SPOTTING,
  DEFAULT_STRUCTURE_SPREAD,
  FIRE_STEP_MINUTES,
  MOISTURE_PRESETS,
  cellAt,
  compassPoint,
  simulateFireSpread,
  type FireRun,
  type GeoPoint,
} from "../fire/spread";
import AreaPicker from "../fire/ui/AreaPicker";
import { DEFAULT_AREA } from "../fire/ui/areaPresets";
import FireDock from "../fire/ui/FireDock";
import { effectiveRadiusMeters } from "../fire/ui/areaSize";
import { useFirePlayback } from "../fire/useFirePlayback";
import { Button, IconButton, LoadingState, Notice, SegmentedControl, Spinner } from "../ui";
import DispatchConsole, { hhmm, type SetupStep } from "./DispatchConsole";
import { HOME_COLORS, cssColor } from "./scene/DispatchOverlay";
import { DispatchOverlay } from "./scene/DispatchOverlay";
import {
  AreaRequestError,
  dispatchBoxFor,
  groundMeters,
  loadArea,
  type Bbox,
  type DispatchArea,
} from "./area";
import { noActionBaseline } from "./engine";
import { computeExposure } from "./fireExposure";
import { useDispatchSession } from "./useDispatchSession";
import "../fire/fire.css";
import "./dispatch.css";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const HORIZON_CHOICES = [120, 180, 240] as const;
const DEFAULT_HORIZON_MINUTES = 180;
const MAX_WIND_SPEED_MPH = 60;
const CUSTOM = "custom";
/** Wait this long after the last fire edit before asking for the road network. */
const AREA_DEBOUNCE_MS = 500;
/** Road boxes are snapped to this grid (degrees), like the backend cache, so small edits reuse one. */
const AREA_SNAP_DEGREES = 0.01;
/** A board click within this distance of a home selects its zone during a run. */
const PICK_HOME_METERS = 250;
const ZONE_FOCUS_METERS = 900;
const COMPASS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/** A ready-made demo: Berkeley Hills under a NE (Diablo) wind toward the hill neighbourhoods. */
const DEMO = {
  regionId: "berkeley-hills-tilden",
  ignition: { latitude: 37.885, longitude: -122.235 },
  windFromDegrees: 45,
  windSpeedMph: 25,
};
const DEFAULT_REGION = DEMO.regionId;

type LandscapeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; grid: LandscapeGrid }
  | { status: "error"; message: string };

type AreaState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; area: DispatchArea }
  | { status: "error"; key: string; message: string };

function snapBox([w, s, e, n]: Bbox): Bbox {
  const snap = (value: number, round: (v: number) => number) =>
    Number((round(value / AREA_SNAP_DEGREES) * AREA_SNAP_DEGREES).toFixed(2));
  return [snap(w, Math.floor), snap(s, Math.floor), snap(e, Math.ceil), snap(n, Math.ceil)];
}

export default function DispatchAgentPage() {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [selection, setSelection] = useState<string>(DEFAULT_REGION);
  const [areaCenter, setAreaCenter] = useState<GeoPoint>(DEFAULT_AREA.point);
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [landscape, setLandscape] = useState<LandscapeState>({ status: "idle" });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [origin, setOrigin] = useState<GeoPoint | null>(null);
  const [windSpeedMph, setWindSpeedMph] = useState(DEMO.windSpeedMph);
  const [windFromDegrees, setWindFromDegrees] = useState(DEMO.windFromDegrees);
  const [presetId, setPresetId] = useState(MOISTURE_PRESETS[0].id);
  const [horizonMinutes, setHorizonMinutes] = useState<number>(DEFAULT_HORIZON_MINUTES);
  const [scenarioOpen, setScenarioOpen] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [areaState, setAreaState] = useState<AreaState>({ status: "idle" });
  const [areaAttempt, setAreaAttempt] = useState(0);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);

  const sceneHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FireDioramaSceneApi | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlay = useMemo(() => new DispatchOverlay(), []);
  const pendingIgnitionRef = useRef<GeoPoint | null>(null);

  const region = CALIFORNIA_REGIONS.find((candidate) => candidate.id === selection) ?? null;
  const radiusMeters = region
    ? region.radiusMeters
    : effectiveRadiusMeters(horizonMinutes, "local");
  const cellMeters = region ? region.cellMeters : landscapeCellMetersFor(radiusMeters);
  const centerLatitude = region ? region.center.latitude : areaCenter.latitude;
  const centerLongitude = region ? region.center.longitude : areaCenter.longitude;

  // ---- Landscape (fuel + terrain): stored region package, else live LANDFIRE -------------
  const requestRef = useRef(0);
  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    const stale = () => controller.signal.aborted || request !== requestRef.current;
    setLandscape({ status: "loading" });
    const live = () =>
      loadLandscape(centerLongitude, centerLatitude, radiusMeters, controller.signal, {
        cellMeters,
      }).then((grid) => {
        if (!stale()) setLandscape({ status: "ready", grid });
      });
    const work = region
      ? fetchRegionLandscape(region.id, controller.signal).then(
          ({ grid }) => {
            if (!stale()) setLandscape({ status: "ready", grid });
          },
          (cause: unknown) => {
            if (stale()) return;
            if (!(cause instanceof RegionUnavailableError) && !(cause instanceof TypeError))
              throw cause;
            return live();
          },
        )
      : live();
    work.catch((cause: unknown) => {
      if (stale()) return;
      setLandscape({
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not load fuel and terrain data.",
      });
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, centerLatitude, centerLongitude, radiusMeters, cellMeters, loadAttempt]);
  const grid = landscape.status === "ready" ? landscape.grid : null;

  // A demo ignition chosen before its region finished loading is placed once the grid is in.
  useEffect(() => {
    const pending = pendingIgnitionRef.current;
    if (!grid || !pending) return;
    pendingIgnitionRef.current = null;
    if (cellAt(grid, pending) >= 0) setOrigin(pending);
  }, [grid]);

  // ---- Fire run (Rothermel, same solver and options as /fire) ---------------------------
  const moisture = (
    MOISTURE_PRESETS.find((preset) => preset.id === presetId) ?? MOISTURE_PRESETS[0]
  ).moisture;
  const scenario = useMemo(
    () =>
      origin
        ? {
            origin,
            windSpeedMph,
            windFromDegrees,
            moisture,
            midflameAdjustment: DEFAULT_MIDFLAME_ADJUSTMENT,
            stepMinutes: FIRE_STEP_MINUTES,
            horizonMinutes,
            spotting: { enabled: true, maxDistanceMeters: DEFAULT_SPOTTING.maxDistanceMeters },
            structureSpread: {
              enabled: true,
              rateMetersPerMinute: DEFAULT_STRUCTURE_SPREAD.rateMetersPerMinute,
            },
          }
        : null,
    [origin, windSpeedMph, windFromDegrees, moisture, horizonMinutes],
  );
  const deferredScenario = useDeferredValue(scenario);
  const fire = useMemo<{ run: FireRun | null; error: string | null }>(() => {
    if (!grid || !deferredScenario || cellAt(grid, deferredScenario.origin) < 0)
      return { run: null, error: null };
    try {
      return { run: simulateFireSpread(grid, deferredScenario), error: null };
    } catch (cause) {
      return {
        run: null,
        error: cause instanceof Error ? cause.message : "This fire could not be simulated.",
      };
    }
  }, [grid, deferredScenario]);
  // Clearing the fire must not leave the previous run on screen while the deferred value catches up.
  const run = scenario ? fire.run : null;

  // ---- Road network, homes and stations for the box the fire threatens -------------------
  const box = useMemo(
    () => (grid && run ? dispatchBoxFor(grid, run.arrivalMinutes, horizonMinutes) : null),
    [grid, run, horizonMinutes],
  );
  const snapped = useMemo(() => (box ? snapBox(box) : null), [box]);
  const boxKey = snapped ? snapped.join(",") : null;
  useEffect(() => {
    if (!boxKey || !snapped) {
      setAreaState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setAreaState((current) =>
      current.status === "ready" && current.key === boxKey
        ? current
        : { status: "loading", key: boxKey },
    );
    const timer = window.setTimeout(() => {
      loadArea(snapped, controller.signal)
        .then((area) => {
          if (!controller.signal.aborted) setAreaState({ status: "ready", key: boxKey, area });
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            cause instanceof AreaRequestError || cause instanceof Error
              ? cause.message
              : "Could not load the road network.";
          setAreaState({ status: "error", key: boxKey, message });
        });
    }, AREA_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, areaAttempt]);
  const area = areaState.status === "ready" && areaState.key === boxKey ? areaState.area : null;

  const exposure = useMemo(
    () => (area && grid && run ? computeExposure(area, grid, run.arrivalMinutes) : null),
    [area, grid, run],
  );
  const baseline = useMemo(
    () => (area && exposure ? noActionBaseline(area, exposure, horizonMinutes) : null),
    [area, exposure, horizonMinutes],
  );

  // ---- Clocks: fire preview before a run, the session clock during one -------------------
  const pushTime = useCallback(
    (minutes: number) => {
      sceneRef.current?.setTime(minutes);
      overlay.setPreviewMinute(minutes);
    },
    [overlay],
  );
  const playback = useFirePlayback(horizonMinutes, pushTime);
  const session = useDispatchSession(pushTime);
  const sessionActive = session.status !== "idle" && session.engine !== null;
  const { stop: stopSession } = session;

  // Any change to the fire, its area or its roads ends a dispatcher run.
  useEffect(() => {
    stopSession();
    setSelectedZone(null);
  }, [run, area, stopSession]);

  // ---- Scene ------------------------------------------------------------------------------
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    const host = sceneHostRef.current;
    if (!host) return;
    let created: FireDioramaSceneApi;
    try {
      created = new FireDioramaScene(host, { reducedMotion: reducedMotionRef.current });
    } catch (error) {
      setSceneError(error instanceof Error ? error.message : "WebGL could not be initialised.");
      return;
    }
    sceneRef.current = created;
    setScene(created);
    return () => {
      sceneRef.current = null;
      setScene(null);
      created.dispose();
    };
  }, []);
  useEffect(() => {
    scene?.setLandscape(grid);
  }, [scene, grid]);
  useEffect(() => {
    scene?.setRun(run);
    scene?.setTime(sessionActive ? session.getClock() : playback.getTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, run]);
  useEffect(() => {
    scene?.setIgnition(origin);
  }, [scene, origin]);
  useEffect(() => {
    scene?.setWind(windFromDegrees, windSpeedMph);
  }, [scene, windFromDegrees, windSpeedMph]);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    scene?.setReducedMotion(reducedMotion);
  }, [scene, reducedMotion]);
  useEffect(() => {
    scene?.setOverlay(overlay);
    return () => scene?.setOverlay(null);
  }, [scene, overlay]);
  // Modelled homes replace the stylized fuel-class houses once the area is loaded.
  useEffect(() => {
    scene?.setCoverHouses(!area);
  }, [scene, area]);
  useEffect(() => {
    overlay.setArea(area, exposure);
  }, [overlay, area, exposure]);
  useEffect(() => {
    overlay.setEngine(sessionActive ? session.engine : null);
  }, [overlay, sessionActive, session.engine, session.version]);
  useEffect(() => {
    overlay.setSelectedZone(selectedZone);
  }, [overlay, selectedZone]);

  // Restart the preview whenever a new fire is solved, so the user sees it spread.
  const { restart: restartPreview, pause: pausePreview } = playback;
  const runKey = run ? `${run.scenario.origin.latitude},${run.scenario.origin.longitude}` : null;
  const lastRunKey = useRef<string | null>(null);
  useEffect(() => {
    if (!runKey || runKey === lastRunKey.current) return;
    lastRunKey.current = runKey;
    restartPreview();
    sceneRef.current?.resetView(true);
  }, [runKey, restartPreview]);

  // The scene frames the board inside the space the floating panels leave.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !scene) return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      const panel = stage.querySelector<HTMLElement>(".dsp-scenario");
      const dock = stage.querySelector<HTMLElement>(".dsp-dock");
      const left = panel && panel.offsetParent ? panel.getBoundingClientRect().right - box.left : 0;
      const bottom = dock ? box.bottom - dock.getBoundingClientRect().top : 0;
      scene.setViewInsets({
        top: 0,
        right: 0,
        bottom: Math.max(0, bottom),
        left: Math.max(0, left),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    stage.querySelectorAll(".dsp-scenario, .dsp-dock").forEach((el) => observer.observe(el));
    measure();
    return () => observer.disconnect();
  }, [scene, scenarioOpen, sessionActive]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // ---- Interaction ------------------------------------------------------------------------
  const selectZone = useCallback(
    (zone: number | null) => {
      setSelectedZone(zone);
      if (zone !== null && area) {
        const [longitude, latitude] = area.zones[zone].centroid;
        sceneRef.current?.focusOn({ latitude, longitude }, ZONE_FOCUS_METERS);
      }
    },
    [area],
  );

  const handleGroundClick = useCallback(
    (point: GeoPoint) => {
      if (sessionActive && area) {
        // During a run a click picks the zone of the nearest home.
        let best = -1;
        let bestMeters = PICK_HOME_METERS;
        const here: [number, number] = [point.longitude, point.latitude];
        area.homes.forEach((home, i) => {
          const d = groundMeters(here, home.position);
          if (d < bestMeters) {
            bestMeters = d;
            best = i;
          }
        });
        selectZone(best >= 0 ? area.homes[best].zone : null);
        return;
      }
      if (grid && cellAt(grid, point) < 0) {
        setNotice("That spot is outside the loaded landscape.");
        return;
      }
      setOrigin(point);
    },
    [sessionActive, area, grid, selectZone],
  );
  const clickRef = useRef(handleGroundClick);
  useEffect(() => {
    clickRef.current = handleGroundClick;
  }, [handleGroundClick]);
  useEffect(() => {
    scene?.onGroundClick((point) => clickRef.current(point));
  }, [scene]);

  function chooseRegion(id: string) {
    if (id === selection) return;
    setOrigin(null);
    setSelection(id);
  }

  function loadDemo() {
    setWindFromDegrees(DEMO.windFromDegrees);
    setWindSpeedMph(DEMO.windSpeedMph);
    setPresetId(MOISTURE_PRESETS[0].id);
    if (selection === DEMO.regionId && grid) setOrigin(DEMO.ignition);
    else {
      setOrigin(null);
      pendingIgnitionRef.current = DEMO.ignition;
      setSelection(DEMO.regionId);
    }
  }

  const handleStart = useCallback(() => {
    if (!area || !exposure || !run) return;
    pausePreview();
    setScenarioOpen(false);
    setSelectedZone(null);
    session.start({
      area,
      exposure,
      frames: run.frames,
      baselineHomesExposed: baseline?.caught ?? null,
      horizonMinutes,
      ignitions: [{ minute: 0, name: "the fire" }],
      windFromDegrees,
      windSpeedMph,
    });
  }, [
    area,
    exposure,
    run,
    baseline,
    horizonMinutes,
    windFromDegrees,
    windSpeedMph,
    session,
    pausePreview,
  ]);

  // ---- Setup checklist --------------------------------------------------------------------
  const areaLabel = region
    ? region.name
    : `Custom area (${areaCenter.latitude.toFixed(2)}, ${areaCenter.longitude.toFixed(2)})`;
  const steps: SetupStep[] = [
    {
      label: "Landscape",
      detail:
        landscape.status === "ready"
          ? `${areaLabel} · LANDFIRE fuels and terrain`
          : landscape.status === "error"
            ? landscape.message
            : "Loading fuels and terrain…",
      state:
        landscape.status === "ready" ? "done" : landscape.status === "error" ? "error" : "active",
    },
    {
      label: "Start a fire",
      detail: run
        ? `Simulated ${horizonMinutes / 60} h of spread, wind ${windSpeedMph} mph from ${compassPoint(windFromDegrees)}`
        : (fire.error ?? "Click the landscape where the fire starts, or use the demo fire."),
      state: run ? "done" : fire.error ? "error" : grid ? "active" : "waiting",
    },
    {
      label: "Roads, homes and stations",
      detail: area
        ? `${area.name}: ${area.homes.length.toLocaleString()} homes in ${area.zones.length} zones, ${area.exits.length} exits, ${area.stations.length} fire stations`
        : areaState.status === "error"
          ? areaState.message
          : run
            ? "Building the evacuation network from OpenStreetMap…"
            : "Built from OpenStreetMap around the fire.",
      state: area ? "done" : areaState.status === "error" ? "error" : run ? "active" : "waiting",
    },
  ];
  const startBlocker = !run
    ? "Place a fire first."
    : !area
      ? areaState.status === "error"
        ? "The road network could not be loaded."
        : "Waiting for the road network…"
      : area.zones.length === 0
        ? "No residential streets lie near this fire, so there is nobody to evacuate. Try a fire closer to homes."
        : null;

  const windToward = (windFromDegrees + 180) % 360;
  const editable = !sessionActive;

  return (
    <main
      className="fr-page dsp-page"
      id="main-content"
      aria-label="Dispatch agent"
      data-reduced-motion={reducedMotion ? "true" : undefined}
    >
      <div className="dsp-layout">
        <div className="fr-stage dsp-stage" ref={stageRef}>
          <div
            className="fr-scene"
            ref={sceneHostRef}
            role="group"
            aria-label={
              sessionActive
                ? "3D landscape. Click a home to select its zone."
                : "3D landscape. Click to start the fire."
            }
          />
          {sceneError && (
            <div className="fr-error fr-panel dsp-center" role="alert">
              <p className="fr-error-title">3D view unavailable in this browser</p>
              <p>{sceneError}</p>
            </div>
          )}
          {landscape.status === "loading" && (
            <div className="fr-veil" role="status">
              <Spinner size="lg" />
              <div>
                <p>Sculpting terrain from LANDFIRE fuels and elevation…</p>
              </div>
            </div>
          )}
          {landscape.status === "error" && (
            <div className="fr-error fr-panel dsp-center" role="alert">
              <p className="fr-error-title">The landscape could not be loaded</p>
              <p>{landscape.message}</p>
              <div className="fr-error-actions">
                <Button onClick={() => setLoadAttempt((v) => v + 1)}>Retry</Button>
                <Button variant="secondary" onClick={() => setAreaPickerOpen(true)}>
                  Change area
                </Button>
              </div>
            </div>
          )}

          <div className="dsp-overlay">
            {scenarioOpen ? (
              <section className="dsp-scenario fr-panel" aria-labelledby="dsp-scenario-title">
                <header className="fr-scenario-head">
                  <div>
                    <h1 id="dsp-scenario-title">Fire scenario</h1>
                    <p className="dsp-muted dsp-small">
                      {editable
                        ? "Pick a place, start a fire, then hand it to the dispatcher."
                        : "Locked while the dispatcher runs. Stop it to edit."}
                    </p>
                  </div>
                  <IconButton label="Hide scenario panel" onClick={() => setScenarioOpen(false)}>
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path
                        d="M7.5 2.5 4 6l3.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </IconButton>
                </header>
                <fieldset className="dsp-scenario-body" disabled={!editable}>
                  <Button block onClick={loadDemo}>
                    ▶ Load demo fire (Berkeley Hills)
                  </Button>
                  <div className="fr-field">
                    <label htmlFor="dsp-region">Where</label>
                    <div className="dsp-row">
                      <select
                        id="dsp-region"
                        className="ui-input"
                        value={region ? region.id : ""}
                        onChange={(event) => event.target.value && chooseRegion(event.target.value)}
                      >
                        {!region && (
                          <option value="">
                            Custom: {areaCenter.latitude.toFixed(2)},{" "}
                            {areaCenter.longitude.toFixed(2)}
                          </option>
                        )}
                        {REGION_AREAS.map((group) => (
                          <optgroup key={group} label={group}>
                            {CALIFORNIA_REGIONS.filter((entry) => entry.area === group).map(
                              (entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {entry.name}
                                </option>
                              ),
                            )}
                          </optgroup>
                        ))}
                      </select>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setAreaPickerOpen(true)}
                        aria-haspopup="dialog"
                      >
                        Anywhere…
                      </Button>
                    </div>
                  </div>
                  <p className="dsp-hint">
                    {origin
                      ? `🔥 Fire at ${origin.latitude.toFixed(4)}, ${origin.longitude.toFixed(4)}. Click the landscape to move it.`
                      : "👆 Click the landscape to start the fire."}
                  </p>
                  <div className="fr-field">
                    <label htmlFor="dsp-wind">
                      Wind speed <strong>{windSpeedMph} mph</strong>
                    </label>
                    <input
                      id="dsp-wind"
                      type="range"
                      min={0}
                      max={MAX_WIND_SPEED_MPH}
                      value={windSpeedMph}
                      onChange={(event) => setWindSpeedMph(Number(event.target.value))}
                    />
                  </div>
                  <div className="fr-field">
                    <span className="fr-field-title">
                      Wind from{" "}
                      <span className="dsp-muted">→ toward {compassPoint(windToward)}</span>
                    </span>
                    <SegmentedControl
                      className="dsp-compass"
                      label="Wind from"
                      options={COMPASS.map((deg) => ({
                        value: String(deg),
                        label: compassPoint(deg),
                      }))}
                      value={String(windFromDegrees)}
                      onChange={(value) => setWindFromDegrees(Number(value))}
                    />
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
                          onClick={() => setPresetId(preset.id)}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="fr-field fr-field-inline">
                    <label htmlFor="dsp-horizon">Run length</label>
                    <select
                      id="dsp-horizon"
                      className="ui-input"
                      value={horizonMinutes}
                      onChange={(event) => setHorizonMinutes(Number(event.target.value))}
                    >
                      {HORIZON_CHOICES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes / 60} hours
                        </option>
                      ))}
                    </select>
                  </div>
                  {areaState.status === "error" && (
                    <Notice tone="danger" className="fr-compact-notice">
                      {areaState.message}{" "}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setAreaAttempt((v) => v + 1)}
                      >
                        Retry
                      </Button>
                    </Notice>
                  )}
                </fieldset>
              </section>
            ) : (
              <Button
                variant="secondary"
                className="dsp-scenario-open"
                onClick={() => setScenarioOpen(true)}
              >
                ☰ Scenario
              </Button>
            )}

            <div className="dsp-top">
              {sessionActive && session.status === "thinking" && (
                <div className="fr-hint-chip fr-panel">
                  <LoadingState>Clock held: the dispatcher is deciding…</LoadingState>
                </div>
              )}
              {!sessionActive && areaState.status === "loading" && run && (
                <div className="fr-hint-chip fr-panel">
                  <LoadingState>Building roads and homes from OpenStreetMap…</LoadingState>
                </div>
              )}
              {notice && (
                <Notice tone="info" className="fr-compact-notice">
                  {notice}
                </Notice>
              )}
            </div>

            <aside
              className={`dsp-legend fr-panel${legendOpen ? "" : " is-closed"}`}
              aria-label="Legend"
            >
              <Button
                variant="ghost"
                size="sm"
                className="dsp-legend__toggle"
                aria-expanded={legendOpen}
                onClick={() => setLegendOpen((v) => !v)}
              >
                Legend {legendOpen ? "▾" : "▸"}
              </Button>
              {legendOpen && (
                <ul>
                  {(
                    [
                      [HOME_COLORS[0], "Home, no order yet"],
                      [HOME_COLORS[1], "Ordered, getting ready"],
                      [HOME_COLORS[2], "Queued to leave"],
                      [HOME_COLORS[3], "Driving out"],
                      [HOME_COLORS[4], "Safe ✓"],
                      [HOME_COLORS[5], "Caught by fire"],
                    ] as [number, string][]
                  ).map(([color, text]) => (
                    <li key={text}>
                      <span
                        className="dsp-roof"
                        style={{ background: cssColor(color) }}
                        aria-hidden="true"
                      />
                      {text}
                    </li>
                  ))}
                  <li>
                    <span className="dsp-key dsp-key--route" aria-hidden="true" />
                    Evacuation route (colour = exit)
                  </li>
                  <li>
                    <span className="dsp-key dsp-key--engine" aria-hidden="true" />
                    Fire engine &amp; its path
                  </li>
                  <li>
                    <span className="dsp-key dsp-key--exit" aria-hidden="true" />⇥ Exit in use
                  </li>
                  <li>
                    <span className="dsp-key dsp-key--station" aria-hidden="true" />
                    Fire station
                  </li>
                </ul>
              )}
            </aside>

            <div className="dsp-dock">
              {sessionActive && session.engine ? (
                <section className="fr-panel dsp-session-dock" aria-label="Dispatcher clock">
                  <strong className="dsp-clock">{hhmm(session.engine.minute)}</strong>
                  <span className="dsp-muted">/ {hhmm(horizonMinutes)}</span>
                  <div className="dsp-track" aria-hidden="true">
                    <span
                      className="dsp-track__fill"
                      style={{ width: `${(session.engine.minute / horizonMinutes) * 100}%` }}
                    />
                    {session.log.map((entry) => (
                      <span
                        key={entry.id}
                        className="dsp-track__tick"
                        style={{ left: `${(entry.minute / horizonMinutes) * 100}%` }}
                        title={`Decision at ${hhmm(entry.minute)}`}
                      />
                    ))}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => sceneRef.current?.resetView(true)}
                  >
                    Focus fire
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => sceneRef.current?.resetView(false)}
                  >
                    Whole board
                  </Button>
                </section>
              ) : (
                <FireDock
                  playback={playback}
                  horizonMinutes={horizonMinutes}
                  hasRun={run !== null}
                  canFocusFire={run !== null}
                  sceneReady={scene !== null}
                  onResetView={() => sceneRef.current?.resetView(false)}
                  onFocusFire={() => sceneRef.current?.resetView(true)}
                />
              )}
            </div>
          </div>

          <p className="fr-attribution">
            Fuel: LANDFIRE · Terrain: AWS terrain tiles · Roads, stations: © OpenStreetMap
            contributors (ODbL) · Homes &amp; zones: synthetic
          </p>
          {areaPickerOpen && (
            <AreaPicker
              current={region ? region.center : areaCenter}
              onSelect={(center) => {
                setAreaPickerOpen(false);
                setOrigin(null);
                setSelection(CUSTOM);
                setAreaCenter(center);
              }}
              onClose={() => setAreaPickerOpen(false)}
            />
          )}
        </div>

        <DispatchConsole
          area={area}
          steps={steps}
          startBlocker={startBlocker}
          status={session.status}
          engine={sessionActive ? session.engine : null}
          version={session.version}
          log={session.log}
          baseline={baseline}
          speed={session.speed}
          selectedZone={selectedZone}
          onStart={handleStart}
          onPause={session.pause}
          onResume={session.resume}
          onStop={session.stop}
          onRetry={session.retry}
          onSkip={session.skip}
          onSpeedChange={session.setSpeed}
          onSelectZone={selectZone}
        />
      </div>
    </main>
  );
}
