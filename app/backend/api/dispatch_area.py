"""GET /api/dispatch/area?bbox=w,s,e,n: a drivable dispatch area for any bounding box.

The /dispatch page (docs/adr/0014-dispatch-agent.md) needs a road graph, evacuation zones,
exits and fire stations. This endpoint builds them at runtime from the OpenStreetMap
Overpass API and caches the result (docs/adr/0016-dispatch-anywhere.md). It ports the
logic of tools/build_dispatch_area.py, which produced one static fixture offline.

Observed (OSM): road geometry, class, name, lanes, maxspeed, oneway; place names; fire
station locations. Assumed (named constants below): lane capacity and default speed by
class, homes per km of residential street, vehicles per home, one engine per station.
Synthetic: homes are placed along residential streets, not real buildings; zones are grid
cells over residential streets, not official evacuation zones. Wire schema: version 2.

Caching: in-process LRU, then MongoDB `dispatch_areas`, then a fresh build. The cache key
is the builder version plus the bbox snapped outward to a 0.01 degree grid. MongoDB being
unavailable only costs the shared cache; the endpoint still works.
"""

import gzip
import hashlib
import json
import logging
import math
import threading
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict
from datetime import UTC, datetime
from http.client import HTTPException

from bson import Binary
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse
from pymongo.errors import PyMongoError
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from .mongodb import get_database

logger = logging.getLogger(__name__)

BUILDER_VERSION = "dispatch-area/2"
COLLECTION = "dispatch_areas"
MAX_STORED_BYTES = 15 * 1024 * 1024
LRU_ENTRIES = 8
CACHE_CONTROL = "public, max-age=86400"

OVERPASS_MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
USER_AGENT = "CrisisTwin/0.1 (hackathon research; github.com/ryankim0709/crisistwin)"
OVERPASS_HTTP_TIMEOUT_S = 90
OVERPASS_QUERY_TIMEOUT_S = 80

# Request limits, in degrees. The box is snapped outward to GRID_DEG.
GRID_DEG = 0.01
MIN_SPAN_DEG = 0.01
MAX_LAT_SPAN_DEG = 0.22
MAX_LON_SPAN_DEG = 0.28
MAX_ABS_LAT = 85.0

ROAD_CLASSES = (
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street",
)
EXIT_CLASSES = {"motorway", "trunk", "primary", "secondary"}
RESIDENTIAL_CLASSES = {"residential", "living_street", "unclassified"}
PLACE_KINDS = ("neighbourhood", "suburb", "quarter", "hamlet", "village", "town")

# Assumed traffic parameters (not observed). Saturation flow per lane by class, vehicles/hour,
# lower than urban arterial textbook values to reflect narrow, curving hill roads.
CAPACITY_PER_LANE_VPH = {
    "motorway": 1900, "trunk": 1600, "primary": 1200, "secondary": 1000, "tertiary": 800,
}
DEFAULT_CAPACITY_PER_LANE_VPH = 600
SPEED_DEFAULT_KPH = {
    "motorway": 100, "trunk": 80, "primary": 56, "secondary": 48, "tertiary": 40,
    "unclassified": 40, "residential": 32, "living_street": 16,
}
KPH_PER_MPH = 1.609344

# Synthetic demand (planning placeholders, not Census counts).
HOMES_PER_KM = 50  # both sides of the street combined
VEHICLES_PER_HOME = 1.6
HOME_SETBACK_M = 16
MAX_HOMES = 20_000
ZONE_CELL_METERS = 1000
ZONE_CELL_GROWTH_M = 200
MIN_ZONE_STREET_KM = 0.6
MAX_ZONES = 60
EXIT_DEDUPE_METERS = 400
ENGINES_PER_STATION = 1
STATION_SEARCH_BUFFER_M = 3000
MAX_STATIONS = 16

EARTH_RADIUS_M = 6_371_008.8
M_PER_DEG_LAT = math.pi * EARTH_RADIUS_M / 180

