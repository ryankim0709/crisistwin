import {
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type MapGeoJSONFeature,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BASEMAP_STYLE_URL,
  FALLBACK_STYLE,
  INTERACTIVE_LAYERS,
  ROAD_CLASS_BY_CODE,
  ROAD_CLASS_LABEL,
  applyTrafficFrame,
  applyClosedState,
  applyThreatState,
  pinCollection,
  setThreatPulse,
  closedLabelCollection,
  installLayers,
  particlesCollection,
  perimeterCollection,
  perimeterHistoryCollection,
  setBasemap,
  setGroupVisibility,
  setPerimeterFreshness,
  setSourceData,
  simulatedFrontCollection,
  trafficToRoadIndex,
  zonesCollection,
  type Basemap as BasemapChoice,
  type BasemapStyle,
  type LayerGroup,
} from "./mapLayers";
import { buildEdgePath, buildTravelIndex, particlePositions, type EdgePath } from "./particles";
import PerspectiveSwitcher from "./perspectives/PerspectiveSwitcher";
import { edgeThreats } from "./insights";
import { EVIDENCE_LABEL, closedEdgesAt, sameNumbers } from "./timeline";
import type { EvidenceClass, LngLat, ReplayModel } from "./types";

// Same explicit worker bundling as maps/MapCanvas.tsx; Vite relocates the main module.
setWorkerUrl(workerUrl);

const STYLE_TIMEOUT_MS = 10_000;
const FRESHNESS_BUCKET_MS = 10 * 60_000;
const THREAT_BUCKET_MS = 60_000;
const PULSE_PERIOD_MS = 1400;
const PULSE_INTERVAL_MS = 80;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** A request to frame some coordinates; `key` changes to re-trigger the same target. */
export interface MapFocus {
  key: number;
  coords: LngLat[];
}

type StyleStatus = "loading" | "ok" | "fallback";

async function loadBasemapStyle(signal: AbortSignal): Promise<BasemapStyle | null> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), STYLE_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal.addEventListener("abort", abort);
  try {
    const response = await fetch(BASEMAP_STYLE_URL, { signal: timeout.signal });
    if (!response.ok) return null;
    const style: unknown = await response.json();
    if (
      typeof style !== "object" ||
      style === null ||
      !("version" in style) ||
      style.version !== 8 ||
      !("layers" in style) ||
      !Array.isArray(style.layers)
    ) {
      return null;
    }
    return style as BasemapStyle;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function fmt(n: unknown, digits = 0): string {
  return typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
}

function tooltipContent(feature: MapGeoJSONFeature, perParticle: number): HTMLElement {
  const p = feature.properties as Record<string, unknown>;
  const root = document.createElement("div");
  root.className = "rp-tip";
  const add = (tag: string, text: string, className?: string) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    root.appendChild(el);
  };
  switch (feature.layer.id) {
    case "fire-fill":
      add("strong", "Fire perimeter in effect");
      add("span", `${fmt(p.area_km2, 1)} km² · ${EVIDENCE_LABEL[p.evidence_class as EvidenceClass] ?? String(p.evidence_class)}`);
      add("span", "Shape held until the next snapshot; no interpolation.", "rp-tip-note");
      break;
    case "roads-flow": {
      const state = feature.state as { veh?: number; speed?: number | null; cls?: number };
      const veh = state.veh ?? 0;
      add("strong", `${String(p.name)}${p.bridge ? " · bridge" : ""}`);
      add("span", ROAD_CLASS_LABEL[ROAD_CLASS_BY_CODE[state.cls ?? 0] ?? "idle"]);
      if (veh > 0) {
        add("span", `${fmt(veh)} modelled vehicles · ${fmt(state.speed, 1)} of ${fmt(p.speed_kph)} km/h`);
        add("span", "Simulated traffic, not recorded movement.", "rp-tip-note");
      } else {
        add("span", `Free-flow speed ${fmt(p.speed_kph)} km/h`);
      }
      break;
    }
    case "roads-threat": {
      const state = feature.state as { threat?: number };
      add("strong", String(p.name));
      add("span", state.threat === 2 ? "Modelled fire arrival within 10 min" : "Modelled fire arrival within 30 min");
      add("span", "From the simulated fire front; not an observation.", "rp-tip-note");
      break;
    }
    case "roads-closed": {
      const state = feature.state as { veh?: number };
      add("strong", `${String(p.name)}${p.bridge ? " · bridge" : ""}`);
      add("span", "Closed at this time (event or modelled fire hazard)");
      if ((state.veh ?? 0) > 0) add("span", `${fmt(state.veh)} modelled vehicles held on this edge`);
      break;
    }
    case "sim-front-fill":
      add("strong", "Simulated fire front (model output)");
      add("span", `${fmt(p.area_km2, 1)} km² · from an assumed ignition`);
      add("span", "Not an observation; shown only before the first satellite perimeter.", "rp-tip-note");
      break;
    case "sim-ignition":
      add("strong", "Assumed ignition (model input)");
      if (p.provenance) add("span", String(p.provenance));
      break;
    case "particles":
    case "particles-halo":
      add("strong", "Illustrative vehicle dots");
      add("span", `1 dot ≈ ${perParticle} modelled vehicle${perParticle === 1 ? "" : "s"}`);
      add("span", "Illustrates modelled counts; not tracked vehicles.", "rp-tip-note");
      break;
    case "zones-fill":
      add("strong", String(p.name));
      add("span", p.state === "ordered" ? "Evacuation order issued" : p.state === "warned" ? "Warning issued" : "No order yet");
      add("span", `${fmt(p.households)} households · ${fmt(p.vehicles)} vehicles`);
      break;
    case "destinations":
      add("strong", String(p.name));
      add("span", `${String(p.dest_kind).replace(/_/g, " ")} · capacity ${p.capacity_veh == null ? "unbounded" : fmt(p.capacity_veh)}`);
      break;
    case "damage":
      add("strong", String(p.damage ?? "Damage assessment"));
      if (p.structure_category) add("span", String(p.structure_category));
      add("span", "Post-fire assessment (no damage time).", "rp-tip-note");
      break;
  }
  return root;
}

