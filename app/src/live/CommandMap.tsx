import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
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
import { VERDICT, labelPoint, nf, plural, shortKey, shortZoneName, wallClock } from "./format";
import type { QueueItem } from "./queue";
import type { CommandResponse, GuidanceLevel, ImpactResponse, LonLat, TwinMonitor } from "./types";

setWorkerUrl(workerUrl);

const STYLE_TIMEOUT_MS = 10_000;
const FOCUS_ZOOM = 13.5;
const FIT_PADDING = 56;

/** MapLibre paint cannot read CSS variables; these mirror the --lc-* tokens in live.css. */
export const LEVEL_COLOR: Record<GuidanceLevel, string> = {
  evacuate_now: "#FF5147",
  be_ready: "#FFB938",
  none: "#9DA29F",
};
export const MAP_COLOR = {
  fire: "#FF7A33",
  route: "#3D9BFF",
  casing: "#FFFFFF",
  hazard: "#FF5147",
  report: "#1B2430",
  responder: "#6B5BD2",
  help: "#F5A623",
  queue: "#8A6D00",
  shelter: "#2E7D5B",
  ink: "#0F1720",
};

export type LayerKey = "zones" | "fire" | "reports" | "roads" | "shelters";
export const LAYER_KEYS: LayerKey[] = ["zones", "fire", "reports", "roads", "shelters"];
const LAYER_IDS: Record<LayerKey, string[]> = {
  zones: ["lc-zones-fill", "lc-zones-line", "lc-zone-labels"],
  fire: ["lc-fire-fill", "lc-fire-line", "lc-fire-obs"],
  reports: ["lc-points", "lc-help", "lc-responders"],
  roads: ["lc-routes-casing", "lc-routes", "lc-hazard-casing", "lc-hazard-lines", "lc-queues"],
  shelters: ["lc-dest", "lc-dest-labels"],
};

export interface MapFocus {
  id: string;
  coord: LonLat;
}

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean | null>>;
const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const point = (coord: LonLat, properties: Feature["properties"]): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coord },
  properties,
});
const lineFeature = (coords: LonLat[], properties: Feature["properties"] = {}): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: coords },
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

function buildSources(data: CommandResponse, items: QueueItem[]): Record<string, GeoJSON.FeatureCollection> {
  const guidance = new Map(data.guidance.map((g) => [g.zone_id, g]));
  const counts = new Map(data.checkins.by_zone.map((c) => [c.zone_id, c]));

  const zones: Feature[] = [];
  const zoneLabels: Feature[] = [];
  for (const zone of data.zones) {
    const level: GuidanceLevel = guidance.get(zone.id)?.level ?? "none";
    zones.push({ type: "Feature", geometry: zone.geometry, properties: { id: zone.id, level } });
    const c = counts.get(zone.id);
    const anchor = labelPoint(zone.geometry);
    if (c && anchor && c.out + c.need_help > 0) {
      zoneLabels.push(point(anchor, { text: c.need_help ? `${c.out} out, ${c.need_help} help` : `${c.out} out` }));
    }
  }

  const routes = data.guidance
    .filter((g) => g.route && g.level !== "none" && g.route.line.length > 1)
    .map((g) => lineFeature(g.route!.line, { zone_id: g.zone_id, level: g.level }));

  const fire: Feature[] = data.fire.geometry
    ? [{ type: "Feature", geometry: data.fire.geometry, properties: { method: data.fire.method } }]
    : [];
  const fireObs = data.fire.observations.map((o) => point(o.coord, { source: o.source }));

  const hazardLines = data.public_items
    .filter((i) => i.kind === "road_blocked" && i.line && i.line.length > 1)
    .map((i) => lineFeature(i.line!, { id: i.id, confirmed: i.controller_confirmed }));

  const points = items.map((item) =>
    point(item.coord, {
      item: item.id,
      kind: item.kind,
      state: item.confirmed ? "confirmed" : item.kind === "fire_seen" ? "fire" : "open",
    }),
  );
  const help = data.checkins.need_help
    .filter((h) => h.coord)
    .map((h) => point(h.coord!, { label: `Needs help, ${wallClock(h.at)}` }));
  const responders = data.responders.map((r) =>
    point(r.coord, { label: `Responder ${shortKey(r.party_key)}, ${wallClock(r.at)}` }),
  );
  const dests = data.destinations
    .filter((d) => d.kind !== "exit")
    .map((d) =>
      point(d.coord, {
        kind: d.kind,
        name: d.name,
        label: `${d.name}${d.capacity_veh !== null ? `, ${nf(d.capacity_veh)} vehicles` : ", capacity unknown"}`,
      }),
    );

  return {
    "lc-zones": collection(zones),
    "lc-zone-labels": collection(zoneLabels),
    "lc-fire": collection(fire),
    "lc-fire-obs": collection(fireObs),
    "lc-routes": collection(routes),
    "lc-hazard-lines": collection(hazardLines),
    "lc-points": collection(points),
    "lc-help": collection(help),
    "lc-responders": collection(responders),
    "lc-dest": collection(dests),
  };
}

