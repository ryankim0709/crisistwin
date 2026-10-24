// MapLibre glue: sources, layers and GeoJSON builders for the replay overlays. Sources are
// added once on load; per-tick changes go through setData on small sources or feature-state
// on the (large, static) road network. Layers are never re-created per tick.
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapOptions } from "maplibre-gl";
import { SATELLITE_STYLE } from "../maps/basemap";
import type {
  LngLat,
  Perimeter,
  ReplayModel,
  SimulatedFront,
  TrafficFrame,
  Zone,
} from "./types";

/** Free OpenFreeMap dark basemap; no API key. */
export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const FALLBACK_GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const LABEL_FONT = ["Noto Sans Regular"];
const LABEL_FONT_BOLD = ["Noto Sans Bold"];

/** A style JSON document (maplibre-gl does not re-export the style-spec type). */
export type BasemapStyle = Exclude<MapOptions["style"], string | undefined>;

/** Used when the basemap style cannot be fetched, so the replay overlays still render. */
export const FALLBACK_STYLE: BasemapStyle = {
  version: 8,
  glyphs: FALLBACK_GLYPHS_URL,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0a0e13" } }],
};

export type Basemap = "dark" | "satellite";
export const IMAGERY_LAYER = "rp-imagery";
export const IMAGERY_DATE_NOTE =
  "Imagery: USGS NAIP/National Map, acquisition dates vary — not imagery from Nov 2018";

/** The teammate's USGS imagery raster source (maps/basemap.ts), without the SF previews. */
function imagerySource() {
  const style = SATELLITE_STYLE;
  if (typeof style !== "object" || style === null) return null;
  const source = style.sources.imagery;
  return source && source.type === "raster" ? source : null;
}

export function setBasemap(map: MapLibreMap, basemap: Basemap): void {
  if (map.getLayer(IMAGERY_LAYER)) {
    map.setLayoutProperty(IMAGERY_LAYER, "visibility", basemap === "satellite" ? "visible" : "none");
  }
}

// Congestion bands: mean speed as a fraction of the edge's free-flow speed_kph.
export const CONGESTION_FREE_RATIO = 0.7;
export const CONGESTION_SLOW_RATIO = 0.35;

const MAJOR_HIGHWAYS = ["motorway", "trunk", "primary", "secondary", "tertiary"];
const SIM_HATCH_IMAGE = "rp-sim-hatch";
const ZONE_HATCH_IMAGE = "rp-zone-hatch";

export const COLORS = {
  ember: "#ff6a1a",
  emberCore: "#ffd29a",
  emberDeep: "#ff3d00",
  history: "#ff9a5c",
  simFront: "#ff7ad9",
  free: "#3ddbb4",
  slow: "#f5c04a",
  jam: "#ff4d6d",
  closed: "#ff2e4d",
  network: "#26394a",
  networkMajor: "#3d566c",
  bridge: "#d8e3ee",
  particle: "#e9fbff",
  particleStopped: "#ff8fa3",
  zone: "#8fb3ff",
  zoneOrdered: "#ffb547",
  destination: "#7cf2c9",
  damage: "#c7a6ff",
} as const;

export type LayerGroup =
  | "fire"
  | "history"
  | "simFire"
  | "roads"
  | "particles"
  | "zones"
  | "destinations"
  | "damage";

export const LAYER_GROUPS: Record<LayerGroup, string[]> = {
  history: ["fire-history"],
  simFire: ["sim-front-fill", "sim-front-line", "sim-ignition", "sim-ignition-label"],
  fire: ["fire-glow-outer", "fire-fill", "fire-glow", "fire-line"],
  zones: ["zones-fill", "zones-hatch", "zones-line", "zones-line-ordered", "zones-label"],
  roads: [
    "roads-base",
    "roads-bridge",
    "roads-flow",
    "roads-closed",
    "roads-threat",
    "roads-closed-label",
    "roads-bridge-label",
  ],
  particles: ["particles-halo", "particles"],
  destinations: ["destinations-halo", "destinations", "destinations-label"],
  damage: ["damage"],
};

