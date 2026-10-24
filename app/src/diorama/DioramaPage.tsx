import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createScenario } from "./scenario";
import { DioramaScene } from "./scene/DioramaScene";
import type { PickTarget } from "./types";
import { WORLD } from "./world";
import Caption from "./ui/Caption";
import Counters from "./ui/Counters";
import { formatCount, phaseAt, useMediaQuery } from "./ui/format";
import Legend from "./ui/Legend";
import PickLabel from "./ui/PickLabel";
import PlaybackDock from "./ui/PlaybackDock";
import RecapCard, { useCountdown } from "./ui/RecapCard";
import { usePlayback } from "./ui/usePlayback";
import "./diorama.css";

/** Seconds the recap stays up before the ~90 s loop restarts on its own. */
const RECAP_AUTO_RESTART_S = 8;
/** The legend starts expanded only where the sidebar and a wide stage leave room for it. */
const WIDE_QUERY = "(min-width: 1680px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type SceneStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/** Elements whose own Space handling must win over the global play/pause shortcut. */
const SPACE_OWNERS = "button, a[href], select, textarea, summary, [contenteditable], input:not([type='range'])";

export default function DioramaPage() {
  // Scenario data is deterministic and built once; scene rendering and playback stay separate.
  const scenario = useMemo(() => createScenario(WORLD), []);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<DioramaScene | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  const [status, setStatus] = useState<SceneStatus>({ kind: "loading" });
  const [pick, setPick] = useState<PickTarget | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  // Imperative per-frame path: clock → scenario.sample → scene.update, with no React render.
  const onTime = useCallback((t: number) => sceneRef.current?.update(scenario.sample(t)), [scenario]);
  const playback = usePlayback({ duration: scenario.duration, autoPlay: true, onTime });
  const { getTime } = playback;

  // Throttled React path: overlays read a snapshot of the ~10 Hz clock copy.
  const snapshot = useMemo(() => scenario.sample(playback.t), [scenario, playback.t]);

  useEffect(() => {
    const host = sceneHostRef.current;
    if (!host) return;
    let scene: DioramaScene;
    try {
      scene = new DioramaScene(host, WORLD, scenario.fire, { reducedMotion: reducedMotionRef.current });
    } catch (error) {
      console.error("Diorama scene could not start", error);
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "WebGL could not be initialised.",
      });
      return;
    }
    sceneRef.current = scene;
    scene.onPick(setPick);
    scene.update(scenario.sample(getTime()));
    setStatus({ kind: "ready" });
    return () => {
      sceneRef.current = null;
      scene.dispose();
      setPick(null);
    };
  }, [scenario, getTime]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    sceneRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  // Frame the board inside the part of the stage the floating overlay leaves uncovered.
  useEffect(() => {
    const stage = stageRef.current;
    const overlay = stage?.querySelector<HTMLElement>(".dio-overlay");
    const scene = sceneRef.current;
    if (!stage || !overlay || !scene || status.kind !== "ready") return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      let top = 0;
      let bottom = 0;
      for (const child of Array.from(overlay.children)) {
        const r = child.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.top + r.height / 2 < middle) top = Math.max(top, r.bottom - box.top);
        else bottom = Math.max(bottom, box.bottom - r.top);
      }
      scene.setViewInsets({ top, right: 0, bottom, left: 0 });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    for (const child of Array.from(overlay.children)) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [status.kind]);

  const project = useCallback((target: PickTarget) => sceneRef.current?.project(target) ?? null, []);
  const resetView = useCallback(() => sceneRef.current?.resetView(), []);

  // Recap and loop: at the end, show the recap and restart after a pause unless the viewer
  // has engaged with it (then wait for Replay).
  const [recapDismissed, setRecapDismissed] = useState(false);
  const [recapHeld, setRecapHeld] = useState(false);
  const { ended, restart, toggle } = playback;
  if (!ended && (recapDismissed || recapHeld)) {
    setRecapDismissed(false);
    setRecapHeld(false);
  }
  const showRecap = ended && !recapDismissed;
  const autoRestartIn = useCountdown(showRecap && !recapHeld, RECAP_AUTO_RESTART_S, restart);
  const holdRecap = useCallback(() => setRecapHeld(true), []);
  const dismissRecap = useCallback(() => setRecapDismissed(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === " " || event.code === "Space") {
        if (target?.closest(SPACE_OWNERS)) return;
        event.preventDefault();
        toggle();
      } else if (event.key === "Escape") {
        if (pick) setPick(null);
        else if (showRecap) setRecapDismissed(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, pick, showRecap]);

  const phase = phaseAt(scenario.phases, snapshot.phase);
  const description = pick ? scenario.describe(pick, snapshot) : null;
  const finalCounters = snapshot.counters;
  const recapSummary =
    `${formatCount(finalCounters.sheltered)} of ${formatCount(finalCounters.population)} simulated residents ` +
    `reached ${WORLD.shelter.label}; ${formatCount(finalCounters.crewsDeployed)} of ` +
    `${formatCount(finalCounters.crewsTotal)} fire crews were deployed in this scripted run.`;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="dio-page"
      data-reduced-motion={reducedMotion ? "true" : undefined}
      aria-label="Larkspur Hollow wildfire evacuation diorama"
    >
      <div className="dio-stage" ref={stageRef}>
        <div className="dio-scene" ref={sceneHostRef} aria-hidden={status.kind === "error"} />

        {status.kind === "loading" && (
          <div className="dio-veil" role="status">
            <span className="dio-veil-dot" aria-hidden="true" />
            Building the miniature…
          </div>
        )}

        {status.kind === "error" && (
          <div className="dio-error dio-panel" role="alert">
            <p className="dio-error-title">3D view unavailable in this browser</p>
            <p>
              The diorama needs WebGL, which appears to be disabled or unsupported here. The scripted captions,
              counters and timeline below still play.
            </p>
            <p className="dio-error-detail">{status.message}</p>
          </div>
        )}

        <div className="dio-overlay">
          <header className="dio-title dio-panel">
            <h1>Larkspur Hollow · Wildfire evacuation</h1>
            <div className="dio-disclaimer">
              <span className="dio-chip">Fictional scenario · Synthetic data · Visual demonstration</span>
              <button
                type="button"
                className="dio-disclaimer-more"
                aria-expanded={noteOpen}
                aria-controls="dio-disclaimer-note"
                aria-label="About this visualization"
                onClick={() => setNoteOpen((open) => !open)}
              >
                i
              </button>
            </div>
            <p id="dio-disclaimer-note" className="dio-disclaimer-note" data-open={noteOpen}>
              Scripted visualization, not a validated fire model or operational guidance.
            </p>
          </header>

          <Counters counters={snapshot.counters} />

          <Caption phaseLabel={phase?.label ?? ""} caption={snapshot.caption} reducedMotion={reducedMotion} />

          <Legend world={WORLD} defaultOpen={wide} />

          <PlaybackDock
            playback={playback}
            duration={scenario.duration}
            phases={scenario.phases}
            currentPhase={snapshot.phase}
            onResetView={resetView}
            resetViewDisabled={status.kind !== "ready"}
          />
        </div>

        {pick && description && status.kind === "ready" && (
          <PickLabel
            target={pick}
            title={description.title}
            lines={description.lines}
            project={project}
            stageRef={stageRef}
            onClose={() => setPick(null)}
          />
        )}

        {showRecap && (
          <div className="dio-recap-layer">
            <RecapCard
              items={scenario.recap}
              summary={recapSummary}
              autoRestartIn={autoRestartIn}
              onReplay={restart}
              onExplore={dismissRecap}
              onInteract={holdRecap}
            />
          </div>
        )}
      </div>
    </main>
  );
}
