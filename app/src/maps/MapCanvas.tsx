import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./maps.css";

export interface MapLocation {
  latitude: number;
  longitude: number;
}

interface MapCanvasProps {
  center?: MapLocation;
  zoom?: number;
  onLocationSelect?: (location: MapLocation) => void;
}

const DEFAULT_CENTER: MapLocation = { latitude: 37.5, longitude: -119.5 };

/** A plain geographic map. The parent controls its starting view and receives selected locations. */
export default function MapCanvas({
  center = DEFAULT_CENTER,
  zoom = 6,
  onLocationSelect,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onLocationSelect);
  const [tileError, setTileError] = useState(false);
  const { latitude, longitude } = center;

  useEffect(() => {
    selectRef.current = onLocationSelect;
  }, [onLocationSelect]);

  useEffect(() => {
    if (!container.current) return;
    const map = L.map(container.current, { minZoom: 2, maxZoom: 19 }).setView(
      [latitude, longitude],
      zoom,
    );
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      keepBuffer: 0,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    let failed = false;
    let timeout: number | undefined;
    tiles.on("loading", () => {
      failed = false;
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setTileError(true), 15_000);
    });
    tiles.on("tileerror", () => {
      failed = true;
      setTileError(true);
    });
    tiles.on("load", () => {
      window.clearTimeout(timeout);
      setTileError(failed);
    });
    tiles.addTo(map);
    L.control.scale({ imperial: false }).addTo(map);

    let marker: L.CircleMarker | undefined;
    map.on("click", (event: L.LeafletMouseEvent) => {
      const position = event.latlng.wrap();
      if (marker) marker.setLatLng(event.latlng);
      else
        marker = L.circleMarker(event.latlng, {
          radius: 6,
          color: "#fff",
          weight: 2,
          fillColor: "#245c4f",
          fillOpacity: 1,
          interactive: false,
        }).addTo(map);
      selectRef.current?.({ latitude: position.lat, longitude: position.lng });
    });

    const resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resize.observe(container.current);
    return () => {
      window.clearTimeout(timeout);
      resize.disconnect();
      map.remove();
    };
  }, [latitude, longitude, zoom]);

  return (
    <div className="geographic-map-container">
      <div
        ref={container}
        className="geographic-map"
        tabIndex={0}
        role="region"
        aria-label="Geographic map. Use arrow keys to pan and plus or minus to zoom."
      />
      {tileError && (
        <p className="map-error" role="status">
          Some map tiles are unavailable. Check your connection and zoom or pan to try another view.
        </p>
      )}
    </div>
  );
}
