"""Zone-to-destination routes on the drill road network.

Contract: docs/live-reports.md "Planner rules". The search cost of an edge is its free-flow
travel time x its fire weight x an optional congestion factor (simulated, from the traffic
twin; ADR 0031-congestion-aware-planner); ``Route.travel_time_s`` stays free-flow. A zone's
incumbent route (the published one) is kept unless the new route is cheaper by a margin
(SWITCH_MIN_GAIN_S, SWITCH_MIN_GAIN_FRACTION). Never routes over a blocked segment. Normal
routes keep every edge outside the fire estimate and FIRE_BUFFER_M beyond it; a zone with no such route gets a
least-exposure route (``Route.exposed``) that a controller must approve. A temporary refuge
is a destination only when it lies farther than REFUGE_FIRE_BUFFER_M from the fire estimate,
and a least-exposure route prefers an exit or shelter (out of the fire area) over a refuge.
"""

from __future__ import annotations

import dataclasses
import heapq
import logging
import math
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Literal

from .drill import Destination, DestinationKind, Drill, Edge, Zone
from .geo import LonLat, MultiPolygon, centroid, haversine_m, point_in_multipolygon, polyline_distance_m

log = logging.getLogger(__name__)

DESTINATION_KINDS: tuple[DestinationKind, ...] = ("exit", "shelter")
FALLBACK_KINDS: tuple[DestinationKind, ...] = ("temporary_refuge",)
"""Used only for zones that reach no exit or shelter."""
REFUGE_FIRE_BUFFER_M = 1000.0
"""A temporary refuge (and its road node) must be farther than this from the fire estimate to
be a destination at all: a refuge inside or beside the fire is not a place to go."""
REFUGE_MIN_EXPOSURE_CUT_S = 30.0
"""Least-exposure passes: a refuge replaces the zone's exit or shelter route only when its route
spends at least this many fewer seconds inside the fire estimate, or about the same time inside
(within this) and this many fewer within FIRE_BUFFER_M of it."""
VIA_MAX_NAMES = 3
"""``via`` lists at most this many road names: the longest named stretches, in route order."""
ROUTE_MAX_POINTS = 500
"""``line`` is simplified to at most this many points."""
FIRE_BUFFER_M = 300.0
"""Normal routes keep every edge at least this far outside the fire estimate."""
EXPOSED_COST_INSIDE = 20.0
"""Least-exposure (through-fire) pass: travel-time multiplier for an edge with any part inside the fire estimate."""
EXPOSED_COST_BUFFER = 5.0
"""Least-exposure passes: travel-time multiplier for an edge within FIRE_BUFFER_M of it."""
DEST_SNAP_MAX_M = 300.0
"""A destination off the routable network snaps to a routable node within this distance, else it is dropped."""
MIN_ROUTE_M = 50.0
"""A shorter route is not a route; the zone takes its next-nearest destination."""
MAX_SKIPPED_DESTINATIONS = 5
"""Per zone and pass, how many too-short destinations are skipped before giving up."""
ALTERNATIVE_CANDIDATES = 12
"""``alternative_routes``: a zone's search stops once it has reached this many usable exits or
shelters (refuges met on the way are kept too)."""
CONGESTION_MAX_FACTOR = 10.0
"""Upper bound of a congestion factor (a stopped edge counts as 10x its free-flow time); the
same bound as ``livecore.inbound`` (which re-exports it)."""
SWITCH_MIN_GAIN_S = 120.0
SWITCH_MIN_GAIN_FRACTION = 0.15
"""Hysteresis (ADR 0031-congestion-aware-planner): a zone leaves its incumbent route only when
the new route's search cost is lower by at least max(SWITCH_MIN_GAIN_S, SWITCH_MIN_GAIN_FRACTION
x the incumbent's cost), both measured now with the same edge costs (fire weight x congestion).
Planning heuristics, not calibrated: two minutes, or 15 %, is more than the swing of one twin
reroute interval (300 s) of queue on a typical 15-30 min route."""
SWITCH_MIN_DWELL_S = 900.0
"""Hysteresis, second rule: for this many drill seconds after a zone's guidance was published,
its incumbent is kept whatever the gain, as long as it stays usable (not blocked, allowed by the
pass's fire rule, destination usable). Planning heuristic, not calibrated: the margin alone let
zones swap exits every 5-10 min in the record comparison at 16:00-17:45Z (queues the zone's own
vehicles build on its route make the other exit look cheaper; ADR 0031-congestion-aware-planner).
15 min is three twin reroute intervals (300 s), time for a zone's departures to load its route."""

