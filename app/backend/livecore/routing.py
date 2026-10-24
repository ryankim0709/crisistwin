"""Zone-to-destination routes on the drill road network.

Contract: docs/live-reports.md "Planner rules". Free-flow travel time; congestion is ignored
(a stated simplification). Never routes over a blocked segment. Normal routes keep every edge
outside the fire estimate and FIRE_BUFFER_M beyond it; a zone with no such route gets a
least-exposure route (``Route.exposed``) that a controller must approve.
"""

from __future__ import annotations

import dataclasses
import heapq
import logging
import math
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass

from .drill import Destination, DestinationKind, Drill, Edge, Zone
from .geo import LonLat, MultiPolygon, centroid, haversine_m, point_in_multipolygon, polyline_distance_m

log = logging.getLogger(__name__)

DESTINATION_KINDS: tuple[DestinationKind, ...] = ("exit", "shelter")
FALLBACK_KINDS: tuple[DestinationKind, ...] = ("temporary_refuge",)
"""Used only for zones that reach no exit or shelter."""
VIA_MAX_NAMES = 3
"""``via`` lists at most this many road names: the longest named stretches, in route order."""
ROUTE_MAX_POINTS = 500
"""``line`` is simplified to at most this many points."""
FIRE_BUFFER_M = 300.0
"""Normal routes keep every edge at least this far outside the fire estimate."""
EXPOSED_COST_INSIDE = 20.0
"""Least-exposure pass: travel-time multiplier for an edge with any part inside the fire estimate."""
EXPOSED_COST_BUFFER = 5.0
"""Least-exposure pass: travel-time multiplier for an edge within FIRE_BUFFER_M of it."""
DEST_SNAP_MAX_M = 300.0
"""A destination off the routable network snaps to a routable node within this distance, else it is dropped."""
MIN_ROUTE_M = 50.0
"""A shorter route is not a route; the zone takes its next-nearest destination."""
MAX_SKIPPED_DESTINATIONS = 5
"""Per zone and pass, how many too-short destinations are skipped before giving up."""

_CLEAR, _BUFFER, _INSIDE = 0, 1, 2


@dataclass(frozen=True)
class Route:
    zone_id: str
    destination_id: str
    origin_node: str
    edge_ids: tuple[str, ...]
    """Directed edges in travel order."""
    segment_ids: tuple[str, ...]
    """Segment ids of ``edge_ids`` (for task suggestions and block checks)."""
    line: tuple[LonLat, ...]
    via: tuple[str, ...]
    distance_m: float
    travel_time_s: float
    exposed: bool = False
    """True for a least-exposure route: it passes the fire estimate or its FIRE_BUFFER_M buffer."""
    passes_fire: bool = False
    """True when an exposed route has an edge inside or crossing the fire estimate itself."""

    @property
    def eta_min(self) -> int:
        """Free-flow travel time in whole minutes, rounded up."""
        return math.ceil(self.travel_time_s / 60)


def edge_travel_time_s(edge: Edge) -> float:
    """``length_m / (speed_kph / 3.6)``, in seconds."""
    return edge.length_m / (edge.speed_kph / 3.6)


# --- per-drill derived indexes (built once, cached by identity) ---------------------------

_SNAP_CELL_DEG = 0.01


@dataclass(frozen=True)
class _Index:
    """Derived lookups for one ``Drill``: snapping grid, edge travel times, origin/destination nodes.

    Snapping only considers nodes of the largest weakly connected road component, so a zone
    centroid next to a disconnected stub still gets an origin that can reach an exit. A zone
    origin is never a destination node.
    """

    main_nodes: frozenset[str]
    grid: Mapping[tuple[int, int], tuple[str, ...]]
    edge_time_s: Mapping[str, float]
    zone_origins: Mapping[str, str]
    destination_nodes: Mapping[str, str]
    """Destination id -> road node; destinations with no routable node within DEST_SNAP_MAX_M are absent."""


_index_cache: dict[int, tuple[Drill, _Index]] = {}


def _cell(p: LonLat) -> tuple[int, int]:
    return (math.floor(p[0] / _SNAP_CELL_DEG), math.floor(p[1] / _SNAP_CELL_DEG))


def _largest_component(drill: Drill) -> frozenset[str]:
    roads = drill.roads
    parent: dict[str, str] = {n: n for n in roads.node_coords}

    def find(n: str) -> str:
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for e in roads.edges.values():
        a, b = find(e.from_node), find(e.to_node)
        if a != b:
            parent[a] = b
    sizes: dict[str, int] = {}
    for n in parent:
        r = find(n)
        sizes[r] = sizes.get(r, 0) + 1
    root = max(sizes, key=lambda r: (sizes[r], r))
    return frozenset(n for n in parent if find(n) == root)


