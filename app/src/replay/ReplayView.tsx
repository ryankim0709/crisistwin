import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { groupAvailability } from "./layerGroups";
import CompareTab, { CaveatChip } from "./CompareTab";
import { BundleMissingError, REPLAY_VIEW, fetchReplayBundle, type ViewConfig } from "./loadBundle";
import RespondersTab from "./RespondersTab";
import StressTab from "./StressTab";
import StoryMode, { StoryLanding, storySeconds, storyTitle } from "./StoryMode";
import { buildChapters, revealRows } from "./story";
import Tour from "./Tour";
import ValidationTab from "./ValidationTab";
import { homeCoords, referencePlace } from "./places";
import { markTourSeen, replayTour, simulationTour, tourSeen } from "./tourSteps";
import { useVariants } from "./useVariants";
import type { Map as MapLibreMap } from "maplibre-gl";
import MobilityOverlay from "./MobilityOverlay";
import MobilityTab from "./MobilityTab";
import { mobilityUrlFor } from "./mobility";
import { useMobility } from "./useMobility";
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
  ignitionBasis,
  incidentYear,
  observationSource,
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

// Large bundles (Kincade is ~40 MB) need longer than the default fetch window.
const LOAD_TIMEOUT_MS = 90_000;
const fmtN = (n: number) => n.toLocaleString("en-US");
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

