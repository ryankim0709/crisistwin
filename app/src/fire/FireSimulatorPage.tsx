import { useEffect, useMemo, useState } from "react";
import FireMap, { ARRIVAL_COLORS, type ClickMode } from "./FireMap";
import {
  FIRE_HORIZON_MINUTES,
  FIRE_STEP_MINUTES,
  MAX_WIND_SPEED_MPH,
  METERS_PER_MILE,
  SQUARE_METERS_PER_ACRE,
  SQUARE_METERS_PER_HECTARE,
  bearingBetween,
  compassPoint,
  formatElapsed,
  simulateFire,
  type FireRun,
  type GeoPoint,
} from "./model";
import "./fire.css";

const PLAYBACK_INTERVAL_MS = 850;
const HORIZON_CHOICES = [120, 180, 360] as const;
const DEFAULT_WIND_SPEED_MPH = 15;
/** Offshore north-easterly, the direction that drives the worst East Bay fire weather. */
const DEFAULT_WIND_FROM_DEGREES = 45;

function formatArea(squareMeters: number): string {
  const hectares = squareMeters / SQUARE_METERS_PER_HECTARE;
  const acres = squareMeters / SQUARE_METERS_PER_ACRE;
  return `${hectares.toFixed(hectares < 10 ? 1 : 0)} ha · ${acres.toFixed(acres < 10 ? 1 : 0)} acres`;
}

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km · ${(meters / METERS_PER_MILE).toFixed(2)} mi`;
}

export default function FireSimulatorPage() {
  const [origin, setOrigin] = useState<GeoPoint | null>(null);
  const [windSpeedMph, setWindSpeedMph] = useState(DEFAULT_WIND_SPEED_MPH);
  const [windFromDegrees, setWindFromDegrees] = useState(DEFAULT_WIND_FROM_DEGREES);
  const [horizonMinutes, setHorizonMinutes] = useState<number>(FIRE_HORIZON_MINUTES);
  const [clickMode, setClickMode] = useState<ClickMode>("origin");
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);

  const result = useMemo<{ run: FireRun | null; error: string | null }>(() => {
    if (!origin) return { run: null, error: null };
    try {
      return {
        run: simulateFire({
          origin,
          wind: { speedMph: windSpeedMph, fromDegrees: windFromDegrees },
          stepMinutes: FIRE_STEP_MINUTES,
          horizonMinutes,
        }),
        error: null,
      };
    } catch (cause) {
      return {
        run: null,
        error: cause instanceof Error ? cause.message : "This scenario could not be simulated.",
      };
    }
  }, [origin, windSpeedMph, windFromDegrees, horizonMinutes]);

  const frames = useMemo(() => result.run?.frames ?? [], [result.run]);
  const lastIndex = Math.max(frames.length - 1, 0);
  const safeIndex = Math.min(frameIndex, lastIndex);
  const frame = frames[safeIndex];

  useEffect(() => {
    if (frameIndex > lastIndex) setFrameIndex(lastIndex);
  }, [frameIndex, lastIndex]);

  // Playback advances the simulation clock one step at a time; it never reads wall-clock time.
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

  function handleMapClick(point: GeoPoint) {
    if (clickMode === "wind" && origin) {
      // Clicking downwind of the ignition point sets the direction the fire is pushed.
      setWindFromDegrees(Math.round((bearingBetween(origin, point) + 180) % 360));
      return;
    }
    setOrigin(point);
    setFrameIndex(0);
    setPlaying(true);
    setFitSignal((value) => value + 1);
  }

  function clearScenario() {
    setOrigin(null);
    setFrameIndex(0);
    setPlaying(false);
    setClickMode("origin");
    setFitSignal(0);
  }

  const windTowardDegrees = (windFromDegrees + 180) % 360;

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
            Place an ignition point, set the wind, and step the perimeter forward in{" "}
            {FIRE_STEP_MINUTES}-minute intervals.
          </p>

          <fieldset className="fire-field">
            <legend>Clicking the map sets</legend>
            <div className="fire-radio-row">
              <label>
                <input
                  type="radio"
                  name="click-mode"
                  value="origin"
                  checked={clickMode === "origin"}
                  onChange={() => setClickMode("origin")}
                />
                Ignition point
              </label>
              <label>
                <input
                  type="radio"
                  name="click-mode"
                  value="wind"
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
              Wind speed <strong>{windSpeedMph} mph</strong>
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
              {compassPoint(windFromDegrees)} → blowing toward {Math.round(windTowardDegrees)}°{" "}
              {compassPoint(windTowardDegrees)}
            </span>
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
            <span className="fire-readout">{lastIndex} steps</span>
          </div>

          {result.error && (
            <p className="fire-alert" role="alert">
              {result.error}
            </p>
          )}

          {!origin && !result.error && (
            <p className="fire-empty" role="status">
              No scenario yet. Place an ignition point on the map to run the model.
            </p>
          )}

          {origin && frame && (
            <>
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
                  <dt>Head reach from ignition</dt>
                  <dd>{formatDistance(frame.headDistanceMeters)}</dd>
                </div>
                <div>
                  <dt>Head rate of spread</dt>
                  <dd>{result.run?.headRateMetersPerMinute.toFixed(1)} m/min</dd>
                </div>
                <div>
                  <dt>Ignition point (WGS84)</dt>
                  <dd>
                    {origin.latitude.toFixed(5)}, {origin.longitude.toFixed(5)}
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
                  Each ring is one {FIRE_STEP_MINUTES}-minute step. The bright outline is the
                  perimeter at the elapsed time shown above.
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

          <footer className="fire-disclaimer">
            <p>
              Simulated result from the{" "}
              <code>{result.run?.model.id ?? "uniform-fuel-ellipse"}</code> v
              {result.run?.model.version ?? "1.0.0"} demo model: a deterministic wind-driven ellipse
              on flat, uniform fuel. It ignores fuel type and moisture, terrain, spotting,
              suppression, and barriers such as rivers and roads, and it is not calibrated against
              observed fires.
            </p>
            <p>
              Aerial imagery is historical USGS coverage, not live fire observation. This is a
              planning experiment, not an operational evacuation instruction.
            </p>
          </footer>
        </section>

        <FireMap
          origin={origin}
          windFromDegrees={windFromDegrees}
          frames={frames}
          frameIndex={safeIndex}
          fitSignal={fitSignal}
          clickMode={clickMode}
          onMapClick={handleMapClick}
        />
      </div>
    </main>
  );
}
