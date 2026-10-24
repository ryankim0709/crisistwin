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
import io
import pickle
import types
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
MODEL_VERSION = "0.2.0"

DEMAND_EVENT_TYPES = ("evacuation_order", "evacuation_warning")
CLOSE_EVENT_TYPES = ("road_closed", "road_blocked")
REOPEN_EVENT_TYPES = ("road_reopened",)
SHELTER_FULL_EVENT_TYPES = ("shelter_full",)
DESTINATION_OPEN_EVENT_TYPES = ("shelter_opened",)  # with destination_id; a destination opened first starts closed
DESTINATION_CLOSE_EVENT_TYPES = ("shelter_closed",)
REFUGE_KIND = "temporary_refuge"  # fallback tier: routed to only from nodes that reach no exit or shelter
CAPACITY_EVENT_TYPES = ("capacity_changed",)  # edge capacity = source capacity x event capacity_factor
CONTRAFLOW_START_EVENT_TYPES = ("contraflow_started",)  # edge_ids are the outbound edges
CONTRAFLOW_END_EVENT_TYPES = ("contraflow_ended",)
FIRE_CLOSURE_TIME_PRECISION = "model_step"  # closure time is the first model step the perimeter is in effect
CONGESTED_SPEED_FRACTION = 0.5  # an occupied edge is congested in a frame when mean speed < this x free-flow speed
FIRE_CACHE_MAX_GEOMETRIES = 4  # non-cumulative mode: distinct fire geometries whose edge-inside sets are kept
REFERENCE_RESPONSE_DELAY_MEDIAN_MIN = 30.0  # agent hazards and preparation times are stated at this median
FIRE_INDEX_CELL_DEG = 0.01  # bucket size (about 1 km) of the spatial index over fire polygon parts
# Vehicles already on an edge when the fire closes it finish the edge at this x free-flow speed (smoke,
# low visibility); planning assumption, not calibrated.
FIRE_DRAIN_SPEED_FACTOR = 0.5
_REFUGE_TIER_OFFSET_S = 1e9  # route cost added to refuge-tier nodes so they always rank after exit-tier nodes
_ESCAPE_TIER_OFFSET_S = 2 * _REFUGE_TIER_OFFSET_S  # escape-tier nodes rank after both
ENTRAPMENT_LABEL_PREFIX = "Modelled fire entrapment"

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
    "An edge whose midpoint lies inside the fire area in effect is exposed, and closed to new entry when "
    "close_edges_in_fire is set. Vehicles already on it drive on to its downstream end at "
    f"{FIRE_DRAIN_SPEED_FACTOR} x free-flow speed, counted as exposed, then reroute over open edges.",
    "Fire closes edges to traffic from outside the burned area only. A vehicle at a node that reaches no "
    "destination over open edges (it is already inside the burned area) drives out over fire-closed edges at the "
    "reduced speed toward the nearest node that does, if that path crosses at most fire_escape_max_m of burned "
    "road (fire-intensity rule); event and contraflow closures are never crossed.",
    "A vehicle is trapped by fire when it is on a fire-exposed edge and the downstream node has neither an open "
    "route nor an escape within fire_escape_max_m. Each road name's first such frame is reported as a "
    f"'{ENTRAPMENT_LABEL_PREFIX}' event (burnover-like). Event closures (road_closed / road_blocked) stop "
    "vehicles on the edge until it reopens, unless the event sets closure_drains.",
    "Destinations open and close with shelter_opened / shelter_closed events; a destination whose first such "
    "event is an opening starts closed. Vehicles already arrived stay arrived when it closes.",
    f"Temporary refuges ({REFUGE_KIND}) are a fallback: a node routes to one only when no exit or shelter is "
    "reachable from it over open edges; otherwise vehicles drive past it.",
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
    "Vehicles on an edge closed by an event stop until it reopens; turning back is not modelled.",
    "Fire entrapment is topological (no onward open edge), not a fire-intensity or survivability model; "
    "refuges have unknown capacity (unlimited) and vehicles do not leave a refuge later.",
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
    # road_closed/road_blocked only: close to entry; vehicles on the edge, and vehicles inside an area
    # with no open route, may still leave over it (as with fire closures). False = hard stop.
    closure_drains: bool = False


@dataclass(frozen=True)
class TrafficParams:
    step_s: int = 10  # model time step
    record_every_s: int = 60  # frame cadence; a multiple of step_s
    seed: int = 7
    packet_size_veh: int = 5  # vehicles per packet (the last packet of a zone may be smaller)
    # Fixed-delay engine: order -> departure, lognormal median. With agents it is a response-time scale instead:
    # response_delay_median_min / REFERENCE_RESPONSE_DELAY_MEDIAN_MIN divides every departure hazard and
    # multiplies preparation time (2x slower residents: 60.0). response_delay_sigma/max apply only without agents.
    response_delay_median_min: float = 30.0
    response_delay_sigma: float = 0.8  # lognormal shape (sigma of ln delay)
    response_delay_max_min: float = 360.0  # draws above this are capped
    jam_density_veh_per_km_lane: float = 125.0  # storage; ~8 m per stopped vehicle
    reroute_interval_s: int = 300  # periodic route-tree rebuild with current queues
    queue_aware_routing: bool = True  # add discharge time of vehicles on an edge to its route cost
    close_edges_in_fire: bool = True
    # Fire-intensity rule: a vehicle with no route over open edges may drive out over fire-closed edges, but
    # only through at most this much burned road (m); deeper inside it is trapped. Planning assumption, about
    # the width of the Paradise ridge: NIST TN 2252 describes drives of several km through burning areas
    # (Skyway, Pentz Rd, Clark Rd). Chosen after a sensitivity sweep, so burnover counts are not independent.
    fire_escape_max_m: float = 5000.0
    fire_area_cumulative: bool = True  # an edge midpoint once inside the fire area stays inside (burned area only grows)
    fire_check_every_s: int = 60  # cadence of fire_area_at calls; a multiple of step_s
    warning_releases_demand: bool = False  # fixed-delay engine only; agents respond to warnings via a hazard
    # Fixed-delay engine only: share of a zone's packets that leave without an order once modelled fire reaches
    # one of the zone's origin nodes (shadow evacuation; sim.behavior.PeopleBehavior). 0 = off (replays).
    shadow_evacuation_share: float = 0.0
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
        if not (self.fire_escape_max_m >= 0):
            raise ValueError(f"fire_escape_max_m must be nonnegative, got {self.fire_escape_max_m}")
        for name in ("response_delay_median_min", "response_delay_max_min", "jam_density_veh_per_km_lane"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value > 0):
                raise ValueError(f"{name} must be positive and finite, got {value}")
        if not (math.isfinite(self.response_delay_sigma) and self.response_delay_sigma >= 0):
            raise ValueError(f"response_delay_sigma must be nonnegative, got {self.response_delay_sigma}")
        if not 0 <= self.shadow_evacuation_share <= 1:
            raise ValueError(f"shadow_evacuation_share must be in [0, 1], got {self.shadow_evacuation_share}")

    def to_dict(self) -> dict:
        d = asdict(self)
        if not self.behavior.enabled:
            d.pop("behavior")  # replay outputs carry no agent parameters
        if not self.shadow_evacuation_share:
            d.pop("shadow_evacuation_share")  # off: fingerprints of existing runs are unchanged
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
    closed_destination_ids: frozenset[str] = frozenset()  # closed by shelter_closed or not yet opened


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
    engine = TrafficEngine(network, zones, destinations, events, params, start=start, end=end,
                           fire_area_at=fire_area_at, controllers=controllers, controller_every_s=controller_every_s)
    engine.run_to_end()
    return engine.result()


# --- resumable engine (docs/adr/0013-realtime-twin.md)

ZONE_ROUTE_EVENT_TYPES = ("zone_rerouted",)  # with zone_ids and destination_id (None clears the assignment)


class _EngineStatic:
    """Inputs and indexes fixed after setup; shared by reference between an engine and its forks."""


