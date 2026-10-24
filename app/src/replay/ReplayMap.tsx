import { Spinner } from "../ui";
import {
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type ErrorEvent,
  type MapGeoJSONFeature,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BASEMAP_STYLE_URL,
  FALLBACK_STYLE,
  IMAGERY_LAYER,
  INTERACTIVE_LAYERS,
  ROAD_CLASS_BY_CODE,
  ROAD_CLASS_LABEL,
  applyTrafficFrame,
  applyClosedState,
  applyThreatState,
  pinCollection,
  setFireFlicker,
  setIgnitionLabelVisible,
  setZoneFlash,
  setThreatPulse,
  closedLabelCollection,
  installLayers,
  particlesCollection,
  perimeterCollection,
  perimeterHistoryCollection,
  setBasemap,
  setGroupVisibility,
  setPerimeterFreshness,
  setPerimeterLabel,
  applyPeopleState,
  destinationsCollection,
  setFireObservationTime,
  setSourceData,
  simulatedFrontCollection,
  trafficToRoadIndex,
  zonesCollection,
  type Basemap as BasemapChoice,
  type BasemapStyle,
  type LayerGroup,
} from "./mapLayers";
import { HILLSHADE_LAYER, restyleDarkBasemap } from "./basemapStyle";
import { buildEdgePath, buildTravelIndex, particlePositions, type EdgePath } from "./particles";
import PerspectiveSwitcher from "./perspectives/PerspectiveSwitcher";
import { edgeThreats } from "./insights";
import { areaKm2, peopleAtHome } from "./population";
import { openRefugeKey, refugeTimeline } from "./refuges";
import {
  EVIDENCE_LABEL,
  closedEdgesAt,
  localTime,
  perimeterWindowEnd,
  sameNumbers,
} from "./timeline";
import type { EvidenceClass, LngLat, ReplayModel } from "./types";

// Bundle the MapLibre worker explicitly; Vite relocates the main module.
setWorkerUrl(workerUrl);

const STYLE_TIMEOUT_MS = 10_000;
/** Older fronts this many steps back render as burned char inside the live front. */
const CHAR_LAG_FRONTS = 3;
const FLICKER_INTERVAL_MS = 90;
/** Zone-order flash: wall-clock length, and how recent (sim time) an order must be to flash. */
const ZONE_FLASH_MS = 3000;
const ZONE_FLASH_RECENT_MS = 20 * 60_000;
const ZONE_FLASH_TICK_MS = 50;
/** The ignition text is hidden this long after the assumed ignition time. */
const IGNITION_LABEL_MS = 90 * 60_000;
/** Opening camera: padding around the home coordinates (ignition and reference place). */
const HOME_PADDING = { top: 160, bottom: 200, left: 120, right: 120 };
const HOME_MAX_ZOOM = 11.5;
const FRESHNESS_BUCKET_MS = 10 * 60_000;
const MIN_ZOOM = 7;
const MAX_BOUNDS_PAD_DEG = 2.5;
/** Satellite falls back to the map if no imagery tile at all has loaded by then. */
const IMAGERY_TIMEOUT_MS = 15_000;
const IMAGERY_MAX_ERRORS = 12;
const THREAT_BUCKET_MS = 60_000;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** A request to frame some coordinates; `key` changes to re-trigger the same target. */
export interface MapFocus {
  key: number;
  coords: LngLat[];
  /** Screen padding in px, e.g. to keep the framed area clear of an overlay card. */
  padding?: { top: number; bottom: number; left: number; right: number };
  maxZoom?: number;
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
    return restyleDarkBasemap(style as BasemapStyle);
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

function boundsOf(coords: LngLat[]): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
  }
  return [w, s, e, n];
}

function evidenceText(value: unknown): string {
  return EVIDENCE_LABEL[value as EvidenceClass] ?? "Evidence class unknown";
}

