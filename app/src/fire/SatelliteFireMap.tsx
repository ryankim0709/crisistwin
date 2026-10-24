import { useEffect, useMemo, useRef, useState } from "react";
import {
  LngLatBounds,
  Map,
  Marker,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type ErrorEvent,
  type ImageSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, LineString, Polygon, Position } from "geojson";
import { FUEL_MODELS, NON_BURNABLE_CODES } from "./fuelModels";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";
import { formatElapsed, type FireFrame, type GeoPoint } from "./spread";
import { ARRIVAL_COLORS, CURRENT_PERIMETER_COLOR, FUEL_COLORS } from "./fuelPalette";
import { SATELLITE_STYLE } from "../maps/basemap";
import {
  BASEMAP_STYLE_URL,
  COLORS,
  FALLBACK_STYLE,
  IMAGERY_DATE_NOTE,
  IMAGERY_LAYER,
  setBasemap,
  type BasemapStyle,
} from "../replay/mapLayers";
import { restyleDarkBasemap } from "../replay/basemapStyle";
import "./fire.css";

export type ClickMode = "origin" | "wind";
export type SatelliteFireMapProps = FireMapProps;

interface FireMapProps {
  origin: GeoPoint | null;
  windFromDegrees: number;
  frames: FireFrame[];
  frameIndex: number;
  landscape: LandscapeGrid | null;
  showFuel: boolean;
  fitSignal: number;
  clickMode: ClickMode;
  onMapClick: (point: GeoPoint) => void;
}

const DEFAULT_CENTER: GeoPoint = { latitude: 37.88, longitude: -122.24 };
const DEFAULT_ZOOM = 12;
const PERIMETER_SOURCE = "fire-perimeters";
const BURNED_SOURCE = "fire-burned";
const EDGE_SOURCE = "fire-edge";
const REGION_SOURCE = "fire-region";
const LABEL_AVERAGE_RADIUS = 6;
const LABEL_AVERAGE_PASSES = 3;
// Spot fires and slivers are too small to carry the edge label.
const MIN_LABEL_RING_VERTICES = 12;
const FUEL_SOURCE = "fire-fuel";
// Fire older than this behind the current front is drawn as burned char (replay: last ~30 min glow).
const BURNING_WINDOW_MINUTES = 30;
const SMOOTHING_ITERATIONS = 2;
const FIT_PADDING = 24;
const MIN_FIT_SPACE = 120;
const SHORT_ATTRIBUTION = "Imagery: USGS \u00b7 dates vary";
const LABEL_FONT_BOLD = ["Noto Sans Bold"];

export { ARRIVAL_COLORS, CURRENT_PERIMETER_COLOR, FUEL_COLORS };

function fuelColor(code: number): [number, number, number, number] {
  if (NON_BURNABLE_CODES.has(code)) return code === 98 ? [60, 90, 120, 150] : [91, 97, 104, 140];
  if (!FUEL_MODELS.has(code)) return [0, 0, 0, 0];
  if (code < 120) return [217, 193, 94, 150];
  if (code < 140) return [176, 138, 62, 150];
  if (code < 160) return [140, 111, 58, 150];
  if (code < 180) return [79, 122, 67, 150];
  if (code < 200) return [47, 93, 58, 150];
  return [107, 79, 42, 150];
}

// Mirrors the Historical replay's satellite mode (replay/ReplayMap.tsx): same timeouts.
const STYLE_TIMEOUT_MS = 10_000;
const IMAGERY_TIMEOUT_MS = 15_000;
const IMAGERY_MAX_ERRORS = 12;

/**
 * The dark style's place layers ask for a "circle-11" sprite icon that its sprite does not ship,
 * which logs a MapLibre warning per map. The labels are text; drop the icon reference.
 */
