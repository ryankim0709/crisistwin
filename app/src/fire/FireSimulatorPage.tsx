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
  FIRE_HORIZON_MINUTES,
  FIRE_STEP_MINUTES,
  HORIZON_CHOICES,
  METERS_PER_MILE,
  MOISTURE_PRESETS,
  NonBurnableIgnitionError,
  SQUARE_METERS_PER_ACRE,
  SQUARE_METERS_PER_HECTARE,
  bearingBetween,
  compassPoint,
  formatElapsed,
  simulateFireSpread,
  type FireRun,
  type GeoPoint,
} from "./spread";
import "./fire.css";

const PLAYBACK_INTERVAL_MS = 850;
const MAX_WIND_SPEED_MPH = 60;
/** Grid half-width: generous enough for a fast run, bounded so downloads stay small. */
const ASSUMED_FAST_SPREAD_METERS_PER_MINUTE = 40;
const MIN_RADIUS_METERS = 3000;
const MAX_RADIUS_METERS = 12000;

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

export default function FireSimulatorPage() {
  const [origin, setOrigin] = useState<GeoPoint | null>(null);
  const [windSpeedMph, setWindSpeedMph] = useState(25);
  const [windFromDegrees, setWindFromDegrees] = useState(45);
  const [presetId, setPresetId] = useState(MOISTURE_PRESETS[1].id);
  const [moisture, setMoisture] = useState<FuelMoisture>(MOISTURE_PRESETS[1].moisture);
  const [midflameAdjustment, setMidflameAdjustment] = useState(DEFAULT_MIDFLAME_ADJUSTMENT);
  const [horizonMinutes, setHorizonMinutes] = useState<number>(FIRE_HORIZON_MINUTES);
  const [clickMode, setClickMode] = useState<ClickMode>("origin");
  const [showFuel, setShowFuel] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [landscape, setLandscape] = useState<LandscapeState>({ status: "idle" });

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
          }
        : null,
    [origin, windSpeedMph, windFromDegrees, moisture, midflameAdjustment, horizonMinutes],
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

  const handleMapClick = useCallback(
    (point: GeoPoint) => {
      if (clickMode === "wind") {
        setWindFromDegrees((current) =>
          origin ? Math.round((bearingBetween(origin, point) + 180) % 360) : current,
        );
        return;
      }
      setOrigin(point);
    },
    [clickMode, origin],
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
  }

  const windTowardDegrees = (windFromDegrees + 180) % 360;
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
            {FIRE_STEP_MINUTES}-minute intervals.
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
              onChange={(event) => setWindSpeedMph(Number(event.target.value))}
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
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) setWindFromDegrees(((value % 360) + 360) % 360);
              }}
            />
            <span className="fire-readout">
              {compassPoint(windFromDegrees)} → toward {Math.round(windTowardDegrees)}°{" "}
              {compassPoint(windTowardDegrees)}
            </span>
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
              <summary>Advanced: individual moisture classes</summary>
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

              {run.ignition.spread.beyondValidatedWind && (
                <p className="fire-warning" role="status">
                  Effective wind is past the range Rothermel (1972) was validated against. Spread
                  rates here are extrapolation.
                </p>
              )}
              {stalledAt !== null && (
                <p className="fire-warning" role="status">
                  The fire stops growing at {formatElapsed(stalledAt)}: it is fuel-limited, boxed in
                  by non-burnable ground. The model has no structure-to-structure spread, so this
                  understates risk at the wildland-urban edge.
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
          </div>

          <footer className="fire-disclaimer">
            <p>
              Simulated result, not an observation. Surface fire only: no crown fire, spotting,
              suppression, or structure-to-structure spread. Wind and fuel moisture are uniform
              across the grid and constant in time. LANDFIRE fuel is a mapped 2025 product, not
              today&rsquo;s vegetation.
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
