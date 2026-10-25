/**
 * 3D diorama view for Simulation Studio: the fire page's three.js miniature (ADR 0011,
 * `fire/diorama/`) drawing the selected prebuilt region board (or the last run's landscape)
 * and the run's combined arrival field, with one labelled pin per enabled ignition, plus the
 * board's OSM roads with synthetic homes along residential streets. Presentation only; frames,
 * areas and outcomes stay the solver's. See docs/adr/0016-studio-diorama-view.md.
 *
 * With the evacuation on, the dispatch overlay draws households by state, routes, vehicles and
 * closed roads, positioned by an `EvacuationPlayer` at the playback clock
 * (docs/adr/0018-road-closures.md).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DispatchArea } from "../dispatch/area";
import { HomeStatus } from "../dispatch/engine";
import type { FireExposure } from "../dispatch/fireExposure";
import { DispatchOverlay, HOME_COLORS, cssColor } from "../dispatch/scene/DispatchOverlay";
import { BurnedGlyph, FireEdgeGlyph, StationBadgeGlyph, WindGlyph } from "../diorama/ui/glyphs";
import { useMediaQuery } from "../diorama/ui/format";
import { FireDioramaScene } from "../fire/diorama/FireDioramaScene";
import type {
  DioramaIgnition,
  DioramaRun,
  FireDioramaSceneApi,
  ViewInsets,
} from "../fire/diorama/types";
import type { LandscapeGrid } from "../fire/landscape";
import type { GeoPoint } from "../fire/spread";
import { sceneryOf, type BoardStreetsState } from "../fire/useBoardStreets";
import { Button, Legend, Panel, type LegendItem } from "../ui";
import { EvacuationPlayer, type EvacuationInputs } from "./evacuation";
import { CompositeOverlay } from "../fire/diorama/compositeOverlay";
import { FirelineOverlay, type FirelineView } from "./FirelineOverlay";
import { CrewOverlay } from "./CrewOverlay";
import type { CrewDispatch } from "./crewDispatch";
import { CREW_COLORS, FIRELINE_COLORS, firelineCss } from "./firelinePalette";
import type { IntelCandidate } from "../intel/api";
import { liveClosures } from "../intel/closures";
import { useConfirmedClosures } from "../intel/useConfirmedClosures";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const ROADS_ATTRIBUTION = "Roads © OpenStreetMap contributors";
const NO_LEAVES: readonly (number | null)[] = [];

function closureLabel(report: IntelCandidate): string {
  return report.mapping?.road_name || report.target.road_name || report.description;
}

function RoadGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <path d="M2 12C8 12 10 4 22 4" stroke="#cdbfa6" strokeWidth="5" fill="none" />
      <path d="M2 12C8 12 10 4 22 4" stroke="#6b7480" strokeWidth="3" fill="none" />
    </svg>
  );
}

function ClosedRoadGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <path d="M2 8H22" stroke="#1a1a1a" strokeWidth="4" />
      <path d="M9 3l6 10M15 3 9 13" stroke="#fff" strokeWidth="1.6" />
    </svg>
  );
}

const HOUSEHOLD_STATES: readonly [HomeStatus, string][] = [
  [HomeStatus.idle, "Household: no order (or cut off)"],
  [HomeStatus.ordered, "Household: ordered, getting ready"],
  [HomeStatus.queued, "Household: queued to enter the road"],
  [HomeStatus.driving, "Household: driving out"],
  [HomeStatus.safe, "Household: reached an exit"],
  [HomeStatus.caught, "Household: caught by the modelled fire"],
];

function RoofGlyph({ color }: { color: string }) {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <path d="M7 14V8h10v6z" fill="#e7e1d3" stroke="#8a8172" strokeWidth="1" />
      <path d="M5 8.5 12 3l7 5.5z" fill={color} />
    </svg>
  );
}

/** What the evacuation overlay draws; null leaves the board as plain streets. */
export interface StudioEvacuationView {
  area: DispatchArea;
  /** Fire exposure of the run shown, or null before a run (homes only, no evacuation). */
  exposure: FireExposure | null;
  closedEdges: ReadonlySet<number>;
  /** Policy inputs to play, or null before a run. */
  inputs: EvacuationInputs | null;
}

