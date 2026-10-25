/**
 * Shortest free-flow travel-time paths over the dispatch road graph (Dijkstra). Routes are
 * computed here, never by the agent: the agent picks an exit, the router finds the path.
 */

import type { Arc, DispatchArea } from "./area";

export interface PathStep {
  edge: number;
  forward: boolean;
}

export interface Route {
  steps: PathStep[];
  /** Free-flow travel time, seconds. */
  seconds: number;
  /** Smallest capacity along the route, vehicles/hour. */
  bottleneckVph: number;
  /** Node the route ends at. */
  target: number;
}

export interface ShortestPathTree {
  source: number;
  seconds: Float64Array;
  /** Arc used to reach each node, or null for the source and unreached nodes. */
  via: (Arc | null)[];
  /** Tail node of `via`. */
  previous: Int32Array;
}

export function edgeSeconds(area: DispatchArea, edge: number): number {
  const road = area.edges[edge];
  return road.lengthMeters / (road.speedKph / 3.6);
}

/** Binary min-heap keyed by seconds. */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, value: number): void {
    const keys = this.keys;
    const values = this.values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  pop(): [number, number] {
    const keys = this.keys;
    const values = this.values;
    const topKey = keys[0];
    const topValue = values[0];
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    if (keys.length > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= keys.length) break;
        const right = left + 1;
        const child = right < keys.length && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return [topKey, topValue];
  }
}

/**
 * Dijkstra from `source`, skipping edges for which `blocked(edge)` is true. `options.arcs`
 * replaces the public-road adjacency (e.g. `area.allOutgoing` for apparatus that may use
 * service roads and tracks) and `options.seconds` the free-flow edge time.
 */
export function shortestPathTree(
  area: DispatchArea,
  source: number,
  blocked: (edge: number) => boolean,
  options: { arcs?: Arc[][]; seconds?: (edge: number) => number } = {},
): ShortestPathTree {
  const arcsOf = options.arcs ?? area.outgoing;
  const cost = options.seconds ?? ((edge: number) => edgeSeconds(area, edge));
  const count = area.nodes.length;
  const seconds = new Float64Array(count).fill(Infinity);
  const via: (Arc | null)[] = new Array(count).fill(null);
  const previous = new Int32Array(count).fill(-1);
  seconds[source] = 0;
  const heap = new Heap();
  heap.push(0, source);
  while (heap.size > 0) {
    const [at, node] = heap.pop();
    if (at > seconds[node]) continue;
    for (const arc of arcsOf[node]) {
      if (blocked(arc.edge)) continue;
      const next = at + cost(arc.edge);
      if (next < seconds[arc.head]) {
        seconds[arc.head] = next;
        via[arc.head] = arc;
        previous[arc.head] = node;
        heap.push(next, arc.head);
      }
    }
  }
  return { source, seconds, via, previous };
}

/** The route to `target` in `tree`, or null when it is unreachable. */
export function routeTo(area: DispatchArea, tree: ShortestPathTree, target: number): Route | null {
  if (!Number.isFinite(tree.seconds[target])) return null;
  const steps: PathStep[] = [];
  let bottleneckVph = Infinity;
  for (let node = target; node !== tree.source; node = tree.previous[node]) {
    const arc = tree.via[node];
    if (!arc) return null;
    steps.push({ edge: arc.edge, forward: arc.forward });
    bottleneckVph = Math.min(bottleneckVph, area.edges[arc.edge].capacityVph);
  }
  steps.reverse();
  return { steps, seconds: tree.seconds[target], bottleneckVph, target };
}

/** Node a step arrives at. */
export function stepHead(area: DispatchArea, step: PathStep): number {
  const edge = area.edges[step.edge];
  return step.forward ? edge.to : edge.from;
}

/** Polyline of a route, optionally starting part-way along it. */
export function routeCoords(
  area: DispatchArea,
  steps: readonly PathStep[],
  fromStep = 0,
): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = fromStep; i < steps.length; i += 1) {
    const edge = area.edges[steps[i].edge];
    const line = steps[i].forward ? edge.coords : [...edge.coords].reverse();
    coords.push(...(coords.length > 0 ? line.slice(1) : line));
  }
  return coords;
}

/** Point a fraction (0..1) of the way along one step. */
export function pointAlongStep(
  area: DispatchArea,
  step: PathStep,
  fraction: number,
): [number, number] {
  const edge = area.edges[step.edge];
  const line = step.forward ? edge.coords : [...edge.coords].reverse();
  if (line.length === 1 || fraction <= 0) return line[0];
  if (fraction >= 1) return line[line.length - 1];
  // Interpolate by vertex index weighted by segment length in degrees; adequate for display.
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    const d = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    lengths.push(d);
    total += d;
  }
  let remaining = fraction * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (remaining <= lengths[i]) {
      const t = lengths[i] > 0 ? remaining / lengths[i] : 0;
      return [
        line[i][0] + (line[i + 1][0] - line[i][0]) * t,
        line[i][1] + (line[i + 1][1] - line[i][1]) * t,
      ];
    }
    remaining -= lengths[i];
  }
  return line[line.length - 1];
}
