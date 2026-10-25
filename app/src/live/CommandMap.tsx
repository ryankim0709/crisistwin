import { attachStations } from "../maps/stations";
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
  type MapMouseEvent,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { SATELLITE_STYLE, fireHatch } from "./mapStyle";
import { VERDICT, labelPoint, nf, plural, responderName, shortZoneName, wallClock } from "./format";
import { installInjectLayers } from "./injectMap";
import { buildInjectSources } from "./injects";
import { attachPeopleLayer, PEOPLE_INTERACTIVE_LAYERS, type PeopleLayer, type PeopleSnapshot } from "./people";
import { PERSONS_PER_VEHICLE } from "../population/peopleSnapshot";
import type { QueueItem } from "./queue";
import type { CommandResponse, GuidanceLevel, ImpactResponse, LonLat, TwinMonitor } from "./types";

setWorkerUrl(workerUrl);

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
  fireEdge: "#B33A00",
  /** Dark so routes never read as rivers or the basemap's roads; white dashes show the flow. */
  route: "#1F2A44",
  routeFlow: "#FFFFFF",
  trafficSlow: "#A15C00",
  selection: "#3D9BFF",
  casing: "#FFFFFF",
  hazard: "#FF5147",
  report: "#1B2430",
  responder: "#6B5BD2",
  help: "#F5A623",
  /** 2018 911 / radio / rescue activity per zone (historical record). */
  ground: "#BE185D",
  /** Responder route to a task: teal, unused by fire, zones, routes or traffic. */
  responderRoute: "#0A8EA6",
  queue: "#8A6D00",
  shelter: "#2E7D5B",
  ink: "#0F1720",
};

export type LayerKey = "zones" | "fire" | "reports" | "roads" | "shelters" | "people" | "noTruck" | "stations";
export const LAYER_KEYS: LayerKey[] = ["zones", "fire", "reports", "roads", "shelters", "people", "noTruck", "stations"];
const LAYER_IDS: Record<LayerKey, string[]> = {
  stations: [],
  zones: ["lc-zones-fill", "lc-zones-line", "lc-zone-labels"],
  fire: ["lc-fire-fill", "lc-fire-hatch", "lc-fire-casing", "lc-fire-line", "lc-fire-obs", "lc-fire-label"],
  reports: ["lc-ground", "lc-ground-count", "lc-points", "lc-help-casing", "lc-help", "lc-responders"],
  roads: [
    "lc-routes-casing", "lc-routes", "lc-traffic-casing", "lc-traffic", "lc-traffic-flow", "lc-hazard-casing", "lc-hazard-lines", "lc-queues-casing", "lc-queues",
  ],
  shelters: ["lc-dest", "lc-dest-labels"],
  /** Drawn and toggled by the people layer itself (./people). */
  people: [],
  /** Roads closed to the board's trucks: drawn by demo/boardMapLayers.ts (also shown for a selected unit). */
  noTruck: [],
};

