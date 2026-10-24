"""Inbound responder routes: any point to any point on the drill road network.

Contract: docs/live-reports.md "Tasks (v2 additions)", ``GET tasks/{task_id}/route``. The
reverse of the evacuation routes in ``routing``: a responder drives from where they are to a
task target. Same network, same rules:

- both ends snap to the nearest node of the largest road component (origin: a node with an
  out-edge; target: a node with an in-edge), at most INBOUND_SNAP_MAX_M away;
- never an edge whose ``segment_id`` is blocked;
- never an edge inside or crossing the fire estimate; an edge within ``routing.FIRE_BUFFER_M``
  of it costs ``routing.EXPOSED_COST_BUFFER`` times its travel time (the planner's near-fire
  pass), so a responder route is ``clear`` or ``near_fire``, never ``through_fire``;
- the search cost of an edge is also multiplied by its congestion factor (>= 1, from the
  simulated traffic twin), so the route prefers roads not jammed with outbound traffic;
- with an apparatus ``access`` profile (``livecore.apparatus``, rules R01-R12 of
  docs/suppression-data.md) only edges open to that vehicle class are used, each at the class's
  speed; when only the class rules stand between the ends the reason is ``no_access`` with the
  blocking rule of the first closed edge on the route an unrestricted vehicle would take.

Times are seconds, distances meters, coordinates WGS84 ``(lon, lat)``.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Literal

from .apparatus import AccessProfile
from .drill import Drill
from .geo import LonLat, MultiPolygon, haversine_m
from .routing import (
    _INSIDE,
    CONGESTION_MAX_FACTOR,
    Route,
    _build_route,
    _edge_costs,
    _fire_classes,
    _index,
    _nearest_node,
    _with_exposure,
    validate_congestion,
)

INBOUND_SNAP_MAX_M = 1000.0
"""An origin or target farther than this from a routable road node is off the network."""
CONGESTION_MIN_VEH = 3
"""An edge is congested only with at least this many simulated vehicles on it (one car waiting
at a junction is not a jam). Shared by responder routes and the evacuation planner."""

InboundReason = Literal[
    "origin_off_network", "target_off_network", "origin_in_fire", "target_in_fire", "no_open_road", "no_access",
]


@dataclass(frozen=True)
class InboundResult:
    """``route`` is None exactly when ``reason`` is set."""

    route: Route | None
    reason: InboundReason | None
    origin_snap_m: float | None
    """Straight-line meters from the origin to its road node (None when no node was found)."""
    target_snap_m: float | None
    travel_time_s: float | None
    """Drive time: each edge's free-flow seconds times its congestion factor (no fire weighting).
    Equals ``route.travel_time_s`` when no congestion applies."""
    congested_edges: int = 0
    """Edges of the route with a congestion factor above 1."""
    access_rule: str | None = None
    """``no_access`` only: the rule (R01-R10) that closes the first blocking edge to the class."""
    access_note: str | None = None
    """``no_access`` only: why, e.g. ``"grade 18% above 16% limit for engine_t1_t2"``, and the road."""


_ends_cache: dict[int, tuple[Drill, frozenset[str], frozenset[str]]] = {}


def _end_nodes(drill: Drill) -> tuple[frozenset[str], frozenset[str]]:
    """(origin-capable, target-capable) nodes of the main component; cached per drill."""
    hit = _ends_cache.get(id(drill))
    if hit is not None and hit[0] is drill:
        return hit[1], hit[2]
    roads = drill.roads
    main = _index(drill).main_nodes
    origins = frozenset(n for n in main if roads.out_edges.get(n))
    targets = frozenset(n for n in main if roads.in_edges.get(n))
    _ends_cache.clear()
    _ends_cache[id(drill)] = (drill, origins, targets)
    return origins, targets


def congestion_factor(speed_kph: float, free_flow_kph: float) -> float:
    """``free_flow_kph / speed_kph`` clamped to [1, CONGESTION_MAX_FACTOR]; a stopped edge
    (speed 0) gets the maximum. The simulated-traffic travel-time multiplier of one edge."""
    if not (math.isfinite(speed_kph) and math.isfinite(free_flow_kph)) or free_flow_kph <= 0:
        return 1.0
    if speed_kph <= 0:
        return CONGESTION_MAX_FACTOR
    return min(CONGESTION_MAX_FACTOR, max(1.0, free_flow_kph / speed_kph))


def congestion_factors(speeds: Mapping[str, tuple[int, float, float]], known_edges: Collection[str]
                       ) -> dict[str, float]:
    """Directed edge id -> ``congestion_factor`` for the simulated twin's occupied edges
    (``speeds``: edge id -> (vehicles, mean speed kph, free-flow kph)) that are in ``known_edges``,
    have at least CONGESTION_MIN_VEH vehicles and a factor above 1. Other edges are free-flow."""
    return {
        eid: f
        for eid, (veh, speed, free_flow) in sorted(speeds.items())
        if veh >= CONGESTION_MIN_VEH and eid in known_edges and (f := congestion_factor(speed, free_flow)) > 1.0
    }


def inbound_route(
    drill: Drill,
    origin: LonLat,
    target: LonLat,
    blocked: frozenset[str],
    fire: MultiPolygon | None,
    congestion: Mapping[str, float] | None = None,
    access: AccessProfile | None = None,
) -> InboundResult:
    """Cheapest drive from ``origin`` to ``target`` (forward Dijkstra, stops at the target node).

    ``blocked``: segment ids never used. ``fire``: the fire estimate (None = no fire).
    ``congestion``: directed edge id -> travel-time factor in [1, CONGESTION_MAX_FACTOR];
    missing edges count as 1. Raises ``ValueError`` on a factor outside that range.

    ``access``: an apparatus class's road access (``livecore.apparatus.access_profile``); None
    drives every edge at its own speed (the pre-apparatus behaviour).

    Edge search cost = drive seconds (free-flow, or at the class's speed) x (EXPOSED_COST_BUFFER
    if within FIRE_BUFFER_M of the fire else 1) x congestion factor; edges inside the fire,
    blocked edges and edges closed to the class are unusable.
    Returns a result whose ``reason`` says why there is no route: an end off the network,
    an end inside the fire estimate, or no open road between them. Origin and target on the
    same node give a zero-length route.
    """
    factors = validate_congestion(congestion)
    index = _index(drill)
    roads = drill.roads
    origin_ok, target_ok = _end_nodes(drill)
    src = _nearest_node(index.grid, roads.node_coords, origin, origin_ok)
    dst = _nearest_node(index.grid, roads.node_coords, target, target_ok)
    src_m = haversine_m(origin, roads.node_coords[src]) if src else None
    dst_m = haversine_m(target, roads.node_coords[dst]) if dst else None

    def fail(reason: InboundReason) -> InboundResult:
        return InboundResult(None, reason, src_m, dst_m, None)

    if src is None or src_m is None or src_m > INBOUND_SNAP_MAX_M:
        return fail("origin_off_network")
    if dst is None or dst_m is None or dst_m > INBOUND_SNAP_MAX_M:
        return fail("target_off_network")
    fire_class = _fire_classes(drill, fire)
    _, near_cost, _ = _edge_costs(drill, index, frozenset(blocked), fire_class)
    if src != dst and fire is not None:
        if all(fire_class(e) == _INSIDE for e in roads.out_edges[src]):
            return fail("origin_in_fire")
        if all(fire_class(e) == _INSIDE for e in roads.in_edges[dst]):
            return fail("target_in_fire")

    def time_factor(eid: str) -> float:
        """Class drive time over free-flow time on an open edge (1 without a profile)."""
        if access is None:
            return 1.0
        edge = roads.edges[eid]
        return edge.speed_kph / access.speed_kph(eid, edge.speed_kph)

    def class_cost(eid: str) -> float | None:
        if access is not None and not access.passable(eid):
            return None
        c = near_cost(eid)
        return None if c is None else c * time_factor(eid)

    path = _search(drill, src, dst, class_cost, factors)
    if path is None:
        if access is None:
            return fail("no_open_road")
        # Would an unrestricted vehicle get through? Then the class rules are the block.
        open_path = _search(drill, src, dst, near_cost, factors)
        if open_path is None:
            return fail("no_open_road")
        for eid in open_path:
            acc = access.edges.get(eid)
            if acc is not None and not acc.passable:
                road = roads.edges[eid].name or roads.edges[eid].highway
                return InboundResult(None, "no_access", src_m, dst_m, None, 0, acc.rule, f"{acc.note} ({road})")
        return fail("no_open_road")
    next_edge = {roads.edges[eid].from_node: eid for eid in path}
    # Route.zone_id is empty and destination_id is the target road node for an inbound route.
    route = _with_exposure(index, fire_class, _build_route(drill, index, "", src, next_edge, dst))
    drive_s = sum(index.edge_time_s[e] * time_factor(e) * factors.get(e, 1.0) for e in route.edge_ids)
    slow = sum(1 for e in route.edge_ids if factors.get(e, 1.0) > 1.0)
    return InboundResult(route, None, src_m, dst_m, drive_s, slow)


def _search(drill: Drill, src: str, dst: str, cost: Callable[[str], float | None],
            factors: Mapping[str, float]) -> list[str] | None:
    """Forward Dijkstra from ``src`` to ``dst``; the edge ids in travel order, or None."""
    roads = drill.roads
    dist: dict[str, float] = {src: 0.0}
    prev: dict[str, str] = {}
    heap: list[tuple[float, str]] = [(0.0, src)]
    done: set[str] = set()
    while heap:
        d, node = heapq.heappop(heap)
        if node in done:
            continue
        if node == dst:
            break
        done.add(node)
        for eid in roads.out_edges.get(node, ()):
            c = cost(eid)
            if c is None:
                continue
            nxt = roads.edges[eid].to_node
            nd = d + c * factors.get(eid, 1.0)
            if nd < dist.get(nxt, math.inf):
                dist[nxt] = nd
                prev[nxt] = eid
                heapq.heappush(heap, (nd, nxt))
    if dst not in dist:
        return None
    path: list[str] = []
    at = dst
    while at != src:
        eid = prev[at]
        path.append(eid)
        at = roads.edges[eid].from_node
    path.reverse()
    return path
