import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { LEVEL_COLOR, MAP_COLOR } from "../live/CommandMap";
import { fireHatch, loadStyle } from "../live/mapStyle";
import { labelPoint } from "../live/format";
import type { CommandZone, Destination, LonLat } from "../live/types";
import { fireRing, teamPosition, type Board, type ZoneForecast } from "./model";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";

export type Selection = { kind: "fire" | "zone" | "team"; id: string };

interface Props {
  zones: CommandZone[];
  destinations: Destination[];
  /** Mutated in place by the page; `version` increments whenever it changed. */
  board: Board | null;
  version: number;
  forecasts: Map<string, ZoneForecast>;
  selected: Selection | null;
  igniteMode: boolean;
  onSelect: (sel: Selection | null) => void;
  onIgnite: (coord: LonLat) => void;
}

/** MapLibre paint cannot read CSS variables; these mirror the greys and inks of the --ct-* tokens. */
const DEMO_COLOR = {
  scar: "#6B7280",
  scarEdge: "#4B5563",
  ink: MAP_COLOR.ink,
  halo: "#FFFFFF",
  overrun: "#B3140C",
  overrunText: "#7A0A05",
  readyText: "#7A4B00",
};

const FIT_PADDING = 56;
const FOCUS_ZOOM = 12.5;

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
  geometry: { type: "Polygon", coordinates: [ring] },
  properties,
});

type ZoneMapState = "overrun" | "ordered" | "threatened" | "quiet";

function zoneMapState(zone: Board["zones"][number], forecast: ZoneForecast | undefined): ZoneMapState {
  if (zone.overrunAt !== null) return "overrun";
  if (zone.orderedAt !== null) return "ordered";
  if (forecast && forecast.edgeEta !== null) return "threatened";
  return "quiet";
}

function zoneTag(state: ZoneMapState, forecast: ZoneForecast | undefined): string {
  if (state === "overrun") return "OVERRUN";
  if (state === "ordered") return "LEAVE NOW";
  if (state === "threatened") {
    const eta = forecast?.edgeEta ?? 0;
    return eta <= 0 ? "AT RISK · now" : `AT RISK · ${Math.round(eta)} min`;
  }
  return "";
}

function buildZones(zones: CommandZone[], board: Board, forecasts: Map<string, ZoneForecast>) {
  const states = new Map(board.zones.map((z) => [z.id, z]));
  const areas: Feature[] = [];
  const labels: Feature[] = [];
  const routes: Feature[] = [];
  for (const zone of zones) {
    const zs = states.get(zone.id);
    if (!zs) continue;
    const forecast = forecasts.get(zone.id);
    const state = zoneMapState(zs, forecast);
    areas.push({ type: "Feature", geometry: zone.geometry, properties: { id: zone.id, state } });
    const anchor = labelPoint(zone.geometry);
    const tag = zoneTag(state, forecast);
    if (anchor && tag) labels.push(point(anchor, { text: tag, state }));
    if (zs.orderedAt !== null && zs.route && zs.route.line.length > 1) routes.push(lineFeature(zs.route.line, { zone_id: zone.id }));
  }
  return { areas, labels, routes };
}

function buildFires(board: Board) {
  const rings: Feature[] = [];
  const labels: Feature[] = [];
  for (const fire of board.fires) {
    rings.push(polygon(fireRing(fire), { id: fire.id, status: fire.status }));
    labels.push(point(fire.origin, { id: fire.id, text: fire.status === "burning" ? fire.id : `${fire.id} · ${fire.status}`, status: fire.status }));
  }
  return { rings, labels };
}

function buildTeams(board: Board) {
  const teams: Feature[] = [];
  const lines: Feature[] = [];
  for (const team of board.teams) {
    const pos = teamPosition(board, team);
    teams.push(point(pos, { id: team.id, status: team.status }));
    // En route: the road line when known (whole route), else the straight line to its target.
    if (team.status === "en_route" && team.target) {
      lines.push(lineFeature(team.route && team.route.length > 1 ? team.route : [pos, team.target], { id: team.id }));
    }
  }
  return { teams, lines };
}

