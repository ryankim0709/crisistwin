/**
 * 3D diorama view of the /demo command board: the fire page's three.js miniature
 * (fire/diorama/FireDioramaScene.ts, ADR 0011) drawing the drill's prebuilt LANDFIRE region
 * with OSM roads and synthetic homes (fire/useBoardStreets.ts, as the Studio's 3D view), the
 * board's simulated fires as the fire solver's arrival field (dioramaField.ts) with a labelled pin per active
 * fire, and its units, stations and alerted zones (DemoBoardOverlay.ts). Presentation only:
 * the board's fires, units and households are simulated; trees, homes and relief are stylized.
 * Selection stays in the panels.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BurnedGlyph, FireEdgeGlyph, WindGlyph } from "../diorama/ui/glyphs";
import { useMediaQuery } from "../diorama/ui/format";
import { FireDioramaScene } from "../fire/diorama/FireDioramaScene";
import type { DioramaIgnition, FireDioramaSceneApi } from "../fire/diorama/types";
import type { LandscapeGrid } from "../fire/landscape";
import { sceneryOf, useBoardStreets } from "../fire/useBoardStreets";
import { CREW_COLORS, firelineCss } from "../studio/firelinePalette";
import { Button, Legend, Panel, type LegendItem } from "../ui";
import { EXTINGUISHED_LEGEND } from "../fire/diorama/board";
import { HOUSE_MARK_COLORS } from "../fire/diorama/cover";
import { DemoBoardOverlay, type DemoOverlayApi, type FollowedPersonLike, type PredictedFireRings } from "./DemoBoardOverlay";
import { APPARATUS_COLORS, DEMO_3D_COLORS, DESTINATION_COLORS, FOLLOW_COLORS, hexCss } from "./board3dPalette";
import {
  AirAttackGlyph,
  AirtankerGlyph,
  AmbulanceGlyph,
  CrewCarrierGlyph,
  DozerGlyph,
  DropGlyph,
  EngineGlyph,
  FireStationGlyph,
  FollowedPersonGlyph,
  ForecastRingGlyph,
  HelicopterGlyph,
  HikingCrewGlyph,
  SafeAreaGlyph,
  TenderGlyph,
} from "./boardLegendGlyphs";
import type { Selection } from "./DemoMap";
import { dioramaRun } from "./dioramaField";
import { fireOuterRings } from "./fireFootprint";
import { fireCellStates } from "./fireState";
import { assignHouses, safeHouseMarks, type HouseZones } from "./safeHouses";
import { activeFires, distanceM, teamPosition, type Board, type ZoneForecast } from "./model";
import { fireMapLabel } from "./boardResponse";
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
  /** /run: simulated people followed from phones (lead H1's FollowedPerson is structurally this). */
  followed?: readonly FollowedPersonLike[];
  /** /run: predicted fire perimeters at +30/+60/+120 min (dashed, labelled "forecast"). */
  predictedFire?: readonly PredictedFireRings[];
  /** Called with the board overlay's API once mounted (null on unmount), for pages that drive it imperatively. */
  onOverlay?: (api: DemoOverlayApi | null) => void;
}

function VehicleGlyph({ color, width, height }: { color: number; width: number; height: number }) {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x={12 - width / 2} y={13 - height} width={width} height={height} rx="1" fill={firelineCss(color)} />
    </svg>
  );
}

/** Green-roofed house with a white check on it (residents safe). */
function SafeHouseGlyph() {
  const roof = css(HOUSE_MARK_COLORS.safeRoof);
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <rect x="6" y="8" width="12" height="7" fill="var(--ct-surface)" stroke="var(--ct-ink-muted)" strokeWidth="1" />
      <path d="M4 9 12 2.5 20 9Z" fill={roof} stroke="var(--ct-ink-muted)" strokeWidth="0.8" />
      <path d="M8.8 6.4l2.1 1.9 4-4" fill="none" stroke={css(HOUSE_MARK_COLORS.check)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Put-out ground: slate with a pale diagonal hatch and a dashed outline, no glow. */
function ExtinguishedGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      <defs>
        <pattern id="dm-ext-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill={EXTINGUISHED_LEGEND.fill} />
          <line x1="0" y1="0" x2="0" y2="4" stroke={EXTINGUISHED_LEGEND.hatch} strokeWidth="1.4" />
        </pattern>
      </defs>
      <rect x="2" y="2" width="20" height="12" rx="2" fill="url(#dm-ext-hatch)" stroke={EXTINGUISHED_LEGEND.edge} strokeWidth="1.4" strokeDasharray="3 2" />
    </svg>
  );
}

