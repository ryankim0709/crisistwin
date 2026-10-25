import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { LEVEL_COLOR, MAP_COLOR } from "../live/CommandMap";
import { fireHatch } from "../live/mapStyle";
import type { LonLat } from "../live/types";
import { boardFireFeatures, firePolygons } from "./fireFootprint";
import { teamPosition, type Board, type RouteOption, type ZoneForecast } from "./model";

/**
 * The simulated fire board drawn on top of the live command map (a framework-free port of
 * DemoMap's layers). Everything here is simulation output; the legend labels it so.
 * Sources, layers and the image use the `bd-` prefix. Add via `CommandMap`'s `onMapReady`.
 */

export type BoardSelection = { kind: "fire" | "zone" | "team"; id: string };

export interface BoardLayerInput {
  board: Board | null;
  forecasts: Map<string, ZoneForecast>;
  routes: ReadonlyMap<string, RouteOption[]>;
  selection: BoardSelection | null;
  igniteMode: boolean;
}

export interface BoardLayers {
  update(input: BoardLayerInput): void;
  /**
   * True when a click at this event should be handled by the board and not by the live map:
   * ignite mode is on, or a board feature (team, fire, non-quiet zone) is under the pointer.
   * Pass as CommandMap's `interceptClick`.
   */
  claimsClick(e: MapMouseEvent): boolean;
  dispose(): void;
}

/** MapLibre paint cannot read CSS variables; these mirror the --ct-* greys and inks. Also used by the legend. */
export const BOARD_COLOR = {
  scar: "#6B7280",
  scarEdge: "#4B5563",
  halo: "#FFFFFF",
  overrun: "#B3140C",
  overrunText: "#7A0A05",
  readyText: "#7A4B00",
};

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
const polygon = (ring: LonLat[], properties: Feature["properties"]): Feature => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [closed(ring)] },
  properties,
});
function closed(ring: LonLat[]): LonLat[] {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a && b && (a[0] !== b[0] || a[1] !== b[1]) ? [...ring, a] : ring;
}

type ZoneMapState = "overrun" | "ordered" | "threatened" | "quiet";

function zoneMapState(zone: Board["zones"][number], forecast: ZoneForecast | undefined): ZoneMapState {
  if (zone.overrunAt !== null) return "overrun";
  if (zone.orderedAt !== null) return "ordered";
  if (forecast && forecast.edgeEta !== null) return "threatened";
  return "quiet";
}

function zoneTag(state: ZoneMapState, forecast: ZoneForecast | undefined): string {
  if (state === "overrun") return "OVERRUN (sim)";
  if (state === "ordered") return "LEAVE NOW (sim)";
  if (state === "threatened") {
    const eta = forecast?.edgeEta ?? 0;
    return eta <= 0 ? "AT RISK (sim) · now" : `AT RISK (sim) · ${Math.round(eta)} min`;
  }
  return "";
}

/** Fire footprints at board.minute (the solver's burned cells, fireFootprint.ts). */
function fireFeatures(board: Board): Feature[] {
  return boardFireFeatures(board).features.map((f): Feature => ({ ...f, properties: { ...f.properties } }));
}

function buildFireLabels(board: Board): Feature[] {
  return board.fires.map((fire) =>
    point(fire.origin, { id: fire.id, text: fire.status === "burning" ? fire.id : `${fire.id} · ${fire.status}`, status: fire.status }),
  );
}

function buildZones(board: Board, forecasts: Map<string, ZoneForecast>) {
  const areas: Feature[] = [];
  const labels: Feature[] = [];
  for (const zs of board.zones) {
    const state = zoneMapState(zs, forecasts.get(zs.id));
    if (state === "quiet") continue; // quiet zones draw nothing
    areas.push(polygon(zs.ring, { id: zs.id, state }));
    const tag = zoneTag(state, forecasts.get(zs.id));
    if (tag) labels.push(point(zs.core, { text: tag, state }));
  }
  return { areas, labels };
}

