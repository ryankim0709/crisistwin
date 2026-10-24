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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from types import MappingProxyType

from sim import behavior as bh
from sim.behavior import BehaviorParams
from sim.geo import EARTH_RADIUS_M, point_in_geometry
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
    "exposed_at_origin_veh counts vehicles not yet departed whose origin node lies inside the fire area in effect "
    "(cumulative like edge exposure); exposed_veh counts only vehicles on edges.",
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
_FIXED_DELAY_ASSUMPTION = ASSUMPTIONS[4]  # replaced by sim.behavior.ASSUMPTIONS when agents are on
_FIXED_DELAY_LIMITATIONS = (LIMITATIONS[3], LIMITATIONS[5])  # turning back and warnings are modelled by agents


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
    warning_releases_demand: bool = False  # fixed-delay engine only; agents respond to warnings via a hazard
    behavior: BehaviorParams = field(default_factory=BehaviorParams)

    def __post_init__(self) -> None:
        if not isinstance(self.behavior, BehaviorParams):
            raise ValueError("behavior must be a BehaviorParams")
        if self.behavior.enabled and self.behavior.decision_every_s % self.step_s:
            raise ValueError("behavior.decision_every_s must be a multiple of step_s")
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
        d = asdict(self)
        if not self.behavior.enabled:
            d.pop("behavior")  # replay outputs carry no agent parameters
        return d


@dataclass(frozen=True)
class ZoneView:
    id: str
    name: str
    vehicles: int
    ordered_at: datetime | None  # first order applied so far
    warned_at: datetime | None  # first warning applied so far
    waiting_veh: int
    preparing_veh: int
    departed_veh: int  # everyone who has left, including those who have since arrived
    arrived_veh: int


@dataclass(frozen=True)
class TrafficView:
    """Read-only snapshot handed to controllers. Mappings are MappingProxyType."""

    at: datetime
    network: RoadNetwork
    edge_veh: Mapping[str, int]  # occupied edges only
    edge_speed_ratio: Mapping[str, float]  # occupied edges only; mean speed / free-flow, 0.0 if stopped
    closed_edge_ids: frozenset[str]  # closed by events, fire, or contraflow inbound
    exposed_edge_ids: frozenset[str]  # edge midpoint inside the fire area in effect
    zones: Mapping[str, ZoneView]
    full_destination_ids: frozenset[str]
    metrics: Mapping[str, int]
    fire_area: dict | None
    elapsed_s: int = 0  # model seconds since start
    contraflow_outbound_edge_ids: frozenset[str] = frozenset()  # edges currently borrowing their twin's lanes


