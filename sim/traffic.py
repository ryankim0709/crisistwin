"""Mesoscopic link-queue (spatial queue) evacuation traffic, driven by timestamped events.

Each directed edge holds a FIFO queue of vehicle packets. A packet entering an edge
becomes ready to leave after the edge's free-flow time; ready packets leave the head of
the queue at most at the edge's outflow capacity, and only if the next edge has storage
left (spillback). Vehicles route node by node to the nearest open destination by
current travel time, from a reversed multi-source Dijkstra tree that is rebuilt when
closures or destinations change and every `reroute_interval_s`. Closed edges are never
routed over. Pure computation: no file I/O, network, or wall-clock time.
"""

from __future__ import annotations

import heapq
from bisect import bisect_left, bisect_right
import math
import random
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from sim.geo import point_in_geometry
from sim.history import format_utc

MODEL_ID = "meso-link-queue"
MODEL_VERSION = "0.1.0"

DEMAND_EVENT_TYPES = ("evacuation_order", "evacuation_warning")
CLOSE_EVENT_TYPES = ("road_closed", "road_blocked")
REOPEN_EVENT_TYPES = ("road_reopened",)
SHELTER_FULL_EVENT_TYPES = ("shelter_full",)
CAPACITY_EVENT_TYPES = ("capacity_changed",)  # edge capacity = source capacity x event capacity_factor
CONTRAFLOW_START_EVENT_TYPES = ("contraflow_started",)  # edge_ids are the outbound edges
CONTRAFLOW_END_EVENT_TYPES = ("contraflow_ended",)
FIRE_CLOSURE_TIME_PRECISION = "model_step"  # closure time is the first model step the perimeter is in effect
CONGESTED_SPEED_FRACTION = 0.5  # an occupied edge is congested in a frame when mean speed < this x free-flow speed
FIRE_CACHE_MAX_GEOMETRIES = 4  # non-cumulative mode: distinct fire geometries whose edge-inside sets are kept
FIRE_INDEX_CELL_DEG = 0.01  # bucket size (about 1 km) of the spatial index over fire polygon parts

# Per-lane capacity (veh/h), free-flow speed (km/h) and lane count per direction, used only
# when the source lacks a value. Rough HCM-style planning values; the bundle labels them as assumptions.
_HIGHWAY_DEFAULTS = {
    "motorway": (2, 105.0, 2000),
    "trunk": (2, 90.0, 1800),
    "primary": (1, 72.0, 1600),
    "secondary": (1, 56.0, 1200),
    "tertiary": (1, 48.0, 1000),
    "unclassified": (1, 40.0, 700),
    "residential": (1, 40.0, 600),
    "service": (1, 24.0, 400),
    "track": (1, 16.0, 200),
}
_FALLBACK_HIGHWAY = "residential"
_LINK_DEFAULTS = (1, 48.0, 1200)  # *_link ramps

ASSUMPTIONS = [
    "Mesoscopic spatial queue: vehicles cross an edge at its free-flow speed, then queue at the downstream end; "
    "outflow is limited by edge capacity and by storage on the next edge (spillback).",
    "Vehicles are grouped into packets; packet counts are exact integers and are conserved.",
    "Every vehicle heads for the nearest open destination by current travel time, re-evaluated at every node.",
    "Route travel time is free-flow time plus the time to discharge the vehicles already on the edge.",
    "Departure after an evacuation order follows a seeded lognormal response delay; all vehicles of an ordered zone eventually depart.",
    "An edge whose midpoint lies inside the fire area in effect is exposed, and closed when close_edges_in_fire is set.",
    "With fire_area_cumulative (default), the fire area is treated as cumulative burned area: an edge once inside "
    "stays exposed and closed even if a later perimeter is smaller.",
    "Contraflow: each listed outbound edge gains the capacity and storage of its reverse twin (same segment_id), and "
    "the twin is closed to new entry; vehicles already on the twin drain out.",
]
LIMITATIONS = [
    "Not calibrated against observed Camp Fire traffic; outputs are planning experiments, not historical traffic counts.",
    "No intersection control, turning delays, lane changes, or signal timing; contraflow is a capacity transfer only.",
    "Each edge takes at least one model step to traverse, which slows very short edges.",
    "Vehicles on an edge when it closes stop until it reopens; turning back is not modelled.",
    "Vehicles waiting at an origin node are not counted as exposed; only vehicles on edges are.",
    "Warnings release no demand unless warning_releases_demand is set; spontaneous early departures are not modelled.",
    "Destination capacity is the only shelter constraint; exits have unlimited capacity.",
]