def _nearest_node(index_grid: Mapping[tuple[int, int], tuple[str, ...]], node_coords: Mapping[str, LonLat],
                  p: LonLat, allowed: Collection[str] | None = None) -> str | None:
    cx, cy = _cell(p)
    best: tuple[float, str] | None = None
    # Expand rings of cells until the best hit is closer than the next ring can be.
    ring_m = _SNAP_CELL_DEG * 111_000 * math.cos(math.radians(p[1]))
    for r in range(0, 200):
        for gx in range(cx - r, cx + r + 1):
            for gy in range(cy - r, cy + r + 1):
                if max(abs(gx - cx), abs(gy - cy)) != r:
                    continue
                for node in index_grid.get((gx, gy), ()):
                    if allowed is not None and node not in allowed:
                        continue
                    d = haversine_m(p, node_coords[node])
                    if best is None or (d, node) < best:
                        best = (d, node)
        if best is not None and best[0] <= r * ring_m:
            break
    return best[1] if best else None


def _index(drill: Drill) -> _Index:
    hit = _index_cache.get(id(drill))
    if hit is not None and hit[0] is drill:
        return hit[1]
    roads = drill.roads
    main = _largest_component(drill)
    grid: dict[tuple[int, int], list[str]] = {}
    for node in sorted(main):
        grid.setdefault(_cell(roads.node_coords[node]), []).append(node)
    frozen_grid = {k: tuple(v) for k, v in grid.items()}
    dest_ok = {n for n in main if roads.in_edges.get(n)}
    destination_nodes: dict[str, str] = {}
    own_nodes: set[str] = set()
    dropped: list[str] = []
    for dest in drill.destinations:
        node = _destination_node_id(dest)
        if node is not None:
            own_nodes.add(node)
        if node not in dest_ok:
            node = _nearest_node(frozen_grid, roads.node_coords, dest.coord, dest_ok)
            if node is not None and haversine_m(dest.coord, roads.node_coords[node]) > DEST_SNAP_MAX_M:
                node = None
        if node is None:
            dropped.append(dest.id)
            continue
        destination_nodes[dest.id] = node
    if dropped:
        log.warning("routing: %d destinations have no routable road node within %g m and are dropped: %s",
                    len(dropped), DEST_SNAP_MAX_M, ", ".join(dropped))
    origin_ok = {n for n in main if roads.out_edges.get(n)} - own_nodes - set(destination_nodes.values())
    zone_origins: dict[str, str] = {}
    for zone in drill.zones:
        node = _nearest_node(frozen_grid, roads.node_coords, centroid(zone.geometry), origin_ok)
        if node is None:
            raise ValueError(f"no road node near zone {zone.id}")
        zone_origins[zone.id] = node
    index = _Index(
        main_nodes=main,
        grid=frozen_grid,
        edge_time_s={eid: edge_travel_time_s(e) for eid, e in roads.edges.items()},
        zone_origins=zone_origins,
        destination_nodes=destination_nodes,
    )
    _index_cache.clear()
    _index_cache[id(drill)] = (drill, index)
    return index


def _destination_node_id(dest: Destination) -> str | None:
    """Exits are named after their road node (``exit:osm-node:123``); others are snapped."""
    prefix = dest.id.split(":", 1)
    return prefix[1] if len(prefix) == 2 and prefix[1].startswith("osm-node:") else None


def zone_origin_node(drill: Drill, zone: Zone) -> str:
    """The road node nearest the zone centroid (one origin per zone; a stated simplification)."""
    index = _index(drill)
    node = index.zone_origins.get(zone.id)
    if node is None:
        found = _nearest_node(index.grid, drill.roads.node_coords, centroid(zone.geometry))
        if found is None:
            raise ValueError(f"no road node near zone {zone.id}")
        node = found
    return node


# --- routing ------------------------------------------------------------------------------


def _simplify(line: list[LonLat]) -> tuple[LonLat, ...]:
    if len(line) <= ROUTE_MAX_POINTS:
        return tuple(line)
    step = (len(line) - 1) / (ROUTE_MAX_POINTS - 1)
    return tuple(line[round(i * step)] for i in range(ROUTE_MAX_POINTS))


