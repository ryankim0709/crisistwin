/**
 * 3D diorama view of the /demo command board: the fire page's three.js miniature
 * (fire/diorama/FireDioramaScene.ts, ADR 0011) drawing the drill's prebuilt LANDFIRE region
 * with OSM roads and synthetic homes (fire/useBoardStreets.ts, as the Studio's 3D view), the
 * board's simulated fires as an arrival field (dioramaField.ts) with a labelled pin per active
 * fire, and its units, stations and alerted zones (DemoBoardOverlay.ts). Presentation only:
 * the board's fires, units and households are simulated; trees, homes and relief are stylized.
 * Clicking the board starts a fire while "Add fire" is on; other selection stays in the panels.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BurnedGlyph, FireEdgeGlyph, StationGlyph, WindGlyph } from "../diorama/ui/glyphs";
import { useMediaQuery } from "../diorama/ui/format";
import { FireDioramaScene } from "../fire/diorama/FireDioramaScene";
import type { DioramaIgnition, FireDioramaSceneApi } from "../fire/diorama/types";
import type { LandscapeGrid } from "../fire/landscape";
import { useBoardStreets } from "../fire/useBoardStreets";
import type { LonLat } from "../live/types";
import { CREW_COLORS, firelineCss } from "../studio/firelinePalette";
import { Button, Legend, Panel, type LegendItem } from "../ui";
import { DEMO_3D_COLORS, DemoBoardOverlay } from "./DemoBoardOverlay";
import type { Selection } from "./DemoMap";
import { dioramaRun } from "./dioramaField";
import { fireOuterRings } from "./fireFootprint";
import { activeFires, distanceM, teamPosition, type Board, type ZoneForecast } from "./model";
import type { ArrivalFieldState } from "./useArrivalField";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MPH_PER_METER_PER_SECOND = 2.236_936;
/** Room kept clear at the bottom of the view for the view toggle and legend, CSS px. */
const INSETS = { top: 12, right: 12, bottom: 56, left: 12 };
/** Ground radius framed around a selected unit, metres; a fire is framed by its size. */
const UNIT_FOCUS_M = 600;
const MIN_FIRE_FOCUS_M = 400;

interface Props {
  /** Mutated in place by the page; `version` increments whenever it changed. */
  board: Board;
  version: number;
  /** The board's arrival field on `landscape` (useArrivalField). */
  field: ArrivalFieldState | null;
  landscape: LandscapeGrid;
  regionName: string | null;
  forecasts: Map<string, ZoneForecast>;
  wind: { speedMetersPerSecond: number; fromDegrees: number } | null;
  selected: Selection | null;
  igniteMode: boolean;
  onIgnite: (coord: LonLat) => void;
}

function VehicleGlyph({ color, width, height }: { color: number; width: number; height: number }) {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x={12 - width / 2} y={13 - height} width={width} height={height} rx="1" fill={firelineCss(color)} />
    </svg>
  );
}

function FirePinGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <path d="M12 15V7" stroke="var(--ct-ink-muted)" strokeWidth="1.4" />
      <circle cx="12" cy="5" r="3.6" fill="var(--ct-fire)" stroke="var(--ct-surface)" strokeWidth="1.2" />
    </svg>
  );
}

const css = (color: number | string) => (typeof color === "number" ? firelineCss(color) : color);