# A controller sees the state at a tick and returns events to apply immediately (see simulate_traffic).
Controller = Callable[[datetime, TrafficView], Sequence[TrafficEvent]]


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
    zone_ids: list[str] | None = None, destination_id: str | None = None,
) -> dict:
    return {
        "id": ev_id,
        "at": format_utc(at),
        "type": ev_type,
        "label": label,
        "evidence_class": evidence_class,
        "time_precision": time_precision,
        "target": {"zone_ids": zone_ids or [], "edge_ids": edge_ids, "destination_id": destination_id},
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
        _check_event_targets(ev, edge_ids, zone_ids, dest_ids)


def _check_event_targets(ev: TrafficEvent, edge_ids, zone_ids, dest_ids) -> None:
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
    controllers: Sequence[Controller] = (),
    controller_every_s: int = 60,
) -> dict:
    """Run the link-queue model from start to end; return the bundle `traffic` block plus
    `generated_events`, `assumptions` and `limitations`.

    Events at or before a step's time take effect at that step; orders issued before
    `start` still release demand (departures already due leave at `start`).

    Controllers run every `controller_every_s` (a multiple of step_s) after scheduled events
    and the fire update, all on one TrafficView built for that tick, in sequence order. The
    events they return must be timezone-aware with start <= at <= the tick time and unique
    ids; they are applied immediately like scheduled events and appended to
    `generated_events` with their own evidence_class and label.
    """
    _validate(network, zones, destinations, events, start, end)
    if controllers and (not isinstance(controller_every_s, int) or controller_every_s <= 0
                        or controller_every_s % params.step_s):
        raise ValueError("controller_every_s must be a positive multiple of step_s")
    bp = params.behavior
    agents_on = bp.enabled
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

    queue: list[deque] = [deque() for _ in range(n_edges)]  # packets: [count, ready_at_s, zone index, agent]
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

    # --- demand
    zone_list = list(zones)
    n_zones = len(zone_list)
    zone_ix = {z.id: i for i, z in enumerate(zone_list)}
    zone_departures: list[list[list]] = [[] for _ in zone_list]  # per zone: [[t_s, veh], ...] by step
    zone_arrivals: list[list[list]] = [[] for _ in zone_list]
    z_waiting = [z.vehicles for z in zone_list]  # vehicle counts by state, per zone
    z_preparing = [0] * n_zones
    z_departed = [0] * n_zones
    z_arrived = [0] * n_zones
    z_ordered_s: list[float | None] = [None] * n_zones
    z_warned_s: list[float | None] = [None] * n_zones
    zone_packets: dict[str, list[tuple[float, int, int]]] = {}  # fixed-delay engine: zone -> [(delay_s, node, count)]
    # Agent arrays (behaviour on): one agent per packet.
    ag_zone: list[int] = []
    ag_node: list[int] = []
    ag_count: list[int] = []
    ag_wait_fire: list[bool] = []
    ag_herd: list[bool] = []
    ag_trigger: list[str | None] = []
    ag_turn_edge: list[int] = []  # edge on which the agent last made its turn-back decision
    zone_waiting_agents: list[list[int]] = [[] for _ in zone_list]
    z_trigger_veh = [dict.fromkeys(bh.TRIGGERS, 0) for _ in zone_list]
    if not agents_on:
        # Draw every packet's delay up front so draws do not depend on event handling.
        rng = random.Random(params.seed)
        mu = math.log(params.response_delay_median_min * 60)
        delay_cap_s = params.response_delay_max_min * 60
        for z in zones:
            packets = []
            full, rest = divmod(z.vehicles, params.packet_size_veh)
            counts = [params.packet_size_veh] * full + ([rest] if rest else [])
            for k, count in enumerate(counts):
                delay = min(delay_cap_s, rng.lognormvariate(mu, params.response_delay_sigma))
                packets.append((delay, node_ix[z.origin_nodes[k % len(z.origin_nodes)]], count))
            zone_packets[z.id] = packets
    else:
        brng = random.Random(f"{params.seed}:behavior")  # own stream; str seeds are stable across processes
        for zi, z in enumerate(zone_list):
            full, rest = divmod(z.vehicles, params.packet_size_veh)
            counts = [params.packet_size_veh] * full + ([rest] if rest else [])
            for k, count in enumerate(counts):
                zone_waiting_agents[zi].append(len(ag_zone))
                ag_zone.append(zi)
                ag_node.append(node_ix[z.origin_nodes[k % len(z.origin_nodes)]])
                ag_count.append(count)
                ag_wait_fire.append(brng.random() < bp.wait_for_fire_share)
                ag_herd.append(brng.random() < bp.herding_prob)
                ag_trigger.append(None)
                ag_turn_edge.append(-1)
        prep_mu = math.log(bp.prep_median_min * 60)
        prep_cap_s = bp.prep_max_min * 60
    total_veh = sum(z.vehicles for z in zones)
    nd_at_node: dict[int, int] = {}  # origin node -> vehicles not yet departed from it
    if agents_on:
        for a, n in enumerate(ag_node):
            nd_at_node[n] = nd_at_node.get(n, 0) + ag_count[a]
    else:
        for packets in zone_packets.values():
            for _, n, count in packets:
                nd_at_node[n] = nd_at_node.get(n, 0) + count
    origin_order = sorted(nd_at_node, key=lambda n: network.nodes[node_ids[n]][0])
    origin_lons = [network.nodes[node_ids[n]][0] for n in origin_order]
    origin_pts = {n: network.nodes[node_ids[n]] for n in nd_at_node}
    origin_burned: set[int] = set()  # origin nodes inside the fire area in effect (cumulative per fire_area_cumulative)
    pending: list[tuple[float, int, int, int, int]] = []  # fixed delay: (depart_s, seq, node, count, zone index)
    preparing: list[tuple[float, int]] = []  # agents: (depart_s, agent)
    returning: list[tuple[float, int, int, int, int, int]] = []  # turned back: (at_s, seq, node, count, zone, agent)
    seq = 0
    released_zones: set[str] = set()
    first_order_s: float | None = None
    waiting: dict[int, deque] = {}  # node -> departed packets [count, zone index, agent] not yet on an edge
    departed_by = dict.fromkeys(bh.TRIGGERS, 0)
    turned_back = 0
    zone_memory: list[dict[int, int]] = [{} for _ in zone_list]  # herding: node -> edge zone-mates last took

    not_departed = total_veh
    arrived = 0
    last_arrival_s: float | None = None

    # --- fire cues: origin nodes bucketed so burned points can mark origins within fire_cue_distance_m
    fire_cued = bytearray(len(node_ids))
    zone_cued = [False] * n_zones
    node_zones: dict[int, set[int]] = {}
    cue_buckets: dict[tuple[int, int], list[int]] = {}
    if agents_on and fire_area_at is not None:
        lats = [lat for _, lat in network.nodes.values()]
        m_lat = math.radians(1) * EARTH_RADIUS_M
        m_lon = m_lat * math.cos(math.radians((min(lats) + max(lats)) / 2))
        cue_d = max(bp.fire_cue_distance_m, 1.0)
        cell_lon, cell_lat = cue_d / m_lon, cue_d / m_lat
        for a, n in enumerate(ag_node):
            node_zones.setdefault(n, set()).add(ag_zone[a])
        for n in sorted(node_zones):
            lon, lat = network.nodes[node_ids[n]]
            cue_buckets.setdefault((math.floor(lon / cell_lon), math.floor(lat / cell_lat)), []).append(n)
        node_pts = [network.nodes[n] for n in node_ids]
        node_order = sorted(range(len(node_ids)), key=lambda i: node_pts[i][0])
        node_lons = [node_pts[i][0] for i in node_order]
    burned_nodes: set[int] = set()

    def cue_from_points(points) -> None:
        for lon, lat in points:
            bx, by = math.floor(lon / cell_lon), math.floor(lat / cell_lat)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for n in cue_buckets.get((bx + dx, by + dy), ()):
                        if fire_cued[n]:
                            continue
                        nlon, nlat = network.nodes[node_ids[n]]
                        if math.hypot((nlon - lon) * m_lon, (nlat - lat) * m_lat) <= cue_d:
                            fire_cued[n] = 1
                            for zi in node_zones[n]:
                                zone_cued[zi] = True

    def update_fire_cues(geom: dict) -> None:
        """Mark origins near newly burned road nodes or near the fire boundary (cues are cumulative)."""
        x0, y0, x1, y1 = _geometry_bbox(geom)
        candidates = (
            i for i in node_order[bisect_left(node_lons, x0):bisect_right(node_lons, x1)]
            if i not in burned_nodes and y0 <= node_pts[i][1] <= y1
        )
        newly = _points_inside(geom, node_pts, candidates)
        burned_nodes.update(newly)
        polygons = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        cue_from_points([node_pts[i] for i in sorted(newly)])
        cue_from_points((q[0], q[1]) for poly in polygons if poly for q in poly[0])

    # --- events
    ev_sorted = sorted(events, key=lambda ev: (ev.at, ev.id))
    ev_s = [(ev.at - start).total_seconds() for ev in ev_sorted]
    ev_next = 0
    event_closed: set[int] = set()
    edge_index = {e.id: i for i, e in enumerate(edges)}
    used_event_ids = {ev.id for ev in events}

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
    route_dist = [math.inf] * len(node_ids)  # current route cost to the nearest open destination
    routes_dirty = True
    closures_changed = False
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
        With agents, open fire-exposed edges carry bp.fire_edge_penalty_s.
        """
        dist = [math.inf] * len(node_ids)
        nxt = [-1] * len(node_ids)
        heap = []
        for node, ds in dests_at_node.items():
            if any(not dest_full[d] for d in ds):
                dist[node] = 0.0
                heap.append((0.0, node))
        heapq.heapify(heap)
        penalize = agents_on and bp.fire_edge_penalty_s > 0 and bool(exposed_edges)
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
                if penalize and e in exposed_edges:
                    cost += bp.fire_edge_penalty_s
                u = e_from[e]
                nd = d + cost
                if nd < dist[u]:
                    dist[u] = nd
                    nxt[u] = e
                    heapq.heappush(heap, (nd, u))
        next_edge[:] = nxt
        route_dist[:] = dist

    def open_dest_at(node: int) -> int | None:
        for d in dests_at_node.get(node, ()):
            if not dest_full[d]:
                return d
        return None

    def choose(node: int, zone: int, agent: int) -> int:
        """Next edge from node: the route tree, or for a herding agent its zone-mates' last choice."""
        ne = next_edge[node]
        if ag_herd[agent]:
            m = zone_memory[zone].get(node)
            if (m is not None and m != ne and not closed[m] and m not in exposed_edges
                    and route_dist[e_to[m]] < route_dist[node]):
                return m
        return ne

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
            z_arrived[zone] += n
            last_arrival_s = t
            add_series(zone_arrivals[zone], t, n)
        if cap is not None and dest_arrived[d] >= cap:
            mark_full(d, t)
        return n

    def enter(i: int, count: int, zone: int, agent: int, t: int) -> None:
        if not occ[i]:
            credit[i] = e_credit_max[i]  # an idle edge starts with full discharge credit
        queue[i].append([count, t + e_fft[i], zone, agent])
        occ[i] += count
        active.add(i)

    def release_zone(zone_id: str, at_s: float) -> None:
        nonlocal seq, first_order_s
        if zone_id in released_zones:
            return
        released_zones.add(zone_id)
        first_order_s = at_s if first_order_s is None else min(first_order_s, at_s)
        zi = zone_ix[zone_id]
        z_preparing[zi], z_waiting[zi] = z_waiting[zi], 0
        for delay, node, count in zone_packets[zone_id]:
            heapq.heappush(pending, (at_s + delay, seq, node, count, zi))
            seq += 1

    def apply_event(ev: TrafficEvent, at_s: float) -> None:
        nonlocal closures_changed, routes_dirty, first_order_s
        if not agents_on and (
                ev.type == "evacuation_order" or (ev.type == "evacuation_warning" and params.warning_releases_demand)):
            for z in ev.zone_ids:
                release_zone(z, at_s)
        elif agents_on and ev.type in DEMAND_EVENT_TYPES:
            notice = z_ordered_s if ev.type == "evacuation_order" else z_warned_s
            for z in ev.zone_ids:
                zi = zone_ix[z]
                if notice[zi] is None:
                    notice[zi] = at_s
            if ev.type == "evacuation_order" and ev.zone_ids:
                first_order_s = at_s if first_order_s is None else min(first_order_s, at_s)
        elif ev.type in CLOSE_EVENT_TYPES:
            event_closed.update(edge_index[x] for x in ev.edge_ids)
            closures_changed = True
        elif ev.type in REOPEN_EVENT_TYPES:
            event_closed.difference_update(edge_index[x] for x in ev.edge_ids)
            closures_changed = True
        elif ev.type in SHELTER_FULL_EVENT_TYPES and ev.destination_id is not None:
            mark_full(dest_ix[ev.destination_id], at_s)
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
        if geom is None:
            if not params.fire_area_cumulative:
                origin_burned.clear()
        else:
            x0, y0, x1, y1 = _geometry_bbox(geom)
            if not params.fire_area_cumulative:
                origin_burned.clear()
            candidates = [
                n for n in origin_order[bisect_left(origin_lons, x0):bisect_right(origin_lons, x1)]
                if n not in origin_burned and y0 <= origin_pts[n][1] <= y1
            ]
            origin_burned.update(_points_inside(geom, origin_pts, candidates))
        if agents_on:
            if geom is not None:
                update_fire_cues(geom)
            if inside != exposed_edges:
                routes_dirty = True  # exposed edges carry a route penalty
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

    def decide_departures(t: int) -> None:
        """Waiting agents decide to leave with a hazard from notice, fire and social cues."""
        dt = bp.decision_every_s
        for zi in range(n_zones):
            agents = zone_waiting_agents[zi]
            if not agents:
                continue
            if z_ordered_s[zi] is not None:
                notice_h = bp.order_hazard_per_h
            elif z_warned_s[zi] is not None:
                notice_h = bp.warning_hazard_per_h
            else:
                notice_h = 0.0
            vehicles = zone_list[zi].vehicles
            social_h = bp.social_hazard_per_h * z_departed[zi] / vehicles if vehicles else 0.0
            if notice_h == 0 and social_h == 0 and not zone_cued[zi]:
                continue
            still = []
            for a in agents:
                fire_h = bp.fire_cue_hazard_per_h if fire_cued[ag_node[a]] else 0.0
                n_h, s_h = (0.0, 0.0) if ag_wait_fire[a] else (notice_h, social_h)
                h = n_h + fire_h + s_h
                if h <= 0 or brng.random() >= bh.decision_probability(h, dt):
                    still.append(a)
                    continue
                u = brng.random() * h
                ag_trigger[a] = bh.TRIGGER_ORDER if u < n_h else bh.TRIGGER_FIRE if u < n_h + fire_h else bh.TRIGGER_SOCIAL
                prep_s = min(prep_cap_s, brng.lognormvariate(prep_mu, bp.prep_sigma))
                heapq.heappush(preparing, (t + max(prep_s, step), a))
                z_waiting[zi] -= ag_count[a]
                z_preparing[zi] += ag_count[a]
            zone_waiting_agents[zi] = still

    def turn_back(t: int) -> None:
        """Agents on a stopped or dead-end edge decide once per edge whether to turn back to its start."""
        nonlocal seq, turned_back
        for i in sorted(active):
            stopped = closed[i] and i in closed_hard
            if not (stopped or (next_edge[e_to[i]] == -1 and open_dest_at(e_to[i]) is None)):
                continue
            keep = deque()
            for pkt in queue[i]:
                count, ready, zone, a = pkt
                if ag_turn_edge[a] == i:
                    keep.append(pkt)
                    continue
                ag_turn_edge[a] = i
                if brng.random() < bp.turn_back_prob:
                    back_s = min(e_fft[i], max(step, t - (ready - e_fft[i])))  # retrace the distance covered
                    heapq.heappush(returning, (t + back_s, seq, e_from[i], count, zone, a))
                    seq += 1
                    occ[i] -= count
                    turned_back += count
                else:
                    keep.append(pkt)
            queue[i] = keep
            if not keep:
                active.discard(i)

    frames: list[dict] = []
    metrics: list[dict] = []
    edge_ids_out = [e.id for e in edges]
    peaks = {"en_route_veh": 0, "blocked_veh": 0, "exposed_veh": 0, "exposed_at_origin_veh": 0}
    edge_peak: dict[int, list] = {}  # edge index -> [peak_veh, peak_t_s, min_speed_kph, congested_frames]

    def edge_rows(t: int) -> list[tuple[int, int, float, bool]]:
        """(edge, vehicles, mean speed kph, stopped) for occupied edges, in index order."""
        rows = []
        for i in sorted(active):
            moving = sum(p[0] for p in queue[i] if p[1] > t)
            stopped = closed[i] and i in closed_hard
            rows.append((i, occ[i], 0.0 if stopped else edges[i].speed_kph * moving / occ[i], stopped))
        return rows

    def state_counts(rows) -> dict[str, int]:
        blocked = 0
        for i, n, _, stopped in rows:
            if stopped or (next_edge[e_to[i]] == -1 and open_dest_at(e_to[i]) is None):
                blocked += n
        for node, q in waiting.items():
            if q and next_edge[node] == -1 and open_dest_at(node) is None:
                blocked += sum(p[0] for p in q)
        counts = {
            "not_departed_veh": not_departed,
            "en_route_veh": total_veh - not_departed - arrived,
            "arrived_veh": arrived,
            "blocked_veh": blocked,
            "exposed_veh": sum(n for i, n, _, _ in rows if i in exposed_edges),
            "exposed_at_origin_veh": sum(nd_at_node[n] for n in origin_burned),
        }
        if agents_on:
            counts.update({
                "waiting_veh": sum(z_waiting),
                "preparing_veh": sum(z_preparing),
                "turned_back_veh": turned_back,
                **{f"departed_by_{trig}_veh": departed_by[trig] for trig in bh.TRIGGERS},
            })
        return counts

    def record(t: int, at: datetime) -> None:
        rows = edge_rows(t)
        frame_edges = []
        for i, n, speed, _ in rows:
            frame_edges.append([i, n, round(speed, 1)])
            stat = edge_peak.setdefault(i, [0, t, math.inf, 0])
            if n > stat[0]:
                stat[0], stat[1] = n, t
            stat[2] = min(stat[2], speed)
            if speed < CONGESTED_SPEED_FRACTION * edges[i].speed_kph:
                stat[3] += 1
        counts = state_counts(rows)
        en_route = counts["en_route_veh"]
        if not (min(not_departed, en_route, arrived) >= 0 and not_departed + en_route + arrived == total_veh):
            raise AssertionError(f"population not conserved at {format_utc(at)}")
        on_edges = sum(occ[i] for i in active)
        in_wait = sum(p[0] for q in waiting.values() for p in q)
        in_return = sum(r[3] for r in returning)
        if (on_edges + in_wait + in_return != en_route or counts["blocked_veh"] > en_route
                or counts["exposed_veh"] > en_route):
            raise AssertionError(f"inconsistent vehicle states at {format_utc(at)}")
        if agents_on and (counts["waiting_veh"] + counts["preparing_veh"] != not_departed
                          or sum(departed_by.values()) != total_veh - not_departed):
            raise AssertionError(f"inconsistent resident states at {format_utc(at)}")
        frames.append({
            "at": format_utc(at),
            "edges": frame_edges,
            "closed": closed_list,
        })
        metrics.append({"at": format_utc(at), **counts})
        if counts["exposed_at_origin_veh"] > not_departed:
            raise AssertionError(f"inconsistent origin exposure at {format_utc(at)}")
        for key in peaks:
            peaks[key] = max(peaks[key], counts[key])

    def view(t: int, at: datetime) -> TrafficView:
        rows = edge_rows(t)

        def when(s: float | None) -> datetime | None:
            return None if s is None else start + timedelta(seconds=s)

        return TrafficView(
            at=at,
            network=network,
            edge_veh=MappingProxyType({edges[i].id: n for i, n, _, _ in rows}),
            edge_speed_ratio=MappingProxyType({edges[i].id: speed / edges[i].speed_kph for i, _, speed, _ in rows}),
            closed_edge_ids=frozenset(edges[i].id for i in closed_list),
            exposed_edge_ids=frozenset(edges[i].id for i in exposed_edges),
            zones=MappingProxyType({
                z.id: ZoneView(
                    id=z.id, name=z.name, vehicles=z.vehicles,
                    ordered_at=when(z_ordered_s[zi]) if agents_on else (
                        when(first_release_s.get(z.id))),
                    warned_at=when(z_warned_s[zi]),
                    waiting_veh=z_waiting[zi], preparing_veh=z_preparing[zi],
                    departed_veh=z_departed[zi], arrived_veh=z_arrived[zi],
                )
                for zi, z in enumerate(zone_list)
            }),
            full_destination_ids=frozenset(d.id for k, d in enumerate(dest_list) if dest_full[k]),
            metrics=MappingProxyType(state_counts(rows)),
            fire_area=fire_geom,
            elapsed_s=t,
            contraflow_outbound_edge_ids=frozenset(edges[i].id for i in contraflow_out),
        )

    first_release_s: dict[str, float] = {}  # fixed-delay engine: zone -> order time, for views

    def run_controllers(t: int, at: datetime) -> None:
        snapshot = view(t, at)
        for controller in controllers:
            for ev in controller(at, snapshot) or ():
                if ev.at.tzinfo is None or ev.at.utcoffset() is None or not (start <= ev.at <= at):
                    raise ValueError(f"controller event {ev.id} must be timezone-aware with start <= at <= {at}")
                if ev.id in used_event_ids:
                    raise ValueError(f"controller event id {ev.id} is not unique")
                _check_event_targets(ev, edge_index, zone_ix, dest_ix)
                used_event_ids.add(ev.id)
                at_s = (ev.at - start).total_seconds()
                if not agents_on and ev.type == "evacuation_order":
                    for z in ev.zone_ids:
                        first_release_s.setdefault(z, at_s)
                generated.append(_bundle_event(
                    ev.id, ev.at, ev.type, ev.label, list(ev.edge_ids), evidence_class=ev.evidence_class,
                    time_precision=ev.time_precision, source_id=ev.source_id, source_locator=ev.source_locator,
                    zone_ids=list(ev.zone_ids), destination_id=ev.destination_id,
                ))
                apply_event(ev, at_s)

    for k in range(n_steps + 1):
        t = k * step
        at = start + timedelta(seconds=t)

        # 1. events due by now
        closures_changed = False
        while ev_next < len(ev_sorted) and ev_s[ev_next] <= t:
            ev = ev_sorted[ev_next]
            if not agents_on and ev.type == "evacuation_order":
                for z in ev.zone_ids:
                    first_release_s.setdefault(z, ev_s[ev_next])
            apply_event(ev, ev_s[ev_next])
            ev_next += 1
        # 2. fire area in effect
        if fire_area_at is not None and t % params.fire_check_every_s == 0:
            set_fire(fire_area_at(at), at)
        # 3. controllers
        if controllers and t % controller_every_s == 0:
            run_controllers(t, at)
        if closures_changed or routes_dirty:
            closed_hard = event_closed | fire_closed
            union = closed_hard | contraflow_in
            if union != closed_set:
                for i in union ^ closed_set:
                    closed[i] = i in union
                closed_set = union
                closed_list = sorted(union)
                closures_changed = True
        # 4. routes
        if routes_dirty or closures_changed or t >= next_reroute_s:
            rebuild_routes()
            routes_dirty = False
            next_reroute_s = t + params.reroute_interval_s

        # 5. resident decisions, then departures and returns due by now join their node
        if agents_on and t % bp.decision_every_s == 0:
            decide_departures(t)
            if bp.turn_back_prob > 0:
                turn_back(t)
        while pending and pending[0][0] <= t:
            _, _, node, count, zone = heapq.heappop(pending)
            not_departed -= count
            nd_at_node[node] -= count
            z_preparing[zone] -= count
            z_departed[zone] += count
            add_series(zone_departures[zone], t, count)
            waiting.setdefault(node, deque()).append([count, zone, -1])
        while preparing and preparing[0][0] <= t:
            _, a = heapq.heappop(preparing)
            zone, count = ag_zone[a], ag_count[a]
            not_departed -= count
            nd_at_node[ag_node[a]] -= count
            z_preparing[zone] -= count
            z_departed[zone] += count
            departed_by[ag_trigger[a]] += count
            z_trigger_veh[zone][ag_trigger[a]] += count
            add_series(zone_departures[zone], t, count)
            waiting.setdefault(ag_node[a], deque()).append([count, zone, a])
        while returning and returning[0][0] <= t:
            _, _, node, count, zone, a = heapq.heappop(returning)
            waiting.setdefault(node, deque()).append([count, zone, a])

        # 6. move packets off edges, in edge-index order
        for i in sorted(active):
            q = queue[i]
            credit[i] = min(credit[i] + e_cap_step[i], e_credit_max[i])
            if closed[i] and i in closed_hard:
                continue
            node = e_to[i]
            while q:
                count, ready, zone, a = q[0]
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
                ne = choose(node, zone, a) if agents_on else next_edge[node]
                if ne == -1 or (occ[ne] and occ[ne] + count > e_storage[ne]):
                    break
                q.popleft()
                credit[i] -= count
                occ[i] -= count
                enter(ne, count, zone, a, t)
                if agents_on:
                    zone_memory[zone][node] = ne
            if not q:
                active.discard(i)

        # 7. departed packets enter their first edge
        for node in sorted(waiting):
            wq = waiting[node]
            while wq:
                count, zone, a = wq[0]
                d = open_dest_at(node)
                if d is not None:
                    n = accept(d, count, zone, t)
                    if n < count:
                        wq[0][0] = count - n
                        break
                    wq.popleft()
                    continue
                ne = choose(node, zone, a) if agents_on else next_edge[node]
                if ne == -1 or (occ[ne] and occ[ne] + count > e_storage[ne]):
                    break
                wq.popleft()
                enter(ne, count, zone, a, t)
                if agents_on:
                    zone_memory[zone][node] = ne
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

    summary = {
        "total_veh": total_veh,
        "clearance_time_s": clearance,
        "max_exposed_veh": peaks["exposed_veh"],
        "max_exposed_at_origin_veh": peaks["exposed_at_origin_veh"],
        "max_en_route_veh": peaks["en_route_veh"],
        "max_blocked_veh": peaks["blocked_veh"],
        "arrived_veh": arrived,
        "not_departed_veh": not_departed,
        "first_order_at": None if first_order_s is None else format_utc(start + timedelta(seconds=first_order_s)),
        "last_arrival_at": None if last_arrival_s is None else format_utc(start + timedelta(seconds=last_arrival_s)),
        "arrived_by_destination_veh": {d.id: dest_arrived[i] for i, d in enumerate(dest_list)},
    }
    zone_stats = {
        z.id: {
            "departures": [[iso(t), n] for t, n in zone_departures[k]],
            "arrivals": [[iso(t), n] for t, n in zone_arrivals[k]],
        }
        for k, z in enumerate(zone_list)
    }
    assumptions, limitations = list(ASSUMPTIONS), list(LIMITATIONS)
    if agents_on:
        summary.update({
            "departed_by_trigger_veh": dict(departed_by),
            "turned_back_veh": turned_back,
            "waiting_at_end_veh": sum(z_waiting),
            "preparing_at_end_veh": sum(z_preparing),
        })
        for k, z in enumerate(zone_list):
            zone_stats[z.id]["departed_by_trigger_veh"] = dict(z_trigger_veh[k])
        assumptions = [a for a in assumptions if a != _FIXED_DELAY_ASSUMPTION] + bh.ASSUMPTIONS
        limitations = [x for x in limitations if x not in _FIXED_DELAY_LIMITATIONS] + bh.LIMITATIONS

    return {
        "evidence_class": "simulated",
        "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict(), "seed": params.seed},
        "edge_ids": edge_ids_out,
        "frames": frames,
        "metrics": metrics,
        "summary": summary,
        "diagnostics": {
            "congested_speed_fraction": CONGESTED_SPEED_FRACTION,
            "edge_stats_sampled_every_s": params.record_every_s,  # edge stats come from recorded frames
            "zone_stats": zone_stats,
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
        "assumptions": assumptions,
        "limitations": limitations,
    }