function buildStations(board: Board): Feature[] {
  return board.stations.map((s) => point(s.location, { name: s.name }));
}

function buildDestinations(destinations: Destination[]): Feature[] {
  return destinations.filter((d) => d.kind !== "exit").map((d) => point(d.coord, { kind: d.kind, name: d.name }));
}

/** Highlight of the selected fire, zone or team, plus where the camera should go for it. */
function buildSelection(
  sel: Selection | null,
  board: Board,
  zones: CommandZone[],
): { areas: Feature[]; points: Feature[] } {
  const none = { areas: [], points: [] };
  if (!sel) return none;
  if (sel.kind === "fire") {
    const fire = board.fires.find((f) => f.id === sel.id);
    return fire ? { areas: [polygon(fireRing(fire), { id: fire.id })], points: [point(fire.origin, { id: fire.id })] } : none;
  }
  if (sel.kind === "zone") {
    const zone = zones.find((z) => z.id === sel.id);
    return zone ? { areas: [{ type: "Feature", geometry: zone.geometry, properties: { id: zone.id } }], points: [] } : none;
  }
  const team = board.teams.find((t) => t.id === sel.id);
  return team ? { areas: [], points: [point(teamPosition(board, team), { id: team.id })] } : none;
}

function selectionCenter(sel: Selection, board: Board, zones: CommandZone[]): LonLat | null {
  if (sel.kind === "fire") return board.fires.find((f) => f.id === sel.id)?.origin ?? null;
  if (sel.kind === "team") {
    const team = board.teams.find((t) => t.id === sel.id);
    return team ? teamPosition(board, team) : null;
  }
  const zone = zones.find((z) => z.id === sel.id);
  return zone ? labelPoint(zone.geometry) : null;
}

const SOURCES = [
  "dm-zones", "dm-zone-labels", "dm-routes", "dm-fires", "dm-fire-labels", "dm-team-lines", "dm-teams",
  "dm-stations", "dm-dest", "dm-sel-area", "dm-sel-point",
];

const STATE_MATCH = (values: Record<ZoneMapState, string | number>) =>
  ["match", ["get", "state"], "overrun", values.overrun, "ordered", values.ordered, "threatened", values.threatened, values.quiet];
const STATUS_MATCH = (burning: string | number, contained: string | number, out: string | number) =>
  ["match", ["get", "status"], "burning", burning, "contained", contained, out];

const FONT = ["Noto Sans Regular"];
const INTERACTIVE = ["dm-teams", "dm-fire-fill", "dm-fire-labels", "dm-zones-fill"];