export interface MapFocus {
  id: string;
  coord: LonLat;
  /** A segment's line: the map fits it instead of flying to the coord. */
  line?: LonLat[] | null;
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

/** On-map zone tags, so a red zone never reads as fire. */
const ZONE_TAG: Record<Exclude<GuidanceLevel, "none">, string> = { evacuate_now: "LEAVE NOW", be_ready: "BE READY" };

function buildSources(data: CommandResponse, items: QueueItem[], twin: TwinMonitor | null): Record<string, GeoJSON.FeatureCollection> {
  const guidance = new Map(data.guidance.map((g) => [g.zone_id, g]));
  const counts = new Map(data.checkins.by_zone.map((c) => [c.zone_id, c]));

  const zones: Feature[] = [];
  const zoneLabels: Feature[] = [];
  for (const zone of data.zones) {
    const level: GuidanceLevel = guidance.get(zone.id)?.level ?? "none";
    zones.push({ type: "Feature", geometry: zone.geometry, properties: { id: zone.id, level } });
    const c = counts.get(zone.id);
    const anchor = labelPoint(zone.geometry);
    const parts = level === "none" ? [] : [ZONE_TAG[level]];
    if (c && c.out + c.need_help > 0) parts.push(c.need_help ? `${c.out} out, ${c.need_help} help` : `${c.out} out`);
    if (anchor && parts.length) zoneLabels.push(point(anchor, { text: parts.join(" · "), level }));
  }

  const routes = data.guidance
    .filter((g) => g.route && g.level !== "none" && g.route.line.length > 1)
    .map((g) => lineFeature(g.route!.line, { zone_id: g.zone_id, level: g.level }));

  const fire: Feature[] = data.fire.geometry
    ? [{ type: "Feature", geometry: data.fire.geometry, properties: { method: data.fire.method } }]
    : [];
  const fireAnchor = data.fire.geometry ? labelPoint(data.fire.geometry) : null;
  const fireLabel = fireAnchor ? [point(fireAnchor, { text: "FIRE" })] : [];
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
    point(r.coord, { label: `Responder ${responderName(r)}, ${wallClock(r.at)}` }),
  );
  const routedTo = new Set<string>();
  for (const g of data.guidance) if (g.level !== "none" && g.destination?.id) routedTo.add(g.destination.id);
  const arrivedVeh = new Map((twin?.destinations ?? []).map((t) => [t.id, t.arrived_veh]));
  const dests = data.destinations
    .filter((d) => d.kind !== "exit")
    .map((d) => {
      const arrived = arrivedVeh.get(d.id) ?? 0;
      const active = routedTo.has(d.id) || arrived > 0;
      const people = Math.round(arrived * PERSONS_PER_VEHICLE);
      const parts = [`Shelter: ${d.name}`];
      if (arrived > 0) parts.push(`${nf(people)} arrived`);
      if (d.capacity_veh !== null && arrivedVeh.has(d.id)) {
        const room = Math.max(0, Math.round((d.capacity_veh - arrived) * PERSONS_PER_VEHICLE));
        parts.push(`room for ${nf(room)} more`);
      } else if (active && arrived === 0) parts.push("people routed here");
      return point(d.coord, {
        kind: d.kind,
        name: d.name,
        active,
        text: active ? parts.join(" · ") : d.name,
        label: `${d.name}${d.capacity_veh !== null ? `, ${nf(d.capacity_veh)} vehicles` : ", capacity unknown"}`,
      });
    });

  const zoneById = new Map(data.zones.map((z) => [z.id, z]));
  const ground: Feature[] = [];
  for (const z of data.ground_record?.zones ?? []) {
    const zone = zoneById.get(z.zone_id);
    const anchor = zone ? labelPoint(zone.geometry) : null;
    if (!zone || !anchor) continue;
    const parts = [`${z.items} in ${data.ground_record!.window_min} min`];
    if (z.help) parts.push(`${z.help} help or trapped`);
    if (z.fire) parts.push(`${z.fire} fire seen`);
    ground.push(point(anchor, { items: z.items, label: `2018 calls and radio, ${shortZoneName(zone.name)}: ${parts.join(", ")}` }));
  }

  return {
    "lc-ground": collection(ground),
    "lc-zones": collection(zones),
    "lc-zone-labels": collection(zoneLabels),
    "lc-fire": collection(fire),
    "lc-fire-label": collection(fireLabel),
    "lc-fire-obs": collection(fireObs),
    "lc-routes": collection(routes),
    "lc-hazard-lines": collection(hazardLines),
    "lc-points": collection(points),
    "lc-help": collection(help),
    "lc-responders": collection(responders),
    "lc-dest": collection(dests),
  };
}

