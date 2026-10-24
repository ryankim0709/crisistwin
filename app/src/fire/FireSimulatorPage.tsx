import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import FireMap, { ARRIVAL_COLORS, FUEL_COLORS, type ClickMode } from "./FireMap";
import {
  LANDFIRE_ATTRIBUTION,
  TERRAIN_ATTRIBUTION,
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
  compassPoint,
  formatElapsed,
  simulateFireSpread,
  type FireRun,
  type GeoPoint,
} from "./spread";
import { NWS_ATTRIBUTION, fetchNwsWind, type NwsWindReading } from "./weather";
import "./fire.css";

const PLAYBACK_INTERVAL_MS = 850;
const MAX_WIND_SPEED_MPH = 60;
/** Grid half-width: generous enough for a fast run, bounded so downloads stay small. */
const ASSUMED_FAST_SPREAD_METERS_PER_MINUTE = 40;
const MIN_RADIUS_METERS = 3000;
const MAX_RADIUS_METERS = 12000;

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

function radiusFor(horizonMinutes: number): number {
  return Math.min(
    Math.max(horizonMinutes * ASSUMED_FAST_SPREAD_METERS_PER_MINUTE, MIN_RADIUS_METERS),
    MAX_RADIUS_METERS,
  );
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

export default function FireSimulatorPage() {
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
  const [clickMode, setClickMode] = useState<ClickMode>("origin");
  const [showFuel, setShowFuel] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [landscape, setLandscape] = useState<LandscapeState>({ status: "idle" });
  const [windSource, setWindSource] = useState<WindSourceState>({ status: "idle" });

  const radiusMeters = radiusFor(horizonMinutes);

  // Fuel and terrain depend only on where and how far, so wind and moisture edits never
  // refetch. An older request can never overwrite a newer one.
  const requestRef = useRef(0);
  useEffect(() => {
    if (!origin) {
      setLandscape({ status: "idle" });
      return;
    }
    const request = ++requestRef.current;
    const controller = new AbortController();
    setLandscape({ status: "loading" });
    loadLandscape(origin.longitude, origin.latitude, radiusMeters, controller.signal)
      .then((grid) => {
        if (request === requestRef.current) setLandscape({ status: "ready", grid });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setLandscape({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not load fuel and terrain data.",
        });
      });
    return () => controller.abort();
  }, [origin, radiusMeters]);

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
  const lastIndex = Math.max(frames.length - 1, 0);
  const safeIndex = Math.min(frameIndex, lastIndex);
  const frame = frames[safeIndex];

  useEffect(() => {
    if (frameIndex > lastIndex) setFrameIndex(lastIndex);
  }, [frameIndex, lastIndex]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const timer = window.setInterval(() => {
      setFrameIndex((index) => {
        if (index >= lastIndex) {
          setPlaying(false);
          return lastIndex;
        }
        return index + 1;
      });
    }, PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, frames.length, lastIndex]);

  // Fit and start playback once a freshly placed ignition has a solved run.
  const runKey = run ? `${run.scenario.origin.latitude},${run.scenario.origin.longitude}` : null;
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!runKey || runKey === lastFitKey.current) return;
    lastFitKey.current = runKey;
    setFrameIndex(0);
    setPlaying(true);
    setFitSignal((value) => value + 1);
  }, [runKey]);

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

  const handleMapClick = useCallback(
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
    setFrameIndex(0);
    setPlaying(false);
    setClickMode("origin");
    setFitSignal(0);
    lastFitKey.current = null;
    dropWindProvenance();
  }

  const windTowardDegrees = (windFromDegrees + 180) % 360;
  // Attribution covers the whole run, so the three mechanisms sum to the final burned area.
  const breakdownTotal = run
    ? run.arrivalBreakdown.surfaceSquareMeters +
      run.arrivalBreakdown.spottingSquareMeters +
      run.arrivalBreakdown.structureSquareMeters
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

  return (
    <main className="fire-page">
      <header className="fire-header">
        <a className="wordmark" href="/" aria-label="CrisisTwin home">
          <span className="mark" aria-hidden="true">
            CT
          </span>
          CrisisTwin
        </a>
        <span className="badge">Fire spread · simulated</span>
      </header>

      <div className="fire-layout">
        <section className="fire-panel" aria-labelledby="fire-controls-title">
          <h1 id="fire-controls-title">Fire spread simulator</h1>
          <p className="fire-lede">
            Rothermel surface spread over real LANDFIRE fuels and terrain, stepped forward in{" "}
            {FIRE_STEP_MINUTES}-minute intervals, plus two optional wildland-urban mechanisms you
            switch on as assumptions.
          </p>

          <fieldset className="fire-field">
            <legend>Clicking the map sets</legend>
            <div className="fire-radio-row">
              <label>
                <input
                  type="radio"
                  name="click-mode"
                  checked={clickMode === "origin"}
                  onChange={() => setClickMode("origin")}
                />
                Ignition point
              </label>
              <label>
                <input
                  type="radio"
                  name="click-mode"
                  checked={clickMode === "wind"}
                  disabled={!origin}
                  onChange={() => setClickMode("wind")}
                />
                Wind direction
              </label>
            </div>
            <p className="fire-hint">
              {origin
                ? clickMode === "origin"
                  ? "Click anywhere to move the ignition point."
                  : "Click downwind of the ignition point to aim the wind that way."
                : "Click the map, or press Enter with the map focused, to place the ignition point."}
            </p>
          </fieldset>

          <div className="fire-field">
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

          <div className="fire-field fire-field-inline">
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
            <span className="fire-readout">
              {compassPoint(windFromDegrees)} → toward {Math.round(windTowardDegrees)}°{" "}
              {compassPoint(windTowardDegrees)}
            </span>
          </div>

          <div className="fire-field">
            <button
              type="button"
              className="fire-secondary"
              onClick={lookUpNwsWind}
              disabled={!origin || windSource.status === "loading"}
            >
              Use current NWS wind
            </button>
            {!origin && (
              <p className="fire-hint">
                Place an ignition point first: the forecast is looked up for that location.
              </p>
            )}
            {windSource.status === "loading" && (
              <div className="fire-loading" role="status">
                <span className="fire-spinner" aria-hidden="true" />
                Reading the National Weather Service hourly forecast…
              </div>
            )}
            {windSource.status === "error" && (
              <p className="fire-alert" role="alert">
                {windSource.message}
              </p>
            )}
            {windSource.status === "ready" ? (
              <p className="fire-status">
                {nwsProvenance(windSource.reading, windSource.clampedFromMph)}
              </p>
            ) : (
              <p className="fire-status">
                Assumption — the wind above is a value you set, not an observation. Nothing has
                been fetched for this scenario.
              </p>
            )}
          </div>

          <div className="fire-field">
            <span className="fire-legend-title">Fuel moisture</span>
            <div className="fire-preset-row">
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
            <details className="fire-advanced">
              <summary>Advanced: moisture classes and spread parameters</summary>
              <div className="fire-moisture-grid">
                {MOISTURE_FIELDS.map(({ key, label, title }) => (
                  <div className="fire-moisture-field" key={key}>
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
              <div className="fire-field fire-field-inline">
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
                <span className="fire-readout">
                  Midflame wind {(windSpeedMph * midflameAdjustment).toFixed(1)} mph
                </span>
              </div>
              <div className="fire-field fire-field-inline">
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
                <span className="fire-readout">
                  {!spottingEnabled
                    ? "Ember spotting is switched off, so this has no effect"
                    : spottingDistanceMeters > SUPPORTED_SPOTTING_DISTANCE_METERS
                      ? `${spottingDistanceMeters} m is past what surface-fire spotting supports`
                      : `Embers land up to ${spottingDistanceMeters} m downwind`}
                </span>
              </div>
              <div className="fire-field fire-field-inline">
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
                <span className="fire-readout">
                  {structureSpreadEnabled
                    ? "Assumed, not measured; the model scales it with wind speed"
                    : "Structure-to-structure spread is switched off, so this has no effect"}
                </span>
              </div>
            </details>
          </div>

          <div className="fire-field fire-field-inline">
            <label htmlFor="horizon">Horizon</label>
            <select
              id="horizon"
              value={horizonMinutes}
              onChange={(event) => setHorizonMinutes(Number(event.target.value))}
            >
              {HORIZON_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes / 60} hours
                </option>
              ))}
            </select>
            <span className="fire-readout">{(radiusMeters / 1000).toFixed(0)} km grid radius</span>
          </div>

          <div className="fire-field">
            <span className="fire-legend-title">Extra spread mechanisms (your assumptions)</span>
            <div className="fire-toggle-row">
              <input
                id="spotting-enabled"
                type="checkbox"
                checked={spottingEnabled}
                onChange={(event) => setSpottingEnabled(event.target.checked)}
              />
              <label htmlFor="spotting-enabled">Ember spotting</label>
            </div>
            <p className="fire-hint">
              Burning embers are carried downwind and start new fires ahead of the front, so the
              fire can cross a road, a river, or a firebreak instead of stopping at it.
            </p>
            <div className="fire-toggle-row">
              <input
                id="structure-spread-enabled"
                type="checkbox"
                checked={structureSpreadEnabled}
                onChange={(event) => setStructureSpreadEnabled(event.target.checked)}
              />
              <label htmlFor="structure-spread-enabled">Structure-to-structure spread</label>
            </div>
            <p className="fire-hint">
              Once fire reaches a built-up area, burning buildings ignite their neighbours, so the
              fire keeps moving through streets and yards that carry no vegetation.
            </p>
          </div>

          {structureSpreadEnabled && (
            <p className="fire-warning" role="status">
              Structure-to-structure spread is a coarse stand-in for urban conflagration, not a
              validated structure-fire model. It ignores building materials, spacing, defensible
              space, and suppression, and it will overstate losses in some neighbourhoods and
              understate them in others. Treat any burned area it contributes as an assumption you
              have switched on, not as a prediction of which homes are lost.
            </p>
          )}

          <div className="fire-toggle-row">
            <input
              id="show-fuel"
              type="checkbox"
              checked={showFuel}
              onChange={(event) => setShowFuel(event.target.checked)}
              disabled={!grid}
            />
            <label htmlFor="show-fuel">Show the fuel layer the model is using</label>
          </div>
          {showFuel && grid && (
            <ul className="fire-fuel-legend">
              {FUEL_COLORS.map((entry) => (
                <li className="fire-fuel-legend-item" key={entry.label}>
                  <span
                    className="fire-fuel-swatch"
                    style={{ background: entry.color }}
                    aria-hidden="true"
                  />
                  {entry.label}
                </li>
              ))}
            </ul>
          )}

          {landscape.status === "loading" && (
            <div className="fire-loading" role="status">
              <span className="fire-spinner" aria-hidden="true" />
              Loading LANDFIRE fuels and terrain for a {(radiusMeters / 1000).toFixed(0)} km radius…
            </div>
          )}
          {landscape.status === "error" && (
            <p className="fire-alert" role="alert">
              {landscape.message}
            </p>
          )}
          {result.error && (
            <p className="fire-alert" role="alert">
              {result.error}
            </p>
          )}
          {!origin && landscape.status === "idle" && (
            <p className="fire-empty" role="status">
              No scenario yet. Place an ignition point on vegetated ground to run the model.
            </p>
          )}

          {run && frame && (
            <>
              <div className="fire-ignition-card">
                <div className="fire-ignition-row">
                  <span>Fuel at ignition</span>
                  <strong>{run.ignition.fuelLabel}</strong>
                </div>
                <div className="fire-ignition-row">
                  <span>Head rate of spread</span>
                  <strong>
                    {(run.ignition.spread.headRateFeetPerMinute * 0.3048).toFixed(1)} m/min
                  </strong>
                </div>
                <div className="fire-ignition-row">
                  <span>Flame length</span>
                  <strong>{(run.ignition.spread.flameLengthFeet * 0.3048).toFixed(1)} m</strong>
                </div>
                <div className="fire-ignition-row">
                  <span>Slope · elevation</span>
                  <strong>
                    {run.ignition.slopePercent.toFixed(0)}% ·{" "}
                    {run.ignition.elevationMeters.toFixed(0)} m
                  </strong>
                </div>
                <div className="fire-ignition-row">
                  <span>Burnable in modelled area</span>
                  <strong>{(run.burnableFraction * 100).toFixed(0)}%</strong>
                </div>
              </div>

              <div className="fire-ignition-card">
                <h2>How the fire spread (simulated)</h2>
                <p>
                  Every burned cell is credited to whichever mechanism reached it first, measured
                  over the whole run to {formatElapsed(run.scenario.horizonMinutes)} rather than at
                  the elapsed time below.
                </p>
                {spreadShares && breakdownTotal > 0 ? (
                  <>
                    <div className="fire-ignition-row">
                      <span>Surface spread through fuels (modelled)</span>
                      <strong>{spreadShares.surface}</strong>
                    </div>
                    <div className="fire-ignition-row">
                      <span>Ember spotting (assumption)</span>
                      <strong>{spreadShares.spotting}</strong>
                    </div>
                    <div className="fire-ignition-row">
                      <span>Structure-to-structure (assumption)</span>
                      <strong>{spreadShares.structure}</strong>
                    </div>
                    <div className="fire-ignition-row">
                      <span>Developed ground in modelled area</span>
                      <strong>{(run.developedFraction * 100).toFixed(0)}%</strong>
                    </div>
                    <p>
                      Only the surface line comes from the Rothermel physics. The spotting and
                      structure-to-structure lines are the assumptions you switched on: the more
                      of the burn they account for, the less of this run is a validated fire
                      model. Developed ground is read from the LANDFIRE fuel map, not simulated.
                    </p>
                  </>
                ) : (
                  <p>
                    Nothing burned, so there is no breakdown to show. Check the fuel at the
                    ignition point and the horizon.
                  </p>
                )}
              </div>

              {run.ignition.spread.beyondValidatedWind && (
                <p className="fire-warning" role="status">
                  Effective wind is past the range Rothermel (1972) was validated against. Spread
                  rates here are extrapolation.
                </p>
              )}
              {stalledAt !== null && (
                <p className="fire-warning" role="status">
                  The fire stops growing at {formatElapsed(stalledAt)}: it is fuel-limited, boxed in
                  by non-burnable ground.{" "}
                  {structureSpreadEnabled
                    ? "Structure-to-structure spread is on, so this is where the model ran out " +
                      "of built-up ground to carry fire, not where real risk ends."
                    : "Structure-to-structure spread is switched off, so this understates risk " +
                      "at the wildland-urban edge."}
                </p>
              )}
              {run.reachedEdge && (
                <p className="fire-warning" role="status">
                  The fire reached the edge of the modelled area. Results past that point are
                  truncated; try a longer horizon for a wider grid.
                </p>
              )}

              <div className="fire-field">
                <label htmlFor="timeline">
                  Elapsed <strong>{formatElapsed(frame.elapsedMinutes)}</strong>
                </label>
                <input
                  id="timeline"
                  type="range"
                  min={0}
                  max={lastIndex}
                  step={1}
                  value={safeIndex}
                  onChange={(event) => {
                    setPlaying(false);
                    setFrameIndex(Number(event.target.value));
                  }}
                />
                <div className="fire-transport">
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      setFrameIndex(Math.max(safeIndex - 1, 0));
                    }}
                    disabled={safeIndex === 0}
                  >
                    ‹ Back {FIRE_STEP_MINUTES}m
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!playing && safeIndex >= lastIndex) setFrameIndex(0);
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? "Pause" : "Play"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      setFrameIndex(Math.min(safeIndex + 1, lastIndex));
                    }}
                    disabled={safeIndex === lastIndex}
                  >
                    Forward {FIRE_STEP_MINUTES}m ›
                  </button>
                </div>
              </div>

              <dl className="fire-metrics" aria-live="polite">
                <div>
                  <dt>Burned area (simulated)</dt>
                  <dd>{formatArea(frame.burnedAreaSquareMeters)}</dd>
                </div>
                <div>
                  <dt>Furthest reach</dt>
                  <dd>{formatDistance(frame.maxReachMeters)}</dd>
                </div>
                <div>
                  <dt>Ignition point (WGS84)</dt>
                  <dd>
                    {run.scenario.origin.latitude.toFixed(5)},{" "}
                    {run.scenario.origin.longitude.toFixed(5)}
                  </dd>
                </div>
                <div>
                  <dt>Grid · solve time</dt>
                  <dd>
                    {run.cellSizeMeters.toFixed(0)} m · {run.computeMilliseconds.toFixed(0)} ms
                  </dd>
                </div>
              </dl>

              <div className="fire-legend">
                <span className="fire-legend-title">Arrival time</span>
                <div className="fire-legend-scale" aria-hidden="true">
                  <span style={{ background: ARRIVAL_COLORS.earliest }} />
                  <span style={{ background: ARRIVAL_COLORS.middle }} />
                  <span style={{ background: ARRIVAL_COLORS.latest }} />
                </div>
                <div className="fire-legend-labels">
                  <span>{formatElapsed(FIRE_STEP_MINUTES)}</span>
                  <span>{formatElapsed(Math.round(horizonMinutes / 2))}</span>
                  <span>{formatElapsed(horizonMinutes)}</span>
                </div>
                <p>
                  Each band is one {FIRE_STEP_MINUTES}-minute step, shaded by when the fire reached
                  it. The bright outline is the perimeter at the elapsed time above.
                </p>
              </div>

              <div className="fire-transport">
                <button
                  type="button"
                  className="fire-secondary"
                  onClick={() => setFitSignal((value) => value + 1)}
                >
                  Fit view to run
                </button>
                <button type="button" className="fire-secondary" onClick={clearScenario}>
                  Clear scenario
                </button>
              </div>
            </>
          )}

          <div className="fire-sources">
            <p>Fuel: {LANDFIRE_ATTRIBUTION}</p>
            <p>Terrain: {TERRAIN_ATTRIBUTION}</p>
            <p>
              Spread: Rothermel (1972) per Andrews RMRS-GTR-371; Scott &amp; Burgan (2005) fuel
              models; minimum travel time after Finney (2002).
            </p>
            <p>Wind (only when fetched): {NWS_ATTRIBUTION}</p>
          </div>

          <footer className="fire-disclaimer">
            <p>
              Simulated result, not an observation. Rothermel surface fire with no crown fire and
              no suppression. {mechanismsSentence(spottingEnabled, structureSpreadEnabled)} Wind
              and fuel moisture are uniform across the grid and constant in time. LANDFIRE fuel is
              a mapped 2025 product, not today&rsquo;s vegetation.
            </p>
            <p>
              The default moisture preset and wind speed on this page are demo settings chosen to
              show peak fire weather, not values calibrated against a recorded fire.
            </p>
            <p>A planning experiment, not an operational evacuation instruction.</p>
          </footer>
        </section>

        <FireMap
          origin={origin}
          windFromDegrees={windFromDegrees}
          frames={frames}
          frameIndex={safeIndex}
          landscape={grid}
          showFuel={showFuel}
          fitSignal={fitSignal}
          clickMode={clickMode}
          onMapClick={handleMapClick}
        />
      </div>
    </main>
  );
}