export default function ReplayView({
  config = REPLAY_VIEW,
  picker,
  switcher,
  nextFire,
}: {
  config?: ViewConfig;
  picker?: ReactNode;
  /** Fire switcher shown on the map, visible whether or not the panel is collapsed. */
  switcher?: ReactNode;
  /** The next fire's name and a callback that opens it straight into its story. */
  nextFire?: { label: string; open: () => void } | null;
}) {
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
            message:
              error instanceof Error ? error.message : "The replay bundle could not be loaded.",
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

  if (load.status === "ready")
    return (
      <ReplayScreen model={load.model} config={config} picker={picker} switcher={switcher} nextFire={nextFire ?? null} />
    );

  const sim = config.kind === "simulation";
  return (
    <main className={`rp-root rp-root--state${sim ? " rp-root--sim" : ""}`}>
      <div className="rp-state-card">
        <a className="rp-back" href="/">
          ← Workspace
        </a>
        <p className="rp-eyebrow">{config.eyebrow}</p>
        {picker}
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

// Default view: four layers (perimeter, model fire, roads/traffic, vehicle dots); the rest are toggles.
const DEFAULT_OFF: LayerGroup[] = ["damage", "zones", "history", "destinations", "fireObs"];

function initialVisibility(model: ReplayModel): Record<LayerGroup, boolean> {
  const out = {} as Record<LayerGroup, boolean>;
  for (const group of Object.keys(LAYER_GROUPS) as LayerGroup[]) {
    // Off by default: damage (a post-fire assessment, auto-shown at the end) and the
    // synthetic zone grid (orders flash briefly on the map instead).
    out[group] = !DEFAULT_OFF.includes(group) && groupAvailability(model, group).available;
  }
  return out;
}

const LINKABLE_TABS: readonly PanelTab[] = [
  "overview",
  "responder",
  "evacuee",
  "explain",
  "whatif",
  "validation",
  "stress",
  "responders",
  "movement",
];

/** Deep link ?tab=<id>; null for absent or unknown values. */
function tabFromUrl(): PanelTab | null {
  try {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return LINKABLE_TABS.find((t) => t === tab) ?? null;
  } catch {
    return null;
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // The timeline slider, checkboxes and radios are not text entry: Space still plays/pauses.
  if (target instanceof HTMLInputElement)
    return !["range", "checkbox", "radio", "button"].includes(target.type);
  return ["SELECT", "TEXTAREA"].includes(target.tagName);
}

function ReplayScreen({
  model: baseline,
  config,
  picker,
  switcher,
  nextFire,
}: {
  model: ReplayModel;
  config: ViewConfig;
  picker?: ReactNode;
  switcher?: ReactNode;
  nextFire: { label: string; open: () => void } | null;
}) {
  const variants = useVariants(baseline, config.variantsUrl);
  const model = variants.shown?.model ?? baseline;
  const selectVariant = variants.select;
  // Where "fire N km from X" is measured and what the camera opens on; derived per bundle.
  const place = useMemo(() => referencePlace(baseline, config.place), [baseline, config.place]);
  const home = useMemo(() => homeCoords(baseline, place), [baseline, place]);
  const tourSteps = useMemo(
    () =>
      config.kind === "simulation" ? simulationTour(baseline, place) : replayTour(baseline, place),
    [baseline, place, config.kind],
  );
  const { startMs, endMs } = model.clock;
  const [simTimeMs, setSimTimeMs] = useState(startMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  // The story landing keeps the map clear; deep links and the simulation open the panel.
  const [panelOpen, setPanelOpen] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return config.kind !== "replay" || q.has("tab") || q.has("variant");
  });
  const [visibility, setVisibility] = useState(() => initialVisibility(baseline));
  const [perParticle, setPerParticle] = useState<number | null>(null);
  const [tab, setTab] = useState<PanelTab>(() => tabFromUrl() ?? "overview");
  // Deep link ?variant=<id>: select it once the what-if index has loaded; unknown ids are ignored.
  const linkedVariant = useRef(new URLSearchParams(window.location.search).get("variant"));
  const selectLinked = variants.select;
  useEffect(() => {
    const id = linkedVariant.current;
    if (!id || !variants.index) return;
    linkedVariant.current = null;
    if (variants.index.variants.some((v) => v.id === id)) selectLinked(id);
  }, [variants.index, selectLinked]);
  const [statusOpen, setStatusOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  // Replay opens on the story title card; the tour is optional (Tour button). Deep links
  // (?tab=, ?variant=) skip the card; ?story=1 starts the story at once.
  const [tourOpen, setTourOpen] = useState(() => config.kind === "simulation" && !tourSeen(config.kind));
  const [landing, setLanding] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return config.kind === "replay" && !q.has("tab") && !q.has("variant") && q.get("story") !== "1";
  });
  const autoStory = useRef(config.kind === "replay" && new URLSearchParams(window.location.search).get("story") === "1");
  const closeTour = useCallback(() => {
    markTourSeen(config.kind);
    setTourOpen(false);
  }, [config.kind]);
  const [basemap, setBasemap] = useState<Basemap>("dark");
  const [pin, setPin] = useState<LngLat | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [storyOpen, setStoryOpen] = useState(false);
  // Optional phone-panel mobility sidecar (replay route only); hidden when the file is absent.
  const mobility = useMobility(config.kind === "replay" ? mobilityUrlFor(config.bundleUrl) : null);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [mobilityVisible, setMobilityVisible] = useState(true);
  const [mobilityFlows, setMobilityFlows] = useState(false);
  const mobilityOrigin = useMemo<LngLat>(() => {
    const [w, s, e, n] = baseline.bbox;
    return place?.coord ?? [(w + e) / 2, (s + n) / 2];
  }, [baseline, place]);
  const timeRef = useRef(startMs);
  /** Story mode: playback stops at this sim time and then calls arriveRef. */
  const stopAtRef = useRef<number | null>(null);
  const arriveRef = useRef<(() => void) | null>(null);
  const focusTarget = useCallback((coords: LngLat[], padding?: MapFocus["padding"]) => {
    setFocus((prev) => ({ key: (prev?.key ?? 0) + 1, coords, padding }));
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const t = clampTime(model, ms);
      timeRef.current = t;
      setSimTimeMs(t);
      // Any manual seek cancels a story run-to.
      stopAtRef.current = null;
      arriveRef.current = null;
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
      const limit = Math.min(endMs, stopAtRef.current ?? endMs);
      const next = Math.min(limit, timeRef.current + dt * speed * 1000);
      timeRef.current = next;
      setSimTimeMs(next);
      if (next >= limit) {
        setPlaying(false);
        const arrive = arriveRef.current;
        stopAtRef.current = null;
        arriveRef.current = null;
        arrive?.();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, endMs]);

  // Story mode owns the clock while open: Pause stops the clock, any run-in and the story's
  // auto-advance together; Play resumes the story from its current chapter.
  const [storyPaused, setStoryPaused] = useState(false);
  const [storyResume, setStoryResume] = useState(0);
  const toggleStoryPause = useCallback(() => {
    if (storyPaused) {
      setStoryPaused(false);
      setStoryResume((k) => k + 1);
      return;
    }
    setStoryPaused(true);
    stopAtRef.current = null;
    arriveRef.current = null;
    setPlaying(false);
  }, [storyPaused]);

  const togglePlay = useCallback(() => {
    if (storyOpen) {
      toggleStoryPause();
      return;
    }
    if (!playing && timeRef.current >= endMs) seek(startMs);
    stopAtRef.current = null;
    arriveRef.current = null;
    setPlaying((p) => !p);
  }, [storyOpen, toggleStoryPause, playing, endMs, startMs, seek]);

  const playTo = useCallback(
    (ms: number, rate: number, onArrive: () => void) => {
      seek(timeRef.current);
      stopAtRef.current = clampTime(model, ms);
      arriveRef.current = onArrive;
      setSpeed(rate);
      setPlaying(true);
    },
    [model, seek],
  );

  // What-ifs are only comparable with this replay when they were run on the same demand.
  const variantDemand = variants.index?.demandTotalVeh ?? null;
  const baselineDemand = baseline.traffic?.totalVeh ?? null;
  const variantsStale =
    variantDemand !== null && baselineDemand !== null && variantDemand !== baselineDemand;
  const usableIndex = variantsStale ? null : variants.index;
  const chapters = useMemo(
    () => buildChapters(baseline, usableIndex, place),
    [baseline, usableIndex, place],
  );
  const reveal = useMemo(() => (usableIndex ? revealRows(usableIndex) : []), [usableIndex]);
  const startStory = useCallback(() => {
    markTourSeen(config.kind);
    setTourOpen(false);
    selectVariant(null);
    setTab("overview");
    setLanding(false);
    // The map is the hero: panel collapsed, people layer on for the prologue.
    setPanelOpen(false);
    setVisibility((v) => ({ ...v, people: true }));
    setStoryPaused(false);
    setStoryOpen(true);
  }, [config.kind, selectVariant]);
  // ?story=1 (from "Watch another fire"): start the story once chapters exist, then drop the flag.
  useEffect(() => {
    if (!autoStory.current || chapters.length === 0) return;
    // Flip the flag only when the start actually runs (StrictMode re-runs effects).
    const timer = window.setTimeout(() => {
      autoStory.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete("story");
      window.history.replaceState(null, "", url);
      startStory();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [chapters.length, startStory]);
  const exploreFire = useCallback(() => {
    setLanding(false);
    setPanelOpen(true);
  }, []);
  const closeStory = useCallback(() => {
    setPanelOpen(true);
    setStoryOpen(false);
    setStoryPaused(false);
    stopAtRef.current = null;
    arriveRef.current = null;
    setPlaying(false);
    setSpeed(DEFAULT_SPEED);
  }, []);
  const peakExposureMs = useMemo(
    () => chapters.find((c) => c.id === "peak-exposure")?.atMs ?? null,
    [chapters],
  );
  const showVariantFromStory = useCallback(
    (id: string) => {
      closeStory();
      selectVariant(id);
      setTab("whatif");
      setPanelOpen(true);
      if (peakExposureMs !== null) seek(peakExposureMs);
    },
    [closeStory, selectVariant, peakExposureMs, seek],
  );

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
      // Space always toggles play/pause, also while a button has focus (a clicked speed or story
      // button keeps focus, and Space used to re-press it instead of pausing). Dialog buttons
      // (tour) keep native Space; Enter still activates any focused button.
      const inDialog = event.target instanceof Element && event.target.closest(".rp-tour");
      if (event.key === " " && !inDialog && !(event.target instanceof HTMLSelectElement)) {
        event.preventDefault();
        if (!event.repeat) togglePlay();
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        // Arrow keys pan the map when it has focus, and move between radio options.
        !(event.target instanceof Element && event.target.closest(".maplibregl-map")) &&
        !(event.target instanceof HTMLInputElement && event.target.type !== "range")
      ) {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey ? BIG_STEP_SECONDS : STEP_SECONDS);
      } else if (event.key === "Home") {
        event.preventDefault();
        reset();
      }
    };
    // Button activation by Space happens on keyup; suppress it where keydown already toggled.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== " " || isTextEntry(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".rp-tour")) return;
      if (event.target instanceof HTMLButtonElement) event.preventDefault();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
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
  const derivedDemand =
    !fixture && model.demand !== null && model.layerStatus.zones?.evidenceClass === "derived";
  const fixtureLayers = Object.entries(model.layerStatus)
    .filter(([, s]) => s.status === "fixture")
    .map(([name]) => FIXTURE_LAYER_LABEL[name] ?? name.replace(/_/g, " "));

  const sim = config.kind === "simulation";
  const extraTabs = [
    ...(variants.index && variantsStale
      ? [
          {
            id: "whatif" as const,
            label: "What if…",
            content: (
              <div className="rp-tab">
                <p className="rp-empty" role="note">
                  The what-if runs on disk were made with a different demand (
                  {variantDemand?.toLocaleString("en-US")} vehicles) than this replay (
                  {baselineDemand?.toLocaleString("en-US")} vehicles), so they are not comparable
                  and are hidden until they are regenerated.
                </p>
              </div>
            ),
          },
        ]
      : variants.index
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
    ...(baseline.validation
      ? [
          {
            id: "validation" as const,
            label: `Model vs ${incidentYear(baseline)}`,
            content: (
              <ValidationTab
                validation={baseline.validation}
                year={incidentYear(baseline)}
                fire={baseline.fireSimulated}
                observationSource={observationSource(baseline)}
              />
            ),
          },
        ]
      : []),
    ...(sim && model.responders
      ? [
          {
            id: "responders" as const,
            label: `Responders vs ${incidentYear(baseline)}`,
            content: <RespondersTab responders={model.responders} />,
          },
        ]
      : []),
    ...(config.stressUrl
      ? [
          {
            id: "stress" as const,
            label: "Stress test",
            content: <StressTab url={config.stressUrl} />,
          },
        ]
      : []),
    ...(mobility.status !== "missing"
      ? [
          {
            id: "movement" as const,
            label: "Movement",
            content: (
              <MobilityTab
                state={mobility}
                simTimeMs={simTimeMs}
                clockStartMs={startMs}
                clockEndMs={endMs}
                visible={mobilityVisible}
                onVisible={setMobilityVisible}
                showFlows={mobilityFlows}
                onShowFlows={setMobilityFlows}
                onSeek={seekAndPause}
                onFocus={focusTarget}
              />
            ),
          },
        ]
      : []),
  ];
  // The Movement tab disappears if its file turns out to be absent; fall back to Overview.
  const panelTab: PanelTab = tab === "movement" && mobility.status === "missing" ? "overview" : tab;
  const caption = buildCaption(model, simTimeMs, frameIndex, place);
  // While a what-if is on the map, set it against the baseline at the same clock time.
  const baselineFrame = variants.shown ? frameIndexAt(baseline, simTimeMs) : -1;
  const variantDelta =
    variants.shown && baselineFrame >= 0 && frameIndex >= 0 && model.traffic && baseline.traffic
      ? {
          variant: model.traffic.metrics[frameIndex]?.exposedVeh ?? 0,
          baseline: baseline.traffic.metrics[baselineFrame]?.exposedVeh ?? 0,
        }
      : null;
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
      }${storyOpen || landing ? " rp-root--story" : ""}`}
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
          animate={playing}
          pin={tab === "evacuee" ? pin : null}
          onPick={tab === "evacuee" ? setPin : null}
          focus={focus}
          basemapChoice={basemap}
          home={home}
          onMapReady={setMapInstance}
        />

        <MobilityOverlay
          map={mapInstance}
          mobility={mobility.data}
          simTimeMs={simTimeMs}
          visible={mobilityVisible}
          showFlows={mobilityFlows}
          origin={mobilityOrigin}
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
          {switcher}
          <div className="rp-status">
            {/* One muted status line; details (evidence, demand, fire model) open below it. */}
            <button
              type="button"
              className="rp-statusline"
              aria-expanded={statusOpen}
              aria-controls="rp-status-details"
              onClick={() => setStatusOpen((o) => !o)}
            >
              <span className="rp-status-chip">
                {sim ? "Agent simulation" : "Retrospective · modelled traffic"}
              </span>
              {variants.shown && (
                <span className="rp-status-chip">What-if: {variants.shown.title}</span>
              )}
              {fixture && <span className="rp-fixture-tag">FIXTURE DEMAND</span>}
              {derivedDemand && <span className="rp-status-text">Census demand (derived)</span>}
              <span className="rp-status-text">
                {perimeter ? (
                  <>
                    Satellite perimeter from{" "}
                    <strong>{formatAge(simTimeMs - perimeter.atMs)}</strong> ago
                  </>
                ) : model.perimeters.length > 0 ? (
                  <>
                    {simFrontIndex >= 0 && visibility.simFire ? "Model fire" : "No perimeter"} until
                    satellite perimeter in{" "}
                    <strong>{formatAge(model.perimeters[0].atMs - simTimeMs)}</strong>
                  </>
                ) : (
                  "No satellite perimeter in this bundle"
                )}
              </span>
              <span className="rp-status-more">{statusOpen ? "Hide ▴" : "Details ▾"}</span>
            </button>
            <div id="rp-status-details" className="rp-banners" hidden={!statusOpen}>
              {sim ? (
                <p className="rp-banner" role="note">
                  <strong>Agent simulation</strong> — modelled residents and responders; not a
                  historical replay.
                </p>
              ) : (
                <p className="rp-banner" role="note">
                  <strong>Retrospective reconstruction</strong> — simulated traffic, not recorded
                  vehicle movement. Planning experiment only.
                </p>
              )}
              {variants.shown && (
                <p className="rp-banner" role="note">
                  <strong>What-if: {variants.shown.title}</strong> — simulated counterfactual
                  traffic; fire perimeters and other evidence unchanged.
                </p>
              )}
              <p className="rp-banner" role="note">
                <strong>Fire</strong> —{" "}
                {perimeter ? (
                  <>
                    satellite perimeter in effect ({PERIMETER_PROVENANCE[perimeter.evidenceClass]}
                    {perimeter.areaKm2 != null && <>, {perimeter.areaKm2.toFixed(0)} km²</>}
                    {perimeter.timePrecision && (
                      <>, ± {perimeter.timePrecision.replace(/_/g, " ")}</>
                    )}
                    )
                    {nextPerimeter && (
                      <>; next snapshot in {formatAge(nextPerimeter.atMs - simTimeMs)}</>
                    )}
                    .
                  </>
                ) : (
                  <>
                    before the first satellite perimeter the orange area is a fire-spread model from
                    the {ignitionBasis(model)} ignition, not an observation.
                  </>
                )}{" "}
                {model.fireSimulated?.constraintNote}
                {model.fireSimulated &&
                  " How well the model matches the record: see the Model vs tab."}
              </p>
              {derivedDemand && model.demand && (
                <p className="rp-banner" role="note">
                  <strong>Demand (derived)</strong> —{" "}
                  {[
                    model.demand.population != null && `${fmtN(model.demand.population)} people`,
                    model.demand.households != null &&
                      `${fmtN(model.demand.households)} households` +
                        (model.demand.householdsNoVehicle != null
                          ? ` (${fmtN(model.demand.householdsNoVehicle)} without a vehicle)`
                          : ""),
                    model.demand.blockGroups != null &&
                      `${fmtN(model.demand.blockGroups)} Census block groups`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {model.demand.evacuatingVehicles != null && (
                    <>
                      {" "}
                      → {fmtN(model.demand.evacuatingVehicles)} evacuating vehicles
                      {model.demand.evacuatingVehiclesMoe != null && (
                        <> (± {fmtN(model.demand.evacuatingVehiclesMoe)})</>
                      )}
                    </>
                  )}
                  . Evacuation orders and warnings are historical records, mapped to block groups
                  through a crosswalk with stated confidence.
                </p>
              )}
              {fixture && (
                <p className="rp-fixture" role="note">
                  <span className="rp-fixture-tag">FIXTURE DATA</span> synthetic, not historical
                  {fixtureLayers.length > 0 && (
                    <span className="rp-fixture-layers">: {fixtureLayers.join(", ")}</span>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="rp-basemap">
            {chapters.length > 0 && (
              <button
                type="button"
                className="rp-story-open"
                aria-pressed={storyOpen}
                onClick={storyOpen ? closeStory : startStory}
              >
                <span aria-hidden="true">{storyOpen ? "■" : "▶"}</span>{" "}
                {storyOpen ? "Stop story" : "Play the story"}
              </button>
            )}
            <button
              type="button"
              className="rp-tour-open"
              onClick={() => {
                closeStory();
                setTab("overview");
                setTourOpen(true);
              }}
            >
              <span aria-hidden="true">?</span> Tour
            </button>
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
            {basemap === "satellite" && (
              <span className="rp-imagery-note">{IMAGERY_DATE_NOTE}</span>
            )}
          </div>
          <MapLegend
            windFromDeg={model.fireSimulated?.windFromDeg ?? null}
            fireObsSource={model.fireObservations ? observationSource(model) : null}
            showFireObs={visibility.fireObs}
            showDestinations={visibility.destinations}
            peopleSource={visibility.people ? `Census ${incidentYear(model)} ACS; departures modelled` : null}
            open={legendOpen || tourOpen}
            onToggle={() => setLegendOpen((o) => !o)}
          />
        </div>

        {variantDelta && variants.shown && (
          <p className="rp-delta-pill" role="status">
            <span className="rp-status-chip rp-status-chip--variant">WHAT-IF · SIMULATED</span>
            <span>
              <strong>{variants.shown.title}:</strong>{" "}
              <strong className="rp-delta-pill-num">
                {variantDelta.variant.toLocaleString("en-US")}
              </strong>{" "}
              vehicles on roads inside the fire now, vs{" "}
              <strong className="rp-delta-pill-base">
                {variantDelta.baseline.toLocaleString("en-US")}
              </strong>{" "}
              in the baseline run
            </span>
            <CaveatChip id={variants.shown.id} />
          </p>
        )}

        {landing && !storyOpen && chapters.length > 0 && (
          <StoryLanding
            title={storyTitle(model)}
            chapters={chapters.length}
            seconds={storySeconds(chapters.length)}
            onPlay={startStory}
            onExplore={exploreFire}
          />
        )}

        {storyOpen && (
          <StoryMode
            chapters={chapters}
            revealRows={reveal}
            simTimeMs={simTimeMs}
            timezone={model.incident.timezone}
            metrics={
              model.traffic && frameIndex >= 0 ? (model.traffic.metrics[frameIndex] ?? null) : null
            }
            trafficEvidence={model.traffic?.evidenceClass ?? null}
            demandLabel={
              fixture ? "FIXTURE DEMAND" : derivedDemand ? "CENSUS DEMAND (DERIVED)" : null
            }
            playTo={playTo}
            seek={seek}
            focus={focusTarget}
            onShowVariant={showVariantFromStory}
            onClose={closeStory}
            nextFire={nextFire}
            paused={storyPaused}
            onTogglePause={togglePlay}
            resumeKey={storyResume}
          />
        )}

        <TimelineDock
          simTimeMs={simTimeMs}
          startMs={startMs}
          endMs={endMs}
          stepSeconds={model.clock.stepSeconds}
          timezone={model.incident.timezone}
          events={model.events}
          // In story mode the story is "playing" while it auto-advances, even during a chapter hold.
          playing={playing || (storyOpen && !storyPaused)}
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
            tab={panelTab}
            onTab={setTab}
            pin={pin}
            onPin={setPin}
            onFocus={focusTarget}
            eyebrow={config.eyebrow}
            picker={picker}
            extraTabs={extraTabs}
            showResidents={sim}
          />
        </div>
      </aside>
      {tourOpen && (
        <Tour
          steps={tourSteps}
          onSeek={seekAndPause}
          onClose={closeTour}
          onStory={chapters.length > 0 ? startStory : undefined}
        />
      )}
    </main>
  );
}