_CLEAR, _BUFFER, _INSIDE = 0, 1, 2

Exposure = Literal["clear", "near_fire", "through_fire"]


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
    fire_time_s: float = 0.0
    """Free-flow seconds on edges inside or crossing the fire estimate."""
    near_fire_time_s: float = 0.0
    """Free-flow seconds on edges outside the fire estimate but within FIRE_BUFFER_M of it."""

    @property
    def eta_min(self) -> int:
        """Free-flow travel time in whole minutes, rounded up."""
        return math.ceil(self.travel_time_s / 60)

    @property
    def exposure(self) -> Exposure:
        """``through_fire`` (passes the fire), ``near_fire`` (only its buffer) or ``clear``."""
        return "through_fire" if self.passes_fire else "near_fire" if self.exposed else "clear"


def edge_travel_time_s(edge: Edge) -> float:
    """``length_m / (speed_kph / 3.6)``, in seconds."""
    return edge.length_m / (edge.speed_kph / 3.6)


@dataclass(frozen=True)
class Incumbent:
    """The route a zone is following now (its published guidance), for hysteresis."""

    destination_id: str
    edge_ids: tuple[str, ...] | None = None
    """Directed edges of the published route when known; None compares destinations only."""
    held_s: float | None = None
    """Drill seconds since the zone's guidance was published; under SWITCH_MIN_DWELL_S the
    incumbent is kept while usable. None: no dwell rule."""


def validate_congestion(congestion: Mapping[str, float] | None) -> dict[str, float]:
    """``congestion`` as a dict; raises ``ValueError`` on a factor outside [1, CONGESTION_MAX_FACTOR]."""
    factors = dict(congestion or {})
    for eid, f in factors.items():
        if not (math.isfinite(f) and 1.0 <= f <= CONGESTION_MAX_FACTOR):
            raise ValueError(f"congestion factor of {eid} must be in [1, {CONGESTION_MAX_FACTOR}], got {f!r}")
    return factors


def _congested(edge_cost: Callable[[str], float | None], factors: Mapping[str, float]
               ) -> Callable[[str], float | None]:
    """``edge_cost`` x the edge's congestion factor (missing edges: 1)."""
    if not factors:
        return edge_cost

    def cost(eid: str) -> float | None:
        c = edge_cost(eid)
        return None if c is None else c * factors.get(eid, 1.0)

    return cost


def path_cost_s(edge_cost: Callable[[str], float | None], edge_ids: Collection[str]) -> float | None:
    """Sum of ``edge_cost`` over ``edge_ids``; None when any edge is unusable."""
    total = 0.0
    for eid in edge_ids:
        c = edge_cost(eid)
        if c is None:
            return None
        total += c
    return total


def switch_margin_s(incumbent_cost_s: float) -> float:
    """Cost (search seconds) a new route must save over the incumbent to replace it."""
    return max(SWITCH_MIN_GAIN_S, SWITCH_MIN_GAIN_FRACTION * incumbent_cost_s)


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



def _edge_costs(drill: Drill, index: _Index, blocked: frozenset[str], fire_class: Callable[[str], int]
                ) -> tuple[Callable[[str], float | None], Callable[[str], float | None], Callable[[str], float | None]]:
    """Edge cost functions of the three passes (open, near fire, through fire); None = unusable."""
    edges = drill.roads.edges

    def open_cost(eid: str) -> float | None:
        if edges[eid].segment_id in blocked or fire_class(eid) != _CLEAR:
            return None
        return index.edge_time_s[eid]

    def near_cost(eid: str) -> float | None:
        if edges[eid].segment_id in blocked:
            return None
        c = fire_class(eid)
        if c == _INSIDE:
            return None
        return index.edge_time_s[eid] * (EXPOSED_COST_BUFFER if c == _BUFFER else 1.0)

    def through_cost(eid: str) -> float | None:
        if edges[eid].segment_id in blocked:
            return None
        c = fire_class(eid)
        return index.edge_time_s[eid] * (
            EXPOSED_COST_INSIDE if c == _INSIDE else EXPOSED_COST_BUFFER if c == _BUFFER else 1.0)

    return open_cost, near_cost, through_cost