function installLayers(map: MapLibreMap): void {
  const empty = collection([]);
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  map.addImage("dm-fire-hatch", fireHatch(MAP_COLOR.fireEdge));

  const zoneColor = { overrun: DEMO_COLOR.overrun, ordered: LEVEL_COLOR.evacuate_now, threatened: LEVEL_COLOR.be_ready, quiet: LEVEL_COLOR.none };
  map.addLayer({
    id: "dm-zones-fill",
    type: "fill",
    source: "dm-zones",
    paint: {
      "fill-color": STATE_MATCH(zoneColor) as never,
      "fill-opacity": STATE_MATCH({ overrun: 0.22, ordered: 0.12, threatened: 0.1, quiet: 0.02 }) as never,
    },
  });
  map.addLayer({
    id: "dm-zones-line",
    type: "line",
    source: "dm-zones",
    paint: {
      "line-color": STATE_MATCH(zoneColor) as never,
      "line-width": STATE_MATCH({ overrun: 3, ordered: 2.5, threatened: 2, quiet: 0.6 }) as never,
      "line-opacity": STATE_MATCH({ overrun: 1, ordered: 0.9, threatened: 0.9, quiet: 0.5 }) as never,
    },
  });
  map.addLayer({
    id: "dm-sel-area",
    type: "line",
    source: "dm-sel-area",
    layout: { "line-join": "round" },
    paint: { "line-color": MAP_COLOR.selection, "line-width": 4.5 },
  });
  map.addLayer({
    id: "dm-routes",
    type: "line",
    source: "dm-routes",
    layout: { "line-join": "round" },
    paint: { "line-color": MAP_COLOR.route, "line-width": 2, "line-opacity": 0.75, "line-dasharray": [2, 1.5] },
  });
  // Fires: burning is hatched with a solid edge, contained is lighter with a dashed edge, out is a grey scar.
  map.addLayer({
    id: "dm-fire-fill",
    type: "fill",
    source: "dm-fires",
    paint: {
      "fill-color": STATUS_MATCH(MAP_COLOR.fire, MAP_COLOR.fire, DEMO_COLOR.scar) as never,
      "fill-opacity": STATUS_MATCH(0.35, 0.18, 0.25) as never,
    },
  });
  map.addLayer({
    id: "dm-fire-hatch",
    type: "fill",
    source: "dm-fires",
    filter: ["==", ["get", "status"], "burning"],
    paint: { "fill-pattern": "dm-fire-hatch", "fill-opacity": 0.6 },
  });
  map.addLayer({
    id: "dm-fire-line",
    type: "line",
    source: "dm-fires",
    filter: ["!=", ["get", "status"], "out"],
    paint: {
      "line-color": MAP_COLOR.fireEdge,
      "line-width": 2.5,
      "line-dasharray": ["case", ["==", ["get", "status"], "contained"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
    },
  });
  map.addLayer({
    id: "dm-fire-scar",
    type: "line",
    source: "dm-fires",
    filter: ["==", ["get", "status"], "out"],
    paint: { "line-color": DEMO_COLOR.scarEdge, "line-width": 1 },
  });
  map.addLayer({
    id: "dm-team-lines",
    type: "line",
    source: "dm-team-lines",
    paint: { "line-color": MAP_COLOR.responder, "line-width": 1.5, "line-dasharray": [1.5, 1.5] },
  });
  map.addLayer({
    id: "dm-stations",
    type: "circle",
    source: "dm-stations",
    paint: { "circle-radius": 5, "circle-color": "#FFFFFF", "circle-stroke-color": DEMO_COLOR.ink, "circle-stroke-width": 3 },
  });
  map.addLayer({
    id: "dm-station-labels",
    type: "symbol",
    source: "dm-stations",
    minzoom: 11,
    layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": DEMO_COLOR.ink, "text-halo-color": DEMO_COLOR.halo, "text-halo-width": 1.4 },
  });
  map.addLayer({
    id: "dm-dest",
    type: "circle",
    source: "dm-dest",
    paint: { "circle-radius": 4.5, "circle-color": "#FFFFFF", "circle-stroke-color": MAP_COLOR.shelter, "circle-stroke-width": 2 },
  });
  map.addLayer({
    id: "dm-dest-labels",
    type: "symbol",
    source: "dm-dest",
    minzoom: 12.5,
    layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": MAP_COLOR.shelter, "text-halo-color": DEMO_COLOR.halo, "text-halo-width": 1.4 },
  });
  map.addLayer({
    id: "dm-sel-point",
    type: "circle",
    source: "dm-sel-point",
    paint: {
      "circle-radius": 17,
      "circle-color": "rgba(61,155,255,0.18)",
      "circle-stroke-color": MAP_COLOR.selection,
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "dm-teams",
    type: "circle",
    source: "dm-teams",
    paint: {
      "circle-radius": 6,
      "circle-color": MAP_COLOR.responder,
      "circle-stroke-color": "#FFFFFF",
      "circle-stroke-width": ["match", ["get", "status"], "en_route", 1, 2] as never,
      "circle-opacity": ["match", ["get", "status"], "en_route", 0.75, 1] as never,
    },
  });
  map.addLayer({
    id: "dm-team-labels",
    type: "symbol",
    source: "dm-teams",
    layout: { "text-field": ["get", "id"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1], "text-anchor": "bottom", "text-allow-overlap": true },
    paint: { "text-color": MAP_COLOR.responder, "text-halo-color": DEMO_COLOR.halo, "text-halo-width": 1.6 },
  });
  map.addLayer({
    id: "dm-zone-labels",
    type: "symbol",
    source: "dm-zone-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04 },
    paint: {
      "text-color": ["match", ["get", "state"], "overrun", DEMO_COLOR.overrunText, "ordered", DEMO_COLOR.overrun, DEMO_COLOR.readyText] as never,
      "text-halo-color": DEMO_COLOR.halo,
      "text-halo-width": 1.6,
    },
  });
  map.addLayer({
    id: "dm-fire-labels",
    type: "symbol",
    source: "dm-fire-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04, "text-allow-overlap": true },
    paint: {
      "text-color": STATUS_MATCH(MAP_COLOR.fireEdge, MAP_COLOR.fireEdge, DEMO_COLOR.scarEdge) as never,
      "text-halo-color": DEMO_COLOR.halo,
      "text-halo-width": 1.8,
    },
  });
}

export default function DemoMap({
  zones, destinations, board, version, forecasts, selected, igniteMode, onSelect, onIgnite,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const live = useRef({ board, zones, igniteMode, onSelect, onIgnite });

  useEffect(() => {
    live.current = { board, zones, igniteMode, onSelect, onIgnite };
  }, [board, zones, igniteMode, onSelect, onIgnite]);

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
      map.on("click", (e: MapMouseEvent) => {
        if (!map) return;
        const cur = live.current;
        if (cur.igniteMode) {
          cur.onIgnite([e.lngLat.lng, e.lngLat.lat]);
          return;
        }
        const layers = INTERACTIVE.filter((l) => map?.getLayer(l));
        const hit = map.queryRenderedFeatures(e.point, { layers });
        // Layer order of INTERACTIVE is the priority: team, then fire, then zone.
        for (const layer of INTERACTIVE) {
          const f = hit.find((h) => h.layer.id === layer);
          const id = f?.properties.id;
          if (typeof id !== "string") continue;
          cur.onSelect({ kind: layer === "dm-teams" ? "team" : layer === "dm-zones-fill" ? "zone" : "fire", id });
          return;
        }
        cur.onSelect(null);
      });
      for (const layer of INTERACTIVE) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    });
    return () => {
      controller.abort();
      map?.remove();
      mapRef.current = null;
      fitted.current = false;
      setReady(false);
    };
  }, []);

  // Crosshair in ignite mode; a class toggle, since React must not rewrite the classes MapLibre sets.
  useEffect(() => {
    container.current?.classList.toggle("dm-map--ignite", igniteMode);
  }, [igniteMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !board) return;
    const z = buildZones(zones, board, forecasts);
    const f = buildFires(board);
    const t = buildTeams(board);
    const sel = buildSelection(selected, board, zones);
    const data: Record<string, Feature[]> = {
      "dm-zones": z.areas,
      "dm-zone-labels": z.labels,
      "dm-routes": z.routes,
      "dm-fires": f.rings,
      "dm-fire-labels": f.labels,
      "dm-team-lines": t.lines,
      "dm-teams": t.teams,
      "dm-stations": buildStations(board),
      "dm-dest": buildDestinations(destinations),
      "dm-sel-area": sel.areas,
      "dm-sel-point": sel.points,
    };
    for (const [id, features] of Object.entries(data)) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(collection(features));
    }
    if (!fitted.current && zones.length) {
      const bounds = new LngLatBounds();
      for (const zone of zones) {
        const polys = zone.geometry.type === "Polygon" ? [zone.geometry.coordinates] : zone.geometry.coordinates;
        for (const poly of polys) for (const [lon, lat] of poly[0] ?? []) bounds.extend([lon, lat]);
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: FIT_PADDING, duration: 0 });
      fitted.current = true;
    }
    // `board` is mutated in place; `version` is what signals a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, version, forecasts, selected, zones, destinations]);

  // Move the camera only when the selection changes, not on each board update.
  const selKey = selected ? `${selected.kind}:${selected.id}` : null;
  useEffect(() => {
    const map = mapRef.current;
    const cur = live.current;
    if (!ready || !map || !cur.board || !selected) return;
    const center = selectionCenter(selected, cur.board, cur.zones);
    if (center) map.easeTo({ center, zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ease on a new selection only
  }, [ready, selKey]);

  return <div ref={container} className="dm-map" role="region" aria-label="Fire board map" />;
}
