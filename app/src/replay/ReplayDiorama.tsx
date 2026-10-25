/**
 * The replay's 3D diorama view: the same historical fire as /fire (LANDFIRE terrain and fuels,
 * observed FEDS perimeters interpolated into an arrival raster, or the bundle's simulated run),
 * driven by the replay's own timeline clock, with the bundle's roads, homes and evacuation
 * zones drawn on the board. The replay dock scrubs and plays it; this component has no clock.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../diorama/ui/format";
import { BurnedGlyph, FireEdgeGlyph } from "../diorama/ui/glyphs";
import { FireDioramaScene } from "../fire/diorama/FireDioramaScene";
import type { BoardStreets, DioramaRun, FireDioramaSceneApi } from "../fire/diorama/types";
import { OBSERVED_ARRIVAL_LABEL } from "../historical/arrivalFromPerimeters";
import {
  errorMessage,
  useHistoricalFireData,
  type FireLayer,
} from "../historical/useHistoricalFireData";
import { Button, EvidenceTag, Legend, Notice, SegmentedControl, Spinner } from "../ui";
import "../fire/fire.css";
import { REPLAY_3D_COLORS, ReplayBoardOverlay, type ReplayZoneState } from "./ReplayBoardOverlay";
import type { HomeDot } from "./population";
import type { ReplayModel } from "./types";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** `DioramaRun.scenario.stepMinutes`: only sizes the glow band of the burning edge. */
const DIORAMA_STEP_MINUTES = 60;
const DAY_MINUTES = 24 * 60;

function formatElapsed(minutes: number): string {
  const days = Math.floor(minutes / DAY_MINUTES);
  const hours = Math.round((minutes - days * DAY_MINUTES) / 60);
  return days > 0 ? (hours ? `${days} d ${hours} h` : `${days} d`) : `${Math.round(minutes / 60)} h`;
}