export default function DemoDiorama({ board, version, field, landscape, regionName, forecasts, wind, selected, igniteMode, onIgnite }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const reducedMotionRef = useRef(reducedMotion);
  const [overlay] = useState(() => new DemoBoardOverlay());
  const streets = useBoardStreets(landscape);
  const streetArea = streets.status === "ready" ? streets.area : null;

  const clickRef = useRef({ igniteMode, onIgnite });
  useEffect(() => {
    clickRef.current = { igniteMode, onIgnite };
  }, [igniteMode, onIgnite]);

  // StrictMode-safe: the cleanup disposes, the re-run builds a fresh scene.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let created: FireDioramaSceneApi;
    try {
      created = new FireDioramaScene(host, { reducedMotion: reducedMotionRef.current });
    } catch (cause) {
      console.error("Demo diorama scene could not start", cause);
      setError(cause instanceof Error ? cause.message : "WebGL could not be initialised.");
      return;
    }
    created.onGroundClick((point) => {
      if (clickRef.current.igniteMode) clickRef.current.onIgnite([point.longitude, point.latitude]);
    });
    created.setOverlay(overlay);
    setScene(created);
    setError(null);
    return () => {
      setScene(null);
      created.dispose();
    };
  }, [overlay]);

  useEffect(() => {
    scene?.setLandscape(landscape);
  }, [scene, landscape]);
  useEffect(() => {
    scene?.setStreets(streetArea);
  }, [scene, streetArea]);
  useEffect(() => {
    scene?.setRun(field ? dioramaRun(field.field) : null);
    if (field) scene?.setTime(field.board.minute);
  }, [scene, field]);

  // The board is mutated in place; `version` marks each change (about 5 Hz while running).
  const ignitions = useMemo<DioramaIgnition[]>(
    () =>
      activeFires(board).map((fire) => ({
        id: fire.id,
        point: { longitude: fire.origin[0], latitude: fire.origin[1] },
        label: fire.status === "burning" ? fire.id : `${fire.id} · ${fire.status}`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
    [board, version],
  );
  useEffect(() => {
    scene?.setIgnitions(ignitions);
  }, [scene, ignitions]);
  useEffect(() => {
    scene?.setTime(board.minute);
    overlay.setBoard(board, forecasts);
  }, [scene, overlay, board, version, forecasts]);
  useEffect(() => () => overlay.setBoard(null, new Map()), [overlay]);

  const windFrom = wind?.fromDegrees ?? 0;
  const windMph = (wind?.speedMetersPerSecond ?? 0) * MPH_PER_METER_PER_SECOND;
  useEffect(() => {
    scene?.setWind(windFrom, windMph);
  }, [scene, windFrom, windMph]);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    scene?.setReducedMotion(reducedMotion);
  }, [scene, reducedMotion]);
  useEffect(() => {
    scene?.setViewInsets(INSETS);
  }, [scene]);

  // Selecting a fire or a unit in the panels frames it on the board.
  const selectedKind = selected?.kind ?? null;
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (!scene || !selectedId) return;
    if (selectedKind === "fire") {
      const fire = board.fires.find((f) => f.id === selectedId);
      if (!fire) return;
      let reach = 0;
      for (const ring of fireOuterRings(board, fire)) for (const p of ring) reach = Math.max(reach, distanceM(fire.origin, p));
      scene.focusOn({ longitude: fire.origin[0], latitude: fire.origin[1] }, Math.max(MIN_FIRE_FOCUS_M, 1.5 * reach));
    } else if (selectedKind === "team") {
      const team = board.teams.find((t) => t.id === selectedId);
      if (!team) return;
      const [longitude, latitude] = teamPosition(board, team);
      scene.focusOn({ longitude, latitude }, UNIT_FOCUS_M);
    } else if (selectedKind === "zone") {
      const zone = board.zones.find((z) => z.id === selectedId);
      if (zone) scene.focusOn({ longitude: zone.core[0], latitude: zone.core[1] }, UNIT_FOCUS_M * 2);
    }
  }, [scene, board, selectedKind, selectedId]);

  const sources = [
    ...new Set([landscape.attribution.fuel, landscape.attribution.terrain].filter(Boolean)),
    ...(streetArea ? ["Roads © OpenStreetMap contributors"] : []),
  ];
  const legend: LegendItem[] = [
    { label: "Simulated fire, burning edge (glows)", color: "var(--ct-fire)", glyph: <FireEdgeGlyph /> },
    { label: "Burned by a simulated fire (stays as a scar)", color: "var(--ct-burned)", glyph: <BurnedGlyph /> },
    { label: "Fire origin, with its id", color: "var(--ct-fire)", glyph: <FirePinGlyph /> },
    {
      label: "Engine (long red block)",
      color: css(CREW_COLORS.engine),
      glyph: <VehicleGlyph color={CREW_COLORS.engine} width={16} height={6} />,
    },
    {
      label: "Hand crew (tall green block)",
      color: css(CREW_COLORS.hand_crew),
      glyph: <VehicleGlyph color={CREW_COLORS.hand_crew} width={12} height={9} />,
    },
    {
      label: "Dozer (low wide yellow block)",
      color: css(CREW_COLORS.dozer),
      glyph: <VehicleGlyph color={CREW_COLORS.dozer} width={13} height={5} />,
    },
    { label: "Unit driving to a fire", color: css(DEMO_3D_COLORS.route), shape: "dashed" },
    { label: "Station (free units listed by its name)", color: css(DEMO_3D_COLORS.stationRoof), glyph: <StationGlyph /> },
    { label: "Leave now zone (outline)", color: css(DEMO_3D_COLORS.ordered), shape: "line" },
    { label: "At risk zone (dashed outline)", color: css(DEMO_3D_COLORS.threatened), shape: "dashed" },
    { label: "Overrun zone (thick outline)", color: css(DEMO_3D_COLORS.overrun), shape: "line" },
    { label: "Wind, pointing downwind", color: "var(--ct-ink)", glyph: <WindGlyph bearing={(windFrom + 180) % 360} /> },
  ];

  return (
    <div className="dm-diorama">
      <div
        ref={hostRef}
        className="dm-diorama__scene"
        role="group"
        aria-label="3D view of the simulated command board. Use the fire and unit lists to select; click the board to start a fire while Add fire is on."
        aria-hidden={error !== null}
      />

      {error ? (
        <Panel glass className="dm-diorama__card" role="alert">
          <p className="dm-diorama__card-title">3D view unavailable in this browser</p>
          <p>The diorama needs WebGL, which appears to be disabled or unsupported here. Switch to the map view; the board keeps running.</p>
          <p className="dm-diorama__detail">{error}</p>
        </Panel>
      ) : (
        <>
          <div className="dm-diorama__tools">
            <Button variant="secondary" size="sm" onClick={() => scene?.resetView(false)}>
              Whole board
            </Button>
            <Button variant="secondary" size="sm" onClick={() => scene?.resetView(true)} disabled={ignitions.length === 0}>
              Frame fires
            </Button>
          </div>

          <p className="dm-diorama__credit">
            Simulated fires, units and households on a stylized miniature
            {regionName ? ` of the prebuilt region "${regionName}"` : ""} · Sources: {sources.join(" · ")}
            {streets.status === "loading" ? " · Loading roads…" : ""}
          </p>

          <section className="dm-diorama__legend" aria-label="3D view legend">
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={legendOpen}
              aria-controls="dm-diorama-legend"
              onClick={() => setLegendOpen((open) => !open)}
            >
              {legendOpen ? "Hide legend" : "Legend"}
            </Button>
            {legendOpen ? (
              <Panel glass compact id="dm-diorama-legend" className="dm-diorama__legend-list">
                <Legend label="3D view legend items" items={legend} />
                <p className="dm-diorama__legend-note">
                  Fires, units and households are simulated, not real data. Vehicles are drawn about 20× too large to be seen.{" "}
                  {streetArea
                    ? "Trees symbolise LANDFIRE fuel classes; homes are placeholders along OSM residential streets, not real buildings. Relief is exaggerated."
                    : "Trees and houses symbolise LANDFIRE fuel classes; relief is exaggerated."}
                </p>
              </Panel>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
