import { useEffect, useMemo, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapOptions,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { attachStations } from "../maps/stations";
import { AERIAL_STYLE } from "../maps/basemap";
import type { Feature, FeatureCollection, Polygon, Position } from "geojson";
import { ARRIVAL_COLORS, CURRENT_PERIMETER_COLOR } from "../fire/FireMap";
import { mercatorToLonLat, type MercatorBox } from "../fire/landscape";
import { formatElapsed, type GeoPoint } from "../fire/spread";
import { Button, Legend, Notice, Panel, Tag } from "../ui";
import type { IgnitionDisplayState, ScheduledIgnition, StudioMapProps } from "./contracts";
import "./studioMap.css";

const DEFAULT_CENTER: GeoPoint = { latitude: 37.88, longitude: -122.24 };
const DEFAULT_ZOOM = 12;
const FIT_MAX_ZOOM = 14;
const FIT_PADDING = 120;
const IMAGERY_LOAD_TIMEOUT_MS = 15_000;
const FOOTPRINT_SOURCE = "studio-footprint";
const BOX_SOURCE = "studio-box";
const FOOTPRINT_FILL_OPACITY = 0.6;
const FOOTPRINT_LINE_OPACITY = 0.95;
/** Dark casing under the light current outline so it reads on any imagery. */
const CURRENT_CASING_COLOR = "#142b27";
/** Line widths in screen pixels (constant at every zoom, so tiny footprints never vanish). */
const CURRENT_LINE_WIDTH = 2.6;
const CURRENT_CASING_WIDTH = 5.4;
/** A footprint whose screen bbox is under this many pixels also gets a locator ring. */
const TINY_FOOTPRINT_PIXELS = 12;
const ZOOM_TO_FIRE_MAX_ZOOM = 17;
const ZOOM_TO_FIRE_PADDING = 140;
const SQUARE_METERS_PER_HECTARE = 10_000;
const STALE_DIM = 0.4;
const LEGEND_BAND_COUNT = 4;
const MARKER_CLASS = "studio-marker";

/** Aerial imagery plus the OpenFreeMap glyphs the people layer's labels need (as on /live). */
const SATELLITE_STYLE: MapOptions["style"] = {
  ...AERIAL_STYLE,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
};

const ARRIVAL_EXPRESSION = [
  "interpolate",
  ["linear"],
  ["get", "arrivalFraction"],
  0,
  ARRIVAL_COLORS.earliest,
  0.5,
  ARRIVAL_COLORS.middle,
  1,
  ARRIVAL_COLORS.latest,
] as const;

interface FootprintProperties {
  elapsedMinutes: number;
  arrivalFraction: number;
  current: boolean;
}
type FootprintCollection = FeatureCollection<Polygon, FootprintProperties>;

const EMPTY_FOOTPRINT: FootprintCollection = { type: "FeatureCollection", features: [] };
const EMPTY_BOX: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };

/** One consistent palette: colour depends only on arrival time relative to the horizon. */
function footprintCollection(
  frames: StudioMapProps["visibleFrames"],
  horizonMinutes: number,
): FootprintCollection {
  const features: Feature<Polygon, FootprintProperties>[] = [];
  frames.forEach((frame, index) => {
    const arrivalFraction =
      horizonMinutes > 0 ? Math.min(1, Math.max(0, frame.elapsedMinutes / horizonMinutes)) : 0;
    for (const perimeter of frame.perimeters) {
      features.push({
        type: "Feature",
        geometry: perimeter.geometry,
        properties: {
          elapsedMinutes: frame.elapsedMinutes,
          arrivalFraction,
          current: index === frames.length - 1,
        },
      });
    }
  });
  // Newest underneath, oldest on top, so the arrival bands stay readable.
  features.sort((a, b) => b.properties.elapsedMinutes - a.properties.elapsedMinutes);
  return { type: "FeatureCollection", features };
}

interface Locator {
  id: string;
  position: [number, number];
  areaSquareMeters: number;
  /** Screen-space bbox size of this fire's footprint is computed in the component. */
  bbox: [number, number, number, number] | null;
}

