/**
 * The dispatch area: an OSM road graph, synthetic homes and evacuation zones, exits and fire
 * stations for one bounding box, built at runtime by `GET /api/dispatch/area`
 * (app/backend/api/dispatch_area.py, schema 2). See docs/adr/0017-dispatch-anywhere.md.
 *
 * Units: WGS84 [longitude, latitude]; metres; km/h; vehicles per hour per direction.
 */

import { lonLatToMercator, mercatorToLonLat, type LandscapeGrid } from "../fire/landscape";

export const DISPATCH_AREA_URL = "/api/dispatch/area";
const AREA_KIND = "crisistwin_dispatch_area";
const AREA_SCHEMA_VERSION = 2;

/** The road box covers the fire's footprint at the horizon plus this much ground on every side. */
export const AREA_BUFFER_METERS = 2500;
/** Half-width limits of the road box (ground metres); the backend refuses much larger boxes. */
export const MIN_AREA_HALF_METERS = 3000;
export const MAX_AREA_HALF_METERS = 6000;

export type LonLat = [number, number];
/** [west, south, east, north] */
export type Bbox = [number, number, number, number];

export interface RoadEdge {
  index: number;
  from: number;
  to: number;
  lengthMeters: number;
  roadClass: string;
  speedKph: number;
  /** Assumed saturation flow in the direction of travel, vehicles/hour. */
  capacityVph: number;
  /** One-way edges are drivable only from `from` to `to`. */
  oneway: boolean;
  name: string | null;
  /** Tagged as a bridge in OSM (false for areas cached before builder dispatch-area/3). */
  bridge: boolean;
  /** Full polyline from `from` to `to`. */
  coords: LonLat[];
  /**
   * OSM tags kept for road-access rules (surface, tracktype, smoothness, width, maxweight,
   * maxheight, bridge, access, emergency, ...); empty for areas built before dispatch-area/4.
   */
  tags?: Readonly<Record<string, string>>;
  /**
   * A service road or track kept only for apparatus access (dispatch-area/4). It is not in
   * `outgoing`, so evacuation and the dispatch agent never route over it.
   */
  accessOnly?: boolean;
}

/** A road's display name: its OSM name or class, marked when it is a bridge. */
export function roadLabel(edge: RoadEdge): string {
  const name = edge.name ?? `Unnamed ${edge.roadClass.replace("_", " ")} road`;
  return edge.bridge ? `${name} (bridge)` : name;
}

export interface Zone {
  id: string;
  name: string;
  /** Graph node where the zone's traffic enters the network (its loading point). */
  node: number;
  homes: number;
  /** Evacuating vehicles (synthetic estimate). */
  vehicles: number;
  centroid: LonLat;
  polygon: LonLat[];
  /** Index of the zone's first home in `DispatchArea.homes`; its homes are contiguous. */
  firstHome: number;
}

/** One synthetic household, placed along a residential street. */
export interface Home {
  position: LonLat;
  zone: number;
}

export interface Exit {
  id: string;
  name: string;
  node: number;
  road: string;
}

export interface Station {
  id: string;
  name: string;
  node: number;
  location: LonLat;
  /** Straight-line metres from the OSM station to its graph node (0 inside the box). */
  approachMeters: number;
  units: { id: string; type: "engine" }[];
}

/** One outgoing direction of an edge from a node. */
export interface Arc {
  edge: number;
  /** True when travelling `from` -> `to`. */
  forward: boolean;
  head: number;
}

export interface DispatchArea {
  id: string;
  name: string;
  bbox: Bbox;
  attribution: string;
  osmTimestamp: string | null;
  notes: string[];
  nodes: LonLat[];
  edges: RoadEdge[];
  /** Outgoing arcs per node over public roads, respecting one-way edges. */
  outgoing: Arc[][];
  /** Outgoing arcs per node over every edge, access-only service roads and tracks included. */
  allOutgoing?: Arc[][];
  /** Nodes tagged highway=turning_circle or turning_loop (empty before dispatch-area/4). */
  turningNodes?: number[];
  /** Nodes where a way leaves the area's box (empty before dispatch-area/4). */
  boundaryNodes?: number[];
  zones: Zone[];
  /** Grouped by zone; within a zone in departure order. */
  homes: Home[];
  exits: Exit[];
  stations: Station[];
}

class AreaFormatError extends Error {
  constructor(message: string) {
    super(`The dispatch area is invalid: ${message}`);
    this.name = "AreaFormatError";
  }
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new AreaFormatError(`${what} must be a list.`);
  return value;
}

function asLonLat(value: unknown, what: string): LonLat {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    throw new AreaFormatError(`${what} must be [longitude, latitude].`);
  }
  return [value[0], value[1]];
}

function nodeIndex(value: unknown, count: number, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= count) {
    throw new AreaFormatError(`${what} is not a node index.`);
  }
  return value as number;
}