def _via(edges: list[Edge]) -> tuple[str, ...]:
    totals: dict[str, float] = {}
    first: dict[str, int] = {}
    for i, e in enumerate(edges):
        if not e.name or e.name.startswith("unnamed "):  # bundle placeholder, e.g. "unnamed residential road"
            continue
        totals[e.name] = totals.get(e.name, 0.0) + e.length_m
        first.setdefault(e.name, i)
    top = sorted(totals, key=lambda n: (-totals[n], first[n]))[:VIA_MAX_NAMES]
    return tuple(sorted(top, key=lambda n: first[n]))


def _search(drill: Drill, index: _Index, edge_cost: Callable[[str], float | None],
            dest_ids: list[str]) -> tuple[dict[str, float], dict[str, str], dict[str, str]]:
    """Reverse multi-source Dijkstra over edges with a cost (None = unusable).

    Returns node -> cost to the destination, node -> next edge, node -> destination id.
    """
    roads = drill.roads
    dist: dict[str, float] = {}
    next_edge: dict[str, str] = {}
    reached: dict[str, str] = {}
    heap: list[tuple[float, str, str]] = []
    for did in dest_ids:
        node = index.destination_nodes[did]
        if node not in dist or did < reached[node]:
            dist[node] = 0.0
            reached[node] = did
    for node, did in reached.items():
        heap.append((0.0, node, did))
    heapq.heapify(heap)
    done: set[str] = set()
    while heap:
        d, node, did = heapq.heappop(heap)
        if node in done:
            continue
        done.add(node)
        for eid in roads.in_edges.get(node, ()):
            c = edge_cost(eid)
            if c is None:
                continue
            prev = roads.edges[eid].from_node
            nd = d + c
            old = dist.get(prev)
            if old is None or nd < old:
                dist[prev] = nd
                next_edge[prev] = eid
                reached[prev] = did
                heapq.heappush(heap, (nd, prev, did))
    return dist, next_edge, reached


_fire_cache: dict[str, tuple[Drill, MultiPolygon, dict[str, int]]] = {}


def _fire_classes(drill: Drill, avoid_polygon: MultiPolygon | None) -> Callable[[str], int]:
    """Edge id -> _CLEAR, _BUFFER (within FIRE_BUFFER_M) or _INSIDE (any part inside or crossing the fire).

    Computed lazily and kept for the most recent (drill, polygon) pair, so the alternative
    rounds of one replan share the work.
    """
    if avoid_polygon is None:
        return lambda eid: _CLEAR
    hit = _fire_cache.get("last")
    if hit is not None and hit[0] is drill and hit[1] is avoid_polygon:
        classes = hit[2]
    else:
        classes = {}
        _fire_cache["last"] = (drill, avoid_polygon, classes)
    edges = drill.roads.edges

    def fire_class(eid: str) -> int:
        edge = edges[eid]
        c = classes.get(edge.segment_id)  # both directions of a segment share one polyline
        if c is None:
            d = polyline_distance_m(edge.coords, avoid_polygon, FIRE_BUFFER_M)
            c = _INSIDE if d == 0.0 else _BUFFER if d <= FIRE_BUFFER_M else _CLEAR
            classes[edge.segment_id] = c
        return c

    return fire_class