/** A tiny standing firefighter: body in the unit's colour, yellow helmet. */
function FirefighterGlyph() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true">
      {[7, 12, 17].map((x) => (
        <g key={x}>
          <rect x={x - 1.4} y="7" width="2.8" height="7.5" rx="1.2" fill={css(CREW_COLORS.hand_crew)} />
          <circle cx={x} cy="5.2" r="1.9" fill={css(DEMO_3D_COLORS.crewHelmet)} stroke="var(--ct-ink-muted)" strokeWidth="0.6" />
        </g>
      ))}
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

export default function DemoDiorama({ board, version, field, landscape, regionName, forecasts, wind, selected, followed, predictedFire, onOverlay }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const reducedMotionRef = useRef(reducedMotion);
  const [overlay] = useState(() => new DemoBoardOverlay());
  const streets = useBoardStreets(landscape);
  const streetArea = sceneryOf(streets);

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
  const stationKey = board.stations.map((st) => `${st.id}@${st.location.join(",")}`).join("|");
  useEffect(() => {
    scene?.setStations(
      board.stations.map((st) => ({ id: st.id, label: st.name, lon: st.location[0], lat: st.location[1], air: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; stationKey marks changes
  }, [scene, stationKey]);
  useEffect(() => {
    scene?.setStreets(streetArea);
  }, [scene, streetArea]);
  useEffect(() => {
    // The solver's whole field (with its lookahead); setTime(board minute) shows only what has burned.
    scene?.setRun(field ? dioramaRun(field.field) : null);
    if (field) scene?.setTime(field.board.minute);
  }, [scene, field]);

  // The board is mutated in place; `version` marks each change (about 5 Hz while running).
  const ignitions = useMemo<DioramaIgnition[]>(
    () =>
      activeFires(board).map((fire) => ({
        id: fire.id,
        point: { longitude: fire.origin[0], latitude: fire.origin[1] },
        // "S1-F1 · not yet reported (sim)" before its report (boardResponse.ts report rule).
        label: fireMapLabel(board, fire),
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

  // /run: followed people and the predicted perimeters (props), and the imperative API (onOverlay).
  // A page driving the overlay through onOverlay only leaves these props undefined (no effect then).
  useEffect(() => {
    if (followed !== undefined) overlay.setFollowed(followed);
  }, [overlay, followed]);
  useEffect(() => {
    if (predictedFire !== undefined) overlay.setPredictedFire(predictedFire);
  }, [overlay, predictedFire]);
  useEffect(() => {
    if (!onOverlay) return;
    onOverlay(overlay);
    return () => onOverlay(null);
  }, [overlay, onOverlay]);

  // Per-cell fire states (burning / burned out / put out, fireState.ts); the cells must be the
  // scene's landscape's (the board's own), else the arrival field alone decides.
  useEffect(() => {
    if (!scene) return;
    const states = board.env.landscape === landscape ? fireCellStates(board) : null;
    scene.setCellStates(states);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  }, [scene, board, version, landscape, field]);

  // Residents safe: each zone's houses marked in proportion to its households out (safeHouses.ts).
  // Runs after setLandscape / setStreets above, so houseLocations() is the current cover's.
  const houseZones = useRef<{ key: string; index: HouseZones } | null>(null);
  useEffect(() => {
    if (!scene) return;
    const houses = scene.houseLocations();
    const key = board.zones.map((z) => `${z.id}:${z.ring.length}:${z.ring[0]?.join(",") ?? ""}`).join("|");
    let cached = houseZones.current;
    if (!cached || cached.index.houses !== houses || cached.key !== key) {
      cached = { key, index: assignHouses(houses, board.zones) };
      houseZones.current = cached;
    }
    scene.setHouseMarks(houses.length ? safeHouseMarks(cached.index, board) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  }, [scene, board, version, landscape, streetArea]);

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
    { label: "Burning now (simulated): glows, with flames and smoke", color: "var(--ct-fire)", glyph: <FireEdgeGlyph /> },
    { label: "Burned out (simulated): dark scar, no glow", color: "var(--ct-burned)", glyph: <BurnedGlyph /> },
    { label: "Put out by crews (simulated): slate with a pale hatch and a dashed outline, no glow", color: EXTINGUISHED_LEGEND.fill, glyph: <ExtinguishedGlyph /> },
    { label: "Firefighters at work (simulated): small figures in their unit's colour, yellow helmets, stepping in toward the fire", color: css(CREW_COLORS.hand_crew), glyph: <FirefighterGlyph /> },
    {
      label: "Residents safe (simulated): green roof with a white check, in proportion to the zone's households that got out",
      color: css(HOUSE_MARK_COLORS.safeRoof),
      glyph: <SafeHouseGlyph />,
    },
    { label: "Fire origin, with its id", color: "var(--ct-fire)", glyph: <FirePinGlyph /> },
    { label: "Engine (red truck with a white cab and light bar; drives only on roads it may use)", color: hexCss(APPARATUS_COLORS.engine), glyph: <EngineGlyph /> },
    { label: "Water tender (dark red truck with a round tank)", color: hexCss(APPARATUS_COLORS.tender), glyph: <TenderGlyph /> },
    { label: "Dozer (yellow, tracks and a front blade)", color: hexCss(APPARATUS_COLORS.dozer), glyph: <DozerGlyph /> },
    { label: "Hand crew carrier (long green crew truck with windows)", color: hexCss(APPARATUS_COLORS.hand_crew), glyph: <CrewCarrierGlyph /> },
    { label: "ALS ambulance (white box truck with a red stripe and cross; answers injuries only; out of service at hospital after a transport)", color: hexCss(APPARATUS_COLORS.ambulanceStripe), glyph: <AmbulanceGlyph /> },
    { label: "Crew hiking in on foot from where the truck parked (simulated)", color: hexCss(APPARATUS_COLORS.hand_crew), glyph: <HikingCrewGlyph /> },
    { label: "Helicopter (rotor; hovers low over drops and at its water dip)", color: hexCss(APPARATUS_COLORS.aircraftRed), glyph: <HelicopterGlyph /> },
    { label: "Airtanker (fixed wing, two engines; flies straight from its air base at altitude)", color: hexCss(APPARATUS_COLORS.aircraftRed), glyph: <AirtankerGlyph /> },
    { label: "Air attack / lead plane (small white plane with an orange band, circling high over the fire)", color: hexCss(APPARATUS_COLORS.airAttackBand), glyph: <AirAttackGlyph /> },
    { label: "Drop: retardant (pink, airtankers) or water (blue, helicopters) curtain below the aircraft; dark disc = its ground shadow", color: hexCss(APPARATUS_COLORS.retardant), glyph: <DropGlyph /> },
    { label: "Unit driving to a fire", color: css(DEMO_3D_COLORS.route), shape: "dashed" },
    { label: "Unit returning to its station (thin dashed; trip lines follow road routes only)", color: css(DEMO_3D_COLORS.route), shape: "dashed" },
    { label: "Fire line ahead of a fire: planned (dashed), built (solid)", color: css(DEMO_3D_COLORS.fireLine), shape: "line" },
    {
      label: "Evacuating vehicles on their road route (simulated; one car per 10+ vehicles)",
      color: css(DEMO_3D_COLORS.evacuee),
      glyph: <VehicleGlyph color={DEMO_3D_COLORS.evacuee} width={8} height={4} />,
    },
    { label: "Fire station (red firehouse with a white roof and a red beacon)", color: hexCss(DEMO_3D_COLORS.station), glyph: <FireStationGlyph /> },
    {
      label: "Safe area (green flag; gauge = cars arrived vs its capacity, grey when capacity is unknown; simulated)",
      color: hexCss(DESTINATION_COLORS.marker),
      glyph: <SafeAreaGlyph />,
    },
    ...(followed && followed.length > 0
      ? [{ label: "Followed person (simulated): pink pin with a white ring; path dashed, travelled part solid", color: hexCss(FOLLOW_COLORS.person), glyph: <FollowedPersonGlyph /> }]
      : []),
    ...(predictedFire && predictedFire.length > 0
      ? [{ label: "Fire forecast (model prediction): dashed perimeters at +30 / +60 / +120 min, darker = sooner", color: hexCss(FOLLOW_COLORS.forecast[0]), glyph: <ForecastRingGlyph /> }]
      : []),
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
                  Fires, units and households are simulated, not real data. Vehicles and aircraft are drawn about 20× too large to be seen, and aircraft heights are exaggerated.{" "}
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
