// MapLibre glue: sources, layers and GeoJSON builders for the replay overlays. Sources are
// added once on load; per-tick changes go through setData on small sources or feature-state
// on the (large, static) road network. Layers are never re-created per tick.
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapOptions } from "maplibre-gl";
import { SATELLITE_STYLE } from "../maps/basemap";
import { BASEMAP_BACKGROUND, SATELLITE_BACKGROUND } from "./basemapStyle";
import { ignitionBasis } from "./timeline";
import { REFUGE_KIND, refugeStateAt, traCode, type RefugeTimeline } from "./refuges";
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
  layers: [{ id: "background", type: "background", paint: { "background-color": BASEMAP_BACKGROUND } }],
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
  // Mid-grey rather than black where imagery tiles have not arrived yet.
  if (map.getLayer("background")) {
    map.setPaintProperty(
      "background",
      "background-color",
      basemap === "satellite" ? SATELLITE_BACKGROUND : BASEMAP_BACKGROUND,
    );
  }
}

/** The bundle bbox as a closed outline: where roads, traffic and fire are modelled. */
export function simAreaCollection(model: ReplayModel): FeatureCollection {
  const [w, s, e, n] = model.bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] },
      },
      // Label anchored at the north-west corner, just outside the outline.
      {
        type: "Feature",
        properties: { label: "Simulated area: roads, traffic and fire modelled inside" },
        geometry: { type: "Point", coordinates: [w, n] },
      },
    ],
  };
}

// Congestion bands: mean speed as a fraction of the edge's free-flow speed_kph.
export const CONGESTION_FREE_RATIO = 0.7;
export const CONGESTION_SLOW_RATIO = 0.35;

const MAJOR_HIGHWAYS = ["motorway", "trunk", "primary", "secondary", "tertiary"];
const ZONE_HATCH_IMAGE = "rp-zone-hatch";
const ZONE_HATCH_OPACITY = 0.22;

export const COLORS = {
  ember: "#ff6a1a",
  emberCore: "#ffd29a",
  emberDeep: "#ff3d00",
  char: "#140604",
  satellite: "#eaf4ff",
  history: "#ff9a5c",
  // Strict palette: warm = fire only; one cyan for traffic (dimmer when slow, thicker when
  // busy); everything else neutral grey/white so the fire and the traffic read first.
  simFront: "#ffd166",
  fireBand: "#ff9a1f",
  free: "#3df2ff",
  slow: "#2bb3c6",
  jam: "#16707f",
  closed: "#8a96a3",
  threat: "#ffb547",
  threatImminent: "#ff7a1a",
  network: "#26394a",
  networkMajor: "#3d566c",
  bridge: "#d8e3ee",
  particle: "#e9fbff",
  particleStopped: "#ffffff",
  zone: "#8a96a3",
  zoneOrdered: "#c3cdd6",
  destination: "#aab4be",
  refuge: "#ffffff",
  fireObs: "#ffffff",
  damage: "#c3cdd6",
} as const;

export type LayerGroup =
  | "fire"
  | "history"
  | "simFire"
  | "fireObs"
  | "roads"
  | "particles"
  | "zones"
  | "people"
  | "destinations"
  | "damage";

export const LAYER_GROUPS: Record<LayerGroup, string[]> = {
  history: ["fire-history"],
  simFire: [
    "sim-front-fill",
    "sim-char-fill",
    "sim-edge-glow",
    "sim-edge-mid",
    "sim-front-line",
    "sim-front-label",
    "sim-ignition",
  ],
  fire: ["fire-glow-outer", "fire-fill", "fire-glow", "fire-line", "fire-label"],
  fireObs: ["fire-obs"],
  zones: ["zones-fill", "zones-hatch", "zones-line", "zones-line-ordered"],
  people: ["people-fill", "people-line"],
  roads: [
    "roads-base",
    "roads-bridge",
    "roads-flow-glow",
    "roads-flow",
    "roads-closed",
    "roads-closed-label",
    "roads-bridge-label",
  ],
  particles: ["particles-halo", "particles"],
  destinations: ["destinations-halo", "destinations", "refuges", "refuges-label"],
  damage: ["damage"],
};