/** Layers that show a tooltip on hover, topmost first. */
export const INTERACTIVE_LAYERS = [
  "particles",
  "destinations",
  "damage",
  "roads-closed",
  "roads-threat",
  "roads-flow",
  "sim-ignition",
  "zones-fill",
  "fire-fill",
  "sim-front-fill",
];

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function perimeterCollection(perimeter: Perimeter | null): FeatureCollection {
  if (!perimeter) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: perimeter.geometry,
        properties: {
          area_km2: perimeter.areaKm2,
          evidence_class: perimeter.evidenceClass,
          at_ms: perimeter.atMs,
        },
      },
    ],
  };
}

/** Earlier perimeters, newest first; `rank` 1 is the snapshot just before the one in effect. */
export function perimeterHistoryCollection(
  perimeters: readonly Perimeter[],
  currentIndex: number,
): FeatureCollection {
  const features: FeatureCollection["features"] = [];
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    features.push({
      type: "Feature",
      geometry: perimeters[i].geometry,
      properties: { rank: currentIndex - i },
    });
  }
  return { type: "FeatureCollection", features };
}

export function simulatedFrontCollection(front: SimulatedFront | null): FeatureCollection {
  if (!front) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: front.geometry,
        properties: { area_km2: front.areaKm2, at_ms: front.atMs },
      },
    ],
  };
}

export type RoadClass = "free" | "slow" | "jam" | "closed" | "idle";

/** Numeric codes stored in feature-state (paint expressions match on them). */
const ROAD_CLASS_CODE: Record<RoadClass, number> = { idle: 0, free: 1, slow: 2, jam: 3, closed: 4 };
export const ROAD_CLASS_BY_CODE: RoadClass[] = ["idle", "free", "slow", "jam", "closed"];

export function roadClass(
  closed: boolean,
  vehicles: number,
  meanSpeedKph: number,
  freeSpeedKph: number,
): RoadClass {
  if (closed) return "closed";
  if (vehicles <= 0) return "idle";
  const ratio = freeSpeedKph > 0 ? meanSpeedKph / freeSpeedKph : 1;
  if (ratio >= CONGESTION_FREE_RATIO) return "free";
  if (ratio >= CONGESTION_SLOW_RATIO) return "slow";
  return "jam";
}

export const ROAD_CLASS_LABEL: Record<RoadClass, string> = {
  free: "Flowing",
  slow: "Slow",
  jam: "Congested",
  closed: "Closed",
  idle: "No modelled vehicles",
};

/** traffic edge index -> road index (or -1), computed once per bundle. */
export function trafficToRoadIndex(model: ReplayModel): number[] {
  if (!model.roads || !model.traffic) return [];
  const byId = new Map<string, number>();
  model.roads.items.forEach((edge, i) => byId.set(edge.id, i));
  return model.traffic.edgeIds.map((id) => byId.get(id) ?? -1);
}

/** Static road network; feature ids are road indices so feature-state can address them. */
export function roadsCollection(model: ReplayModel): FeatureCollection {
  if (!model.roads) return EMPTY;
  return {
    type: "FeatureCollection",
    features: model.roads.items.map((edge, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "LineString", coordinates: edge.coords },
      properties: {
        id: edge.id,
        name: edge.name ?? edge.highway ?? edge.id,
        highway: edge.highway,
        major: edge.highway !== null && MAJOR_HIGHWAYS.includes(edge.highway),
        bridge: edge.bridge,
        speed_kph: edge.speedKph,
      },
    })),
  };
}

/** Label anchors (one middle vertex per closed edge); lighter to update than full lines. */
export function closedLabelCollection(
  model: ReplayModel,
  trafficToRoad: readonly number[],
  closed: readonly number[],
): FeatureCollection {
  const roads = model.roads?.items ?? [];
  const features: FeatureCollection["features"] = [];
  for (const ti of closed) {
    const ri = trafficToRoad[ti];
    if (ri === undefined || ri < 0) continue;
    const coords = roads[ri].coords;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coords[Math.floor(coords.length / 2)] },
      properties: {},
    });
  }
  return { type: "FeatureCollection", features };
}

/** Mark closed edges in feature-state; only edges whose status changed are touched. */
export function applyClosedState(
  map: MapLibreMap,
  trafficToRoad: readonly number[],
  closed: readonly number[],
  previous: ReadonlySet<number>,
): Set<number> {
  const next = new Set<number>();
  for (const ti of closed) {
    const ri = trafficToRoad[ti];
    if (ri !== undefined && ri >= 0) next.add(ri);
  }
  for (const ri of next) if (!previous.has(ri)) map.setFeatureState({ source: "roads", id: ri }, { closed: true });
  for (const ri of previous) if (!next.has(ri)) map.setFeatureState({ source: "roads", id: ri }, { closed: false });
  return next;
}

