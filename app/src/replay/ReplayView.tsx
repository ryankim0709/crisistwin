import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupAvailability } from "./layerGroups";
import CompareTab from "./CompareTab";
import { BundleMissingError, REPLAY_VIEW, fetchReplayBundle, type ViewConfig } from "./loadBundle";
import StressTab from "./StressTab";
import { useVariants } from "./useVariants";
import { IMAGERY_DATE_NOTE, LAYER_GROUPS, type Basemap, type LayerGroup } from "./mapLayers";
import ReplayMap, { type MapFocus } from "./ReplayMap";
import SidePanel, { type PanelTab } from "./SidePanel";
import TimelineDock, { SPEEDS } from "./TimelineDock";
import {
  PERIMETER_PROVENANCE,
  clampTime,
  formatAge,
  frameIndexAt,
  hasFixtureData,
  lastAtOrBefore,
  localTime,
  perimeterIndexAt,
  simulatedFrontIndexAt,
  zoneStatesAt,
} from "./timeline";
import { buildCaption } from "./narrative";
import MapLegend from "./MapLegend";
import type { LngLat, ReplayModel } from "./types";
import "./replay.css";

const LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_SPEED = SPEEDS[1].value;
const STEP_SECONDS = 10 * 60;
const BIG_STEP_SECONDS = 60 * 60;
const FIXTURE_LAYER_LABEL: Record<string, string> = {
  zones: "demand zones, vehicle counts and evacuation orders",
};
/** Dots move at true modelled speed up to this playback rate, and are slowed above it. */
const PARTICLE_PACE = 60;

type Load =
  | { status: "loading" }
  | { status: "ready"; model: ReplayModel }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

