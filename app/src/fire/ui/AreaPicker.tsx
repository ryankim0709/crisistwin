import { useEffect, useRef, useState } from "react";
import { Map, Marker, NavigationControl, type MapOptions } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoPoint } from "../spread";
import type { AreaSizeId } from "./areaSize";

export const DEFAULT_AREA: AreaPreset = {
  id: "berkeley",
  label: "Berkeley Hills, CA",
  point: { latitude: 37.88, longitude: -122.24 },
};

export type AreaPreset = {
  id: string;
  label: string;
  point: GeoPoint;
  /** Also selects this area size (the Bay Area preset only makes sense wide). */
  areaSize?: AreaSizeId;
};

/** LANDFIRE FBFM40 is a CONUS product, so non-CONUS places (Lahaina, HI) are not offered. */
export const AREA_PRESETS: readonly AreaPreset[] = [
  DEFAULT_AREA,
  { id: "paradise", label: "Paradise, CA", point: { latitude: 39.76, longitude: -121.62 } },
  { id: "malibu", label: "Malibu / Woolsey, CA", point: { latitude: 34.08, longitude: -118.79 } },
  {
    id: "bay-area",
    label: "San Francisco Bay Area",
    point: { latitude: 37.77, longitude: -122.27 },
    areaSize: "bay",
  },
];

/** Rough CONUS box; a click outside it cannot load LANDFIRE fuels. */
const CONUS = { south: 24.4, north: 49.5, west: -125.0, east: -66.9 };
const LOCATOR_ZOOM = 6;
const IMAGERY_LOAD_TIMEOUT_MS = 15_000;

function insideConus(point: GeoPoint): boolean {
  return (
    point.latitude >= CONUS.south &&
    point.latitude <= CONUS.north &&
    point.longitude >= CONUS.west &&
    point.longitude <= CONUS.east
  );
}

const LOCATOR_STYLE: MapOptions["style"] = {
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

type AreaPickerProps = {
  current: GeoPoint;
  onSelect: (point: GeoPoint, areaSize?: AreaSizeId) => void;
  onClose: () => void;
};

/** Dialog for choosing the area the board is built from: presets, or a click on a locator map. */
export default function AreaPicker({ current, onSelect, onClose }: AreaPickerProps) {
  const mapHost = useRef<HTMLDivElement>(null);
  const markerRef = useRef<Marker | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [picked, setPicked] = useState<GeoPoint | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus moves in once on open and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    return () => {
      const target =
        opener && opener.isConnected ? opener : document.getElementById("fr-change-area");
      target?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === titleRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const host = mapHost.current;
    if (!host) return;
    let map: Map;
    try {
      map = new Map({
        container: host,
        style: LOCATOR_STYLE,
        center: [current.longitude, current.latitude],
        zoom: LOCATOR_ZOOM,
        minZoom: 2,
        maxZoom: 12,
        attributionControl: { compact: true },
      });
    } catch (cause) {
      setMapError(
        cause instanceof Error
          ? `Unable to start the locator map: ${cause.message}`
          : "Unable to start the locator map. It needs WebGL support.",
      );
      return;
    }
    const timeout = window.setTimeout(
      () => setMapError("Imagery is taking longer to load. The place presets still work."),
      IMAGERY_LOAD_TIMEOUT_MS,
    );
    map.on("idle", () => {
      window.clearTimeout(timeout);
      setMapError(null);
    });
    map.on("error", () => setMapError("Some imagery could not load. The place presets still work."));
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    const element = document.createElement("div");
    element.className = "fr-locator-pin";
    const marker = new Marker({ element })
      .setLngLat([current.longitude, current.latitude])
      .addTo(map);
    markerRef.current = marker;
    map.on("click", (event) => {
      const point = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
      marker.setLngLat([point.longitude, point.latitude]);
      setPicked(point);
    });
    return () => {
      window.clearTimeout(timeout);
      markerRef.current = null;
      map.remove();
    };
  }, [current]);

  const pickedOutside = picked !== null && !insideConus(picked);

  return (
    <div className="fr-area-scrim" onClick={onClose}>
      <section
        ref={dialogRef}
        className="fr-area fr-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fr-area-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fr-area-head">
          <h2 id="fr-area-title" tabIndex={-1} ref={titleRef}>
            Change area
          </h2>
          <button type="button" className="fr-icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </header>
        <p className="fr-hint">
          Pick the place the miniature is built from. Changing area clears the ignition point and
          the run.
        </p>
        <ul className="fr-area-presets" aria-label="Preset places">
          {AREA_PRESETS.map((preset) => (
            <li key={preset.id}>
              <button type="button" className="fr-chip-btn" onClick={() => onSelect(preset.point, preset.areaSize)}>
                {preset.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="fr-area-or">Or click the locator map to choose a new centre</p>
        <div className="fr-locator">
          <div
            ref={mapHost}
            className="fr-locator-map"
            role="application"
            aria-label="Locator map. Click to choose the new area centre. Arrow keys pan, plus and minus zoom."
          />
          {mapError && (
            <p className="fr-locator-error" role="status">
              {mapError}
            </p>
          )}
        </div>
        <footer className="fr-area-foot">
          <span className="fr-readout" aria-live="polite">
            {picked
              ? `${picked.latitude.toFixed(3)}, ${picked.longitude.toFixed(3)}${
                  pickedOutside ? " · outside LANDFIRE coverage (contiguous US only)" : ""
                }`
              : "No point picked yet."}
          </span>
          <button
            type="button"
            className="fr-btn fr-btn--primary"
            disabled={!picked || pickedOutside}
            onClick={() => picked && onSelect(picked)}
          >
            Use this area
          </button>
        </footer>
      </section>
    </div>
  );
}
