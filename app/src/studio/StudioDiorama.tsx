/**
 * 3D diorama view for Simulation Studio: the fire page's three.js miniature (ADR 0011,
 * `fire/diorama/`) drawing the last run's landscape and its combined arrival field, with one
 * labelled pin per enabled ignition. Presentation only; frames, areas and outcomes stay the
 * solver's. See docs/adr/0016-studio-diorama-view.md.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import type { MapMode } from "./contracts";
import { Button, Legend, Notice, Panel, Tag } from "../ui";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const MODE_PROMPT: Partial<Record<MapMode, string>> = {
  add: "Click the board to add an ignition.",
  move: "Click the board to move the selected ignition.",
};

export interface StudioDioramaProps {
  /** Landscape of the latest result; null before the first run. */
  landscape: LandscapeGrid | null;
  run: DioramaRun | null;
  ignitions: DioramaIgnition[];
  windFromDegrees: number;
  windSpeedMph: number;
  mode: MapMode;
  /** Smooth playback clock in minutes from T+0, read every animation frame. */
  timeRef: { readonly current: number };
  insets: ViewInsets;
  /** Changing this frames the burn (a new result arrived). */
  fitKey: number | null;
  /** Model warnings and the planning disclaimer, as the map shows them. */
  warnings: string[];
  /** Source data credits for the landscape. */
  attribution: string[];
  onGroundClick: (point: GeoPoint) => void;
  /** Shown over the empty plinth before any run. */
  emptyState: ReactNode;
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
    mode,
    timeRef,
    insets,
    fitKey,
    warnings,
    attribution,
    onGroundClick,
    emptyState,
  } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const reducedMotionRef = useRef(reducedMotion);
  const clickRef = useRef(onGroundClick);
  useEffect(() => {
    clickRef.current = onGroundClick;
  }, [onGroundClick]);

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
      scene.setTime(timeRef.current);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [scene, timeRef]);

  useEffect(() => {
    scene?.setLandscape(landscape);
  }, [scene, landscape]);
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

  const prompt = landscape ? MODE_PROMPT[mode] : undefined;

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
            The diorama needs WebGL, which appears to be disabled or unsupported here. Switch to
            the map view; the scenario and results still work.
          </p>
          <p className="studio-diorama__detail">{error}</p>
        </Panel>
      )}
      {!error && !landscape && (
        <Panel glass className="studio-diorama__card">
          {emptyState}
        </Panel>
      )}

      {!error && landscape && (
        <>
          <div className="studio-diorama__top">
            {prompt && (
              <Tag tone="brand" className="studio-diorama__pill">
                {prompt}
              </Tag>
            )}
            <ul className="studio-diorama__warnings" aria-label="Model warnings">
              {warnings.map((warning) => (
                <li key={warning}>
                  <Notice compact className="studio-diorama__warning">
                    <span aria-hidden="true">⚠</span> {warning}
                  </Notice>
                </li>
              ))}
            </ul>
          </div>
          {attribution.length > 0 && (
            <p className="studio-diorama__credit">Sources: {attribution.join(" · ")}</p>
          )}
          <div className="studio-diorama__tools">
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
                <p className="studio-diorama__legend-note">
                  Trees and houses symbolise LANDFIRE fuel classes; relief is exaggerated.
                </p>
              </Panel>
            )}
          </section>
        </>
      )}
    </div>
  );
}