ATTRIBUTION = "Roads, places and fire stations © OpenStreetMap contributors, ODbL"
NOTES = [
    "Zones are grid cells over residential streets, not official evacuation zones.",
    "Homes are synthetic: placed every ~40 m along both sides of residential streets, "
    "not real buildings or Census counts.",
    "Each OSM fire station is given one engine; real staffing is not modelled.",
]

Box = tuple[float, float, float, float]  # west, south, east, north


class UpstreamUnavailable(Exception):
    """No Overpass mirror produced a usable answer."""


class NoRoads(Exception):
    pass


class NoExits(Exception):
    pass


# --- geometry helpers -------------------------------------------------------------------


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def parse_speed_kph(tag: str | None, cls: str) -> float:
    default = SPEED_DEFAULT_KPH.get(cls.removesuffix("_link"), 40)
    if not tag:
        return default
    text = tag.strip().lower()
    try:
        if text.endswith("mph"):
            return float(text[:-3].strip()) * KPH_PER_MPH
        return float(text)
    except ValueError:
        return default


def lanes_one_direction(tags: dict, oneway: bool) -> int:
    try:
        lanes = int(str(tags.get("lanes", "")).split(";")[0])
    except ValueError:
        lanes = 0
    if lanes <= 0:
        return 2 if tags["highway"] == "motorway" else 1
    return lanes if oneway else max(1, lanes // 2)


def side_of_box(box: Box, lon: float, lat: float) -> str:
    w, s, e, n = box
    distances = {"south": lat - s, "north": n - lat, "west": lon - w, "east": e - lon}
    return min(distances, key=distances.get)


# --- Overpass ---------------------------------------------------------------------------


def overpass(query: str) -> dict:
    """POST a query to each mirror in turn; return the first usable JSON answer."""
    body = urllib.parse.urlencode({"data": query}).encode()
    for url in OVERPASS_MIRRORS:
        request = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=OVERPASS_HTTP_TIMEOUT_S) as response:
                data = json.load(response)
        except (OSError, ValueError, HTTPException) as exc:
            logger.warning("Overpass mirror failed: %s (%s)", urllib.parse.urlparse(url).netloc, type(exc).__name__)
            continue
        if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
            continue
        remark = str(data.get("remark", "")).lower()
        if "error" in remark or "timed out" in remark:
            logger.warning("Overpass mirror reported a problem: %s", urllib.parse.urlparse(url).netloc)
            continue
        return data
    raise UpstreamUnavailable


# --- builder ----------------------------------------------------------------------------


def _homes_along(pts: list[tuple[float, float]], spacing: float) -> list[tuple[float, float]]:
    """Offsets (metres east, north) of homes on both sides of a metre-space polyline."""
    out: list[tuple[float, float]] = []
    seg_lens = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    total = sum(seg_lens)
    k = 0
    seg = 0
    seg_start = 0.0
    while (d := (k + 0.5) * spacing) < total:
        while seg < len(seg_lens) - 1 and seg_start + seg_lens[seg] <= d:
            seg_start += seg_lens[seg]
            seg += 1
        length = seg_lens[seg]
        if length > 0:
            a, b = pts[seg], pts[seg + 1]
            t = (d - seg_start) / length
            x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
            out.append((x - uy * HOME_SETBACK_M, y + ux * HOME_SETBACK_M))  # left
            out.append((x + uy * HOME_SETBACK_M, y - ux * HOME_SETBACK_M))  # right
        k += 1
    return out


def _count_per_side(total: float, spacing: float) -> int:
    return max(0, math.ceil(total / spacing - 0.5))