class FireTimeline:
    """Per-fire-check effect of a cumulative fire area, computed once and shared by engines and forks.

    With fire_area_cumulative, what the fire covers at each check (edges whose midpoint is inside,
    origin nodes inside, agent fire cues) depends only on the sequence of geometries, never on traffic
    or commands. Entry j (check time j * fire_check_every_s) is (geometry, same_as_previous,
    added_edges, added_origins, added_cued_nodes, added_cued_zones), computed in order from a running
    frontier with exactly the per-engine code it replaces.
    """

    def __init__(self, static: _EngineStatic):
        if not static.params.fire_area_cumulative or static.fire_area_at is None:
            raise ValueError("FireTimeline needs fire_area_at and fire_area_cumulative")
        self.s = static
        self.key = _timeline_key(static)
        self.entries: list[tuple] = []
        self._prev = None  # geometry of the last check (an engine starts with no fire geometry)
        self._exposed: set[int] = set()
        self._origin_burned: set[int] = set()
        self._burned_nodes: set[int] = set()
        self._fire_cued = bytearray(len(static.node_ids))
        self._zone_cued = [False] * len(static.zone_list)

    def entry(self, j: int) -> tuple:
        while len(self.entries) <= j:
            self._advance()
        return self.entries[j]

    def _advance(self) -> None:
        s = self.s
        t = len(self.entries) * s.params.fire_check_every_s
        geom = s.fire_area_at(s.start + timedelta(seconds=t))
        if geom is self._prev:
            self.entries.append((geom, True, (), (), (), ()))
            return
        self._prev = geom
        if geom is None:
            self.entries.append((geom, False, (), (), (), ()))
            return
        x0, y0, x1, y1 = _geometry_bbox(geom)
        exposed = self._exposed
        candidates = (
            i for i in s.mid_order[bisect_left(s.mid_lons, x0):bisect_right(s.mid_lons, x1)]
            if i not in exposed and y0 <= s.e_mid[i][1] <= y1
        )
        added_edges = _points_inside(geom, s.e_mid, candidates)
        exposed.update(added_edges)
        burned = self._origin_burned
        candidates = [
            n for n in s.origin_order[bisect_left(s.origin_lons, x0):bisect_right(s.origin_lons, x1)]
            if n not in burned and y0 <= s.origin_pts[n][1] <= y1
        ]
        added_origins = _points_inside(geom, s.origin_pts, candidates)
        burned.update(added_origins)
        cued_nodes: list[int] = []
        cued_zones: list[int] = []
        if s.agents_on:
            _update_fire_cues(s, geom, self._burned_nodes, self._fire_cued, self._zone_cued, cued_nodes, cued_zones)
        self.entries.append((geom, False, tuple(sorted(added_edges)), tuple(sorted(added_origins)),
                             tuple(cued_nodes), tuple(cued_zones)))


def _timeline_key(s: _EngineStatic) -> tuple:
    return (len(s.node_ids), len(s.edges), s.start, s.params.fire_check_every_s, s.agents_on,
            tuple(s.origin_order), id(s.fire_area_at), s.cue_d)


def _update_fire_cues(s: _EngineStatic, geom: dict, burned_nodes: set[int], fire_cued: bytearray,
                      zone_cued: list[bool], cued_nodes: list[int] | None = None,
                      cued_zones: list[int] | None = None) -> None:
    """Mark origins near newly burned road nodes or near the fire boundary (cues are cumulative)."""
    x0, y0, x1, y1 = _geometry_bbox(geom)
    candidates = (
        i for i in s.node_order[bisect_left(s.node_lons, x0):bisect_right(s.node_lons, x1)]
        if i not in burned_nodes and y0 <= s.node_pts[i][1] <= y1
    )
    newly = _points_inside(geom, s.node_pts, candidates)
    burned_nodes.update(newly)
    polygons = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]

    def cue_from_points(points) -> None:
        for lon, lat in points:
            bx, by = math.floor(lon / s.cell_lon), math.floor(lat / s.cell_lat)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for n in s.cue_buckets.get((bx + dx, by + dy), ()):
                        if fire_cued[n]:
                            continue
                        nlon, nlat = s.node_pts[n]
                        if math.hypot((nlon - lon) * s.m_lon, (nlat - lat) * s.m_lat) <= s.cue_d:
                            fire_cued[n] = 1
                            if cued_nodes is not None:
                                cued_nodes.append(n)
                            for zi in s.node_zones[n]:
                                if cued_zones is not None and not zone_cued[zi]:
                                    cued_zones.append(zi)
                                zone_cued[zi] = True

    cue_from_points([s.node_pts[i] for i in sorted(newly)])
    cue_from_points((q[0], q[1]) for poly in polygons if poly for q in poly[0])


# Engine attributes a fork shares by reference or starts empty instead of copying.
_FORK_SHARED = ("s", "timeline", "fire_geom", "fire_cache", "frames", "metrics", "edge_peak", "metrics_hook",
                "controllers")


class _SharingPickler(pickle.Pickler):
    """Pickler that passes callables and frozen input records by reference (for stateful controllers)."""

    _SHARED_TYPES = (types.FunctionType, types.MethodType, types.BuiltinFunctionType, RoadEdge, RoadNetwork,
                     DemandZone, Destination, TrafficEvent)

    def __init__(self, file, shared: list):
        super().__init__(file, pickle.HIGHEST_PROTOCOL)
        self.shared = shared

    def persistent_id(self, obj):
        if isinstance(obj, self._SHARED_TYPES):
            self.shared.append(obj)
            return len(self.shared) - 1
        return None


class _SharingUnpickler(pickle.Unpickler):
    def __init__(self, file, shared: list):
        super().__init__(file)
        self.shared = shared

    def persistent_load(self, pid):
        return self.shared[pid]


def _copy_sharing(obj):
    shared: list = []
    buf = io.BytesIO()
    _SharingPickler(buf, shared).dump(obj)
    buf.seek(0)
    return _SharingUnpickler(buf, shared).load()