def best_routes(
    drill: Drill,
    blocked_segment_ids: Collection[str],
    avoid_polygon: MultiPolygon | None,
    full_destination_ids: Collection[str] = (),
    kinds: tuple[DestinationKind, ...] = DESTINATION_KINDS,
) -> dict[str, Route | None]:
    """Fastest route from every zone to its nearest usable destination by travel time.

    Multi-source Dijkstra over the reversed graph from all usable destination nodes. Never
    uses edges whose ``segment_id`` is in ``blocked_segment_ids``; never routes to
    destinations inside ``avoid_polygon`` or in ``full_destination_ids``. Passes, for the
    zones still unrouted:

    1. ``kinds``, then ``FALLBACK_KINDS``, over edges entirely outside ``avoid_polygon`` and
       farther than FIRE_BUFFER_M from it;
    2. least exposure: both kind sets, edges inside the fire or buffer allowed at
       EXPOSED_COST_INSIDE / EXPOSED_COST_BUFFER times their travel time; ``exposed=True``.

    A route shorter than MIN_ROUTE_M is skipped for the next-nearest destination.
    ``travel_time_s`` is always free-flow time. Returns zone id -> Route, or None.
    """
    index = _index(drill)
    roads = drill.roads
    blocked = frozenset(blocked_segment_ids)
    full = frozenset(full_destination_ids)
    fire_class = _fire_classes(drill, avoid_polygon)
    multiplier = {_CLEAR: 1.0, _BUFFER: EXPOSED_COST_BUFFER, _INSIDE: EXPOSED_COST_INSIDE}

    def open_cost(eid: str) -> float | None:
        if roads.edges[eid].segment_id in blocked or fire_class(eid) != _CLEAR:
            return None
        return index.edge_time_s[eid]

    def exposed_cost(eid: str) -> float | None:
        if roads.edges[eid].segment_id in blocked:
            return None
        return index.edge_time_s[eid] * multiplier[fire_class(eid)]

    def usable_destinations(wanted: tuple[DestinationKind, ...]) -> list[str]:
        out = []
        for dest in drill.destinations:
            if dest.kind not in wanted or dest.id in full or dest.id not in index.destination_nodes:
                continue
            if avoid_polygon is not None and (
                point_in_multipolygon(dest.coord, avoid_polygon)
                or point_in_multipolygon(roads.node_coords[index.destination_nodes[dest.id]], avoid_polygon)
            ):
                continue
            out.append(dest.id)
        return out

    passes: list[tuple[tuple[DestinationKind, ...], Callable[[str], float | None]]] = [
        (kinds, open_cost), (FALLBACK_KINDS, open_cost),
    ]
    if avoid_polygon is not None:
        passes.append((tuple(dict.fromkeys((*kinds, *FALLBACK_KINDS))), exposed_cost))
    result: dict[str, Route | None] = {z.id: None for z in drill.zones}
    pending = list(drill.zones)
    for wanted, edge_cost in passes:
        if not pending:
            break
        dest_ids = usable_destinations(wanted)
        if not dest_ids:
            continue
        routed = _route_zones(drill, index, pending, dest_ids, edge_cost)
        for zone_id, route in routed.items():
            if edge_cost is exposed_cost:
                classes = {fire_class(eid) for eid in route.edge_ids}
                if classes - {_CLEAR}:
                    route = dataclasses.replace(route, exposed=True, passes_fire=_INSIDE in classes)
            result[zone_id] = route
        pending = [z for z in pending if z.id not in routed]
    return result


def _route_zones(drill: Drill, index: _Index, zones: list[Zone], dest_ids: list[str],
                 edge_cost: Callable[[str], float | None]) -> dict[str, Route]:
    """Cheapest route per zone; a route under MIN_ROUTE_M skips that destination node and
    retries with the rest (up to MAX_SKIPPED_DESTINATIONS times)."""
    out: dict[str, Route] = {}
    skipped: dict[str, frozenset[str]] = {z.id: frozenset() for z in zones}
    todo = list(zones)
    for _ in range(MAX_SKIPPED_DESTINATIONS + 1):
        if not todo:
            break
        groups: dict[frozenset[str], list[Zone]] = {}
        for zone in todo:
            groups.setdefault(skipped[zone.id], []).append(zone)
        todo = []
        for skip_nodes, group in groups.items():
            ids = [d for d in dest_ids if index.destination_nodes[d] not in skip_nodes]
            if not ids:
                continue
            dist, next_edge, reached = _search(drill, index, edge_cost, ids)
            for zone in group:
                origin = zone_origin_node(drill, zone)
                if origin not in dist:
                    continue
                route = _build_route(drill, index, zone.id, origin, next_edge, reached[origin])
                dest_node = index.destination_nodes[route.destination_id]
                if route.distance_m < MIN_ROUTE_M or origin == dest_node:
                    skipped[zone.id] = skip_nodes | {dest_node}
                    todo.append(zone)
                    continue
                out[zone.id] = route
    return out


def _build_route(drill: Drill, index: _Index, zone_id: str, origin: str, next_edge: Mapping[str, str],
                 destination_id: str) -> Route:
    roads = drill.roads
    edges: list[Edge] = []
    node = origin
    seen: set[str] = set()
    while node in next_edge:
        if node in seen:  # defensive; Dijkstra predecessor chains are acyclic
            raise RuntimeError("routing loop")
        seen.add(node)
        edge = roads.edges[next_edge[node]]
        edges.append(edge)
        node = edge.to_node
    line: list[LonLat] = [roads.node_coords[origin]]
    for e in edges:
        pts = list(e.coords)
        if line and pts and line[-1] == pts[0]:
            pts = pts[1:]
        line.extend(pts)
    return Route(
        zone_id=zone_id,
        destination_id=destination_id,
        origin_node=origin,
        edge_ids=tuple(e.id for e in edges),
        segment_ids=tuple(e.segment_id for e in edges),
        line=_simplify(line),
        via=_via(edges),
        distance_m=sum(e.length_m for e in edges),
        travel_time_s=sum(index.edge_time_s[e.id] for e in edges),
    )
