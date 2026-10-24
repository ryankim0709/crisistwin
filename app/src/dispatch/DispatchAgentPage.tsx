/**
 * Dispatch agent (/dispatch): the Simulation Studio's fire scenario and run, plus an AI
 * dispatcher that orders evacuations, redirects traffic and sends fire engines while the run
 * plays. See docs/adr/0012-dispatch-agent.md. The scenario starts as the studio demo and is
 * not autosaved (the studio's device draft stays the studio's).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoPoint } from "../fire/spread";
import ConfigPanel from "../studio/ConfigPanel";
import PlaybackBar from "../studio/PlaybackBar";
import StudioMap from "../studio/StudioMap";
import {
  MAX_ENABLED_IGNITIONS,
  type IgnitionDisplayState,
  type MapMode,
  type ScenarioIssue,
  type ScheduledIgnition,
  type StudioScenario,
} from "../studio/contracts";
import { demoScenario } from "../studio/demo";
import { exportScenarioJson } from "../studio/draft";
import {
  createIgnition,
  emptyScenario,
  parseScenario,
  solverInputChanged,
  validateScenario,
} from "../studio/scenario";
import { useStudioRun } from "../studio/useStudioRun";
import AgentPanel from "./AgentPanel";
import DispatchLegend from "./DispatchLegend";
import { insideBbox, loadArea, type DispatchArea } from "./area";
import { DispatchLayers } from "./dispatchLayers";
import { noActionBaseline, type IgnitionEvent } from "./engine";
import { computeExposure } from "./fireExposure";
import { useDispatchSession } from "./useDispatchSession";
import "../studio/studio.css";
import "./dispatch.css";

const PREVIEW_SPEED_CHOICES = [1, 5, 10, 30] as const;
const DEFAULT_PREVIEW_SPEED = 10;
const NOTICE_MS = 4000;
/** When the agent starts, frame the whole dispatch area so every zone is in view. */
const AREA_FIT_PADDING = 40;
const AREA_FIT_DURATION_MS = 800;
const MAX_IMPORT_CHARACTERS = 1_000_000;

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

type AreaState =
  | { status: "loading" }
  | { status: "ready"; area: DispatchArea }
  | { status: "error"; message: string };

