import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { LEVEL_COLOR, MAP_COLOR } from "../live/CommandMap";
import { fireHatch } from "../live/mapStyle";
import type { LonLat } from "../live/types";
import { GROUND_APPARATUS, vehicleFamily } from "../studio/apparatus";
import { CREW_COLORS, firelineCss } from "../studio/firelinePalette";
import type { AccessClassWire, RoadAccessResponse } from "./contracts";
import { fireMapLabel, isReported } from "./boardResponse";
import { boardFireFeatures, firePolygons } from "./fireFootprint";
import { crewWork, fireStatePolygons, type CrewWork } from "./fireState";
import { simClock } from "./format";
import { zoneSafeShare } from "./safeHouses";
import { allClearLabelShown } from "./allClear";
import { BoardMotion, teamSubjects } from "./unitMotion";
import {
  activeRoute,
  attackPositions,
  distanceM,
  evacueeMarkers,
  lineBuiltExtent,
  positionEta,
  teamPosition,
  trafficPicture,
  zoneCounts,
  zoneOrderStatus,
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
  /**
   * Drill roads closed by the road access rules (GET /api/demo/road_access). Drawn dashed for the
   * selected unit's class, or, with `showClosedRoads`, for every class on the board.
   */
  closedRoads?: RoadAccessResponse["closed_roads"] | null;
  showClosedRoads?: boolean;
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
  /** A zone whose evacuation order was lifted (all clear, demo/allClear.ts): neutral, thin, no fill. */
  allClear: "#5B6470",
  /** Fire line (control line) built or planned ahead of a fire: the map's ink, drawn thin. */
  fireLine: MAP_COLOR.ink,
  /** Evacuating vehicles (simulated): small dots in the route colour, on their road route. */
  evacuee: MAP_COLOR.route,
  /** Road closed to a unit's apparatus class (dashed); unused by fire, zones, routes and units. */
  noTruck: "#8B1E3F",
  /** Ground put out by crews (fireState "extinguished"): blue-grey fill, dashed slate outline. */
  extinguished: "#7D8C99",
  extinguishedEdge: "#3E5568",
  /** Firefighters at work: dot outline (their fill is the unit family's colour). */
  crewEdge: "#FFFFFF",
};

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, string | number | boolean | null>>;
const collection = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const point = (coord: LonLat, properties: Feature["properties"]): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coord },
  properties,
});
/**
 * Every facility that fields a unit (response/fleet.ts buildFleet): stations on the board, mutual
 * aid outside it and air bases in range, labelled "Paradise FS · CAL FIRE · 2 engines, 1 dozer",
 * so what is on the map is what can respond. Stations a unit was sent from later stay drawn.
 */
function stationFeatures(board: Board): Feature[] {
  const seen = new Set<string>();
  const out: Feature[] = [];
  for (const f of board.response.facilities) {
    seen.add(f.id);
    out.push(point(f.location, { name: f.name, tier: f.tier, label: f.tier === "mutual_aid" ? `${f.label} · mutual aid` : f.label }));
  }
  for (const s of board.stations) {
    if (!seen.has(s.id)) out.push(point(s.location, { name: s.name, tier: "closest", label: s.label ?? s.name }));
  }
  return out;
}
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

type ZoneMapState = "overrun" | "ordered" | "threatened" | "lifted" | "quiet";

function zoneMapState(zone: Board["zones"][number], forecast: ZoneForecast | undefined, minute: number): ZoneMapState {
  // All clear (demo/allClear.ts): no "Leave now" sign; a neutral label for ALL_CLEAR_LABEL_MINUTES,
  // then nothing, unless a fire is forecast to reach it again (edge ETA > 0; a contained fire's
  // burned ground at its edge reads 0).
  if (zoneOrderStatus(zone, minute) === "lifted") {
    if (forecast && forecast.edgeEta !== null && forecast.edgeEta > 0) return "threatened";
    return allClearLabelShown(zone, minute) ? "lifted" : "quiet";
  }
  if (zone.overrunAt !== null) return "overrun";
  if (zone.orderedAt !== null) return "ordered";
  // A scheduled order is drawn like a threatened zone; its tag says when it leaves.
  if ((forecast && forecast.edgeEta !== null) || zone.pendingOrder) return "threatened";
  return "quiet";
}