/** Layers that show a tooltip on hover, topmost first. */
export const INTERACTIVE_LAYERS = [
  "particles",
  "fire-obs",
  "refuges",
  "destinations",
  "damage",
  "roads-closed",
  "roads-threat",
  "roads-flow",
  "sim-ignition",
  "zones-fill",
  "people-fill",
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
          half_day: perimeter.timePrecision === "half_day",
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
    const ratio = roads[ri].speedKph > 0 ? Math.min(1, speed / roads[ri].speedKph) : 1;
    map.setFeatureState({ source: "roads", id: ri }, { veh, speed, ratio, cls: ROAD_CLASS_CODE[cls] });
    next.add(ri);
  }
  for (const ri of previous) {
    if (!next.has(ri)) map.setFeatureState({ source: "roads", id: ri }, { veh: 0, speed: null, cls: 0 });
  }
  return next;
}

/** Households at home per km² -> fill colour (grey to white). Shared with the map key. */
export const PEOPLE_RAMP: [number, string][] = [
  [0, "#1f262e"],
  [25, "#3a434d"],
  [100, "#6b7682"],
  [300, "#aab4be"],
  [800, "#f2f5f8"],
];

/** Static zone polygons for the people layer; numeric feature ids match zone order. */
export function peopleCollection(model: ReplayModel): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (model.zones?.items ?? []).map((zone, i) => ({
      type: "Feature",
      id: i,
      geometry: zone.geometry,
      properties: { name: zone.name, households: zone.households, population: zone.population, vehicles: zone.vehicles },
    })),
  };
}

/** Push per-zone at-home figures to the people layer as feature-state. */
export function applyPeopleState(
  map: MapLibreMap,
  rows: readonly ({ home: number; left: number; density: number } | null)[],
): void {
  if (!map.getSource("people")) return;
  rows.forEach((row, i) => {
    map.setFeatureState(
      { source: "people", id: i },
      row ? { density: row.density, home: row.home, left: row.left } : { density: 0, home: null, left: null },
    );
  });
}

export function zonesCollection(
  zones: readonly Zone[],
  states: Map<string, "ordered" | "warned">,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: zones.map((zone, i) => {
      const state = states.get(zone.id) ?? "none";
      const suffix = state === "ordered" ? " · ORDERED" : state === "warned" ? " · WARNING" : "";
      return {
        type: "Feature",
        id: i,
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

/** Destinations with their own evidence class; refuges carry their open state at time t. */
export function destinationsCollection(model: ReplayModel, refuges: RefugeTimeline, t: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (model.destinations?.items ?? []).map((d) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: d.coord },
      properties: {
        name: d.name,
        dest_kind: d.kind,
        evidence_class: d.evidenceClass,
        label: `${d.name} (${d.kind.replace(/_/g, " ")})`,
        short: d.kind === REFUGE_KIND ? (traCode(d.name) ? `TRA-${traCode(d.name)}` : d.name) : "",
        capacity_veh: d.capacityVeh,
        refuge_state: d.kind === REFUGE_KIND ? refugeStateAt(refuges, d.id, t) : "",
        refuge_opened_ms: refuges.get(d.id)?.find((s) => s.open)?.atMs ?? null,
      },
    })),
  };
}

/** NIST fire observation points with their observed time, for a time filter on the layer. */
export function fireObservationsCollection(model: ReplayModel): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (model.fireObservations?.items ?? []).map((o) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: o.coord },
      properties: {
        at_ms: o.atMs,
        time_precision: o.timePrecision,
        location_source: o.locationSource,
        residual: o.residual,
        source_locator: o.sourceLocator,
        evidence_class: model.fireObservations?.evidenceClass ?? null,
      },
    })),
  };
}

/** How long an observation stays highlighted as "recent" after its time. */
export const FIRE_OBS_RECENT_MS = 30 * 60_000;