function tooltipContent(
  feature: MapGeoJSONFeature,
  perParticle: number,
  timezone: string,
): HTMLElement {
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
      if (p.half_day)
        add("span", "Half-day satellite composite: extent reached sometime in this window.");
      add(
        "span",
        `${fmt(p.area_km2, 1)} km² · ${EVIDENCE_LABEL[p.evidence_class as EvidenceClass] ?? String(p.evidence_class)}`,
      );
      add("span", "Shape held until the next snapshot; no interpolation.", "rp-tip-note");
      break;
    case "roads-flow": {
      const state = feature.state as { veh?: number; speed?: number | null; cls?: number };
      const veh = state.veh ?? 0;
      add("strong", `${String(p.name)}${p.bridge ? " · bridge" : ""}`);
      add("span", ROAD_CLASS_LABEL[ROAD_CLASS_BY_CODE[state.cls ?? 0] ?? "idle"]);
      if (veh > 0) {
        add(
          "span",
          `${fmt(veh)} modelled vehicles · ${fmt(state.speed, 1)} of ${fmt(p.speed_kph)} km/h`,
        );
        add("span", "Simulated traffic, not recorded movement.", "rp-tip-note");
      } else {
        add("span", `Free-flow speed ${fmt(p.speed_kph)} km/h`);
      }
      break;
    }
    case "roads-threat": {
      const state = feature.state as { threat?: number };
      add("strong", String(p.name));
      add(
        "span",
        state.threat === 2
          ? "Modelled fire arrival within 10 min"
          : "Modelled fire arrival within 30 min",
      );
      add("span", "From the simulated fire front; not an observation.", "rp-tip-note");
      break;
    }
    case "roads-closed": {
      const state = feature.state as { veh?: number };
      add("strong", `${String(p.name)}${p.bridge ? " · bridge" : ""}`);
      add("span", "Closed at this time (event or modelled fire hazard)");
      if ((state.veh ?? 0) > 0)
        add("span", `${fmt(state.veh)} modelled vehicles held on this edge`);
      break;
    }
    case "sim-front-fill":
      add("strong", "Simulated fire front (model output)");
      add("span", `${fmt(p.area_km2, 1)} km² · fire-spread model run`);
      add(
        "span",
        "Not an observation; shown only before the first satellite perimeter.",
        "rp-tip-note",
      );
      break;
    case "sim-ignition":
      add("strong", String(p.label ?? "Ignition (model input)"));
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
      add(
        "span",
        p.state === "ordered"
          ? "Evacuation order issued"
          : p.state === "warned"
            ? "Warning issued"
            : "No order yet",
      );
      add("span", `${fmt(p.households)} households · ${fmt(p.vehicles)} vehicles`);
      break;
    case "destinations":
      add("strong", String(p.name));
      add(
        "span",
        `${String(p.dest_kind).replace(/_/g, " ")} · capacity ${p.capacity_veh == null ? "unbounded" : fmt(p.capacity_veh)}`,
      );
      add("span", evidenceText(p.evidence_class), "rp-tip-note");
      break;
    case "people-fill": {
      const state = feature.state as {
        home?: number | null;
        left?: number | null;
        density?: number;
      };
      add("strong", String(p.name));
      add(
        "span",
        [
          p.households != null && `${fmt(p.households)} households`,
          p.population != null && `${fmt(p.population)} people`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      if (state.home != null) {
        add(
          "span",
          `Still home now: ${fmt(state.home)} · left: ${fmt(state.left)} households (model)`,
        );
        add("span", `${fmt(state.density)} households at home per km²`);
      }
      add("span", "Census ACS households; departures are modelled.", "rp-tip-note");
      break;
    }
    case "refuges":
      add("strong", String(p.name));
      add(
        "span",
        p.refuge_state === "open"
          ? "Temporary refuge area · open at this time"
          : p.refuge_state === "closed"
            ? "Temporary refuge area · not open at this time"
            : "Temporary refuge area · open times not recorded",
      );
      add(
        "span",
        `${evidenceText(p.evidence_class)} · NIST-identified refuge; used in the model only when no exit is reachable`,
        "rp-tip-note",
      );
      break;
    case "fire-obs":
      add("strong", `Fire observed here at ${localTime(Number(p.at_ms), timezone)} (NIST)`);
      add(
        "span",
        [
          p.location_source && `located by ${String(p.location_source)}`,
          p.time_precision && `time ${String(p.time_precision)}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      add(
        "span",
        `${evidenceText(p.evidence_class)} · fire present at that time, not its first arrival`,
        "rp-tip-note",
      );
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
  /** Cosmetic motion (fire flicker) only while the clock plays, so a paused map is still. */
  animate: boolean;
  /** Coordinates the opening camera frames (e.g. ignition and reference place). */
  home: LngLat[];
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
  home,
  animate,
}: ReplayMapProps) {
  const homeRef = useRef(home);
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
    () =>
      model.traffic
        ? buildTravelIndex(model.traffic.frames, edgePaths, model.traffic.closures)
        : [],
    [model, edgePaths],
  );

  // Create the map once per mount (the parent keys this component by incident); remove it and
  // its listeners on unmount. Static layers come from the model at mount; a what-if variant
  // only swaps traffic, events and insights, which the effects below push into the map.
  const initialModelRef = useRef(model);
  useEffect(() => {
    const model = initialModelRef.current;
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
          bounds: boundsOf(homeRef.current),
          fitBoundsOptions: { padding: HOME_PADDING, maxZoom: HOME_MAX_ZOOM },
          attributionControl: { compact: true },
          // Zoomed out far enough to see Northern California, but never lose the incident.
          minZoom: MIN_ZOOM,
          maxBounds: [
            model.bbox[0] - MAX_BOUNDS_PAD_DEG,
            model.bbox[1] - MAX_BOUNDS_PAD_DEG,
            model.bbox[2] + MAX_BOUNDS_PAD_DEG,
            model.bbox[3] + MAX_BOUNDS_PAD_DEG,
          ],
          dragRotate: false,
          pitchWithRotate: false,
        });
      } catch (error) {
        setMapError(error instanceof Error ? error.message : "WebGL map could not start.");
        return;
      }
      map = m;
      mapRef.current = m;
      // Dev-only handle for debugging in the browser console.
      if (import.meta.env.DEV) (window as unknown as { __replayMap?: MapLibreMap }).__replayMap = m;
      m.addControl(new NavigationControl({ showCompass: false }), "top-right");
      m.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
      // The top-down hillshade steps aside while a 3D perspective drapes its own terrain.
      m.on("terrain", () => {
        if (m.getLayer(HILLSHADE_LAYER)) {
          m.setLayoutProperty(HILLSHADE_LAYER, "visibility", m.getTerrain() ? "none" : "visible");
        }
      });
      m.on("load", () => {
        if (cancelled) return;
        installLayers(m, model);
        // The simulated-area label sits at the bbox corner, among exit markers: keep it on top.
        if (m.getLayer("sim-area-label")) m.moveLayer("sim-area-label");
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
        const feature = m.queryRenderedFeatures(event.point, { layers }).find((f) => {
          const state = f.state as { veh?: number; closed?: boolean };
          if (f.layer.id === "roads-flow") return (state.veh ?? 0) > 0;
          if (f.layer.id === "roads-closed") return state.closed === true;
          if (f.layer.id === "roads-threat")
            return ((f.state as { threat?: number }).threat ?? 0) > 0;
          return true;
        });
        if (!feature) {
          popup.remove();
          m.getCanvas().style.cursor = onPickRef.current ? "crosshair" : "";
          return;
        }
        m.getCanvas().style.cursor = "pointer";
        popup
          .setLngLat(event.lngLat)
          .setDOMContent(tooltipContent(feature, perParticleRef.current, model.incident.timezone))
          .addTo(m);
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
  }, []);

  const perimeter = perimeterIndex >= 0 ? model.perimeters[perimeterIndex] : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setSourceData(map, "fire", perimeterCollection(perimeter));
    setSourceData(
      map,
      "fire-history",
      perimeterHistoryCollection(model.perimeters, perimeterIndex),
    );
  }, [ready, model, perimeter, perimeterIndex]);

  const freshnessBucket = perimeter
    ? Math.floor((simTimeMs - perimeter.atMs) / FRESHNESS_BUCKET_MS)
    : 0;
  // Half-day composites: dotted outline until the end of their window, then the normal style.
  const windowEnd = perimeter ? perimeterWindowEnd(model, perimeterIndex) : null;
  const provisional = windowEnd !== null && simTimeMs < windowEnd;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setPerimeterFreshness(map, freshnessBucket * FRESHNESS_BUCKET_MS, provisional);
    setPerimeterLabel(
      map,
      provisional && windowEnd !== null
        ? `EXTENT SOMETIME BY ${localTime(windowEnd, model.incident.timezone).replace(/ [A-Z]{3,4}$/, "")}`
        : "SATELLITE ESTIMATE",
    );
  }, [ready, freshnessBucket, provisional, windowEnd, model.incident.timezone]);

  const simFront = simFrontIndex >= 0 ? (model.fireSimulated?.fronts[simFrontIndex] ?? null) : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setSourceData(map, "sim-front", simulatedFrontCollection(simFront));
    const charFront =
      simFrontIndex >= CHAR_LAG_FRONTS
        ? (model.fireSimulated?.fronts[simFrontIndex - CHAR_LAG_FRONTS] ?? null)
        : null;
    setSourceData(map, "sim-char", simulatedFrontCollection(charFront));
  }, [ready, model, simFront, simFrontIndex]);

  // Cosmetic flicker on wall-clock time (no data meaning); off for reduced motion.
  const fireVisible = simFront !== null && visibility.simFire;
  const hasOrderedZones = Array.from(zoneStates.values()).includes("ordered");
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !animate || (!fireVisible && !hasOrderedZones) || prefersReducedMotion())
      return;
    const timer = window.setInterval(
      () => setFireFlicker(map, performance.now()),
      FLICKER_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [ready, animate, fireVisible, hasOrderedZones]);

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

  // Threatened roads are drawn static (no wall-clock pulse): one less moving, warm mark.
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setThreatPulse(map, 0.5);
  }, [ready]);

  // Satellite: show a loading hint while USGS tiles stream; on repeated errors or a timeout with
  // no tile loaded, fall back to the (restyled) dark map with a notice. Status is set from callbacks only.
  const [imagery, setImagery] = useState<"idle" | "loading" | "ok" | "failed">("idle");
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const reset = window.setTimeout(
      () => setImagery(basemapChoice === "satellite" ? "loading" : "idle"),
      0,
    );
    setBasemap(map, basemapChoice);
    if (basemapChoice !== "satellite") return () => window.clearTimeout(reset);
    let loaded = false;
    let anyTile = false;
    let errors = 0;
    let failed = false;
    const fail = () => {
      if (failed || loaded || anyTile) return;
      failed = true;
      setBasemap(map, "dark");
      setImagery("failed");
    };
    const onData = (event: { sourceId?: string; tile?: { state?: string } }) => {
      if (failed || event.sourceId !== IMAGERY_LAYER) return;
      if (event.tile?.state === "loaded") anyTile = true;
      // Errored tiles also count as "loaded" for the source, so require a real tile first.
      if (anyTile && map.isSourceLoaded(IMAGERY_LAYER)) {
        loaded = true;
        setImagery("ok");
      } else {
        setImagery("loading");
      }
    };
    const onError = (event: ErrorEvent) => {
      if ((event as unknown as { sourceId?: string }).sourceId !== IMAGERY_LAYER) return;
      errors += 1;
      if (errors >= IMAGERY_MAX_ERRORS) fail();
    };
    map.on("sourcedata", onData);
    map.on("error", onError);
    const timeout = window.setTimeout(() => {
      if (!loaded && !anyTile) fail();
    }, IMAGERY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(reset);
      window.clearTimeout(timeout);
      map.off("sourcedata", onData);
      map.off("error", onError);
    };
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
    map.fitBounds([w, s, e, n], {
      padding: focus.padding ?? 120,
      maxZoom: focus.maxZoom ?? 15,
      duration: prefersReducedMotion() ? 0 : 1600,
      essential: true,
    });
  }, [ready, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) map.getCanvas().style.cursor = onPick ? "crosshair" : "";
  }, [ready, onPick]);

  // Flash zones whose order was issued recently (in sim time) as the clock crosses it.
  const zoneOrderAt = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of model.events) {
      if (!e.type.includes("order")) continue;
      for (const id of e.zoneIds) if (!out.has(id)) out.set(id, e.atMs);
    }
    return out;
  }, [model]);
  const zoneIndex = useMemo(
    () => new Map((model.zones?.items ?? []).map((z, i) => [z.id, i])),
    [model],
  );
  const orderedRef = useRef<Set<string>>(new Set());
  const flashesRef = useRef<Map<number, number>>(new Map());
  const [flashTick, setFlashTick] = useState(0);
  useEffect(() => {
    const ordered = new Set<string>();
    for (const [id, state] of zoneStates) if (state === "ordered") ordered.add(id);
    const now = performance.now();
    for (const id of ordered) {
      const at = zoneOrderAt.get(id);
      const idx = zoneIndex.get(id);
      if (orderedRef.current.has(id) || at === undefined || idx === undefined) continue;
      if (simTimeMs - at <= ZONE_FLASH_RECENT_MS) flashesRef.current.set(idx, now);
    }
    orderedRef.current = ordered;
    if (flashesRef.current.size > 0) setFlashTick((n) => n + 1);
    // simTimeMs is read only to judge recency when the ordered set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneStates, zoneOrderAt, zoneIndex]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || flashTick === 0) return;
    const reduced = prefersReducedMotion();
    const timer = window.setInterval(() => {
      const now = performance.now();
      for (const [idx, start] of flashesRef.current) {
        const t = (now - start) / ZONE_FLASH_MS;
        if (t >= 1) {
          setZoneFlash(map, idx, 0);
          flashesRef.current.delete(idx);
          continue;
        }
        const pulse = reduced ? 1 : 0.6 + 0.4 * Math.cos(t * 6 * Math.PI);
        setZoneFlash(map, idx, (1 - t) * pulse);
      }
      if (flashesRef.current.size === 0) window.clearInterval(timer);
    }, ZONE_FLASH_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ready, flashTick]);

  const ignitionAt = model.fireSimulated?.ignition?.atMs ?? null;
  const ignitionLabel =
    ignitionAt !== null && visibility.simFire && simTimeMs < ignitionAt + IGNITION_LABEL_MS;
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setIgnitionLabelVisible(map, ignitionLabel);
  }, [ready, ignitionLabel]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map)
      setSourceData(map, "zones", zonesCollection(model.zones?.items ?? [], zoneStates));
  }, [ready, model, zoneStates]);

  // People at home: zone areas once, then per-minute feature-state from modelled departures.
  const zoneAreas = useMemo(
    () => (model.zones?.items ?? []).map((z) => areaKm2(z.geometry)),
    [model.zones],
  );
  const peopleMinute = Math.floor(simTimeMs / 60_000) * 60_000;
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map && visibility.people)
      applyPeopleState(map, peopleAtHome(model, zoneAreas, peopleMinute));
  }, [ready, model, zoneAreas, peopleMinute, visibility.people]);

  // Refuges open and close at NIST-recorded times; redraw only when the open set changes.
  const refuges = useMemo(
    () => refugeTimeline(model.destinations?.items ?? [], model.events),
    [model.destinations, model.events],
  );
  const openKey = openRefugeKey(refuges, simTimeMs);
  const refugeTimeRef = useRef(simTimeMs);
  useEffect(() => {
    refugeTimeRef.current = simTimeMs;
  }, [simTimeMs]);
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map)
      setSourceData(
        map,
        "destinations",
        destinationsCollection(model, refuges, refugeTimeRef.current),
      );
  }, [ready, model, refuges, openKey]);

  // Fire observations appear at their observed time (minute buckets keep filter updates cheap).
  const obsBucket = Math.floor(simTimeMs / 60_000) * 60_000;
  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) setFireObservationTime(map, obsBucket);
  }, [ready, obsBucket]);

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
      <PerspectiveSwitcher
        map={mapInstance}
        model={model}
        frameIndex={frameIndex}
        perimeterIndex={perimeterIndex}
        simTimeMs={simTimeMs}
      />
      {mapInstance === null && !mapError && (
        <div className="rp-map-state" role="status">
          <Spinner />
          {styleStatus === "loading" ? "Loading basemap…" : "Preparing map layers…"}
        </div>
      )}
      {mapError && (
        <div className="rp-map-state rp-map-state--error" role="alert">
          Map could not start: {mapError}
        </div>
      )}
      {basemapChoice === "satellite" && imagery === "loading" && (
        <p className="rp-imagery-status" role="status">
          <Spinner /> Loading satellite imagery…
        </p>
      )}
      {basemapChoice === "satellite" && imagery === "failed" && (
        <p className="rp-imagery-status rp-imagery-status--failed" role="alert">
          Satellite imagery (USGS) did not load — showing the map instead.
        </p>
      )}
      {styleStatus === "fallback" && (
        <p className="rp-basemap-note" role="status">
          Basemap unavailable — overlays drawn on a plain background.
        </p>
      )}
    </div>
  );
}