@dataclass(frozen=True)
class RoadEdge:
    """Directed road edge. A two-way road is two edges sharing segment_id. Coords are (lon, lat)."""

    id: str
    segment_id: str
    from_node: str
    to_node: str
    length_m: float
    lanes: int  # in this direction
    speed_kph: float  # free-flow
    capacity_veh_per_hour: float  # outflow capacity of the whole edge (all lanes)
    name: str
    highway: str
    bridge: bool
    coords: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class RoadNetwork:
    nodes: dict[str, tuple[float, float]]  # node id -> (lon, lat)
    edges: tuple[RoadEdge, ...]


@dataclass(frozen=True)
class DemandZone:
    id: str
    name: str
    households: int
    vehicles: int  # vehicles that evacuate once the zone is ordered
    origin_nodes: tuple[str, ...]  # vehicles are spread round-robin over these nodes
    geometry: dict  # GeoJSON Polygon/MultiPolygon


@dataclass(frozen=True)
class Destination:
    id: str
    name: str
    kind: str  # exit | shelter | temporary_refuge
    node_id: str
    coord: tuple[float, float]
    capacity_veh: int | None  # None = unlimited


@dataclass(frozen=True)
class TrafficEvent:
    id: str
    at: datetime  # aware
    type: str
    label: str
    evidence_class: str
    time_precision: str
    edge_ids: tuple[str, ...] = ()
    zone_ids: tuple[str, ...] = ()
    destination_id: str | None = None
    source_id: str = ""
    source_locator: str | None = None
    capacity_factor: float | None = None  # capacity_changed only: multiplier on the edge's source capacity


@dataclass(frozen=True)
class TrafficParams:
    step_s: int = 10  # model time step
    record_every_s: int = 60  # frame cadence; a multiple of step_s
    seed: int = 7
    packet_size_veh: int = 5  # vehicles per packet (the last packet of a zone may be smaller)
    response_delay_median_min: float = 30.0  # order -> departure, lognormal median
    response_delay_sigma: float = 0.8  # lognormal shape (sigma of ln delay)
    response_delay_max_min: float = 360.0  # draws above this are capped
    jam_density_veh_per_km_lane: float = 125.0  # storage; ~8 m per stopped vehicle
    reroute_interval_s: int = 300  # periodic route-tree rebuild with current queues
    queue_aware_routing: bool = True  # add discharge time of vehicles on an edge to its route cost
    close_edges_in_fire: bool = True
    fire_area_cumulative: bool = True  # an edge midpoint once inside the fire area stays inside (burned area only grows)
    fire_check_every_s: int = 60  # cadence of fire_area_at calls; a multiple of step_s
    warning_releases_demand: bool = False

    def __post_init__(self) -> None:
        for name in ("step_s", "record_every_s", "packet_size_veh", "reroute_interval_s", "fire_check_every_s"):
            if not isinstance(getattr(self, name), int) or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer, got {getattr(self, name)!r}")
        for name in ("record_every_s", "fire_check_every_s"):
            if getattr(self, name) % self.step_s:
                raise ValueError(f"{name} must be a multiple of step_s")
        for name in ("response_delay_median_min", "response_delay_max_min", "jam_density_veh_per_km_lane"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value > 0):
                raise ValueError(f"{name} must be positive and finite, got {value}")
        if not (math.isfinite(self.response_delay_sigma) and self.response_delay_sigma >= 0):
            raise ValueError(f"response_delay_sigma must be nonnegative, got {self.response_delay_sigma}")

    def to_dict(self) -> dict:
        return asdict(self)


def default_edge_attributes(highway: str) -> dict:
    """Assumed lanes, free-flow speed and capacity for an OSM-style highway class with unknown values."""
    if highway in _HIGHWAY_DEFAULTS:
        lanes, speed, per_lane = _HIGHWAY_DEFAULTS[highway]
        basis = highway
    elif highway.endswith("_link"):
        lanes, speed, per_lane = _LINK_DEFAULTS
        basis = "link"
    else:
        lanes, speed, per_lane = _HIGHWAY_DEFAULTS[_FALLBACK_HIGHWAY]
        basis = f"fallback:{_FALLBACK_HIGHWAY}"
    return {
        "lanes": lanes,
        "speed_kph": speed,
        "capacity_veh_per_hour": lanes * per_lane,
        "capacity_veh_per_hour_per_lane": per_lane,
        "basis": basis,
    }


