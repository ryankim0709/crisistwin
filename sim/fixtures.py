"""Synthetic fixture scenario for the traffic engine. NOT historical data.

A schematic ridge town placed roughly over Paradise, CA, with a grid of local streets
and four egress corridors. Geometry is generated procedurally and is not surveyed;
names, zones, vehicle totals and event times are invented, round, stand-in values.
Everything is labelled evidence_class "fixture".
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sim.geo import EARTH_RADIUS_M
from sim.traffic import DemandZone, Destination, RoadEdge, RoadNetwork, TrafficEvent, default_edge_attributes

EVIDENCE_CLASS = "fixture"
SOURCE_ID = "fixture"

CLOCK_START = datetime(2018, 11, 8, 14, 0, tzinfo=timezone.utc)
CLOCK_END = datetime(2018, 11, 9, 2, 0, tzinfo=timezone.utc)

# Town street grid: GRID_ROWS x GRID_COLS nodes, row 0 at the south, skewed so the town follows a NNE ridge.
GRID_ROWS, GRID_COLS = 9, 8
GRID_ORIGIN = (-121.640, 39.745)  # (lon, lat) of row 0, col 0 before skew
GRID_STEP_DEG = (0.0080, 0.0063)  # (lon, lat) node spacing, about 690 m x 700 m
RIDGE_SKEW_DEG_LON_PER_ROW = 0.0015
SPINE_COL = 3  # the grid column that carries the town's tertiary spine
CORRIDOR_SEGMENT_M = 1200.0  # target corridor segment length
CORRIDOR_WIGGLE_DEG = 0.004  # sideways amplitude of the corridor's sine bend

# (name, start grid (row, col), exit (lon, lat), highway, bridge segment indexes)
_CORRIDORS = (
    ("SW", (0, 0), (-121.735, 39.700), "trunk", ()),
    ("W", (5, 0), (-121.770, 39.775), "primary", (2,)),
    ("S", (0, 4), (-121.600, 39.655), "primary", ()),
    ("SE", (0, 7), (-121.520, 39.680), "primary", (3,)),
)
SHELTER_CORRIDOR, SHELTER_NODE_INDEX, SHELTER_CAPACITY_VEH = "S", 4, 1500
BLOCKED_CORRIDOR, BLOCKED_SEGMENT_INDEX = "SW", 1

# (id, name, rows, cols, households, vehicles); totals 6,600 households and 10,000 vehicles.
_ZONES = (
    ("z1", "Fixture zone 1 (NE)", (5, 8), (4, 7), 1700, 2500),
    ("z2", "Fixture zone 2 (NW)", (5, 8), (0, 3), 1300, 2000),
    ("z3", "Fixture zone 3 (central E)", (2, 4), (4, 7), 1300, 2000),
    ("z4", "Fixture zone 4 (central W)", (2, 4), (0, 3), 1300, 2000),
    ("z5", "Fixture zone 5 (south)", (0, 1), (0, 7), 1000, 1500),
)
# (id, minute after 14:00Z, type, zone ids)
_ZONE_EVENTS = (
    ("fx-ev1", 45, "evacuation_order", ("z1",)),
    ("fx-ev2", 70, "evacuation_order", ("z2",)),
    ("fx-ev3", 90, "evacuation_warning", ("z5",)),
    ("fx-ev4", 95, "evacuation_order", ("z3",)),
    ("fx-ev5", 115, "evacuation_order", ("z4",)),
    ("fx-ev7", 150, "evacuation_order", ("z5",)),
)
BLOCK_EVENT_MINUTE = 120

NOTES = [
    "Synthetic fixture: schematic geometry placed over Paradise, CA; not a surveyed road network.",
    "Road names, zones, households, vehicles, destinations and event times are invented stand-ins.",
    "Lanes, speeds and capacities are sim.traffic.default_edge_attributes assumptions by highway class.",
    "Replace with the camp-2018-evacuation package layers once acquired.",
]


def _grid_lonlat(row: float, col: float) -> tuple[float, float]:
    lon = GRID_ORIGIN[0] + col * GRID_STEP_DEG[0] + row * RIDGE_SKEW_DEG_LON_PER_ROW
    lat = GRID_ORIGIN[1] + row * GRID_STEP_DEG[1]
    return round(lon, 6), round(lat, 6)


def _length_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    kx = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.radians(math.hypot((b[0] - a[0]) * kx, b[1] - a[1])) * EARTH_RADIUS_M


def _at(minute: int) -> datetime:
    return CLOCK_START + timedelta(minutes=minute)


def camp_fixture_scenario() -> dict:
    """Synthetic scenario: network, zones, destinations, events, bbox, clock and notes."""
    nodes: dict[str, tuple[float, float]] = {}
    edges: list[RoadEdge] = []
    segments: dict[str, list[str]] = {}  # segment id -> its two directed edge ids

    def add_segment(a: str, b: str, name: str, highway: str, bridge: bool = False) -> str:
        seg = f"s{len(segments) + 1}"
        attrs = default_edge_attributes(highway)
        length = round(_length_m(nodes[a], nodes[b]), 1)
        ids = []
        for u, v in ((a, b), (b, a)):
            eid = f"e{len(edges) + 1}"
            edges.append(RoadEdge(
                id=eid, segment_id=seg, from_node=u, to_node=v, length_m=length,
                lanes=attrs["lanes"], speed_kph=attrs["speed_kph"],
                capacity_veh_per_hour=attrs["capacity_veh_per_hour"],
                name=name, highway=highway, bridge=bridge, coords=(nodes[u], nodes[v]),
            ))
            ids.append(eid)
        segments[seg] = ids
        return seg

    def grid_node(r: int, c: int) -> str:
        return f"g{r}_{c}"

    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            nodes[grid_node(r, c)] = _grid_lonlat(r, c)
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS - 1):
            add_segment(grid_node(r, c), grid_node(r, c + 1), f"Fixture street {r + 1}", "residential")
    for c in range(GRID_COLS):
        spine = c == SPINE_COL
        for r in range(GRID_ROWS - 1):
            add_segment(
                grid_node(r, c), grid_node(r + 1, c),
                "Fixture spine" if spine else f"Fixture avenue {c + 1}",
                "tertiary" if spine else "residential",
            )

    destinations: list[Destination] = []
    corridor_segments: dict[str, list[str]] = {}
    for name, (r0, c0), exit_ll, highway, bridges in _CORRIDORS:
        start_id = grid_node(r0, c0)
        a = nodes[start_id]
        n_seg = max(2, math.ceil(_length_m(a, exit_ll) / CORRIDOR_SEGMENT_M))
        dx, dy = exit_ll[0] - a[0], exit_ll[1] - a[1]
        norm = math.hypot(dx, dy)
        px, py = -dy / norm, dx / norm  # unit perpendicular in degree space
        path = [start_id]
        for k in range(1, n_seg + 1):
            f = k / n_seg
            bend = CORRIDOR_WIGGLE_DEG * math.sin(math.pi * f) * math.sin(3 * math.pi * f)
            nid = f"c{name}_{k}"
            nodes[nid] = (round(a[0] + f * dx + bend * px, 6), round(a[1] + f * dy + bend * py, 6))
            path.append(nid)
        corridor_segments[name] = []
        for k, (u, v) in enumerate(zip(path, path[1:])):
            bridge = k in bridges
            label = f"Fixture corridor {name}" + (" bridge" if bridge else "")
            corridor_segments[name].append(add_segment(u, v, label, highway, bridge))
        destinations.append(Destination(
            id=f"d-exit-{name.lower()}", name=f"Fixture exit {name}", kind="exit",
            node_id=path[-1], coord=nodes[path[-1]], capacity_veh=None,
        ))
        if name == SHELTER_CORRIDOR:
            sid = path[SHELTER_NODE_INDEX]
            destinations.append(Destination(
                id="d-shelter-1", name="Fixture shelter", kind="shelter",
                node_id=sid, coord=nodes[sid], capacity_veh=SHELTER_CAPACITY_VEH,
            ))

    zones = []
    for zid, name, (r_lo, r_hi), (c_lo, c_hi), households, vehicles in _ZONES:
        corners = [
            _grid_lonlat(r_lo - 0.5, c_lo - 0.5), _grid_lonlat(r_lo - 0.5, c_hi + 0.5),
            _grid_lonlat(r_hi + 0.5, c_hi + 0.5), _grid_lonlat(r_hi + 0.5, c_lo - 0.5),
        ]
        ring = [list(p) for p in corners + corners[:1]]
        zones.append(DemandZone(
            id=zid, name=name, households=households, vehicles=vehicles,
            origin_nodes=tuple(grid_node(r, c) for r in range(r_lo, r_hi + 1) for c in range(c_lo, c_hi + 1)),
            geometry={"type": "Polygon", "coordinates": [ring]},
        ))
    zone_names = {z.id: z.name for z in zones}

    events = []
    for eid, minute, ev_type, zone_ids in _ZONE_EVENTS:
        kind = "Evacuation order" if ev_type == "evacuation_order" else "Evacuation warning"
        events.append(TrafficEvent(
            id=eid, at=_at(minute), type=ev_type,
            label=f"{kind}: " + ", ".join(zone_names[z] for z in zone_ids),
            evidence_class=EVIDENCE_CLASS, time_precision="minute", zone_ids=zone_ids, source_id=SOURCE_ID,
        ))
    blocked_seg = corridor_segments[BLOCKED_CORRIDOR][BLOCKED_SEGMENT_INDEX]
    events.append(TrafficEvent(
        id="fx-ev6", at=_at(BLOCK_EVENT_MINUTE), type="road_blocked",
        label=f"Road blocked: Fixture corridor {BLOCKED_CORRIDOR}",
        evidence_class=EVIDENCE_CLASS, time_precision="minute",
        edge_ids=tuple(segments[blocked_seg]), source_id=SOURCE_ID,
    ))
    events.sort(key=lambda ev: (ev.at, ev.id))

    lons = [p[0] for p in nodes.values()]
    lats = [p[1] for p in nodes.values()]
    return {
        "network": RoadNetwork(nodes=nodes, edges=tuple(edges)),
        "zones": tuple(zones),
        "destinations": tuple(destinations),
        "events": tuple(events),
        "bbox": [round(min(lons), 4), round(min(lats), 4), round(max(lons), 4), round(max(lats), 4)],
        "clock_start": CLOCK_START,
        "clock_end": CLOCK_END,
        "evidence_class": EVIDENCE_CLASS,
        "notes": list(NOTES),
    }