function withoutMissingIcons(style: BasemapStyle): BasemapStyle {
  const layers = style.layers.map((layer) => {
    if (layer.type !== "symbol" || !layer.layout || !("icon-image" in layer.layout)) return layer;
    const layout = { ...layer.layout };
    delete layout["icon-image"];
    return { ...layer, layout };
  });
  return { ...style, layers };
}

/**
 * Fetch and restyle the OpenFreeMap dark basemap, as the replay does. Replicated from
 * replay/ReplayMap.tsx `loadBasemapStyle` (not exported there). Null on any failure.
 */
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
    return withoutMissingIcons(restyleDarkBasemap(style as BasemapStyle));
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** The teammate's USGS imagery raster source (maps/basemap.ts); replicated from replay/mapLayers.ts. */
function imagerySource() {
  const style = SATELLITE_STYLE;
  if (typeof style !== "object" || style === null) return null;
  const source = style.sources.imagery;
  return source && source.type === "raster" ? source : null;
}

type PerimeterCollection = FeatureCollection<Polygon>;

const EMPTY: PerimeterCollection = { type: "FeatureCollection", features: [] };
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** One round of Chaikin corner cutting on a closed ring (first point repeated at the end). */
function chaikin(ring: Position[]): Position[] {
  const open = ring.slice(0, -1);
  if (open.length < 3) return ring;
  const out: Position[] = [];
  for (let i = 0; i < open.length; i++) {
    const a = open[i];
    const b = open[(i + 1) % open.length];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
    out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  out.push(out[0]);
  return out;
}

/** Display-only smoothing of the raster-cell staircase; model data and stats are untouched. */
function smoothRing(ring: Position[]): Position[] {
  let result = ring;
  for (let i = 0; i < SMOOTHING_ITERATIONS; i++) result = chaikin(result);
  return result;
}

/**
 * A much calmer copy of a ring for the edge label only: line-placed text needs gentle curvature,
 * which a 90 m cell staircase never has, even after corner cutting.
 */
function labelPath(ring: Position[]): Position[] {
  let open = smoothRing(ring).slice(0, -1);
  for (let pass = 0; pass < LABEL_AVERAGE_PASSES; pass++) {
    const n = open.length;
    const next: Position[] = [];
    for (let i = 0; i < n; i++) {
      let x = 0;
      let y = 0;
      for (let k = -LABEL_AVERAGE_RADIUS; k <= LABEL_AVERAGE_RADIUS; k++) {
        const point = open[(i + k + n) % n];
        x += point[0];
        y += point[1];
      }
      const count = 2 * LABEL_AVERAGE_RADIUS + 1;
      next.push([x / count, y / count]);
    }
    open = next;
  }
  return [...open, open[0]];
}

function smoothed(polygon: Feature<Polygon>): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: polygon.geometry.coordinates.map(smoothRing) },
  };
}

/**
 * The current front (latest frame) and the earlier burned area: the newest perimeter at least
 * BURNING_WINDOW_MINUTES behind it, which contains everything older.
 */
function fireThrough(
  frames: FireFrame[],
  frameIndex: number,
): { now: PerimeterCollection; burned: PerimeterCollection; edge: FeatureCollection<LineString> } {
  const shown = frames.slice(0, frameIndex + 1);
  const currentMinutes = shown.at(-1)?.elapsedMinutes ?? 0;
  const all = shown.flatMap((frame) => frame.perimeters);
  const now = all.filter((p) => p.properties.elapsedMinutes === currentMinutes);
  let burnedMinutes = -Infinity;
  for (const p of all) {
    const minutes = p.properties.elapsedMinutes;
    if (minutes <= currentMinutes - BURNING_WINDOW_MINUTES && minutes > burnedMinutes) {
      burnedMinutes = minutes;
    }
  }
  const burned = all.filter((p) => p.properties.elapsedMinutes === burnedMinutes);
  // Line-placed labels need LineStrings: MapLibre does not place them along polygon rings.
  const edge: Feature<LineString>[] = now.flatMap((polygon) =>
    polygon.geometry.coordinates[0].length >= MIN_LABEL_RING_VERTICES
      ? [
          {
            type: "Feature" as const,
            properties: {},
            geometry: { type: "LineString" as const, coordinates: labelPath(polygon.geometry.coordinates[0]) },
          },
        ]
      : [],
  );
  return {
    now: { type: "FeatureCollection", features: now.map(smoothed) },
    burned: { type: "FeatureCollection", features: burned.map(smoothed) },
    edge: { type: "FeatureCollection", features: edge },
  };
}