def _midpoint(coords: tuple[tuple[float, float], ...]) -> tuple[float, float]:
    """Point halfway along a lon/lat polyline (local equirectangular lengths)."""
    if len(coords) == 1:
        return coords[0]
    kx = math.cos(math.radians(sum(lat for _, lat in coords) / len(coords)))
    seg = [math.hypot((x1 - x0) * kx, y1 - y0) for (x0, y0), (x1, y1) in zip(coords, coords[1:])]
    half = sum(seg) / 2
    for (p0, p1), d in zip(zip(coords, coords[1:]), seg):
        if half <= d and d > 0:
            f = half / d
            return p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])
        half -= d
    return coords[-1]


def _points_inside(geometry: dict, points: list[tuple[float, float]], candidates) -> set[int]:
    """Indexes from `candidates` whose point lies inside a GeoJSON Polygon/MultiPolygon.

    Polygon parts are bucketed on a FIRE_INDEX_CELL_DEG grid by bbox, so each point is tested
    only against parts near it; rasterized fire fronts are MultiPolygons of many small parts.
    """
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    cell = FIRE_INDEX_CELL_DEG
    buckets: dict[tuple[int, int], list[tuple]] = {}
    for poly in polygons:
        if not poly or not poly[0]:
            continue
        xs = [q[0] for q in poly[0]]
        ys = [q[1] for q in poly[0]]
        part = (min(xs), min(ys), max(xs), max(ys), {"type": "Polygon", "coordinates": poly})
        for bx in range(math.floor(part[0] / cell), math.floor(part[2] / cell) + 1):
            for by in range(math.floor(part[1] / cell), math.floor(part[3] / cell) + 1):
                buckets.setdefault((bx, by), []).append(part)
    inside = set()
    for i in candidates:
        lon, lat = points[i]
        for x0, y0, x1, y1, part in buckets.get((math.floor(lon / cell), math.floor(lat / cell)), ()):
            if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_geometry(lon, lat, part):
                inside.add(i)
                break
    return inside


def _geometry_bbox(geometry: dict) -> tuple[float, float, float, float]:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    xs = [q[0] for poly in polygons for q in poly[0]] if polygons else [0.0]
    ys = [q[1] for poly in polygons for q in poly[0]] if polygons else [0.0]
    return min(xs), min(ys), max(xs), max(ys)


def _bundle_event(
    ev_id: str, at: datetime, ev_type: str, label: str, edge_ids: list[str], *,
    evidence_class: str = "simulated", time_precision: str = FIRE_CLOSURE_TIME_PRECISION,
    source_id: str = MODEL_ID, source_locator: str | None = None,
) -> dict:
    return {
        "id": ev_id,
        "at": format_utc(at),
        "type": ev_type,
        "label": label,
        "evidence_class": evidence_class,
        "time_precision": time_precision,
        "target": {"zone_ids": [], "edge_ids": edge_ids, "destination_id": None},
        "source": {"id": source_id, "locator": source_locator},
    }


def _validate(network: RoadNetwork, zones, destinations, events, start: datetime, end: datetime) -> None:
    for value in (start, end, *(ev.at for ev in events)):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError(f"time must include a timezone: {value}")
    if end <= start:
        raise ValueError("end must be after start")
    edge_ids = set()
    for e in network.edges:
        if e.id in edge_ids:
            raise ValueError(f"duplicate edge id {e.id}")
        edge_ids.add(e.id)
        if e.from_node not in network.nodes or e.to_node not in network.nodes:
            raise ValueError(f"edge {e.id} references an unknown node")
        if not (e.length_m > 0 and e.speed_kph > 0 and e.capacity_veh_per_hour > 0 and e.lanes >= 1):
            raise ValueError(f"edge {e.id} needs positive length, speed, capacity and lanes")
    zone_ids = set()
    for z in zones:
        if z.id in zone_ids:
            raise ValueError(f"duplicate zone id {z.id}")
        zone_ids.add(z.id)
        if z.vehicles < 0 or z.households < 0:
            raise ValueError(f"zone {z.id} has negative counts")
        if z.vehicles and not z.origin_nodes:
            raise ValueError(f"zone {z.id} has vehicles but no origin nodes")
        for n in z.origin_nodes:
            if n not in network.nodes:
                raise ValueError(f"zone {z.id} origin node {n} is not in the network")
    dest_ids = set()
    for d in destinations:
        if d.id in dest_ids:
            raise ValueError(f"duplicate destination id {d.id}")
        dest_ids.add(d.id)
        if d.node_id not in network.nodes:
            raise ValueError(f"destination {d.id} node {d.node_id} is not in the network")
        if d.capacity_veh is not None and d.capacity_veh < 0:
            raise ValueError(f"destination {d.id} has negative capacity")
    if not destinations:
        raise ValueError("at least one destination is required")
    for ev in events:
        unknown = [x for x in ev.edge_ids if x not in edge_ids] + [x for x in ev.zone_ids if x not in zone_ids]
        if ev.destination_id is not None and ev.destination_id not in dest_ids:
            unknown.append(ev.destination_id)
        if unknown:
            raise ValueError(f"event {ev.id} references unknown ids: {unknown}")
        if ev.type in CAPACITY_EVENT_TYPES and ev.edge_ids:
            if ev.capacity_factor is None or not (math.isfinite(ev.capacity_factor) and ev.capacity_factor > 0):
                raise ValueError(f"event {ev.id} needs a positive capacity_factor (use road_closed for zero capacity)")


