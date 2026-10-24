/**
 * Directed lanes over the road graph, shortest-path routing that skips closed edges, and the
 * per-vehicle path (a chain of lane and private segments) the traffic step drives along.
 */
import type { RoadEdge, Vec2, World } from "../types";
import { dist, pointAtDistance, polylineLength } from "../world";

/** One direction of a road edge, or a private lane such as the shelter parking aisle. */
export type Lane = {
  id: number;
  key: string;
  /** Road edge id, or null for a private lane (parking aisle). */
  edgeId: string | null;
  points: Vec2[];
  len: number;
};

/** A stretch of a vehicle path. `lane` is -1 for private driveways / parking stubs. */
export type Seg = {
  lane: number;
  edgeId: string | null;
  /** Centreline in travel direction. */
  points: Vec2[];
  len: number;
  /** Path distance where this segment starts. */
  s0: number;
  /** Lane coordinate (distance from the lane start) at the start of this segment. */
  laneStart: number;
  /** Speed limit (units per second) before any vehicle factor. */
  limit: number;
  /** Lateral offset to the right of travel, for two-way roads. */
  offset: number;
  bridge: boolean;
};

export const LANE_OFFSET = 1.8;
const DRIVEWAY_SPEED = 3.5;
const PARKING_SPEED = 4;
const LOT_SPEED = 9;

export type Network = {
  world: World;
  lanes: Lane[];
  laneKey: Map<string, number>;
  edgeById: Map<string, RoadEdge>;
  edgeLen: Map<string, number>;
  adjacency: Map<string, { edge: RoadEdge; other: string; forward: boolean }[]>;
  nodePos: Map<string, Vec2>;
};

export function reversed(points: Vec2[]): Vec2[] {
  return points.slice().reverse();
}

/** Sub-polyline between path distances d0 and d1 (clamped). */
export function sliceLine(points: Vec2[], d0: number, d1: number): Vec2[] {
  const out: Vec2[] = [pointAtDistance(points, d0).p];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += dist(points[i - 1], points[i]);
    if (acc > d0 + 1e-6 && acc < d1 - 1e-6) out.push(points[i]);
  }
  out.push(pointAtDistance(points, d1).p);
  return out;
}

export function buildNetwork(world: World): Network {
  const lanes: Lane[] = [];
  const laneKey = new Map<string, number>();
  const edgeById = new Map<string, RoadEdge>();
  const edgeLen = new Map<string, number>();
  const adjacency = new Map<string, { edge: RoadEdge; other: string; forward: boolean }[]>();
  const nodePos = new Map<string, Vec2>();
  for (const n of world.nodes) {
    adjacency.set(n.id, []);
    nodePos.set(n.id, n.p);
  }
  const addLane = (key: string, edgeId: string | null, points: Vec2[]) => {
    const id = lanes.length;
    lanes.push({ id, key, edgeId, points, len: polylineLength(points) });
    laneKey.set(key, id);
    return id;
  };
  for (const e of world.edges) {
    edgeById.set(e.id, e);
    edgeLen.set(e.id, polylineLength(e.points));
    addLane(`${e.id}>f`, e.id, e.points);
    addLane(`${e.id}>r`, e.id, reversed(e.points));
    adjacency.get(e.from)!.push({ edge: e, other: e.to, forward: true });
    adjacency.get(e.to)!.push({ edge: e, other: e.from, forward: false });
  }
  return { world, lanes, laneKey, edgeById, edgeLen, adjacency, nodePos };
}

export function addPrivateLane(net: Network, key: string, points: Vec2[]): number {
  const id = net.lanes.length;
  net.lanes.push({ id, key, edgeId: null, points, len: polylineLength(points) });
  net.laneKey.set(key, id);
  return id;
}

export type Hop = { edge: RoadEdge; forward: boolean };

/**
 * Travel time (s) from every node to `target` and the first hop toward it, avoiding
 * `excluded` edges. `speedOf` gives the travel speed on an edge for this vehicle class.
 */
export function shortestTo(
  net: Network,
  target: string,
  excluded: (edge: RoadEdge) => boolean,
  speedOf: (edge: RoadEdge) => number,
): { cost: Map<string, number>; next: Map<string, Hop> } {
  const cost = new Map<string, number>([[target, 0]]);
  const next = new Map<string, Hop>();
  const done = new Set<string>();
  for (;;) {
    let best: string | null = null;
    for (const [node, c] of cost)
      if (!done.has(node) && (best === null || c < cost.get(best)!)) best = node;
    if (best === null) break;
    done.add(best);
    for (const { edge, other, forward } of net.adjacency.get(best)!) {
      if (excluded(edge) || done.has(other)) continue;
      const c = cost.get(best)! + net.edgeLen.get(edge.id)! / speedOf(edge);
      if (c < (cost.get(other) ?? Infinity)) {
        cost.set(other, c);
        // From `other`, the hop toward `best` runs against the direction we arrived by.
        next.set(other, { edge, forward: !forward });
      }
    }
  }
  return { cost, next };
}

export function hopsFrom(
  start: string,
  target: string,
  next: Map<string, Hop>,
  net: Network,
): Hop[] {
  const hops: Hop[] = [];
  let node = start;
  while (node !== target) {
    const hop = next.get(node);
    if (!hop) throw new Error(`No route from ${start} to ${target}`);
    hops.push(hop);
    node = hop.forward ? hop.edge.to : hop.edge.from;
    if (hops.length > net.world.edges.length) throw new Error("Routing loop");
  }
  return hops;
}

/** Incrementally assembles a vehicle path. */
export class PathBuilder {
  segs: Seg[] = [];
  private s = 0;
  private net: Network;
  constructor(net: Network) {
    this.net = net;
  }

  private push(seg: Omit<Seg, "s0" | "len">) {
    const len = polylineLength(seg.points);
    this.segs.push({ ...seg, len, s0: this.s });
    this.s += len;
  }

  privateSeg(points: Vec2[], limit: number) {
    this.push({ lane: -1, edgeId: null, points, laneStart: 0, limit, offset: 0, bridge: false });
  }

  driveway(points: Vec2[]) {
    this.privateSeg(points, DRIVEWAY_SPEED);
  }

  parkingStub(points: Vec2[]) {
    this.privateSeg(points, PARKING_SPEED);
  }

  /** Part of an edge, from lane coordinate `from` to `to` (defaults to the whole lane). */
  edge(hop: Hop, from = 0, to?: number) {
    const lane = this.net.lanes[this.net.laneKey.get(`${hop.edge.id}>${hop.forward ? "f" : "r"}`)!];
    const end = to ?? lane.len;
    const bridge = hop.edge.kind === "bridge";
    this.push({
      lane: lane.id,
      edgeId: hop.edge.id,
      points: from <= 0 && end >= lane.len ? lane.points : sliceLine(lane.points, from, end),
      laneStart: from,
      limit: hop.edge.speed,
      offset: bridge ? 0 : LANE_OFFSET,
      bridge,
    });
  }

  privateLane(laneId: number, to: number) {
    const lane = this.net.lanes[laneId];
    this.push({
      lane: laneId,
      edgeId: null,
      points: sliceLine(lane.points, 0, to),
      laneStart: 0,
      limit: LOT_SPEED,
      offset: 0,
      bridge: false,
    });
  }

  get length() {
    return this.s;
  }
}
