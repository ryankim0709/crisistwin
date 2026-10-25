// Map of the App integration tab: zones with their guidance, the drill fire estimate, closed roads,
// the simulated people layer ("everyone else", ../live/people) and our app users as dots on top.
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
import { labelPoint, shortZoneName } from "../live/format";
import { SATELLITE_STYLE, fireHatch } from "../live/mapStyle";
import { attachPeopleLayer, type PeopleLayer, type PeopleSnapshot } from "../live/people";
import type { CommandResponse, GuidanceLevel, LonLat } from "../live/types";
import { APP_COLOR as C } from "./palette";
import type { Participant } from "./types";

setWorkerUrl(workerUrl);

export type MapLayerKey = "app" | "people" | "zones" | "fire" | "closures";

const LAYERS: Record<Exclude<MapLayerKey, "people">, string[]> = {
  app: ["aix-app", "aix-app-label"],
  zones: ["aix-zones-fill", "aix-zones-line", "aix-zone-labels", "aix-route-casing", "aix-route"],
  fire: ["aix-fire-fill", "aix-fire-hatch", "aix-fire-line", "aix-fire-label"],
  closures: ["aix-closures-casing", "aix-closures"],
};
const SOURCES = ["aix-zones", "aix-zone-labels", "aix-fire", "aix-fire-label", "aix-route", "aix-closures", "aix-app"];

type Props = Record<string, string | number | boolean | null>;
type Feature = GeoJSON.Feature<GeoJSON.Geometry, Props>;
const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const point = (coord: LonLat, properties: Props): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties });
const line = (coords: LonLat[], properties: Props = {}): Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties });

const ZONE_TAG: Record<GuidanceLevel, string> = { evacuate_now: "LEAVE NOW", be_ready: "GET READY", none: "" };
const LEVEL = (values: Record<GuidanceLevel, string | number>) =>
  ["match", ["get", "level"], "evacuate_now", values.evacuate_now, "be_ready", values.be_ready, values.none] as never;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function buildSources(data: CommandResponse, participants: Participant[], selectedId: string | null) {
  const guidance = new Map(data.guidance.map((g) => [g.zone_id, g]));
  const zones: Feature[] = [];
  const labels: Feature[] = [];
  for (const zone of data.zones) {
    const level = guidance.get(zone.id)?.level ?? "none";
    zones.push({ type: "Feature", geometry: zone.geometry, properties: { id: zone.id, level } });
    const anchor = labelPoint(zone.geometry);
    if (anchor && level !== "none") labels.push(point(anchor, { text: `${ZONE_TAG[level]}\n${shortZoneName(zone.name)}`, level }));
  }
  const fire: Feature[] = data.fire.geometry ? [{ type: "Feature", geometry: data.fire.geometry, properties: { method: data.fire.method } }] : [];
  const fireAnchor = data.fire.geometry ? labelPoint(data.fire.geometry) : null;
  const closures = data.public_items
    .filter((i) => i.kind === "road_blocked" && i.line && i.line.length > 1)
    .map((i) => line(i.line!, {}));
  const selected = participants.find((p) => p.id === selectedId) ?? null;
  const selGuidance = selected?.zone_id ? guidance.get(selected.zone_id) : undefined;
  const route = selGuidance?.route && selGuidance.level !== "none" && selGuidance.route.line.length > 1 ? [line(selGuidance.route.line)] : [];
  const app = participants
    .filter((p) => p.position)
    .map((p) =>
      point(p.position!, {
        id: p.id,
        real: p.kind === "real",
        responder: p.role === "responder",
        selected: p.id === selectedId,
        // Names on the map for real phones and the selected person; simulated ones stay unlabelled.
        label: p.kind === "real" || p.id === selectedId ? p.name : "",
        flagged: p.flags.length > 0,
      }),
    );
  return {
    "aix-zones": fc(zones),
    "aix-zone-labels": fc(labels),
    "aix-fire": fc(fire),
    "aix-fire-label": fc(fireAnchor ? [point(fireAnchor, { text: "FIRE" })] : []),
    "aix-route": fc(route),
    "aix-closures": fc(closures),
    "aix-app": fc(app),
  };
}