def _build_zone_groups(res_edges: list[dict], box: Box, lat0: float) -> tuple[list[list[int]], float]:
    """Group residential edges into grid-cell zones. Returns (edge-index groups, cell metres)."""
    w, s, _, _ = box
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    cell_m = ZONE_CELL_METERS
    while True:
        cells: dict[tuple[int, int], dict] = defaultdict(lambda: {"km": 0.0, "edges": []})
        for edge in res_edges:
            key = (
                int((edge["mid"][0] - w) * m_lon // cell_m),
                int((edge["mid"][1] - s) * M_PER_DEG_LAT // cell_m),
            )
            cells[key]["km"] += edge["km"]
            cells[key]["edges"].append(edge["index"])
        if not cells:
            return [], cell_m
        kept = [k for k, c in cells.items() if c["km"] >= MIN_ZONE_STREET_KM]
        if not kept:
            kept = [max(cells, key=lambda k: cells[k]["km"])]
        if len(kept) <= MAX_ZONES:
            break
        cell_m += ZONE_CELL_GROWTH_M
    members = {k: list(cells[k]["edges"]) for k in kept}
    for key, cell in cells.items():
        if key in members:
            continue
        nearest = min(kept, key=lambda k: (k[0] - key[0]) ** 2 + (k[1] - key[1]) ** 2)
        members[nearest].extend(cell["edges"])
    ordered = sorted(members, key=lambda k: (-k[1], k[0]))
    return [members[k] for k in ordered], cell_m


def snap_box(w: float, s: float, e: float, n: float) -> Box:
    def down(v: float) -> float:
        return round(math.floor(v / GRID_DEG + 1e-6) * GRID_DEG, 2)

    def up(v: float) -> float:
        return round(math.ceil(v / GRID_DEG - 1e-6) * GRID_DEG, 2)

    return down(w), down(s), up(e), up(n)


def build_area(box: Box) -> dict:
    w, s, e, n = box
    lat0 = (s + n) / 2
    lon0 = (w + e) / 2
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(lat0))

    def inside(lon: float, lat: float) -> bool:
        return s <= lat <= n and w <= lon <= e

    classes = "|".join(ROAD_CLASSES)
    buf_lat = STATION_SEARCH_BUFFER_M / M_PER_DEG_LAT
    buf_lon = STATION_SEARCH_BUFFER_M / m_lon
    # One request: roads with their nodes, then place nodes and fire stations (the latter in
    # a box expanded by STATION_SEARCH_BUFFER_M so stations just outside can still serve it).
    roads = overpass(
        f"[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_S}];"
        f'way[highway~"^({classes})$"]({s},{w},{n},{e});out body;>;out skel qt;'
        f'(node[place~"^({"|".join(PLACE_KINDS)})$"]({s},{w},{n},{e});'
        f"nwr[amenity=fire_station]({s - buf_lat:.6f},{w - buf_lon:.6f},{n + buf_lat:.6f},{e + buf_lon:.6f}););"
        "out center;"
    )
    osm_timestamp = roads.get("osm3s", {}).get("timestamp_osm_base")

    coords: dict[int, tuple[float, float]] = {}
    ways = []
    for element in roads["elements"]:
        if element.get("type") == "node":
            coords[element["id"]] = (element["lon"], element["lat"])
        elif element.get("type") == "way" and "highway" in element.get("tags", {}):
            ways.append(element)

    # Split each way into runs of consecutive inside nodes; remember boundary-crossing nodes
    # as exit candidates, with the direction a vehicle would leave.
    runs = []
    exit_candidates = []  # (ref, class, label)
    for way in ways:
        tags = way.get("tags", {})
        cls = tags["highway"]
        if cls not in ROAD_CLASSES:
            continue
        oneway = tags.get("oneway") in ("yes", "true", "1") or cls in ("motorway", "motorway_link")
        reverse = tags.get("oneway") == "-1"
        refs = list(reversed(way["nodes"])) if reverse else way["nodes"]
        oneway = oneway or reverse
        run: list[int] = []
        for i, ref in enumerate(refs):
            if ref not in coords:
                continue
            if inside(*coords[ref]):
                run.append(ref)
                nxt = refs[i + 1] if i + 1 < len(refs) else None
                prv = refs[i - 1] if i > 0 else None
                leaves_forward = nxt in coords and not inside(*coords[nxt])
                leaves_backward = (not oneway) and prv in coords and not inside(*coords[prv])
                if leaves_forward or leaves_backward:
                    exit_candidates.append((ref, cls, tags.get("ref") or tags.get("name") or cls))
            else:
                if len(run) >= 2:
                    runs.append((run, tags, cls, oneway))
                run = []
        if len(run) >= 2:
            runs.append((run, tags, cls, oneway))

    usage: dict[int, int] = defaultdict(int)
    for run, *_ in runs:
        for ref in run:
            usage[ref] += 1
        usage[run[0]] += 1
        usage[run[-1]] += 1
    forced = {ref for ref, cls, _ in exit_candidates if cls in EXIT_CLASSES}

    node_index: dict[int, int] = {}
    nodes: list[list[float]] = []

    def node_id(ref: int) -> int:
        if ref not in node_index:
            node_index[ref] = len(nodes)
            lon, lat = coords[ref]
            nodes.append([round(lon, 6), round(lat, 6)])
        return node_index[ref]

    class_list = list(ROAD_CLASSES)
    names: list[str] = []
    name_index: dict[str, int] = {}
    edges: list[list] = []
    for run, tags, cls, oneway in runs:
        name = tags.get("name") or tags.get("ref") or ""
        if name and name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        kph = round(parse_speed_kph(tags.get("maxspeed"), cls), 1)
        base = cls.removesuffix("_link")
        capacity = lanes_one_direction(tags, oneway) * CAPACITY_PER_LANE_VPH.get(base, DEFAULT_CAPACITY_PER_LANE_VPH)
        start = 0
        for i in range(1, len(run)):
            ref = run[i]
            if i == len(run) - 1 or usage[ref] > 1 or ref in forced:
                segment = run[start : i + 1]
                length = sum(haversine_m(coords[a], coords[b]) for a, b in zip(segment, segment[1:]))
                if length > 0:
                    geometry = [c for r in segment[1:-1] for c in (round(coords[r][0], 6), round(coords[r][1], 6))]
                    edges.append([
                        node_id(segment[0]), node_id(segment[-1]), round(length, 1), class_list.index(cls),
                        kph, capacity, 1 if oneway else 0, name_index.get(name, -1), geometry,
                    ])
                start = i

    if not edges:
        raise NoRoads

    # Keep the largest weakly connected component.
    parent = list(range(len(nodes)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for edge in edges:
        ra, rb = find(edge[0]), find(edge[1])
        if ra != rb:
            parent[ra] = rb
    sizes: dict[int, int] = defaultdict(int)
    for i in range(len(nodes)):
        sizes[find(i)] += 1
    main = max(sizes, key=sizes.get)
    keep = [i for i in range(len(nodes)) if find(i) == main]
    remap = {old: new for new, old in enumerate(keep)}
    nodes = [nodes[i] for i in keep]
    edges = [[remap[ed[0]], remap[ed[1]], *ed[2:]] for ed in edges if ed[0] in remap and ed[1] in remap]
    ref_to_node = {ref: remap[idx] for ref, idx in node_index.items() if idx in remap}
    if not edges:
        raise NoRoads

    # Exits: deduplicated boundary crossings of major roads (any road class as a fallback).
    def pick_exits(candidates: list[tuple[int, str, str]], rank: dict[str, int]) -> list[dict]:
        found: list[dict] = []
        for ref, cls, label in sorted(candidates, key=lambda c: rank[c[1]]):
            if ref not in ref_to_node:
                continue
            node = ref_to_node[ref]
            point = tuple(nodes[node])
            if any(haversine_m(point, tuple(nodes[x["node"]])) < EXIT_DEDUPE_METERS for x in found):
                continue
            found.append({"node": node, "road": label, "side": side_of_box(box, *point)})
        return found

    exits = pick_exits(
        [c for c in exit_candidates if c[1] in EXIT_CLASSES],
        {c: i for i, c in enumerate(("motorway", "trunk", "primary", "secondary"))},
    )
    if not exits:
        exits = pick_exits(exit_candidates, {c: i for i, c in enumerate(ROAD_CLASSES)})
    if not exits:
        raise NoExits
    exits.sort(key=lambda x: (x["side"], x["road"]))
    for i, item in enumerate(exits, start=1):
        item["id"] = f"X{i:02d}"
        item["name"] = f"{item['road']} ({item['side']})"

    # Places and fire stations.
    place_points: list[tuple[str, tuple[float, float]]] = []
    stations: list[dict] = []
    for element in roads["elements"]:
        tags = element.get("tags", {})
        if tags.get("amenity") != "fire_station" and tags.get("place") not in PLACE_KINDS:
            continue
        center = element.get("center", {})
        lat = element.get("lat", center.get("lat"))
        lon = element.get("lon", center.get("lon"))
        if lat is None or lon is None:
            continue
        if tags.get("amenity") == "fire_station":
            stations.append({"name": tags.get("name") or "Fire station", "location": [round(lon, 6), round(lat, 6)]})
        elif tags.get("name") and inside(lon, lat):
            place_points.append((tags["name"], (lon, lat)))

    # Homes: synthetic, on both sides of residential edges.
    res_edges = []
    for ei, edge in enumerate(edges):
        if class_list[edge[3]] not in RESIDENTIAL_CLASSES:
            continue
        a, b = nodes[edge[0]], nodes[edge[1]]
        geom = edge[8]
        poly = [tuple(a)] + [(geom[j], geom[j + 1]) for j in range(0, len(geom), 2)] + [tuple(b)]
        pts_m = [((lon - lon0) * m_lon, (lat - lat0) * M_PER_DEG_LAT) for lon, lat in poly]
        total = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(pts_m, pts_m[1:]))
        res_edges.append({
            "index": ei, "pts": pts_m, "total": total, "km": edge[2] / 1000,
            "mid": ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2),
        })
    spacing = 1000 / (HOMES_PER_KM / 2)
    homes_applied: float = HOMES_PER_KM
    estimate = sum(2 * _count_per_side(r["total"], spacing) for r in res_edges)
    while estimate > MAX_HOMES:
        spacing *= max(estimate / MAX_HOMES, 1.01)
        estimate = sum(2 * _count_per_side(r["total"], spacing) for r in res_edges)
    if spacing != 1000 / (HOMES_PER_KM / 2):
        homes_applied = round(2000 / spacing, 1)
    edge_homes: dict[int, list[tuple[float, float]]] = {}
    for r in res_edges:
        edge_homes[r["index"]] = [
            (round(lon0 + x / m_lon, 6), round(lat0 + y / M_PER_DEG_LAT, 6))
            for x, y in _homes_along(r["pts"], spacing)
        ]

    # Zones: grid cells over residential edges, small cells merged into the nearest kept one.
    groups, cell_m = _build_zone_groups(res_edges, box, lat0)
    zones: list[dict] = []
    homes_out: list[list] = []
    for group in groups:
        points = [p for ei in group for p in edge_homes[ei]]
        if not points:
            continue
        weights: dict[int, float] = defaultdict(float)
        for ei in group:
            weights[edges[ei][0]] += edges[ei][2]
            weights[edges[ei][1]] += edges[ei][2]
        hull = convex_hull(points)
        cx = sum(p[0] for p in hull) / len(hull)
        cy = sum(p[1] for p in hull) / len(hull)
        node = min(weights, key=lambda i: haversine_m((cx, cy), tuple(nodes[i])) / (1 + weights[i] / 1000))
        near = min(place_points, key=lambda p: haversine_m((cx, cy), p[1]))[0] if place_points else "area"
        zi = len(zones)
        zones.append({
            "near": near, "node": node, "homes": len(points), "vehicles": round(len(points) * VEHICLES_PER_HOME),
            "centroid": [round(cx, 6), round(cy, 6)],
            "polygon": [[round(p[0], 6), round(p[1], 6)] for p in hull],
        })
        ordered = sorted(
            points,
            key=lambda p: hashlib.blake2b(f"{p[0]:.6f},{p[1]:.6f}".encode(), digest_size=8).digest(),
        )
        homes_out.extend([lon, lat, zi] for lon, lat in ordered)
    for i, zone in enumerate(zones, start=1):
        zone["id"] = f"Z{i:02d}"
        zone["name"] = f"Z{i:02d} · near {zone.pop('near')}"

    # Stations: nearest MAX_STATIONS to the box centre, then ordered by name.
    centre = (lon0, lat0)
    nearest = sorted(stations, key=lambda st: haversine_m(centre, tuple(st["location"])))[:MAX_STATIONS]
    out_stations = []
    for i, station in enumerate(sorted(nearest, key=lambda st: st["name"]), start=1):
        loc = tuple(station["location"])
        node = min(range(len(nodes)), key=lambda j: haversine_m(loc, tuple(nodes[j])))
        out_stations.append({
            "id": f"S{i:02d}", "name": station["name"], "node": node, "location": station["location"],
            "approachMeters": round(haversine_m(loc, tuple(nodes[node]))),
            "units": [
                {"id": f"E{i:02d}{'' if k == 0 else chr(97 + k)}", "type": "engine"}
                for k in range(ENGINES_PER_STATION)
            ],
        })

    near_centre = min(place_points, key=lambda p: haversine_m(centre, p[1]))[0] if place_points else None
    return {
        "kind": "crisistwin_dispatch_area",
        "schemaVersion": 2,
        "id": f"osm-{w:.2f}_{s:.2f}_{e:.2f}_{n:.2f}",
        "name": f"{near_centre} area" if near_centre else "Selected area",
        "bbox": [w, s, e, n],
        "generatedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "builder": BUILDER_VERSION,
        "sources": {"osm": {"timestamp": osm_timestamp, "attribution": ATTRIBUTION}},
        "assumptions": {
            "homesPerKm": HOMES_PER_KM,
            "homesPerKmApplied": homes_applied,
            "vehiclesPerHome": VEHICLES_PER_HOME,
            "zoneCellMeters": cell_m,
            "homeSetbackMeters": HOME_SETBACK_M,
            "capacityPerLaneVph": {**CAPACITY_PER_LANE_VPH, "other": DEFAULT_CAPACITY_PER_LANE_VPH},
            "speedDefaultKph": SPEED_DEFAULT_KPH,
            "enginesPerStation": ENGINES_PER_STATION,
            "notes": NOTES,
        },
        "classes": class_list,
        "names": names,
        "nodes": nodes,
        "edges": edges,
        "zones": zones,
        "homes": homes_out,
        "exits": exits,
        "stations": out_stations,
    }


def build_gzip(box: Box) -> bytes:
    raw = json.dumps(build_area(box), separators=(",", ":"), ensure_ascii=False).encode()
    return gzip.compress(raw, compresslevel=6, mtime=0)


# --- cache ------------------------------------------------------------------------------

_lru: OrderedDict[str, bytes] = OrderedDict()
_lru_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}
_key_locks_guard = threading.Lock()
_MONGO_ERRORS = (PyMongoError, ValueError, ImproperlyConfigured, AttributeError)


