import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoPoint } from "../fire/spread";
import { formatElapsed } from "../fire/spread";
import ConfigPanel from "./ConfigPanel";
import PlaybackBar from "./PlaybackBar";
import StudioMap from "./StudioMap";
import {
  MAX_ENABLED_IGNITIONS,
  type IgnitionDisplayState,
  type MapMode,
  type ScenarioIssue,
  type ScheduledIgnition,
  type StudioScenario,
} from "./contracts";
import { demoScenario } from "./demo";
import {
  clearDraft,
  draftStatusText,
  exportScenarioJson,
  loadDraft,
  saveDraft,
} from "./draft";
import {
  createIgnition,
  emptyScenario,
  parseScenario,
  solverInputChanged,
  validateScenario,
} from "./scenario";
import { useStudioRun } from "./useStudioRun";
import "./studio.css";

const SPEED_CHOICES = [1, 5, 10, 30, 60] as const;
const DEFAULT_SPEED = 10;
const AUTOSAVE_DELAY_MS = 600;
const NOTICE_MS = 4000;
const MAX_IMPORT_CHARACTERS = 1_000_000;
const METERS_PER_FOOT = 0.3048;
/**
 * Surface head-rate bands for the per-fire description, metres per minute. These are display
 * labels over modelled output, not model inputs: under 1 m/min a fire creeps (litter beneath
 * canopy, typically a few cells per hour at 24 m resolution); 1 to 10 m/min is typical shrub
 * or light grass behaviour; over 10 m/min is rapid (wind-driven grass).
 */
const SLOW_HEAD_RATE_METERS_PER_MINUTE = 1;
const FAST_HEAD_RATE_METERS_PER_MINUTE = 10;
/** Below this total reached area at the horizon, warn that modelled spread is small. */
const SMALL_SPREAD_HECTARES = 5;
const SQUARE_METERS_PER_HECTARE = 10_000;
const OPERATIONAL_DISCLAIMER = "Planning experiment; not an operational forecast.";

/** Index of the last frame at or before `minute`. */
function frameIndexAt(frameMinutes: readonly number[], minute: number): number {
  let index = 0;
  for (let i = 0; i < frameMinutes.length; i += 1) {
    if (frameMinutes[i] <= minute) index = i;
    else break;
  }
  return index;
}