export interface ReplayMapProps {
  model: ReplayModel;
  simTimeMs: number;
  perimeterIndex: number;
  frameIndex: number;
  simFrontIndex: number;
  /** Multiplier on displayed dot motion; see particlePositions. */
  motionScale: number;
  zoneStates: Map<string, "ordered" | "warned">;
  visibility: Record<LayerGroup, boolean>;
  onParticleScale: (vehiclesPerDot: number | null) => void;
  /** Evacuee pin location, or null. */
  pin: LngLat | null;
  /** Called with the clicked location when map picking is enabled. */
  onPick: ((p: LngLat) => void) | null;
  focus: MapFocus | null;
  basemapChoice: BasemapChoice;
  /** Receives the map once replay layers are installed, and null when it is removed. */
  onMapReady?: (map: MapLibreMap | null) => void;
}

export default function ReplayMap({
  model,
  simTimeMs,
  perimeterIndex,
  frameIndex,
  simFrontIndex,
  motionScale,
  zoneStates,
  visibility,
  onParticleScale,
  onMapReady,
  pin,
  onPick,
  focus,
  basemapChoice,
}: ReplayMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const perParticleRef = useRef(1);
  const stateRoadsRef = useRef<Set<number>>(new Set());
  const shownClosedRef = useRef<number[] | null>(null);
  const closedRoadsRef = useRef<Set<number>>(new Set());
  const [ready, setReady] = useState(false);
  // The installed map, as state so overlays (e.g. perspectives/) can receive it as a prop.
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const onMapReadyRef = useRef(onMapReady);
  const onPickRef = useRef(onPick);
  const threatRoadsRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    onMapReadyRef.current = onMapReady;
    onPickRef.current = onPick;
  }, [onMapReady, onPick]);
  const [styleStatus, setStyleStatus] = useState<StyleStatus>("loading");
  const [mapError, setMapError] = useState<string | null>(null);

  const trafficToRoad = useMemo(() => trafficToRoadIndex(model), [model]);
  const edgePaths = useMemo<(EdgePath | null)[]>(() => {
    if (!model.traffic || !model.roads) return [];
    const byId = new Map(model.roads.items.map((edge) => [edge.id, edge]));
    return model.traffic.edgeIds.map((id) => {
      const edge = byId.get(id);
      return edge ? buildEdgePath(edge) : null;
    });
  }, [model]);
  const travelIndex = useMemo(
    () => (model.traffic ? buildTravelIndex(model.traffic.frames, edgePaths, model.traffic.closures) : []),
    [model, edgePaths],
  );

  // Create the map once per bundle; remove it and its listeners on unmount.
  useEffect(() => {
    const controller = new AbortController();
    let map: MapLibreMap | null = null;
    let resize: ResizeObserver | null = null;
    let cancelled = false;

    loadBasemapStyle(controller.signal).then((style) => {
      const container = containerRef.current;
      if (cancelled || !container) return;
      setStyleStatus(style ? "ok" : "fallback");
      let m: MapLibreMap;
      try {
        m = new MapLibreMap({
          container,
          style: style ?? FALLBACK_STYLE,
          bounds: model.bbox,
          fitBoundsOptions: { padding: 48 },
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
        });
      } catch (error) {
        setMapError(error instanceof Error ? error.message : "WebGL map could not start.");
        return;
      }
      map = m;
      mapRef.current = m;
      m.addControl(new NavigationControl({ showCompass: false }), "top-right");
      m.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
      m.on("load", () => {
        if (cancelled) return;
        installLayers(m, model);
        setReady(true);
        setMapInstance(m);
        onMapReadyRef.current?.(m);
      });

      const popup = new Popup({
        closeButton: false,
        closeOnClick: false,
        className: "rp-popup",
        offset: 10,
        maxWidth: "260px",
      });
      m.on("mousemove", (event) => {
        const layers = INTERACTIVE_LAYERS.filter((id) => m.getLayer(id));
        // roads-flow covers the whole network (transparent where empty); skip empty edges.
        const feature = m
          .queryRenderedFeatures(event.point, { layers })
          .find((f) => {
            const state = f.state as { veh?: number; closed?: boolean };
            if (f.layer.id === "roads-flow") return (state.veh ?? 0) > 0;
            if (f.layer.id === "roads-closed") return state.closed === true;
            if (f.layer.id === "roads-threat") return ((f.state as { threat?: number }).threat ?? 0) > 0;
            return true;
          });
        if (!feature) {
          popup.remove();
          m.getCanvas().style.cursor = onPickRef.current ? "crosshair" : "";
          return;
        }
        m.getCanvas().style.cursor = "pointer";
        popup.setLngLat(event.lngLat).setDOMContent(tooltipContent(feature, perParticleRef.current)).addTo(m);
      });
      m.on("mouseout", () => popup.remove());
      m.on("click", (event) => onPickRef.current?.([event.lngLat.lng, event.lngLat.lat]));
      // The panel collapses and the dock reflows, so track container size explicitly.
      resize = new ResizeObserver(() => m.resize());
      resize.observe(container);
    });

    return () => {
      cancelled = true;
      controller.abort();
      resize?.disconnect();
      if (map) onMapReadyRef.current?.(null);
      map?.remove();
      mapRef.current = null;
    };
  }, [model]);

  const perimeter = perimeterIndex >= 0 ? model.perimeters[perimeterIndex] : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setSourceData(map, "fire", perimeterCollection(perimeter));
    setSourceData(map, "fire-history", perimeterHistoryCollection(model.perimeters, perimeterIndex));
  }, [ready, model, perimeter, perimeterIndex]);

  const freshnessBucket = perimeter
    ? Math.floor((simTimeMs - perimeter.atMs) / FRESHNESS_BUCKET_MS)
    : 0;
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setPerimeterFreshness(map, freshnessBucket * FRESHNESS_BUCKET_MS);
  }, [ready, freshnessBucket]);

  const simFront = simFrontIndex >= 0 ? (model.fireSimulated?.fronts[simFrontIndex] ?? null) : null;
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setSourceData(map, "sim-front", simulatedFrontCollection(simFront));
  }, [ready, simFront]);

  const frame = model.traffic && frameIndex >= 0 ? model.traffic.frames[frameIndex] : null;
  const closed = useMemo(
    () => (model.traffic ? closedEdgesAt(model.traffic.closures, frameIndex) : []),
    [model, frameIndex],
  );
  const closedSet = useMemo(() => new Set(closed), [closed]);

  // Closed edges change only at closure boundaries; skip setData when the set is unchanged.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const shown = shownClosedRef.current;
    if (shown && sameNumbers(shown, closed)) return;
    shownClosedRef.current = closed;
    closedRoadsRef.current = applyClosedState(map, trafficToRoad, closed, closedRoadsRef.current);
    setSourceData(map, "roads-closed-labels", closedLabelCollection(model, trafficToRoad, closed));
  }, [ready, model, trafficToRoad, closed]);

  // The road network is large and static; congestion is pushed as feature-state per frame.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    stateRoadsRef.current = applyTrafficFrame(
      map,
      model,
      trafficToRoad,
      frame,
      closedSet,
      stateRoadsRef.current,
    );
  }, [ready, model, trafficToRoad, frame, closedSet]);

  // Threat cues: roads the model expects fire to reach within 30 / 10 minutes of the clock.
  const threatBucket = Math.floor(simTimeMs / THREAT_BUCKET_MS);
  const threats = useMemo(
    () => edgeThreats(model, threatBucket * THREAT_BUCKET_MS),
    [model, threatBucket],
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    threatRoadsRef.current = applyThreatState(map, trafficToRoad, threats, threatRoadsRef.current);
  }, [ready, trafficToRoad, threats]);

  // Cosmetic pulse on wall-clock time; it carries no data. Off for reduced motion.
  const hasThreats = threats.size > 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !hasThreats || !visibility.roads || prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      const phase = 0.5 + 0.5 * Math.sin((performance.now() / PULSE_PERIOD_MS) * 2 * Math.PI);
      setThreatPulse(map, phase);
    }, PULSE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ready, hasThreats, visibility.roads]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setBasemap(map, basemapChoice);
  }, [ready, basemapChoice]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setSourceData(map, "pin", pinCollection(pin));
  }, [ready, pin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus || focus.coords.length === 0) return;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of focus.coords) {
      w = Math.min(w, x);
      s = Math.min(s, y);
      e = Math.max(e, x);
      n = Math.max(n, y);
    }
    map.fitBounds(
      [w, s, e, n],
      { padding: 120, maxZoom: 15, duration: prefersReducedMotion() ? 0 : 1600, essential: true },
    );
  }, [ready, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) map.getCanvas().style.cursor = onPick ? "crosshair" : "";
  }, [ready, onPick]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setSourceData(map, "zones", zonesCollection(model.zones?.items ?? [], zoneStates));
  }, [ready, model, zoneStates]);

  // Particles are a pure function of the simulation clock, updated whenever it moves.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!frame || !visibility.particles) {
      setSourceData(map, "particles", particlesCollection([], []));
      onParticleScale(frame ? perParticleRef.current : null);
      return;
    }
    const { coords, stopped, perParticle } = particlePositions({
      paths: edgePaths,
      frame,
      offsets: travelIndex[frameIndex],
      simTimeMs,
      closed: closedSet,
      motionScale,
    });
    perParticleRef.current = perParticle;
    onParticleScale(perParticle);
    setSourceData(map, "particles", particlesCollection(coords, stopped));
  }, [
    ready,
    frame,
    frameIndex,
    travelIndex,
    simTimeMs,
    edgePaths,
    closedSet,
    motionScale,
    visibility.particles,
    onParticleScale,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const group of Object.keys(visibility) as LayerGroup[]) {
      setGroupVisibility(map, group, visibility[group]);
    }
  }, [ready, visibility]);

  return (
    <div className="rp-map-wrap">
      <div
        ref={containerRef}
        className="rp-map"
        role="region"
        aria-label={`Map of ${model.incident.name}: fire perimeter, roads and evacuation overlays`}
      />
      {/* Perspective hook point: render overlays here with map={mapInstance} once ready. */}
      <PerspectiveSwitcher map={mapInstance} model={model} frameIndex={frameIndex} perimeterIndex={perimeterIndex} simTimeMs={simTimeMs} />
      {mapInstance === null && !mapError && (
        <div className="rp-map-state" role="status">
          <span className="rp-spinner" aria-hidden="true" />
          {styleStatus === "loading" ? "Loading basemap…" : "Preparing map layers…"}
        </div>
      )}
      {mapError && (
        <div className="rp-map-state rp-map-state--error" role="alert">
          Map could not start: {mapError}
        </div>
      )}
      {styleStatus === "fallback" && (
        <p className="rp-basemap-note" role="status">
          Basemap unavailable — overlays drawn on a plain background.
        </p>
      )}
    </div>
  );
}
