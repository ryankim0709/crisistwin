import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { restyleBasemap } from "../replay/basemapStyle";
import { BASEMAP_STYLE_URL, FALLBACK_STYLE, type BasemapStyle } from "../replay/mapLayers";
import { KIND_LABEL, LEVEL_LABEL, STATUS_LABEL, labelPoint, shortKey, wallClock } from "./format";
import type { CommandResponse, GuidanceLevel, LonLat, TwinMonitor } from "./types";

setWorkerUrl(workerUrl);

const STYLE_TIMEOUT_MS = 10_000;
const FOCUS_ZOOM = 14;
const FIT_PADDING = 48;
/** Reports in these states are drawn hollow: not yet confirmed and not closed. */
const OPEN_UNVERIFIED = new Set(["unverified", "corroborated"]);

export const LEVEL_COLOR: Record<GuidanceLevel, string> = {
  evacuate_now: "#ff4d6d",
  be_ready: "#ffb547",
  none: "#8b9aa8",
};
export const MAP_COLOR = {
  fire: "#ff6a1a",
  route: "#3ddbb4",
  hazard: "#ff4d6d",
  report: "#c5d3e0",
  responder: "#c7a6ff",
  help: "#ffd29a",
  queue: "#ffe14d",
};

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean | null>>;
const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const point = (coord: LonLat, properties: Feature["properties"]): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coord },
  properties,
});

async function loadStyle(signal: AbortSignal): Promise<BasemapStyle> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), STYLE_TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal.addEventListener("abort", abort);
  try {
    const response = await fetch(BASEMAP_STYLE_URL, { signal: timeout.signal });
    if (!response.ok) return FALLBACK_STYLE;
    const style: unknown = await response.json();
    if (typeof style !== "object" || style === null || !("layers" in style) || !Array.isArray(style.layers)) {
      return FALLBACK_STYLE;
    }
    return restyleBasemap(style as BasemapStyle);
  } catch {
    return FALLBACK_STYLE;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function buildSources(data: CommandResponse): Record<string, GeoJSON.FeatureCollection> {
  const guidance = new Map(data.guidance.map((g) => [g.zone_id, g]));
  const counts = new Map(data.checkins.by_zone.map((c) => [c.zone_id, c]));

  const zones: Feature[] = [];
  const zoneLabels: Feature[] = [];
  for (const zone of data.zones) {
    const g = guidance.get(zone.id);
    const level: GuidanceLevel = g?.level ?? "none";
    zones.push({ type: "Feature", geometry: zone.geometry, properties: { id: zone.id, level } });
    const c = counts.get(zone.id);
    const anchor = labelPoint(zone.geometry);
    if (c && anchor && c.out + c.need_help + c.staying > 0) {
      const parts = [`${c.out} out`];
      if (c.need_help) parts.push(`${c.need_help} help`);
      if (c.staying) parts.push(`${c.staying} staying`);
      zoneLabels.push(point(anchor, { text: parts.join(" · ") }));
    }
  }

  const routes: Feature[] = data.guidance
    .filter((g) => g.route && g.level !== "none" && g.route.line.length > 1)
    .map((g) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: g.route!.line },
      properties: { zone_id: g.zone_id, level: g.level },
    }));

  const fire: Feature[] = data.fire.geometry
    ? [{ type: "Feature", geometry: data.fire.geometry, properties: { method: data.fire.method } }]
    : [];
  const fireObs = data.fire.observations.map((o) => point(o.coord, { source: o.source }));

  const hazardPoints: Feature[] = [];
  const hazardLines: Feature[] = [];
  for (const item of data.public_items) {
    hazardPoints.push(point(item.coord, { kind: "hazard", id: item.id, label: KIND_LABEL[item.kind] ?? item.kind }));
    if (item.line && item.line.length > 1) {
      hazardLines.push({ type: "Feature", geometry: { type: "LineString", coordinates: item.line }, properties: {} });
    }
  }

  const reports = data.reports
    .filter((r) => OPEN_UNVERIFIED.has(r.status))
    .map((r) =>
      point(r.location.coord, {
        kind: "report",
        id: r.id,
        label: `${KIND_LABEL[r.kind] ?? r.kind} · ${STATUS_LABEL[r.status]} · ${wallClock(r.observed_at)}`,
      }),
    );

  const help = data.checkins.need_help
    .filter((h) => h.coord)
    .map((h) => point(h.coord!, { kind: "help", id: h.id, label: `Needs help · ${wallClock(h.at)}` }));

  const responders = data.responders.map((r) =>
    point(r.coord, { kind: "responder", id: r.party_key, label: `Responder ${shortKey(r.party_key)} · ${wallClock(r.at)}` }),
  );

  return {
    "lc-zones": collection(zones),
    "lc-zone-labels": collection(zoneLabels),
    "lc-fire": collection(fire),
    "lc-fire-obs": collection(fireObs),
    "lc-routes": collection(routes),
    "lc-hazard-lines": collection(hazardLines),
    "lc-points": collection([...reports, ...hazardPoints, ...help, ...responders]),
  };
}