function zoneTag(state: ZoneMapState, forecast: ZoneForecast | undefined, zone: Board["zones"][number], minute: number): string {
  if (state === "lifted") {
    const c = zoneCounts(zone, minute);
    const away = c.returning + c.enRoute;
    return `ALL CLEAR (sim) · ${zone.id}${away > 0 ? ` · ${away} returning` : ""}`;
  }
  if (state === "overrun") return "OVERRUN (sim)";
  if (state === "ordered") return "LEAVE NOW (sim)";
  if (state === "threatened" && zone.pendingOrder) {
    const eta = forecast?.edgeEta ?? null;
    return `LEAVES ${simClock(zone.pendingOrder.startMinute)} (sim)${eta === null ? "" : eta <= 0 ? " · fire now" : ` · fire ${Math.round(eta)} min`}`;
  }
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

/**
 * One label per fire at its origin. A fire not yet reported to dispatch (boardResponse.ts report
 * rule) is still drawn for the drill controller, labelled "not yet reported (sim)" in text (not by
 * colour alone) and dimmed; its zones show no threat (the forecasts are the commander's, "reported").
 */
function buildFireLabels(board: Board): Feature[] {
  return board.fires.map((fire) =>
    point(fire.origin, { id: fire.id, text: fireMapLabel(board, fire), status: fire.status, reported: isReported(board, fire) }),
  );
}

function buildZones(board: Board, forecasts: Map<string, ZoneForecast>) {
  const areas: Feature[] = [];
  const labels: Feature[] = [];
  for (const zs of board.zones) {
    const state = zoneMapState(zs, forecasts.get(zs.id), board.minute);
    if (state === "quiet") continue; // quiet zones draw nothing
    areas.push(polygon(zs.ring, { id: zs.id, state }));
    let tag = zoneTag(state, forecasts.get(zs.id), zs, board.minute);
    // Households that reached safety (zoneCounts out), as on the 3D view's green-roofed houses.
    const safe = Math.floor(zoneSafeShare(zs, board.minute) * 100);
    if (tag && safe > 0 && state !== "lifted") tag += ` · ${safe}% safe`;
    if (tag) labels.push(point(zs.core, { text: tag, state }));
  }
  return { areas, labels };
}

/** Burning, burned-out and put-out ground at board.minute (fireState.ts), one feature per state. */
function fireStateFeatures(board: Board): Feature[] {
  const polygons = fireStatePolygons(board);
  return (["burned_out", "extinguished", "burning"] as const).flatMap((state): Feature[] =>
    polygons[state]?.coordinates.length ? [{ type: "Feature", geometry: polygons[state], properties: { state } }] : [],
  );
}

/** Point `s` metres along `path` (clamped to its ends), and the path's lengths so far. */
function alongPath(path: readonly LonLat[], cum: readonly number[], s: number): LonLat {
  if (path.length === 1 || s <= 0) return path[0];
  for (let k = 1; k < path.length; k++) {
    if (cum[k] >= s) {
      const f = (s - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]);
      return toward(path[k - 1], path[k], f);
    }
  }
  return path[path.length - 1];
}

/** Firefighters at work: dots per crew, CREW_DOT_SPACING_M apart behind its worked point. */
const CREW_DOTS = 3;
const CREW_DOT_SPACING_M = 20;
const CREW_TRAIL_M = 70;
/** How far dots step in toward the fire over the work, metres (drawn, not modelled). */
const CREW_INWARD_M = 25;

