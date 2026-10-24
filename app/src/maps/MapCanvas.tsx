import { useEffect, useRef, useState } from "react";
import {
  Map,
  Marker,
  NavigationControl,
  ScaleControl,
  setMaxParallelImageRequests,
  setWorkerUrl,
  type GeoJSONSource,
  type MapOptions,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { EMPTY_PERIMETER, type FirePerimeter } from "../simulation/fire";
import { SATELLITE_STYLE } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maps.css";

export interface MapLocation {
  latitude: number;
  longitude: number;
}
interface MapCanvasProps {
  center?: MapLocation;
  zoom?: number;
  mapStyle?: MapOptions["style"];
  selectedLocation?: MapLocation | null;
  firePerimeter?: FirePerimeter;
  onLocationSelect?: (location: MapLocation) => void;
}

const DEFAULT_CENTER: MapLocation = { latitude: 37.7749, longitude: -122.4194 };
// Vite relocates the main module; explicitly bundle the worker used for GeoJSON overlays.
setWorkerUrl(workerUrl);
// Keep the public imagery request queue bounded; the SF preview comes from the app origin.
setMaxParallelImageRequests(8);

export default function MapCanvas({
  center = DEFAULT_CENTER,
  zoom = 11.5,
  mapStyle = SATELLITE_STYLE,
  selectedLocation,
  firePerimeter = EMPTY_PERIMETER,
  onLocationSelect,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const selectRef = useRef(onLocationSelect);
  const viewRef = useRef({ center, zoom });
  const perimeterRef = useRef(firePerimeter);
  const [error, setError] = useState<string | null>(null);
  const { latitude, longitude } = center;

  useEffect(() => {
    selectRef.current = onLocationSelect;
  }, [onLocationSelect]);
  useEffect(() => {
    viewRef.current = { center: { latitude, longitude }, zoom };
    mapRef.current?.jumpTo({ center: [longitude, latitude], zoom });
  }, [latitude, longitude, zoom]);

  useEffect(() => {
    if (!container.current) return;
    let map: Map;
    const view = viewRef.current;
    try {
      map = new Map({
        container: container.current,
        style: mapStyle,
        center: [view.center.longitude, view.center.latitude],
        zoom: view.zoom,
        minZoom: 2,
        maxZoom: 19,
        maxTileCacheSize: 128,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        cancelPendingTileRequestsWhileZooming: true,
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
      setError("Detailed imagery is taking longer to load. You can keep using the map.");
    }, 15_000);
    let failed = false;
    map.on("error", (event) => {
      failed = true;
      window.clearTimeout(timeout);
      console.error("Map data failed to load", event.error);
      setError("Some map data is unavailable. You can keep using the map.");
    });
    map.on("movestart", () => {
      failed = false;
    });
    map.on("idle", () => {
      window.clearTimeout(timeout);
      if (!failed) setError(null);
    });
    map.on("style.load", () => {
      map.addSource("fire-footprint", { type: "geojson", data: perimeterRef.current });
      map.addLayer({
        id: "fire-fill",
        type: "fill",
        source: "fire-footprint",
        paint: { "fill-color": "#ff6b2c", "fill-opacity": 0.35 },
      });
      map.addLayer({
        id: "fire-boundary",
        type: "line",
        source: "fire-footprint",
        paint: { "line-color": "#ff9b53", "line-width": 2.5 },
      });
    });
    map.addControl(new NavigationControl(), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        "Satellite map. Arrow keys pan, plus and minus zoom. Click or press Enter to select the fire origin.",
      );

    function selectLocation(longitude: number, latitude: number) {
      const wrappedLongitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
      const location = { latitude, longitude: wrappedLongitude };
      placeMarker(map, markerRef, location);
      selectRef.current?.(location);
    }
    map.on("click", (event) => selectLocation(event.lngLat.lng, event.lngLat.lat));
    function selectCenter(event: KeyboardEvent) {
      if (event.key !== "Enter") return;
      const center = map.getCenter();
      selectLocation(center.lng, center.lat);
    }
    map.getCanvas().addEventListener("keydown", selectCenter);
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      window.clearTimeout(timeout);
      resize.disconnect();
      map.getCanvas().removeEventListener("keydown", selectCenter);
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && selectedLocation !== undefined) placeMarker(map, markerRef, selectedLocation);
  }, [selectedLocation, mapStyle]);

  useEffect(() => {
    perimeterRef.current = firePerimeter;
    const source = mapRef.current?.getSource<GeoJSONSource>("fire-footprint");
    let active = true;
    source?.setData(firePerimeter).catch(() => {
      if (active) setError("The simulation overlay could not be displayed.");
    });
    return () => {
      active = false;
    };
  }, [firePerimeter, mapStyle]);

  return (
    <div className="geographic-map-container">
      <div ref={container} className="geographic-map" />
      {error && (
        <div className="map-error" role="status">
          {error}
          {mapStyle === SATELLITE_STYLE && (
            <button
              type="button"
              onClick={() => {
                if (mapRef.current?.getSource("imagery")) {
                  setError(null);
                  mapRef.current.refreshTiles("imagery");
                }
              }}
            >
              Retry imagery
            </button>
          )}
        </div>
      )}
      {mapStyle === SATELLITE_STYLE && (
        <a
          className="map-source-note"
          href="/map-preview/provenance.json"
          target="_blank"
          rel="noreferrer"
        >
          USDA / USGS historical imagery · cached SF overview
        </a>
      )}
    </div>
  );
}

function placeMarker(
  map: Map,
  markerRef: { current: Marker | null },
  location: MapLocation | null,
) {
  if (!location) {
    markerRef.current?.remove();
    markerRef.current = null;
    return;
  }
  const position: [number, number] = [location.longitude, location.latitude];
  if (markerRef.current) markerRef.current.setLngLat(position);
  else {
    const element = document.createElement("div");
    element.className = "map-selection";
    element.setAttribute("aria-label", "Fire origin");
    markerRef.current = new Marker({ element }).setLngLat(position).addTo(map);
  }
}
