// Camera perspectives for the replay map: top-down observer, oblique 3D ("news helicopter")
// and a modelled ground-level POV that drives along the road network. Everything added here
// (sources, layers, terrain, sky, animation frames, listeners) is owned by this module and
// removed when returning to observer or on clearPerspective.
import type { LngLat as MapLngLat, Map as MapLibreMap } from "maplibre-gl";
import { closedEdgesAt, simulatedFrontIndexAt } from "../timeline";
import type { AreaGeometry, LngLat, ReplayModel } from "../types";
import {
  angleDiff,
  areaCenter,
  bearingDeg,
  distanceToAreaM,
  nextEdge,
  pointAlong,
  polylineLength,
  type RoadGraph,
} from "./geo";

export type PerspectiveMode = "observer" | "oblique" | "ground";

/** AWS Terrain Tiles (public dataset, terrarium encoding). */
export const TERRAIN_TILES_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_ATTRIBUTION = "Terrain: AWS Terrain Tiles / Mapzen";
export const IMAGERY_TILES_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
// Same credit as maps/basemap.ts, plus a warning that the imagery is not from the incident.
export const IMAGERY_ATTRIBUTION =
  '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USDA / USGS The National Map</a> · Historical imagery · imagery dates vary — not Nov 2018';

const TERRAIN_SOURCE = "persp-terrain";
const HILLSHADE_SOURCE = "persp-hillshade-dem";
const IMAGERY_SOURCE = "persp-imagery";
const IMAGERY_LAYER = "persp-imagery";
const HILLSHADE_LAYER = "persp-hillshade";
const TERRAIN_EXAGGERATION = 1.5;
/** Replay data layers, bottom-most first; imagery and hillshade go beneath the first present. */
const DATA_LAYER_ANCHORS = ["zones-fill", "sim-front-fill", "fire-history", "fire-glow-outer", "roads-base"];
/** Layers that represent the road network for click-to-follow. */
export const ROAD_PICK_LAYERS = ["roads-flow", "roads-closed", "roads-base"];

const MAX_PITCH_3D = 85;
const OBLIQUE_PITCH = 65;
const OBLIQUE_BEARING = -20;
const OBLIQUE_ZOOM = 12.2;
const OBLIQUE_FLY_MS = 2600;
const ORBIT_DEG_PER_S = 2;

const GROUND_PITCH = 80;
const GROUND_FALLBACK_ZOOM = 17;
/** Camera height above the (exaggerated) terrain surface; a modelled driver-ish viewpoint. */
const GROUND_EYE_HEIGHT_M = 30;
const GROUND_LOOKAHEAD_M = 60;
/** Exponential smoothing rates (per second) for bearing and terrain elevation. */
const BEARING_SMOOTH_PER_S = 2.5;
const ELEVATION_SMOOTH_PER_S = 4;
const MAX_DT_S = 0.1;
const HUD_INTERVAL_MS = 250;

/** Sky turns smoky when the active fire area is within this distance of the camera target. */
const FIRE_NEAR_M = 15_000;
const SKY_CHECK_MS = 1000;
type Sky = Parameters<MapLibreMap["setSky"]>[0];
const CLEAR_SKY: Sky = {
  "sky-color": "#5f86b0",
  "horizon-color": "#d3dde4",
  "fog-color": "#c2ccd2",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.5,
  "fog-ground-blend": 0.75,
};
const SMOKE_SKY: Sky = {
  "sky-color": "#4a2c1e",
  "horizon-color": "#e07a36",
  "fog-color": "#9a5632",
  "sky-horizon-blend": 0.9,
  "horizon-fog-blend": 0.85,
  "fog-ground-blend": 0.35,
};

export type FireSource = "observed perimeter" | "simulated front";

export interface GroundHud {
  roadName: string;
  /** Modelled mean speed when the edge carries traffic in this frame, otherwise free-flow. */
  speedKph: number;
  speedSource: "modelled" | "free-flow";
  vehicles: number;
  closed: boolean;
  /** 0 = inside the fire area; null = no fire area in effect. */
  fireDistanceM: number | null;
  fireSource: FireSource | null;
}

export interface PerspectiveContext {
  model: ReplayModel;
  graph: RoadGraph;
  /** Live getters, read every animation frame so playback keeps driving the 3D views. */
  frameIndex: () => number;
  perimeterIndex: () => number;
  simTimeMs: () => number;
  /** Ground mode: edge to start on; defaults to the busiest edge in the current frame. */
  edgeId?: string | null;
  /** Oblique mode: whether to slowly orbit after arriving (ignored under prefers-reduced-motion). */
  orbit?: () => boolean;
  onGroundHud?: (hud: GroundHud | null) => void;
}