/**
 * Crews at work (fireState.crewWork): a few small dots in the unit family's colour at the worked
 * point of each crew's path, stepped in toward the fire as the work progresses, and a short trail
 * of the path just worked. They move as the board advances.
 */
function buildCrews(board: Board): { dots: Feature[]; trails: Feature[] } {
  const dots: Feature[] = [];
  const trails: Feature[] = [];
  const work: CrewWork[] = crewWork(board);
  for (const w of work) {
    const path = w.path as LonLat[];
    if (path.length === 0) continue;
    const cum = [0];
    for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + distanceM(path[k - 1], path[k]));
    const s = Math.min(1, Math.max(0, w.progress)) * cum[cum.length - 1];
    const team = board.teams.find((t) => t.id === w.teamId);
    const color = firelineCss(CREW_COLORS[team ? vehicleFamily(team.kind) : "hand_crew"]);
    const len = Math.hypot(w.inward[0], w.inward[1]);
    const step = CREW_INWARD_M * (0.25 + 0.75 * Math.min(1, Math.max(0, w.progress))) * (w.kind === "line" ? 0.4 : 1);
    for (let k = 0; k < CREW_DOTS; k++) {
      const at = alongPath(path, cum, s - k * CREW_DOT_SPACING_M);
      const lat = (at[1] * Math.PI) / 180;
      const p: LonLat =
        len > 0
          ? [at[0] + ((w.inward[0] / len) * step) / (111_320 * Math.cos(lat)), at[1] + ((w.inward[1] / len) * step) / 111_320]
          : at;
      dots.push(point(p, { team: w.teamId, fire: w.fireId, kind: w.kind, color, lead: k === 0 }));
    }
    const trail: LonLat[] = [];
    const from = Math.max(0, s - CREW_TRAIL_M);
    trail.push(alongPath(path, cum, from));
    for (let k = 1; k < path.length; k++) if (cum[k] > from && cum[k] < s) trail.push(path[k]);
    trail.push(alongPath(path, cum, s));
    if (trail.length > 1 && s > 0) trails.push(lineFeature(trail, { color }));
  }
  return { dots, trails };
}

/**
 * Options of the selected zone (chosen one emphasised); every other zone with households leaving
 * (an order in effect) shows the route they leave on thin, so the evacuating vehicles
 * (bd-evac) always sit on a drawn route.
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
    const chosen = zs.route?.destination_id ?? zs.pendingOrder?.route.destination_id ?? null;
    if (zs.id === selectedId) {
      const options = routes.get(zs.id) ?? (zs.route ? [zs.route] : []);
      for (const r of options) {
        if (r.line.length < 2) continue;
        lines.push(lineFeature(r.line, { zone_id: zs.id, chosen: r.destination_id === chosen }));
        addDest(r);
      }
    } else {
      const r = activeRoute(zs);
      const leaving = zs.orderedAt !== null || (picture.zones.get(zs.id)?.committed ?? 0) > 0;
      if (r && r.line.length > 1 && leaving) {
        lines.push(lineFeature(r.line, { zone_id: zs.id, chosen: false }));
        addDest(r);
      }
    }
  }
  return { lines, dests: [...dests.values()] };
}

/** Driving on a road line: to a fire, home to its station, or to cover another station. */
const DRIVING: ReadonlySet<Board["teams"][number]["status"]> = new Set(["en_route", "returning", "moving_up"]);

/** Road lines of driving units (the unit dots themselves are drawn per frame from BoardMotion). */
function buildTeamLines(board: Board) {
  const lines: Feature[] = [];
  for (const team of board.teams) {
    // Units follow roads: only a known road route is drawn, never a straight line to the target.
    // A unit still waiting for its road route draws no line.
    if (DRIVING.has(team.status) && team.route && team.route.length > 1) {
      lines.push(lineFeature(team.route, { id: team.id, status: team.status }));
    }
  }
  return lines;
}

