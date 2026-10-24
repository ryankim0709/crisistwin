/**
 * The live AI dispatcher on top of a Simulation Studio run (/dispatch): builds the road
 * network, synthetic homes and fire stations from OpenStreetMap for the box the run's fires
 * threaten, draws them on the studio's 3D diorama, and runs the dispatch session (engine, live
 * monitor, agent) with its console beside the stage. Any new or stale run ends a session. See
 * docs/adr/0017-dispatch-anywhere.md and docs/adr/0019-live-dispatch-monitor.md.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduledFireRun } from "../fire/scheduledTypes";
import { simulateScheduledFireSpread, type ControlLines } from "../fire/spread";
import { CompositeOverlay } from "../fire/diorama/compositeOverlay";
import { FirelineOverlay, type FirelineView } from "../studio/FirelineOverlay";
import { lineStatus } from "../studio/firefighting";
import { fireArrival, joinPlans } from "./fireTactics";
import type { SolvedFire, TacticSolver } from "./tacticOptions";
import { LIVE_SNAPSHOT_VERSION, type LiveSnapshot } from "../live/contracts";
import { LiveShareToggle } from "../live/LiveShareToggle";
import { fireRings, hectares, liveZones } from "../live/snapshot";
import { newSessionId, useLiveBroadcast } from "../live/useLiveBroadcast";
import type { StudioAsideContext } from "../studio/SimulationStudioPage";
import DispatchConsole, { type SetupStep } from "./DispatchConsole";
import { AreaRequestError, dispatchBoxFor, loadArea, type Bbox, type DispatchArea } from "./area";
import { noActionBaseline, type IgnitionEvent, type RoadClosure } from "./engine";
import { fireAreaFrames, fireTargets } from "./fireAttack";
import { computeExposure } from "./fireExposure";
import { roadsObservation, type FrameSummary } from "./observation";
import RoadClosures from "./RoadClosures";
import { nearestEdge } from "../studio/evacuation";
import { DispatchOverlay } from "./scene/DispatchOverlay";
import { useDispatchSession } from "./useDispatchSession";
import { Button } from "../ui";
import "./dispatch.css";

/** Wait this long after the run changes before asking for the road network. */
const AREA_DEBOUNCE_MS = 500;
/** Road boxes are snapped to this grid (degrees), like the backend cache. */
const AREA_SNAP_DEGREES = 0.01;
const ZONE_FOCUS_METERS = 900;
const ROAD_NOTICE_MS = 4000;

type AreaState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; area: DispatchArea }
  | { status: "error"; key: string; message: string };

function frameSummaries(run: ScheduledFireRun): FrameSummary[] {
  return run.frames.map((frame) => ({
    elapsedMinutes: frame.elapsedMinutes,
    burnedAreaSquareMeters: frame.reachedAreaSquareMeters,
  }));
}

/** Burned hectares and synthetic homes the fire reaches by the horizon. */
function outcomeOf(
  run: ScheduledFireRun,
  exposure: { homeArrival: Float64Array },
  horizonMinutes: number,
): { burnedHectares: number; homesReached: number } {
  let homesReached = 0;
  for (const minute of exposure.homeArrival) if (minute <= horizonMinutes) homesReached += 1;
  const last = run.frames[run.frames.length - 1];
  return { burnedHectares: (last?.reachedAreaSquareMeters ?? 0) / 10_000, homesReached };
}

function snapBox([w, s, e, n]: Bbox): Bbox {
  const snap = (value: number, round: (v: number) => number) =>
    Number((round(value / AREA_SNAP_DEGREES) * AREA_SNAP_DEGREES).toFixed(2));
  return [snap(w, Math.floor), snap(s, Math.floor), snap(e, Math.ceil), snap(n, Math.ceil)];
}

