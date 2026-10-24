import { useEffect, useState, type FormEvent } from "react";
import MapCanvas, { type MapLocation } from "./MapCanvas";
import {
  EMPTY_PERIMETER,
  FIRE_HORIZON_MINUTES,
  FIRE_STEP_MINUTES,
  simulateFire,
  type FireRun,
} from "../simulation/fire";

const SAN_FRANCISCO = { latitude: 37.7749, longitude: -122.4194 };
const WIND_DIRECTIONS = [
  [0, "N → south"],
  [45, "NE → southwest"],
  [90, "E → west"],
  [135, "SE → northwest"],
  [180, "S → north"],
  [225, "SW → northeast"],
  [270, "W → east"],
  [315, "NW → southeast"],
] as const;

export default function MapsPage() {
  const [origin, setOrigin] = useState<MapLocation | null>(null);
  const [windSpeed, setWindSpeed] = useState("10");
  const [windFrom, setWindFrom] = useState(270);
  const [run, setRun] = useState<FireRun | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ center: SAN_FRANCISCO, zoom: 11.5 });
  const frame = run?.frames[frameIndex];

  useEffect(() => {
    if (!playing || !run || frameIndex >= run.frames.length - 1) return;
    const next = frameIndex + 1;
    const timer = window.setTimeout(() => {
      setFrameIndex(next);
      if (next === run.frames.length - 1) setPlaying(false);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [playing, run, frameIndex]);

  function clearRun() {
    setRun(null);
    setFrameIndex(0);
    setPlaying(false);
    setError(null);
  }

  function chooseOrigin(location: MapLocation) {
    setOrigin(location);
    clearRun();
  }

  function startSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!origin) return;
    try {
      const result = simulateFire({
        origin,
        windSpeedMph: Number(windSpeed),
        windFromDegrees: windFrom,
      });
      setRun(result);
      setFrameIndex(1);
      setPlaying(false);
      setError(null);
      setView({ center: origin, zoom: 14 });
    } catch (cause) {
      clearRun();
      setError(cause instanceof Error ? cause.message : "The simulation could not run.");
    }
  }

  return (
    <main className="map-page">
      <header className="map-page-header">
        <a className="wordmark" href="/" aria-label="CrisisTwin home">
          <span className="mark" aria-hidden="true">
            CT
          </span>
          CrisisTwin
        </a>
        <span>Fire simulation</span>
      </header>
      <MapCanvas
        center={view.center}
        zoom={view.zoom}
        selectedLocation={origin}
        firePerimeter={frame?.perimeter ?? EMPTY_PERIMETER}
        onLocationSelect={chooseOrigin}
      />
      <section className="fire-controls" aria-label="Fire simulation controls">
        <form className="fire-inputs" onSubmit={startSimulation}>
          <div className="fire-origin" aria-live="polite">
            <strong>
              {origin ? "Fire origin selected" : "1. Click the map to set a fire origin"}
            </strong>
            <span>
              {origin
                ? `${origin.latitude.toFixed(5)}°, ${origin.longitude.toFixed(5)}°`
                : "Or focus the map and press Enter to use its center."}
            </span>
          </div>
          <label>
            Wind speed{" "}
            <span className="input-unit">
              <input
                type="number"
                min="0"
                max="40"
                step="1"
                required
                value={windSpeed}
                onChange={(event) => {
                  setWindSpeed(event.target.value);
                  clearRun();
                }}
              />{" "}
              mph
            </span>
          </label>
          <label>
            Wind from
            <select
              value={windFrom}
              onChange={(event) => {
                setWindFrom(Number(event.target.value));
                clearRun();
              }}
            >
              {WIND_DIRECTIONS.map(([degrees, label]) => (
                <option key={degrees} value={degrees}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!origin}>
            Simulate fire
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!origin}
            onClick={() => {
              setOrigin(null);
              clearRun();
            }}
          >
            Reset
          </button>
        </form>
        {error && (
          <p className="simulation-error" role="alert">
            {error}
          </p>
        )}
        {run && (
          <div className="fire-timeline">
            <button
              className="secondary-button"
              type="button"
              disabled={frameIndex === 0}
              aria-label="Previous 15 minutes"
              onClick={() => {
                setPlaying(false);
                setFrameIndex((index) => index - 1);
              }}
            >
              ←
            </button>
            <button
              type="button"
              aria-label={playing ? "Pause simulation playback" : "Play simulation playback"}
              onClick={() => {
                if (frameIndex === run.frames.length - 1) setFrameIndex(0);
                setPlaying((value) => !value);
              }}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={frameIndex === run.frames.length - 1}
              aria-label="Next 15 minutes"
              onClick={() => {
                setPlaying(false);
                setFrameIndex((index) => index + 1);
              }}
            >
              →
            </button>
            <label className="timeline-slider">
              Time since ignition
              <input
                type="range"
                min="0"
                max={FIRE_HORIZON_MINUTES}
                step={FIRE_STEP_MINUTES}
                value={frame?.elapsedMinutes ?? 0}
                aria-valuetext={`${frame?.elapsedMinutes ?? 0} minutes after ignition`}
                onChange={(event) => {
                  setPlaying(false);
                  setFrameIndex(Number(event.target.value) / FIRE_STEP_MINUTES);
                }}
              />
            </label>
            <output aria-live="polite">+{frame?.elapsedMinutes ?? 0} min</output>
            <span className="timeline-caption">15-minute steps · 2 hours</span>
          </div>
        )}
        <p className="simulation-note">
          <span className="fire-swatch" aria-hidden="true" />
          {run ? "Shaded area: simulated footprint. " : "Illustrative fire-spread model. "}
          Uniform fuel; terrain, water, buildings, and suppression are not modeled. Not an
          operational forecast.
        </p>
      </section>
    </main>
  );
}