function polygonBbox(ring: Position[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

function bboxContains(box: [number, number, number, number], [x, y]: [number, number]): boolean {
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

/** "0 ha" for a fire that has ignited but burned nothing yet, otherwise at least two figures. */
function formatHectares(squareMeters: number): string {
  const hectares = squareMeters / SQUARE_METERS_PER_HECTARE;
  if (hectares === 0) return "0 ha";
  return `${hectares < 0.1 ? hectares.toFixed(2) : hectares < 10 ? hectares.toFixed(1) : Math.round(hectares)} ha`;
}

/**
 * One locator per fire ignited by the current frame. Its position is the centre of the bbox of
 * the current-frame polygon that contains the ignition point (a merged polygon shared by
 * several fires, or no polygon, falls back to the ignition point itself). The area is the
 * solver's own per-source figure, never recomputed here.
 */
function locatorsFor(
  frame: StudioMapProps["visibleFrames"][number] | undefined,
  ignitions: ScheduledIgnition[],
  allowPointFallback: boolean,
): Locator[] {
  if (!frame) return [];
  const boxes = frame.perimeters.map((perimeter) => polygonBbox(perimeter.geometry.coordinates[0]));
  const result: Locator[] = [];
  for (const id of frame.ignitedSourceIds) {
    const ignition = ignitions.find((candidate) => candidate.id === id);
    if (!ignition) continue;
    const point: [number, number] = [ignition.location.longitude, ignition.location.latitude];
    const containing = boxes.filter((box) => bboxContains(box, point));
    const area = frame.reachedAreaBySourceSquareMeters[id] ?? 0;
    if (containing.length === 1) {
      const box = containing[0];
      result.push({
        id,
        position: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
        areaSquareMeters: area,
        bbox: box,
      });
    } else if (allowPointFallback) {
      result.push({ id, position: point, areaSquareMeters: area, bbox: null });
    }
  }
  return result;
}

function boxCollection(box: MercatorBox | null): FeatureCollection<Polygon> {
  if (!box) return EMPTY_BOX;
  const corners = [
    mercatorToLonLat(box.minX, box.maxY),
    mercatorToLonLat(box.maxX, box.maxY),
    mercatorToLonLat(box.maxX, box.minY),
    mercatorToLonLat(box.minX, box.minY),
  ];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[...corners, corners[0]]] },
      },
    ],
  };
}

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

// ---------------------------------------------------------------------------------------
// Marker states: each differs in shape, border style and glyph, not just colour.
// ---------------------------------------------------------------------------------------

const STATE_TEXT: Record<IgnitionDisplayState, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  triggered: "Ignited",
  "reached-before-start": "Already reached",
  disabled: "Disabled",
  invalid: "Invalid",
};
const STATE_KEY_ORDER: IgnitionDisplayState[] = [
  "draft",
  "scheduled",
  "triggered",
  "reached-before-start",
  "disabled",
  "invalid",
];
const STATE_KEY_NOTE: Record<IgnitionDisplayState, string> = {
  draft: "Draft (no current result)",
  scheduled: "Scheduled (hollow ring)",
  triggered: "Ignited (flame)",
  "reached-before-start": "Already reached (double ring)",
  disabled: "Disabled (dashed)",
  invalid: "Invalid (square, !)",
};

const FLAME_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z"/></svg>';
const STATE_GLYPH: Record<IgnitionDisplayState, string> = {
  draft: "…",
  scheduled: "",
  triggered: FLAME_SVG,
  "reached-before-start": "✓",
  disabled: "×",
  invalid: "!",
};

function startLabel(ignition: ScheduledIgnition): string {
  return `${ignition.name} · starts ${formatElapsed(ignition.startMinute)}`;
}

function applyMarker(
  element: HTMLButtonElement,
  ignition: ScheduledIgnition,
  state: IgnitionDisplayState,
  selected: boolean,
  detail: string | undefined,
) {
  // Keep the classes MapLibre put on the element: `maplibregl-marker` makes it
  // position:absolute at the container's top-left, which its translate() is relative to.
  // Dropping it left markers in normal flow, each one 28px below the one before.
  const libraryClasses = [...element.classList].filter((name) => name.startsWith("maplibregl-"));
  element.className = [...libraryClasses, MARKER_CLASS, `${MARKER_CLASS}--${state}`].join(" ");
  element.dataset.selected = String(selected);
  element.setAttribute("aria-pressed", String(selected));
  element.setAttribute(
    "aria-label",
    `${ignition.name}, starts ${formatElapsed(ignition.startMinute)}, ${STATE_TEXT[state]}${
      detail ? `, modelled: ${detail}` : ""
    }${selected ? ", selected" : ""}`,
  );
  const icon = element.querySelector<HTMLElement>(".studio-marker__icon");
  if (icon) icon.innerHTML = STATE_GLYPH[state];
  const title = element.querySelector<HTMLElement>(".studio-marker__title");
  if (title) title.textContent = startLabel(ignition);
  const status = element.querySelector<HTMLElement>(".studio-marker__state");
  if (status) status.textContent = STATE_TEXT[state];
  const detailElement = element.querySelector<HTMLElement>(".studio-marker__detail");
  if (detailElement) {
    detailElement.textContent = detail ?? "";
    detailElement.hidden = !detail;
  }
  // The tooltip repeats the modelled line for pointer users; the aria-label keeps it too.
  element.title = detail ? `${ignition.name}: ${detail} (modelled)` : "";
}