/** Twin queues: one circle per congested edge midpoint, area by queued vehicles. Simulated. */
function buildQueues(twin: TwinMonitor | null): GeoJSON.FeatureCollection {
  if (!twin) return collection([]);
  return collection(
    twin.congested_edges.map((e) =>
      point(e.coord, {
        queued: e.queued_veh,
        label: `Twin, simulated: ${e.name ?? "Unnamed road"}, ${e.queued_veh} queued, ${Math.round(e.speed_kph)} of ${Math.round(e.free_flow_kph)} km/h`,
      }),
    ),
  );
}

/** Run impact: affected zones, the route now (solid) and in the other state (dashed), the road. */
function buildImpact(data: CommandResponse, impact: ImpactResponse | null): Record<string, GeoJSON.FeatureCollection> {
  if (!impact) {
    return { "lc-imp-zones": collection([]), "lc-imp-now": collection([]), "lc-imp-alt": collection([]), "lc-imp-road": collection([]) };
  }
  const geom = new Map(data.zones.map((z) => [z.id, z.geometry]));
  const blockedNow = impact.target.state === "blocked";
  const now: Feature[] = [];
  const alt: Feature[] = [];
  const zones: Feature[] = [];
  for (const z of impact.zones) {
    const g = geom.get(z.zone_id);
    if (g) zones.push({ type: "Feature", geometry: g, properties: { id: z.zone_id } });
    const current = blockedNow ? z.blocked : z.unblocked;
    const other = blockedNow ? z.unblocked : z.blocked;
    if (current) now.push(lineFeature(current.route.line));
    if (other) alt.push(lineFeature(other.route.line));
  }
  return {
    "lc-imp-zones": collection(zones),
    "lc-imp-now": collection(now),
    "lc-imp-alt": collection(alt),
    "lc-imp-road": collection([lineFeature(impact.target.line)]),
  };
}

const LEVEL_MATCH = (prop: string, values: Record<GuidanceLevel, string | number>) =>
  ["match", ["get", prop], "evacuate_now", values.evacuate_now, "be_ready", values.be_ready, values.none];

const SOURCES = [
  "lc-zones", "lc-zone-labels", "lc-fire", "lc-fire-obs", "lc-routes", "lc-hazard-lines", "lc-points", "lc-help",
  "lc-responders", "lc-dest", "lc-queues", "lc-focus", "lc-imp-zones", "lc-imp-now", "lc-imp-alt", "lc-imp-road",
];