/** Options of the selected zone (chosen one emphasised); other ordered zones show their chosen route thin. */
function buildRoutes(board: Board, routes: ReadonlyMap<string, RouteOption[]>, selection: BoardSelection | null) {
  const lines: Feature[] = [];
  const dests = new Map<string, Feature>();
  const addDest = (r: RouteOption) => {
    const end = r.line[r.line.length - 1];
    if (end && r.kind !== "exit" && !dests.has(r.destination_id)) dests.set(r.destination_id, point(end, { kind: r.kind, name: r.name }));
  };
  const selectedId = selection?.kind === "zone" ? selection.id : null;
  for (const zs of board.zones) {
    const chosen = zs.route?.destination_id ?? null;
    if (zs.id === selectedId) {
      const options = routes.get(zs.id) ?? (zs.route ? [zs.route] : []);
      for (const r of options) {
        if (r.line.length < 2) continue;
        lines.push(lineFeature(r.line, { zone_id: zs.id, chosen: r.destination_id === chosen }));
        addDest(r);
      }
    } else if (zs.orderedAt !== null && zs.route && zs.route.line.length > 1) {
      lines.push(lineFeature(zs.route.line, { zone_id: zs.id, chosen: false }));
      addDest(zs.route);
    }
  }
  return { lines, dests: [...dests.values()] };
}

function buildTeams(board: Board) {
  const teams: Feature[] = [];
  const lines: Feature[] = [];
  for (const team of board.teams) {
    const pos = teamPosition(board, team);
    teams.push(point(pos, { id: team.id, status: team.status }));
    if (team.status === "en_route" && team.target) {
      lines.push(lineFeature(team.route && team.route.length > 1 ? team.route : [pos, team.target], { id: team.id }));
    }
  }
  return { teams, lines };
}

function buildSelection(sel: BoardSelection | null, board: Board): { areas: Feature[]; points: Feature[] } {
  const none = { areas: [], points: [] };
  if (!sel) return none;
  if (sel.kind === "fire") {
    const fire = board.fires.find((f) => f.id === sel.id);
    return fire
      ? {
          areas: firePolygons(board, fire).map((p): Feature => ({ type: "Feature", geometry: p.geometry, properties: { id: fire.id } })),
          points: [point(fire.origin, { id: fire.id })],
        }
      : none;
  }
  if (sel.kind === "zone") {
    const zone = board.zones.find((z) => z.id === sel.id);
    return zone ? { areas: [polygon(zone.ring, { id: zone.id })], points: [] } : none;
  }
  const team = board.teams.find((t) => t.id === sel.id);
  return team ? { areas: [], points: [point(teamPosition(board, team), { id: team.id })] } : none;
}

function selectionCenter(sel: BoardSelection, board: Board): LonLat | null {
  if (sel.kind === "fire") return board.fires.find((f) => f.id === sel.id)?.origin ?? null;
  if (sel.kind === "team") {
    const team = board.teams.find((t) => t.id === sel.id);
    return team ? teamPosition(board, team) : null;
  }
  return board.zones.find((z) => z.id === sel.id)?.core ?? null;
}

const SOURCES = [
  "bd-zones", "bd-zone-labels", "bd-routes", "bd-fires", "bd-fire-labels", "bd-team-lines", "bd-teams",
  "bd-stations", "bd-dest", "bd-sel-area", "bd-sel-point",
];
const HATCH_IMAGE = "bd-fire-hatch";
const FONT = ["Noto Sans Regular"];
const FOCUS_ZOOM = 12.5;
/** Click priority: team, then fire, then zone. */
const INTERACTIVE = ["bd-teams", "bd-fire-fill", "bd-fire-labels", "bd-zones-fill"];
/** Live point layers: a click that hits one of these is not an "empty map" click. */
const LIVE_HIT_LAYERS = ["lc-ground", "lc-points", "lc-help", "lc-responders", "lc-queues", "lc-dest"];

const STATE_MATCH = (values: Record<ZoneMapState, string | number>) =>
  ["match", ["get", "state"], "overrun", values.overrun, "ordered", values.ordered, "threatened", values.threatened, values.quiet] as never;
const STATUS_MATCH = (burning: string | number, contained: string | number, out: string | number) =>
  ["match", ["get", "status"], "burning", burning, "contained", contained, out] as never;

