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
import { BurnedGlyph, FireEdgeGlyph, WindGlyph } from "../diorama/ui/glyphs";
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
import type { BoardStreetsState } from "../fire/useBoardStreets";
import { Button, Legend, Panel, type LegendItem } from "../ui";
import { EvacuationPlayer, type EvacuationInputs } from "./evacuation";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const ROADS_ATTRIBUTION = "Roads © OpenStreetMap contributors";

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
  } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const streetArea = streets.status === "ready" ? streets.area : null;
  // The overlay draws its own homes (coloured by household state), so the streets layer then
  // draws roads only.
  const sceneStreets = useMemo(
    () => (streetArea && evacuation ? { edges: streetArea.edges, homes: [] } : streetArea),
    [streetArea, evacuation],
  );
  const [overlay] = useState(() => new DispatchOverlay());
  const inputs = evacuation?.inputs ?? null;
  const player = useMemo(() => (inputs ? new EvacuationPlayer(inputs) : null), [inputs]);
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
      if (player) {
        if (player.syncTo(time)) overlay.setEngine(player.engine);
      } else overlay.setPreviewMinute(time);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [scene, timeRef, player, overlay]);

  const evacuationShown = evacuation !== null;
  useEffect(() => {
    scene?.setOverlay(evacuationShown ? overlay : null);
  }, [scene, overlay, evacuationShown]);
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
            <div className="studio-diorama__buttons">
              <Button variant="secondary" size="sm" onClick={() => scene?.resetView(false)}>
                Whole board
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => scene?.resetView(true)}
                disabled={!run}
              >
                Frame fire
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
                            label: "Closed road or bridge (labelled), your assumption",
                            color: "var(--ct-ink)",
                            glyph: <ClosedRoadGlyph />,
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
              </Panel>
            )}
          </section>
        </>
      )}
    </div>
  );
}