function VehicleGlyph({ color, width, height }: { color: number; width: number; height: number }) {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect
        x={12 - width / 2}
        y={13 - height}
        width={width}
        height={height}
        rx="1"
        fill={firelineCss(color)}
      />
    </svg>
  );
}

function FirelineGlyph({ kind }: { kind: "held" | "breached" | "outrun" }) {
  return kind === "held" ? (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x="2" y="10" width="20" height="3" fill={firelineCss(FIRELINE_COLORS.held)} />
    </svg>
  ) : (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x="6" y="3" width="3" height="11" fill={firelineCss(FIRELINE_COLORS[kind])} />
      <rect x="15" y="3" width="3" height="11" fill={firelineCss(FIRELINE_COLORS[kind])} />
    </svg>
  );
}

function FlowGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x="1" y="9" width="22" height="5" rx="2" fill="#14b8a6" />
      <rect x="1" y="3" width="22" height="2" rx="1" fill="#f2a33a" />
    </svg>
  );
}

function HomeGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <path d="M7 14V8h10v6z" fill="#f2e9d9" stroke="#8a8172" strokeWidth="1" />
      <path d="M5 8.5 12 3l7 5.5z" fill="#c27a5a" />
    </svg>
  );
}

export interface StudioDioramaProps {
  /** Landscape of the latest result; null before the first run. */
  landscape: LandscapeGrid | null;
  run: DioramaRun | null;
  ignitions: DioramaIgnition[];
  windFromDegrees: number;
  windSpeedMph: number;
  /** Smooth playback clock in minutes from T+0, read every animation frame. */
  timeRef: { readonly current: number };
  insets: ViewInsets;
  /** Changing this frames the burn (a new result arrived). */
  fitKey: number | null;
  /** Model warnings and the planning disclaimer, as the map shows them; listed in the legend. */
  warnings: string[];
  /** Source data credits for the landscape. */
  attribution: string[];
  onGroundClick: (point: GeoPoint) => void;
  /** Shown over the empty plinth while there is no board to draw. */
  emptyState: ReactNode;
  /** Region picker and board provenance, shown top right whether or not a board is loaded. */
  boardControl?: ReactNode;
  /** OSM roads and synthetic homes for the board (the page loads them). */
  streets: BoardStreetsState;
  evacuation: StudioEvacuationView | null;
  /** Firefighters' control line for the run shown, or null. */
  fireline: FirelineView | null;
  /** Firefighters driving in from fire stations, or null. */
  crews: CrewDispatch | null;
  /** Wall-clock time of T+0 (epoch ms), for the 3D time readout. */
  startMs?: number;
  /** Minute each crew leaves the fire to help the evacuation (null = stays); empty = none. */
  crewLeaveMinutes?: readonly (number | null)[];
  /** Minute each crew is released because its fire is out (null = stays); empty = none. */
  crewReleaseMinutes?: readonly (number | null)[];
  /** Shown under the board control. */
  evacuationPanel?: ReactNode;
  /** The live scene once created, and null once disposed (for a page overlay such as dispatch). */
  onSceneChange?: (scene: FireDioramaSceneApi | null) => void;
}

function IgnitionGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <path d="M12 15V7" stroke="#8a8172" strokeWidth="1.4" />
      <circle cx="12" cy="5" r="3.6" fill="#d65a40" stroke="#f5f4ee" strokeWidth="1.2" />
    </svg>
  );
}