/**
 * Push one traffic frame into road feature-state. Returns the road ids that now carry state so
 * the next call can clear edges that emptied.
 */
export function applyTrafficFrame(
  map: MapLibreMap,
  model: ReplayModel,
  trafficToRoad: readonly number[],
  frame: TrafficFrame | null,
  closed: ReadonlySet<number>,
  previous: ReadonlySet<number>,
): Set<number> {
  const roads = model.roads?.items ?? [];
  const next = new Set<number>();
  for (const [ti, veh, speed] of frame?.edges ?? []) {
    const ri = trafficToRoad[ti];
    if (ri === undefined || ri < 0) continue;
    const cls = roadClass(closed.has(ti), veh, speed, roads[ri].speedKph);
    map.setFeatureState({ source: "roads", id: ri }, { veh, speed, cls: ROAD_CLASS_CODE[cls] });
    next.add(ri);
  }
  for (const ri of previous) {
    if (!next.has(ri)) map.setFeatureState({ source: "roads", id: ri }, { veh: 0, speed: null, cls: 0 });
  }
  return next;
}

export function zonesCollection(
  zones: readonly Zone[],
  states: Map<string, "ordered" | "warned">,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: zones.map((zone) => {
      const state = states.get(zone.id) ?? "none";
      const suffix = state === "ordered" ? " · ORDERED" : state === "warned" ? " · WARNING" : "";
      return {
        type: "Feature",
        geometry: zone.geometry,
        properties: {
          id: zone.id,
          name: zone.name,
          state,
          label: `${zone.name}${suffix}`,
          households: zone.households,
          vehicles: zone.vehicles,
        },
      };
    }),
  };
}

function destinationsCollection(model: ReplayModel): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (model.destinations?.items ?? []).map((d) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: d.coord },
      properties: {
        name: d.name,
        dest_kind: d.kind,
        label: `${d.name} (${d.kind.replace(/_/g, " ")})`,
        capacity_veh: d.capacityVeh,
      },
    })),
  };
}

function damageCollection(model: ReplayModel): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (model.damage?.items ?? []).map((d) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: d.coord },
      properties: { damage: d.damage, structure_category: d.structureCategory },
    })),
  };
}

function ignitionCollection(model: ReplayModel): FeatureCollection {
  const ignition = model.fireSimulated?.ignition;
  if (!ignition) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: ignition.coord },
        properties: { provenance: ignition.provenance, at_ms: ignition.atMs },
      },
    ],
  };
}

export function particlesCollection(
  coords: readonly LngLat[],
  stopped: readonly boolean[],
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: coords.map((c, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
      properties: { stopped: stopped[i] },
    })),
  };
}

export function setSourceData(map: MapLibreMap, id: string, data: FeatureCollection): void {
  const source = map.getSource<GeoJSONSource>(id);
  // setData resolves asynchronously; a newer update may supersede (abort) an older one.
  Promise.resolve(source?.setData(data)).catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error(`Replay layer "${id}" could not be updated`, error);
    }
  });
}