def _usable_destinations(drill: Drill, index: _Index, avoid_polygon: MultiPolygon | None,
                         full: Collection[str], wanted: tuple[DestinationKind, ...]) -> list[str]:
    """Destinations of ``wanted`` kinds that are routable, not full, not inside the fire estimate,
    and (temporary refuges) farther than REFUGE_FIRE_BUFFER_M from it."""
    roads = drill.roads
    out = []
    for dest in drill.destinations:
        if dest.kind not in wanted or dest.id in full or dest.id not in index.destination_nodes:
            continue
        node_coord = roads.node_coords[index.destination_nodes[dest.id]]
        if avoid_polygon is not None:
            if dest.kind == "temporary_refuge":
                if (polyline_distance_m((dest.coord,), avoid_polygon, REFUGE_FIRE_BUFFER_M) <= REFUGE_FIRE_BUFFER_M
                        or polyline_distance_m((node_coord,), avoid_polygon,
                                               REFUGE_FIRE_BUFFER_M) <= REFUGE_FIRE_BUFFER_M):
                    continue
            elif point_in_multipolygon(dest.coord, avoid_polygon) or point_in_multipolygon(node_coord, avoid_polygon):
                continue
        out.append(dest.id)
    return out


def _with_exposure(index: _Index, fire_class: Callable[[str], int], route: Route) -> Route:
    fire_s = near_s = 0.0
    for eid in route.edge_ids:
        c = fire_class(eid)
        if c == _INSIDE:
            fire_s += index.edge_time_s[eid]
        elif c == _BUFFER:
            near_s += index.edge_time_s[eid]
    if fire_s == 0.0 and near_s == 0.0:
        return route
    return dataclasses.replace(route, exposed=True, passes_fire=fire_s > 0.0,
                               fire_time_s=fire_s, near_fire_time_s=near_s)


def best_routes(
    drill: Drill,
    blocked_segment_ids: Collection[str],
    avoid_polygon: MultiPolygon | None,
    full_destination_ids: Collection[str] = (),
    kinds: tuple[DestinationKind, ...] = DESTINATION_KINDS,
    congestion: Mapping[str, float] | None = None,
    incumbents: Mapping[str, Incumbent] | None = None,
) -> dict[str, Route | None]:
    """Fastest route from every zone to its nearest usable destination by travel time.

    Multi-source Dijkstra over the reversed graph from all usable destination nodes. Never
    uses edges whose ``segment_id`` is in ``blocked_segment_ids``; never routes to
    destinations inside ``avoid_polygon`` or in ``full_destination_ids``, nor to a
    ``temporary_refuge`` within REFUGE_FIRE_BUFFER_M of it. Passes, for the zones still
    unrouted:

    1. ``kinds``, then ``FALLBACK_KINDS``, over edges entirely outside ``avoid_polygon`` and
       farther than FIRE_BUFFER_M from it;
    2. near fire: edges within FIRE_BUFFER_M allowed at EXPOSED_COST_BUFFER times their travel
       time, edges inside the fire never;
    3. through fire: edges inside the fire allowed too, at EXPOSED_COST_INSIDE times.

    Passes 2 and 3 are least-exposure passes (``exposed=True``; ``passes_fire`` on pass 3, so
    it means no route to any usable destination avoids the fire). Each routes the zone to
    ``kinds`` and to ``FALLBACK_KINDS`` separately and keeps the ``kinds`` route, which leaves
    the fire area, unless the refuge route is clearly less exposed (``_less_exposed``).

    A route shorter than MIN_ROUTE_M is skipped for the next-nearest destination.
    ``travel_time_s`` is always free-flow time. Returns zone id -> Route, or None.

    ``congestion`` (directed edge id -> factor in [1, CONGESTION_MAX_FACTOR], simulated)
    multiplies every pass's edge cost; missing edges count as 1. ``incumbents`` (zone id ->
    the route it follows now): within each pass, a zone whose incumbent destination is in that
    pass's destination set keeps the incumbent unless the new route saves ``switch_margin_s``
    (``_hold_incumbents``). Raises ``ValueError`` on a factor out of range.
    """
    index = _index(drill)
    fire_class = _fire_classes(drill, avoid_polygon)
    factors = validate_congestion(congestion)
    open_cost, near_cost, through_cost = (
        _congested(c, factors) for c in _edge_costs(drill, index, frozenset(blocked_segment_ids), fire_class))
    full = frozenset(full_destination_ids)
    held = dict(incumbents or {})

    def usable_destinations(wanted: tuple[DestinationKind, ...]) -> list[str]:
        return _usable_destinations(drill, index, avoid_polygon, full, wanted)

    def with_exposure(route: Route) -> Route:
        return _with_exposure(index, fire_class, route)

    result: dict[str, Route | None] = {z.id: None for z in drill.zones}
    pending = list(drill.zones)
    primary, fallback = usable_destinations(kinds), usable_destinations(FALLBACK_KINDS)

    def route(dest_ids: list[str], edge_cost: Callable[[str], float | None]) -> dict[str, Route]:
        if not pending or not dest_ids:
            return {}
        found = _route_zones(drill, index, pending, dest_ids, edge_cost)
        if held:
            found = _hold_incumbents(drill, index, found, dest_ids, edge_cost, held)
        return {z: with_exposure(r) for z, r in found.items()}

    for dest_ids in (primary, fallback):
        for zone_id, r in route(dest_ids, open_cost).items():
            result[zone_id] = r
        pending = [z for z in pending if result[z.id] is None]
    if avoid_polygon is not None:
        for edge_cost in (near_cost, through_cost):
            leave, refuge = route(primary, edge_cost), route(fallback, edge_cost)
            for zone in pending:
                a, b = leave.get(zone.id), refuge.get(zone.id)
                result[zone.id] = b if a is None or (b is not None and _less_exposed(b, a)) else a
            pending = [z for z in pending if result[z.id] is None]
    return result