export function parseArea(json: unknown): DispatchArea {
  if (!json || typeof json !== "object") throw new AreaFormatError("not an object.");
  const raw = json as Record<string, unknown>;
  if (raw.kind !== AREA_KIND || raw.schemaVersion !== AREA_SCHEMA_VERSION) {
    throw new AreaFormatError(`expected ${AREA_KIND} schema ${AREA_SCHEMA_VERSION}.`);
  }
  const classes = asArray(raw.classes, "classes") as string[];
  const names = asArray(raw.names, "names") as string[];
  const tagSets = (Array.isArray(raw.tagSets) ? raw.tagSets : []) as Record<string, string>[];
  const nodes = asArray(raw.nodes, "nodes").map((node, i) => asLonLat(node, `nodes[${i}]`));
  const count = nodes.length;

  const edges: RoadEdge[] = asArray(raw.edges, "edges").map((value, index) => {
    const row = asArray(value, `edges[${index}]`);
    const [from, to, length, cls, kph, capacity, oneway, name, flat, bridge, tagSet, accessOnly] =
      row;
    if (
      typeof length !== "number" ||
      length <= 0 ||
      typeof kph !== "number" ||
      kph <= 0 ||
      typeof capacity !== "number" ||
      capacity <= 0 ||
      typeof cls !== "number" ||
      !classes[cls] ||
      typeof name !== "number"
    ) {
      throw new AreaFormatError(`edges[${index}] has a bad length, speed, capacity or class.`);
    }
    const a = nodeIndex(from, count, `edges[${index}].from`);
    const b = nodeIndex(to, count, `edges[${index}].to`);
    const middle = asArray(flat, `edges[${index}].geometry`) as number[];
    const coords: LonLat[] = [nodes[a]];
    for (let i = 0; i + 1 < middle.length; i += 2) coords.push([middle[i], middle[i + 1]]);
    coords.push(nodes[b]);
    return {
      index,
      from: a,
      to: b,
      lengthMeters: length,
      roadClass: classes[cls],
      speedKph: kph,
      capacityVph: capacity,
      oneway: oneway === 1,
      name: name >= 0 ? (names[name] ?? null) : null,
      bridge: bridge === 1,
      coords,
      tags: (typeof tagSet === "number" && tagSets[tagSet]) || {},
      accessOnly: accessOnly === 1,
    };
  });

  const outgoing: Arc[][] = nodes.map(() => []);
  const allOutgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    const arcs = edge.accessOnly ? [allOutgoing] : [outgoing, allOutgoing];
    for (const list of arcs) {
      list[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
      if (!edge.oneway) list[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
    }
  }
  const nodeList = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter(
      (n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < count,
    );

  const rawZones = asArray(raw.zones, "zones");
  const homes: Home[] = asArray(raw.homes ?? [], "homes").map((value, i) => {
    const row = asArray(value, `homes[${i}]`);
    const zone = row[2];
    if (!Number.isInteger(zone) || (zone as number) < 0 || (zone as number) >= rawZones.length) {
      throw new AreaFormatError(`homes[${i}] has no valid zone.`);
    }
    return { position: asLonLat(row, `homes[${i}]`), zone: zone as number };
  });
  const homeCounts = new Array<number>(rawZones.length).fill(0);
  const firstHome = new Array<number>(rawZones.length).fill(-1);
  homes.forEach((home, i) => {
    if (firstHome[home.zone] < 0) firstHome[home.zone] = i;
    else if (homes[i - 1].zone !== home.zone) {
      throw new AreaFormatError("homes must be grouped by zone.");
    }
    homeCounts[home.zone] += 1;
  });

  const zones: Zone[] = rawZones.map((value, i) => {
    const zone = value as Record<string, unknown>;
    if (typeof zone.id !== "string" || typeof zone.name !== "string") {
      throw new AreaFormatError(`zones[${i}] needs an id and name.`);
    }
    if (typeof zone.vehicles !== "number" || zone.vehicles < 0) {
      throw new AreaFormatError(`zones[${i}] needs nonnegative vehicles.`);
    }
    return {
      id: zone.id,
      name: zone.name,
      node: nodeIndex(zone.node, count, `zones[${i}].node`),
      // The home rows are the households the engine moves, so the count comes from them.
      homes: homeCounts[i],
      vehicles: zone.vehicles,
      centroid: asLonLat(zone.centroid, `zones[${i}].centroid`),
      polygon: asArray(zone.polygon, `zones[${i}].polygon`).map((p, j) =>
        asLonLat(p, `zones[${i}].polygon[${j}]`),
      ),
      firstHome: Math.max(0, firstHome[i]),
    };
  });

  const exits: Exit[] = asArray(raw.exits, "exits").map((value, i) => {
    const exit = value as Record<string, unknown>;
    if (typeof exit.id !== "string" || typeof exit.name !== "string") {
      throw new AreaFormatError(`exits[${i}] needs an id and name.`);
    }
    return {
      id: exit.id,
      name: exit.name,
      node: nodeIndex(exit.node, count, `exits[${i}].node`),
      road: String(exit.road ?? ""),
    };
  });

  const stations: Station[] = asArray(raw.stations, "stations").map((value, i) => {
    const station = value as Record<string, unknown>;
    if (typeof station.id !== "string" || typeof station.name !== "string") {
      throw new AreaFormatError(`stations[${i}] needs an id and name.`);
    }
    const approach = Number(station.approachMeters ?? 0);
    return {
      id: station.id,
      name: station.name,
      node: nodeIndex(station.node, count, `stations[${i}].node`),
      location: asLonLat(station.location, `stations[${i}].location`),
      approachMeters: Number.isFinite(approach) && approach > 0 ? approach : 0,
      units: (asArray(station.units, `stations[${i}].units`) as { id: string }[]).map((unit) => ({
        id: String(unit.id),
        type: "engine" as const,
      })),
    };
  });

  const bbox = asArray(raw.bbox, "bbox") as number[];
  if (bbox.length !== 4) throw new AreaFormatError("bbox must be [west, south, east, north].");
  const sources = (raw.sources ?? {}) as { osm?: { attribution?: string; timestamp?: string } };
  const assumptions = (raw.assumptions ?? {}) as { notes?: unknown };

  return {
    id: String(raw.id),
    name: String(raw.name),
    bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
    attribution: sources.osm?.attribution ?? "© OpenStreetMap contributors",
    osmTimestamp: typeof sources.osm?.timestamp === "string" ? sources.osm.timestamp : null,
    notes: Array.isArray(assumptions.notes) ? assumptions.notes.map(String) : [],
    nodes,
    edges,
    outgoing,
    allOutgoing,
    turningNodes: nodeList(raw.turningNodes),
    boundaryNodes: nodeList(raw.boundaryNodes),
    zones,
    homes,
    exits,
    stations,
  };
}

export class AreaRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AreaRequestError";
  }
}

