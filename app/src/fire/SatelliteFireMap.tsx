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
import type { FeatureCollection, Polygon } from "geojson";
import { FUEL_MODELS, NON_BURNABLE_CODES } from "./fuelModels";
import { mercatorToLonLat, type LandscapeGrid } from "./landscape";
import { formatElapsed, type FireFrame, type GeoPoint } from "./spread";
import { ARRIVAL_COLORS, CURRENT_PERIMETER_COLOR, FUEL_COLORS } from "./fuelPalette";
import { SATELLITE_STYLE } from "../maps/basemap";
import {
  BASEMAP_STYLE_URL,
  FALLBACK_STYLE,
  IMAGERY_DATE_NOTE,
  IMAGERY_LAYER,
  setBasemap,
  type BasemapStyle,
} from "../replay/mapLayers";
import { HILLSHADE_LAYER, restyleDarkBasemap } from "../replay/basemapStyle";
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
const FUEL_SOURCE = "fire-fuel";

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
    return restyleDarkBasemap(style as BasemapStyle);
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

interface PerimeterFeatureProperties {
  elapsedMinutes: number;
  arrivalFraction: number;
  current: boolean;
}

const EMPTY: FeatureCollection<Polygon, PerimeterFeatureProperties> = {
  type: "FeatureCollection",
  features: [],
};
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function perimetersThrough(
  frames: FireFrame[],
  frameIndex: number,
): FeatureCollection<Polygon, PerimeterFeatureProperties> {
  const horizon = frames.at(-1)?.elapsedMinutes ?? 0;
  const shown = frames.slice(0, frameIndex + 1);
  const currentMinutes = shown.at(-1)?.elapsedMinutes ?? 0;
  const features = shown
    .flatMap((frame) => frame.perimeters)
    .map((perimeter) => ({
      ...perimeter,
      properties: {
        elapsedMinutes: perimeter.properties.elapsedMinutes,
        arrivalFraction: horizon > 0 ? perimeter.properties.elapsedMinutes / horizon : 0,
        current: perimeter.properties.elapsedMinutes === currentMinutes,
      },
    }))
    .sort((a, b) => b.properties.elapsedMinutes - a.properties.elapsedMinutes);
  return { type: "FeatureCollection", features };
}

function createMarkerElement(className: string, innerHTML: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  element.innerHTML = innerHTML;
  return element;
}

const WIND_ARROW_SVG = `
<svg viewBox="0 0 40 160" width="40" height="160" aria-hidden="true">
  <g fill="none" stroke="#fde68a" stroke-width="3" stroke-linecap="round">
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
          attributionControl: { compact: true, customAttribution: IMAGERY_DATE_NOTE },
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

      map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

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
        // Imagery sits just under the hillshade (and so under roads and labels).
        if (imagerySrc) {
          map.addSource(IMAGERY_LAYER, imagerySrc);
          const below = layers.find((l) => l.id === HILLSHADE_LAYER)?.id ?? layers.find((l) => l.type === "line" || l.type === "symbol")?.id;
          map.addLayer(
            {
              id: IMAGERY_LAYER,
              type: "raster",
              source: IMAGERY_LAYER,
              paint: { "raster-fade-duration": 0 },
            },
            below,
          );
          setBasemap(map, "satellite");
        } else {
          setImagery("failed");
        }
        // Fire layers go above imagery but under place labels / symbols so names stay readable.
        const beforeId = layers.find((l) => l.type === "symbol")?.id;
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
        map.addSource(PERIMETER_SOURCE, { type: "geojson", data: EMPTY });
        map.addLayer(
          {
            id: "fire-arrival-fill",
            type: "fill",
            source: PERIMETER_SOURCE,
            paint: {
              "fill-color": [
                "interpolate",
                ["linear"],
                ["get", "arrivalFraction"],
                0,
                ARRIVAL_COLORS.earliest,
                0.5,
                ARRIVAL_COLORS.middle,
                1,
                ARRIVAL_COLORS.latest,
              ],
              "fill-opacity": 0.42,
            },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "fire-perimeter-line",
            type: "line",
            source: PERIMETER_SOURCE,
            paint: {
              "line-color": [
                "interpolate",
                ["linear"],
                ["get", "arrivalFraction"],
                0,
                ARRIVAL_COLORS.earliest,
                0.5,
                ARRIVAL_COLORS.middle,
                1,
                ARRIVAL_COLORS.latest,
              ],
              "line-width": 1.1,
              "line-opacity": 0.8,
            },
          },
          beforeId,
        );
        map.addLayer(
          {
            id: "fire-current-line",
            type: "line",
            source: PERIMETER_SOURCE,
            filter: ["==", ["get", "current"], true],
            paint: { "line-color": CURRENT_PERIMETER_COLOR, "line-width": 2.4 },
          },
          beforeId,
        );
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
    const source = map.getSource(PERIMETER_SOURCE) as GeoJSONSource | undefined;
    source?.setData(perimetersThrough(frames, frameIndex));
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
    map.setPaintProperty("fire-fuel-layer", "raster-opacity", showFuel && fuelOverlay ? 0.85 : 0);
  }, [ready, fuelOverlay, showFuel]);

  // Frame the loaded region so the ignition can be placed on it (default view is the Bay Area).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !fuelOverlay) return;
    const bounds = new LngLatBounds();
    for (const corner of fuelOverlay.corners) bounds.extend(corner);
    map.fitBounds(bounds, { padding: 40, duration: 0 });
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
    map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 600 });
    // Frames are excluded so wind and moisture edits do not move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitSignal]);

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
