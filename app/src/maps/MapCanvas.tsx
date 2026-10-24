import { useEffect, useRef, useState } from "react";
import { Map, Marker, NavigationControl, ScaleControl, type MapOptions } from "maplibre-gl";
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
  onLocationSelect?: (location: MapLocation) => void;
}

const DEFAULT_CENTER: MapLocation = { latitude: 37.75, longitude: -119.6 };
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

export default function MapCanvas({
  center = DEFAULT_CENTER,
  zoom = 11,
  mapStyle = SATELLITE_STYLE,
  onLocationSelect,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onLocationSelect);
  const [error, setError] = useState<string | null>(null);
  const { latitude, longitude } = center;

  useEffect(() => {
    selectRef.current = onLocationSelect;
  }, [onLocationSelect]);

  useEffect(() => {
    if (!container.current) return;
    let map: Map;
    try {
      map = new Map({
        container: container.current,
        style: mapStyle,
        center: [longitude, latitude],
        zoom,
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

    const timeout = window.setTimeout(() => {
      setError("Imagery is taking longer to load. Check your internet connection.");
    }, 15_000);
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
    map.addControl(new NavigationControl(), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        "Satellite map. Use arrow keys to pan and plus or minus to zoom. Press Enter to select the map center.",
      );

    let marker: Marker | undefined;
    function selectLocation(longitude: number, latitude: number) {
      if (marker) marker.setLngLat([longitude, latitude]);
      else {
        const element = document.createElement("div");
        element.className = "map-selection";
        element.setAttribute("aria-label", "Selected location");
        marker = new Marker({ element }).setLngLat([longitude, latitude]).addTo(map);
      }
      const wrappedLongitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
      selectRef.current?.({ latitude, longitude: wrappedLongitude });
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
      marker?.remove();
      map.remove();
    };
  }, [latitude, longitude, zoom, mapStyle]);

  return (
    <div className="geographic-map-container">
      <div ref={container} className="geographic-map" />
      {error && (
        <p className="map-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