export default function ReplayDiorama({
  model,
  fireId,
  simTimeMs,
  zoneStates,
  homeDots,
  onBackToMap,
}: {
  model: ReplayModel;
  /** The historical-fire id (`/historical-fires/<id>.json`); matches the replay incident id. */
  fireId: string;
  simTimeMs: number;
  zoneStates: ReadonlyMap<string, ReplayZoneState>;
  homeDots: readonly HomeDot[];
  onBackToMap: () => void;
}) {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [layer, setLayer] = useState<FireLayer>("observed");
  const { fire, landscape, simulated, observed, simulatedArrival, retry } = useHistoricalFireData(
    fireId,
    layer,
  );
  const [scene, setScene] = useState<FireDioramaSceneApi | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlay = useMemo(() => new ReplayBoardOverlay(), []);

  const fireData = fire.status === "ready" ? fire.value : null;
  const grid = landscape.status === "ready" ? landscape.value : null;
  const simulatedFile = fireData?.simulated_file ?? null;
  const showSimulated = layer === "simulated" && simulatedArrival !== null;

  const run = useMemo((): DioramaRun | null => {
    const arrivalMinutes = showSimulated ? simulatedArrival.arrival : observed?.arrivalMinutes;
    if (!arrivalMinutes) return null;
    const horizonMinutes = showSimulated
      ? Math.max(60, Math.ceil(simulatedArrival.lastMinute / 30) * 30)
      : (observed?.horizonMinutes ?? DAY_MINUTES);
    return { arrivalMinutes, scenario: { horizonMinutes, stepMinutes: DIORAMA_STEP_MINUTES } };
  }, [showSimulated, simulatedArrival, observed]);

  // The replay clock as minutes after the fire's first ignition (the diorama's T+0).
  const minutes = fireData ? Math.max(0, (simTimeMs - Date.parse(fireData.t0)) / 60_000) : 0;

  // The bundle's roads and one illustrative home per dot, drawn in place of the stylised lattice.
  const streets = useMemo((): BoardStreets | null => {
    const edges = model.roads?.items ?? [];
    if (edges.length === 0 && homeDots.length === 0) return null;
    return {
      edges: edges.map((e) => ({ roadClass: e.highway ?? "residential", coords: e.coords })),
      homes: homeDots.map((d) => ({ position: d.coord })),
    };
  }, [model.roads, homeDots]);

  // Scene lifecycle.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let created: FireDioramaSceneApi;
    try {
      created = new FireDioramaScene(host, { reducedMotion });
    } catch (cause) {
      setSceneError(errorMessage(cause, "WebGL could not be initialised."));
      return;
    }
    created.setOverlay(overlay);
    setScene(created);
    return () => {
      setScene(null);
      created.dispose();
    };
    // The scene is built once; reduced motion is pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay]);

  useEffect(() => scene?.setReducedMotion(reducedMotion), [scene, reducedMotion]);
  // No wind is recorded with the perimeters, so the scene's wind arrow would invent one.
  useEffect(() => scene?.setWindVisible(false), [scene]);
  useEffect(() => scene?.setLandscape(grid), [scene, grid]);
  useEffect(() => scene?.setStreets(streets), [scene, streets, grid]);
  useEffect(() => {
    scene?.setRun(run);
    scene?.setTime(minutes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, run]);
  useEffect(() => scene?.setTime(minutes), [scene, minutes]);
  useEffect(() => {
    scene?.setIgnitions(
      fireData
        ? fireData.ignitions.map((ig) => ({
            id: ig.id,
            point: { longitude: ig.coord[0], latitude: ig.coord[1] },
            label: fireData.ignitions.length > 1 ? ig.name : "",
          }))
        : [],
    );
  }, [scene, fireData]);
  useEffect(() => overlay.setZones(model.zones?.items ?? [], zoneStates), [overlay, model.zones, zoneStates]);
  useEffect(() => {
    if (scene && grid) scene.resetView(false);
  }, [scene, grid]);

  // Keep the camera framing clear of the replay dock.
  useEffect(() => {
    const stage = hostRef.current?.parentElement;
    const dock = stage?.querySelector<HTMLElement>(".rp-dock");
    if (!stage || !scene) return;
    const measure = () => {
      const bottom = dock ? Math.max(0, stage.getBoundingClientRect().bottom - dock.getBoundingClientRect().top) : 0;
      scene.setViewInsets({ top: 0, right: 0, bottom, left: 0 });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    if (dock) observer.observe(dock);
    measure();
    return () => observer.disconnect();
  }, [scene]);

  const failed = fire.status === "error" || landscape.status === "error";
  const loadingText =
    fire.status === "loading"
      ? "Loading the fire record…"
      : landscape.status === "loading" && fireData
        ? "Building the 3D terrain from LANDFIRE fuels and elevation. This can take a minute the first time."
        : null;
  const hasZones = (model.zones?.items.length ?? 0) > 0;
  const beforeIgnition = fireData !== null && simTimeMs < Date.parse(fireData.t0);

  return (
    <div className="rd-wrap">
      <div
        className="fr-scene rd-scene"
        ref={hostRef}
        role="group"
        aria-label={`3D landscape of the ${model.incident.name ?? "fire"}`}
      />

      {sceneError && (
        <div className="fr-error fr-panel" role="alert">
          <p className="fr-error-title">3D view unavailable in this browser</p>
          <p>The diorama needs WebGL, which appears to be disabled or unsupported here.</p>
          <div className="fr-error-actions">
            <Button variant="secondary" onClick={onBackToMap}>
              Back to map
            </Button>
          </div>
        </div>
      )}

      {loadingText && !sceneError && !failed && (
        <div className="fr-veil" role="status">
          <Spinner size="lg" />
          <p>{loadingText}</p>
        </div>
      )}

      {failed && (
        <div className="fr-error fr-panel" role="alert">
          <p className="fr-error-title">The 3D view could not be loaded</p>
          <p>
            {fire.status === "error"
              ? fire.message
              : landscape.status === "error"
                ? landscape.message
                : ""}
          </p>
          <div className="fr-error-actions">
            <Button onClick={retry}>Try again</Button>
            <Button variant="secondary" onClick={onBackToMap}>
              Back to map
            </Button>
          </div>
        </div>
      )}

      <section className="rd-card fr-panel" aria-label="3D view fire layer">
        <SegmentedControl
          label="Fire layer"
          options={[
            { value: "observed", label: "Observed" },
            {
              value: "simulated",
              label: "Simulated",
              disabled: !simulatedFile,
              title: simulatedFile
                ? "Model run from the replay bundle"
                : "No simulated run was built for this fire",
            },
          ]}
          value={layer}
          onChange={setLayer}
        />
        {layer === "observed" ? (
          <p className="rd-note">
            <EvidenceTag kind="observed" /> {OBSERVED_ARRIVAL_LABEL}. Satellite perimeters are
            half-day snapshots; the front between them is interpolated.
          </p>
        ) : simulated?.status === "loading" ? (
          <p className="rd-note" role="status">
            <Spinner /> Loading the simulated run…
          </p>
        ) : simulated?.status === "error" ? (
          <Notice tone="danger" compact>
            {simulated.message}
          </Notice>
        ) : simulatedArrival ? (
          <p className="rd-note">
            <EvidenceTag kind="simulated" /> Model run, not observed. Covers 0 to{" "}
            {formatElapsed(simulatedArrival.lastMinute)} after ignition; the fire shows fully burned
            after that.
          </p>
        ) : null}
        {beforeIgnition && <p className="rd-note">Before ignition: nothing has burned yet.</p>}
      </section>

      <section className="rd-legend fr-panel" aria-label="3D view legend">
        <Legend
          items={[
            { label: "Fire front", color: "var(--ct-fire)", glyph: <FireEdgeGlyph /> },
            { label: "Burned", color: "var(--ct-burned)", glyph: <BurnedGlyph /> },
            ...(hasZones
              ? [
                  { label: "Evacuation order", color: REPLAY_3D_COLORS.ordered, shape: "line" as const },
                  { label: "Evacuation warning", color: REPLAY_3D_COLORS.warned, shape: "dashed" as const },
                ]
              : []),
          ]}
        />
        <p className="rd-note">
          Roads from the replay bundle; homes are illustrative placeholders, not buildings. Vehicle
          traffic is on the map view only. Perimeters: NASA FEDS · Fuel: LANDFIRE · Terrain: AWS
          terrain tiles.
        </p>
      </section>

    </div>
  );
}