function downloadJson(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function SimulationStudioPage() {
  const [initialDraft] = useState(loadDraft);
  const [scenario, setScenario] = useState<StudioScenario>(
    () => initialDraft?.scenario ?? emptyScenario(),
  );
  const [savedAt, setSavedAt] = useState<Date | null>(initialDraft?.savedAt ?? null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>("select");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { state, run, cancel, markStale } = useStudioRun();
  const { result } = state;

  // Playback. `clockRef` is the smooth simulation clock; React state only changes when the
  // clock crosses into a new frame, so the map is not re-rendered on every animation tick.
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [frameIndex, setFrameIndex] = useState(0);
  const clockRef = useRef(0);
  const frameMinutes = useMemo(() => result?.frameMinutes ?? [], [result]);

  // A new result starts at T+0, paused. Adjusted during render rather than in an effect.
  const [playbackKey, setPlaybackKey] = useState<number | null>(null);
  const resultKey = result?.requestId ?? null;
  if (playbackKey !== resultKey) {
    setPlaybackKey(resultKey);
    setPlaying(false);
    setFrameIndex(0);
    clockRef.current = 0;
  }

  useEffect(() => {
    if (!playing || frameMinutes.length === 0) return;
    const end = frameMinutes[frameMinutes.length - 1];
    let handle = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsedSeconds = (now - last) / 1000;
      last = now;
      clockRef.current = Math.min(end, clockRef.current + elapsedSeconds * speed);
      setFrameIndex(frameIndexAt(frameMinutes, clockRef.current));
      if (clockRef.current >= end) {
        setPlaying(false);
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, speed, frameMinutes]);

  const seek = useCallback(
    (index: number) => {
      if (frameMinutes.length === 0) return;
      const clamped = Math.max(0, Math.min(frameMinutes.length - 1, index));
      clockRef.current = frameMinutes[clamped];
      setFrameIndex(clamped);
    },
    [frameMinutes],
  );

  const showNotice = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const handle = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(handle);
  }, [notice]);

  // Draft autosave, debounced; labelled "Saved on this device".
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const saved = saveDraft(scenario);
      setSaveFailed(saved === null);
      if (saved) setSavedAt(saved);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [scenario]);

  const issues = useMemo(() => validateScenario(scenario), [scenario]);

  /**
   * The one place a scenario edit lands. Edits that change the solver input pause playback and
   * mark the result stale (cancelling an in-flight run, whose result would no longer match);
   * names, selection, view and speed do not. An edit never starts a run.
   */
  const applyScenario = useCallback(
    (next: StudioScenario) => {
      if (solverInputChanged(scenario, next)) {
        setPlaying(false);
        cancel();
        markStale();
      }
      setScenario(next);
      const selectionSurvives =
        selectedId !== null && next.ignitions.some((ignition) => ignition.id === selectedId);
      if (!selectionSurvives) {
        setSelectedId(null);
        setMode((current) => (current === "move" ? "select" : current));
      }
    },
    [scenario, selectedId, cancel, markStale],
  );

  const updateIgnition = useCallback(
    (id: string, patch: Partial<ScheduledIgnition>) => {
      applyScenario({
        ...scenario,
        ignitions: scenario.ignitions.map((ignition) =>
          ignition.id === id ? { ...ignition, ...patch } : ignition,
        ),
      });
    },
    [scenario, applyScenario],
  );

  const handleMapClick = useCallback(
    (point: GeoPoint) => {
      if (mode === "add") {
        const enabledCount = scenario.ignitions.filter((ignition) => ignition.enabled).length;
        if (enabledCount >= MAX_ENABLED_IGNITIONS) {
          showNotice(
            `At most ${MAX_ENABLED_IGNITIONS} fires can be enabled. Disable or delete one to add another.`,
          );
          return;
        }
        const ignition = createIgnition(scenario.ignitions, point);
        applyScenario({ ...scenario, ignitions: [...scenario.ignitions, ignition] });
        setSelectedId(ignition.id);
      } else if (mode === "move" && selectedId) {
        updateIgnition(selectedId, { location: point });
        setMode("select");
      }
    },
    [mode, scenario, selectedId, applyScenario, updateIgnition, showNotice],
  );

  const handleImport = useCallback(
    (text: string): ScenarioIssue[] => {
      if (text.length > MAX_IMPORT_CHARACTERS) return [{ message: "The file is too large." }];
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return [{ message: "The file is not valid JSON." }];
      }
      const parsed = parseScenario(json);
      if (!parsed.scenario) return parsed.issues;
      const problems = validateScenario(parsed.scenario);
      if (problems.length > 0) return problems;
      applyScenario(parsed.scenario);
      setMode("select");
      return [];
    },
    [applyScenario],
  );

  const handleClear = useCallback(() => {
    clearDraft();
    setSavedAt(null);
    applyScenario(emptyScenario());
    setMode("select");
  }, [applyScenario]);

  const handleSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id === null) setMode((current) => (current === "move" ? "select" : current));
    },
    [],
  );

  const handleExport = useCallback(() => {
    try {
      downloadJson(`${scenario.name || "scenario"}.json`, exportScenarioJson(scenario));
    } catch (cause) {
      showNotice(
        `Could not export the scenario${cause instanceof Error ? `: ${cause.message}` : "."}`,
      );
    }
  }, [scenario, showNotice]);

  const handleRun = useCallback(() => {
    setPlaying(false);
    run(scenario);
  }, [run, scenario]);

  // ---- Derived display state -------------------------------------------------------------

  const stale = state.stale;
  const safeFrameIndex = Math.max(0, Math.min(frameIndex, frameMinutes.length - 1));
  const currentMinute = frameMinutes[safeFrameIndex] ?? 0;
  const running = state.phase === "loading-landscape" || state.phase === "computing";

  const problemIds = useMemo(
    () => new Set((state.error?.problems ?? []).map((problem) => problem.sourceId)),
    [state.error],
  );
  const issueIds = useMemo(
    () => new Set(issues.flatMap((issue) => (issue.ignitionId ? [issue.ignitionId] : []))),
    [issues],
  );

  /** States per the result at the current minute, regardless of staleness. */
  const resultStates = useMemo(() => {
    const states: Record<string, IgnitionDisplayState> = {};
    for (const entry of result?.run.ignitions ?? []) {
      if (entry.outcome.status === "ignited") {
        states[entry.sourceId] = entry.outcome.ignitedMinute <= currentMinute ? "triggered" : "scheduled";
      } else {
        states[entry.sourceId] =
          entry.outcome.reachedMinute <= currentMinute ? "reached-before-start" : "scheduled";
      }
    }
    return states;
  }, [result, currentMinute]);

  const ignitionStates = useMemo(() => {
    const states: Record<string, IgnitionDisplayState> = {};
    for (const ignition of scenario.ignitions) {
      if (!ignition.enabled) states[ignition.id] = "disabled";
      else if (issueIds.has(ignition.id) || problemIds.has(ignition.id)) states[ignition.id] = "invalid";
      else if (!result || stale) states[ignition.id] = "draft";
      else states[ignition.id] = resultStates[ignition.id] ?? "draft";
    }
    return states;
  }, [scenario.ignitions, issueIds, problemIds, result, stale, resultStates]);

  const visibleFrames = useMemo(
    () => (result ? result.run.frames.slice(0, safeFrameIndex + 1) : []),
    [result, safeFrameIndex],
  );

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (result) {
      const { run: solved } = result;
      if (solved.reachedEdgeMinute !== null && currentMinute >= solved.reachedEdgeMinute) {
        list.push(
          `Fire reached the edge of the modelled area at ${formatElapsed(solved.reachedEdgeMinute)}; the footprint after that is incomplete.`,
        );
      }
      if (!solved.crownFire.modelled) list.push(solved.crownFire.unavailableReason);
      if (!result.elevationComplete) {
        list.push("Elevation data was incomplete for part of the area, so slope is understated there.");
      }
      const horizonFrame = solved.frames[solved.frames.length - 1];
      if (
        !stale &&
        horizonFrame &&
        horizonFrame.reachedAreaSquareMeters < SMALL_SPREAD_HECTARES * SQUARE_METERS_PER_HECTARE
      ) {
        const fuels = [
          ...new Set(
            solved.ignitions.map((entry) => entry.conditions.fuelLabel.split(/ — | \(/)[0]),
          ),
        ].join(", ");
        list.push(
          `Modelled spread is small: these fires are on slow-burning fuels (${fuels}). Try grass or shrub areas, or stronger wind/drier fuel.`,
        );
      }
      if (stale) list.push("Showing the previous run. Your edits have not been simulated yet.");
    }
    list.push(OPERATIONAL_DISCLAIMER);
    return list;
  }, [result, currentMinute, stale]);

  /** Fuel and surface head rate per ignition, from the current (non-stale) result only. */
  const ignitionDetails = useMemo(() => {
    const details: Record<string, string> = {};
    if (!result || stale) return details;
    for (const entry of result.run.ignitions) {
      const { conditions } = entry;
      const headMetersPerMinute = conditions.spread.headRateFeetPerMinute * METERS_PER_FOOT;
      const band =
        headMetersPerMinute < SLOW_HEAD_RATE_METERS_PER_MINUTE
          ? "slow"
          : headMetersPerMinute > FAST_HEAD_RATE_METERS_PER_MINUTE
            ? "fast"
            : "moderate";
      const parts = [
        conditions.fuelLabel.replace(" — ", " · "),
        `head ${headMetersPerMinute < 10 ? headMetersPerMinute.toFixed(1) : Math.round(headMetersPerMinute)} m/min (${band})`,
      ];
      if (conditions.crown && conditions.crown.type !== "surface") {
        parts.push(`${conditions.crown.type} crown fire`);
      }
      parts.push(`midflame wind ${Math.round(conditions.midflameAdjustment * 100)}%`);
      details[entry.sourceId] = parts.join(" · ");
    }
    return details;
  }, [result, stale]);

  const attribution = useMemo(
    () => (result ? Object.values(result.attribution) : []),
    [result],
  );

  const playbackHorizon = result?.scenario.settings.horizonMinutes ?? scenario.settings.horizonMinutes;

  const events = useMemo(
    () =>
      (result?.run.input.sources ?? []).map((source) => ({
        id: source.id,
        name:
          result?.scenario.ignitions.find((ignition) => ignition.id === source.id)?.name ??
          source.id,
        minute: source.startMinute,
        state: resultStates[source.id] ?? ("scheduled" as IgnitionDisplayState),
      })),
    [result, resultStates],
  );

  const metrics = useMemo(() => {
    const frame = result?.run.frames[safeFrameIndex];
    const upcoming = events
      .filter((event) => event.minute > currentMinute)
      .sort((a, b) => a.minute - b.minute)[0];
    return {
      ignitionsTriggered: frame?.ignitedSourceIds.length ?? 0,
      ignitionsTotal: events.length || scenario.ignitions.filter((i) => i.enabled).length,
      reachedAreaSquareMeters: frame?.reachedAreaSquareMeters ?? 0,
      nextIgnition: upcoming ? { name: upcoming.name, minute: upcoming.minute } : null,
    };
  }, [result, safeFrameIndex, events, currentMinute, scenario.ignitions]);

  const handlePlayPause = useCallback(() => {
    if (frameMinutes.length === 0) return;
    if (!playing && safeFrameIndex >= frameMinutes.length - 1) seek(0);
    setPlaying(!playing);
  }, [frameMinutes, playing, safeFrameIndex, seek]);

  const handleStep = useCallback(
    (delta: -1 | 1) => {
      setPlaying(false);
      seek(safeFrameIndex + delta);
    },
    [safeFrameIndex, seek],
  );

  return (
    <main className="studio-page" id="main-content" aria-label="Simulation Studio">
      <div className="studio-stage">
        <div className="studio-page-map">
          <StudioMap
            ignitions={scenario.ignitions}
            ignitionStates={ignitionStates}
            selectedId={selectedId}
            mode={mode}
            visibleFrames={visibleFrames}
            currentMinute={currentMinute}
            horizonMinutes={playbackHorizon}
            windSpeedMph={scenario.settings.windSpeedMph}
            windFromDegrees={scenario.settings.windFromDegrees}
            landscapeBox={result?.landscapeBox ?? null}
            footprintIsStale={stale}
            ignitionDetails={ignitionDetails}
            warnings={warnings}
            attribution={attribution}
            onMapClick={handleMapClick}
            onSelectIgnition={handleSelect}
            onMoveIgnition={(id, point) => updateIgnition(id, { location: point })}
          />
        </div>

        <div className="studio-page-status" aria-live="polite">
          {state.phase === "loading-landscape" && (
            <p className="studio-chip">Loading fuel and terrain data…</p>
          )}
          {state.phase === "computing" && <p className="studio-chip">Computing fire spread…</p>}
          {state.phase === "canceled" && <p className="studio-chip">Run canceled.</p>}
          {state.phase === "failed" && state.error && (
            <p className="studio-chip studio-chip-error" role="alert">
              {state.error.message}
            </p>
          )}
          {!running && scenario.ignitions.length === 0 && (
            <p className="studio-chip">
              Choose “Add ignition” and click the map to place a fire, or load the demo scenario.
            </p>
          )}
          {notice && <p className="studio-chip">{notice}</p>}
        </div>

        <div className={`studio-page-panel${panelCollapsed ? " is-collapsed" : ""}`}>
          <ConfigPanel
            scenario={scenario}
            issues={issues}
            problems={state.error?.problems ?? []}
            selectedId={selectedId}
            mode={mode}
            phase={state.phase}
            stale={stale}
            draftStatus={draftStatusText(savedAt, saveFailed)}
            collapsed={panelCollapsed}
            onToggleCollapsed={() => setPanelCollapsed((value) => !value)}
            onModeChange={setMode}
            onSelectIgnition={handleSelect}
            onScenarioChange={applyScenario}
            onRun={handleRun}
            onCancel={cancel}
            onClear={handleClear}
            onExport={handleExport}
            onImport={handleImport}
            onLoadDemo={() => {
              applyScenario(demoScenario());
              setMode("select");
            }}
          />
        </div>
      </div>

      <div className="studio-dock">
        {result && stale && (
          <p className="studio-previous">Playing the previous run; run again to include your edits.</p>
        )}
        <PlaybackBar
          enabled={result !== null && frameMinutes.length > 0}
          frameMinutes={frameMinutes}
          frameIndex={safeFrameIndex}
          horizonMinutes={playbackHorizon}
          playing={playing}
          speed={speed}
          speedChoices={SPEED_CHOICES}
          events={events}
          metrics={metrics}
          onPlayPause={handlePlayPause}
          onStep={handleStep}
          onRestart={() => seek(0)}
          onSpeedChange={setSpeed}
          onSeek={(index) => {
            setPlaying(false);
            seek(index);
          }}
        />
      </div>
    </main>
  );
}