function createMarkerElement(): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.innerHTML =
    '<span class="studio-marker__icon" aria-hidden="true"></span>' +
    '<span class="studio-marker__label" aria-hidden="true">' +
    '<span class="studio-marker__title"></span>' +
    '<span class="studio-marker__state"></span>' +
    '<span class="studio-marker__detail" hidden></span></span>';
  return element;
}

// ---------------------------------------------------------------------------------------
// Legend helpers
// ---------------------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function arrivalColor(fraction: number): string {
  const [from, to, local] =
    fraction < 0.5
      ? [ARRIVAL_COLORS.earliest, ARRIVAL_COLORS.middle, fraction / 0.5]
      : [ARRIVAL_COLORS.middle, ARRIVAL_COLORS.latest, (fraction - 0.5) / 0.5];
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return `rgb(${a.map((channel, i) => Math.round(channel + (b[i] - channel) * local)).join(" ")})`;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

export default function StudioMap({
  ignitions,
  ignitionStates,
  selectedId,
  mode,
  visibleFrames,
  currentMinute,
  horizonMinutes,
  windSpeedMph,
  windFromDegrees,
  landscapeBox,
  footprintIsStale,
  ignitionDetails,
  warnings,
  attribution,
  onMapClick,
  onSelectIgnition,
  onMoveIgnition,
  onMapReady,
  legendExtra,
  legendMode = "full",
  recenterKey,
}: StudioMapProps) {
  const compactLegend = legendMode === "compact";
  const [legendOpen, setLegendOpen] = useState(!compactLegend);
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const boxLabel = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locatorMarkers = useRef(new Map<string, Marker>());
  // Bumped when the camera moves so screen-size checks are recomputed.
  const [viewTick, setViewTick] = useState(0);

  useEffect(() => {
    const map = mapRef.current;
    if (!recenterKey || !map || !ready) return;
    const bounds = new LngLatBounds();
    let any = false;
    for (const { location, enabled } of ignitionsRef.current) {
      if (!enabled) continue;
      bounds.extend([location.longitude, location.latitude]);
      any = true;
    }
    if (any) map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 0 });
  }, [recenterKey, ready]);

  // Handlers and mode are read through refs so the map is created once.
  const clickRef = useRef(onMapClick);
  const selectRef = useRef(onSelectIgnition);
  const moveRef = useRef(onMoveIgnition);
  const modeRef = useRef(mode);
  const ignitionsRef = useRef(ignitions);
  const mapReadyRef = useRef(onMapReady);
  useEffect(() => {
    clickRef.current = onMapClick;
    selectRef.current = onSelectIgnition;
    moveRef.current = onMoveIgnition;
    modeRef.current = mode;
    ignitionsRef.current = ignitions;
    mapReadyRef.current = onMapReady;
  }, [onMapClick, onSelectIgnition, onMoveIgnition, mode, ignitions, onMapReady]);

  useEffect(() => {
    if (!container.current) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
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

    // Fit once on mount; later edits never move the camera.
    const initial = ignitionsRef.current;
    if (initial.length > 0) {
      const bounds = new LngLatBounds();
      for (const { location } of initial) bounds.extend([location.longitude, location.latitude]);
      map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 0 });
    }

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

    map.on("zoomend", () => setViewTick((tick) => tick + 1));
    map.on("moveend", () => setViewTick((tick) => tick + 1));
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

    let stations: ReturnType<typeof attachStations> | null = null;
    map.on("load", () => {
      stations = attachStations(map);
      map.addSource(BOX_SOURCE, { type: "geojson", data: EMPTY_BOX });
      map.addLayer({
        id: "studio-box-line",
        type: "line",
        source: BOX_SOURCE,
        paint: {
          "line-color": "#f5f4ee",
          "line-width": 1.5,
          "line-opacity": 0.7,
          "line-dasharray": [3, 3],
        },
      });
      map.addSource(FOOTPRINT_SOURCE, { type: "geojson", data: EMPTY_FOOTPRINT });
      map.addLayer({
        id: "studio-footprint-fill",
        type: "fill",
        source: FOOTPRINT_SOURCE,
        paint: {
          "fill-color": ARRIVAL_EXPRESSION as unknown as string,
          "fill-opacity": FOOTPRINT_FILL_OPACITY,
        },
      });
      map.addLayer({
        id: "studio-footprint-line",
        type: "line",
        source: FOOTPRINT_SOURCE,
        paint: {
          "line-color": ARRIVAL_EXPRESSION as unknown as string,
          "line-width": 1.6,
          "line-opacity": FOOTPRINT_LINE_OPACITY,
        },
      });
      // Layer order, bottom to top: imagery, modelled-area box, footprint fill, every frame's
      // outline, the current frame's dark casing and light line. Ignition markers and locator
      // rings are DOM markers, so they always sit above all of these.
      map.addLayer({
        id: "studio-footprint-casing",
        type: "line",
        source: FOOTPRINT_SOURCE,
        filter: ["==", ["get", "current"], true],
        layout: { "line-join": "round" },
        paint: { "line-color": CURRENT_CASING_COLOR, "line-width": CURRENT_CASING_WIDTH },
      });
      map.addLayer({
        id: "studio-footprint-current",
        type: "line",
        source: FOOTPRINT_SOURCE,
        filter: ["==", ["get", "current"], true],
        layout: { "line-join": "round" },
        paint: { "line-color": CURRENT_PERIMETER_COLOR, "line-width": CURRENT_LINE_WIDTH },
      });
      setReady(true);
      mapReadyRef.current?.(map);
    });

    function emitPoint(longitude: number, latitude: number) {
      clickRef.current({ latitude, longitude: wrapLongitude(longitude) });
    }
    map.on("click", (event) => {
      const target = event.originalEvent.target;
      // A click on a marker belongs to the marker, never to the map.
      if (target instanceof Element && target.closest(`.${MARKER_CLASS}`)) return;
      if (modeRef.current === "select") selectRef.current(null);
      else emitPoint(event.lngLat.lng, event.lngLat.lat);
    });
    function pointAtCenter(event: KeyboardEvent) {
      if (event.key !== "Enter" || modeRef.current === "select") return;
      const center = map.getCenter();
      emitPoint(center.lng, center.lat);
    }
    const canvas = map.getCanvas();
    canvas.addEventListener("keydown", pointAtCenter);

    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);

    const markerMap = markers.current;
    return () => {
      window.clearTimeout(timeout);
      resize.disconnect();
      canvas.removeEventListener("keydown", pointAtCenter);
      for (const marker of markerMap.values()) marker.remove();
      markerMap.clear();
      for (const marker of locatorMarkers.current.values()) marker.remove();
      locatorMarkers.current.clear();
      boxLabel.current?.remove();
      boxLabel.current = null;
      setReady(false);
      mapReadyRef.current?.(null);
      stations?.dispose();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Cursor and canvas description follow the interaction mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = mode === "select" ? "" : "crosshair";
    canvas.setAttribute(
      "aria-label",
      mode === "add"
        ? "Aerial map. Click, or press Enter, to add a fire at that location. Arrow keys pan, plus and minus zoom."
        : mode === "move"
          ? "Aerial map. Click, or press Enter, to move the selected fire to that location. Arrow keys pan, plus and minus zoom."
          : "Aerial map. Select a fire marker, or click empty map to clear the selection. Arrow keys pan, plus and minus zoom.",
    );
  }, [mode]);

  // Ignition markers: created once per id, then updated in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = new Set(ignitions.map((ignition) => ignition.id));
    for (const [id, marker] of markers.current) {
      if (!live.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    for (const ignition of ignitions) {
      const state = ignitionStates[ignition.id] ?? "draft";
      const position: [number, number] = [ignition.location.longitude, ignition.location.latitude];
      let marker = markers.current.get(ignition.id);
      if (!marker) {
        const id = ignition.id;
        const element = createMarkerElement();
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          selectRef.current(id);
        });
        marker = new Marker({ element, draggable: true, anchor: "center" })
          .setLngLat(position)
          .addTo(map);
        const created = marker;
        created.on("dragend", () => {
          const { lng, lat } = created.getLngLat();
          moveRef.current(id, { latitude: lat, longitude: wrapLongitude(lng) });
        });
        markers.current.set(id, marker);
      } else {
        marker.setLngLat(position);
      }
      applyMarker(
        marker.getElement() as HTMLButtonElement,
        ignition,
        state,
        ignition.id === selectedId,
        ignitionDetails?.[ignition.id],
      );
    }
  }, [ignitions, ignitionStates, selectedId, ready, ignitionDetails]);

  const footprint = useMemo(
    () => footprintCollection(visibleFrames, horizonMinutes),
    [visibleFrames, horizonMinutes],
  );

  const currentFrame = visibleFrames[visibleFrames.length - 1];

  // Locator rings: a dashed ring and area label at each ignited fire whose footprint is
  // under TINY_FOOTPRINT_PIXELS across at this zoom. A locator, not burned area.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const wanted = new Map<string, { locator: Locator; element: HTMLElement | null }>();
    for (const locator of locatorsFor(currentFrame, ignitions, !footprintIsStale)) {
      let tiny = true;
      if (locator.bbox) {
        const low = map.project([locator.bbox[0], locator.bbox[1]]);
        const high = map.project([locator.bbox[2], locator.bbox[3]]);
        tiny = Math.max(Math.abs(high.x - low.x), Math.abs(high.y - low.y)) < TINY_FOOTPRINT_PIXELS;
      }
      if (tiny) wanted.set(locator.id, { locator, element: null });
    }
    for (const [id, marker] of locatorMarkers.current) {
      if (!wanted.has(id)) {
        marker.remove();
        locatorMarkers.current.delete(id);
      }
    }
    for (const { locator } of wanted.values()) {
      let marker = locatorMarkers.current.get(locator.id);
      if (!marker) {
        const element = document.createElement("div");
        element.className = "studio-locator";
        element.innerHTML = '<span class="studio-locator__label"></span>';
        marker = new Marker({ element, anchor: "center" }).setLngLat(locator.position).addTo(map);
        locatorMarkers.current.set(locator.id, marker);
      } else {
        marker.setLngLat(locator.position);
      }
      const element = marker.getElement();
      element.dataset.stale = String(footprintIsStale);
      const label = element.querySelector<HTMLElement>(".studio-locator__label");
      if (label) {
        label.textContent = `${formatHectares(locator.areaSquareMeters)}${
          footprintIsStale ? " (previous run)" : ""
        }`;
      }
    }
  }, [ready, currentFrame, ignitions, footprintIsStale, viewTick]);

  // Explicit user action only; playback never moves the camera.
  const zoomToFire = () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = new LngLatBounds();
    let any = false;
    for (const perimeter of currentFrame?.perimeters ?? []) {
      for (const [longitude, latitude] of perimeter.geometry.coordinates[0]) {
        bounds.extend([longitude, latitude]);
        any = true;
      }
    }
    if (!any) {
      for (const { location, enabled } of ignitions) {
        if (!enabled) continue;
        bounds.extend([location.longitude, location.latitude]);
        any = true;
      }
    }
    if (!any) return;
    map.fitBounds(bounds, {
      padding: ZOOM_TO_FIRE_PADDING,
      maxZoom: ZOOM_TO_FIRE_MAX_ZOOM,
      duration: 600,
    });
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map
      .getSource<GeoJSONSource>(FOOTPRINT_SOURCE)
      ?.setData(footprint)
      .catch(() => setError("The modelled footprint could not be displayed."));
  }, [ready, footprint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const scale = footprintIsStale ? STALE_DIM : 1;
    map.setPaintProperty("studio-footprint-fill", "fill-opacity", FOOTPRINT_FILL_OPACITY * scale);
    map.setPaintProperty("studio-footprint-line", "line-opacity", FOOTPRINT_LINE_OPACITY * scale);
    map.setPaintProperty("studio-footprint-casing", "line-opacity", scale);
    map.setPaintProperty("studio-footprint-current", "line-opacity", scale);
  }, [ready, footprintIsStale]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map
      .getSource<GeoJSONSource>(BOX_SOURCE)
      ?.setData(boxCollection(landscapeBox))
      .catch(() => setError("The modelled area outline could not be displayed."));
    if (!landscapeBox) {
      boxLabel.current?.remove();
      boxLabel.current = null;
      return;
    }
    const corner = mercatorToLonLat(landscapeBox.minX, landscapeBox.maxY);
    if (!boxLabel.current) {
      const element = document.createElement("div");
      element.className = "studio-box-label";
      element.textContent = "Modelled area";
      boxLabel.current = new Marker({ element, anchor: "top-left", offset: [6, 6] })
        .setLngLat(corner)
        .addTo(map);
    } else {
      boxLabel.current.setLngLat(corner);
    }
  }, [ready, landscapeBox]);

  const windToward = (((windFromDegrees + 180) % 360) + 360) % 360;
  const windFrom = ((windFromDegrees % 360) + 360) % 360;
  const compass = COMPASS[Math.round(windFrom / 22.5) % 16];
  const windCaption = `Wind from ${compass} (${Math.round(windFrom)}°) · ${Math.round(
    windSpeedMph,
  )} mph (20-ft)`;

  const bands = Array.from({ length: LEGEND_BAND_COUNT }, (_, i) => ({
    from: Math.round((horizonMinutes * i) / LEGEND_BAND_COUNT),
    to: Math.round((horizonMinutes * (i + 1)) / LEGEND_BAND_COUNT),
    color: arrivalColor((i + 0.5) / LEGEND_BAND_COUNT),
  }));

  return (
    <div className="studio-map">
      <div ref={container} className="studio-map__canvas" />

      <Button variant="secondary" size="sm" className="studio-map__zoom-fire" onClick={zoomToFire}>
        Zoom to fire
      </Button>

      <div className="studio-map__banners">
        {footprintIsStale && (
          <div role="status">
            <Tag tone="warning">Previous run, out of date</Tag>
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="studio-map__warnings" aria-label="Model warnings">
            {warnings.map((warning) => (
              <li key={warning}>
                <Notice className="studio-map__warning">
                  <span aria-hidden="true">⚠</span> {warning}
                </Notice>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="studio-map__wind ui-theme-dark" role="img" aria-label={windCaption}>
        <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: `rotate(${windToward}deg)`,
              transformOrigin: "20px 20px",
            }}
          >
            <line x1="20" y1="34" x2="20" y2="8" />
            <path d="M12 16 L20 6 L28 16" />
          </g>
        </svg>
        <span>{windCaption}</span>
      </div>

      {compactLegend && (
        <Button
          variant="secondary"
          size="sm"
          className="studio-map__legend-toggle"
          aria-expanded={legendOpen}
          aria-controls="studio-map-legend"
          onClick={() => setLegendOpen((open) => !open)}
        >
          {legendOpen ? "Hide legend" : "Legend"}
        </Button>
      )}
      {legendOpen && (
        <Panel
          glass
          compact
          id="studio-map-legend"
          className={`ui-theme-dark studio-map__legend${compactLegend ? " studio-map__legend--compact" : ""}`}
          aria-label="Map legend"
        >
          {!compactLegend && (
            <div className="studio-map__legend-group studio-map__legend-group--assumption">
              <h3>Your assumptions</h3>
              <ul className="studio-map__states">
                {STATE_KEY_ORDER.map((state) => (
                  <li key={state}>
                    <span
                      className={`${MARKER_CLASS} ${MARKER_CLASS}--${state} studio-marker--key`}
                      aria-hidden="true"
                    >
                      <span
                        className="studio-marker__icon"
                        dangerouslySetInnerHTML={{ __html: STATE_GLYPH[state] }}
                      />
                    </span>
                    {STATE_KEY_NOTE[state]}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="studio-map__legend-group studio-map__legend-group--output">
            <h3>Modelled output</h3>
            <p className="studio-map__legend-sub">Arrival time, minutes from T+0</p>
            <Legend
              label="Arrival time bands"
              items={bands.map((band) => ({
                label: `${band.from}–${band.to} min`,
                color: band.color,
              }))}
            />
            <ul className="ui-legend studio-map__extras">
              <li>
                <span className="studio-map__swatch studio-map__swatch--current" />
                Current extent, {formatElapsed(currentMinute)}
              </li>
              {!compactLegend && (
                <li>
                  <span className="studio-map__swatch studio-map__swatch--locator" />
                  Locator ring: footprint too small to see at this zoom (dashed, not burned area)
                </li>
              )}
            </ul>
          </div>
          {legendExtra}
          <div className="studio-map__legend-group studio-map__legend-group--source">
            <h3>Source data</h3>
            <ul className="studio-map__sources">
              <li>Imagery: USDA / USGS The National Map</li>
              {attribution.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </Panel>
      )}

      {error && (
        <Notice tone="danger" className="studio-map__error">
          {error}
        </Notice>
      )}
    </div>
  );
}