def _lru_get(key: str) -> bytes | None:
    with _lru_lock:
        if key in _lru:
            _lru.move_to_end(key)
            return _lru[key]
    return None


def _lru_put(key: str, gz: bytes) -> None:
    with _lru_lock:
        _lru[key] = gz
        _lru.move_to_end(key)
        while len(_lru) > LRU_ENTRIES:
            _lru.popitem(last=False)


def _mongo_get(key: str) -> bytes | None:
    try:
        doc = get_database()[COLLECTION].find_one({"_id": key, "builder": BUILDER_VERSION})
    except _MONGO_ERRORS:
        logger.warning("dispatch area cache read failed; building without it")
        return None
    gz = doc.get("gz") if doc else None
    return bytes(gz) if gz else None


def _mongo_put(key: str, gz: bytes) -> None:
    if len(gz) > MAX_STORED_BYTES:
        return
    try:
        get_database()[COLLECTION].replace_one(
            {"_id": key},
            {"_id": key, "builder": BUILDER_VERSION, "builtAt": datetime.now(UTC), "bytes": len(gz), "gz": Binary(gz)},
            upsert=True,
        )
    except _MONGO_ERRORS:
        logger.warning("dispatch area cache write failed; continuing without it")


def get_area_gzip(box: Box) -> bytes:
    key = f"{BUILDER_VERSION}:{box[0]:.2f},{box[1]:.2f},{box[2]:.2f},{box[3]:.2f}"
    if (hit := _lru_get(key)) is not None:
        return hit
    with _key_locks_guard:
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:
        if (hit := _lru_get(key)) is not None:
            return hit
        gz = _mongo_get(key)
        if gz is None:
            gz = build_gzip(box)
            _mongo_put(key, gz)
        _lru_put(key, gz)
        return gz