/** Twin traffic: each occupied directed edge in travel order, so the flow dashes move the right way. */
function buildTraffic(twin: TwinMonitor | null): GeoJSON.FeatureCollection {
  if (!twin?.traffic) return collection([]);
  return collection(
    twin.traffic
      .filter((e) => e.line.length > 1)
      .map((e) => lineFeature(e.line, { veh: e.veh, ratio: e.free_flow_kph > 0 ? e.speed_kph / e.free_flow_kph : 1 })),
  );
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

/** Steps of the routes' moving dashes (white dash marching along the line, start to end). */
const FLOW_DASHES: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
const FLOW_STEP_MS = 70;

const SOURCES = [
  "lc-zones", "lc-zone-labels", "lc-fire", "lc-fire-label", "lc-fire-obs", "lc-routes", "lc-hazard-lines", "lc-points", "lc-help",
  "lc-responders", "lc-dest", "lc-queues", "lc-traffic", "lc-ground", "lc-focus", "lc-imp-zones", "lc-imp-now", "lc-imp-alt", "lc-imp-road", "lc-resp-route",
];

function installLayers(map: MapLibreMap): void {
  const empty = collection([]);
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({
    // Zones with no guidance ("none") draw nothing, so a Studio package's grid of synthetic
    // squares is not a mesh on the imagery; the opacity-0 fill is still clickable.
    id: "lc-zones-fill",
    type: "fill",
    source: "lc-zones",
    paint: {
      "fill-color": LEVEL_MATCH("level", LEVEL_COLOR) as never,
      "fill-opacity": LEVEL_MATCH("level", { evacuate_now: 0.1, be_ready: 0.08, none: 0 }) as never,
    },
  });
  map.addLayer({
    id: "lc-zones-line",
    type: "line",
    source: "lc-zones",
    paint: {
      "line-color": LEVEL_MATCH("level", LEVEL_COLOR) as never,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 2.5, be_ready: 2, none: 0 }) as never,
      "line-opacity": LEVEL_MATCH("level", { evacuate_now: 0.9, be_ready: 0.9, none: 0 }) as never,
    },
  });
  map.addLayer({ id: "lc-imp-zones", type: "fill", source: "lc-imp-zones", paint: { "fill-color": MAP_COLOR.selection, "fill-opacity": 0.15 } });
  map.addImage("lc-fire-hatch", fireHatch(MAP_COLOR.fireEdge));
  map.addLayer({ id: "lc-fire-fill", type: "fill", source: "lc-fire", paint: { "fill-color": MAP_COLOR.fire, "fill-opacity": 0.35 } });
  map.addLayer({ id: "lc-fire-hatch", type: "fill", source: "lc-fire", paint: { "fill-pattern": "lc-fire-hatch", "fill-opacity": 0.6 } });
  map.addLayer({
    id: "lc-fire-casing",
    type: "line",
    source: "lc-fire",
    layout: { "line-join": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": 5, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "lc-fire-line",
    type: "line",
    source: "lc-fire",
    paint: {
      "line-color": MAP_COLOR.fireEdge,
      "line-width": 2.5,
      "line-dasharray": ["case", ["==", ["get", "method"], "model_nowcast"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
    },
  });
  // The approved route: a thin dashed plan line. The cars on it are the traffic layers below.
  map.addLayer({
    id: "lc-routes-casing",
    type: "line",
    source: "lc-routes",
    layout: { "line-join": "round" },
    paint: {
      "line-color": MAP_COLOR.casing,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 4.5, be_ready: 4, none: 0 }) as never,
      "line-opacity": LEVEL_MATCH("level", { evacuate_now: 0.8, be_ready: 0.6, none: 0 }) as never,
    },
  });
  map.addLayer({
    id: "lc-routes",
    type: "line",
    source: "lc-routes",
    layout: { "line-join": "round" },
    paint: {
      "line-color": MAP_COLOR.route,
      "line-width": LEVEL_MATCH("level", { evacuate_now: 2, be_ready: 1.5, none: 0 }) as never,
      "line-opacity": LEVEL_MATCH("level", { evacuate_now: 0.9, be_ready: 0.75, none: 0 }) as never,
      "line-dasharray": [2, 1.5],
    },
  });
  // Simulated traffic: where the twin's vehicles are now, width by count, amber when slow.
  // It grows as zones leave and drains as vehicles arrive; the white dashes march with travel.
  map.addLayer({
    id: "lc-traffic-casing",
    type: "line",
    source: "lc-traffic",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": MAP_COLOR.casing,
      "line-width": ["interpolate", ["linear"], ["get", "veh"], 1, 5, 20, 8, 150, 12] as never,
    },
  });
  map.addLayer({
    id: "lc-traffic",
    type: "line",
    source: "lc-traffic",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["<", ["get", "ratio"], 0.5], MAP_COLOR.trafficSlow, MAP_COLOR.route] as never,
      "line-width": ["interpolate", ["linear"], ["get", "veh"], 1, 3, 20, 5.5, 150, 9] as never,
    },
  });
  map.addLayer({
    id: "lc-traffic-flow",
    type: "line",
    source: "lc-traffic",
    layout: { "line-join": "round" },
    paint: {
      "line-color": MAP_COLOR.routeFlow,
      "line-width": ["interpolate", ["linear"], ["get", "veh"], 1, 1, 20, 1.6, 150, 2.4] as never,
      "line-dasharray": FLOW_DASHES[0],
    },
  });
  map.addLayer({
    id: "lc-imp-alt-casing",
    type: "line",
    source: "lc-imp-alt",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": 5, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "lc-imp-alt",
    type: "line",
    source: "lc-imp-alt",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.ink, "line-width": 2.5, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "lc-imp-now-casing",
    type: "line",
    source: "lc-imp-now",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": 7 },
  });
  map.addLayer({
    id: "lc-imp-now",
    type: "line",
    source: "lc-imp-now",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP_COLOR.selection, "line-width": 4 },
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
    id: "lc-resp-route-casing",
    type: "line",
    source: "lc-resp-route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": 7, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "lc-resp-route",
    type: "line",
    source: "lc-resp-route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": MAP_COLOR.responderRoute, "line-width": 3.5, "line-dasharray": [0.1, 1.6] },
  });
  map.addLayer({
    id: "lc-imp-road",
    type: "line",
    source: "lc-imp-road",
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP_COLOR.casing, "line-width": 2.5, "line-gap-width": 6 },
  });
  map.addLayer({
    id: "lc-fire-obs",
    type: "circle",
    source: "lc-fire-obs",
    paint: { "circle-radius": 2.5, "circle-color": MAP_COLOR.fire, "circle-stroke-color": MAP_COLOR.casing, "circle-stroke-width": 0.8 },
  });
  map.addLayer({
    id: "lc-queues-casing",
    type: "circle",
    source: "lc-queues",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "queued"]], 0, 4, 3, 7, 8, 13] as never,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": MAP_COLOR.casing,
      "circle-stroke-width": 4,
    },
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
      "circle-radius": ["case", ["==", ["get", "active"], true], 10, 4.5] as never,
      "circle-color": ["case", ["==", ["get", "active"], true], MAP_COLOR.shelter, "#FFFFFF"] as never,
      "circle-stroke-color": ["case", ["==", ["get", "active"], true], "#FFFFFF", MAP_COLOR.shelter] as never,
      "circle-stroke-width": ["case", ["==", ["get", "active"], true], 3, 2] as never,
    },
  });
  map.addLayer({
    id: "lc-dest-labels",
    type: "symbol",
    source: "lc-dest",
    layout: {
      "text-field": ["get", "text"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["case", ["==", ["get", "active"], true], 13, 11] as never,
      "text-max-width": 16,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-optional": true,
      "symbol-sort-key": ["case", ["==", ["get", "active"], true], 0, 1] as never,
    },
    filter: ["any", ["==", ["get", "active"], true], [">=", ["zoom"], 12.5]] as never,
    paint: { "text-color": MAP_COLOR.shelter, "text-halo-color": "#FFFFFF", "text-halo-width": 1.4 },
  });
  map.addLayer({
    id: "lc-focus",
    type: "circle",
    source: "lc-focus",
    paint: {
      "circle-radius": 17,
      "circle-color": "rgba(61,155,255,0.18)",
      "circle-stroke-color": MAP_COLOR.selection,
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "lc-ground",
    type: "circle",
    source: "lc-ground",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "items"]], 1, 9, 3, 13, 6, 19] as never,
      "circle-color": MAP_COLOR.ground,
      "circle-opacity": 0.85,
      "circle-stroke-color": "#FFFFFF",
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "lc-ground-count",
    type: "symbol",
    source: "lc-ground",
    layout: { "text-field": ["to-string", ["get", "items"]], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": "#FFFFFF" },
  });
  map.addLayer({
    id: "lc-help-casing",
    type: "circle",
    source: "lc-help",
    paint: { "circle-radius": 7, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": MAP_COLOR.casing, "circle-stroke-width": 6 },
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
    layout: {
      "text-field": ["get", "text"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["match", ["get", "level"], "evacuate_now", 12, 11] as never,
      "text-letter-spacing": 0.04,
    },
    paint: {
      "text-color": ["match", ["get", "level"], "evacuate_now", "#B3140C", "be_ready", "#7A4B00", MAP_COLOR.ink] as never,
      "text-halo-color": "#FFFFFF",
      "text-halo-width": 2,
    },
  });
  map.addLayer({
    id: "lc-fire-label",
    type: "symbol",
    source: "lc-fire-label",
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-letter-spacing": 0.04 },
    paint: { "text-color": MAP_COLOR.fireEdge, "text-halo-color": "#FFFFFF", "text-halo-width": 1.8 },
  });
  installInjectLayers(map);
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
  /** Simulated people picture (./people); drawn when `layers.people` is on. */
  people?: PeopleSnapshot | null;
  items: QueueItem[];
  selected: QueueItem | null;
  focus: MapFocus | null;
  layers: Record<LayerKey, boolean>;
  impact: ImpactResponse | null;
  taskRoute: LonLat[] | null;
  onSelect: (itemId: string | null) => void;
  /**
   * Extension point for extra layers (the simulated board). Called once, after the satellite
   * style and every live layer and source are installed. Add layers with
   * `map.addLayer(layer, EXTRA_LAYERS_BEFORE_ID)` so they sit under the live labels, markers,
   * routes and selection. May return a cleanup, run before the map is removed on unmount.
   * Held in a ref: pass any function, it is read once at load time.
   */
  onMapReady?: (map: MapLibreMap) => void | (() => void);
  /**
   * Checked first by the live click handlers (select, popups); return true when the click
   * belongs to something else (the simulated board), so the live handlers skip it.
   */
  interceptClick?: (e: MapMouseEvent) => boolean;
}

/**
 * Insert extra layers with this `beforeId`: above the zone fills/lines, fire and impact
 * overlays, routes and traffic, but under the report/inject/zone-label marks and text
 * (`lc-ground` is the first of those; `lc-focus` and `lc-dest` sit just below it).
 */
export const EXTRA_LAYERS_BEFORE_ID = "lc-dest";

export default function CommandMap({ data, twin, people = null, items, selected, focus, layers, impact, taskRoute, onSelect, onMapReady, interceptClick }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const stationsRef = useRef<ReturnType<typeof attachStations> | null>(null);
  const dataRef = useRef<CommandResponse | null>(data);
  const onSelectRef = useRef(onSelect);
  const onMapReadyRef = useRef(onMapReady);
  const interceptRef = useRef(interceptClick);
  const readyCleanup = useRef<(() => void) | null>(null);
  const peopleLayer = useRef<PeopleLayer | null>(null);
  const labelRef = useRef<Marker | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dataRef.current = data;
    onSelectRef.current = onSelect;
    onMapReadyRef.current = onMapReady;
    interceptRef.current = interceptClick;
  }, [data, onSelect, onMapReady, interceptClick]);

  useEffect(() => {
    const controller = new AbortController();
    let map: MapLibreMap | null = null;
    // Satellite imagery, as Studio and /demo; the style is local, so this resolves at once.
    Promise.resolve(SATELLITE_STYLE).then((style) => {
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
        stationsRef.current = attachStations(map);
        // People sit above roads and traffic but under extra (board) layers, labels and markers.
        peopleLayer.current = attachPeopleLayer(map, EXTRA_LAYERS_BEFORE_ID);
        const cleanup = onMapReadyRef.current?.(map);
        if (typeof cleanup === "function") readyCleanup.current = cleanup;
        setReady(true);
      });
      const popup = new Popup({ closeButton: false, maxWidth: "260px", className: "lc-popup" });
      map.on("click", "lc-points", (e: MapLayerMouseEvent) => {
        if (interceptRef.current?.(e)) return;
        const id = e.features?.[0]?.properties.item;
        if (typeof id === "string") onSelectRef.current(id);
      });
      for (const layer of ["lc-ground", "lc-help", "lc-responders", "lc-queues", "lc-dest", "lc-inject-marks"]) {
        map.on("click", layer, (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f || !map || interceptRef.current?.(e)) return;
          popup.setLngLat(e.lngLat).setHTML(escapeHtml(String(f.properties.label ?? ""))).addTo(map);
        });
      }
      map.on("click", "lc-zones-fill", (e: MapLayerMouseEvent) => {
        const interactive = ["lc-ground", "lc-points", "lc-help", "lc-responders", "lc-queues", "lc-dest", ...PEOPLE_INTERACTIVE_LAYERS].filter(
          (l) => map?.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none",
        );
        if (!map || interceptRef.current?.(e) || map.queryRenderedFeatures(e.point, { layers: interactive }).length) return;
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
      for (const layer of ["lc-ground", "lc-points", "lc-help", "lc-responders", "lc-queues", "lc-dest", "lc-zones-fill"]) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    });
    return () => {
      controller.abort();
      readyCleanup.current?.();
      readyCleanup.current = null;
      peopleLayer.current?.dispose();
      peopleLayer.current = null;
      stationsRef.current?.dispose();
      stationsRef.current = null;
      labelRef.current?.remove();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    for (const [id, fc] of Object.entries({ ...buildSources(data, items, twin), ...buildInjectSources(data) })) {
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
  }, [ready, data, items, twin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("lc-queues") as GeoJSONSource | undefined)?.setData(buildQueues(twin));
    (map.getSource("lc-traffic") as GeoJSONSource | undefined)?.setData(buildTraffic(twin));
  }, [ready, twin]);

  // Traffic: march the white dashes in the travel direction, so the stream reads as moving.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let step = -1;
    const tick = (t: number) => {
      const next = Math.floor(t / FLOW_STEP_MS) % FLOW_DASHES.length;
      if (next !== step && map.getLayer("lc-traffic-flow")) {
        step = next;
        map.setPaintProperty("lc-traffic-flow", "line-dasharray", FLOW_DASHES[step]);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    peopleLayer.current?.update(layers.people ? people : null);
  }, [ready, people, layers.people]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    peopleLayer.current?.setVisible(layers.people);
    stationsRef.current?.setVisible(layers.stations);
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
    const line = !selectedCoord && focus?.line && focus.line.length > 1 ? focus.line : null;
    if (line) {
      const lons = line.map((c) => c[0]);
      const lats = line.map((c) => c[1]);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 80, maxZoom: 15 },
      );
    } else if (target) map.flyTo({ center: target.coord, zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fly on a new selection or focus, not on each poll
  }, [ready, selectedId, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("lc-resp-route") as GeoJSONSource | undefined)?.setData(
      collection(taskRoute && taskRoute.length > 1 ? [lineFeature(taskRoute)] : []),
    );
  }, [ready, taskRoute]);

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