class TrafficEngine:
    """The link-queue model as a resumable state machine: one `step()` per model step.

    `simulate_traffic` is `TrafficEngine(...).run_to_end(); result()`. On top of that the engine
    accepts injected events between steps (`inject`), forks cheaply (`fork`), can hold the fire
    where it is (`freeze_fire`) and can record metrics only (`record_frames=False`). With no
    injected events its results equal simulate_traffic's exactly.
    """

    def __init__(
        self,
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
        fire_timeline: FireTimeline | None = None,
        record_frames: bool = True,
        metrics_hook: Callable[[int, dict], None] | None = None,
    ):
        _validate(network, zones, destinations, events, start, end)
        if controllers and (not isinstance(controller_every_s, int) or controller_every_s <= 0
                            or controller_every_s % params.step_s):
            raise ValueError("controller_every_s must be a positive multiple of step_s")
        s = self.s = _EngineStatic()
        s.network, s.params, s.start, s.end = network, params, start, end
        s.fire_area_at, s.controller_every_s = fire_area_at, controller_every_s
        bp = s.bp = params.behavior
        agents_on = s.agents_on = bp.enabled
        step = s.step = params.step_s
        horizon_s = int((end - start).total_seconds())
        s.n_steps = horizon_s // step

        # --- network arrays (index-based for speed)
        node_ids = s.node_ids = sorted(network.nodes)
        node_ix = s.node_ix = {n: i for i, n in enumerate(node_ids)}
        edges = s.edges = network.edges
        n_edges = s.n_edges = len(edges)
        s.e_from = [node_ix[e.from_node] for e in edges]
        e_to = s.e_to = [node_ix[e.to_node] for e in edges]
        s.e_fft = [e.length_m / (e.speed_kph / 3.6) for e in edges]
        self.e_cap_step = [e.capacity_veh_per_hour * step / 3600 for e in edges]
        # Credit is capped so an idle edge can release at most one full packet (or one step's capacity) at once.
        self.e_credit_max = [max(c, params.packet_size_veh) for c in self.e_cap_step]
        # An edge always stores at least one packet, so very short edges cannot deadlock.
        self.e_storage = [
            max(params.packet_size_veh, e.length_m / 1000 * e.lanes * params.jam_density_veh_per_km_lane)
            for e in edges
        ]
        s.e_base_vph = [e.capacity_veh_per_hour for e in edges]
        s.e_base_storage = list(self.e_storage)
        self.cap_factor: dict[int, float] = {}  # edge -> capacity_changed factor
        seg_dir = {(e.segment_id, e.from_node, e.to_node): i for i, e in enumerate(edges)}
        s.twin = [seg_dir.get((e.segment_id, e.to_node, e.from_node)) for e in edges]
        self.contraflow_out: dict[int, int] = {}  # outbound edge -> reverse twin it borrows lanes from
        self.contraflow_in: set[int] = set()  # reverse twins closed to new entry by contraflow
        e_mid = s.e_mid = [_midpoint(e.coords) if e.coords else network.nodes[e.from_node] for e in edges]
        s.mid_order = sorted(range(n_edges), key=lambda i: e_mid[i][0])  # edges by midpoint longitude
        s.mid_lons = [e_mid[i][0] for i in s.mid_order]
        s.in_edges = [[] for _ in node_ids]
        for i in range(n_edges):
            s.in_edges[e_to[i]].append(i)

        self.queue: list[deque] = [deque() for _ in range(n_edges)]  # packets: [count, ready_at_s, zone, agent]
        self.occ = [0] * n_edges
        self.credit = [0.0] * n_edges
        self.active: set[int] = set()

        # --- destinations
        dest_list = s.dest_list = list(destinations)
        self.dest_arrived = [0] * len(dest_list)
        self.dest_full = [d.capacity_veh is not None and d.capacity_veh <= 0 for d in dest_list]
        self.dest_full_s: list[float | None] = [0.0 if f else None for f in self.dest_full]
        s.dest_ix = {d.id: i for i, d in enumerate(dest_list)}
        s.dest_refuge = [d.kind == REFUGE_KIND for d in dest_list]
        self.dest_series: list[list[list]] = [[] for _ in dest_list]  # per destination: [[t_s, veh], ...] by step
        first_toggle: dict[str, str] = {}
        for ev in sorted(events, key=lambda ev: (ev.at, ev.id)):
            if ev.destination_id is not None and ev.type in DESTINATION_OPEN_EVENT_TYPES + DESTINATION_CLOSE_EVENT_TYPES:
                first_toggle.setdefault(ev.destination_id, ev.type)
        self.dest_open = [first_toggle.get(d.id) not in DESTINATION_OPEN_EVENT_TYPES for d in dest_list]
        s.dests_at_node = {}
        for i, d in enumerate(dest_list):
            s.dests_at_node.setdefault(node_ix[d.node_id], []).append(i)

        # --- demand
        zone_list = s.zone_list = list(zones)
        n_zones = s.n_zones = len(zone_list)
        s.zone_ix = {z.id: i for i, z in enumerate(zone_list)}
        self.zone_departures: list[list[list]] = [[] for _ in zone_list]  # per zone: [[t_s, veh], ...] by step
        self.zone_arrivals: list[list[list]] = [[] for _ in zone_list]
        self.z_waiting = [z.vehicles for z in zone_list]  # vehicle counts by state, per zone
        self.z_preparing = [0] * n_zones
        self.z_departed = [0] * n_zones
        self.z_arrived = [0] * n_zones
        self.z_ordered_s: list[float | None] = [None] * n_zones
        self.z_warned_s: list[float | None] = [None] * n_zones
        s.zone_packets = {}  # fixed-delay engine: zone -> [(delay_s, node, count)]
        s.shadow_packets = {}  # fixed-delay engine: zone -> packet indexes that leave on the fire cue
        # Agent arrays (behaviour on): one agent per packet.
        s.ag_zone, s.ag_node, s.ag_count, s.ag_wait_fire, s.ag_herd = [], [], [], [], []
        self.ag_trigger: list[str | None] = []
        self.ag_turn_edge: list[int] = []  # edge on which the agent last made its turn-back decision
        self.zone_waiting_agents: list[list[int]] = [[] for _ in zone_list]
        self.z_trigger_veh = [dict.fromkeys(bh.TRIGGERS, 0) for _ in zone_list]
        self.brng = None
        s.response_scale = s.prep_mu = s.prep_cap_s = None
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
                s.zone_packets[z.id] = packets
            # Shadow evacuation: which packets of each zone leave on the fire cue without an order. Own stream,
            # so the delay draws above (and every run with the share at 0) are unchanged.
            s.shadow_packets = {}
            if params.shadow_evacuation_share > 0:
                srng = random.Random(f"{params.seed}:shadow")
                for z in zones:
                    s.shadow_packets[z.id] = frozenset(
                        k for k in range(len(s.zone_packets[z.id])) if srng.random() < params.shadow_evacuation_share)
            s.zone_origin_ix = [frozenset(node_ix[n] for n in z.origin_nodes) for z in zone_list]
        else:
            brng = self.brng = random.Random(f"{params.seed}:behavior")  # own stream; str seeds are stable
            for zi, z in enumerate(zone_list):
                full, rest = divmod(z.vehicles, params.packet_size_veh)
                counts = [params.packet_size_veh] * full + ([rest] if rest else [])
                for k, count in enumerate(counts):
                    self.zone_waiting_agents[zi].append(len(s.ag_zone))
                    s.ag_zone.append(zi)
                    s.ag_node.append(node_ix[z.origin_nodes[k % len(z.origin_nodes)]])
                    s.ag_count.append(count)
                    s.ag_wait_fire.append(brng.random() < bp.wait_for_fire_share)
                    s.ag_herd.append(brng.random() < bp.herding_prob)
                    self.ag_trigger.append(None)
                    self.ag_turn_edge.append(-1)
            s.response_scale = params.response_delay_median_min / REFERENCE_RESPONSE_DELAY_MEDIAN_MIN
            s.prep_mu = math.log(bp.prep_median_min * 60 * s.response_scale)
            s.prep_cap_s = bp.prep_max_min * 60 * s.response_scale
        s.total_veh = sum(z.vehicles for z in zones)
        nd_at_node = self.nd_at_node = {}  # origin node -> vehicles not yet departed from it
        if agents_on:
            for a, n in enumerate(s.ag_node):
                nd_at_node[n] = nd_at_node.get(n, 0) + s.ag_count[a]
        else:
            for packets in s.zone_packets.values():
                for _, n, count in packets:
                    nd_at_node[n] = nd_at_node.get(n, 0) + count
        s.origin_order = sorted(nd_at_node, key=lambda n: network.nodes[node_ids[n]][0])
        s.origin_lons = [network.nodes[node_ids[n]][0] for n in s.origin_order]
        s.origin_pts = {n: network.nodes[node_ids[n]] for n in nd_at_node}
        self.origin_burned: set[int] = set()  # origin nodes inside the fire area in effect
        self.pending: list[tuple[float, int, int, int, int]] = []  # fixed delay: (depart_s, seq, node, count, zone)
        self.preparing: list[tuple[float, int]] = []  # agents: (depart_s, agent)
        self.returning: list[tuple[float, int, int, int, int, int]] = []  # turned back: (at_s, seq, node, count, zone, agent)
        self.seq = 0
        self.released_zones: set[str] = set()
        self.shadow_released: set[str] = set()  # fixed delay: zones whose shadow packets left on the fire cue
        self.first_order_s: float | None = None
        self.waiting: dict[int, deque] = {}  # node -> departed packets [count, zone index, agent] not yet on an edge
        self.departed_by = dict.fromkeys(bh.TRIGGERS, 0)
        self.turned_back = 0
        self.zone_memory: list[dict[int, int]] = [{} for _ in zone_list]  # herding: node -> edge zone-mates last took

        self.not_departed = s.total_veh
        self.arrived = 0
        self.last_arrival_s: float | None = None

        # --- fire cues: origin nodes bucketed so burned points can mark origins within fire_cue_distance_m
        self.fire_cued = bytearray(len(node_ids))
        self.zone_cued = [False] * n_zones
        s.node_zones = {}
        s.cue_buckets = {}
        s.cue_d = s.cell_lon = s.cell_lat = s.m_lon = s.m_lat = None
        s.node_pts = s.node_order = s.node_lons = None
        if agents_on and fire_area_at is not None:
            lats = [lat for _, lat in network.nodes.values()]
            s.m_lat = math.radians(1) * EARTH_RADIUS_M
            s.m_lon = s.m_lat * math.cos(math.radians((min(lats) + max(lats)) / 2))
            s.cue_d = max(bp.fire_cue_distance_m, 1.0)
            s.cell_lon, s.cell_lat = s.cue_d / s.m_lon, s.cue_d / s.m_lat
            for a, n in enumerate(s.ag_node):
                s.node_zones.setdefault(n, set()).add(s.ag_zone[a])
            for n in sorted(s.node_zones):
                lon, lat = network.nodes[node_ids[n]]
                s.cue_buckets.setdefault((math.floor(lon / s.cell_lon), math.floor(lat / s.cell_lat)), []).append(n)
            s.node_pts = [network.nodes[n] for n in node_ids]
            s.node_order = sorted(range(len(node_ids)), key=lambda i: s.node_pts[i][0])
            s.node_lons = [s.node_pts[i][0] for i in s.node_order]
        self.burned_nodes: set[int] = set()

        # --- events
        s.ev_sorted = sorted(events, key=lambda ev: (ev.at, ev.id))
        s.ev_s = [(ev.at - start).total_seconds() for ev in s.ev_sorted]
        self.ev_next = 0
        self.event_closed: set[int] = set()  # hard: vehicles on the edge stop
        self.event_closed_drain: set[int] = set()  # closure_drains: closed to entry only
        s.edge_index = {e.id: i for i, e in enumerate(edges)}
        self.used_event_ids = {ev.id for ev in events}

        # --- fire
        self.fire_closed: set[int] = set()
        self.exposed_edges: frozenset[int] | set[int] = frozenset()
        self.fire_geom: dict | None = None
        # id(geometry) -> (geometry, edges inside); insertion-ordered for eviction. Holding the geometry
        # keeps its id from being reused while cached, so identity is a safe, cheap key.
        self.fire_cache: dict[int, tuple[dict, frozenset[int]]] = {}
        self.fire_frozen = False
        self.timeline: FireTimeline | None = None
        if fire_area_at is not None and params.fire_area_cumulative:
            if fire_timeline is not None and fire_timeline.key != _timeline_key(s):
                raise ValueError("fire_timeline was built for different inputs")
            self.timeline = fire_timeline or FireTimeline(s)
            self.exposed_edges = set()  # updated in place from the timeline's deltas
        self.generated: list[dict] = []

        self.closed = [False] * n_edges
        self.closed_set: set[int] = set()
        self.closed_hard: set[int] = set()  # closed to entry and exit; fire- and contraflow-closed edges still drain
        self.fire_trapped_edges: set[int] = set()  # edges that have held fire-trapped vehicles (reported once)
        self.closed_list: list[int] = []  # sorted; rebuilt only when closures change
        self.next_edge = [-1] * len(node_ids)
        self.route_dist = [math.inf] * len(node_ids)  # current route cost to the nearest open destination
        self.routes_dirty = True
        self.closures_changed = False
        self.next_reroute_s = 0

        # --- commands (twin): injected events and per-zone destination assignments
        self.injected: list[tuple[float, int, TrafficEvent]] = []  # heap (at_s, seq, event)
        self.inject_seq = 0
        self.zone_dest: dict[int, int] = {}  # zone index -> assigned destination index
        self.dest_next: dict[int, list[int]] = {}  # assigned destination -> per-node next edge toward it
        self.dest_dist: dict[int, list[float]] = {}

        # --- outputs
        s.edge_ids_out = [e.id for e in edges]
        s.refuge_ix = [d for d in range(len(dest_list)) if s.dest_refuge[d]]
        self.frames: list[dict] = []
        self.metrics: list[dict] = []
        self.peaks = {"en_route_veh": 0, "blocked_veh": 0, "exposed_veh": 0, "exposed_at_origin_veh": 0,
                      "trapped_by_fire_veh": 0, "trapped_by_closure_veh": 0, "active_refuges": 0}
        self.edge_peak: dict[int, list] = {}  # edge index -> [peak_veh, peak_t_s, min_speed_kph, congested_frames]
        self.first_release_s: dict[str, float] = {}  # fixed-delay engine: zone -> order time, for views
        self.exposed_veh_min = 0.0  # integrals over recorded frames since start
        self.exposed_at_origin_veh_min = 0.0
        self.last_counts: dict | None = None
        self.record_frames = record_frames
        self.metrics_hook = metrics_hook
        self.controllers = tuple(controllers)
        self.k = 0  # index of the next step to run

    # --- clock

    @property
    def n_steps(self) -> int:
        return self.s.n_steps

    @property
    def finished(self) -> bool:
        return self.k > self.s.n_steps

    @property
    def now_s(self) -> int | None:
        """Model seconds of the last completed step (None before the first step)."""
        return None if self.k == 0 else (self.k - 1) * self.s.step

    @property
    def next_step_s(self) -> int:
        return self.k * self.s.step

    def run_to(self, t_s: float) -> None:
        """Run every remaining step with time <= t_s."""
        step, n_steps = self.s.step, self.s.n_steps
        while self.k <= n_steps and self.k * step <= t_s:
            self.step()

    def run_to_end(self) -> None:
        while self.k <= self.s.n_steps:
            self.step()

    # --- commands

    def inject(self, events: Sequence[TrafficEvent]) -> None:
        """Schedule events (simulated commands) for the first step at or after their time.

        They go on their own queue, never into the historical event list, and are applied after the
        controllers of their step with the same checks and generated-event entry as controller events.
        """
        s = self.s
        batch_ids = set()
        for ev in events:
            if ev.at.tzinfo is None or ev.at.utcoffset() is None:
                raise ValueError(f"event {ev.id} time must include a timezone")
            at_s = (ev.at - s.start).total_seconds()
            if at_s < self.next_step_s or ev.at > s.end:
                raise ValueError(f"event {ev.id} must be at or after the next step and not after end")
            if ev.id in self.used_event_ids or ev.id in batch_ids:
                raise ValueError(f"event id {ev.id} is not unique")
            if ev.type in ZONE_ROUTE_EVENT_TYPES and not ev.zone_ids:
                raise ValueError(f"event {ev.id} needs zone_ids")
            _check_event_targets(ev, s.edge_index, s.zone_ix, s.dest_ix)
            batch_ids.add(ev.id)
        for ev in events:
            self.used_event_ids.add(ev.id)
            heapq.heappush(self.injected, ((ev.at - s.start).total_seconds(), self.inject_seq, ev))
            self.inject_seq += 1

    def freeze_fire(self) -> None:
        """Hold the fire area where it is now: no fire checks after this."""
        self.fire_frozen = True

    def fork(self, *, keep_outputs: bool = False, metrics_hook=None) -> "TrafficEngine":
        """Independent engine at the same state. Static inputs, the fire timeline, callables and fire
        geometries are shared; everything else is copied (pickle round trip). Recorded outputs start
        empty unless keep_outputs (then frames record too)."""
        state = {k: v for k, v in self.__dict__.items() if k not in _FORK_SHARED}
        new = TrafficEngine.__new__(TrafficEngine)
        new.__dict__.update(pickle.loads(pickle.dumps(state, pickle.HIGHEST_PROTOCOL)))
        new.s, new.timeline, new.fire_geom = self.s, self.timeline, self.fire_geom
        new.fire_cache = dict(self.fire_cache)
        if keep_outputs:
            new.frames, new.metrics = list(self.frames), list(self.metrics)
            new.edge_peak = {i: list(v) for i, v in self.edge_peak.items()}
            new.record_frames = self.record_frames
        else:
            new.frames, new.metrics, new.edge_peak = [], [], {}
            new.record_frames = False
        new.metrics_hook = metrics_hook
        new.controllers = _copy_sharing(self.controllers) if self.controllers else ()
        return new

    # --- helpers (one per former nested function)

    def refresh_capacity(self, i: int) -> None:
        s = self.s
        vph = s.e_base_vph[i] * self.cap_factor.get(i, 1.0)
        storage = s.e_base_storage[i]
        if i in self.contraflow_out:
            vph += s.e_base_vph[self.contraflow_out[i]]
            storage += s.e_base_storage[self.contraflow_out[i]]
        self.e_cap_step[i] = vph * s.step / 3600
        self.e_credit_max[i] = max(self.e_cap_step[i], s.params.packet_size_veh)
        self.e_storage[i] = storage

    def usable(self, d: int) -> bool:
        return self.dest_open[d] and not self.dest_full[d]

    def _search(self, dist: list[float], nxt: list[int], sources: list[int], base: float, allowed,
                penalize: bool) -> None:
        s = self.s
        in_edges, e_from, e_fft = s.in_edges, s.e_from, s.e_fft
        closed, occ, e_cap_step = self.closed, self.occ, self.e_cap_step
        step = s.step
        queue_aware = s.params.queue_aware_routing
        exposed_edges = self.exposed_edges
        penalty = s.bp.fire_edge_penalty_s
        heappop, heappush = heapq.heappop, heapq.heappush
        heap = []
        for node in sources:
            dist[node] = base
            heap.append((base, node))
        heapq.heapify(heap)
        while heap:
            d, v = heappop(heap)
            if d > dist[v]:
                continue
            for e in in_edges[v]:
                if closed[e]:
                    continue
                u = e_from[e]
                if allowed is not None and u not in allowed:
                    continue
                cost = e_fft[e]
                if queue_aware and occ[e]:
                    cost += occ[e] / e_cap_step[e] * step
                if penalize and e in exposed_edges:
                    cost += penalty
                nd = d + cost
                if nd < dist[u]:
                    dist[u] = nd
                    nxt[u] = e
                    heappush(heap, (nd, u))

    def rebuild_routes(self) -> None:
        """Two-tier reversed multi-source Dijkstra over open edges.

        Tier 1 runs from open exits and shelters; one pass equals the per-node minimum over
        per-destination trees. Tier 2 runs from open refuges over nodes tier 1 left unreachable
        only, so the refuge tree never routes a node that can reach an exit (every node reachable
        from an unreachable node is itself unreachable). Tier-2 costs carry _REFUGE_TIER_OFFSET_S.
        With agents, open fire-exposed edges carry bp.fire_edge_penalty_s. Destinations assigned to
        zones (zone_rerouted) get their own single-destination tree over the same open edges.
        """
        s = self.s
        n_nodes = len(s.node_ids)
        dist = [math.inf] * n_nodes
        nxt = [-1] * n_nodes
        penalize = s.agents_on and s.bp.fire_edge_penalty_s > 0 and bool(self.exposed_edges)
        usable, dest_refuge = self.usable, s.dest_refuge
        self._search(dist, nxt,
                     sorted(n for n, ds in s.dests_at_node.items() if any(usable(d) and not dest_refuge[d] for d in ds)),
                     0.0, None, penalize)
        refuges = sorted(n for n, ds in s.dests_at_node.items()
                         if math.isinf(dist[n]) and any(usable(d) and dest_refuge[d] for d in ds))
        if refuges:
            self._search(dist, nxt, refuges, _REFUGE_TIER_OFFSET_S, {v for v, x in enumerate(dist) if math.isinf(x)},
                         penalize)
        if self.fire_closed or self.event_closed_drain:
            self.escape(dist, nxt)
        self.next_edge[:] = nxt
        self.route_dist[:] = dist
        self.dest_next, self.dest_dist = {}, {}
        for d in sorted(set(self.zone_dest.values())):
            ddist = [math.inf] * n_nodes
            dnxt = [-1] * n_nodes
            self._search(ddist, dnxt, [s.node_ix[s.dest_list[d].node_id]], 0.0, None, penalize)
            self.dest_next[d], self.dest_dist[d] = dnxt, ddist

    def escape(self, dist: list[float], nxt: list[int]) -> None:
        """Escape tier, in place: route nodes with no open route out over fire-closed edges.

        Reversed Dijkstra over the unrouted nodes from the routed nodes they border through a
        fire-only closure, by time (fire edges at FIRE_DRAIN_SPEED_FACTOR), keeping only paths
        with at most params.fire_escape_max_m of fire-closed road.
        """
        s = self.s
        params, edges, in_edges, e_from, e_to, e_fft = s.params, s.edges, s.in_edges, s.e_from, s.e_to, s.e_fft
        closed, occ, e_cap_step, step = self.closed, self.occ, self.e_cap_step, s.step
        stuck = {v for v, x in enumerate(dist) if math.isinf(x)}
        if not stuck:
            return
        # Entry-only closures (fire, closure_drains events) may be escaped from inside; hard ones never.
        hard = self.event_closed | self.contraflow_in
        escapable = self.fire_closed | self.event_closed_drain
        edist: dict[int, float] = {}
        fire_m: dict[int, float] = {}
        heap = []
        for e in sorted(escapable):
            v = e_to[e]
            if e_from[e] in stuck and v not in stuck and e not in hard and v not in edist:
                edist[v], fire_m[v] = dist[v], 0.0
                heap.append((dist[v], v))
        heapq.heapify(heap)
        while heap:
            d, v = heapq.heappop(heap)
            if d > edist[v]:
                continue
            for e in in_edges[v]:
                u = e_from[e]
                if u not in stuck or e in hard:
                    continue
                cost = e_fft[e]
                fm = fire_m[v]
                if closed[e]:
                    if e not in escapable:
                        continue
                    cost /= FIRE_DRAIN_SPEED_FACTOR
                    fm += edges[e].length_m
                    if fm > params.fire_escape_max_m:
                        continue
                if params.queue_aware_routing and occ[e]:
                    cost += occ[e] / e_cap_step[e] * step
                nd = d + cost
                if nd < edist.get(u, math.inf):
                    edist[u], fire_m[u] = nd, fm
                    nxt[u] = e
                    heapq.heappush(heap, (nd, u))
        for u, d in edist.items():
            if u in stuck:
                dist[u] = _ESCAPE_TIER_OFFSET_S + d

    def open_dest_at(self, node: int) -> int | None:
        """Open destination that takes vehicles at node; a refuge only where no exit or shelter is reachable."""
        for d in self.s.dests_at_node.get(node, ()):
            if self.usable(d) and (not self.s.dest_refuge[d] or self.route_dist[node] >= _REFUGE_TIER_OFFSET_S):
                return d
        return None

    def assignment_following(self, zone: int, node: int) -> int | None:
        """Assigned destination of the zone if a packet at node can follow it (usable and reachable), else None."""
        d = self.zone_dest.get(zone)
        if d is None or not self.usable(d):
            return None
        dd = self.dest_dist.get(d)
        return d if dd is not None and not math.isinf(dd[node]) else None

    def admit_at(self, node: int, zone: int) -> int | None:
        """open_dest_at for a packet of `zone`: a following assigned zone is admitted only at its destination."""
        d = self.assignment_following(zone, node)
        if d is None:
            return self.open_dest_at(node)
        return d if self.s.node_ix[self.s.dest_list[d].node_id] == node else None

    def route(self, node: int, zone: int, agent: int) -> int:
        """Next edge for a packet of `zone`: its assigned destination's tree, else the shared tree."""
        d = self.assignment_following(zone, node)
        if d is not None and self.dest_next[d][node] != -1:
            return self.dest_next[d][node]
        return self.choose(node, zone, agent) if self.s.agents_on else self.next_edge[node]

    def choose(self, node: int, zone: int, agent: int) -> int:
        """Next edge from node: the route tree, or for a herding agent its zone-mates' last choice."""
        ne = self.next_edge[node]
        if self.s.ag_herd[agent]:
            m = self.zone_memory[zone].get(node)
            if (m is not None and m != ne and not self.closed[m] and m not in self.exposed_edges
                    and self.route_dist[self.s.e_to[m]] < self.route_dist[node]):
                return m
        return ne

    @staticmethod
    def add_series(series: list[list], t: int, n: int) -> None:
        if series and series[-1][0] == t:
            series[-1][1] += n
        else:
            series.append([t, n])

    def mark_full(self, d: int, t: float) -> None:
        if not self.dest_full[d]:
            self.dest_full[d] = True
            self.dest_full_s[d] = t
            self.routes_dirty = True

    def accept(self, d: int, count: int, zone: int, t: int) -> int:
        """Admit up to `count` vehicles at destination d; return how many were admitted."""
        cap = self.s.dest_list[d].capacity_veh
        n = count if cap is None else min(count, cap - self.dest_arrived[d])
        if n > 0:
            self.dest_arrived[d] += n
            self.arrived += n
            self.z_arrived[zone] += n
            self.last_arrival_s = t
            self.add_series(self.zone_arrivals[zone], t, n)
            self.add_series(self.dest_series[d], t, n)
        if cap is not None and self.dest_arrived[d] >= cap:
            self.mark_full(d, t)
        return n

    def enter(self, i: int, count: int, zone: int, agent: int, t: int) -> None:
        if not self.occ[i]:
            self.credit[i] = self.e_credit_max[i]  # an idle edge starts with full discharge credit
        self.queue[i].append([count, t + self.s.e_fft[i] / (FIRE_DRAIN_SPEED_FACTOR if i in self.fire_closed else 1.0),
                              zone, agent])
        self.occ[i] += count
        self.active.add(i)

    def release_zone(self, zone_id: str, at_s: float) -> None:
        if zone_id in self.released_zones:
            return
        self.released_zones.add(zone_id)
        self.first_order_s = at_s if self.first_order_s is None else min(self.first_order_s, at_s)
        zi = self.s.zone_ix[zone_id]
        skip = self.s.shadow_packets.get(zone_id, ()) if zone_id in self.shadow_released else ()
        moved = 0
        for k, (delay, node, count) in enumerate(self.s.zone_packets[zone_id]):
            if k in skip:
                continue  # already left on the fire cue
            heapq.heappush(self.pending, (at_s + delay, self.seq, node, count, zi))
            self.seq += 1
            moved += count
        self.z_preparing[zi] += moved
        self.z_waiting[zi] -= moved

    def shadow_release(self, at_s: float) -> None:
        """Fixed delay: zones not yet released whose origin nodes the fire reached send their shadow packets
        (TrafficParams.shadow_evacuation_share), each after its own drawn delay from now."""
        s = self.s
        burned = self.origin_burned
        for zi, z in enumerate(s.zone_list):
            if z.id in self.released_zones or z.id in self.shadow_released or not (s.zone_origin_ix[zi] & burned):
                continue
            self.shadow_released.add(z.id)
            packets = s.zone_packets[z.id]
            for k in sorted(s.shadow_packets.get(z.id, ())):
                delay, node, count = packets[k]
                heapq.heappush(self.pending, (at_s + delay, self.seq, node, count, zi))
                self.seq += 1
                self.z_preparing[zi] += count
                self.z_waiting[zi] -= count

    def apply_event(self, ev: TrafficEvent, at_s: float) -> None:
        s = self.s
        params, agents_on, edge_index = s.params, s.agents_on, s.edge_index
        if not agents_on and (
                ev.type == "evacuation_order" or (ev.type == "evacuation_warning" and params.warning_releases_demand)):
            for z in ev.zone_ids:
                self.release_zone(z, at_s)
        elif agents_on and ev.type in DEMAND_EVENT_TYPES:
            notice = self.z_ordered_s if ev.type == "evacuation_order" else self.z_warned_s
            for z in ev.zone_ids:
                zi = s.zone_ix[z]
                if notice[zi] is None:
                    notice[zi] = at_s
            if ev.type == "evacuation_order" and ev.zone_ids:
                self.first_order_s = at_s if self.first_order_s is None else min(self.first_order_s, at_s)
        elif ev.type in CLOSE_EVENT_TYPES:
            (self.event_closed_drain if ev.closure_drains else self.event_closed).update(
                edge_index[x] for x in ev.edge_ids)
            self.closures_changed = True
        elif ev.type in REOPEN_EVENT_TYPES:
            self.event_closed.difference_update(edge_index[x] for x in ev.edge_ids)
            self.event_closed_drain.difference_update(edge_index[x] for x in ev.edge_ids)
            self.closures_changed = True
        elif ev.type in SHELTER_FULL_EVENT_TYPES and ev.destination_id is not None:
            self.mark_full(s.dest_ix[ev.destination_id], at_s)
        elif (ev.type in DESTINATION_OPEN_EVENT_TYPES + DESTINATION_CLOSE_EVENT_TYPES
              and ev.destination_id is not None):
            d = s.dest_ix[ev.destination_id]
            is_open = ev.type in DESTINATION_OPEN_EVENT_TYPES
            if self.dest_open[d] != is_open:
                self.dest_open[d] = is_open
                self.routes_dirty = True
        elif ev.type in CAPACITY_EVENT_TYPES and ev.edge_ids:
            for x in ev.edge_ids:
                self.cap_factor[edge_index[x]] = ev.capacity_factor
                self.refresh_capacity(edge_index[x])
            self.routes_dirty = True
        elif ev.type in CONTRAFLOW_START_EVENT_TYPES:
            inbound = []
            for x in ev.edge_ids:
                i = edge_index[x]
                j = s.twin[i]
                # One-way roads have no twin; an edge already lending or borrowing lanes is left as is.
                if j is None or i in self.contraflow_out or i in self.contraflow_in or j in self.contraflow_out:
                    continue
                self.contraflow_out[i] = j
                self.contraflow_in.add(j)
                self.refresh_capacity(i)
                inbound.append(j)
            if inbound:
                names = ", ".join(sorted({s.edges[j].name for j in inbound}))
                self.generated.append(_bundle_event(
                    f"{ev.id}-inbound-closed", ev.at, "road_closed",
                    f"Contraflow inbound lanes closed (derived from {ev.id}): {names}",
                    [s.edges[j].id for j in inbound], evidence_class="derived",
                    time_precision=ev.time_precision, source_id=ev.source_id, source_locator=ev.source_locator,
                ))
                self.closures_changed = True
        elif ev.type in CONTRAFLOW_END_EVENT_TYPES:
            for x in ev.edge_ids:
                i = edge_index[x]
                if i in self.contraflow_out:
                    self.contraflow_in.discard(self.contraflow_out.pop(i))
                    self.refresh_capacity(i)
                    self.closures_changed = True
        elif ev.type in ZONE_ROUTE_EVENT_TYPES:
            for z in ev.zone_ids:
                zi = s.zone_ix[z]
                if ev.destination_id is None:
                    self.zone_dest.pop(zi, None)
                else:
                    self.zone_dest[zi] = s.dest_ix[ev.destination_id]
            self.routes_dirty = True

    def _apply_fire_entry(self, j: int, at: datetime) -> None:
        """set_fire for cumulative fire from the shared FireTimeline (same effect as the direct path)."""
        geom, same, added_edges, added_origins, cued_nodes, cued_zones = self.timeline.entry(j)
        if same:
            return
        s = self.s
        self.fire_geom = geom
        self.origin_burned.update(added_origins)
        if s.agents_on:
            for n in cued_nodes:
                self.fire_cued[n] = 1
            for zi in cued_zones:
                self.zone_cued[zi] = True
            if added_edges:
                self.routes_dirty = True  # exposed edges carry a route penalty
        self.exposed_edges.update(added_edges)
        if not s.params.close_edges_in_fire or not added_edges:
            return
        # Cumulative: fire_closed equals the exposed set before this check, so every added edge is newly
        # closed and nothing reopens.
        edges, generated = s.edges, self.generated
        by_name: dict[str, list[str]] = {}
        for i in added_edges:  # ascending edge index
            by_name.setdefault(edges[i].name, []).append(edges[i].id)
        for name in sorted(by_name):
            ev_id = f"sim-fire-closure-{len(generated) + 1}"
            generated.append(_bundle_event(ev_id, at, "road_closed", f"Modelled fire closure: {name}", by_name[name]))
        t = (at - s.start).total_seconds()
        queue = self.queue
        for i in added_edges:
            for pkt in queue[i]:
                if pkt[1] > t:  # still driving: the rest of the edge at reduced speed
                    pkt[1] = t + (pkt[1] - t) / FIRE_DRAIN_SPEED_FACTOR
        self.fire_closed.update(added_edges)
        self.routes_dirty = True

    def set_fire(self, geom: dict | None, at: datetime) -> None:
        """Direct (per-engine) fire update; used when fire_area_cumulative is off."""
        s = self.s
        params, mid_order, mid_lons, e_mid = s.params, s.mid_order, s.mid_lons, s.e_mid
        if geom is self.fire_geom:
            return
        self.fire_geom = geom
        exposed_edges = self.exposed_edges
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
            cached = self.fire_cache.get(id(geom))
            if cached is None or cached[0] is not geom:
                x0, y0, x1, y1 = _geometry_bbox(geom)
                candidates = (
                    i for i in mid_order[bisect_left(mid_lons, x0):bisect_right(mid_lons, x1)]
                    if y0 <= e_mid[i][1] <= y1
                )
                inside = frozenset(_points_inside(geom, e_mid, candidates))
                self.fire_cache[id(geom)] = (geom, inside)
                while len(self.fire_cache) > FIRE_CACHE_MAX_GEOMETRIES:
                    del self.fire_cache[next(iter(self.fire_cache))]
            else:
                inside = cached[1]
        origin_burned = self.origin_burned
        if geom is None:
            if not params.fire_area_cumulative:
                origin_burned.clear()
        else:
            x0, y0, x1, y1 = _geometry_bbox(geom)
            if not params.fire_area_cumulative:
                origin_burned.clear()
            candidates = [
                n for n in s.origin_order[bisect_left(s.origin_lons, x0):bisect_right(s.origin_lons, x1)]
                if n not in origin_burned and y0 <= s.origin_pts[n][1] <= y1
            ]
            origin_burned.update(_points_inside(geom, s.origin_pts, candidates))
        if s.agents_on:
            if geom is not None:
                _update_fire_cues(s, geom, self.burned_nodes, self.fire_cued, self.zone_cued)
            if inside != exposed_edges:
                self.routes_dirty = True  # exposed edges carry a route penalty
        self.exposed_edges = inside
        if not params.close_edges_in_fire:
            return
        newly_closed, reopened = inside - self.fire_closed, self.fire_closed - inside
        edges, generated = s.edges, self.generated
        for ev_type, group, verb in (("road_closed", newly_closed, "closure"), ("road_reopened", reopened, "reopening")):
            by_name: dict[str, list[str]] = {}
            for i in sorted(group):
                by_name.setdefault(edges[i].name, []).append(edges[i].id)
            for name in sorted(by_name):
                ev_id = f"sim-fire-{verb}-{len(generated) + 1}"
                generated.append(_bundle_event(ev_id, at, ev_type, f"Modelled fire {verb}: {name}", by_name[name]))
        t = (at - s.start).total_seconds()
        for i in newly_closed:
            for pkt in self.queue[i]:
                if pkt[1] > t:  # still driving: the rest of the edge at reduced speed
                    pkt[1] = t + (pkt[1] - t) / FIRE_DRAIN_SPEED_FACTOR
        if newly_closed or reopened:
            self.fire_closed = set(inside)
            self.routes_dirty = True

    def decide_departures(self, t: int) -> None:
        """Waiting agents decide to leave with a hazard from notice, fire and social cues."""
        s = self.s
        bp, step, brng = s.bp, s.step, self.brng
        response_scale = s.response_scale
        dt = bp.decision_every_s
        for zi in range(s.n_zones):
            agents = self.zone_waiting_agents[zi]
            if not agents:
                continue
            if self.z_ordered_s[zi] is not None:
                notice_h = bp.order_hazard_per_h / response_scale
            elif self.z_warned_s[zi] is not None:
                notice_h = bp.warning_hazard_per_h / response_scale
            else:
                notice_h = 0.0
            vehicles = s.zone_list[zi].vehicles
            social_h = bp.social_hazard_per_h / response_scale * self.z_departed[zi] / vehicles if vehicles else 0.0
            if notice_h == 0 and social_h == 0 and not self.zone_cued[zi]:
                continue
            still = []
            for a in agents:
                fire_h = bp.fire_cue_hazard_per_h / response_scale if self.fire_cued[s.ag_node[a]] else 0.0
                n_h, s_h = (0.0, 0.0) if s.ag_wait_fire[a] else (notice_h, social_h)
                h = n_h + fire_h + s_h
                if h <= 0 or brng.random() >= bh.decision_probability(h, dt):
                    still.append(a)
                    continue
                u = brng.random() * h
                self.ag_trigger[a] = (bh.TRIGGER_ORDER if u < n_h else bh.TRIGGER_FIRE if u < n_h + fire_h
                                      else bh.TRIGGER_SOCIAL)
                prep_s = min(s.prep_cap_s, brng.lognormvariate(s.prep_mu, bp.prep_sigma))
                heapq.heappush(self.preparing, (t + max(prep_s, step), a))
                self.z_waiting[zi] -= s.ag_count[a]
                self.z_preparing[zi] += s.ag_count[a]
            self.zone_waiting_agents[zi] = still

    def turn_back(self, t: int) -> None:
        """Agents on a stopped or dead-end edge decide once per edge whether to turn back to its start."""
        s = self.s
        e_to, e_from, e_fft, step = s.e_to, s.e_from, s.e_fft, s.step
        for i in sorted(self.active):
            stopped = self.closed[i] and i in self.closed_hard
            if not (stopped or (self.next_edge[e_to[i]] == -1 and self.open_dest_at(e_to[i]) is None)):
                continue
            keep = deque()
            for pkt in self.queue[i]:
                count, ready, zone, a = pkt
                if self.ag_turn_edge[a] == i:
                    keep.append(pkt)
                    continue
                self.ag_turn_edge[a] = i
                if self.brng.random() < s.bp.turn_back_prob:
                    back_s = min(e_fft[i], max(step, t - (ready - e_fft[i])))  # retrace the distance covered
                    heapq.heappush(self.returning, (t + back_s, self.seq, e_from[i], count, zone, a))
                    self.seq += 1
                    self.occ[i] -= count
                    self.turned_back += count
                else:
                    keep.append(pkt)
            self.queue[i] = keep
            if not keep:
                self.active.discard(i)

    def edge_rows(self, t: int) -> list[tuple[int, int, float, bool]]:
        """(edge, vehicles, mean speed kph, stopped) for occupied edges, in index order."""
        edges, queue, occ, closed = self.s.edges, self.queue, self.occ, self.closed
        closed_hard, fire_closed = self.closed_hard, self.fire_closed
        rows = []
        for i in sorted(self.active):
            moving = sum(p[0] for p in queue[i] if p[1] > t)
            stopped = closed[i] and i in closed_hard
            kph = edges[i].speed_kph * (FIRE_DRAIN_SPEED_FACTOR if i in fire_closed else 1.0)
            rows.append((i, occ[i], 0.0 if stopped else kph * moving / occ[i], stopped))
        return rows

    def fire_trapped_rows(self, rows) -> list[tuple[int, int]]:
        """(edge, vehicles) on fire-exposed edges (not event-stopped) whose downstream node has no route or escape."""
        e_to, next_edge, exposed_edges = self.s.e_to, self.next_edge, self.exposed_edges
        return [(i, n) for i, n, _, stopped in rows
                if not stopped and i in exposed_edges and next_edge[e_to[i]] == -1
                and self.open_dest_at(e_to[i]) is None]

    def state_counts(self, rows) -> dict[str, int]:
        s = self.s
        e_to, next_edge, open_dest_at = s.e_to, self.next_edge, self.open_dest_at
        blocked = by_closure = 0
        for i, n, _, stopped in rows:
            if stopped:
                by_closure += n
            if stopped or (next_edge[e_to[i]] == -1 and open_dest_at(e_to[i]) is None):
                blocked += n
        for node, q in self.waiting.items():
            if q and next_edge[node] == -1 and open_dest_at(node) is None:
                blocked += sum(p[0] for p in q)
        exposed_edges, nd_at_node, usable = self.exposed_edges, self.nd_at_node, self.usable
        counts = {
            "not_departed_veh": self.not_departed,
            "en_route_veh": s.total_veh - self.not_departed - self.arrived,
            "arrived_veh": self.arrived,
            "blocked_veh": blocked,
            "exposed_veh": sum(n for i, n, _, _ in rows if i in exposed_edges),
            "exposed_at_origin_veh": sum(nd_at_node[n] for n in self.origin_burned),
            "trapped_by_fire_veh": sum(n for _, n in self.fire_trapped_rows(rows)),
            "trapped_by_closure_veh": by_closure,
            "open_refuges": sum(1 for d in s.refuge_ix if usable(d)),
            "active_refuges": sum(1 for d in s.refuge_ix if usable(d) and self.dest_arrived[d] > 0),
        }
        if s.agents_on:
            counts.update({
                "waiting_veh": sum(self.z_waiting),
                "preparing_veh": sum(self.z_preparing),
                "turned_back_veh": self.turned_back,
                **{f"departed_by_{trig}_veh": self.departed_by[trig] for trig in bh.TRIGGERS},
            })
        return counts

    def record(self, t: int, at: datetime) -> None:
        s = self.s
        edges = s.edges
        rows = self.edge_rows(t)
        frame_edges = []
        if self.record_frames:
            edge_peak = self.edge_peak
            for i, n, speed, _ in rows:
                frame_edges.append([i, n, round(speed, 1)])
                stat = edge_peak.setdefault(i, [0, t, math.inf, 0])
                if n > stat[0]:
                    stat[0], stat[1] = n, t
                stat[2] = min(stat[2], speed)
                if speed < CONGESTED_SPEED_FRACTION * edges[i].speed_kph:
                    stat[3] += 1
        counts = self.state_counts(rows)
        not_departed, arrived, total_veh = self.not_departed, self.arrived, s.total_veh
        en_route = counts["en_route_veh"]
        if not (min(not_departed, en_route, arrived) >= 0 and not_departed + en_route + arrived == total_veh):
            raise AssertionError(f"population not conserved at {format_utc(at)}")
        on_edges = sum(self.occ[i] for i in self.active)
        in_wait = sum(p[0] for q in self.waiting.values() for p in q)
        in_return = sum(r[3] for r in self.returning)
        if (on_edges + in_wait + in_return != en_route or counts["blocked_veh"] > en_route
                or counts["exposed_veh"] > en_route):
            raise AssertionError(f"inconsistent vehicle states at {format_utc(at)}")
        if s.agents_on and (counts["waiting_veh"] + counts["preparing_veh"] != not_departed
                            or sum(self.departed_by.values()) != total_veh - not_departed):
            raise AssertionError(f"inconsistent resident states at {format_utc(at)}")
        if (counts["trapped_by_fire_veh"] + counts["trapped_by_closure_veh"] > counts["blocked_veh"]):
            raise AssertionError(f"inconsistent trapped counts at {format_utc(at)}")
        new_traps = [i for i, _ in self.fire_trapped_rows(rows) if i not in self.fire_trapped_edges]
        generated = self.generated
        if new_traps:
            self.fire_trapped_edges.update(new_traps)
            by_name: dict[str, list[int]] = {}
            for i in new_traps:
                by_name.setdefault(edges[i].name, []).append(i)
            for name in sorted(by_name):
                ids = by_name[name]
                generated.append(_bundle_event(
                    f"sim-fire-entrapment-{len(generated) + 1}", at, "vehicles_trapped",
                    f"{ENTRAPMENT_LABEL_PREFIX}: {name} ({sum(self.occ[i] for i in ids)} veh)",
                    [edges[i].id for i in ids], time_precision=FIRE_CLOSURE_TIME_PRECISION))
        if self.record_frames:
            self.frames.append({
                "at": format_utc(at),
                "edges": frame_edges,
                "closed": self.closed_list,
            })
            self.metrics.append({"at": format_utc(at), **counts})
        if counts["exposed_at_origin_veh"] > not_departed:
            raise AssertionError(f"inconsistent origin exposure at {format_utc(at)}")
        peaks = self.peaks
        for key in peaks:
            peaks[key] = max(peaks[key], counts[key])
        minutes = s.params.record_every_s / 60
        self.exposed_veh_min += counts["exposed_veh"] * minutes
        self.exposed_at_origin_veh_min += counts["exposed_at_origin_veh"] * minutes
        self.last_counts = counts
        if self.metrics_hook is not None:
            self.metrics_hook(t, counts)

    def view(self, t: int, at: datetime) -> TrafficView:
        s = self.s
        edges, start = s.edges, s.start
        rows = self.edge_rows(t)

        def when(sec: float | None) -> datetime | None:
            return None if sec is None else start + timedelta(seconds=sec)

        return TrafficView(
            at=at,
            network=s.network,
            edge_veh=MappingProxyType({edges[i].id: n for i, n, _, _ in rows}),
            edge_speed_ratio=MappingProxyType({edges[i].id: speed / edges[i].speed_kph for i, _, speed, _ in rows}),
            closed_edge_ids=frozenset(edges[i].id for i in self.closed_list),
            exposed_edge_ids=frozenset(edges[i].id for i in self.exposed_edges),
            zones=MappingProxyType({
                z.id: ZoneView(
                    id=z.id, name=z.name, vehicles=z.vehicles,
                    ordered_at=when(self.z_ordered_s[zi]) if s.agents_on else (
                        when(self.first_release_s.get(z.id))),
                    warned_at=when(self.z_warned_s[zi]),
                    waiting_veh=self.z_waiting[zi], preparing_veh=self.z_preparing[zi],
                    departed_veh=self.z_departed[zi], arrived_veh=self.z_arrived[zi],
                )
                for zi, z in enumerate(s.zone_list)
            }),
            full_destination_ids=frozenset(d.id for k, d in enumerate(s.dest_list) if self.dest_full[k]),
            closed_destination_ids=frozenset(d.id for k, d in enumerate(s.dest_list) if not self.dest_open[k]),
            metrics=MappingProxyType(self.state_counts(rows)),
            fire_area=self.fire_geom,
            elapsed_s=t,
            contraflow_outbound_edge_ids=frozenset(edges[i].id for i in self.contraflow_out),
        )

    def _apply_external(self, ev: TrafficEvent, at_s: float) -> None:
        """Record and apply a controller or injected event (same handling for both)."""
        if not self.s.agents_on and ev.type == "evacuation_order":
            for z in ev.zone_ids:
                self.first_release_s.setdefault(z, at_s)
        self.generated.append(_bundle_event(
            ev.id, ev.at, ev.type, ev.label, list(ev.edge_ids), evidence_class=ev.evidence_class,
            time_precision=ev.time_precision, source_id=ev.source_id, source_locator=ev.source_locator,
            zone_ids=list(ev.zone_ids), destination_id=ev.destination_id,
        ))
        self.apply_event(ev, at_s)

    def run_controllers(self, t: int, at: datetime) -> None:
        s = self.s
        start = s.start
        snapshot = self.view(t, at)
        for controller in self.controllers:
            for ev in controller(at, snapshot) or ():
                if ev.at.tzinfo is None or ev.at.utcoffset() is None or not (start <= ev.at <= at):
                    raise ValueError(f"controller event {ev.id} must be timezone-aware with start <= at <= {at}")
                if ev.id in self.used_event_ids:
                    raise ValueError(f"controller event id {ev.id} is not unique")
                _check_event_targets(ev, s.edge_index, s.zone_ix, s.dest_ix)
                self.used_event_ids.add(ev.id)
                self._apply_external(ev, (ev.at - start).total_seconds())

    # --- one model step

    def step(self) -> None:
        """Run model step k (time k * step_s): events, fire, controllers, commands, routes, moves, record."""
        s = self.s
        k = self.k
        if k > s.n_steps:
            raise RuntimeError("engine already finished")
        params, agents_on, bp = s.params, s.agents_on, s.bp
        step = s.step
        t = k * step
        at = s.start + timedelta(seconds=t)

        # 1. events due by now
        self.closures_changed = False
        ev_sorted, ev_s = s.ev_sorted, s.ev_s
        while self.ev_next < len(ev_sorted) and ev_s[self.ev_next] <= t:
            ev = ev_sorted[self.ev_next]
            if not agents_on and ev.type == "evacuation_order":
                for z in ev.zone_ids:
                    self.first_release_s.setdefault(z, ev_s[self.ev_next])
            self.apply_event(ev, ev_s[self.ev_next])
            self.ev_next += 1
        # 2. fire area in effect
        if s.fire_area_at is not None and not self.fire_frozen and t % params.fire_check_every_s == 0:
            if self.timeline is not None:
                self._apply_fire_entry(t // params.fire_check_every_s, at)
            else:
                self.set_fire(s.fire_area_at(at), at)
            if s.shadow_packets and self.origin_burned:
                self.shadow_release(t)
        # 3. controllers
        if self.controllers and t % s.controller_every_s == 0:
            self.run_controllers(t, at)
        # 3b. injected commands due by now (never merged into the historical events)
        injected = self.injected
        while injected and injected[0][0] <= t:
            at_s, _, ev = heapq.heappop(injected)
            self._apply_external(ev, at_s)
        if self.closures_changed or self.routes_dirty:
            closed_hard = self.closed_hard = set(self.event_closed)
            union = closed_hard | self.event_closed_drain | self.fire_closed | self.contraflow_in
            if union != self.closed_set:
                closed = self.closed
                for i in union ^ self.closed_set:
                    closed[i] = i in union
                self.closed_set = union
                self.closed_list = sorted(union)
                self.closures_changed = True
        # 4. routes
        if self.routes_dirty or self.closures_changed or t >= self.next_reroute_s:
            self.rebuild_routes()
            self.routes_dirty = False
            self.next_reroute_s = t + params.reroute_interval_s

        # 5. resident decisions, then departures and returns due by now join their node
        if agents_on and t % bp.decision_every_s == 0:
            self.decide_departures(t)
            if bp.turn_back_prob > 0:
                self.turn_back(t)
        waiting, add_series = self.waiting, self.add_series
        pending, nd_at_node = self.pending, self.nd_at_node
        z_preparing, z_departed, zone_departures = self.z_preparing, self.z_departed, self.zone_departures
        while pending and pending[0][0] <= t:
            _, _, node, count, zone = heapq.heappop(pending)
            self.not_departed -= count
            nd_at_node[node] -= count
            z_preparing[zone] -= count
            z_departed[zone] += count
            add_series(zone_departures[zone], t, count)
            waiting.setdefault(node, deque()).append([count, zone, -1])
        preparing = self.preparing
        while preparing and preparing[0][0] <= t:
            _, a = heapq.heappop(preparing)
            zone, count = s.ag_zone[a], s.ag_count[a]
            self.not_departed -= count
            nd_at_node[s.ag_node[a]] -= count
            z_preparing[zone] -= count
            z_departed[zone] += count
            self.departed_by[self.ag_trigger[a]] += count
            self.z_trigger_veh[zone][self.ag_trigger[a]] += count
            add_series(zone_departures[zone], t, count)
            waiting.setdefault(s.ag_node[a], deque()).append([count, zone, a])
        returning = self.returning
        while returning and returning[0][0] <= t:
            _, _, node, count, zone, a = heapq.heappop(returning)
            waiting.setdefault(node, deque()).append([count, zone, a])

        # 6. move packets off edges, in edge-index order
        queue, credit, occ, closed = self.queue, self.credit, self.occ, self.closed
        e_cap_step, e_credit_max, e_storage = self.e_cap_step, self.e_credit_max, self.e_storage
        closed_hard, active, next_edge = self.closed_hard, self.active, self.next_edge
        e_to = s.e_to
        open_dest_at, accept, enter, choose = self.open_dest_at, self.accept, self.enter, self.choose
        zone_memory = self.zone_memory
        assigned = bool(self.zone_dest)
        admit_at, route = self.admit_at, self.route
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
                d = admit_at(node, zone) if assigned else open_dest_at(node)
                if d is not None:
                    n = accept(d, count, zone, t)
                    credit[i] -= n
                    occ[i] -= n
                    if n < count:
                        q[0][0] = count - n
                        break  # remainder waits for the route rebuild at the next step
                    q.popleft()
                    continue
                if assigned:
                    ne = route(node, zone, a)
                else:
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
                d = admit_at(node, zone) if assigned else open_dest_at(node)
                if d is not None:
                    n = accept(d, count, zone, t)
                    if n < count:
                        wq[0][0] = count - n
                        break
                    wq.popleft()
                    continue
                if assigned:
                    ne = route(node, zone, a)
                else:
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
            self.record(t, at)
        self.k = k + 1

    # --- output

    def result(self) -> dict:
        """The bundle `traffic` block plus generated_events, assumptions and limitations (simulate_traffic)."""
        s = self.s
        params, start, edges, dest_list, zone_list = s.params, s.start, s.edges, s.dest_list, s.zone_list
        peaks, dest_arrived = self.peaks, self.dest_arrived
        arrived, total_veh = self.arrived, s.total_veh
        first_order_s, last_arrival_s = self.first_order_s, self.last_arrival_s

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
            "not_departed_veh": self.not_departed,
            "first_order_at": None if first_order_s is None else format_utc(start + timedelta(seconds=first_order_s)),
            "last_arrival_at": None if last_arrival_s is None else format_utc(
                start + timedelta(seconds=last_arrival_s)),
            "arrived_by_destination_veh": {d.id: dest_arrived[i] for i, d in enumerate(dest_list)},
            "max_trapped_by_fire_veh": peaks["trapped_by_fire_veh"],
            "max_trapped_by_closure_veh": peaks["trapped_by_closure_veh"],
            "fire_entrapment_edges": len(self.fire_trapped_edges),
            "max_active_refuges": peaks["active_refuges"],
            "refuges_used": sum(1 for d in s.refuge_ix if dest_arrived[d] > 0),
        }
        zone_stats = {
            z.id: {
                "departures": [[iso(t), n] for t, n in self.zone_departures[k]],
                "arrivals": [[iso(t), n] for t, n in self.zone_arrivals[k]],
            }
            for k, z in enumerate(zone_list)
        }
        assumptions, limitations = list(ASSUMPTIONS), list(LIMITATIONS)
        if s.agents_on:
            summary.update({
                "departed_by_trigger_veh": dict(self.departed_by),
                "turned_back_veh": self.turned_back,
                "waiting_at_end_veh": sum(self.z_waiting),
                "preparing_at_end_veh": sum(self.z_preparing),
            })
            for k, z in enumerate(zone_list):
                zone_stats[z.id]["departed_by_trigger_veh"] = dict(self.z_trigger_veh[k])
            assumptions = [a for a in assumptions if a != _FIXED_DELAY_ASSUMPTION] + bh.ASSUMPTIONS
            limitations = [x for x in limitations if x not in _FIXED_DELAY_LIMITATIONS] + bh.LIMITATIONS

        return {
            "evidence_class": "simulated",
            "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict(), "seed": params.seed},
            "edge_ids": s.edge_ids_out,
            "frames": self.frames,
            "metrics": self.metrics,
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
                    for i, stat in sorted(self.edge_peak.items())
                ],
                "destination_stats": {
                    d.id: {
                        "arrived_veh": dest_arrived[k],
                        "full_at": None if self.dest_full_s[k] is None else iso(self.dest_full_s[k]),
                        "arrivals": [[iso(t), n] for t, n in self.dest_series[k]],
                    }
                    for k, d in enumerate(dest_list)
                },
            },
            "generated_events": self.generated,
            "assumptions": assumptions,
            "limitations": limitations,
        }