interface State {
  mode: PerspectiveMode;
  saved: { maxPitch: number; dragRotate: boolean; sky: Sky | undefined } | null;
  stopMode: (() => void) | null;
  /** Top-down camera to return to when leaving the 3D modes. */
  observerCamera: { center: MapLngLat; zoom: number } | null;
  skyTimer: number | null;
  skyKey: string;
}

const states = new WeakMap<MapLibreMap, State>();

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function getPerspective(map: MapLibreMap): PerspectiveMode {
  return states.get(map)?.mode ?? "observer";
}

/**
 * Switch the map to `mode`. Safe to call repeatedly; re-calling "ground" with a new edgeId
 * re-targets the drive. Throws nothing if the style is still loading: the switch is retried
 * once the style reports ready.
 */
export function setPerspective(map: MapLibreMap, mode: PerspectiveMode, ctx: PerspectiveContext): void {
  let state = states.get(map);
  if (!state) {
    state = { mode: "observer", saved: null, stopMode: null, observerCamera: null, skyTimer: null, skyKey: "" };
    states.set(map, state);
  }
  state.stopMode?.();
  state.stopMode = null;
  if (state.mode === "observer" && mode !== "observer") {
    state.observerCamera = { center: map.getCenter(), zoom: map.getZoom() };
  }
  state.mode = mode;

  if (mode === "observer") {
    teardown3d(map, state);
    ctx.onGroundHud?.(null);
    const camera = { ...(state.observerCamera ?? {}), pitch: 0, bearing: 0 };
    if (prefersReducedMotion()) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: 900 });
    return;
  }

  if (!install3d(map, state, ctx)) {
    // Style not ready yet: retry once it is, unless the mode changed in the meantime.
    const retry = () => {
      if (states.get(map)?.mode === mode) setPerspective(map, mode, ctx);
    };
    map.once("styledata", retry);
    state.stopMode = () => map.off("styledata", retry);
    return;
  }
  state.stopMode = mode === "oblique" ? startOblique(map, ctx) : startGround(map, ctx);
}

/** Remove everything this module added (call on unmount, before map.remove()). */
export function clearPerspective(map: MapLibreMap): void {
  const state = states.get(map);
  if (!state) return;
  try {
    state.stopMode?.();
  } catch {
    // Map already removed.
  }
  state.stopMode = null;
  state.mode = "observer";
  teardown3d(map, state);
  states.delete(map);
}

function firstAnchor(map: MapLibreMap): string | undefined {
  return DATA_LAYER_ANCHORS.find((id) => map.getLayer(id));
}

function install3d(map: MapLibreMap, state: State, ctx: PerspectiveContext): boolean {
  try {
    if (!map.getSource(IMAGERY_SOURCE)) {
      map.addSource(IMAGERY_SOURCE, {
        type: "raster",
        tiles: [IMAGERY_TILES_URL],
        tileSize: 256,
        maxzoom: 16,
        attribution: IMAGERY_ATTRIBUTION,
      });
    }
    // Separate DEM sources for terrain and hillshade, as MapLibre recommends.
    for (const id of [TERRAIN_SOURCE, HILLSHADE_SOURCE]) {
      if (!map.getSource(id)) {
        map.addSource(id, {
          type: "raster-dem",
          tiles: [TERRAIN_TILES_URL],
          encoding: "terrarium",
          tileSize: 256,
          maxzoom: 15,
          attribution: TERRAIN_ATTRIBUTION,
        });
      }
    }
    const before = firstAnchor(map);
    if (!map.getLayer(IMAGERY_LAYER)) {
      map.addLayer(
        { id: IMAGERY_LAYER, type: "raster", source: IMAGERY_SOURCE, paint: { "raster-opacity": 0.92 } },
        before,
      );
    }
    if (!map.getLayer(HILLSHADE_LAYER)) {
      map.addLayer(
        {
          id: HILLSHADE_LAYER,
          type: "hillshade",
          source: HILLSHADE_SOURCE,
          paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#1a0f08" },
        },
        before,
      );
    }
    if (!map.getTerrain()) map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
  } catch (error) {
    if (error instanceof Error && /style is not done loading/i.test(error.message)) return false;
    throw error;
  }

  if (!state.saved) {
    state.saved = { maxPitch: map.getMaxPitch(), dragRotate: map.dragRotate.isEnabled(), sky: map.getSky() };
    map.setMaxPitch(MAX_PITCH_3D);
    map.dragRotate.enable();
  }
  if (state.skyTimer === null) {
    state.skyKey = "";
    const update = () => updateSky(map, state, ctx);
    update();
    state.skyTimer = window.setInterval(update, SKY_CHECK_MS);
  }
  return true;
}