export default function StudioDispatch({
  result,
  stale,
  scene,
  clockRef,
  setLocked,
  showDiorama,
  setRunOverride,
  groundClickRef,
}: StudioAsideContext) {
  const [areaState, setAreaState] = useState<AreaState>({ status: "idle" });
  const [areaAttempt, setAreaAttempt] = useState(0);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const overlay = useMemo(() => new DispatchOverlay(), []);
  const lineOverlay = useMemo(() => new FirelineOverlay(), []);
  const composite = useMemo(() => {
    const value = new CompositeOverlay();
    value.setChildren([overlay, lineOverlay]);
    return value;
  }, [overlay, lineOverlay]);

  // Only a current run is dispatched; an edited (stale) scenario must be run again first.
  const current = result && !stale ? result : null;
  const grid = current?.landscape ?? null;
  const horizonMinutes = current?.scenario.settings.horizonMinutes ?? 0;
  const frames = useMemo<FrameSummary[]>(
    () => (current ? frameSummaries(current.run) : []),
    [current],
  );
  // The fire as the dispatcher sees it: the run without the Studio's own firefighters, re-solved
  // whenever dispatched engines put a fire out during a session.
  const [liveRun, setLiveRun] = useState<ScheduledFireRun | null>(null);
  const ignitions = useMemo<IgnitionEvent[]>(() => {
    if (!current) return [];
    return current.run.ignitions.flatMap((entry) => {
      if (entry.outcome.status !== "ignited") return [];
      const source = current.scenario.ignitions.find((i) => i.id === entry.sourceId);
      return [{ minute: entry.outcome.ignitedMinute, name: source?.name || entry.sourceId }];
    });
  }, [current]);

  // ---- Road network, homes and stations for the box the fires threaten ------------------
  const box = useMemo(
    () =>
      grid && current ? dispatchBoxFor(grid, current.run.arrivalMinutes, horizonMinutes) : null,
    [grid, current, horizonMinutes],
  );
  const snapped = useMemo(() => (box ? snapBox(box) : null), [box]);
  const boxKey = snapped ? snapped.join(",") : null;
  useEffect(() => {
    if (!boxKey || !snapped) {
      setAreaState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setAreaState((state) =>
      state.status === "ready" && state.key === boxKey ? state : { status: "loading", key: boxKey },
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
    () =>
      area && grid && current ? computeExposure(area, grid, current.run.arrivalMinutes) : null,
    [area, grid, current],
  );
  const baseline = useMemo(
    () => (area && exposure ? noActionBaseline(area, exposure, horizonMinutes) : null),
    [area, exposure, horizonMinutes],
  );

  // ---- Session: drives the studio's clock while it runs ----------------------------------
  const pushTime = useCallback(
    (minutes: number) => {
      clockRef.current = minutes;
      overlay.setPreviewMinute(minutes);
      lineOverlay.setMinute(minutes);
    },
    [clockRef, overlay, lineOverlay],
  );
  const session = useDispatchSession(pushTime);
  const sessionActive = session.status !== "idle" && session.engine !== null;
  const { stop: stopSession } = session;

  // ---- Road closures: planned before the start (held from T+0), live during a session ------
  const [roadTool, setRoadTool] = useState(false);
  const [roadNotice, setRoadNotice] = useState<string | null>(null);
  const [planned, setPlanned] = useState<{ key: string; closures: RoadClosure[] }>({
    key: "",
    closures: [],
  });
  const plannedClosures = useMemo(
    () => (area && planned.key === area.id ? planned.closures : []),
    [area, planned],
  );
  const liveRoads = sessionActive ? session.engine : null;
  const closures = liveRoads ? liveRoads.roadClosures : plannedClosures;
  const closedEdges = useMemo<ReadonlySet<number>>(
    () => (liveRoads ? liveRoads.closedEdges : new Set(plannedClosures.map((c) => c.edge))),
    // session.version: the engine replaces its closed set in place of mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveRoads, plannedClosures, session.version],
  );
  const toggleRoad = useCallback(
    (edge: number) => {
      if (!area) return;
      if (liveRoads) {
        session.setRoadClosed(edge, !liveRoads.closedEdges.has(edge));
        return;
      }
      setPlanned(({ key, closures: list }) => {
        const current = key === area.id ? list : [];
        return {
          key: area.id,
          closures: current.some((c) => c.edge === edge)
            ? current.filter((c) => c.edge !== edge)
            : [...current, { edge, minute: 0 }],
        };
      });
    },
    [area, liveRoads, session],
  );
  useEffect(() => {
    if (!roadTool || !area) return;
    groundClickRef.current = (point) => {
      const edge = nearestEdge(area, [point.longitude, point.latitude]);
      if (edge === null) setRoadNotice("No road there. Click closer to a road to close it.");
      else {
        setRoadNotice(null);
        toggleRoad(edge);
      }
      return true;
    };
    return () => {
      groundClickRef.current = null;
    };
  }, [roadTool, area, toggleRoad, groundClickRef]);
  useEffect(() => {
    if (!roadNotice) return;
    const handle = window.setTimeout(() => setRoadNotice(null), ROAD_NOTICE_MS);
    return () => window.clearTimeout(handle);
  }, [roadNotice]);
  useEffect(() => {
    overlay.setClosedEdges(closedEdges);
  }, [overlay, closedEdges]);
  const fireCut = useMemo(() => {
    if (!liveRoads) return null;
    const roads = roadsObservation(liveRoads);
    return { segments: roads.fire_cut_segments, roads: roads.fire_cut_roads };
    // session.version: the engine's minute advances in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRoads, session.version]);

  useEffect(() => {
    setLocked(sessionActive);
  }, [sessionActive, setLocked]);
  useEffect(() => () => setLocked(false), [setLocked]);

  // Any change to the run or its roads ends a dispatcher run.
  useEffect(() => {
    stopSession();
    setSelectedZone(null);
  }, [current, area, stopSession]);
  // A re-solved fire is shown only during the session that produced it.
  const dispatchRun =
    sessionActive && liveRun && liveRun.input === current?.run.input
      ? liveRun
      : (current?.run ?? null);
  useEffect(() => {
    setRunOverride(dispatchRun);
  }, [dispatchRun, setRunOverride]);
  useEffect(() => () => setRunOverride(null), [setRunOverride]);

  // ---- 3D overlay ------------------------------------------------------------------------
  useEffect(() => {
    if (!scene) return;
    scene.setOverlay(composite);
    return () => scene.setOverlay(null);
  }, [scene, composite]);
  // Modelled homes replace the board's placeholder houses once the area is loaded.
  useEffect(() => {
    if (!scene) return;
    scene.setCoverHouses(!area);
    return () => scene.setCoverHouses(true);
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
  // Control line the dispatched engines build (flank and indirect attack), on the live fire.
  const lineEngine = sessionActive ? session.engine : null;
  const firelineView = useMemo<FirelineView | null>(() => {
    if (!lineEngine || !current || !dispatchRun) return null;
    const line = lineEngine.fires.reduce(
      (all, fire) => joinPlans(all, fire.line),
      null as ReturnType<typeof joinPlans>,
    );
    if (!line || line.cells.length === 0) return null;
    return {
      grid: current.landscape,
      line,
      status: lineStatus(line, dispatchRun.arrivalMinutes, horizonMinutes),
      arrival: dispatchRun.arrivalMinutes,
    };
    // session.version: the engine's lines change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineEngine, current, dispatchRun, horizonMinutes, session.version]);
  useEffect(() => {
    lineOverlay.setView(firelineView);
  }, [lineOverlay, firelineView]);
  // Before a session, homes darken as the studio's playback clock reaches them.
  useEffect(() => {
    if (sessionActive || !area) return;
    let handle = 0;
    const tick = () => {
      overlay.setPreviewMinute(clockRef.current);
      lineOverlay.setMinute(clockRef.current);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [sessionActive, area, overlay, lineOverlay, clockRef]);

  const selectZone = useCallback(
    (zone: number | null) => {
      setSelectedZone(zone);
      if (zone !== null && area) {
        const [longitude, latitude] = area.zones[zone].centroid;
        scene?.focusOn({ latitude, longitude }, ZONE_FOCUS_METERS);
      }
    },
    [area, scene],
  );

  /** The fire with some fires put out and some control lines built, for the dispatcher. */
  const solveFire = useCallback(
    (outFromMinuteBySource: number[], lines: ControlLines | null): SolvedFire => {
      if (!current || !area) throw new Error("No run to re-solve.");
      const run = simulateScheduledFireSpread(
        current.landscape,
        current.run.input,
        lines,
        outFromMinuteBySource,
      );
      const solvedExposure = computeExposure(area, current.landscape, run.arrivalMinutes);
      return {
        run,
        exposure: solvedExposure,
        frames: frameSummaries(run),
        fireFrames: fireAreaFrames(run),
        ...outcomeOf(run, solvedExposure, horizonMinutes),
      };
    },
    [current, area, horizonMinutes],
  );
  const solver = useMemo<TacticSolver | null>(
    () =>
      current
        ? {
            grid: current.landscape,
            unchecked: current.run.ignitions.map((_, index) => fireArrival(current.run, index)),
            windFromDegrees: current.scenario.settings.windFromDegrees,
            horizonMinutes,
            solve: solveFire,
          }
        : null,
    [current, horizonMinutes, solveFire],
  );
  const showFire = useCallback((solved: SolvedFire) => setLiveRun(solved.run), []);

  const handleStart = useCallback(() => {
    if (!area || !exposure || !current || !solver) return;
    showDiorama();
    setSelectedZone(null);
    setLiveRun(null);
    const names = Object.fromEntries(
      current.scenario.ignitions.map((ignition) => [ignition.id, ignition.name || ignition.id]),
    );
    session.start({
      area,
      exposure,
      frames,
      fireTargets: fireTargets(current.run, names),
      fireFrames: fireAreaFrames(current.run),
      solver,
      showFire,
      initialOutcome: outcomeOf(current.run, exposure, horizonMinutes),
      baselineHomesExposed: baseline?.caught ?? null,
      horizonMinutes,
      ignitions,
      windFromDegrees: current.scenario.settings.windFromDegrees,
      windSpeedMph: current.scenario.settings.windSpeedMph,
      closedEdges: new Set(plannedClosures.map((closure) => closure.edge)),
    });
  }, [
    plannedClosures,
    area,
    exposure,
    current,
    frames,
    baseline,
    horizonMinutes,
    ignitions,
    session,
    showDiorama,
    solver,
    showFire,
  ]);

  // ---- Resident app broadcast (simulated guidance per zone) -------------------------------
  const areaLabel = current?.scenario.name || area?.name || "Dispatch scenario";
  const liveEngine = sessionActive ? session.engine : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const liveSessionId = useMemo(() => (current ? newSessionId() : null), [current, liveEngine]);
  const getLiveSnapshot = useCallback((): LiveSnapshot | null => {
    if (!current || !liveSessionId) return null;
    const minute = Math.min(liveEngine ? liveEngine.minute : clockRef.current, horizonMinutes);
    const frame = [...(dispatchRun ?? current.run).frames]
      .reverse()
      .find((f) => f.elapsedMinutes <= minute);
    const latest = session.log.find((entry) => entry.status === "done");
    return {
      version: LIVE_SNAPSHOT_VERSION,
      source: liveEngine ? "dispatch_agent" : "fire_model",
      session_id: liveSessionId,
      evidence_class: "simulated",
      playback: liveEngine
        ? session.status === "finished"
          ? "finished"
          : session.status === "running" || session.status === "thinking"
            ? "playing"
            : "paused"
        : "paused",
      area_name: areaLabel,
      minute: Math.round(minute),
      horizon_minutes: horizonMinutes,
      wind: {
        from_degrees: current.scenario.settings.windFromDegrees,
        speed_mph: current.scenario.settings.windSpeedMph,
      },
      bbox: area ? area.bbox : null,
      fire: {
        perimeters: frame ? fireRings(frame.perimeters) : [],
        burned_area_ha: hectares(frame?.reachedAreaSquareMeters ?? 0),
      },
      zones: liveEngine ? liveZones(liveEngine) : [],
      agent:
        liveEngine && latest && latest.model
          ? { summary: latest.summary, model: latest.model, minute: latest.minute }
          : null,
    };
  }, [
    current,
    dispatchRun,
    liveSessionId,
    liveEngine,
    clockRef,
    horizonMinutes,
    session.log,
    session.status,
    areaLabel,
    area,
  ]);
  const liveBroadcast = useLiveBroadcast(
    getLiveSnapshot,
    `${liveSessionId}:${session.status}:${session.version}`,
  );

  // ---- Setup checklist --------------------------------------------------------------------
  const steps: SetupStep[] = [
    {
      label: "Run the fire scenario",
      detail: current
        ? `${horizonMinutes / 60} h of simulated spread from ${ignitions.length} fire${ignitions.length === 1 ? "" : "s"}`
        : result && stale
          ? "The scenario changed since the last run. Run it again to dispatch it."
          : "Place fires (or load the demo) in the panel, then run the simulation.",
      state: current ? "done" : "active",
    },
    {
      label: "Roads, homes and stations",
      detail: area
        ? `${area.name}: ${area.homes.length.toLocaleString()} homes in ${area.zones.length} zones, ${area.exits.length} exits, ${area.stations.length} fire stations`
        : areaState.status === "error"
          ? areaState.message
          : current
            ? "Building the evacuation network from OpenStreetMap…"
            : "Built from OpenStreetMap around the fire.",
      state: area
        ? "done"
        : areaState.status === "error"
          ? "error"
          : current
            ? "active"
            : "waiting",
    },
  ];
  const startBlocker = !current
    ? result && stale
      ? "Run the edited scenario first."
      : "Run a fire scenario first."
    : !area
      ? areaState.status === "error"
        ? "The road network could not be loaded."
        : "Waiting for the road network…"
      : area.zones.length === 0
        ? "No residential streets lie near these fires, so there is nobody to evacuate. Try fires closer to homes."
        : null;

  return (
    <DispatchConsole
      area={area}
      steps={steps}
      startBlocker={startBlocker}
      status={session.status}
      engine={sessionActive ? session.engine : null}
      version={session.version}
      log={session.log}
      checks={session.checks}
      checkInterval={session.checkInterval}
      nextCheckMinute={session.nextCheckMinute}
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
      onCheckIntervalChange={session.setCheckInterval}
      onSelectZone={selectZone}
      roads={
        area && (
          <RoadClosures
            area={area}
            closures={closures}
            fireCut={fireCut}
            tool={roadTool}
            onTool={() => {
              setRoadTool((on) => !on);
              setRoadNotice(null);
              showDiorama();
            }}
            onReopen={toggleRoad}
            live={liveRoads !== null}
            notice={roadNotice}
          />
        )
      }
      footer={
        <>
          {areaState.status === "error" && (
            <p className="dsp-note">
              <Button variant="secondary" size="sm" onClick={() => setAreaAttempt((v) => v + 1)}>
                Retry the road network
              </Button>
            </p>
          )}
          {current && (
            <LiveShareToggle
              id="dispatch-live-share"
              className="live-share dispatch-live-share"
              enabled={liveBroadcast.enabled}
              onChange={liveBroadcast.setEnabled}
              status={liveBroadcast.status}
              idleText="Shares the fire, and each zone's simulated guidance while the agent runs, with the resident app."
            />
          )}
        </>
      }
    />
  );
}