/**
 * Camera padding that keeps the framed area clear of the page's floating panels
 * (`--fr-inset-*` on the stage). Null while the panels leave too little map to frame anything.
 */
function insetPadding(element: HTMLElement, margin: number) {
  const style = getComputedStyle(element);
  const inset = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  const padding = {
    top: inset("--fr-inset-top") + margin,
    bottom: inset("--fr-inset-bottom") + margin,
    left: inset("--fr-inset-left") + margin,
    right: margin,
  };
  const tooSmall =
    padding.top + padding.bottom >= element.clientHeight - MIN_FIT_SPACE ||
    padding.left + padding.right >= element.clientWidth - MIN_FIT_SPACE;
  return tooSmall ? null : padding;
}

function createMarkerElement(className: string, innerHTML: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  element.innerHTML = innerHTML;
  return element;
}

const WIND_ARROW_SVG = `
<svg viewBox="0 0 40 160" width="40" height="160" aria-hidden="true">
  <g fill="none" stroke="#eaf4ff" stroke-width="1.6" stroke-linecap="round">
    <line x1="20" y1="78" x2="20" y2="20" />
    <path d="M11 31 L20 18 L29 31" stroke-linejoin="round" />
  </g>
</svg>`;

/** Render the fuel grid to a data URL so MapLibre can show it as an image source. */
type ImageCorners = [[number, number], [number, number], [number, number], [number, number]];

function fuelImage(landscape: LandscapeGrid): { url: string; corners: ImageCorners } | null {
  const { width, height, fuelCodes, originX, originY, cellSizeX, cellSizeY } = landscape;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  for (let i = 0; i < fuelCodes.length; i++) {
    const [r, g, b, a] = fuelColor(fuelCodes[i]);
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = a;
  }
  context.putImageData(image, 0, 0);
  const left = originX - cellSizeX / 2;
  const top = originY - cellSizeY / 2;
  const right = left + width * cellSizeX;
  const bottom = top + height * cellSizeY;
  return {
    url: canvas.toDataURL(),
    corners: [
      mercatorToLonLat(left, top),
      mercatorToLonLat(right, top),
      mercatorToLonLat(right, bottom),
      mercatorToLonLat(left, bottom),
    ],
  };
}