def weighted_time_s(route: Route) -> float:
    """The least-exposure search cost of ``route``: free-flow seconds with buffer time weighted by
    EXPOSED_COST_BUFFER and time inside the fire by EXPOSED_COST_INSIDE (= travel time when clear)."""
    return (route.travel_time_s + (EXPOSED_COST_BUFFER - 1.0) * route.near_fire_time_s
            + (EXPOSED_COST_INSIDE - 1.0) * route.fire_time_s)


def destination_node(drill: Drill, destination_id: str) -> str | None:
    """The road node a destination is routed to; None when it was dropped (unroutable)."""
    return _index(drill).destination_nodes.get(destination_id)


def alternative_routes(
    drill: Drill,
    picks: Mapping[str, Route],
    blocked_segment_ids: Collection[str],
    avoid_polygon: MultiPolygon | None,
    full_destination_ids: Collection[str] = (),
    kinds: tuple[DestinationKind, ...] = DESTINATION_KINDS,
    congestion: Mapping[str, float] | None = None,
) -> dict[str, list[Route]]:
    """Zone id -> routes from the zone's origin to other usable destinations, cheapest first.

    ``picks`` is zone id -> the zone's chosen route (from ``best_routes``). Each zone gets a
    forward Dijkstra from the pick's origin with the edge cost of the pass that produced the
    pick: open edges only for a clear pick, the near-fire cost for a ``near_fire`` pick, the
    through-fire cost for a ``through_fire`` pick. So the same blocked-edge rule applies, and
    an alternative is never in a worse exposure class than the pick (a clear route would have
    been found by an earlier pass). Destinations are the ``best_routes`` usable set of ``kinds``
    and FALLBACK_KINDS (never inside the fire estimate, never full, refuges farther than
    REFUGE_FIRE_BUFFER_M from it). The pick's destination, destinations at the origin node and
    routes shorter than MIN_ROUTE_M are skipped. The search stops after ALTERNATIVE_CANDIDATES
    exits or shelters. Routes carry their exposure like ``best_routes``. ``congestion`` multiplies
    the edge costs as in ``best_routes``.
    """
    index = _index(drill)
    roads = drill.roads
    fire_class = _fire_classes(drill, avoid_polygon)
    factors = validate_congestion(congestion)
    open_cost, near_cost, through_cost = (
        _congested(c, factors) for c in _edge_costs(drill, index, frozenset(blocked_segment_ids), fire_class))
    full = frozenset(full_destination_ids)
    primary = set(_usable_destinations(drill, index, avoid_polygon, full, kinds))
    usable = sorted(primary | set(_usable_destinations(drill, index, avoid_polygon, full, FALLBACK_KINDS)))
    by_node: dict[str, list[str]] = {}
    for did in usable:
        by_node.setdefault(index.destination_nodes[did], []).append(did)
    costs = {"clear": open_cost, "near_fire": near_cost, "through_fire": through_cost}
    out: dict[str, list[Route]] = {}
    for zone_id in sorted(picks):
        pick = picks[zone_id]
        edge_cost = costs[pick.exposure] if avoid_polygon is not None else open_cost
        origin = pick.origin_node
        dist: dict[str, float] = {origin: 0.0}
        prev: dict[str, str] = {}
        heap: list[tuple[float, str]] = [(0.0, origin)]
        done: set[str] = set()
        reached: list[tuple[str, str]] = []
        n_primary = 0
        while heap and n_primary < ALTERNATIVE_CANDIDATES:
            d, node = heapq.heappop(heap)
            if node in done:
                continue
            done.add(node)
            for did in by_node.get(node, ()):
                if did != pick.destination_id and node != origin:
                    reached.append((did, node))
                    n_primary += did in primary
            for eid in roads.out_edges.get(node, ()):
                c = edge_cost(eid)
                if c is None:
                    continue
                nxt = roads.edges[eid].to_node
                nd = d + c
                if nd < dist.get(nxt, math.inf):
                    dist[nxt] = nd
                    prev[nxt] = eid
                    heapq.heappush(heap, (nd, nxt))
        routes: list[Route] = []
        for did, node in reached:
            path: list[str] = []
            at = node
            while at != origin:
                eid = prev[at]
                path.append(eid)
                at = roads.edges[eid].from_node
            next_edge = {roads.edges[eid].from_node: eid for eid in path}
            route = _build_route(drill, index, zone_id, origin, next_edge, did)
            if route.distance_m >= MIN_ROUTE_M:
                routes.append(_with_exposure(index, fire_class, route))
        out[zone_id] = routes
    return out