function installLayers(map: MapLibreMap): void {
  const empty = collection([]);
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({
    id: "lc-zones-fill",
    type: "fill",
    source: "lc-zones",
    paint: {
      "fill-color": LEVEL_MATCH("level", LEVEL_COLOR) as never,
      "fill-opacity": LEVEL_MATCH("level", { evacuate_now: 0.12, be_ready: 0.12, none: 0.02 }) as never,
    },
  });
  map.addLayer({
    id: "lc-zones-line",
    type: "line",
    source: "lc-zones",
    paint: {
      "line-color": LEVEL_MATCH("level", LEVEL_COLOR) as never,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 2, be_ready: 2, none: 0.6 }) as never,
      "line-opacity": LEVEL_MATCH("level", { evacuate_now: 0.9, be_ready: 0.9, none: 0.5 }) as never,
    },
  });
  map.addLayer({ id: "lc-imp-zones", type: "fill", source: "lc-imp-zones", paint: { "fill-color": MAP_COLOR.route, "fill-opacity": 0.15 } });
  map.addLayer({ id: "lc-fire-fill", type: "fill", source: "lc-fire", paint: { "fill-color": MAP_COLOR.fire, "fill-opacity": 0.28 } });
  map.addLayer({
    id: "lc-fire-line",
    type: "line",
    source: "lc-fire",
    paint: {
      "line-color": MAP_COLOR.fire,
      "line-width": 2,
      "line-dasharray": ["case", ["==", ["get", "method"], "model_nowcast"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
    },
  });
  map.addLayer({
    id: "lc-routes-casing",
    type: "line",
    source: "lc-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": LEVEL_MATCH("level", { evacuate_now: 6, be_ready: 4.5, none: 0 }) as never },
  });
  map.addLayer({
    id: "lc-routes",
    type: "line",
    source: "lc-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": MAP_COLOR.route,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 3, be_ready: 2, none: 0 }) as never,
      "line-opacity": LEVEL_MATCH("level", { evacuate_now: 1, be_ready: 0.7, none: 0 }) as never,
    },
  });
  map.addLayer({
    id: "lc-imp-alt",
    type: "line",
    source: "lc-imp-alt",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.ink, "line-width": 2.5, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "lc-imp-now",
    type: "line",
    source: "lc-imp-now",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.route, "line-width": 4 },
  });
  map.addLayer({
    id: "lc-hazard-casing",
    type: "line",
    source: "lc-hazard-lines",
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": 9 },
  });
  map.addLayer({
    id: "lc-hazard-lines",
    type: "line",
    source: "lc-hazard-lines",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": MAP_COLOR.hazard,
      "line-width": 5,
      "line-dasharray": ["case", ["get", "confirmed"], ["literal", [1, 0]], ["literal", [1.5, 1]]] as never,
    },
  });
  map.addLayer({
    id: "lc-imp-road",
    type: "line",
    source: "lc-imp-road",
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP_COLOR.ink, "line-width": 2, "line-gap-width": 6 },
  });
  map.addLayer({
    id: "lc-fire-obs",
    type: "circle",
    source: "lc-fire-obs",
    paint: { "circle-radius": 2.5, "circle-color": MAP_COLOR.fire, "circle-stroke-color": "#3A1600", "circle-stroke-width": 0.5 },
  });
  map.addLayer({
    id: "lc-queues",
    type: "circle",
    source: "lc-queues",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "queued"]], 0, 4, 3, 7, 8, 13] as never,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": MAP_COLOR.queue,
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "lc-dest",
    type: "circle",
    source: "lc-dest",
    paint: {
      "circle-radius": 4.5,
      "circle-color": "#FFFFFF",
      "circle-stroke-color": MAP_COLOR.shelter,
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "lc-dest-labels",
    type: "symbol",
    source: "lc-dest",
    minzoom: 12.5,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: { "text-color": MAP_COLOR.shelter, "text-halo-color": "#FFFFFF", "text-halo-width": 1.4 },
  });
  map.addLayer({
    id: "lc-focus",
    type: "circle",
    source: "lc-focus",
    paint: {
      "circle-radius": 17,
      "circle-color": "rgba(61,155,255,0.18)",
      "circle-stroke-color": MAP_COLOR.route,
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "lc-help",
    type: "circle",
    source: "lc-help",
    paint: { "circle-radius": 7, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": MAP_COLOR.help, "circle-stroke-width": 3 },
  });
  map.addLayer({
    id: "lc-responders",
    type: "circle",
    source: "lc-responders",
    paint: { "circle-radius": 5, "circle-color": MAP_COLOR.responder, "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 1.5 },
  });
  map.addLayer({
    id: "lc-points",
    type: "circle",
    source: "lc-points",
    paint: {
      "circle-radius": ["match", ["get", "state"], "confirmed", 7, 6] as never,
      "circle-color": ["match", ["get", "state"], "confirmed", MAP_COLOR.hazard, "#FFFFFF"] as never,
      "circle-stroke-color": [
        "match",
        ["get", "state"],
        "confirmed",
        "#FFFFFF",
        "fire",
        MAP_COLOR.fire,
        MAP_COLOR.report,
      ] as never,
      "circle-stroke-width": ["match", ["get", "state"], "confirmed", 2, 2.5] as never,
    },
  });
  map.addLayer({
    id: "lc-zone-labels",
    type: "symbol",
    source: "lc-zone-labels",
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 11 },
    paint: { "text-color": MAP_COLOR.ink, "text-halo-color": "#FFFFFF", "text-halo-width": 1.4 },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function impactLabel(impact: ImpactResponse): string {
  const s = impact.summary;
  const parts = [
    s.eta_delta_min == null ? null : `${s.eta_delta_min > 0 ? "+" : ""}${s.eta_delta_min} min`,
    plural(s.affected_zones, "zone"),
    `${nf(s.vehicles_at_risk)} vehicles`,
  ];
  return parts.filter(Boolean).join(", ");
}

interface Props {
  data: CommandResponse | null;
  twin: TwinMonitor | null;
  items: QueueItem[];
  selected: QueueItem | null;
  focus: MapFocus | null;
  layers: Record<LayerKey, boolean>;
  impact: ImpactResponse | null;
  onSelect: (itemId: string | null) => void;
}

export default function CommandMap({ data, twin, items, selected, focus, layers, impact, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef<CommandResponse | null>(data);
  const onSelectRef = useRef(onSelect);
  const labelRef = useRef<Marker | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dataRef.current = data;
    onSelectRef.current = onSelect;
  }, [data, onSelect]);

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
      map.on("click", "lc-points", (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties.item;
        if (typeof id === "string") onSelectRef.current(id);
      });
      for (const layer of ["lc-help", "lc-responders", "lc-queues", "lc-dest"]) {
        map.on("click", layer, (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f || !map) return;
          popup.setLngLat(e.lngLat).setHTML(escapeHtml(String(f.properties.label ?? ""))).addTo(map);
        });
      }
      map.on("click", "lc-zones-fill", (e: MapLayerMouseEvent) => {
        const interactive = ["lc-points", "lc-help", "lc-responders", "lc-queues", "lc-dest"].filter((l) => map?.getLayer(l));
        if (!map || map.queryRenderedFeatures(e.point, { layers: interactive }).length) return;
        const id = e.features?.[0]?.properties.id;
        const d = dataRef.current;
        const zone = d?.zones.find((z) => z.id === id);
        if (!zone || !d) return;
        const g = d.guidance.find((x) => x.zone_id === zone.id);
        const c = d.checkins.by_zone.find((x) => x.zone_id === zone.id);
        const lines = [`<strong>${escapeHtml(shortZoneName(zone.name))}</strong>`, escapeHtml(VERDICT[g?.level ?? "none"])];
        if (g?.no_route) lines.push("No open route");
        if (g?.destination) {
          const via = g.route?.via.length ? ` via ${g.route.via.join(", ")}` : "";
          lines.push(escapeHtml(`${g.destination.name}${via}${g.route ? `, ${g.route.eta_min} min` : ""}`));
        }
        if (g) lines.push(`Version ${g.version}, ${g.approved_by === "auto_policy" ? "auto policy" : "controller"}`);
        lines.push(escapeHtml(`${zone.households.toLocaleString("en-US")} households, ${zone.vehicles.toLocaleString("en-US")} vehicles`));
        if (c) lines.push(escapeHtml(`${c.out} out, ${c.need_help} need help`));
        popup.setLngLat(e.lngLat).setHTML(lines.join("<br>")).addTo(map);
      });
      for (const layer of ["lc-points", "lc-help", "lc-responders", "lc-queues", "lc-dest", "lc-zones-fill"]) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    });
    return () => {
      controller.abort();
      labelRef.current?.remove();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    for (const [id, fc] of Object.entries(buildSources(data, items))) {
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
  }, [ready, data, items]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("lc-queues") as GeoJSONSource | undefined)?.setData(buildQueues(twin));
  }, [ready, twin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const key of LAYER_KEYS) {
      for (const id of LAYER_IDS[key]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", layers[key] ? "visible" : "none");
      }
    }
  }, [ready, layers]);

  // Selection: halo the item and fly to it once per selection.
  const selectedId = selected?.id ?? null;
  const selectedCoord = selected?.coord ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const target = selectedCoord ? { id: selectedId!, coord: selectedCoord } : focus;
    (map.getSource("lc-focus") as GeoJSONSource | undefined)?.setData(
      collection(target ? [point(target.coord, { id: target.id })] : []),
    );
    if (target) map.flyTo({ center: target.coord, zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fly on a new selection or focus, not on each poll
  }, [ready, selectedId, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    for (const [id, fc] of Object.entries(buildImpact(data, impact))) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
    }
    labelRef.current?.remove();
    labelRef.current = null;
    if (impact) {
      const el = document.createElement("div");
      el.className = "lc-imp-label";
      el.setAttribute("role", "status");
      el.textContent = impactLabel(impact);
      labelRef.current = new Marker({ element: el, anchor: "bottom", offset: [0, -16] })
        .setLngLat(impact.target.coord)
        .addTo(map);
      const bounds = new LngLatBounds();
      for (const z of impact.zones) {
        for (const opt of [z.blocked, z.unblocked]) for (const [lon, lat] of opt?.route.line ?? []) bounds.extend([lon, lat]);
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 96, maxZoom: 14 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on a new result only
  }, [ready, impact]);

  return <div ref={container} className="lc-map" role="region" aria-label="Incident map" />;
}