/** Spacing of units fanned out at one spot (unitMotion slot units), screen px. */
const SPOT_SPACING_PX = 15;
/** Metres per screen pixel at `zoom` and latitude (MapLibre's 512 px tiles). */
const metresPerPixel = (zoom: number, lat: number) => (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

/**
 * Unit dots at their smoothed positions (unitMotion.ts): units at one spot fanned out by
 * a few pixels, labelled once at the group's lead with every id; a driving unit labelled with its id.
 */
/** Statuses of a unit idle at a station (the station marker stands for it on the map). */
const IDLE_AT_STATION = new Set(["available", "resting", "refilling", "out_of_service"]);
/** A unit this close to its home station counts as there (metres). */
const AT_STATION_M = 150;

function buildTeamPoints(board: Board, motion: BoardMotion, zoom: number): Feature[] {
  const teams: Feature[] = [];
  // Units idle at their own station are not drawn: the station marker shows where they are.
  const hidden = new Set(
    board.teams
      .filter((t) => {
        const d = motion.get(t.id);
        return d && IDLE_AT_STATION.has(t.status) && distanceM(d.at, t.home) <= AT_STATION_M;
      })
      .map((t) => t.id),
  );
  for (const team of board.teams) {
    const d = motion.get(team.id);
    if (!d || hidden.has(team.id)) continue;
    let at = d.at;
    if (d.offset[0] !== 0 || d.offset[1] !== 0) {
      const m = metresPerPixel(zoom, at[1]) * SPOT_SPACING_PX;
      const lat = (at[1] * Math.PI) / 180;
      at = [at[0] + (d.offset[0] * m) / (111_320 * Math.cos(lat)), at[1] + (d.offset[1] * m) / 111_320];
    }
    // A group's label sits on its first visible member and lists the visible ids only.
    const shown = d.group ? d.group.ids.filter((id) => !hidden.has(id)) : [];
    const label = !d.group ? team.id : shown[0] === team.id ? shown.join(" ") : "";
    teams.push(point(at, { id: team.id, status: team.status, label }));
  }
  return teams;
}

/** A point `f` of the way from `p` to `q` (straight, a few hundred metres at most). */
function toward(p: LonLat, q: LonLat, f: number): LonLat {
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
}

/**
 * Fire line at attack positions (model.AttackLine): the planned line dashed, the part built so
 * far solid. For the selected fire, also its candidate positions (attack.ts), faint, with a label.
 */
function buildAttackLines(board: Board, selection: BoardSelection | null) {
  const lines: Feature[] = [];
  const points: Feature[] = [];
  for (const line of board.lines) {
    const { point: p, a, b, aM, bM, id } = line.plan;
    lines.push(lineFeature([a, p, b], { state: "planned" }));
    const ext = lineBuiltExtent(line);
    if (line.builtM > 0) lines.push(lineFeature([toward(p, a, aM > 0 ? ext.a / aM : 0), p, toward(p, b, bM > 0 ? ext.b / bM : 0)], { state: "built" }));
    if (line.completedAt === null) points.push(point(p, { text: `${line.fireId} ${id}` }));
  }
  const fire = selection?.kind === "fire" ? board.fires.find((f) => f.id === selection.id) : undefined;
  // Candidate attack positions only for a reported fire (report rule: none can be taken before).
  if (fire && isReported(board, fire)) {
    for (const pos of attackPositions(board, fire)) {
      if (pos.line) continue;
      lines.push(lineFeature([pos.a, pos.point, pos.b], { state: "candidate" }));
      const eta = positionEta(board, pos);
      points.push(point(pos.point, { text: `${pos.id}${eta === null ? "" : ` · fire ${Math.round(eta)} min`} (forecast)` }));
    }
  }
  return { lines, points };
}

/** Roads closed to the selected unit's class, or (toggle) to any class on the board. */
function buildClosedRoads(board: Board, input: BoardLayerInput): Feature[] {
  const roads = input.closedRoads;
  if (!roads) return [];
  const team = input.selection?.kind === "team" ? board.teams.find((t) => t.id === input.selection?.id) : undefined;
  const classOf = (kind: keyof typeof GROUND_APPARATUS) => GROUND_APPARATUS[kind].access as AccessClassWire;
  let classes: AccessClassWire[];
  if (team) classes = [classOf(team.kind)];
  else if (input.showClosedRoads) classes = [...new Set(board.teams.map((t) => classOf(t.kind)))];
  else return [];
  const out: Feature[] = [];
  for (const f of roads.features) {
    const rule = classes.map((c) => f.properties.closed[c]).find(Boolean);
    if (rule) out.push(lineFeature(f.geometry.coordinates as LonLat[], { rule, reason: f.properties.reason }));
  }
  return out;
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
  "bd-stations", "bd-dest", "bd-sel-area", "bd-sel-point", "bd-no-truck", "bd-evac", "bd-attack-lines", "bd-attack-points",
  "bd-fire-state", "bd-crews", "bd-crew-trails",
];
/** Dark hatch on burned-out ground (fire states). */
const SCAR_HATCH_IMAGE = "bd-scar-hatch";
const FIRE_STATE_MATCH = (burning: string | number, burnedOut: string | number, extinguished: string | number) =>
  ["match", ["get", "state"], "burning", burning, "burned_out", burnedOut, extinguished] as never;
const FONT = ["Noto Sans Regular"];
const FOCUS_ZOOM = 12.5;
/** Click priority: team, then fire, then zone. */
const INTERACTIVE = ["bd-teams", "bd-fire-fill", "bd-fire-labels", "bd-zones-fill"];
/** Live point layers: a click that hits one of these is not an "empty map" click. */
const LIVE_HIT_LAYERS = ["lc-ground", "lc-points", "lc-help", "lc-responders", "lc-queues", "lc-dest"];

const STATE_MATCH = (values: Record<ZoneMapState, string | number>) =>
  ["match", ["get", "state"], "overrun", values.overrun, "ordered", values.ordered, "threatened", values.threatened, "lifted", values.lifted, values.quiet] as never;
const STATUS_MATCH = (burning: string | number, contained: string | number, out: string | number) =>
  ["match", ["get", "status"], "burning", burning, "contained", contained, out] as never;

function installLayers(map: MapLibreMap, beforeId: string): string[] {
  const empty = collection([]);
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: empty });
  map.addImage(SCAR_HATCH_IMAGE, fireHatch(BOARD_COLOR.scarEdge));
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

  const zoneColor = { overrun: BOARD_COLOR.overrun, ordered: LEVEL_COLOR.evacuate_now, threatened: LEVEL_COLOR.be_ready, lifted: BOARD_COLOR.allClear, quiet: LEVEL_COLOR.none };
  add({ id: "bd-zones-fill", type: "fill", source: "bd-zones", paint: {
    "fill-color": STATE_MATCH(zoneColor),
    "fill-opacity": STATE_MATCH({ overrun: 0.22, ordered: 0.12, threatened: 0.1, lifted: 0, quiet: 0 }),
  } });
  add({ id: "bd-zones-line", type: "line", source: "bd-zones", paint: {
    "line-color": STATE_MATCH(zoneColor),
    "line-width": STATE_MATCH({ overrun: 3, ordered: 2.5, threatened: 2, lifted: 1, quiet: 0.6 }),
    "line-opacity": 0.95,
  } });
  add({ id: "bd-no-truck-casing", type: "line", source: "bd-no-truck", layout: { "line-cap": "round" }, paint: {
    "line-color": BOARD_COLOR.halo, "line-width": 5, "line-opacity": 0.8,
  } });
  add({ id: "bd-no-truck", type: "line", source: "bd-no-truck", paint: {
    "line-color": BOARD_COLOR.noTruck, "line-width": 2.5, "line-dasharray": [1, 1.2],
  } });
  add({ id: "bd-sel-area", type: "line", source: "bd-sel-area", layout: { "line-join": "round" }, paint: { "line-color": MAP_COLOR.selection, "line-width": 4.5 } });
  add({ id: "bd-routes", type: "line", source: "bd-routes", layout: { "line-join": "round" }, paint: {
    "line-color": MAP_COLOR.route,
    "line-width": ["case", ["get", "chosen"], 3, 1.8] as never,
    "line-opacity": ["case", ["get", "chosen"], 0.85, 0.55] as never,
    "line-dasharray": [2, 1.5],
  } });
  // Evacuating vehicles (simulated), sampled: small dots on their zone's road route.
  add({ id: "bd-evac", type: "circle", source: "bd-evac", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 14, 3] as never,
    "circle-color": BOARD_COLOR.evacuee,
    "circle-opacity": 0.8,
    "circle-stroke-color": "#FFFFFF",
    "circle-stroke-width": 0.8,
  } });
  // Fire states (fireState.ts): what burns now, what burned out, what crews put out. The
  // per-fire footprint stays only for clicks (transparent) and a contained fire's dashed edge.
  add({ id: "bd-fire-fill", type: "fill", source: "bd-fires", paint: { "fill-color": MAP_COLOR.fire, "fill-opacity": 0 } });
  add({ id: "bd-fs-fill", type: "fill", source: "bd-fire-state", paint: {
    "fill-color": FIRE_STATE_MATCH(MAP_COLOR.fire, BOARD_COLOR.scar, BOARD_COLOR.extinguished),
    "fill-opacity": FIRE_STATE_MATCH(0.5, 0.4, 0.4),
  } });
  add({ id: "bd-fs-scar-hatch", type: "fill", source: "bd-fire-state", filter: ["==", ["get", "state"], "burned_out"], paint: { "fill-pattern": SCAR_HATCH_IMAGE, "fill-opacity": 0.75 } });
  add({ id: "bd-fs-scar-line", type: "line", source: "bd-fire-state", filter: ["==", ["get", "state"], "burned_out"], paint: { "line-color": BOARD_COLOR.scarEdge, "line-width": 1 } });
  add({ id: "bd-fs-ext-line", type: "line", source: "bd-fire-state", filter: ["==", ["get", "state"], "extinguished"], paint: {
    "line-color": BOARD_COLOR.extinguishedEdge, "line-width": 2, "line-dasharray": [2, 1.5],
  } });
  // Burning: a soft glow under a thick solid edge, so it reads as active even without colour.
  add({ id: "bd-fs-burn-glow", type: "line", source: "bd-fire-state", filter: ["==", ["get", "state"], "burning"], paint: {
    "line-color": MAP_COLOR.fire, "line-width": 9, "line-blur": 5, "line-opacity": 0.7,
  } });
  add({ id: "bd-fs-burn-line", type: "line", source: "bd-fire-state", filter: ["==", ["get", "state"], "burning"], layout: { "line-join": "round" }, paint: {
    "line-color": MAP_COLOR.fireEdge, "line-width": 3.5,
  } });
  add({ id: "bd-fire-line", type: "line", source: "bd-fires", filter: ["==", ["get", "status"], "contained"], paint: {
    "line-color": MAP_COLOR.fireEdge, "line-width": 1.5, "line-dasharray": [3, 2],
  } });
  // Firefighters at work (fireState.crewWork): a short trail of the path just worked, then small dots.
  add({ id: "bd-crew-trails", type: "line", source: "bd-crew-trails", layout: { "line-cap": "round", "line-join": "round" }, paint: {
    "line-color": ["get", "color"] as never, "line-width": 2.5, "line-opacity": 0.55,
  } });
  add({ id: "bd-crews", type: "circle", source: "bd-crews", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["get", "lead"], 2.6, 2], 15, ["case", ["get", "lead"], 4.2, 3.4]] as never,
    "circle-color": ["get", "color"] as never,
    "circle-stroke-color": BOARD_COLOR.crewEdge,
    "circle-stroke-width": 1,
  } });
  // Fire line ahead of fires, thin in the map's ink: built solid, planned dashed, a selected fire's candidates faint.
  add({ id: "bd-attack-lines", type: "line", source: "bd-attack-lines", layout: { "line-cap": "round" }, paint: {
    "line-color": BOARD_COLOR.fireLine,
    "line-width": ["match", ["get", "state"], "built", 2.5, "planned", 1.5, 1] as never,
    "line-opacity": ["match", ["get", "state"], "built", 0.85, "planned", 0.7, 0.45] as never,
    "line-dasharray": ["match", ["get", "state"], "built", ["literal", [1, 0]], ["literal", [2, 1.5]]] as never,
  } });
  add({ id: "bd-attack-points", type: "symbol", source: "bd-attack-points", minzoom: 13,
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: text(BOARD_COLOR.scarEdge, 1.4) });
  // En route: dashed; returning home or moving up to cover a station: dotted and fainter.
  add({ id: "bd-team-lines", type: "line", source: "bd-team-lines", paint: {
    "line-color": MAP_COLOR.responder,
    "line-width": 1.5,
    "line-opacity": ["match", ["get", "status"], ["returning", "moving_up"], 0.6, 1] as never,
    "line-dasharray": ["match", ["get", "status"], ["returning", "moving_up"], ["literal", [0.5, 2]], ["literal", [1.5, 1.5]]] as never,
  } });
  add({ id: "bd-stations", type: "circle", source: "bd-stations", paint: {
    "circle-radius": 5, "circle-color": "#FFFFFF", "circle-stroke-color": MAP_COLOR.ink, "circle-stroke-width": 3,
    // Mutual aid from outside the area is drawn fainter; its label says so (never colour alone).
    "circle-opacity": ["case", ["==", ["get", "tier"], "mutual_aid"], 0.6, 1],
    "circle-stroke-opacity": ["case", ["==", ["get", "tier"], "mutual_aid"], 0.6, 1],
  } });
  // Station labels say what each station fields and mark mutual aid in text (the fainter marker is not the only cue).
  add({ id: "bd-station-labels", type: "symbol", source: "bd-stations", minzoom: 10,
    layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
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
    // Driving units are lighter (thin stroke, faded); returning and moving-up fainter than en route.
    "circle-stroke-width": ["match", ["get", "status"], ["en_route", "returning", "moving_up"], 1, 2] as never,
    "circle-opacity": ["match", ["get", "status"], "en_route", 0.75, ["returning", "moving_up"], 0.55, 1] as never,
  } });
  add({ id: "bd-team-labels", type: "symbol", source: "bd-teams",
    layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 11, "text-offset": [0, -1], "text-anchor": "bottom", "text-allow-overlap": true },
    paint: text(MAP_COLOR.responder, 1.6) });
  add({ id: "bd-zone-labels", type: "symbol", source: "bd-zone-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04 },
    paint: text(["match", ["get", "state"], "overrun", BOARD_COLOR.overrunText, "ordered", BOARD_COLOR.overrun, "lifted", BOARD_COLOR.allClear, BOARD_COLOR.readyText], 1.6) });
  add({ id: "bd-fire-labels", type: "symbol", source: "bd-fire-labels",
    layout: { "text-field": ["get", "text"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.04, "text-allow-overlap": true },
    paint: { ...text(STATUS_MATCH(MAP_COLOR.fireEdge, MAP_COLOR.fireEdge, BOARD_COLOR.scarEdge), 1.8), "text-opacity": ["case", ["get", "reported"], 1, 0.7] as never } });
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
      return { kind: layer === "bd-teams" ? "team" : layer === "bd-zones-fill" ? "zone" : "fire", id };
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

  // Unit dots move smoothly between board updates (unitMotion.ts): one GeoJSON source (bd-teams,
  // dots and labels) and the selected unit's ring are redrawn per animation frame while anything
  // moves, and only then. Snapped on board updates under prefers-reduced-motion or while the map is
  // hidden under the 3D view; browsers pause animation frames in a hidden tab.
  const motion = new BoardMotion();
  const reducedQuery = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  motion.setReducedMotion(reducedQuery?.matches ?? false);
  let selectedTeam: string | null = null;
  let mapHidden = false;
  let raf = 0;
  const renderUnits = (now: number): boolean => {
    if (!board) return false;
    const changing = motion.frame(now, mapHidden);
    const teams = buildTeamPoints(board, motion, map.getZoom());
    setData("bd-teams", teams);
    if (selectedTeam) {
      const f = teams.find((t) => t.properties.id === selectedTeam);
      setData("bd-sel-point", f ? [point((f.geometry as GeoJSON.Point).coordinates as LonLat, { id: selectedTeam })] : []);
    }
    return changing;
  };
  const loop = (now: number) => {
    raf = 0;
    if (disposed) return;
    if (renderUnits(now) && !mapHidden) raf = requestAnimationFrame(loop);
  };
  const schedule = () => {
    if (!raf && !disposed && !mapHidden) raf = requestAnimationFrame(loop);
  };
  const onReduced = () => {
    motion.setReducedMotion(reducedQuery?.matches ?? false);
    schedule();
  };
  reducedQuery?.addEventListener("change", onReduced);
  // Standing offsets are in screen pixels: redraw as the zoom changes.
  map.on("zoom", schedule);

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
        motion.sample(null, []);
        lastSelKey = null;
        return;
      }
      const z = buildZones(board, input.forecasts);
      const r = buildRoutes(board, input.routes, input.selection);
      const sel = buildSelection(input.selection, board);
      setData("bd-zones", z.areas);
      setData("bd-zone-labels", z.labels);
      setData("bd-routes", r.lines);
      setData("bd-fires", fireFeatures(board));
      setData("bd-fire-state", fireStateFeatures(board));
      const crews = buildCrews(board);
      setData("bd-crews", crews.dots);
      setData("bd-crew-trails", crews.trails);
      setData("bd-fire-labels", buildFireLabels(board));
      setData("bd-team-lines", buildTeamLines(board));
      setData("bd-stations", stationFeatures(board));
      setData("bd-dest", r.dests);
      setData("bd-sel-area", sel.areas);
      selectedTeam = input.selection?.kind === "team" ? input.selection.id : null;
      if (!selectedTeam) setData("bd-sel-point", sel.points);
      setData("bd-no-truck", buildClosedRoads(board, input));
      setData("bd-evac", evacueeMarkers(board).map((m) => point(m.at, { zone_id: m.zoneId, vehicles: m.vehicles })));
      const al = buildAttackLines(board, input.selection);
      setData("bd-attack-lines", al.lines);
      setData("bd-attack-points", al.points);
      // Move the camera only when the selection changes, not on each board update.
      const key = input.selection ? `${input.selection.kind}:${input.selection.id}` : null;
      if (key !== lastSelKey && input.selection) {
        const center = selectionCenter(input.selection, board);
        if (center) map.easeTo({ center, zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
      }
      lastSelKey = key;
      const now = performance.now();
      mapHidden = getComputedStyle(map.getContainer()).visibility === "hidden";
      motion.sample(board, teamSubjects(board), now);
      if (renderUnits(now)) schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      reducedQuery?.removeEventListener("change", onReduced);
      map.off("zoom", schedule);
      map.off("click", onClick);
      for (const layer of INTERACTIVE) {
        map.off("mouseenter", layer, pointer);
        map.off("mouseleave", layer, reset);
      }
      if (!map.getStyle()) return;
      for (const id of [...layerIds].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of SOURCES) if (map.getSource(id)) map.removeSource(id);
      if (map.hasImage(SCAR_HATCH_IMAGE)) map.removeImage(SCAR_HATCH_IMAGE);
    },
  };
}