def _less_exposed(refuge: Route, leave: Route) -> bool:
    """True when ``refuge`` beats ``leave`` by REFUGE_MIN_EXPOSURE_CUT_S: less time inside the
    fire estimate, or about the same inside and less within its buffer."""
    cut = REFUGE_MIN_EXPOSURE_CUT_S
    if refuge.fire_time_s <= leave.fire_time_s - cut:
        return True
    return (abs(refuge.fire_time_s - leave.fire_time_s) < cut
            and refuge.near_fire_time_s <= leave.near_fire_time_s - cut)


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


def _hold_incumbents(drill: Drill, index: _Index, found: Mapping[str, Route], dest_ids: Collection[str],
                     edge_cost: Callable[[str], float | None], incumbents: Mapping[str, Incumbent]
                     ) -> dict[str, Route]:
    """``found`` with each zone's incumbent kept unless the new route is cheaper by the margin.

    Applies when the incumbent's destination is in ``dest_ids`` (same pass, same destination
    group). The incumbent route is its known edges when they still form a usable path from the
    zone origin to the destination node under ``edge_cost`` (so never over a blocked edge, nor
    into a fire class this pass does not allow); otherwise the cheapest route to the incumbent
    destination now, when the new route goes elsewhere (same destination, unknown edges: the new
    path is taken). Both costs are ``path_cost_s`` under ``edge_cost``. While the incumbent is
    within SWITCH_MIN_DWELL_S of its publication (``held_s``) it is kept whenever it is usable.
    """
    usable = set(dest_ids)
    zones = {z.id: z for z in drill.zones}
    out = dict(found)
    for zone_id, new in found.items():
        inc = incumbents.get(zone_id)
        if inc is None or inc.destination_id not in usable or inc.edge_ids == new.edge_ids:
            continue
        keep = _incumbent_path(drill, index, zone_id, new.origin_node, inc, edge_cost)
        if keep is None and inc.destination_id != new.destination_id:
            keep = _route_zones(drill, index, [zones[zone_id]], [inc.destination_id], edge_cost).get(zone_id)
        if keep is None or keep.edge_ids == new.edge_ids:
            continue
        new_cost, old_cost = path_cost_s(edge_cost, new.edge_ids), path_cost_s(edge_cost, keep.edge_ids)
        if new_cost is None or old_cost is None:
            continue
        dwelling = inc.held_s is not None and inc.held_s < SWITCH_MIN_DWELL_S
        if dwelling or new_cost > old_cost - switch_margin_s(old_cost):
            out[zone_id] = keep
    return out


def _incumbent_path(drill: Drill, index: _Index, zone_id: str, origin: str, inc: Incumbent,
                    edge_cost: Callable[[str], float | None]) -> Route | None:
    """The incumbent's known edges as a Route when they are a usable path from ``origin`` to its
    destination node (contiguous, no repeated node, every edge usable, at least MIN_ROUTE_M)."""
    if not inc.edge_ids:
        return None
    edges = drill.roads.edges
    target = index.destination_nodes.get(inc.destination_id)
    if target is None or any(e not in edges for e in inc.edge_ids):
        return None
    next_edge: dict[str, str] = {}
    at = origin
    for eid in inc.edge_ids:
        e = edges[eid]
        if e.from_node != at or at in next_edge or edge_cost(eid) is None:
            return None
        next_edge[at] = eid
        at = e.to_node
    if at != target or at in next_edge:
        return None
    route = _build_route(drill, index, zone_id, origin, next_edge, inc.destination_id)
    return route if route.distance_m >= MIN_ROUTE_M else None


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