function installLayers(map: MapLibreMap): void {
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: fc([]) });
  map.addLayer({
    id: "aix-zones-fill",
    type: "fill",
    source: "aix-zones",
    paint: { "fill-color": LEVEL({ evacuate_now: C.evacuateNow, be_ready: C.beReady, none: "#000" }), "fill-opacity": LEVEL({ evacuate_now: 0.12, be_ready: 0.1, none: 0 }) },
  });
  map.addLayer({
    id: "aix-zones-line",
    type: "line",
    source: "aix-zones",
    paint: {
      "line-color": LEVEL({ evacuate_now: C.evacuateNow, be_ready: C.beReady, none: "#000" }),
      "line-width": LEVEL({ evacuate_now: 2.5, be_ready: 2, none: 0 }),
      "line-dasharray": ["case", ["==", ["get", "level"], "be_ready"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
    },
  });
  map.addImage("aix-fire-hatch", fireHatch(C.fireEdge));
  map.addLayer({ id: "aix-fire-fill", type: "fill", source: "aix-fire", paint: { "fill-color": C.fire, "fill-opacity": 0.35 } });
  map.addLayer({ id: "aix-fire-hatch", type: "fill", source: "aix-fire", paint: { "fill-pattern": "aix-fire-hatch", "fill-opacity": 0.6 } });
  map.addLayer({ id: "aix-fire-line", type: "line", source: "aix-fire", paint: { "line-color": C.fireEdge, "line-width": 2.5 } });
  map.addLayer({
    id: "aix-route-casing",
    type: "line",
    source: "aix-route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": C.halo, "line-width": 6, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "aix-route",
    type: "line",
    source: "aix-route",
    layout: { "line-join": "round" },
    paint: { "line-color": C.appUser, "line-width": 3, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "aix-closures-casing",
    type: "line",
    source: "aix-closures",
    layout: { "line-cap": "round" },
    paint: { "line-color": C.halo, "line-width": 7 },
  });
  map.addLayer({
    id: "aix-closures",
    type: "line",
    source: "aix-closures",
    paint: { "line-color": C.closure, "line-width": 4, "line-dasharray": [1.5, 1] },
  });
  map.addLayer({
    id: "aix-zone-labels",
    type: "symbol",
    source: "aix-zone-labels",
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-max-width": 12 },
    paint: { "text-color": "#1F2A44", "text-halo-color": C.halo, "text-halo-width": 1.6 },
  });
  map.addLayer({
    id: "aix-fire-label",
    type: "symbol",
    source: "aix-fire-label",
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 13, "text-letter-spacing": 0.1 },
    paint: { "text-color": C.fireEdge, "text-halo-color": C.halo, "text-halo-width": 2 },
  });
  // App users: solid = real phone, hollow = simulated; the selected one is larger with an amber ring.
  map.addLayer({
    id: "aix-app",
    type: "circle",
    source: "aix-app",
    paint: {
      "circle-radius": ["case", ["get", "selected"], 9, 6.5] as never,
      "circle-color": ["case", ["get", "real"], C.appUser, C.hollow] as never,
      "circle-stroke-color": ["case", ["get", "selected"], C.selected, C.appUser] as never,
      "circle-stroke-width": ["case", ["get", "selected"], 3.5, 2.5] as never,
    },
  });
  map.addLayer({
    id: "aix-app-label",
    type: "symbol",
    source: "aix-app",
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, -1.3],
      "text-anchor": "bottom",
      "text-allow-overlap": false,
    },
    paint: { "text-color": C.appUserInk, "text-halo-color": C.halo, "text-halo-width": 2 },
  });
}

interface MapProps {
  data: CommandResponse | null;
  people: PeopleSnapshot | null;
  participants: Participant[];
  selectedId: string | null;
  layers: Record<MapLayerKey, boolean>;
  onSelect: (id: string) => void;
}

export default function AppMap({ data, people, participants, selectedId, layers, onSelect }: MapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const peopleLayer = useRef<PeopleLayer | null>(null);
  const onSelectRef = useRef(onSelect);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: SATELLITE_STYLE,
      center: [-121.6, 39.76],
      zoom: 10,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
    map.on("load", () => {
      installLayers(map);
      // Everyone else sits under the closures, labels and our dots.
      peopleLayer.current = attachPeopleLayer(map, "aix-closures-casing");
      setReady(true);
    });
    map.on("click", "aix-app", (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties.id;
      if (typeof id === "string") onSelectRef.current(id);
    });
    map.on("mouseenter", "aix-app", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "aix-app", () => (map.getCanvas().style.cursor = ""));
    const popup = new Popup({ closeButton: false, maxWidth: "240px" });
    map.on("click", "aix-closures", (e: MapLayerMouseEvent) => {
      popup.setLngLat(e.lngLat).setHTML(escapeHtml("Road closed")).addTo(map);
    });
    return () => {
      peopleLayer.current?.dispose();
      peopleLayer.current = null;
      popup.remove();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    for (const [id, data_] of Object.entries(buildSources(data, participants, selectedId))) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(data_);
    }
    if (!fitted.current && data.zones.length) {
      const bounds = new LngLatBounds();
      for (const zone of data.zones) {
        const polys = zone.geometry.type === "Polygon" ? [zone.geometry.coordinates] : zone.geometry.coordinates;
        for (const poly of polys) for (const [lon, lat] of poly[0] ?? []) bounds.extend([lon, lat]);
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, duration: 0 });
      fitted.current = true;
    }
  }, [ready, data, participants, selectedId]);

  useEffect(() => {
    if (ready) peopleLayer.current?.update(people);
  }, [ready, people]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const [key, ids] of Object.entries(LAYERS) as [Exclude<MapLayerKey, "people">, string[]][]) {
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", layers[key] ? "visible" : "none");
    }
    peopleLayer.current?.setVisible(layers.people);
  }, [ready, layers]);

  // Pan to a selected person who is off screen.
  useEffect(() => {
    const map = mapRef.current;
    const p = participants.find((x) => x.id === selectedId);
    if (!ready || !map || !p?.position) return;
    if (!map.getBounds().contains(p.position)) map.easeTo({ center: p.position, duration: 400 });
    // Only on a new selection, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedId]);

  return <div ref={container} className="aix-map" role="region" aria-label="Map of the drill: zones, fire, everyone else and our app users" />;
}