# --- view -------------------------------------------------------------------------------


class DispatchAreaThrottle(AnonRateThrottle):
    """Per-client cap on area builds, which fan out to the public Overpass service."""

    scope = "dispatch_area"
    rate = "20/min"


def _error(status: int, code: str, detail: str) -> Response:
    return Response({"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"})


def parse_bbox(raw: str | None) -> Box | None:
    """Validate the raw `w,s,e,n` parameter and return the snapped build box."""
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) != 4:
        return None
    try:
        w, s, e, n = (float(p) for p in parts)
    except ValueError:
        return None
    if not all(math.isfinite(v) for v in (w, s, e, n)) or w >= e or s >= n:
        return None
    if abs(s) >= MAX_ABS_LAT or abs(n) >= MAX_ABS_LAT:
        return None
    eps = 1e-9
    if e - w > MAX_LON_SPAN_DEG + eps or n - s > MAX_LAT_SPAN_DEG + eps:
        return None
    if e - w < MIN_SPAN_DEG - eps or n - s < MIN_SPAN_DEG - eps:
        return None
    return snap_box(w, s, e, n)


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([DispatchAreaThrottle])
def dispatch_area(request):
    """Return the dispatch area (schema v2) for `?bbox=west,south,east,north`."""
    box = parse_bbox(request.query_params.get("bbox"))
    if box is None:
        return _error(
            400,
            "bad_bbox",
            "bbox must be west,south,east,north in degrees, at most "
            f"{MAX_LON_SPAN_DEG} deg wide and {MAX_LAT_SPAN_DEG} deg tall, at least {MIN_SPAN_DEG} deg each.",
        )
    try:
        gz = get_area_gzip(box)
    except UpstreamUnavailable:
        return _error(
            502,
            "upstream_unavailable",
            "OpenStreetMap's Overpass service could not be reached; try again in a minute.",
        )
    except NoRoads:
        return _error(422, "no_roads", "No drivable roads were found in this area.")
    except NoExits:
        return _error(422, "no_exits", "No roads leave this area, so there is nowhere to evacuate to.")
    headers = {"Cache-Control": CACHE_CONTROL, "Vary": "Accept-Encoding"}
    if "gzip" in request.headers.get("Accept-Encoding", "").lower():
        response = HttpResponse(gz, content_type="application/json")
        response["Content-Encoding"] = "gzip"
    else:
        response = HttpResponse(gzip.decompress(gz), content_type="application/json")
    for name, value in headers.items():
        response[name] = value
    return response