/** Show observations seen by t; the last FIRE_OBS_RECENT_MS of them larger and brighter. */
export function setFireObservationTime(map: MapLibreMap, t: number): void {
  if (map.getLayer("fire-obs")) {
    map.setFilter("fire-obs", ["<=", ["get", "at_ms"], t]);
    map.setPaintProperty("fire-obs", "circle-radius", [
      "case",
      [">", ["get", "at_ms"], t - FIRE_OBS_RECENT_MS],
      4.5,
      2.6,
    ]);
    map.setPaintProperty("fire-obs", "circle-stroke-opacity", [
      "case",
      [">", ["get", "at_ms"], t - FIRE_OBS_RECENT_MS],
      1,
      0.55,
    ]);
  }
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
        properties: {
          provenance: ignition.provenance,
          at_ms: ignition.atMs,
          label: `${ignitionBasis(model) === "reconstructed" ? "Reconstructed" : "Assumed"} ignition (model start)`,
        },
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
export function setPerimeterFreshness(map: MapLibreMap, ageMs: number, provisional = false): void {
  const hours = Math.max(0, ageMs / 3_600_000);
  const freshness = Math.max(0.45, 1 - hours / 24);
  // Provisional (inside a half-day composite's window): dotted outline, faint fill, no glow.
  if (map.getLayer("fire-fill")) map.setPaintProperty("fire-fill", "fill-opacity", provisional ? 0.12 : 0.32 * freshness);
  if (map.getLayer("fire-glow-outer")) {
    map.setPaintProperty("fire-glow-outer", "line-opacity", provisional ? 0 : 0.5 * freshness);
  }
  if (map.getLayer("fire-glow")) map.setPaintProperty("fire-glow", "line-opacity", provisional ? 0 : 0.6);
  if (map.getLayer("fire-line")) {
    map.setPaintProperty("fire-line", "line-dasharray", provisional ? [1, 3] : [3, 2]);
    map.setPaintProperty("fire-line", "line-opacity", provisional ? 0.6 : 1);
  }
}

/** Label on the perimeter edge: the satellite tag, or "extent sometime by HH:MM" while provisional. */
export function setPerimeterLabel(map: MapLibreMap, text: string): void {
  if (map.getLayer("fire-label")) map.setLayoutProperty("fire-label", "text-field", text);
}

/** Cosmetic flicker of the model fire edge and pulse of ordered-zone hatching; `t` in ms. */
export function setFireFlicker(map: MapLibreMap, t: number): void {
  const flicker = 0.5 + 0.25 * Math.sin(t / 130) + 0.15 * Math.sin(t / 53) + 0.1 * Math.sin(t / 311);
  if (map.getLayer("sim-edge-glow")) {
    map.setPaintProperty("sim-edge-glow", "line-opacity", 0.4 + 0.35 * flicker);
    map.setPaintProperty("sim-edge-glow", "line-width", 18 + 8 * flicker);
  }
  if (map.getLayer("sim-edge-mid")) map.setPaintProperty("sim-edge-mid", "line-opacity", 0.7 + 0.3 * flicker);
  if (map.getLayer("zones-hatch")) {
    map.setPaintProperty("zones-hatch", "fill-opacity", ZONE_HATCH_OPACITY * (0.6 + 0.4 * Math.sin(t / 900)));
  }
}

/** Set zone-order flash strength (0..1) by zone feature index. */
export function setZoneFlash(map: MapLibreMap, zoneIndex: number, strength: number): void {
  map.setFeatureState({ source: "zones", id: zoneIndex }, { flash: strength });
}

export function setIgnitionLabelVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer("sim-ignition-label")) {
    map.setLayoutProperty("sim-ignition-label", "visibility", visible ? "visible" : "none");
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
  geojson("sim-char");
  geojson("sim-ignition", ignitionCollection(model));
  geojson("fire-history");
  geojson("fire");
  geojson("zones");
  map.addSource("people", { type: "geojson", data: peopleCollection(model) });
  geojson("roads", roadsCollection(model));
  geojson("roads-closed-labels");
  geojson("particles");
  geojson("destinations", destinationsCollection(model, new Map(), model.clock.startMs));
  geojson("fire-obs", fireObservationsCollection(model));
  geojson("damage", damageCollection(model));
  geojson("pin");
  geojson("sim-area", simAreaCollection(model));
  const imagery = imagerySource();
  if (imagery) {
    map.addSource(IMAGERY_LAYER, imagery);
    // Dimmed so the overlays stay readable; hidden until the Satellite basemap is chosen. Placed
    // under the basemap's place labels so towns stay named over imagery.
    const labels = map.getStyle().layers.find((l) => l.id.startsWith("place_"))?.id;
    map.addLayer(
      {
        id: IMAGERY_LAYER,
        type: "raster",
        source: IMAGERY_LAYER,
        layout: { visibility: "none" },
        paint: { "raster-brightness-max": 0.75, "raster-saturation": -0.25, "raster-fade-duration": 0 },
      },
      labels,
    );
  }
  // Extent of the modelled area, so it is clear why the traffic network ends there.
  map.addLayer({
    id: "sim-area-line",
    type: "line",
    source: "sim-area",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": "#c3cdd6", "line-opacity": 0.55, "line-width": 1.2, "line-dasharray": [4, 3] },
  });
  // Zoomed in, the corner label is off-screen: repeat a short tag along the outline.
  map.addLayer({
    id: "sim-area-edge-label",
    type: "symbol",
    source: "sim-area",
    minzoom: 10,
    filter: ["==", ["geometry-type"], "LineString"],
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 500,
      "text-field": "Simulated area edge",
      "text-font": LABEL_FONT,
      "text-size": 10.5,
      "text-offset": [0, -0.8],
    },
    paint: { "text-color": "#c3cdd6", "text-halo-color": "#0a0e13", "text-halo-width": 1.6, "text-opacity": 0.8 },
  });
  map.addLayer({
    id: "sim-area-label",
    type: "symbol",
    source: "sim-area",
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "text-field": ["get", "label"],
      "text-font": LABEL_FONT,
      "text-size": 11.5,
      "text-anchor": "bottom-left",
      "text-offset": [0.2, -0.4],
      "text-max-width": 40,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: { "text-color": "#c3cdd6", "text-halo-color": "#0a0e13", "text-halo-width": 1.6, "text-opacity": 0.85 },
  });
  if (!map.hasImage(ZONE_HATCH_IMAGE)) map.addImage(ZONE_HATCH_IMAGE, hatchImage([195, 205, 214], 60, 14));

  // People at home: households still home per km², a neutral grey-to-white ramp (never warm,
  // never cyan) under everything else. Density arrives as feature-state from ReplayMap.
  map.addLayer({
    id: "people-fill",
    type: "fill",
    source: "people",
    paint: {
      "fill-color": [
        "interpolate",
        ["linear"],
        ["coalesce", ["feature-state", "density"], 0],
        ...PEOPLE_RAMP.flat(),
      ],
      "fill-opacity": ["case", [">", ["coalesce", ["feature-state", "density"], 0], 0.5], 0.42, 0],
    },
  });
  map.addLayer({
    id: "people-line",
    type: "line",
    source: "people",
    paint: { "line-color": "#c3cdd6", "line-opacity": 0.18, "line-width": 0.6 },
  });

  // Zones: nearly invisible until ordered; ordered zones get a faint (pulsed) hatch.
  map.addLayer({
    id: "zones-fill",
    type: "fill",
    source: "zones",
    paint: {
      "fill-color": ["match", ["get", "state"], "ordered", COLORS.zoneOrdered, COLORS.zone],
      "fill-opacity": ["match", ["get", "state"], "ordered", 0.035, "warned", 0.02, 0.006],
    },
  });
  map.addLayer({
    id: "zones-hatch",
    type: "fill",
    source: "zones",
    filter: ["==", ["get", "state"], "ordered"],
    paint: { "fill-pattern": ZONE_HATCH_IMAGE, "fill-opacity": ZONE_HATCH_OPACITY },
  });
  map.addLayer({
    id: "zones-line",
    type: "line",
    source: "zones",
    filter: ["!=", ["get", "state"], "ordered"],
    paint: {
      "line-color": COLORS.zone,
      "line-width": 0.6,
      "line-opacity": 0.22,
      "line-dasharray": [3, 3],
    },
  });
  map.addLayer({
    id: "zones-line-ordered",
    type: "line",
    source: "zones",
    filter: ["==", ["get", "state"], "ordered"],
    paint: { "line-color": COLORS.zoneOrdered, "line-width": 0.8, "line-opacity": 0.3 },
  });
  // Brief amber pulse when an order is issued; independent of the (off by default) zones toggle.
  map.addLayer({
    id: "zones-flash",
    type: "line",
    source: "zones",
    paint: {
      "line-color": COLORS.zoneOrdered,
      "line-width": 3,
      "line-blur": 1.5,
      "line-opacity": ["coalesce", ["feature-state", "flash"], 0],
    },
  });

  // Model fire: the newest band (last ~30 min) glows orange-yellow; older area is opaque
  // burned char; the leading edge is a thick blurred orange line under a thin yellow core.
  map.addLayer({
    id: "sim-front-fill",
    type: "fill",
    source: "sim-front",
    paint: { "fill-color": COLORS.fireBand, "fill-opacity": 0.72 },
  });
  map.addLayer({
    id: "sim-char-fill",
    type: "fill",
    source: "sim-char",
    paint: { "fill-color": COLORS.char, "fill-opacity": 0.92 },
  });
  map.addLayer({
    id: "sim-edge-glow",
    type: "line",
    source: "sim-front",
    paint: { "line-color": COLORS.emberDeep, "line-width": 16, "line-blur": 10, "line-opacity": 0.75 },
  });
  map.addLayer({
    id: "sim-edge-mid",
    type: "line",
    source: "sim-front",
    paint: { "line-color": COLORS.ember, "line-width": 5, "line-blur": 2, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "sim-front-line",
    type: "line",
    source: "sim-front",
    paint: { "line-color": "#ffe066", "line-width": 1.6 },
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

  // Satellite perimeter in effect: ember body with a cool-white dashed outline, distinct
  // from the model's solid glowing edge.
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
    paint: { "fill-color": COLORS.ember, "fill-opacity": 0.16 },
  });
  map.addLayer({
    id: "fire-glow",
    type: "line",
    source: "fire",
    paint: { "line-color": COLORS.ember, "line-width": 5, "line-blur": 4, "line-opacity": 0.6 },
  });
  map.addLayer({
    id: "fire-line",
    type: "line",
    source: "fire",
    paint: { "line-color": COLORS.satellite, "line-width": 2.2, "line-dasharray": [3, 2] },
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
  // Congestion: continuous red -> amber -> green by speed ratio, width by vehicle count,
  // with a soft glow underneath so busy corridors pop.
  map.addLayer({
    id: "roads-flow-glow",
    type: "line",
    source: "roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["==", ["coalesce", ["feature-state", "cls"], 0], 4], COLORS.closed, ["interpolate", ["linear"], ["coalesce", ["feature-state", "ratio"], 1], 0, COLORS.jam, CONGESTION_SLOW_RATIO, COLORS.jam, CONGESTION_FREE_RATIO, COLORS.slow, 0.9, COLORS.free]],
      "line-width": ["interpolate", ["linear"], ["coalesce", ["feature-state", "veh"], 0], 0, 0, 1, 6, 20, 10, 80, 16, 250, 24],
      "line-blur": 8,
      "line-opacity": ["case", [">", ["coalesce", ["feature-state", "veh"], 0], 0], 0.32, 0],
      "line-offset": 1.4,
    },
  });
  map.addLayer({
    id: "roads-flow",
    type: "line",
    source: "roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["==", ["coalesce", ["feature-state", "cls"], 0], 4], COLORS.closed, ["interpolate", ["linear"], ["coalesce", ["feature-state", "ratio"], 1], 0, COLORS.jam, CONGESTION_SLOW_RATIO, COLORS.jam, CONGESTION_FREE_RATIO, COLORS.slow, 0.9, COLORS.free]],
      "line-width": ["interpolate", ["linear"], ["coalesce", ["feature-state", "veh"], 0], 0, 0, 1, 2.2, 20, 4, 80, 7, 250, 11],
      "line-opacity": ["case", [">", ["coalesce", ["feature-state", "veh"], 0], 0], 0.95, 0],
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
      "line-opacity": ["case", ["boolean", ["feature-state", "closed"], false], 0.55, 0],
    },
  });
  // Roads the model expects fire to reach soon. Hidden: it added a second warm, moving mark;
  // the same lookahead stays in the tooltips and the Evacuee view.
  map.addLayer({
    id: "roads-threat",
    type: "line",
    source: "roads",
    layout: { visibility: "none" },
    paint: {
      "line-color": ["match", ["coalesce", ["feature-state", "threat"], 0], 2, COLORS.threatImminent, COLORS.threat],
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 2.5],
      "line-dasharray": [2, 2],
      "line-opacity": ["match", ["coalesce", ["feature-state", "threat"], 0], 2, 0.9, 1, 0.6, 0],
    },
  });
  map.addLayer({
    id: "roads-closed-label",
    type: "symbol",
    source: "roads-closed-labels",
    // Only close in, so a burned-over town is not covered in repeated tags.
    minzoom: 14,
    layout: {
      "text-field": "× CLOSED",
      "text-font": LABEL_FONT_BOLD,
      "text-size": 10.5,
      "text-letter-spacing": 0.1,
    },
    paint: { "text-color": "#d6dde4", "text-halo-color": "#0a0e13", "text-halo-width": 2 },
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
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 13, 8, 16, 12],
      "circle-color": "#7ff9ff",
      "circle-blur": 1,
      // Glow only on moving dots; stopped ones are plain white with a dark ring.
      "circle-opacity": ["case", ["get", "stopped"], 0, 0.5],
    },
  });
  map.addLayer({
    id: "particles",
    type: "circle",
    source: "particles",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 13, 3, 16, 4],
      "circle-color": ["case", ["get", "stopped"], COLORS.particleStopped, COLORS.particle],
      "circle-stroke-color": ["case", ["get", "stopped"], "#0a0e13", "#7ff9ff"],
      "circle-stroke-width": ["case", ["get", "stopped"], 1.2, 0.6],
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
      "text-field": ["get", "label"],
      "text-font": LABEL_FONT,
      "text-size": 11,
      "text-anchor": "left",
      "text-offset": [1, 0],
    },
    paint: { "text-color": COLORS.simFront, "text-halo-color": "#0a0e13", "text-halo-width": 2 },
  });

  // Text tags on the fire edges, so model and satellite never read alike.
  map.addLayer({
    id: "sim-front-label",
    type: "symbol",
    source: "sim-front",
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 420,
      "text-field": "MODEL FIRE (simulated)",
      "text-font": LABEL_FONT_BOLD,
      "text-size": 10.5,
      "text-letter-spacing": 0.15,
      "text-offset": [0, -1.2],
    },
    paint: { "text-color": "#ffc46b", "text-halo-color": "#1a0702", "text-halo-width": 2 },
  });
  map.addLayer({
    id: "fire-label",
    type: "symbol",
    source: "fire",
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 480,
      "text-field": "SATELLITE ESTIMATE",
      "text-font": LABEL_FONT_BOLD,
      "text-size": 10.5,
      "text-letter-spacing": 0.15,
      "text-offset": [0, -1.2],
    },
    paint: { "text-color": COLORS.satellite, "text-halo-color": "#0a0e13", "text-halo-width": 2 },
  });

  // Destinations: ring marker plus a text label naming the kind.
  map.addLayer({
    id: "destinations-halo",
    type: "circle",
    source: "destinations",
    filter: ["!=", ["get", "dest_kind"], REFUGE_KIND],
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
    filter: ["!=", ["get", "dest_kind"], REFUGE_KIND],
    paint: {
      "circle-radius": 4.5,
      "circle-color": "#0a0e13",
      "circle-stroke-color": COLORS.destination,
      "circle-stroke-width": 2.5,
    },
  });
  // Temporary refuge areas (NIST): solid marker with a white ring and a "TRA-x" tag, so they
  // never read as exits (hollow rings). Faded while not open; open/closed is also in the tooltip.
  map.addLayer({
    id: "refuges",
    type: "circle",
    source: "destinations",
    filter: ["==", ["get", "dest_kind"], REFUGE_KIND],
    paint: {
      "circle-radius": ["match", ["get", "refuge_state"], "open", 6.5, 4.5],
      "circle-color": COLORS.refuge,
      "circle-opacity": ["match", ["get", "refuge_state"], "closed", 0.25, 0.95],
      "circle-stroke-color": "#4b5157",
      "circle-stroke-width": ["match", ["get", "refuge_state"], "open", 2, 1],
      "circle-stroke-opacity": ["match", ["get", "refuge_state"], "closed", 0.35, 1],
    },
  });
  map.addLayer({
    id: "refuges-label",
    type: "symbol",
    source: "destinations",
    minzoom: 11,
    filter: ["all", ["==", ["get", "dest_kind"], REFUGE_KIND], ["==", ["get", "refuge_state"], "open"]],
    layout: {
      "text-field": ["concat", ["get", "short"], " refuge"],
      "text-font": LABEL_FONT_BOLD,
      "text-size": 10.5,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
    },
    paint: { "text-color": COLORS.refuge, "text-halo-color": "#0a0e13", "text-halo-width": 1.6 },
  });

  // NIST fire observations: small warm dots with a dark ring, shown from their observed time.
  // Reconstructed evidence, so solid points, never an area or a glow like the model fire.
  map.addLayer({
    id: "fire-obs",
    type: "circle",
    source: "fire-obs",
    filter: ["<=", ["get", "at_ms"], model.clock.startMs],
    paint: {
      "circle-radius": 2.6,
      // Hollow white rings: evidence points, never a second warm colour next to the fire.
      "circle-color": "rgba(0, 0, 0, 0)",
      "circle-stroke-color": COLORS.fireObs,
      "circle-stroke-width": 1.1,
      "circle-stroke-opacity": 0.55,
    },
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