/** Twin queues: one circle per congested edge midpoint, area by queued vehicles. Simulated. */
function buildQueues(twin: TwinMonitor | null): GeoJSON.FeatureCollection {
  if (!twin) return collection([]);
  return collection(
    twin.congested_edges.map((e) =>
      point(e.coord, {
        queued: e.queued_veh,
        label: `Twin (simulated) · ${e.name ?? "Unnamed road"} · ${e.queued_veh} queued · ${Math.round(e.speed_kph)} of ${Math.round(e.free_flow_kph)} km/h`,
      }),
    ),
  );
}

const LEVEL_MATCH = (prop: string, values: Record<GuidanceLevel, string | number>) =>
  ["match", ["get", prop], "evacuate_now", values.evacuate_now, "be_ready", values.be_ready, values.none];

function installLayers(map: MapLibreMap): void {
  const empty = collection([]);
  for (const id of ["lc-zones", "lc-zone-labels", "lc-fire", "lc-fire-obs", "lc-routes", "lc-hazard-lines", "lc-points", "lc-queues", "lc-focus"]) {
    map.addSource(id, { type: "geojson", data: empty });
  }
  map.addLayer({
    id: "lc-zones-fill",
    type: "fill",
    source: "lc-zones",
    paint: {
      "fill-color": LEVEL_MATCH("level", LEVEL_COLOR) as never,
      "fill-opacity": LEVEL_MATCH("level", { evacuate_now: 0.34, be_ready: 0.2, none: 0.04 }) as never,
    },
  });
  map.addLayer({
    id: "lc-zones-line",
    type: "line",
    source: "lc-zones",
    paint: {
      "line-color": LEVEL_MATCH("level", LEVEL_COLOR) as never,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 2, be_ready: 1.5, none: 0.6 }) as never,
      "line-opacity": 0.8,
    },
  });
  map.addLayer({
    id: "lc-fire-fill",
    type: "fill",
    source: "lc-fire",
    paint: { "fill-color": MAP_COLOR.fire, "fill-opacity": 0.35 },
  });
  map.addLayer({
    id: "lc-fire-line",
    type: "line",
    source: "lc-fire",
    paint: { "line-color": MAP_COLOR.fire, "line-width": 2 },
  });
  map.addLayer({
    id: "lc-routes",
    type: "line",
    source: "lc-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": MAP_COLOR.route,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 3.5, be_ready: 2, none: 0 }) as never,
      "line-opacity": LEVEL_MATCH("level", { evacuate_now: 0.95, be_ready: 0.6, none: 0 }) as never,
    },
  });
  map.addLayer({
    id: "lc-hazard-lines",
    type: "line",
    source: "lc-hazard-lines",
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP_COLOR.hazard, "line-width": 5, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "lc-fire-obs",
    type: "circle",
    source: "lc-fire-obs",
    paint: {
      "circle-radius": 2.5,
      "circle-color": MAP_COLOR.fire,
      "circle-stroke-color": "#1a0a00",
      "circle-stroke-width": 0.5,
    },
  });
  map.addLayer({
    id: "lc-queues",
    type: "circle",
    source: "lc-queues",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "queued"]], 0, 4, 3, 7, 8, 13] as never,
      "circle-color": MAP_COLOR.queue,
      "circle-opacity": 0.55,
      "circle-stroke-color": MAP_COLOR.queue,
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "lc-points",
    type: "circle",
    source: "lc-points",
    paint: {
      "circle-radius": ["match", ["get", "kind"], "help", 8, "hazard", 6, 5.5] as never,
      "circle-color": [
        "match",
        ["get", "kind"],
        "hazard",
        MAP_COLOR.hazard,
        "responder",
        MAP_COLOR.responder,
        "help",
        "rgba(0,0,0,0)",
        "rgba(0,0,0,0)",
      ] as never,
      "circle-stroke-color": [
        "match",
        ["get", "kind"],
        "hazard",
        "#ffffff",
        "responder",
        "#0c1117",
        "help",
        MAP_COLOR.help,
        MAP_COLOR.report,
      ] as never,
      "circle-stroke-width": ["match", ["get", "kind"], "help", 3, "report", 2, 1.5] as never,
    },
  });
  map.addLayer({
    id: "lc-zone-labels",
    type: "symbol",
    source: "lc-zone-labels",
    layout: {
      "text-field": ["get", "text"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#e6edf3", "text-halo-color": "rgba(7,10,14,0.9)", "text-halo-width": 1.4 },
  });
  map.addLayer({
    id: "lc-focus",
    type: "circle",
    source: "lc-focus",
    paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface MapFocus {
  id: string;
  coord: LonLat;
}

interface Props {
  data: CommandResponse | null;
  twin: TwinMonitor | null;
  focus: MapFocus | null;
}

export default function CommandMap({ data, twin, focus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef<CommandResponse | null>(data);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    const controller = new AbortController();
    let map: MapLibreMap | null = null;
    loadStyle(controller.signal).then((style) => {
      if (controller.signal.aborted || !container.current) return;
      map = new MapLibreMap({
        container: container.current,
        style,
        center: [-121.6, 39.76],
        zoom: 10,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
      map.on("load", () => {
        if (!map) return;
        installLayers(map);
        setReady(true);
      });
      const popup = new Popup({ closeButton: false, maxWidth: "260px", className: "lc-popup" });
      for (const layer of ["lc-points", "lc-queues"]) {
        map.on("click", layer, (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f || !map) return;
          popup.setLngLat(e.lngLat).setHTML(escapeHtml(String(f.properties.label ?? ""))).addTo(map);
        });
      }
      map.on("click", "lc-zones-fill", (e: MapLayerMouseEvent) => {
        if (!map || map.queryRenderedFeatures(e.point, { layers: ["lc-points", "lc-queues"] }).length) return;
        const id = e.features?.[0]?.properties.id;
        const d = dataRef.current;
        const zone = d?.zones.find((z) => z.id === id);
        if (!zone || !d) return;
        const g = d.guidance.find((x) => x.zone_id === zone.id);
        const c = d.checkins.by_zone.find((x) => x.zone_id === zone.id);
        const lines = [`<strong>${escapeHtml(zone.name)}</strong>`, escapeHtml(LEVEL_LABEL[g?.level ?? "none"])];
        if (g?.no_route) lines.push("No open route");
        if (g?.destination) {
          const via = g.route?.via.length ? ` via ${g.route.via.join(", ")}` : "";
          const eta = g.route ? `, ${g.route.eta_min} min` : "";
          lines.push(escapeHtml(`${g.destination.name}${via}${eta}`));
        }
        if (g) lines.push(`v${g.version} · ${g.approved_by === "auto_policy" ? "auto policy" : "controller"}`);
        lines.push(escapeHtml(`${zone.households.toLocaleString()} households`));
        if (c) lines.push(escapeHtml(`${c.out} out · ${c.need_help} need help · ${c.staying} staying`));
        popup.setLngLat(e.lngLat).setHTML(lines.join("<br>")).addTo(map);
      });
      for (const layer of ["lc-points", "lc-queues", "lc-zones-fill"]) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    });
    return () => {
      controller.abort();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    for (const [id, fc] of Object.entries(buildSources(data))) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
    }
    if (!fitted.current && data.zones.length) {
      const bounds = new LngLatBounds();
      for (const zone of data.zones) {
        const polys = zone.geometry.type === "Polygon" ? [zone.geometry.coordinates] : zone.geometry.coordinates;
        for (const poly of polys) for (const [lon, lat] of poly[0] ?? []) bounds.extend([lon, lat]);
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: FIT_PADDING, duration: 0 });
      fitted.current = true;
    }
  }, [ready, data]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("lc-queues") as GeoJSONSource | undefined)?.setData(buildQueues(twin));
  }, [ready, twin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("lc-focus") as GeoJSONSource | undefined)?.setData(
      collection(focus ? [point(focus.coord, { id: focus.id })] : []),
    );
    if (focus) map.flyTo({ center: focus.coord, zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
  }, [ready, focus]);

  return <div ref={container} className="lc-map" role="region" aria-label="Live command map" />;
}
