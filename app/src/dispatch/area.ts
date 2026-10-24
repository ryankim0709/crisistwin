/**
 * The dispatch area fixture (`public/dispatch/<id>.json`, built by
 * `python3 -m tools.build_dispatch_area`): an OSM road graph, synthetic evacuation zones,
 * exits and fire stations. See docs/adr/0014-dispatch-agent.md.
 *
 * Units: WGS84 [longitude, latitude]; metres; km/h; vehicles per hour per direction.
 */

export const DISPATCH_AREA_URL = "/dispatch/east-bay-hills.json";
const AREA_KIND = "crisistwin_dispatch_area";
const AREA_SCHEMA_VERSION = 1;

export type LonLat = [number, number];

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
  /** Full polyline from `from` to `to`. */
  coords: LonLat[];
}

export interface Zone {
  id: string;
  name: string;
  /** Graph node where the zone's traffic enters the network. */
  node: number;
  homes: number;
  /** Evacuating vehicles (synthetic estimate). */
  vehicles: number;
  centroid: LonLat;
  polygon: LonLat[];
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
  /** [west, south, east, north]. */
  bbox: [number, number, number, number];
  attribution: string;
  notes: string[];
  nodes: LonLat[];
  edges: RoadEdge[];
  /** Outgoing arcs per node, respecting one-way edges. */
  outgoing: Arc[][];
  zones: Zone[];
  exits: Exit[];
  stations: Station[];
}

class AreaFormatError extends Error {
  constructor(message: string) {
    super(`The dispatch area file is invalid: ${message}`);
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
    value.length !== 2 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
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
  const nodes = asArray(raw.nodes, "nodes").map((node, i) => asLonLat(node, `nodes[${i}]`));
  const count = nodes.length;

  const edges: RoadEdge[] = asArray(raw.edges, "edges").map((value, index) => {
    const row = asArray(value, `edges[${index}]`);
    const [from, to, length, cls, kph, capacity, oneway, name, flat] = row;
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
      coords,
    };
  });

  const outgoing: Arc[][] = nodes.map(() => []);
  for (const edge of edges) {
    outgoing[edge.from].push({ edge: edge.index, forward: true, head: edge.to });
    if (!edge.oneway) outgoing[edge.to].push({ edge: edge.index, forward: false, head: edge.from });
  }

  const zones: Zone[] = asArray(raw.zones, "zones").map((value, i) => {
    const zone = value as Record<string, unknown>;
    if (typeof zone.id !== "string" || typeof zone.name !== "string") {
      throw new AreaFormatError(`zones[${i}] needs an id and name.`);
    }
    if (typeof zone.vehicles !== "number" || zone.vehicles < 0 || typeof zone.homes !== "number") {
      throw new AreaFormatError(`zones[${i}] needs nonnegative homes and vehicles.`);
    }
    return {
      id: zone.id,
      name: zone.name,
      node: nodeIndex(zone.node, count, `zones[${i}].node`),
      homes: zone.homes,
      vehicles: zone.vehicles,
      centroid: asLonLat(zone.centroid, `zones[${i}].centroid`),
      polygon: asArray(zone.polygon, `zones[${i}].polygon`).map((p, j) =>
        asLonLat(p, `zones[${i}].polygon[${j}]`),
      ),
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
    return {
      id: station.id,
      name: station.name,
      node: nodeIndex(station.node, count, `stations[${i}].node`),
      location: asLonLat(station.location, `stations[${i}].location`),
      units: (asArray(station.units, `stations[${i}].units`) as { id: string }[]).map((unit) => ({
        id: String(unit.id),
        type: "engine" as const,
      })),
    };
  });

  const bbox = asArray(raw.bbox, "bbox") as number[];
  if (bbox.length !== 4) throw new AreaFormatError("bbox must be [west, south, east, north].");
  const sources = (raw.sources ?? {}) as { osm?: { attribution?: string } };
  const assumptions = (raw.assumptions ?? {}) as { notes?: unknown };

  return {
    id: String(raw.id),
    name: String(raw.name),
    bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
    attribution: sources.osm?.attribution ?? "© OpenStreetMap contributors",
    notes: Array.isArray(assumptions.notes) ? assumptions.notes.map(String) : [],
    nodes,
    edges,
    outgoing,
    zones,
    exits,
    stations,
  };
}

export async function loadArea(signal: AbortSignal): Promise<DispatchArea> {
  const response = await fetch(DISPATCH_AREA_URL, { signal });
  if (!response.ok) {
    throw new Error(
      `Could not load the dispatch area (${DISPATCH_AREA_URL}, HTTP ${response.status}).`,
    );
  }
  return parseArea(await response.json());
}

export function insideBbox(area: DispatchArea, [lon, lat]: LonLat): boolean {
  const [west, south, east, north] = area.bbox;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}
