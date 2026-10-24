"""Zone-to-destination routes on the drill road network.

Contract: docs/live-reports.md "Planner rules". Free-flow travel time; congestion is ignored
(a stated simplification). Never routes over a blocked segment or through the fire estimate.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Collection, Mapping
from dataclasses import dataclass

from .drill import Destination, DestinationKind, Drill, Edge, Zone
from .geo import LonLat, MultiPolygon, centroid, haversine_m, point_in_multipolygon

DESTINATION_KINDS: tuple[DestinationKind, ...] = ("exit", "shelter")
FALLBACK_KINDS: tuple[DestinationKind, ...] = ("temporary_refuge",)
"""Used only for zones that reach no exit or shelter."""
VIA_MAX_NAMES = 3
"""``via`` lists at most this many road names: the longest named stretches, in route order."""
ROUTE_MAX_POINTS = 500
"""``line`` is simplified to at most this many points."""


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
    """Derived lookups for one ``Drill``: snapping grid, edge midpoints, origin/destination nodes.

    Snapping only considers nodes of the largest weakly connected road component, so a zone
    centroid next to a disconnected stub still gets an origin that can reach an exit.
    """

    main_nodes: frozenset[str]
    grid: Mapping[tuple[int, int], tuple[str, ...]]
    edge_midpoints: Mapping[str, LonLat]
    edge_time_s: Mapping[str, float]
    zone_origins: Mapping[str, str]
    destination_nodes: Mapping[str, str]


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


def _midpoint(edge: Edge) -> LonLat:
    """Point halfway along the polyline (planar interpolation between vertices)."""
    coords = edge.coords
    lengths = [haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1)]
    half = sum(lengths) / 2
    for i, seg in enumerate(lengths):
        if half <= seg and seg > 0:
            t = half / seg
            (x1, y1), (x2, y2) = coords[i], coords[i + 1]
            return (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
        half -= seg
    return coords[-1]


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
    origin_ok = {n for n in main if roads.out_edges.get(n)}
    dest_ok = {n for n in main if roads.in_edges.get(n)}
    zone_origins: dict[str, str] = {}
    for zone in drill.zones:
        node = _nearest_node(frozen_grid, roads.node_coords, centroid(zone.geometry), origin_ok)
        if node is None:
            raise ValueError(f"no road node near zone {zone.id}")
        zone_origins[zone.id] = node
    destination_nodes: dict[str, str] = {}
    for dest in drill.destinations:
        node = _destination_node_id(dest)
        if node not in dest_ok:
            node = _nearest_node(frozen_grid, roads.node_coords, dest.coord, dest_ok)
        if node is not None:
            destination_nodes[dest.id] = node
    index = _Index(
        main_nodes=main,
        grid=frozen_grid,
        edge_midpoints={eid: _midpoint(e) for eid, e in roads.edges.items()},
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


def _search(drill: Drill, index: _Index, usable_edge, dest_ids: list[str]) -> tuple[dict[str, float], dict[str, str], dict[str, str]]:
    """Reverse multi-source Dijkstra. Returns node -> (time to dest, next edge, destination id)."""
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
            if not usable_edge(eid):
                continue
            prev = roads.edges[eid].from_node
            nd = d + index.edge_time_s[eid]
            old = dist.get(prev)
            if old is None or nd < old:
                dist[prev] = nd
                next_edge[prev] = eid
                reached[prev] = did
                heapq.heappush(heap, (nd, prev, did))
    return dist, next_edge, reached


def best_routes(
    drill: Drill,
    blocked_segment_ids: Collection[str],
    avoid_polygon: MultiPolygon | None,
    full_destination_ids: Collection[str] = (),
    kinds: tuple[DestinationKind, ...] = DESTINATION_KINDS,
) -> dict[str, Route | None]:
    """Fastest route from every zone to its nearest usable destination by travel time.

    Multi-source Dijkstra over the reversed graph from all usable destination nodes (each
    destination snapped to its nearest road node). Excludes edges whose ``segment_id`` is in
    ``blocked_segment_ids`` or whose midpoint lies inside ``avoid_polygon``, destinations
    inside ``avoid_polygon`` and ids in ``full_destination_ids``. Zones that reach none of
    ``kinds`` retry with ``FALLBACK_KINDS``. Returns zone id -> Route, or None when unreachable.
    """
    index = _index(drill)
    roads = drill.roads
    blocked = frozenset(blocked_segment_ids)
    full = frozenset(full_destination_ids)
    excluded: dict[str, bool] = {}

    def usable_edge(eid: str) -> bool:
        hit = excluded.get(eid)
        if hit is None:
            edge = roads.edges[eid]
            hit = edge.segment_id in blocked or (
                avoid_polygon is not None and point_in_multipolygon(index.edge_midpoints[eid], avoid_polygon)
            )
            excluded[eid] = hit
        return not hit

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

    result: dict[str, Route | None] = {z.id: None for z in drill.zones}
    pending = [z for z in drill.zones]
    for wanted in (kinds, FALLBACK_KINDS):
        if not pending:
            break
        dest_ids = usable_destinations(wanted)
        if not dest_ids:
            continue
        dist, next_edge, reached = _search(drill, index, usable_edge, dest_ids)
        still: list[Zone] = []
        for zone in pending:
            origin = zone_origin_node(drill, zone)
            if origin not in dist:
                still.append(zone)
                continue
            result[zone.id] = _build_route(drill, zone.id, origin, next_edge, reached[origin], dist[origin])
        pending = still
    return result


def _build_route(drill: Drill, zone_id: str, origin: str, next_edge: Mapping[str, str],
                 destination_id: str, travel_time_s: float) -> Route:
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
        travel_time_s=travel_time_s,
    )
