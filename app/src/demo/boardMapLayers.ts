import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { LEVEL_COLOR, MAP_COLOR } from "../live/CommandMap";
import { fireHatch } from "../live/mapStyle";
import type { ScenarioSnapshot, SnapshotStation } from "../live/scenarioSnapshot";
import type { LonLat } from "../live/types";
import { shortStationName } from "./format";
import { boardFireFeatures, firePolygons } from "./fireFootprint";
import {
  activeRoute,
  attackPositions,
  lineBuiltExtent,
  positionEta,
  evacueeMarkers,
  routeDelayFactor,
  teamPosition,
  trafficPicture,
  type Board,
  type RouteOption,
  type ZoneForecast,
} from "./model";

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
  /** The drill's resource snapshot (live/scenarioSnapshot.ts); station labels show its engine counts. */
  snapshot?: ScenarioSnapshot | null;
}

export interface BoardLayers {
  update(input: BoardLayerInput): void;
  /**
   * True when a click at this event should be handled by the board and not by the live map:
   * a board feature (team, fire, non-quiet zone) is under the pointer.
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
  /** Fire line (control line) built or planned ahead of a fire. */
  fireLine: "#3B2A1A",
  /** Evacuation traffic (simulated): route delay bands and the evacuee vehicle markers. */
  trafficSlow: "#C26A00",
  trafficJam: "#B3140C",
  evacuee: "#1F6FEB",
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

/** Fire footprints at board.minute: the simulator solver's burned cells, contoured (fireFootprint.ts). */
function fireFeatures(board: Board): Feature[] {
  return boardFireFeatures(board).features.map((f) => ({ ...f, properties: { ...f.properties } }));
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

/** Route delay bands (route time / free-flow time under the board's simulated traffic). */
export const TRAFFIC_SLOW_FACTOR = 1.25;
export const TRAFFIC_JAM_FACTOR = 2;

/** Line properties of a route in use: delay band, label and width by the zone's vehicles on the road. */
function trafficProps(board: Board, r: RouteOption, onRoad: number): Feature["properties"] {
  const delay = routeDelayFactor(board, r);
  const load = delay >= TRAFFIC_JAM_FACTOR ? "jammed" : delay >= TRAFFIC_SLOW_FACTOR ? "slow" : "free";
  return {
    load,
    width: 2 + Math.min(5, onRoad / 150),
    label: load === "free" ? "" : `${load === "jammed" ? "Jammed" : "Slow"} x${delay.toFixed(1)} (sim)`,
  };
}

/**
 * Options of the selected zone (chosen one emphasised); every other zone with households leaving
 * (ordered or on the fire cue) shows its route. Routes in use are coloured and labelled by their
 * simulated delay and thickened by the zone's vehicles on the road.
 */
function buildRoutes(board: Board, routes: ReadonlyMap<string, RouteOption[]>, selection: BoardSelection | null) {
  const picture = trafficPicture(board);
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
        const inUse = r.destination_id === activeRoute(zs)?.destination_id;
        const traffic = trafficProps(board, r, inUse ? (picture.zones.get(zs.id)?.onRoad ?? 0) : 0);
        lines.push(lineFeature(r.line, { zone_id: zs.id, chosen: r.destination_id === chosen, ...traffic, width: r.destination_id === chosen ? Math.max(3, Number(traffic.width)) : 1.8 }));
        addDest(r);
      }
    } else {
      const r = activeRoute(zs);
      if (r && r.line.length > 1 && (zs.orderedAt !== null || (picture.zones.get(zs.id)?.committed ?? 0) > 0)) {
        lines.push(lineFeature(r.line, { zone_id: zs.id, chosen: false, ...trafficProps(board, r, picture.zones.get(zs.id)?.onRoad ?? 0) }));
        addDest(r);
      }
    }
  }
  return { lines, dests: [...dests.values()] };
}

/** Units within this distance share a spot and fan out, metres. */
const SPOT_M = 15;
/** Radius of the ring co-located units are drawn on, metres (a visible gap at city zoom 15 to 16). */
const FAN_RADIUS_M = 30;
const M_PER_DEG_LAT = 111_320;