/** Fetch (or read the server's cache of) the area for `bbox`. */
export async function loadArea(bbox: Bbox, signal: AbortSignal): Promise<DispatchArea> {
  const query = bbox.map((value) => value.toFixed(5)).join(",");
  const response = await fetch(`${DISPATCH_AREA_URL}?bbox=${query}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    let code = "http_error";
    let detail = `The road network service returned HTTP ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      if (body.error) code = body.error;
      if (body.detail) detail = body.detail;
    } catch {
      // Not JSON (a proxy error page, or the backend is not running); keep the status message.
    }
    throw new AreaRequestError(code, detail);
  }
  return parseArea(await response.json());
}

/**
 * The road box for a fire run: the cells the fire reaches by the horizon plus
 * AREA_BUFFER_METERS, kept between MIN and MAX_AREA_HALF_METERS of half-width around its
 * centre and inside the landscape board. Ground metres are converted to Mercator metres with
 * the board's own scale. Null when nothing burns.
 */
export function dispatchBoxFor(
  grid: LandscapeGrid,
  arrivalMinutes: Float32Array,
  horizonMinutes: number,
): Bbox | null {
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (let i = 0; i < arrivalMinutes.length; i += 1) {
    if (!(arrivalMinutes[i] <= horizonMinutes)) continue;
    const c = i % grid.width;
    const r = (i - c) / grid.width;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  if (!Number.isFinite(minC)) return null;
  const mercatorPerGround = Math.abs(grid.cellSizeX) / grid.groundCellSizeMeters;
  const halfGround = (cells: number) =>
    (cells / 2) * grid.groundCellSizeMeters + AREA_BUFFER_METERS;
  const clampHalf = (meters: number) =>
    Math.min(MAX_AREA_HALF_METERS, Math.max(MIN_AREA_HALF_METERS, meters));
  const halfX = clampHalf(halfGround(maxC - minC + 1)) * mercatorPerGround;
  const halfY = clampHalf(halfGround(maxR - minR + 1)) * mercatorPerGround;
  const cx = grid.originX + ((minC + maxC) / 2) * grid.cellSizeX;
  const cy = grid.originY + ((minR + maxR) / 2) * grid.cellSizeY;
  // Board extent in Mercator metres (cell centres sit at origin + index * size).
  const boardWest = grid.originX - grid.cellSizeX / 2;
  const boardEast = grid.originX + (grid.width - 0.5) * grid.cellSizeX;
  const boardNorth = grid.originY - grid.cellSizeY / 2;
  const boardSouth = grid.originY + (grid.height - 0.5) * grid.cellSizeY;
  const [w, s] = mercatorToLonLat(
    Math.max(boardWest, cx - halfX),
    Math.max(boardSouth, cy - halfY),
  );
  const [e, n] = mercatorToLonLat(
    Math.min(boardEast, cx + halfX),
    Math.min(boardNorth, cy + halfY),
  );
  return [w, s, e, n];
}

/** Ground metres between two points (Mercator distance scaled by latitude; fine at area scale). */
export function groundMeters(a: LonLat, b: LonLat): number {
  const [ax, ay] = lonLatToMercator(a[0], a[1]);
  const [bx, by] = lonLatToMercator(b[0], b[1]);
  const scale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot(ax - bx, ay - by) * scale;
}