/** Satellite (USGS aerial imagery) view of the same run, switchable with the diorama. */
export default function SatelliteFireMap({
  origin,
  windFromDegrees,
  frames,
  frameIndex,
  landscape,
  showFuel,
  fitSignal,
  clickMode,
  onMapClick,
}: FireMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const clickRef = useRef(onMapClick);
  const originMarker = useRef<Marker | null>(null);
  const windMarker = useRef<Marker | null>(null);
  const headMarker = useRef<Marker | null>(null);
  const userMoved = useRef(false);
  const regionFit = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagery, setImagery] = useState<"loading" | "ok" | "failed">("loading");

  useEffect(() => {
    clickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const controller = new AbortController();
    let cancelled = false;
    let cleanup = () => {};

    loadBasemapStyle(controller.signal).then((style) => {
      if (cancelled) return;
      let map: Map;
      try {
        map = new Map({
          container: element,
          style: style ?? FALLBACK_STYLE,
          center: [DEFAULT_CENTER.longitude, DEFAULT_CENTER.latitude],
          zoom: DEFAULT_ZOOM,
          minZoom: 2,
          maxZoom: 19,
          attributionControl: { compact: true, customAttribution: SHORT_ATTRIBUTION },
        });
      } catch (cause) {
        setError(
          cause instanceof Error
            ? `Unable to initialize the map: ${cause.message}`
            : "Unable to initialize the map. This map requires WebGL2 support.",
        );
        return;
      }
      mapRef.current = map;

      map.on("movestart", (event) => {
        if ((event as { originalEvent?: Event }).originalEvent) userMoved.current = true;
      });

      map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
      // Full imagery-date note on hover; the visible attribution stays short.
      const attribution = element.querySelector(".maplibregl-ctrl-attrib");
      attribution?.setAttribute("title", IMAGERY_DATE_NOTE);
      // MapLibre opens the attribution on wide screens; keep it collapsed until the user asks.
      attribution?.classList.remove("maplibregl-compact-show");
      attribution?.removeAttribute("open");

      // Imagery loading hint and fallback, as in replay/ReplayMap.tsx: fall back to the restyled
      // map on repeated imagery tile errors, or if no tile at all arrives before the timeout.
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

      map.on("load", () => {
        const imagerySrc = imagerySource();
        const layers = map.getStyle().layers;
        // As in the replay: imagery under the place labels (so it sits above the hillshade and
        // roads), and the fire layers added after it, under the same labels.
        const beforeId =
          layers.find((l) => l.id.startsWith("place_"))?.id ?? layers.find((l) => l.type === "symbol")?.id;
        if (imagerySrc) {
          map.addSource(IMAGERY_LAYER, imagerySrc);
          map.addLayer(
            {
              id: IMAGERY_LAYER,
              type: "raster",
              source: IMAGERY_LAYER,
              // Same paint as replay/mapLayers.ts.
              paint: { "raster-brightness-max": 0.75, "raster-saturation": -0.25, "raster-fade-duration": 0 },
            },
            beforeId,
          );
          setBasemap(map, "satellite");
        } else {
          setImagery("failed");
        }
        map.addSource(FUEL_SOURCE, {
          type: "image",
          url: TRANSPARENT_PIXEL,
          coordinates: [
            [-0.001, 0.001],
            [0.001, 0.001],
            [0.001, -0.001],
            [-0.001, -0.001],
          ],
        });
        map.addLayer(
          {
            id: "fire-fuel-layer",
            type: "raster",
            source: FUEL_SOURCE,
            paint: { "raster-opacity": 0, "raster-resampling": "nearest" },
          },
          beforeId,
        );
        // The loaded region's extent, so the framed view reads as a region (replay "sim-area" style).
        map.addSource(REGION_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer(
          {
            id: "fire-region-line",
            type: "line",
            source: REGION_SOURCE,
            paint: { "line-color": "#c3cdd6", "line-opacity": 0.55, "line-width": 1.2, "line-dasharray": [4, 3] },
          },
          beforeId,
        );
        // Layer recipe follows the replay's satellite fire (replay/mapLayers.ts).
        map.addSource(PERIMETER_SOURCE, { type: "geojson", data: EMPTY });
        map.addSource(BURNED_SOURCE, { type: "geojson", data: EMPTY });
        map.addSource(EDGE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer(
          {
            id: "fire-glow-outer",
            type: "line",
            source: PERIMETER_SOURCE,
            paint: { "line-color": COLORS.emberDeep, "line-width": 16, "line-blur": 10, "line-opacity": 0.75 },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "fire-fill",
            type: "fill",
            source: PERIMETER_SOURCE,
            paint: { "fill-color": COLORS.ember, "fill-opacity": 0.22 },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "fire-burned-fill",
            type: "fill",
            source: BURNED_SOURCE,
            paint: { "fill-color": COLORS.char, "fill-opacity": 0.4 },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "fire-glow",
            type: "line",
            source: PERIMETER_SOURCE,
            paint: { "line-color": COLORS.ember, "line-width": 5, "line-blur": 2, "line-opacity": 0.95 },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "fire-line",
            type: "line",
            source: PERIMETER_SOURCE,
            paint: { "line-color": COLORS.simFront, "line-width": 1.6 },
          },
          beforeId,
        );
        // The edge tag may sit over place labels.
        map.addLayer({
          id: "fire-label",
          type: "symbol",
          source: EDGE_SOURCE,
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 130,
            "text-field": "MODEL FIRE (simulated)",
            "text-font": LABEL_FONT_BOLD,
            "text-size": 10.5,
            "text-letter-spacing": 0.15,
            "text-offset": [0, -1.2],
          },
          paint: { "text-color": "#ffc46b", "text-halo-color": "#1a0702", "text-halo-width": 2 },
        });
        setReady(true);
      });

      function selectPoint(longitude: number, latitude: number) {
        clickRef.current({
          latitude,
          longitude: ((((longitude + 180) % 360) + 360) % 360) - 180,
        });
      }
      map.on("click", (event) => selectPoint(event.lngLat.lng, event.lngLat.lat));
      function selectCenter(event: KeyboardEvent) {
        if (event.key !== "Enter") return;
        const center = map.getCenter();
        selectPoint(center.lng, center.lat);
      }
      const canvas = map.getCanvas();
      canvas.addEventListener("keydown", selectCenter);
      canvas.style.cursor = "crosshair";

      const resize = new ResizeObserver(() => map.resize());
      resize.observe(element);

      cleanup = () => {
        window.clearTimeout(timeout);
        resize.disconnect();
        canvas.removeEventListener("keydown", selectCenter);
        originMarker.current?.remove();
        windMarker.current?.remove();
        headMarker.current?.remove();
        originMarker.current = null;
        windMarker.current = null;
        headMarker.current = null;
        setReady(false);
        map.remove();
        mapRef.current = null;
      };
    });

    return () => {
      cancelled = true;
      controller.abort();
      cleanup();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const { now, burned, edge } = fireThrough(frames, frameIndex);
    (map.getSource(PERIMETER_SOURCE) as GeoJSONSource | undefined)?.setData(now);
    (map.getSource(BURNED_SOURCE) as GeoJSONSource | undefined)?.setData(burned);
    (map.getSource(EDGE_SOURCE) as GeoJSONSource | undefined)?.setData(edge);
  }, [ready, frames, frameIndex]);

  const fuelOverlay = useMemo(() => (landscape ? fuelImage(landscape) : null), [landscape]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(FUEL_SOURCE) as ImageSource | undefined;
    if (!source) return;
    if (fuelOverlay) {
      source.updateImage({ url: fuelOverlay.url, coordinates: fuelOverlay.corners });
    }
    if (fuelOverlay) {
      const ring = [...fuelOverlay.corners, fuelOverlay.corners[0]];
      (map.getSource(REGION_SOURCE) as GeoJSONSource | undefined)?.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: ring },
      });
    }
    map.setPaintProperty("fire-fuel-layer", "raster-opacity", showFuel && fuelOverlay ? 0.85 : 0);
  }, [ready, fuelOverlay, showFuel]);

  // Frame the loaded region so the ignition can be placed on it (default view is the Bay Area).
  // Padding follows the page's floating panels (--fr-inset-* on the stage); refit when they or the
  // viewport change, until the user moves the map themselves.
  useEffect(() => {
    const map = mapRef.current;
    const element = container.current;
    if (!map || !ready || !fuelOverlay || !element) return;
    const bounds = new LngLatBounds();
    for (const corner of fuelOverlay.corners) bounds.extend(corner);
    userMoved.current = false;
    regionFit.current = true;
    const fit = () => {
      if (userMoved.current || !regionFit.current) return;
      map.resize();
      const padding = insetPadding(element, FIT_PADDING);
      if (padding) map.fitBounds(bounds, { padding, duration: 0 });
    };
    fit();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      mutations.observe(node, { attributes: true, attributeFilter: ["style"] });
    }
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [ready, fuelOverlay]);

  useEffect(() => {
    const map = mapRef.current;
    const perimeter = frames.at(-1)?.perimeters;
    if (!map || !ready || fitSignal === 0 || !perimeter?.length) return;
    const bounds = new LngLatBounds();
    for (const polygon of perimeter) {
      for (const position of polygon.geometry.coordinates[0]) {
        bounds.extend([position[0], position[1]]);
      }
    }
    regionFit.current = false;
    const element = container.current;
    const padding = (element && insetPadding(element, 48)) || 80;
    map.fitBounds(bounds, { padding, maxZoom: 15, duration: 600 });
    // Frames are excluded so wind and moisture edits do not move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitSignal]);

  // Once an ignition exists the camera is the user's: panels opening must not move it.
  useEffect(() => {
    if (origin) regionFit.current = false;
  }, [origin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!origin) {
      originMarker.current?.remove();
      windMarker.current?.remove();
      originMarker.current = null;
      windMarker.current = null;
      return;
    }
    const position: [number, number] = [origin.longitude, origin.latitude];
    const windToward = (windFromDegrees + 180) % 360;
    if (!originMarker.current) {
      const element = createMarkerElement("fire-origin-marker", "");
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", "Ignition point");
      originMarker.current = new Marker({ element }).setLngLat(position).addTo(map);
    }
    originMarker.current.setLngLat(position);
    if (!windMarker.current) {
      windMarker.current = new Marker({
        element: createMarkerElement("fire-wind-marker", WIND_ARROW_SVG),
        rotationAlignment: "map",
      })
        .setLngLat(position)
        .addTo(map);
    }
    windMarker.current.setLngLat(position).setRotation(windToward);
    windMarker.current
      .getElement()
      .setAttribute("aria-label", `Wind pushing the fire toward ${Math.round(windToward)}°`);
  }, [origin, windFromDegrees]);

  useEffect(() => {
    const map = mapRef.current;
    const frame = frames[frameIndex];
    if (!map || !origin || !frame?.perimeters.length) {
      headMarker.current?.remove();
      headMarker.current = null;
      return;
    }
    // Label the perimeter vertex furthest from the ignition point.
    let best: [number, number] = [origin.longitude, origin.latitude];
    let bestDistance = -1;
    const scale = Math.cos((origin.latitude * Math.PI) / 180);
    for (const polygon of frame.perimeters) {
      for (const [longitude, latitude] of polygon.geometry.coordinates[0]) {
        const distance = Math.hypot(
          (longitude - origin.longitude) * scale,
          latitude - origin.latitude,
        );
        if (distance > bestDistance) {
          bestDistance = distance;
          best = [longitude, latitude];
        }
      }
    }
    if (!headMarker.current) {
      headMarker.current = new Marker({
        element: createMarkerElement("fire-head-marker", ""),
        anchor: "bottom",
        offset: [0, -8],
      })
        .setLngLat(best)
        .addTo(map);
    }
    headMarker.current.getElement().textContent = `${formatElapsed(frame.elapsedMinutes)} head`;
    headMarker.current.setLngLat(best);
  }, [frames, frameIndex, origin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        clickMode === "origin"
          ? "Aerial map. Click, or press Enter, to place the ignition point. Arrow keys pan, plus and minus zoom."
          : "Aerial map. Click, or press Enter, to point the wind from the ignition point toward that location. Arrow keys pan, plus and minus zoom.",
      );
  }, [clickMode]);

  return (
    <div className="fire-map-container">
      <div ref={container} className="fire-map" />
      {!error && imagery === "loading" && (
        <p className="fire-map-hint" role="status">
          Loading satellite imagery…
        </p>
      )}
      {!error && imagery === "failed" && (
        <p className="fire-map-hint fire-map-hint--failed" role="alert">
          Satellite imagery (USGS) did not load — showing the map instead.
        </p>
      )}
      {error && (
        <p className="fire-map-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