function metresBetween(a: LonLat, b: LonLat): number {
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  const dx = (b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * Where each unit is drawn. Units at (nearly) the same point, such as engines parked at one
 * station, are spread on a ring of FAN_RADIUS_M around it, in unit-id order starting from north, so
 * each stays visible and clickable. Deterministic; a lone unit stays at its true position.
 */
/** An available unit standing at its home station: drawn as part of the station's marker, not as its own dot. */
function isParked(board: Board, team: Board["teams"][number]): boolean {
  if (team.status !== "available") return false;
  const home = board.stations.find((s) => s.id === team.station);
  return !!home && metresBetween(team.position, home.location) < PARKED_M;
}

export function fanOutTeams(board: Board): Map<string, LonLat> {
  const spots: { at: LonLat; members: { id: string; pos: LonLat }[] }[] = [];
  for (const team of board.teams) {
    if (isParked(board, team)) continue;
    const pos = teamPosition(board, team);
    const spot = spots.find((s) => metresBetween(s.at, pos) < SPOT_M);
    if (spot) spot.members.push({ id: team.id, pos });
    else spots.push({ at: pos, members: [{ id: team.id, pos }] });
  }
  const out = new Map<string, LonLat>();
  for (const spot of spots) {
    const members = [...spot.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = members.length;
    members.forEach((m, i) => {
      if (n === 1) return void out.set(m.id, m.pos);
      const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const dLat = (Math.sin(angle) * -FAN_RADIUS_M) / M_PER_DEG_LAT;
      const dLon = (Math.cos(angle) * FAN_RADIUS_M) / (M_PER_DEG_LAT * Math.cos((spot.at[1] * Math.PI) / 180));
      out.set(m.id, [spot.at[0] + dLon, spot.at[1] + dLat]);
    });
  }
  return out;
}

function buildTeams(board: Board, fanned: Map<string, LonLat>) {
  const teams: Feature[] = [];
  const lines: Feature[] = [];
  for (const team of board.teams) {
    // Units parked at their station are counted on the station marker instead (buildStations).
    if (isParked(board, team)) continue;
    const pos = fanned.get(team.id) ?? teamPosition(board, team);
    teams.push(point(pos, { id: team.id, status: team.status }));
    // Only road lines are drawn: a unit waiting for its road route stays where it is, with no line.
    // Returning units (driving back to their station) draw their road home dotted.
    if ((team.status === "en_route" || team.status === "returning") && team.route && team.route.length > 1) {
      lines.push(lineFeature(team.route, { id: team.id, status: team.status }));
    }
  }
  return { teams, lines };
}

/** The snapshot station at a board station's place (within 100 m), if any. */
function snapshotStationAt(snapshot: ScenarioSnapshot | null | undefined, at: LonLat): SnapshotStation | null {
  let best: SnapshotStation | null = null;
  let bestM = 100;
  for (const s of snapshot?.stations ?? []) {
    const m = metresBetween(at, s.location);
    if (m < bestM) {
      best = s;
      bestM = m;
    }
  }
  return best;
}

/**
 * Station labels: "BFD 5 · 2/3" (engines available at the drill's start / total, from the snapshot;
 * synthetic engines), then the units drawn at the station. Without a snapshot match only the name.
 */
function buildStations(board: Board, snapshot: ScenarioSnapshot | null | undefined) {
  return board.stations.map((s) => {
    const snap = snapshotStationAt(snapshot, s.location);
    const name = shortStationName(s.name);
    const parked = board.teams
      .filter((t) => t.station === s.id && isParked(board, t))
      .map((t) => t.id)
      .sort();
    const head = snap ? `${name} · ${snap.engines_available}/${snap.engines_total}` : name;
    // One marker per station: the number of units parked there; clicking it selects the first of them.
    return point(s.location, {
      name: head,
      text: parked.length ? `${head}\n${parked.join(" ")}` : head,
      count: parked.length,
      label: parked.length ? String(parked.length) : "",
      ...(parked.length ? { id: parked[0] } : {}),
    });
  });
}

/** A point `f` of the way from `p` to `q` (straight, a few hundred metres at most). */
function toward(p: LonLat, q: LonLat, f: number): LonLat {
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
}

/**
 * Fire line at attack positions (model.AttackLine): the planned line dashed, the part built so
 * far solid. For the selected fire, also its candidate positions (attack.ts), thin dashed with a label.
 */
function buildAttackLines(board: Board, selection: BoardSelection | null) {
  const lines: Feature[] = [];
  const points: Feature[] = [];
  for (const line of board.lines) {
    const { point: p, a, b, aM, bM, id } = line.plan;
    lines.push(lineFeature([a, p, b], { state: "planned" }));
    const ext = lineBuiltExtent(line);
    if (line.builtM > 0) lines.push(lineFeature([toward(p, a, aM > 0 ? ext.a / aM : 0), p, toward(p, b, bM > 0 ? ext.b / bM : 0)], { state: "built" }));
    if (line.completedAt === null) points.push(point(p, { text: `${line.fireId} ${id}`, state: "line" }));
  }
  const fire = selection?.kind === "fire" ? board.fires.find((f) => f.id === selection.id) : undefined;
  if (fire) {
    for (const pos of attackPositions(board, fire)) {
      if (pos.line) continue;
      lines.push(lineFeature([pos.a, pos.point, pos.b], { state: "candidate" }));
      const eta = positionEta(board, pos);
      points.push(point(pos.point, { text: `${pos.id}${eta === null ? "" : ` · fire ${Math.round(eta)} min`} (forecast)`, state: "candidate" }));
    }
  }
  return { lines, points };
}

function buildSelection(sel: BoardSelection | null, board: Board, fanned: Map<string, LonLat>): { areas: Feature[]; points: Feature[] } {
  const none = { areas: [], points: [] };
  if (!sel) return none;
  if (sel.kind === "fire") {
    const fire = board.fires.find((f) => f.id === sel.id);
    if (!fire) return none;
    const areas = firePolygons(board, fire).map((p) => ({ ...p, properties: { id: fire.id } }) as Feature);
    return { areas, points: [point(fire.origin, { id: fire.id })] };
  }
  if (sel.kind === "zone") {
    const zone = board.zones.find((z) => z.id === sel.id);
    return zone ? { areas: [polygon(zone.ring, { id: zone.id })], points: [] } : none;
  }
  const team = board.teams.find((t) => t.id === sel.id);
  return team ? { areas: [], points: [point(fanned.get(team.id) ?? teamPosition(board, team), { id: team.id })] } : none;
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
  "bd-stations", "bd-dest", "bd-sel-area", "bd-sel-point", "bd-evac", "bd-attack-lines", "bd-attack-points",
];
const HATCH_IMAGE = "bd-fire-hatch";
/** Fire station marker, the red of the 3D firehouses. */
const STATION_RED = "#C62828";
/** A unit within this distance of its home station, and available, counts as parked there. */
const PARKED_M = 100;
const CHECK_IMAGE = "bd-fire-check";
/** Contained / out badge colour (a green check on a white ring), mirrors --ct-success. */
const CHECK_COLOR = "#1F7A4A";

/** A round green badge with a white check mark, drawn once (map glyph fonts may lack U+2713). */
function checkBadge(): ImageData {
  const size = 28;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = CHECK_COLOR;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 3.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(size * 0.29, size * 0.52);
  ctx.lineTo(size * 0.44, size * 0.67);
  ctx.lineTo(size * 0.72, size * 0.36);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}
const FONT = ["Noto Sans Regular"];
const FOCUS_ZOOM = 12.5;
/** Click priority: team, then fire, then zone. */
const INTERACTIVE = ["bd-teams", "bd-stations", "bd-fire-fill", "bd-fire-labels", "bd-zones-fill"];
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
  if (!map.hasImage(CHECK_IMAGE)) map.addImage(CHECK_IMAGE, checkBadge(), { pixelRatio: 2 });
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
  // Evacuation routes: colour and label by simulated delay band, width by the zone's vehicles on the road.
  add({ id: "bd-routes", type: "line", source: "bd-routes", layout: { "line-join": "round" }, paint: {
    "line-color": ["match", ["get", "load"], "jammed", BOARD_COLOR.trafficJam, "slow", BOARD_COLOR.trafficSlow, MAP_COLOR.route] as never,
    "line-width": ["coalesce", ["get", "width"], 1.8] as never,
    "line-opacity": ["case", ["get", "chosen"], 0.9, 0.7] as never,
    "line-dasharray": [2, 1.5],
  } });
  add({ id: "bd-route-labels", type: "symbol", source: "bd-routes", filter: ["!=", ["coalesce", ["get", "label"], ""], ""], minzoom: 11,
    layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-optional": true },
    paint: { "text-color": ["match", ["get", "load"], "jammed", BOARD_COLOR.trafficJam, BOARD_COLOR.trafficSlow] as never, "text-halo-color": BOARD_COLOR.halo, "text-halo-width": 1.6 } });
  // Evacuating vehicles (simulated), sampled: one dot per few vehicles, on the route's road line.
  add({ id: "bd-evac", type: "circle", source: "bd-evac", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 14, 4] as never,
    "circle-color": BOARD_COLOR.evacuee,
    "circle-stroke-color": "#FFFFFF",
    "circle-stroke-width": 1,
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
  // Fire line ahead of fires: built solid, planned dashed, a selected fire's candidates thin dashed.
  add({ id: "bd-attack-lines", type: "line", source: "bd-attack-lines", layout: { "line-cap": "round" }, paint: {
    "line-color": BOARD_COLOR.fireLine,
    "line-width": ["match", ["get", "state"], "built", 4, "planned", 2.5, 1.6] as never,
    "line-opacity": ["match", ["get", "state"], "candidate", 0.7, 1] as never,
    "line-dasharray": ["match", ["get", "state"], "built", ["literal", [1, 0]], ["literal", [2, 1.5]]] as never,
  } });
  add({ id: "bd-attack-points", type: "symbol", source: "bd-attack-points", minzoom: 12,
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true },
    paint: text(BOARD_COLOR.fireLine, 1.6) });
  add({ id: "bd-team-lines", type: "line", source: "bd-team-lines", paint: {
    "line-color": MAP_COLOR.responder,
    "line-width": 1.5,
    "line-opacity": ["match", ["get", "status"], "returning", 0.6, 1] as never,
    "line-dasharray": ["match", ["get", "status"], "returning", ["literal", [0.5, 2]], ["literal", [1.5, 1.5]]] as never,
  } });
  // A station is one marker: red with the number of units parked there, or a small ring when none are.
  add({ id: "bd-stations", type: "circle", source: "bd-stations", paint: {
    "circle-radius": ["case", [">", ["get", "count"], 0], 9, 5] as never,
    "circle-color": ["case", [">", ["get", "count"], 0], STATION_RED, "#FFFFFF"] as never,
    "circle-stroke-color": ["case", [">", ["get", "count"], 0], "#FFFFFF", STATION_RED] as never,
    "circle-stroke-width": 2.5,
  } });
  add({ id: "bd-station-count", type: "symbol", source: "bd-stations", filter: [">", ["get", "count"], 0],
    layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#FFFFFF" } });
  add({ id: "bd-station-labels", type: "symbol", source: "bd-stations", minzoom: 11,
    // Hidden: the station marks speak for themselves; unit and station ids are in the panels.
    layout: { visibility: "none", "text-field": ["get", "text"], "text-font": FONT, "text-size": 11, "text-offset": [0, 2.2], "text-anchor": "top", "text-optional": true },
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
    "circle-stroke-width": ["match", ["get", "status"], ["en_route", "returning"], 1, 2] as never,
    "circle-opacity": ["match", ["get", "status"], "en_route", 0.75, "returning", 0.55, 1] as never,
  } });
  add({ id: "bd-team-labels", type: "symbol", source: "bd-teams",
    layout: { visibility: "none", "text-field": ["get", "id"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1], "text-anchor": "bottom", "text-allow-overlap": true },
    paint: text(MAP_COLOR.responder, 1.6) });
  add({ id: "bd-zone-labels", type: "symbol", source: "bd-zone-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04 },
    paint: text(["match", ["get", "state"], "overrun", BOARD_COLOR.overrunText, "ordered", BOARD_COLOR.overrun, BOARD_COLOR.readyText], 1.6) });
  add({ id: "bd-fire-labels", type: "symbol", source: "bd-fire-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04, "text-allow-overlap": true },
    paint: text(STATUS_MATCH(MAP_COLOR.fireEdge, MAP_COLOR.fireEdge, BOARD_COLOR.scarEdge), 1.8) });
  // Contained or out: a green check badge above the fire's label.
  add({ id: "bd-fire-check", type: "symbol", source: "bd-fire-labels", filter: ["!=", ["get", "status"], "burning"],
    layout: { "icon-image": CHECK_IMAGE, "icon-anchor": "bottom", "icon-offset": [0, -16], "icon-allow-overlap": true } });
  return layers;
}

export function attachBoardLayers(
  map: MapLibreMap,
  beforeId: string,
  handlers: { onSelect(sel: BoardSelection | null): void },
): BoardLayers {
  const layerIds = installLayers(map, beforeId);
  let board: Board | null = null;
  let lastSelKey: string | null = null;
  let disposed = false;

  const hitBoard = (e: MapMouseEvent): BoardSelection | null => {
    const layers = INTERACTIVE.filter((l) => map.getLayer(l));
    const hit = map.queryRenderedFeatures(e.point, { layers });
    for (const layer of INTERACTIVE) {
      const id = hit.find((h) => h.layer.id === layer)?.properties?.id;
      if (typeof id !== "string") continue;
      return { kind: layer === "bd-teams" || layer === "bd-stations" ? "team" : layer === "bd-zones-fill" ? "zone" : "fire", id };
    }
    return null;
  };

  const onClick = (e: MapMouseEvent) => {
    const sel = hitBoard(e);
    if (sel) {
      handlers.onSelect(sel);
      return;
    }
    const live = LIVE_HIT_LAYERS.filter((l) => map.getLayer(l));
    if (!map.queryRenderedFeatures(e.point, { layers: live }).length) handlers.onSelect(null);
  };
  const pointer = () => { map.getCanvas().style.cursor = "pointer"; };
  const reset = () => { map.getCanvas().style.cursor = ""; };
  map.on("click", onClick);
  for (const layer of INTERACTIVE) {
    map.on("mouseenter", layer, pointer);
    map.on("mouseleave", layer, reset);
  }

  const setData = (id: string, features: Feature[]) =>
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(collection(features));

  return {
    claimsClick(e) {
      return !disposed && hitBoard(e) !== null;
    },
    update(input) {
      if (disposed) return;
      board = input.board;
      if (!board) {
        // Between boards: do not leave the previous drill's marks on the map.
        for (const id of SOURCES) setData(id, []);
        lastSelKey = null;
        return;
      }
      const z = buildZones(board, input.forecasts);
      const r = buildRoutes(board, input.routes, input.selection);
      const fanned = fanOutTeams(board);
      const t = buildTeams(board, fanned);
      const sel = buildSelection(input.selection, board, fanned);
      setData("bd-zones", z.areas);
      setData("bd-zone-labels", z.labels);
      setData("bd-routes", r.lines);
      setData("bd-evac", evacueeMarkers(board).map((m) => point(m.at, { zone_id: m.zoneId, vehicles: m.vehicles })));
      setData("bd-fires", fireFeatures(board));
      setData("bd-fire-labels", buildFireLabels(board));
      setData("bd-team-lines", t.lines);
      const al = buildAttackLines(board, input.selection);
      setData("bd-attack-lines", al.lines);
      setData("bd-attack-points", al.points);
      setData("bd-teams", t.teams);
      setData("bd-stations", buildStations(board, input.snapshot));
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
      if (map.hasImage(CHECK_IMAGE)) map.removeImage(CHECK_IMAGE);
    },
  };
}