def simulate_traffic(
    network: RoadNetwork,
    zones: tuple[DemandZone, ...] | list[DemandZone],
    destinations: tuple[Destination, ...] | list[Destination],
    events: tuple[TrafficEvent, ...] | list[TrafficEvent],
    params: TrafficParams,
    *,
    start: datetime,
    end: datetime,
    fire_area_at: Callable[[datetime], dict | None] | None = None,
) -> dict:
    """Run the link-queue model from start to end; return the bundle `traffic` block plus
    `generated_events`, `assumptions` and `limitations`.

    Events at or before a step's time take effect at that step; orders issued before
    `start` still release demand (departures already due leave at `start`).
    """
    _validate(network, zones, destinations, events, start, end)
    step = params.step_s
    horizon_s = int((end - start).total_seconds())
    n_steps = horizon_s // step

    # --- network arrays (index-based for speed)
    node_ids = sorted(network.nodes)
    node_ix = {n: i for i, n in enumerate(node_ids)}
    edges = network.edges
    n_edges = len(edges)
    e_from = [node_ix[e.from_node] for e in edges]
    e_to = [node_ix[e.to_node] for e in edges]
    e_fft = [e.length_m / (e.speed_kph / 3.6) for e in edges]
    e_cap_step = [e.capacity_veh_per_hour * step / 3600 for e in edges]
    # Credit is capped so an idle edge can release at most one full packet (or one step's capacity) at once.
    e_credit_max = [max(c, params.packet_size_veh) for c in e_cap_step]
    # An edge always stores at least one packet, so very short edges cannot deadlock.
    e_storage = [
        max(params.packet_size_veh, e.length_m / 1000 * e.lanes * params.jam_density_veh_per_km_lane) for e in edges
    ]
    e_base_vph = [e.capacity_veh_per_hour for e in edges]
    e_base_storage = list(e_storage)
    cap_factor: dict[int, float] = {}  # edge -> capacity_changed factor
    seg_dir = {(e.segment_id, e.from_node, e.to_node): i for i, e in enumerate(edges)}
    twin = [seg_dir.get((e.segment_id, e.to_node, e.from_node)) for e in edges]
    contraflow_out: dict[int, int] = {}  # outbound edge -> reverse twin it borrows lanes from
    contraflow_in: set[int] = set()  # reverse twins closed to new entry by contraflow
    e_mid = [_midpoint(e.coords) if e.coords else network.nodes[e.from_node] for e in edges]
    mid_order = sorted(range(n_edges), key=lambda i: e_mid[i][0])  # edges by midpoint longitude
    mid_lons = [e_mid[i][0] for i in mid_order]
    in_edges: list[list[int]] = [[] for _ in node_ids]
    for i in range(n_edges):
        in_edges[e_to[i]].append(i)

    queue: list[deque] = [deque() for _ in range(n_edges)]  # packets: [count, ready_at_s, zone index]
    occ = [0] * n_edges
    credit = [0.0] * n_edges
    active: set[int] = set()

    # --- destinations
    dest_list = list(destinations)
    dest_arrived = [0] * len(dest_list)
    dest_full = [d.capacity_veh is not None and d.capacity_veh <= 0 for d in dest_list]
    dest_full_s: list[float | None] = [0.0 if f else None for f in dest_full]
    dest_ix = {d.id: i for i, d in enumerate(dest_list)}
    dests_at_node: dict[int, list[int]] = {}
    for i, d in enumerate(dest_list):
        dests_at_node.setdefault(node_ix[d.node_id], []).append(i)

    # --- demand: draw every packet's delay up front so draws do not depend on event handling.
    rng = random.Random(params.seed)
    mu = math.log(params.response_delay_median_min * 60)
    delay_cap_s = params.response_delay_max_min * 60
    zone_packets: dict[str, list[tuple[float, int, int]]] = {}  # zone -> [(delay_s, origin node, count)]
    zone_list = list(zones)
    zone_ix = {z.id: i for i, z in enumerate(zone_list)}
    zone_departures: list[list[list]] = [[] for _ in zone_list]  # per zone: [[t_s, veh], ...] by step
    zone_arrivals: list[list[list]] = [[] for _ in zone_list]
    for z in zones:
        packets = []
        full, rest = divmod(z.vehicles, params.packet_size_veh)
        counts = [params.packet_size_veh] * full + ([rest] if rest else [])
        for k, count in enumerate(counts):
            delay = min(delay_cap_s, rng.lognormvariate(mu, params.response_delay_sigma))
            packets.append((delay, node_ix[z.origin_nodes[k % len(z.origin_nodes)]], count))
        zone_packets[z.id] = packets
    total_veh = sum(z.vehicles for z in zones)
    pending: list[tuple[float, int, int, int, int]] = []  # (depart_s, seq, node, count, zone index)
    seq = 0
    released_zones: set[str] = set()
    first_order_s: float | None = None
    waiting: dict[int, deque] = {}  # origin node -> departed packets [count, zone index] not yet on an edge

    not_departed = total_veh
    arrived = 0
    last_arrival_s: float | None = None

    # --- events
    ev_sorted = sorted(events, key=lambda ev: (ev.at, ev.id))
    ev_s = [(ev.at - start).total_seconds() for ev in ev_sorted]
    ev_next = 0
    event_closed: set[int] = set()
    edge_index = {e.id: i for i, e in enumerate(edges)}

    # --- fire
    fire_closed: set[int] = set()
    exposed_edges: frozenset[int] | set[int] = frozenset()
    fire_geom: dict | None = None
    # id(geometry) -> (geometry, edges inside); insertion-ordered for eviction. Holding the geometry
    # keeps its id from being reused while cached, so identity is a safe, cheap key.
    fire_cache: dict[int, tuple[dict, frozenset[int]]] = {}
    generated: list[dict] = []

    closed = [False] * n_edges
    closed_set: set[int] = set()
    closed_hard: set[int] = set()  # closed to entry and exit; contraflow-closed edges may still drain
    closed_list: list[int] = []  # sorted; rebuilt only when closures change
    next_edge = [-1] * len(node_ids)
    routes_dirty = True
    next_reroute_s = 0

    def refresh_capacity(i: int) -> None:
        vph = e_base_vph[i] * cap_factor.get(i, 1.0)
        storage = e_base_storage[i]
        if i in contraflow_out:
            vph += e_base_vph[contraflow_out[i]]
            storage += e_base_storage[contraflow_out[i]]
        e_cap_step[i] = vph * step / 3600
        e_credit_max[i] = max(e_cap_step[i], params.packet_size_veh)
        e_storage[i] = storage

    def rebuild_routes() -> None:
        """Reversed multi-source Dijkstra from all open destinations over open edges.

        Equivalent to taking, per node, the minimum over per-destination trees, in one pass.
        """
        dist = [math.inf] * len(node_ids)
        nxt = [-1] * len(node_ids)
        heap = []
        for node, ds in dests_at_node.items():
            if any(not dest_full[d] for d in ds):
                dist[node] = 0.0
                heap.append((0.0, node))
        heapq.heapify(heap)
        while heap:
            d, v = heapq.heappop(heap)
            if d > dist[v]:
                continue
            for e in in_edges[v]:
                if closed[e]:
                    continue
                cost = e_fft[e]
                if params.queue_aware_routing and occ[e]:
                    cost += occ[e] / e_cap_step[e] * step
                u = e_from[e]
                nd = d + cost
                if nd < dist[u]:
                    dist[u] = nd
                    nxt[u] = e
                    heapq.heappush(heap, (nd, u))
        next_edge[:] = nxt

    def open_dest_at(node: int) -> int | None:
        for d in dests_at_node.get(node, ()):
            if not dest_full[d]:
                return d
        return None

    def add_series(series: list[list], t: int, n: int) -> None:
        if series and series[-1][0] == t:
            series[-1][1] += n
        else:
            series.append([t, n])

    def mark_full(d: int, t: float) -> None:
        nonlocal routes_dirty
        if not dest_full[d]:
            dest_full[d] = True
            dest_full_s[d] = t
            routes_dirty = True

    def accept(d: int, count: int, zone: int, t: int) -> int:
        """Admit up to `count` vehicles at destination d; return how many were admitted."""
        nonlocal arrived, last_arrival_s
        cap = dest_list[d].capacity_veh
        n = count if cap is None else min(count, cap - dest_arrived[d])
        if n > 0:
            dest_arrived[d] += n
            arrived += n
            last_arrival_s = t
            add_series(zone_arrivals[zone], t, n)
        if cap is not None and dest_arrived[d] >= cap:
            mark_full(d, t)
        return n

    def enter(i: int, count: int, zone: int, t: int) -> None:
        if not occ[i]:
            credit[i] = e_credit_max[i]  # an idle edge starts with full discharge credit
        queue[i].append([count, t + e_fft[i], zone])
        occ[i] += count
        active.add(i)

    def release_zone(zone_id: str, at_s: float) -> None:
        nonlocal seq, first_order_s
        if zone_id in released_zones:
            return
        released_zones.add(zone_id)
        first_order_s = at_s if first_order_s is None else min(first_order_s, at_s)
        for delay, node, count in zone_packets[zone_id]:
            heapq.heappush(pending, (at_s + delay, seq, node, count, zone_ix[zone_id]))
            seq += 1

    def set_fire(geom: dict | None, at: datetime) -> None:
        nonlocal fire_geom, exposed_edges, fire_closed, routes_dirty
        if geom is fire_geom:
            return
        fire_geom = geom
        if geom is None:
            inside = set(exposed_edges) if params.fire_area_cumulative else frozenset()
        elif params.fire_area_cumulative:
            # Test only edges not yet inside and within the geometry's bbox; earlier hits stay inside.
            x0, y0, x1, y1 = _geometry_bbox(geom)
            candidates = (
                i for i in mid_order[bisect_left(mid_lons, x0):bisect_right(mid_lons, x1)]
                if i not in exposed_edges and y0 <= e_mid[i][1] <= y1
            )
            inside = set(exposed_edges) | _points_inside(geom, e_mid, candidates)
        else:
            cached = fire_cache.get(id(geom))
            if cached is None or cached[0] is not geom:
                x0, y0, x1, y1 = _geometry_bbox(geom)
                candidates = (
                    i for i in mid_order[bisect_left(mid_lons, x0):bisect_right(mid_lons, x1)]
                    if y0 <= e_mid[i][1] <= y1
                )
                inside = frozenset(_points_inside(geom, e_mid, candidates))
                fire_cache[id(geom)] = (geom, inside)
                while len(fire_cache) > FIRE_CACHE_MAX_GEOMETRIES:
                    del fire_cache[next(iter(fire_cache))]
            else:
                inside = cached[1]
        exposed_edges = inside
        if not params.close_edges_in_fire:
            return
        newly_closed, reopened = inside - fire_closed, fire_closed - inside
        for ev_type, group, verb in (("road_closed", newly_closed, "closure"), ("road_reopened", reopened, "reopening")):
            by_name: dict[str, list[str]] = {}
            for i in sorted(group):
                by_name.setdefault(edges[i].name, []).append(edges[i].id)
            for name in sorted(by_name):
                ev_id = f"sim-fire-{verb}-{len(generated) + 1}"
                generated.append(_bundle_event(ev_id, at, ev_type, f"Modelled fire {verb}: {name}", by_name[name]))
        if newly_closed or reopened:
            fire_closed = set(inside)
            routes_dirty = True

    frames: list[dict] = []
    metrics: list[dict] = []
    edge_ids_out = [e.id for e in edges]
    peaks = {"en_route_veh": 0, "blocked_veh": 0, "exposed_veh": 0}
    edge_peak: dict[int, list] = {}  # edge index -> [peak_veh, peak_t_s, min_speed_kph, congested_frames]

    def record(t: int, at: datetime) -> None:
        frame_edges = []
        blocked = 0
        for i in sorted(active):
            moving = sum(c for c, ready, _ in queue[i] if ready > t)
            stopped = closed[i] and i in closed_hard
            speed = 0.0 if stopped else edges[i].speed_kph * moving / occ[i]
            frame_edges.append([i, occ[i], round(speed, 1)])
            stat = edge_peak.setdefault(i, [0, t, math.inf, 0])
            if occ[i] > stat[0]:
                stat[0], stat[1] = occ[i], t
            stat[2] = min(stat[2], speed)
            if speed < CONGESTED_SPEED_FRACTION * edges[i].speed_kph:
                stat[3] += 1
            if stopped or (next_edge[e_to[i]] == -1 and open_dest_at(e_to[i]) is None):
                blocked += occ[i]
        for node, q in waiting.items():
            if q and next_edge[node] == -1 and open_dest_at(node) is None:
                blocked += sum(c for c, _ in q)
        exposed = sum(occ[i] for i in active if i in exposed_edges)
        en_route = total_veh - not_departed - arrived
        if not (min(not_departed, en_route, arrived) >= 0 and not_departed + en_route + arrived == total_veh):
            raise AssertionError(f"population not conserved at {format_utc(at)}")
        on_edges = sum(occ[i] for i in active)
        in_wait = sum(c for q in waiting.values() for c, _ in q)
        if on_edges + in_wait != en_route or blocked > en_route or exposed > en_route:
            raise AssertionError(f"inconsistent vehicle states at {format_utc(at)}")
        frames.append({
            "at": format_utc(at),
            "edges": frame_edges,
            "closed": closed_list,
        })
        metrics.append({
            "at": format_utc(at),
            "not_departed_veh": not_departed,
            "en_route_veh": en_route,
            "arrived_veh": arrived,
            "blocked_veh": blocked,
            "exposed_veh": exposed,
        })
        for key, value in (("en_route_veh", en_route), ("blocked_veh", blocked), ("exposed_veh", exposed)):
            peaks[key] = max(peaks[key], value)

    for k in range(n_steps + 1):
        t = k * step
        at = start + timedelta(seconds=t)

        # 1. events due by now
        closures_changed = False
        while ev_next < len(ev_sorted) and ev_s[ev_next] <= t:
            ev = ev_sorted[ev_next]
            ev_next += 1
            if ev.type == "evacuation_order" or (ev.type == "evacuation_warning" and params.warning_releases_demand):
                for z in ev.zone_ids:
                    release_zone(z, ev_s[ev_next - 1])
            elif ev.type in CLOSE_EVENT_TYPES:
                event_closed.update(edge_index[x] for x in ev.edge_ids)
                closures_changed = True
            elif ev.type in REOPEN_EVENT_TYPES:
                event_closed.difference_update(edge_index[x] for x in ev.edge_ids)
                closures_changed = True
            elif ev.type in SHELTER_FULL_EVENT_TYPES and ev.destination_id is not None:
                mark_full(dest_ix[ev.destination_id], ev_s[ev_next - 1])
            elif ev.type in CAPACITY_EVENT_TYPES and ev.edge_ids:
                for x in ev.edge_ids:
                    cap_factor[edge_index[x]] = ev.capacity_factor
                    refresh_capacity(edge_index[x])
                routes_dirty = True
            elif ev.type in CONTRAFLOW_START_EVENT_TYPES:
                inbound = []
                for x in ev.edge_ids:
                    i = edge_index[x]
                    j = twin[i]
                    # One-way roads have no twin; an edge already lending or borrowing lanes is left as is.
                    if j is None or i in contraflow_out or i in contraflow_in or j in contraflow_out:
                        continue
                    contraflow_out[i] = j
                    contraflow_in.add(j)
                    refresh_capacity(i)
                    inbound.append(j)
                if inbound:
                    names = ", ".join(sorted({edges[j].name for j in inbound}))
                    generated.append(_bundle_event(
                        f"{ev.id}-inbound-closed", ev.at, "road_closed",
                        f"Contraflow inbound lanes closed (derived from {ev.id}): {names}",
                        [edges[j].id for j in inbound], evidence_class="derived",
                        time_precision=ev.time_precision, source_id=ev.source_id, source_locator=ev.source_locator,
                    ))
                    closures_changed = True
            elif ev.type in CONTRAFLOW_END_EVENT_TYPES:
                for x in ev.edge_ids:
                    i = edge_index[x]
                    if i in contraflow_out:
                        contraflow_in.discard(contraflow_out.pop(i))
                        refresh_capacity(i)
                        closures_changed = True
        # 2. fire area in effect
        if fire_area_at is not None and t % params.fire_check_every_s == 0:
            set_fire(fire_area_at(at), at)
        if closures_changed or routes_dirty:
            closed_hard = event_closed | fire_closed
            union = closed_hard | contraflow_in
            if union != closed_set:
                for i in union ^ closed_set:
                    closed[i] = i in union
                closed_set = union
                closed_list = sorted(union)
                closures_changed = True
        # 3. routes
        if routes_dirty or closures_changed or t >= next_reroute_s:
            rebuild_routes()
            routes_dirty = False
            next_reroute_s = t + params.reroute_interval_s

        # 4. departures due by now join their origin node
        while pending and pending[0][0] <= t:
            _, _, node, count, zone = heapq.heappop(pending)
            not_departed -= count
            add_series(zone_departures[zone], t, count)
            waiting.setdefault(node, deque()).append([count, zone])

        # 5. move packets off edges, in edge-index order
        for i in sorted(active):
            q = queue[i]
            credit[i] = min(credit[i] + e_cap_step[i], e_credit_max[i])
            if closed[i] and i in closed_hard:
                continue
            node = e_to[i]
            while q:
                count, ready, zone = q[0]
                if ready > t or credit[i] < count:
                    break
                d = open_dest_at(node)
                if d is not None:
                    n = accept(d, count, zone, t)
                    credit[i] -= n
                    occ[i] -= n
                    if n < count:
                        q[0][0] = count - n
                        break  # remainder waits for the route rebuild at the next step
                    q.popleft()
                    continue
                ne = next_edge[node]
                if ne == -1 or (occ[ne] and occ[ne] + count > e_storage[ne]):
                    break
                q.popleft()
                credit[i] -= count
                occ[i] -= count
                enter(ne, count, zone, t)
            if not q:
                active.discard(i)

        # 6. departed packets enter their first edge
        for node in sorted(waiting):
            wq = waiting[node]
            while wq:
                count, zone = wq[0]
                d = open_dest_at(node)
                if d is not None:
                    n = accept(d, count, zone, t)
                    if n < count:
                        wq[0][0] = count - n
                        break
                    wq.popleft()
                    continue
                ne = next_edge[node]
                if ne == -1 or (occ[ne] and occ[ne] + count > e_storage[ne]):
                    break
                wq.popleft()
                enter(ne, count, zone, t)
            if not wq:
                del waiting[node]

        if t % params.record_every_s == 0:
            record(t, at)

    def iso(t_s: float) -> str:
        return format_utc(start + timedelta(seconds=t_s))

    all_arrived = arrived == total_veh and total_veh > 0
    clearance = None
    if all_arrived and first_order_s is not None and last_arrival_s is not None:
        clearance = int(last_arrival_s - first_order_s)

    return {
        "evidence_class": "simulated",
        "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict(), "seed": params.seed},
        "edge_ids": edge_ids_out,
        "frames": frames,
        "metrics": metrics,
        "summary": {
            "total_veh": total_veh,
            "clearance_time_s": clearance,
            "max_exposed_veh": peaks["exposed_veh"],
            "max_en_route_veh": peaks["en_route_veh"],
            "max_blocked_veh": peaks["blocked_veh"],
            "arrived_veh": arrived,
            "not_departed_veh": not_departed,
            "first_order_at": None if first_order_s is None else format_utc(start + timedelta(seconds=first_order_s)),
            "last_arrival_at": None if last_arrival_s is None else format_utc(start + timedelta(seconds=last_arrival_s)),
            "arrived_by_destination_veh": {d.id: dest_arrived[i] for i, d in enumerate(dest_list)},
        },
        "diagnostics": {
            "congested_speed_fraction": CONGESTED_SPEED_FRACTION,
            "edge_stats_sampled_every_s": params.record_every_s,  # edge stats come from recorded frames
            "zone_stats": {
                z.id: {
                    "departures": [[iso(t), n] for t, n in zone_departures[k]],
                    "arrivals": [[iso(t), n] for t, n in zone_arrivals[k]],
                }
                for k, z in enumerate(zone_list)
            },
            "edge_stats": [
                {
                    "edge_index": i,
                    "edge_id": edges[i].id,
                    "peak_veh": stat[0],
                    "peak_at": iso(stat[1]),
                    "min_speed_kph": round(stat[2], 1),
                    "minutes_congested": stat[3] * params.record_every_s / 60,
                }
                for i, stat in sorted(edge_peak.items())
            ],
            "destination_stats": {
                d.id: {
                    "arrived_veh": dest_arrived[k],
                    "full_at": None if dest_full_s[k] is None else iso(dest_full_s[k]),
                }
                for k, d in enumerate(dest_list)
            },
        },
        "generated_events": generated,
        "assumptions": list(ASSUMPTIONS),
        "limitations": list(LIMITATIONS),
    }