function teardown3d(map: MapLibreMap, state: State): void {
  if (state.skyTimer !== null) window.clearInterval(state.skyTimer);
  state.skyTimer = null;
  // The map may already be removed (unmount order); every call below must tolerate that.
  try {
    if (map.getTerrain()) map.setTerrain(null);
    for (const id of [HILLSHADE_LAYER, IMAGERY_LAYER]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [HILLSHADE_SOURCE, TERRAIN_SOURCE, IMAGERY_SOURCE]) if (map.getSource(id)) map.removeSource(id);
    if (state.saved) {
      map.setSky(state.saved.sky ?? {});
      if (!state.saved.dragRotate) map.dragRotate.disable();
      if (map.getPitch() > state.saved.maxPitch) map.jumpTo({ pitch: state.saved.maxPitch });
      map.setMaxPitch(state.saved.maxPitch);
    }
  } catch {
    // Map or style already gone: nothing left to clean.
  }
  state.saved = null;
}

/** The fire area in effect: observed perimeter, else the simulated front before the first one. */
export function activeFire(ctx: PerspectiveContext): { geometry: AreaGeometry; source: FireSource } | null {
  const { model } = ctx;
  const pi = ctx.perimeterIndex();
  if (pi >= 0 && model.perimeters[pi]) return { geometry: model.perimeters[pi].geometry, source: "observed perimeter" };
  const si = simulatedFrontIndexAt(model, ctx.simTimeMs());
  const front = si >= 0 ? model.fireSimulated?.fronts[si] : undefined;
  return front ? { geometry: front.geometry, source: "simulated front" } : null;
}

const toLngLat = (c: MapLngLat): LngLat => [c.lng, c.lat];

function updateSky(map: MapLibreMap, state: State, ctx: PerspectiveContext): void {
  const fire = activeFire(ctx);
  const near = fire !== null && distanceToAreaM(toLngLat(map.getCenter()), fire.geometry) < FIRE_NEAR_M;
  const key = near ? "smoke" : "clear";
  if (key === state.skyKey) return;
  state.skyKey = key;
  try {
    map.setSky(near ? SMOKE_SKY : CLEAR_SKY);
  } catch {
    state.skyKey = "";
  }
}