export function setGroupVisibility(map: MapLibreMap, group: LayerGroup, visible: boolean): void {
  for (const id of LAYER_GROUPS[group]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

/** Fade the ember fill as the perimeter in effect ages (about half strength after 12 h). */
export function setPerimeterFreshness(map: MapLibreMap, ageMs: number): void {
  const hours = Math.max(0, ageMs / 3_600_000);
  const freshness = Math.max(0.45, 1 - hours / 24);
  if (map.getLayer("fire-fill")) map.setPaintProperty("fire-fill", "fill-opacity", 0.32 * freshness);
  if (map.getLayer("fire-glow-outer")) {
    map.setPaintProperty("fire-glow-outer", "line-opacity", 0.5 * freshness);
  }
}

/** Push road threat codes (1 = fire within 30 min, 2 = within 10 min) into feature-state. */
export function applyThreatState(
  map: MapLibreMap,
  trafficToRoad: readonly number[],
  threats: ReadonlyMap<number, 1 | 2>,
  previous: ReadonlyMap<number, number>,
): Map<number, number> {
  const next = new Map<number, number>();
  for (const [ti, code] of threats) {
    const ri = trafficToRoad[ti];
    if (ri !== undefined && ri >= 0) next.set(ri, Math.max(code, next.get(ri) ?? 0));
  }
  for (const [ri, code] of next) {
    if (previous.get(ri) !== code) map.setFeatureState({ source: "roads", id: ri }, { threat: code });
  }
  for (const ri of previous.keys()) {
    if (!next.has(ri)) map.setFeatureState({ source: "roads", id: ri }, { threat: 0 });
  }
  return next;
}

/** Pulse threatened roads; `phase` in [0, 1]. */
export function setThreatPulse(map: MapLibreMap, phase: number): void {
  if (!map.getLayer("roads-threat")) return;
  const strength = 0.45 + 0.55 * phase;
  map.setPaintProperty("roads-threat", "line-opacity", [
    "match",
    ["coalesce", ["feature-state", "threat"], 0],
    2,
    strength,
    1,
    0.35 + 0.4 * phase,
    0,
  ]);
}

export function pinCollection(pin: LngLat | null): FeatureCollection {
  if (!pin) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: pin }, properties: {} }],
  };
}

/** Diagonal hatch so the simulated front is distinguishable from observed fire without color. */
function hatchImage(
  rgb: [number, number, number],
  alpha: number,
  size = 10,
): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const on = (x + y) % size < 2;
      const o = (y * size + x) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = on ? alpha : 0;
    }
  }
  return { width: size, height: size, data };
}