function installLayers(map: MapLibreMap, beforeId: string): string[] {
  const empty = collection([]);
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  map.addImage(HATCH_IMAGE, fireHatch(MAP_COLOR.fireEdge));
  const layers: string[] = [];
  const add = (layer: Parameters<MapLibreMap["addLayer"]>[0] & { id: string }) => {
    map.addLayer(layer, beforeId);
    layers.push(layer.id);
  };
  const text = (color: unknown, halo: number) => ({
    "text-color": color as never,
    "text-halo-color": BOARD_COLOR.halo,
    "text-halo-width": halo,
  });

  const zoneColor = { overrun: BOARD_COLOR.overrun, ordered: LEVEL_COLOR.evacuate_now, threatened: LEVEL_COLOR.be_ready, quiet: LEVEL_COLOR.none };
  add({ id: "bd-zones-fill", type: "fill", source: "bd-zones", paint: {
    "fill-color": STATE_MATCH(zoneColor),
    "fill-opacity": STATE_MATCH({ overrun: 0.22, ordered: 0.12, threatened: 0.1, quiet: 0 }),
  } });
  add({ id: "bd-zones-line", type: "line", source: "bd-zones", paint: {
    "line-color": STATE_MATCH(zoneColor),
    "line-width": STATE_MATCH({ overrun: 3, ordered: 2.5, threatened: 2, quiet: 0.6 }),
    "line-opacity": 0.95,
  } });
  add({ id: "bd-sel-area", type: "line", source: "bd-sel-area", layout: { "line-join": "round" }, paint: { "line-color": MAP_COLOR.selection, "line-width": 4.5 } });
  add({ id: "bd-routes", type: "line", source: "bd-routes", layout: { "line-join": "round" }, paint: {
    "line-color": MAP_COLOR.route,
    "line-width": ["case", ["get", "chosen"], 3, 1.8] as never,
    "line-opacity": ["case", ["get", "chosen"], 0.85, 0.55] as never,
    "line-dasharray": [2, 1.5],
  } });
  // Fires: burning is hatched with a solid edge, contained is lighter with a dashed edge, out is a grey scar.
  add({ id: "bd-fire-fill", type: "fill", source: "bd-fires", paint: {
    "fill-color": STATUS_MATCH(MAP_COLOR.fire, MAP_COLOR.fire, BOARD_COLOR.scar),
    "fill-opacity": STATUS_MATCH(0.35, 0.18, 0.25),
  } });
  add({ id: "bd-fire-hatch", type: "fill", source: "bd-fires", filter: ["==", ["get", "status"], "burning"], paint: { "fill-pattern": HATCH_IMAGE, "fill-opacity": 0.6 } });
  add({ id: "bd-fire-line", type: "line", source: "bd-fires", filter: ["!=", ["get", "status"], "out"], paint: {
    "line-color": MAP_COLOR.fireEdge,
    "line-width": 2.5,
    "line-dasharray": ["case", ["==", ["get", "status"], "contained"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
  } });
  add({ id: "bd-fire-scar", type: "line", source: "bd-fires", filter: ["==", ["get", "status"], "out"], paint: { "line-color": BOARD_COLOR.scarEdge, "line-width": 1 } });
  add({ id: "bd-team-lines", type: "line", source: "bd-team-lines", paint: { "line-color": MAP_COLOR.responder, "line-width": 1.5, "line-dasharray": [1.5, 1.5] } });
  add({ id: "bd-stations", type: "circle", source: "bd-stations", paint: { "circle-radius": 5, "circle-color": "#FFFFFF", "circle-stroke-color": MAP_COLOR.ink, "circle-stroke-width": 3 } });
  add({ id: "bd-station-labels", type: "symbol", source: "bd-stations", minzoom: 11,
    layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: text(MAP_COLOR.ink, 1.4) });
  add({ id: "bd-dest", type: "circle", source: "bd-dest", paint: { "circle-radius": 4.5, "circle-color": "#FFFFFF", "circle-stroke-color": MAP_COLOR.shelter, "circle-stroke-width": 2 } });
  add({ id: "bd-dest-labels", type: "symbol", source: "bd-dest", minzoom: 12.5,
    layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: text(MAP_COLOR.shelter, 1.4) });
  add({ id: "bd-sel-point", type: "circle", source: "bd-sel-point", paint: {
    "circle-radius": 17,
    "circle-color": "rgba(61,155,255,0.18)",
    "circle-stroke-color": MAP_COLOR.selection,
    "circle-stroke-width": 2.5,
  } });
  add({ id: "bd-teams", type: "circle", source: "bd-teams", paint: {
    "circle-radius": 6,
    "circle-color": MAP_COLOR.responder,
    "circle-stroke-color": "#FFFFFF",
    "circle-stroke-width": ["match", ["get", "status"], "en_route", 1, 2] as never,
    "circle-opacity": ["match", ["get", "status"], "en_route", 0.75, 1] as never,
  } });
  add({ id: "bd-team-labels", type: "symbol", source: "bd-teams",
    layout: { "text-field": ["get", "id"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1], "text-anchor": "bottom", "text-allow-overlap": true },
    paint: text(MAP_COLOR.responder, 1.6) });
  add({ id: "bd-zone-labels", type: "symbol", source: "bd-zone-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04 },
    paint: text(["match", ["get", "state"], "overrun", BOARD_COLOR.overrunText, "ordered", BOARD_COLOR.overrun, BOARD_COLOR.readyText], 1.6) });
  add({ id: "bd-fire-labels", type: "symbol", source: "bd-fire-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04, "text-allow-overlap": true },
    paint: text(STATUS_MATCH(MAP_COLOR.fireEdge, MAP_COLOR.fireEdge, BOARD_COLOR.scarEdge), 1.8) });
  return layers;
}

export function attachBoardLayers(
  map: MapLibreMap,
  beforeId: string,
  handlers: { onSelect(sel: BoardSelection | null): void; onIgnite(coord: LonLat): void },
): BoardLayers {
  const layerIds = installLayers(map, beforeId);
  let igniteMode = false;
  let board: Board | null = null;
  let lastSelKey: string | null = null;
  let disposed = false;

  const hitBoard = (e: MapMouseEvent): BoardSelection | null => {
    const layers = INTERACTIVE.filter((l) => map.getLayer(l));
    const hit = map.queryRenderedFeatures(e.point, { layers });
    for (const layer of INTERACTIVE) {
      const id = hit.find((h) => h.layer.id === layer)?.properties?.id;
      if (typeof id !== "string") continue;
      return { kind: layer === "bd-teams" ? "team" : layer === "bd-zones-fill" ? "zone" : "fire", id };
    }
    return null;
  };

  const onClick = (e: MapMouseEvent) => {
    if (igniteMode) {
      handlers.onIgnite([e.lngLat.lng, e.lngLat.lat]);
      return;
    }
    const sel = hitBoard(e);
    if (sel) {
      handlers.onSelect(sel);
      return;
    }
    const live = LIVE_HIT_LAYERS.filter((l) => map.getLayer(l));
    if (!map.queryRenderedFeatures(e.point, { layers: live }).length) handlers.onSelect(null);
  };
  const pointer = () => { map.getCanvas().style.cursor = "pointer"; };
  const reset = () => { map.getCanvas().style.cursor = igniteMode ? "crosshair" : ""; };
  map.on("click", onClick);
  for (const layer of INTERACTIVE) {
    map.on("mouseenter", layer, pointer);
    map.on("mouseleave", layer, reset);
  }

  const setData = (id: string, features: Feature[]) =>
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(collection(features));

  return {
    claimsClick(e) {
      return !disposed && (igniteMode || hitBoard(e) !== null);
    },
    update(input) {
      if (disposed) return;
      igniteMode = input.igniteMode;
      map.getCanvas().style.cursor = igniteMode ? "crosshair" : "";
      board = input.board;
      if (!board) {
        // Between boards: do not leave the previous drill's marks on the map.
        for (const id of SOURCES) setData(id, []);
        lastSelKey = null;
        return;
      }
      const z = buildZones(board, input.forecasts);
      const r = buildRoutes(board, input.routes, input.selection);
      const t = buildTeams(board);
      const sel = buildSelection(input.selection, board);
      setData("bd-zones", z.areas);
      setData("bd-zone-labels", z.labels);
      setData("bd-routes", r.lines);
      setData("bd-fires", fireFeatures(board));
      setData("bd-fire-labels", buildFireLabels(board));
      setData("bd-team-lines", t.lines);
      setData("bd-teams", t.teams);
      setData("bd-stations", board.stations.map((s) => point(s.location, { name: s.name })));
      setData("bd-dest", r.dests);
      setData("bd-sel-area", sel.areas);
      setData("bd-sel-point", sel.points);
      // Move the camera only when the selection changes, not on each board update.
      const key = input.selection ? `${input.selection.kind}:${input.selection.id}` : null;
      if (key !== lastSelKey && input.selection) {
        const center = selectionCenter(input.selection, board);
        if (center) map.easeTo({ center, zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
      }
      lastSelKey = key;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      map.off("click", onClick);
      for (const layer of INTERACTIVE) {
        map.off("mouseenter", layer, pointer);
        map.off("mouseleave", layer, reset);
      }
      if (!map.getStyle()) return;
      for (const id of [...layerIds].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of SOURCES) if (map.getSource(id)) map.removeSource(id);
      if (map.hasImage(HATCH_IMAGE)) map.removeImage(HATCH_IMAGE);
    },
  };
}