export default function DispatchAgentPage() {
  const [scenario, setScenario] = useState<StudioScenario>(demoScenario);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>("select");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [areaState, setAreaState] = useState<AreaState>({ status: "loading" });
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const layersRef = useRef<DispatchLayers | null>(null);

  const { state, run, cancel, markStale } = useStudioRun();
  const { result, stale } = state;
  const session = useDispatchSession();
  const area = areaState.status === "ready" ? areaState.area : null;

  useEffect(() => {
    const controller = new AbortController();
    loadArea(controller.signal)
      .then((loaded) => setAreaState({ status: "ready", area: loaded }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAreaState({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not load the dispatch area.",
        });
      });
    return () => controller.abort();
  }, []);

  // ---- Fire preview playback (before an agent run), as on the studio page ------------------
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_PREVIEW_SPEED);
  const [frameIndex, setFrameIndex] = useState(0);
  const clockRef = useRef(0);
  const frameMinutes = useMemo(() => result?.frameMinutes ?? [], [result]);

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
      clockRef.current = Math.min(end, clockRef.current + ((now - last) / 1000) * speed);
      last = now;
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

  useEffect(() => {
    if (!notice) return;
    const handle = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(handle);
  }, [notice]);

  // ---- Scenario editing (studio behaviour); any solver edit stops an agent run -----------
  const issues = useMemo(() => validateScenario(scenario), [scenario]);
  const { stop: stopSession } = session;

  const applyScenario = useCallback(
    (next: StudioScenario) => {
      if (solverInputChanged(scenario, next)) {
        setPlaying(false);
        stopSession();
        cancel();
        markStale();
      }
      setScenario(next);
      if (selectedId !== null && !next.ignitions.some((ignition) => ignition.id === selectedId)) {
        setSelectedId(null);
        setMode((current) => (current === "move" ? "select" : current));
      }
    },
    [scenario, selectedId, cancel, markStale, stopSession],
  );

  const updateIgnition = useCallback(
    (id: string, patch: Partial<ScheduledIgnition>) =>
      applyScenario({
        ...scenario,
        ignitions: scenario.ignitions.map((ignition) =>
          ignition.id === id ? { ...ignition, ...patch } : ignition,
        ),
      }),
    [scenario, applyScenario],
  );

  const handleMapClick = useCallback(
    (point: GeoPoint) => {
      if (mode === "add") {
        if (
          scenario.ignitions.filter((ignition) => ignition.enabled).length >= MAX_ENABLED_IGNITIONS
        ) {
          setNotice(
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
    [mode, scenario, selectedId, applyScenario, updateIgnition],
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

  const handleExport = useCallback(() => {
    try {
      downloadJson(`${scenario.name || "scenario"}.json`, exportScenarioJson(scenario));
    } catch (cause) {
      setNotice(
        `Could not export the scenario${cause instanceof Error ? `: ${cause.message}` : "."}`,
      );
    }
  }, [scenario]);

  // ---- Dispatch inputs derived from the current fire run ---------------------------------
  const runReady = result !== null && !stale;
  const exposure = useMemo(
    () => (area && result && !stale ? computeExposure(area, result.run.frames) : null),
    [area, result, stale],
  );
  const horizonMinutes =
    result?.scenario.settings.horizonMinutes ?? scenario.settings.horizonMinutes;
  const baseline = useMemo(
    () => (area && exposure ? noActionBaseline(area, exposure, horizonMinutes) : null),
    [area, exposure, horizonMinutes],
  );
  const ignitions: IgnitionEvent[] = useMemo(
    () =>
      (result?.run.ignitions ?? [])
        .filter((entry) => entry.outcome.status === "ignited")
        .map((entry) => ({
          minute: entry.outcome.status === "ignited" ? entry.outcome.ignitedMinute : 0,
          name:
            result?.scenario.ignitions.find((ignition) => ignition.id === entry.sourceId)?.name ??
            entry.sourceId,
        })),
    [result],
  );

  const outsideArea = useMemo(
    () =>
      area
        ? scenario.ignitions.filter(
            (ignition) =>
              ignition.enabled &&
              !insideBbox(area, [ignition.location.longitude, ignition.location.latitude]),
          )
        : [],
    [area, scenario.ignitions],
  );

  const startBlocker =
    areaState.status !== "ready"
      ? "Waiting for the dispatch area to load."
      : !result
        ? "Run the fire simulation first (left panel, “Run simulation”), then start the agent."
        : stale
          ? "Your fire edits have not been simulated yet. Choose “Rerun simulation”."
          : null;

  const handleStart = useCallback(() => {
    if (!area || !exposure || !result) return;
    setPlaying(false);
    setSelectedZoneId(null);
    // The scenario is fixed while the agent runs; give the map the room.
    setPanelCollapsed(true);
    setAgentCollapsed(false);
    const [west, south, east, north] = area.bbox;
    map?.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: AREA_FIT_PADDING, duration: AREA_FIT_DURATION_MS },
    );
    session.start({
      area,
      exposure,
      frames: result.run.frames,
      horizonMinutes,
      ignitions,
      windFromDegrees: result.scenario.settings.windFromDegrees,
      windSpeedMph: result.scenario.settings.windSpeedMph,
    });
  }, [area, exposure, result, horizonMinutes, ignitions, session, map]);

  // ---- Map overlays -------------------------------------------------------------------------
  useEffect(() => {
    if (!map || !area) return;
    const layers = new DispatchLayers(map, area, {
      onSelectZone: (zoneId) => {
        setSelectedZoneId(zoneId);
        setAgentCollapsed(false);
      },
    });
    layersRef.current = layers;
    return () => {
      layers.destroy();
      if (layersRef.current === layers) layersRef.current = null;
    };
  }, [map, area]);

  const sessionActive = session.status !== "idle" && session.engine !== null;
  useEffect(() => {
    layersRef.current?.update(sessionActive ? session.engine : null);
  }, [sessionActive, session.engine, session.version, map, area]);
  useEffect(() => {
    layersRef.current?.setSelectedZone(selectedZoneId);
  }, [selectedZoneId, map, area]);

  // ---- Map display state ------------------------------------------------------------------
  const safeFrameIndex = Math.max(0, Math.min(frameIndex, frameMinutes.length - 1));
  const displayMinute = sessionActive
    ? (session.engine?.minute ?? 0)
    : (frameMinutes[safeFrameIndex] ?? 0);
  const displayFrameIndex = sessionActive
    ? frameIndexAt(frameMinutes, displayMinute)
    : safeFrameIndex;
  const visibleFrames = useMemo(
    () => (result ? result.run.frames.slice(0, displayFrameIndex + 1) : []),
    [result, displayFrameIndex],
  );

  const problemIds = useMemo(
    () => new Set((state.error?.problems ?? []).map((p) => p.sourceId)),
    [state.error],
  );
  const issueIds = useMemo(
    () => new Set(issues.flatMap((issue) => (issue.ignitionId ? [issue.ignitionId] : []))),
    [issues],
  );
  const resultStates = useMemo(() => {
    const states: Record<string, IgnitionDisplayState> = {};
    for (const entry of result?.run.ignitions ?? []) {
      if (entry.outcome.status === "ignited") {
        states[entry.sourceId] =
          entry.outcome.ignitedMinute <= displayMinute ? "triggered" : "scheduled";
      } else {
        states[entry.sourceId] =
          entry.outcome.reachedMinute <= displayMinute ? "reached-before-start" : "scheduled";
      }
    }
    return states;
  }, [result, displayMinute]);
  const ignitionStates = useMemo(() => {
    const states: Record<string, IgnitionDisplayState> = {};
    for (const ignition of scenario.ignitions) {
      if (!ignition.enabled) states[ignition.id] = "disabled";
      else if (issueIds.has(ignition.id) || problemIds.has(ignition.id))
        states[ignition.id] = "invalid";
      else if (!result || stale) states[ignition.id] = "draft";
      else states[ignition.id] = resultStates[ignition.id] ?? "draft";
    }
    return states;
  }, [scenario.ignitions, issueIds, problemIds, result, stale, resultStates]);

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (result) {
      const solved = result.run;
      if (solved.reachedEdgeMinute !== null && displayMinute >= solved.reachedEdgeMinute) {
        list.push(
          "Fire reached the edge of the modelled area; the footprint after that is incomplete.",
        );
      }
      if (!solved.crownFire.modelled) list.push(solved.crownFire.unavailableReason);
      if (stale) list.push("Showing the previous run. Your edits have not been simulated yet.");
    }
    if (outsideArea.length > 0) {
      list.push(
        `${outsideArea.map((i) => i.name).join(", ")} ${outsideArea.length === 1 ? "is" : "are"} outside the ${area?.name ?? "dispatch"} area; roads, zones and stations exist only inside it.`,
      );
    }
    return list;
  }, [result, displayMinute, stale, outsideArea]);

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
    const frame = result?.run.frames[displayFrameIndex];
    const upcoming = events
      .filter((event) => event.minute > displayMinute)
      .sort((a, b) => a.minute - b.minute)[0];
    return {
      ignitionsTriggered: frame?.ignitedSourceIds.length ?? 0,
      ignitionsTotal: events.length || scenario.ignitions.filter((i) => i.enabled).length,
      reachedAreaSquareMeters: frame?.reachedAreaSquareMeters ?? 0,
      nextIgnition: upcoming ? { name: upcoming.name, minute: upcoming.minute } : null,
    };
  }, [result, displayFrameIndex, events, displayMinute, scenario.ignitions]);

  const running = state.phase === "loading-landscape" || state.phase === "computing";
  const attribution = useMemo(
    () => [
      ...(result ? Object.values(result.attribution) : []),
      ...(area ? [area.attribution] : []),
    ],
    [result, area],
  );

  return (
    <main className="studio-page dispatch-page" id="main-content" aria-label="Dispatch agent">
      <div className={`dispatch-body${agentCollapsed ? " is-agent-collapsed" : ""}`}>
        <div className="studio-stage">
          <div className="studio-page-map">
            <StudioMap
              ignitions={scenario.ignitions}
              ignitionStates={ignitionStates}
              selectedId={selectedId}
              mode={mode}
              visibleFrames={visibleFrames}
              currentMinute={displayMinute}
              horizonMinutes={horizonMinutes}
              windSpeedMph={scenario.settings.windSpeedMph}
              windFromDegrees={scenario.settings.windFromDegrees}
              landscapeBox={result?.landscapeBox ?? null}
              footprintIsStale={stale}
              warnings={warnings}
              attribution={attribution}
              onMapClick={handleMapClick}
              onSelectIgnition={(id) => {
                setSelectedId(id);
                if (id === null) setMode((current) => (current === "move" ? "select" : current));
              }}
              onMoveIgnition={(id, point) => updateIgnition(id, { location: point })}
              onMapReady={setMap}
              legendExtra={<DispatchLegend />}
              legendMode="compact"
            />
          </div>

          <div className="studio-page-status" aria-live="polite">
            {state.phase === "loading-landscape" && (
              <p className="studio-chip">Loading fuel and terrain data…</p>
            )}
            {state.phase === "computing" && <p className="studio-chip">Computing fire spread…</p>}
            {state.phase === "failed" && state.error && (
              <p className="studio-chip studio-chip-error" role="alert">
                {state.error.message}
              </p>
            )}
            {session.status === "thinking" && (
              <p className="studio-chip">Clock held: the agent is deciding…</p>
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
              draftStatus={null}
              collapsed={panelCollapsed}
              onToggleCollapsed={() => setPanelCollapsed((value) => !value)}
              onModeChange={setMode}
              onSelectIgnition={setSelectedId}
              onScenarioChange={applyScenario}
              onRun={() => {
                setPlaying(false);
                session.stop();
                run(scenario);
              }}
              onCancel={cancel}
              onClear={() => {
                applyScenario(emptyScenario());
                setMode("select");
              }}
              onExport={handleExport}
              onImport={handleImport}
              onLoadDemo={() => {
                applyScenario(demoScenario());
                setMode("select");
              }}
            />
          </div>
        </div>

        <aside className="dispatch-side">
          <button
            type="button"
            className="dispatch-side__toggle"
            aria-expanded={!agentCollapsed}
            aria-controls="dispatch-agent-panel"
            aria-label={agentCollapsed ? "Show agent panel" : "Hide agent panel"}
            title={agentCollapsed ? "Show agent panel" : "Hide agent panel"}
            onClick={() => setAgentCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{agentCollapsed ? "«" : "»"}</span>
            {agentCollapsed && (
              <span className="dispatch-side__rail-label">Agent · {session.status}</span>
            )}
          </button>
          {!agentCollapsed && (
            <AgentPanel
              area={area}
              areaError={areaState.status === "error" ? areaState.message : null}
              startBlocker={running ? "The fire model is running…" : startBlocker}
              status={session.status}
              engine={sessionActive ? session.engine : null}
              log={session.log}
              baseline={runReady ? baseline : null}
              speed={session.speed}
              selectedZoneId={selectedZoneId}
              onStart={handleStart}
              onPause={session.pause}
              onResume={session.resume}
              onStop={session.stop}
              onRetry={session.retry}
              onSkip={session.skip}
              onSpeedChange={session.setSpeed}
              onSelectZone={setSelectedZoneId}
            />
          )}
        </aside>
      </div>

      {!sessionActive && (
        <div className="studio-dock">
          <PlaybackBar
            enabled={result !== null && frameMinutes.length > 0}
            frameMinutes={frameMinutes}
            frameIndex={safeFrameIndex}
            horizonMinutes={horizonMinutes}
            playing={playing}
            speed={speed}
            speedChoices={PREVIEW_SPEED_CHOICES}
            events={events}
            metrics={metrics}
            onPlayPause={() => {
              if (frameMinutes.length === 0) return;
              if (!playing && safeFrameIndex >= frameMinutes.length - 1) seek(0);
              setPlaying(!playing);
            }}
            onStep={(delta) => {
              setPlaying(false);
              seek(safeFrameIndex + delta);
            }}
            onRestart={() => seek(0)}
            onSpeedChange={setSpeed}
            onSeek={(index) => {
              setPlaying(false);
              seek(index);
            }}
          />
        </div>
      )}
    </main>
  );
}