export function installLayers(map: MapLibreMap, model: ReplayModel): void {
  const geojson = (id: string, data: FeatureCollection = EMPTY) =>
    map.addSource(id, { type: "geojson", data });

  geojson("sim-front");
  geojson("sim-ignition", ignitionCollection(model));
  geojson("fire-history");
  geojson("fire");
  geojson("zones");
  geojson("roads", roadsCollection(model));
  geojson("roads-closed-labels");
  geojson("particles");
  geojson("destinations", destinationsCollection(model));
  geojson("damage", damageCollection(model));
  geojson("pin");
  const imagery = imagerySource();
  if (imagery) {
    map.addSource(IMAGERY_LAYER, imagery);
    // Dimmed so the overlays stay readable; hidden until the Satellite basemap is chosen.
    map.addLayer({
      id: IMAGERY_LAYER,
      type: "raster",
      source: IMAGERY_LAYER,
      layout: { visibility: "none" },
      paint: { "raster-brightness-max": 0.75, "raster-saturation": -0.25, "raster-fade-duration": 0 },
    });
  }
  if (!map.hasImage(SIM_HATCH_IMAGE)) map.addImage(SIM_HATCH_IMAGE, hatchImage([255, 122, 217], 150));
  if (!map.hasImage(ZONE_HATCH_IMAGE)) map.addImage(ZONE_HATCH_IMAGE, hatchImage([255, 181, 71], 70, 12));

  // Zones: dashed when no order has been issued, solid and filled once ordered.
  map.addLayer({
    id: "zones-fill",
    type: "fill",
    source: "zones",
    paint: {
      "fill-color": ["match", ["get", "state"], "ordered", COLORS.zoneOrdered, COLORS.zone],
      "fill-opacity": ["match", ["get", "state"], "ordered", 0.12, "warned", 0.06, 0.02],
    },
  });
  map.addLayer({
    id: "zones-hatch",
    type: "fill",
    source: "zones",
    filter: ["==", ["get", "state"], "ordered"],
    paint: { "fill-pattern": ZONE_HATCH_IMAGE },
  });
  map.addLayer({
    id: "zones-line",
    type: "line",
    source: "zones",
    filter: ["!=", ["get", "state"], "ordered"],
    paint: {
      "line-color": COLORS.zone,
      "line-width": 1,
      "line-opacity": 0.6,
      "line-dasharray": [3, 2],
    },
  });
  map.addLayer({
    id: "zones-line-ordered",
    type: "line",
    source: "zones",
    filter: ["==", ["get", "state"], "ordered"],
    paint: { "line-color": COLORS.zoneOrdered, "line-width": 2, "line-opacity": 0.9 },
  });

  // Simulated front (model output): hatched fill and dashed outline, never the ember style.
  map.addLayer({
    id: "sim-front-fill",
    type: "fill",
    source: "sim-front",
    paint: { "fill-pattern": SIM_HATCH_IMAGE, "fill-opacity": 0.85 },
  });
  map.addLayer({
    id: "sim-front-line",
    type: "line",
    source: "sim-front",
    paint: {
      "line-color": COLORS.simFront,
      "line-width": 1.6,
      "line-dasharray": [2, 1.5],
    },
  });

  // Perimeter progression: faint stacked rings, fading with age rank.
  map.addLayer({
    id: "fire-history",
    type: "line",
    source: "fire-history",
    paint: {
      "line-color": COLORS.history,
      "line-width": 1,
      "line-opacity": ["interpolate", ["linear"], ["get", "rank"], 1, 0.5, 6, 0.18, 20, 0.06],
    },
  });

  // Fire in effect: layered glow, then ember fill and a hot core outline.
  map.addLayer({
    id: "fire-glow-outer",
    type: "line",
    source: "fire",
    paint: { "line-color": COLORS.emberDeep, "line-width": 18, "line-blur": 14, "line-opacity": 0.5 },
  });
  map.addLayer({
    id: "fire-fill",
    type: "fill",
    source: "fire",
    paint: { "fill-color": COLORS.ember, "fill-opacity": 0.32 },
  });
  map.addLayer({
    id: "fire-glow",
    type: "line",
    source: "fire",
    paint: { "line-color": COLORS.ember, "line-width": 6, "line-blur": 4, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "fire-line",
    type: "line",
    source: "fire",
    paint: { "line-color": COLORS.emberCore, "line-width": 1.4 },
  });

  // Road network: dim base everywhere, congestion overlay driven by feature-state.
  map.addLayer({
    id: "roads-base",
    type: "line",
    source: "roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      // Minor (residential) roads fade in at zoom 12; flow and closure layers still show them.
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, ["case", ["get", "major"], 1, 0], 12.5, 1],
      "line-color": ["case", ["get", "major"], COLORS.networkMajor, COLORS.network],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        ["case", ["get", "major"], 0.9, 0.35],
        15,
        ["case", ["get", "major"], 2.6, 1.2],
      ],
    },
  });
  map.addLayer({
    id: "roads-bridge",
    type: "line",
    source: "roads",
    minzoom: 11,
    filter: ["==", ["get", "bridge"], true],
    paint: { "line-color": COLORS.bridge, "line-width": 1, "line-gap-width": 6, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "roads-flow",
    type: "line",
    source: "roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "match",
        ["coalesce", ["feature-state", "cls"], 0],
        1,
        COLORS.free,
        2,
        COLORS.slow,
        3,
        COLORS.jam,
        COLORS.closed,
      ],
      "line-width": ["interpolate", ["linear"], ["coalesce", ["feature-state", "veh"], 0], 0, 0, 1, 1.8, 20, 3.5, 80, 6.5, 250, 10],
      "line-opacity": ["case", [">", ["coalesce", ["feature-state", "veh"], 0], 0], 0.92, 0],
      // Directed edges: offset so both directions of a two-way road stay visible.
      "line-offset": 1.4,
    },
  });
  map.addLayer({
    id: "roads-closed",
    type: "line",
    source: "roads",
    paint: {
      "line-color": COLORS.closed,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 15, 3.2],
      "line-dasharray": [1.2, 1.2],
      "line-opacity": ["case", ["boolean", ["feature-state", "closed"], false], 1, 0],
    },
  });
  // Roads the model expects fire to reach soon: wide dashed band, pulsed from ReplayMap.
  map.addLayer({
    id: "roads-threat",
    type: "line",
    source: "roads",
    paint: {
      "line-color": ["match", ["coalesce", ["feature-state", "threat"], 0], 2, COLORS.jam, COLORS.slow],
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 6],
      "line-dasharray": [0.8, 0.8],
      "line-blur": 1,
      "line-opacity": ["match", ["coalesce", ["feature-state", "threat"], 0], 2, 0.9, 1, 0.6, 0],
    },
  });
  map.addLayer({
    id: "roads-closed-label",
    type: "symbol",
    source: "roads-closed-labels",
    minzoom: 12.5,
    layout: {
      "text-field": "× CLOSED",
      "text-font": LABEL_FONT_BOLD,
      "text-size": 10.5,
      "text-letter-spacing": 0.1,
    },
    paint: { "text-color": "#ffd6dc", "text-halo-color": "#3a0610", "text-halo-width": 2 },
  });
  map.addLayer({
    id: "roads-bridge-label",
    type: "symbol",
    source: "roads",
    minzoom: 13,
    filter: ["==", ["get", "bridge"], true],
    layout: {
      "symbol-placement": "line-center",
      "text-field": "BRIDGE",
      "text-font": LABEL_FONT,
      "text-size": 10,
      "text-offset": [0, -1.1],
    },
    paint: { "text-color": COLORS.bridge, "text-halo-color": "#0a0e13", "text-halo-width": 1.5 },
  });

  // Illustrative particles (modelled counts, not tracked vehicles).
  map.addLayer({
    id: "particles-halo",
    type: "circle",
    source: "particles",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 7],
      "circle-color": ["case", ["get", "stopped"], COLORS.particleStopped, COLORS.free],
      "circle-blur": 1,
      "circle-opacity": 0.4,
    },
  });
  map.addLayer({
    id: "particles",
    type: "circle",
    source: "particles",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 2.6],
      "circle-color": ["case", ["get", "stopped"], COLORS.particleStopped, COLORS.particle],
    },
  });

  map.addLayer({
    id: "zones-label",
    type: "symbol",
    source: "zones",
    minzoom: 11.5,
    layout: {
      "text-field": ["get", "label"],
      "text-font": LABEL_FONT_BOLD,
      "text-size": 11,
      "text-letter-spacing": 0.05,
    },
    paint: {
      "text-color": ["match", ["get", "state"], "ordered", COLORS.zoneOrdered, "#c9d8ff"],
      "text-halo-color": "#0a0e13",
      "text-halo-width": 2,
    },
  });

  map.addLayer({
    id: "sim-ignition",
    type: "circle",
    source: "sim-ignition",
    paint: {
      "circle-radius": 6,
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": COLORS.simFront,
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "sim-ignition-label",
    type: "symbol",
    source: "sim-ignition",
    layout: {
      "text-field": "Assumed ignition (model)",
      "text-font": LABEL_FONT,
      "text-size": 11,
      "text-anchor": "left",
      "text-offset": [1, 0],
    },
    paint: { "text-color": COLORS.simFront, "text-halo-color": "#0a0e13", "text-halo-width": 2 },
  });

  // Destinations: ring marker plus a text label naming the kind.
  map.addLayer({
    id: "destinations-halo",
    type: "circle",
    source: "destinations",
    paint: {
      "circle-radius": 11,
      "circle-color": COLORS.destination,
      "circle-opacity": 0.14,
      "circle-blur": 0.6,
    },
  });
  map.addLayer({
    id: "destinations",
    type: "circle",
    source: "destinations",
    paint: {
      "circle-radius": 4.5,
      "circle-color": "#0a0e13",
      "circle-stroke-color": COLORS.destination,
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "destinations-label",
    type: "symbol",
    source: "destinations",
    minzoom: 10.5,
    layout: {
      "text-field": ["get", "label"],
      "text-font": LABEL_FONT,
      "text-size": 11,
      "text-anchor": "left",
      "text-offset": [1.1, 0],
      "text-optional": true,
    },
    paint: { "text-color": COLORS.destination, "text-halo-color": "#0a0e13", "text-halo-width": 2 },
  });

  // Damage: small hollow markers; post-fire assessments with no damage time.
  map.addLayer({
    id: "damage",
    type: "circle",
    source: "damage",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 15, 4],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": COLORS.damage,
      "circle-stroke-width": 1.2,
      "circle-stroke-opacity": 0.75,
    },
  });

  // Evacuee-tab pin, drawn above everything.
  map.addLayer({
    id: "pin-halo",
    type: "circle",
    source: "pin",
    paint: { "circle-radius": 16, "circle-color": "#ffffff", "circle-opacity": 0.15, "circle-blur": 0.5 },
  });
  map.addLayer({
    id: "pin",
    type: "circle",
    source: "pin",
    paint: {
      "circle-radius": 6,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#0a0e13",
      "circle-stroke-width": 3,
    },
  });
}