export default function StudioDiorama(props: StudioDioramaProps) {
  const {
    landscape,
    run,
    ignitions,
    windFromDegrees,
    windSpeedMph,
    timeRef,
    insets,
    fitKey,
    warnings,
    attribution,
    onGroundClick,
    emptyState,
    boardControl,
    streets,
    evacuation,
    evacuationPanel,
    onSceneChange,
    fireline,
    crews,
    startMs,
    crewLeaveMinutes,
    crewReleaseMinutes,
  } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const streetArea = streets.status === "ready" ? streets.area : null;
  // The overlay draws its own homes (coloured by household state), so the streets layer then
  // draws roads only.
  const streetScenery = sceneryOf(streets);
  const sceneStreets = useMemo(
    () => (streetScenery && evacuation ? { edges: streetScenery.edges, homes: [] } : streetScenery),
    [streetScenery, evacuation],
  );
  const [overlay] = useState(() => new DispatchOverlay());
  const [lineOverlay] = useState(() => new FirelineOverlay());
  const [crewOverlay] = useState(() => new CrewOverlay());
  const [composite] = useState(() => new CompositeOverlay());
  const inputs = evacuation?.inputs ?? null;
  const player = useMemo(() => (inputs ? new EvacuationPlayer(inputs) : null), [inputs]);
  const [closures, refreshClosures] = useConfirmedClosures(streetArea ? streetArea.bbox : null);
  const live = useMemo(
    () =>
      streetArea && closures.status === "ready"
        ? liveClosures(streetArea, closures.closures)
        : null,
    [streetArea, closures],
  );
  const reducedMotionRef = useRef(reducedMotion);
  const clickRef = useRef(onGroundClick);
  useEffect(() => {
    clickRef.current = onGroundClick;
  }, [onGroundClick]);
  const sceneChangeRef = useRef(onSceneChange);
  useEffect(() => {
    sceneChangeRef.current = onSceneChange;
  }, [onSceneChange]);
  useEffect(() => {
    sceneChangeRef.current?.(scene);
  }, [scene]);
  useEffect(() => () => sceneChangeRef.current?.(null), []);

  // StrictMode-safe: the cleanup disposes, the re-run builds a fresh scene.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let created: FireDioramaSceneApi;
    try {
      created = new FireDioramaScene(host, { reducedMotion: reducedMotionRef.current });
    } catch (cause) {
      console.error("Studio diorama scene could not start", cause);
      setError(cause instanceof Error ? cause.message : "WebGL could not be initialised.");
      return;
    }
    created.onGroundClick((point) => clickRef.current(point));
    setScene(created);
    setError(null);
    return () => {
      setScene(null);
      created.dispose();
    };
  }, []);

  // The page's clock is a ref, so push it every frame instead of re-rendering React.
  useEffect(() => {
    if (!scene) return;
    let handle = 0;
    const tick = () => {
      const time = timeRef.current;
      scene.setTime(time);
      lineOverlay.setMinute(time);
      crewOverlay.setMinute(time);
      if (player) {
        if (player.syncTo(time)) overlay.setEngine(player.engine);
      } else overlay.setPreviewMinute(time);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [scene, timeRef, player, overlay, lineOverlay, crewOverlay]);

  const evacuationShown = evacuation !== null;
  const firelineShown = fireline !== null;
  const crewsShown = crews !== null;
  // Clears the scene overlay only if this view set it, so a page overlay set through
  // `onSceneChange` (the /dispatch dispatcher) is left alone.
  const ownsOverlayRef = useRef(false);
  useEffect(() => {
    const children = [
      ...(evacuationShown ? [overlay] : []),
      ...(firelineShown ? [lineOverlay] : []),
      ...(crewsShown ? [crewOverlay] : []),
    ];
    composite.setChildren(children);
    if (!scene) return;
    if (children.length > 0) {
      scene.setOverlay(composite);
      ownsOverlayRef.current = true;
    } else if (ownsOverlayRef.current) {
      scene.setOverlay(null);
      ownsOverlayRef.current = false;
    }
  }, [
    scene,
    composite,
    overlay,
    lineOverlay,
    crewOverlay,
    evacuationShown,
    firelineShown,
    crewsShown,
  ]);
  useEffect(() => {
    crewOverlay.setDispatch(crews);
  }, [crewOverlay, crews]);
  useEffect(() => {
    crewOverlay.setLeaveMinutes(crewLeaveMinutes ?? NO_LEAVES, crewReleaseMinutes ?? NO_LEAVES);
  }, [crewOverlay, crewLeaveMinutes, crewReleaseMinutes]);
  useEffect(() => {
    lineOverlay.setView(fireline);
  }, [lineOverlay, fireline]);
  const evacArea = evacuation?.area ?? null;
  const evacExposure = evacuation?.exposure ?? null;
  useEffect(() => {
    overlay.setArea(evacArea, evacExposure);
  }, [overlay, evacArea, evacExposure]);
  const closedEdges = evacuation?.closedEdges;
  useEffect(() => {
    if (closedEdges) overlay.setClosedEdges(closedEdges);
  }, [overlay, closedEdges]);
  useEffect(() => {
    overlay.setStartMs(startMs ?? null);
  }, [overlay, startMs]);
  useEffect(() => {
    overlay.setEngine(player?.engine ?? null);
  }, [overlay, player, evacArea]);

  useEffect(() => {
    scene?.setLandscape(landscape);
  }, [scene, landscape]);
  useEffect(() => {
    scene?.setStreets(sceneStreets);
  }, [scene, sceneStreets]);
  useEffect(() => {
    scene?.setRun(run);
  }, [scene, run]);
  useEffect(() => {
    scene?.setIgnitions(ignitions);
  }, [scene, ignitions]);
  useEffect(() => {
    scene?.setWind(windFromDegrees, windSpeedMph);
  }, [scene, windFromDegrees, windSpeedMph]);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    scene?.setReducedMotion(reducedMotion);
  }, [scene, reducedMotion]);
  const { top, right, bottom, left } = insets;
  useEffect(() => {
    scene?.setViewInsets({ top, right, bottom, left });
  }, [scene, top, right, bottom, left]);
  useEffect(() => {
    if (fitKey !== null) scene?.resetView(true);
  }, [scene, fitKey]);

  return (
    <div className="studio-diorama">
      <div
        ref={hostRef}
        className="studio-diorama__scene"
        role="group"
        aria-label="3D landscape of the last run. Click the board to add or move an ignition when that mode is on."
        aria-hidden={error !== null}
      />

      {error && (
        <Panel glass className="studio-diorama__card" role="alert">
          <p className="studio-diorama__card-title">3D view unavailable in this browser</p>
          <p>
            The diorama needs WebGL, which appears to be disabled or unsupported here. Switch to the
            map view; the scenario and results still work.
          </p>
          <p className="studio-diorama__detail">{error}</p>
        </Panel>
      )}
      {!error && !landscape && (
        <Panel glass className="studio-diorama__card">
          {emptyState}
        </Panel>
      )}

      {!error && (
        <div className="studio-diorama__tools">
          {boardControl}
          {landscape && (
            <div className="studio-diorama__buttons" role="group" aria-labelledby="studio-diorama-zoom">
              <span id="studio-diorama-zoom" className="studio-diorama__zoom-label">
                Zoom
              </span>
              <Button variant="secondary" size="sm" onClick={() => scene?.resetView(false)}>
                Whole board
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => scene?.resetView(true)}
                disabled={!run}
              >
                Zoom to fire
              </Button>
            </div>
          )}
          {landscape && evacuationPanel}
        </div>
      )}

      {!error && landscape && (
        <>
          {attribution.length > 0 && (
            <p className="studio-diorama__credit">
              Planning experiment, not an operational forecast · Sources:{" "}
              {[...attribution, ...(streetArea ? [ROADS_ATTRIBUTION] : [])].join(" · ")}
              {streets.status === "loading" && " · Loading roads…"}
            </p>
          )}

          <section className="studio-diorama__legend" aria-label="3D view legend">
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={legendOpen}
              aria-controls="studio-diorama-legend"
              onClick={() => setLegendOpen((open) => !open)}
            >
              {legendOpen ? "Hide legend" : "Legend"}
            </Button>
            {legendOpen && (
              <Panel
                glass
                compact
                id="studio-diorama-legend"
                className="studio-diorama__legend-list"
              >
                <Legend
                  label="3D view legend items"
                  items={[
                    {
                      label: "Burning front (glows)",
                      color: "var(--ct-fire)",
                      glyph: <FireEdgeGlyph />,
                    },
                    { label: "Burned ground", color: "var(--ct-burned)", glyph: <BurnedGlyph /> },
                    { label: "Fire station", color: "#c8352a", glyph: <StationBadgeGlyph /> },
                    ...(streetArea
                      ? [
                          {
                            label: "Road (OpenStreetMap), widths exaggerated",
                            color: "var(--ct-ink)",
                            glyph: <RoadGlyph />,
                          },
                          {
                            label: "Synthetic home along a residential street",
                            color: "var(--ct-ink)",
                            glyph: <HomeGlyph />,
                          },
                        ]
                      : []),
                    ...(evacuation
                      ? [
                          ...HOUSEHOLD_STATES.map(([status, label]): LegendItem => ({
                            label,
                            color: cssColor(HOME_COLORS[status]),
                            glyph: <RoofGlyph color={cssColor(HOME_COLORS[status])} />,
                          })),
                          {
                            label: "Road ribbon: thicker = more people; teal moving, amber slow, red stuck",
                            color: "#14b8a6",
                            glyph: <FlowGlyph />,
                          },
                          {
                            label: "Closed road or bridge (labelled), your assumption",
                            color: "var(--ct-ink)",
                            glyph: <ClosedRoadGlyph />,
                          },
                        ]
                      : []),
                    ...(crews
                      ? [
                          {
                            label: "Engine (long red block), driving in or on scene",
                            color: firelineCss(CREW_COLORS.engine),
                            glyph: (
                              <VehicleGlyph color={CREW_COLORS.engine} width={16} height={6} />
                            ),
                          },
                          {
                            label: "Hand-crew buggy (tall green block)",
                            color: firelineCss(CREW_COLORS.hand_crew),
                            glyph: (
                              <VehicleGlyph color={CREW_COLORS.hand_crew} width={12} height={9} />
                            ),
                          },
                          {
                            label: "Dozer (low wide yellow block)",
                            color: firelineCss(CREW_COLORS.dozer),
                            glyph: <VehicleGlyph color={CREW_COLORS.dozer} width={13} height={5} />,
                          },
                        ]
                      : []),
                    ...(fireline
                      ? [
                          {
                            label: "Control line built, holding so far",
                            color: firelineCss(FIRELINE_COLORS.held),
                            glyph: <FirelineGlyph kind="held" />,
                          },
                          {
                            label: "Control line burned over by flames (posts)",
                            color: firelineCss(FIRELINE_COLORS.breached),
                            glyph: <FirelineGlyph kind="breached" />,
                          },
                          {
                            label: "Line the fire reached before the crew (posts)",
                            color: firelineCss(FIRELINE_COLORS.outrun),
                            glyph: <FirelineGlyph kind="outrun" />,
                          },
                        ]
                      : []),
                    {
                      label: "Enabled ignition, with its name",
                      color: "var(--ct-fire)",
                      glyph: <IgnitionGlyph />,
                    },
                    {
                      label: "Wind, pointing downwind",
                      color: "var(--ct-ink)",
                      glyph: <WindGlyph bearing={(windFromDegrees + 180) % 360} />,
                    },
                  ]}
                />
                {warnings.length > 0 && (
                  <ul className="studio-diorama__warnings" aria-label="Model warnings">
                    {warnings.map((warning) => (
                      <li key={warning}>⚠ {warning}</li>
                    ))}
                  </ul>
                )}
                <p className="studio-diorama__legend-note">
                  {streetArea
                    ? "Trees symbolise LANDFIRE fuel classes. Homes are placeholders every ~40 m along OSM residential streets, not real buildings. Relief is exaggerated."
                    : streets.status === "error"
                      ? "Roads could not be loaded, so houses symbolise the LANDFIRE urban fuel class. Trees symbolise fuel classes; relief is exaggerated."
                      : "Trees and houses symbolise LANDFIRE fuel classes; relief is exaggerated."}
                </p>
                {streetArea && closures.status !== "idle" && (
                  <div className="studio-diorama__legend-note" role="status">
                    {closures.status === "loading" ? (
                      "Reported closures: loading…"
                    ) : closures.status === "error" ? (
                      `Reported closures unavailable: ${closures.message}`
                    ) : live && live.applied.length + live.unmatched.length > 0 ? (
                      <>
                        Reported closure · planner-confirmed: {live.applied.length} in force,{" "}
                        {live.closedEdges.size} road segments closed to routing (not fire spread).
                        Applied when a dispatch run starts; changes apply on the next start. The run
                        stays simulated.
                      </>
                    ) : (
                      "No planner-confirmed live closures in this area."
                    )}
                    {live && live.unmatched.length > 0 && (
                      <ul className="studio-diorama__warnings" aria-label="Unmatched closures">
                        {live.unmatched.map((report) => (
                          <li key={report.event_id}>
                            ⚠ Not applied, no matching road: {closureLabel(report)}
                          </li>
                        ))}
                      </ul>
                    )}{" "}
                    {closures.status !== "loading" && (
                      <Button variant="secondary" size="sm" onClick={refreshClosures}>
                        Re-check
                      </Button>
                    )}
                  </div>
                )}
              </Panel>
            )}
          </section>
        </>
      )}
    </div>
  );
}
