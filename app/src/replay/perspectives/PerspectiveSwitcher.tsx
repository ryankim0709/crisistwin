import { Button } from "../../ui";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayModel } from "../types";
import { buildRoadGraph } from "./geo";
import {
  ROAD_PICK_LAYERS,
  clearPerspective,
  prefersReducedMotion,
  setPerspective,
  type GroundHud,
  type PerspectiveContext,
  type PerspectiveMode,
} from "./perspective";
import "./perspectives.css";

export interface PerspectiveSwitcherProps {
  /** The replay map once its layers are installed; null while loading. */
  map: MapLibreMap | null;
  model: ReplayModel;
  frameIndex: number;
  perimeterIndex: number;
  simTimeMs: number;
}

const MODES: { mode: PerspectiveMode; label: string; title: string }[] = [
  { mode: "observer", label: "Top-down", title: "Top-down observer view" },
  { mode: "oblique", label: "3D oblique", title: "Tilted 3D view over terrain and aerial imagery" },
  {
    mode: "ground",
    label: "Ground POV",
    title: "Modelled drive along the busiest road (or click a road in 3D)",
  },
];

function formatDistance(m: number | null): string {
  if (m === null) return "no fire area in effect";
  if (m === 0) return "inside the fire area";
  return m < 1000 ? `≈ ${Math.round(m / 50) * 50} m` : `≈ ${(m / 1000).toFixed(1)} km`;
}

export default function PerspectiveSwitcher({
  map,
  model,
  frameIndex,
  perimeterIndex,
  simTimeMs,
}: PerspectiveSwitcherProps) {
  const [mode, setMode] = useState<PerspectiveMode>("observer");
  const [orbit, setOrbit] = useState(() => !prefersReducedMotion());
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [hud, setHud] = useState<GroundHud | null>(null);
  const live = useRef({ frameIndex, perimeterIndex, simTimeMs, orbit });
  useEffect(() => {
    live.current = { frameIndex, perimeterIndex, simTimeMs, orbit };
  }, [frameIndex, perimeterIndex, simTimeMs, orbit]);

  const graph = useMemo(() => buildRoadGraph(model), [model]);
  const ctx = useMemo<PerspectiveContext>(
    () => ({
      model,
      graph,
      frameIndex: () => live.current.frameIndex,
      perimeterIndex: () => live.current.perimeterIndex,
      simTimeMs: () => live.current.simTimeMs,
      orbit: () => live.current.orbit,
      edgeId,
      onGroundHud: setHud,
    }),
    [model, graph, edgeId],
  );

  useEffect(() => {
    if (!map) return;
    setPerspective(map, mode, ctx);
  }, [map, mode, ctx]);

  // Remove terrain, sky, layers and animation when the map goes away or this unmounts.
  useEffect(() => {
    if (!map) return;
    return () => clearPerspective(map);
  }, [map]);

  const choose = useCallback((next: PerspectiveMode) => {
    if (next !== "ground") setEdgeId(null);
    setMode(next);
  }, []);

  useEffect(() => {
    if (mode === "observer") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") choose("observer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, choose]);

  // In the 3D modes, clicking a road starts (or re-targets) the ground drive on that edge.
  useEffect(() => {
    if (!map || mode === "observer") return;
    const onClick = (event: MapMouseEvent) => {
      const layers = ROAD_PICK_LAYERS.filter((id) => map.getLayer(id));
      if (layers.length === 0) return;
      const id = map
        .queryRenderedFeatures(event.point, { layers })
        .find((f) => typeof f.properties?.id === "string")?.properties.id as string | undefined;
      if (!id || !graph.byId.has(id)) return;
      setEdgeId(id);
      setMode("ground");
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, mode, graph]);

  if (!map) return null;

  return (
    <>
      <div className="pv-switcher" role="group" aria-label="Camera perspective">
        {MODES.map(({ mode: m, label, title }) => (
          <Button
            key={m}
            variant="ghost"
            size="sm"
            className="pv-btn"
            aria-pressed={mode === m}
            title={title}
            onClick={() => choose(m)}
          >
            {label}
          </Button>
        ))}
        {mode === "oblique" && !prefersReducedMotion() && (
          <label className="pv-orbit">
            <input type="checkbox" checked={orbit} onChange={(e) => setOrbit(e.target.checked)} />{" "}
            Slow orbit
          </label>
        )}
        {mode !== "observer" && (
          <p className="pv-hint">Esc returns to top-down · click a road to drive it</p>
        )}
      </div>

      {mode !== "observer" && (
        <p className="pv-imagery-note" role="note">
          Terrain and aerial imagery are present-day context — imagery dates vary, not Nov 2018.
        </p>
      )}

      {mode === "ground" && (
        <>
          <p className="pv-modelled" role="note">
            Modelled scene — not imagery of real conditions
          </p>
          <section className="pv-hud" aria-label="Ground view details" aria-live="off">
            {hud ? (
              <dl>
                <dt>Road</dt>
                <dd>{hud.roadName}</dd>
                <dt>{hud.speedSource === "modelled" ? "Modelled speed" : "Free-flow speed"}</dt>
                <dd>
                  {hud.closed && hud.speedKph === 0
                    ? "closed (modelled)"
                    : `${hud.speedKph.toFixed(0)} km/h`}
                </dd>
                <dt>Modelled vehicles on edge</dt>
                <dd>{hud.vehicles.toLocaleString("en-US")}</dd>
                <dt>Fire area{hud.fireSource ? ` (${hud.fireSource})` : ""}</dt>
                <dd>{formatDistance(hud.fireDistanceM)}</dd>
              </dl>
            ) : (
              <p>
                {graph.edges.length === 0
                  ? "No road network in this bundle."
                  : "Positioning camera…"}
              </p>
            )}
            <p className="pv-hud-note">
              Simulated traffic; camera follows the road network, not a tracked vehicle.
            </p>
          </section>
        </>
      )}
    </>
  );
}