function startOblique(map: MapLibreMap, ctx: PerspectiveContext): () => void {
  const fire = activeFire(ctx);
  const [w, s, e, n] = ctx.model.bbox;
  const center = (fire && areaCenter(fire.geometry)) ?? [(w + e) / 2, (s + n) / 2];
  const camera = { center, zoom: OBLIQUE_ZOOM, pitch: OBLIQUE_PITCH, bearing: OBLIQUE_BEARING };
  const reduced = prefersReducedMotion();
  let raf = 0;
  let orbiting = false;

  const stopOrbit = () => {
    orbiting = false;
    cancelAnimationFrame(raf);
  };
  const interactions = ["mousedown", "touchstart", "wheel"] as const;
  const startOrbit = () => {
    if (reduced || orbiting) return;
    orbiting = true;
    let last = performance.now();
    const tick = (now: number) => {
      if (!orbiting) return;
      const dt = Math.min(MAX_DT_S, (now - last) / 1000);
      last = now;
      if (ctx.orbit?.()) map.setBearing(map.getBearing() + ORBIT_DEG_PER_S * dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  for (const type of interactions) map.on(type, stopOrbit);

  if (reduced) {
    map.jumpTo(camera);
  } else {
    map.once("moveend", startOrbit);
    map.flyTo({ ...camera, duration: OBLIQUE_FLY_MS, essential: false });
  }
  return () => {
    stopOrbit();
    map.off("moveend", startOrbit);
    for (const type of interactions) map.off(type, stopOrbit);
    map.stop();
  };
}

interface FrameView {
  index: number;
  /** road index -> [vehicles, mean speed kph] */
  stats: Map<number, [number, number]>;
  closed: Set<number>;
}

function frameView(ctx: PerspectiveContext, index: number): FrameView {
  const { graph, model } = ctx;
  const stats = new Map<number, [number, number]>();
  const closed = new Set<number>();
  const frame = index >= 0 ? model.traffic?.frames[index] : undefined;
  for (const [ti, veh, speed] of frame?.edges ?? []) {
    const ri = graph.trafficToRoad[ti];
    if (ri !== undefined && ri >= 0) stats.set(ri, [veh, speed]);
  }
  for (const ti of closedEdgesAt(model.traffic?.closures ?? [], index)) {
    const ri = graph.trafficToRoad[ti];
    if (ri !== undefined && ri >= 0) closed.add(ri);
  }
  return { index, stats, closed };
}

/** Road index of the edge holding the most modelled vehicles; falls back to the longest edge. */
export function busiestRoad(ctx: PerspectiveContext): number | null {
  const view = frameView(ctx, ctx.frameIndex());
  let best: number | null = null;
  let bestVeh = 0;
  for (const [ri, [veh]] of view.stats) {
    if (veh > bestVeh && !view.closed.has(ri)) {
      bestVeh = veh;
      best = ri;
    }
  }
  if (best !== null) return best;
  let longest = 0;
  ctx.graph.lines.forEach((line, ri) => {
    const len = polylineLength(line);
    if (len > longest) {
      longest = len;
      best = ri;
    }
  });
  return best;
}

function startGround(map: MapLibreMap, ctx: PerspectiveContext): () => void {
  const { graph } = ctx;
  const picked = ctx.edgeId ? graph.byId.get(ctx.edgeId) : undefined;
  const start = picked ?? busiestRoad(ctx);
  if (start === null || start === undefined) {
    ctx.onGroundHud?.(null);
    return () => {};
  }
  let road = start;
  let dist = 0;
  let bearing: number | null = null;
  let elevation: number | null = null;
  let view = frameView(ctx, ctx.frameIndex());
  let last = performance.now();
  let lastHud = 0;
  let raf = 0;

  const tick = (now: number) => {
    const dt = Math.min(MAX_DT_S, Math.max(0, now - last) / 1000);
    last = now;
    const fi = ctx.frameIndex();
    if (fi !== view.index) view = frameView(ctx, fi);

    const edge = graph.edges[road];
    const stat = view.stats.get(road);
    const closed = view.closed.has(road);
    const speedKph = stat ? stat[1] : closed ? 0 : edge.speedKph;
    dist += (Math.max(0, speedKph) / 3.6) * dt;
    let line = graph.lines[road];
    let guard = 0;
    while (dist >= polylineLength(line) && guard < 8) {
      guard += 1;
      dist -= polylineLength(line);
      // Dead end (e.g. a destination exit): start the drive again from the first edge.
      road = nextEdge(graph, road, view.closed) ?? start;
      line = graph.lines[road];
    }

    const pos = pointAlong(line, dist);
    const ahead = pointAlong(line, dist + GROUND_LOOKAHEAD_M);
    const lineEnd = line.coords.length - 1;
    const target =
      ahead[0] === pos[0] && ahead[1] === pos[1]
        ? bearingDeg(line.coords[Math.max(0, lineEnd - 1)], line.coords[lineEnd])
        : bearingDeg(pos, ahead);
    bearing =
      bearing === null ? target : bearing + angleDiff(bearing, target) * (1 - Math.exp(-dt * BEARING_SMOOTH_PER_S));

    const ground = map.queryTerrainElevation(pos);
    if (ground !== null) {
      elevation =
        elevation === null ? ground : elevation + (ground - elevation) * (1 - Math.exp(-dt * ELEVATION_SMOOTH_PER_S));
    }
    try {
      if (elevation !== null) {
        map.jumpTo(
          map.calculateCameraOptionsFromCameraLngLatAltRotation(pos, elevation + GROUND_EYE_HEIGHT_M, bearing, GROUND_PITCH),
        );
      } else {
        map.jumpTo({ center: pos, zoom: GROUND_FALLBACK_ZOOM, pitch: GROUND_PITCH, bearing });
      }
    } catch {
      map.jumpTo({ center: pos, zoom: GROUND_FALLBACK_ZOOM, pitch: GROUND_PITCH, bearing });
    }

    if (ctx.onGroundHud && now - lastHud >= HUD_INTERVAL_MS) {
      lastHud = now;
      const fire = activeFire(ctx);
      ctx.onGroundHud({
        roadName: graph.edges[road].name ?? graph.edges[road].highway ?? graph.edges[road].id,
        speedKph,
        speedSource: stat ? "modelled" : "free-flow",
        vehicles: stat ? stat[0] : 0,
        closed,
        fireDistanceM: fire ? distanceToAreaM(pos, fire.geometry) : null,
        fireSource: fire?.source ?? null,
      });
    }
    raf = requestAnimationFrame(tick);
  };
  map.stop();
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
