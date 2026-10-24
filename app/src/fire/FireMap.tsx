import { useEffect, useRef, useState } from "react";
import {
  LngLatBounds,
  Map,
  Marker,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapOptions,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection, Polygon } from "geojson";
import { formatElapsed, pointAtBearing, type FireFrame, type GeoPoint } from "./model";
import "./fire.css";

export type ClickMode = "origin" | "wind";

interface FireMapProps {
  origin: GeoPoint | null;
  /** Meteorological bearing the wind blows FROM, degrees clockwise from true north. */
  windFromDegrees: number;
  frames: FireFrame[];
  frameIndex: number;
  /** Changing this value refits the view to the whole run; it never fits on its own. */
  fitSignal: number;
  clickMode: ClickMode;
  onMapClick: (point: GeoPoint) => void;
}

const DEFAULT_CENTER: GeoPoint = { latitude: 37.88, longitude: -122.24 };
const DEFAULT_ZOOM = 12;
const IMAGERY_LOAD_TIMEOUT_MS = 15_000;
const PERIMETER_SOURCE = "fire-perimeters";

/** Arrival-time ramp, from the earliest burned ground to the active head. */
export const ARRIVAL_COLORS = {
  earliest: "#7f1d1d",
  middle: "#ea580c",
  latest: "#fbbf24",
} as const;
export const CURRENT_PERIMETER_COLOR = "#fde68a";

const SATELLITE_STYLE: MapOptions["style"] = {
  version: 8,
  sources: {
    imagery: {
      type: "raster",
      tiles: [
        "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USDA / USGS The National Map</a> · Aerial imagery',
    },
  },
  layers: [{ id: "imagery", type: "raster", source: "imagery" }],
};

interface PerimeterFeatureProperties {
  elapsedMinutes: number;
  /** Arrival time scaled to 0 at ignition and 1 at the horizon, for the colour ramp. */
  arrivalFraction: number;
  current: boolean;
}

const EMPTY_PERIMETERS: FeatureCollection<Polygon, PerimeterFeatureProperties> = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Perimeters reached at or before the displayed step. Later perimeters are listed first
 * so earlier ones paint on top, leaving each band shaded by the time the fire reached it.
 */
function perimetersThrough(
  frames: FireFrame[],
  frameIndex: number,
): FeatureCollection<Polygon, PerimeterFeatureProperties> {
  const horizonMinutes = frames.at(-1)?.elapsedMinutes ?? 0;
  const shown = frames.slice(0, frameIndex + 1);
  const currentMinutes = shown.at(-1)?.elapsedMinutes ?? 0;
  const features = shown
    .filter((frame) => frame.perimeter !== null)
    .map((frame) => ({
      ...frame.perimeter!,
      properties: {
        elapsedMinutes: frame.elapsedMinutes,
        arrivalFraction: horizonMinutes > 0 ? frame.elapsedMinutes / horizonMinutes : 0,
        current: frame.elapsedMinutes === currentMinutes,
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

export default function FireMap({
  origin,
  windFromDegrees,
  frames,
  frameIndex,
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

  useEffect(() => {
    clickRef.current = onMapClick;
  }, [onMapClick]);

  // The map is created once, so placing an ignition point or changing the wind never
  // resets the view the planner has panned to.
  useEffect(() => {
    if (!container.current) return;
    let map: Map;
    try {
      map = new Map({
        container: container.current,
        style: SATELLITE_STYLE,
        center: [DEFAULT_CENTER.longitude, DEFAULT_CENTER.latitude],
        zoom: DEFAULT_ZOOM,
        minZoom: 2,
        maxZoom: 19,
        attributionControl: { compact: true },
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

    const timeout = window.setTimeout(() => {
      setError("Imagery is taking longer to load. Check your internet connection.");
    }, IMAGERY_LOAD_TIMEOUT_MS);
    let failed = false;
    map.on("error", () => {
      failed = true;
      window.clearTimeout(timeout);
      setError("Some imagery could not load. Check your connection or try another area.");
    });
    map.on("movestart", () => {
      failed = false;
    });
    map.on("idle", () => {
      window.clearTimeout(timeout);
      if (!failed) setError(null);
    });

    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      map.addSource(PERIMETER_SOURCE, { type: "geojson", data: EMPTY_PERIMETERS });
      map.addLayer({
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
          "fill-opacity": 0.12,
        },
      });
      map.addLayer({
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
          "line-width": 1.3,
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "fire-current-line",
        type: "line",
        source: PERIMETER_SOURCE,
        filter: ["==", ["get", "current"], true],
        paint: {
          "line-color": CURRENT_PERIMETER_COLOR,
          "line-width": 2.6,
        },
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
    resize.observe(container.current);

    return () => {
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
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(PERIMETER_SOURCE) as GeoJSONSource | undefined;
    source?.setData(perimetersThrough(frames, frameIndex));
  }, [ready, frames, frameIndex]);

  // Fit the whole run into view only when the page asks, so panning is never hijacked.
  useEffect(() => {
    const map = mapRef.current;
    const perimeter = frames.at(-1)?.perimeter;
    if (!map || !ready || fitSignal === 0 || !perimeter) return;
    const bounds = perimeter.geometry.coordinates[0].reduce(
      (extent, position) => extent.extend([position[0], position[1]]),
      new LngLatBounds(),
    );
    map.fitBounds(bounds, { padding: 72, maxZoom: 15, duration: 600 });
    // Frames are excluded so wind and horizon edits do not move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitSignal]);

  // Ignition point and the downwind arrow.
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
    const windTowardDegrees = (windFromDegrees + 180) % 360;

    if (!originMarker.current) {
      const element = createMarkerElement("fire-origin-marker", "");
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", "Ignition point");
      originMarker.current = new Marker({ element }).addTo(map);
    }
    originMarker.current.setLngLat(position);

    if (!windMarker.current) {
      windMarker.current = new Marker({
        element: createMarkerElement("fire-wind-marker", WIND_ARROW_SVG),
        rotationAlignment: "map",
      }).addTo(map);
    }
    windMarker.current.setLngLat(position).setRotation(windTowardDegrees);
    windMarker.current
      .getElement()
      .setAttribute("aria-label", `Wind pushing the fire toward ${Math.round(windTowardDegrees)}°`);
  }, [origin, windFromDegrees]);

  // Label at the head of the perimeter currently displayed.
  useEffect(() => {
    const map = mapRef.current;
    const frame = frames[frameIndex];
    if (!map || !origin || !frame?.perimeter) {
      headMarker.current?.remove();
      headMarker.current = null;
      return;
    }
    const head = pointAtBearing(origin, (windFromDegrees + 180) % 360, frame.headDistanceMeters);
    if (!headMarker.current) {
      headMarker.current = new Marker({
        element: createMarkerElement("fire-head-marker", ""),
        anchor: "bottom",
        offset: [0, -8],
      }).addTo(map);
    }
    headMarker.current.getElement().textContent = `${formatElapsed(frame.elapsedMinutes)} head`;
    headMarker.current.setLngLat([head.longitude, head.latitude]);
  }, [frames, frameIndex, origin, windFromDegrees]);

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
      {error && (
        <p className="fire-map-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