export default function ReplayView({ config = REPLAY_VIEW }: { config?: ViewConfig }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    fetchReplayBundle(controller.signal, config.bundleUrl)
      .then((model) => {
        if (active) setLoad({ status: "ready", model });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof BundleMissingError) {
          setLoad({ status: "missing", message: error.message });
        } else if (error instanceof DOMException && error.name === "AbortError") {
          setLoad({ status: "error", message: "Loading the replay bundle timed out." });
        } else {
          setLoad({
            status: "error",
            message: error instanceof Error ? error.message : "The replay bundle could not be loaded.",
          });
        }
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, config.bundleUrl]);

  function retry() {
    setLoad({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  if (load.status === "ready") return <ReplayScreen model={load.model} config={config} />;

  const sim = config.kind === "simulation";
  return (
    <main className={`rp-root rp-root--state${sim ? " rp-root--sim" : ""}`}>
      <div className="rp-state-card">
        <a className="rp-back" href="/">
          ← Workspace
        </a>
        <p className="rp-eyebrow">{config.eyebrow}</p>
        {load.status === "loading" && (
          <p role="status" className="rp-state-msg">
            <span className="rp-spinner" aria-hidden="true" /> Loading replay bundle…
          </p>
        )}
        {load.status === "missing" && (
          <div role="alert">
            <h1>{sim ? "No agent simulation yet" : "No replay bundle yet"}</h1>
            <p className="rp-state-msg">{load.message}</p>
            <p className="rp-state-msg">
              Generate it, then reload:
              <code>{config.generateHint}</code>
            </p>
            <button type="button" className="rp-btn rp-btn--text" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        {load.status === "error" && (
          <div role="alert">
            <h1>{sim ? "Simulation unavailable" : "Replay unavailable"}</h1>
            <p className="rp-state-msg">{load.message}</p>
            <p className="rp-state-msg rp-dim">Source: {config.bundleUrl}</p>
            <button type="button" className="rp-btn rp-btn--text" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        <a className="rp-back rp-other-route" href={config.otherRoute.href}>
          {config.otherRoute.label}
        </a>
      </div>
    </main>
  );
}

const DEFAULT_OFF: LayerGroup[] = ["damage", "zones"];

function initialVisibility(model: ReplayModel): Record<LayerGroup, boolean> {
  const out = {} as Record<LayerGroup, boolean>;
  for (const group of Object.keys(LAYER_GROUPS) as LayerGroup[]) {
    // Off by default: damage (a post-fire assessment, auto-shown at the end) and the
    // synthetic zone grid (orders flash briefly on the map instead).
    out[group] = !DEFAULT_OFF.includes(group) && groupAvailability(model, group).available;
  }
  return out;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function ReplayScreen({ model: baseline, config }: { model: ReplayModel; config: ViewConfig }) {
  const variants = useVariants(baseline, config.variantsUrl);
  const model = variants.shown?.model ?? baseline;
  const { startMs, endMs } = model.clock;
  const [simTimeMs, setSimTimeMs] = useState(startMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [panelOpen, setPanelOpen] = useState(true);
  const [visibility, setVisibility] = useState(() => initialVisibility(baseline));
  const [perParticle, setPerParticle] = useState<number | null>(null);
  const [tab, setTab] = useState<PanelTab>("overview");
  const [basemap, setBasemap] = useState<Basemap>("dark");
  const [pin, setPin] = useState<LngLat | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const timeRef = useRef(startMs);
  const focusTarget = useCallback((coords: LngLat[]) => {
    setFocus((prev) => ({ key: (prev?.key ?? 0) + 1, coords }));
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const t = clampTime(model, ms);
      timeRef.current = t;
      setSimTimeMs(t);
    },
    [model],
  );

  // Playback advances the simulation clock by (wall seconds elapsed x speed). Displayed data
  // is always looked up from the bundle by simulation time, never by wall-clock time.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, now - last) / 1000);
      last = now;
      const next = Math.min(endMs, timeRef.current + dt * speed * 1000);
      timeRef.current = next;
      setSimTimeMs(next);
      if (next >= endMs) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, endMs]);

  const togglePlay = useCallback(() => {
    if (!playing && timeRef.current >= endMs) seek(startMs);
    setPlaying((p) => !p);
  }, [playing, endMs, startMs, seek]);

  const step = useCallback(
    (direction: -1 | 1, seconds = STEP_SECONDS) => {
      setPlaying(false);
      seek(timeRef.current + direction * seconds * 1000);
    },
    [seek],
  );

  const seekAndPause = useCallback(
    (ms: number) => {
      setPlaying(false);
      seek(ms);
    },
    [seek],
  );

  const reset = useCallback(() => {
    setPlaying(false);
    seek(startMs);
  }, [seek, startMs]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) return;
      const onButton = event.target instanceof HTMLButtonElement;
      if (event.key === " " && !onButton) {
        event.preventDefault();
        togglePlay();
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        // Arrow keys pan the map when it has focus.
        !(event.target instanceof Element && event.target.closest(".maplibregl-map"))
      ) {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey ? BIG_STEP_SECONDS : STEP_SECONDS);
      } else if (event.key === "Home") {
        event.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, step, reset]);

  const toggleLayer = useCallback((group: LayerGroup) => {
    setVisibility((v) => ({ ...v, [group]: !v[group] }));
  }, []);

  const frameIndex = frameIndexAt(model, simTimeMs);
  const perimeterIndex = perimeterIndexAt(model, simTimeMs);
  const simFrontIndex = simulatedFrontIndexAt(model, simTimeMs);
  const eventIndex = lastAtOrBefore(model.events, simTimeMs);
  const zoneStates = useMemo(() => zoneStatesAt(model.events, eventIndex), [model, eventIndex]);
  const fixture = hasFixtureData(model);
  const fixtureLayers = Object.entries(model.layerStatus)
    .filter(([, s]) => s.status === "fixture")
    .map(([name]) => FIXTURE_LAYER_LABEL[name] ?? name.replace(/_/g, " "));

  const sim = config.kind === "simulation";
  const extraTabs = [
    ...(variants.index
      ? [
          {
            id: "whatif" as const,
            label: "What if…",
            content: (
              <CompareTab
                baseline={baseline}
                index={variants.index}
                load={variants.load}
                showVariant={variants.showVariant}
                onSelect={variants.select}
                onShowVariant={variants.setShowVariant}
              />
            ),
          },
        ]
      : []),
    ...(config.stressUrl ? [{ id: "stress" as const, label: "Stress test", content: <StressTab url={config.stressUrl} /> }] : []),
  ];
  const caption = buildCaption(model, simTimeMs, frameIndex);
  const atEnd = simTimeMs >= endMs;
  // Damage is auto-shown once the replay reaches its end.
  const mapVisibility = useMemo(
    () => (atEnd && !visibility.damage ? { ...visibility, damage: true } : visibility),
    [atEnd, visibility],
  );
  const perimeter = perimeterIndex >= 0 ? model.perimeters[perimeterIndex] : null;
  const nextPerimeter = model.perimeters[perimeterIndex + 1] ?? null;

  return (
    <main
      className={`rp-root${panelOpen ? "" : " rp-root--collapsed"}${sim ? " rp-root--sim" : ""}${
        variants.shown ? " rp-root--variant" : ""
      }`}
    >
      <div className="rp-stage">
        <ReplayMap
          key={model.incident.id}
          model={model}
          simTimeMs={simTimeMs}
          perimeterIndex={perimeterIndex}
          frameIndex={frameIndex}
          simFrontIndex={simFrontIndex}
          motionScale={Math.min(1, PARTICLE_PACE / speed)}
          zoneStates={zoneStates}
          visibility={mapVisibility}
          onParticleScale={setPerParticle}
          pin={tab === "evacuee" ? pin : null}
          onPick={tab === "evacuee" ? setPin : null}
          focus={focus}
          basemapChoice={basemap}
        />

        <p className="rp-caption" aria-live="off">
          <span className="rp-caption-time">{localTime(simTimeMs, model.incident.timezone)}</span>
          {caption.event && (
            <span>
              {caption.event.label}
              {caption.event.fixture && !/fixture/i.test(caption.event.label) && " (fixture)"}
            </span>
          )}
          {caption.enRouteVeh !== null && (
            <span>{caption.enRouteVeh.toLocaleString("en-US")} vehicles on the road (model)</span>
          )}
          {caption.fire && <span className="rp-caption-fire">{caption.fire}</span>}
          {atEnd && model.damage && <span>Post-fire damage assessment shown (no damage time)</span>}
        </p>

        <div className="rp-hud">
          <div className="rp-banners">
            {sim ? (
              <p className="rp-banner rp-banner--sim" role="note">
                <strong>AGENT SIMULATION</strong> — modelled residents and responders; not a historical replay.
              </p>
            ) : (
              <p className="rp-banner" role="note">
                <strong>Retrospective reconstruction</strong> — simulated traffic, not recorded vehicle movement.
                Planning experiment only.
              </p>
            )}
            {variants.shown && (
              <p className="rp-banner rp-banner--variant" role="note">
                <strong>WHAT-IF: {variants.shown.title}</strong> — simulated counterfactual traffic; fire perimeters
                and other evidence unchanged.
              </p>
            )}
            {fixture && (
              <p className="rp-fixture" role="note">
                <span className="rp-fixture-tag">FIXTURE DATA</span> synthetic, not historical
                {fixtureLayers.length > 0 && <span className="rp-fixture-layers">: {fixtureLayers.join(", ")}</span>}
              </p>
            )}
          </div>
          <div className="rp-perimeter-badge">
            {perimeter ? (
              <>
                <span className="rp-perimeter-dot" aria-hidden="true" />
                <span>
                  Perimeter observed <strong>{formatAge(simTimeMs - perimeter.atMs)} ago</strong> ·{" "}
                  {PERIMETER_PROVENANCE[perimeter.evidenceClass]}
                  {perimeter.areaKm2 != null && <> · {perimeter.areaKm2.toFixed(0)} km²</>}
                  {perimeter.timePrecision && <> · ± {perimeter.timePrecision.replace(/_/g, " ")}</>}
                  {nextPerimeter && (
                    <span className="rp-dim"> · next snapshot in {formatAge(nextPerimeter.atMs - simTimeMs)}</span>
                  )}
                </span>
              </>
            ) : model.perimeters.length > 0 ? (
              <span>
                No perimeter observed yet · first satellite snapshot in{" "}
                <strong>{formatAge(model.perimeters[0].atMs - simTimeMs)}</strong>
                {simFrontIndex >= 0 && visibility.simFire && (
                  <span className="rp-sim-note"> · glowing area is the model fire (assumed ignition)</span>
                )}
              </span>
            ) : (
              <span>No fire perimeters in this bundle</span>
            )}
          </div>
          <div className="rp-basemap">
            <div className="rp-speed" role="group" aria-label="Basemap">
              {(["dark", "satellite"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="rp-speed-btn"
                  aria-pressed={basemap === option}
                  onClick={() => setBasemap(option)}
                >
                  {option === "dark" ? "Dark" : "Satellite"}
                </button>
              ))}
            </div>
            {basemap === "satellite" && <span className="rp-imagery-note">{IMAGERY_DATE_NOTE}</span>}
          </div>
          <MapLegend windFromDeg={model.fireSimulated?.windFromDeg ?? null} />
        </div>

        <TimelineDock
          simTimeMs={simTimeMs}
          startMs={startMs}
          endMs={endMs}
          stepSeconds={model.clock.stepSeconds}
          timezone={model.incident.timezone}
          events={model.events}
          playing={playing}
          speed={speed}
          onTogglePlay={togglePlay}
          onSeek={seekAndPause}
          onStep={(d) => step(d)}
          onReset={reset}
          onSpeed={setSpeed}
          stepLabel="10 minutes"
        />
      </div>

      <aside className="rp-panel" aria-label="Replay details" id="rp-panel">
        <div className="rp-panel-top">
          <span className="rp-route-links">
            <a className="rp-back" href="/">
              ← Workspace
            </a>
            <a className="rp-back" href={config.otherRoute.href}>
              {config.otherRoute.label}
            </a>
          </span>
          <button
            type="button"
            className="rp-btn rp-panel-toggle"
            aria-expanded={panelOpen}
            aria-controls="rp-panel-content"
            onClick={() => setPanelOpen((o) => !o)}
            title={panelOpen ? "Collapse panel" : "Expand panel"}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d={panelOpen ? "M6 3l5 5-5 5" : "M10 3 5 8l5 5"} />
            </svg>
            <span className="rp-sr">{panelOpen ? "Collapse panel" : "Expand panel"}</span>
          </button>
        </div>
        <div id="rp-panel-content" hidden={!panelOpen}>
          <SidePanel
            model={model}
            frameIndex={frameIndex}
            eventIndex={eventIndex}
            simTimeMs={simTimeMs}
            visibility={visibility}
            perParticle={perParticle}
            onToggleLayer={toggleLayer}
            onSeek={seekAndPause}
            tab={tab}
            onTab={setTab}
            pin={pin}
            onPin={setPin}
            onFocus={focusTarget}
            eyebrow={config.eyebrow}
            extraTabs={extraTabs}
          />
        </div>
      </aside>
    </main>
  );
}
