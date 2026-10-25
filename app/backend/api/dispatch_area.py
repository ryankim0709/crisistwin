"""GET /api/dispatch/area?bbox=w,s,e,n: a drivable dispatch area for any bounding box.

The /dispatch page (docs/adr/0014-dispatch-agent.md) needs a road graph, evacuation zones,
exits and fire stations. This endpoint builds them at runtime from the OpenStreetMap
Overpass API and caches the result (docs/adr/0017-dispatch-anywhere.md). It ports the
logic of tools/build_dispatch_area.py, which produced one static fixture offline.

Observed (OSM): road geometry, class, name, lanes, maxspeed, oneway, bridge; a subset of each
way's tags (TAG_KEYS: surface, tracktype, width, maxweight, ... kept in a deduplicated
`tagSets` table); highway=turning_circle/turning_loop nodes; where ways leave the box; place
names; fire station locations. Assumed (named constants below): lane capacity and default speed
by class (including service 25 and track 15 km/h), homes per km of residential street, vehicles
per home, one engine per station. Synthetic: homes are placed along residential streets, not
real buildings; zones are grid cells over residential streets, not official evacuation zones.

Wire schema: version 2, additive. Edge rows carry a trailing bridge flag since builder
dispatch-area/3 and, since dispatch-area/4, index 10 = tagSets index and index 11 = accessOnly
flag. "service" and "track" are appended to `classes`; their edges are access-only: they serve
fire-apparatus routing (the frontend applies per-class access rules, docs/suppression-data.md)
and never evacuation. The evacuation graph is the largest component of the public ROAD_CLASSES
edges; access-only edges are kept only when reachable from it, are listed after all public
edges, and their nodes are indexed after all public nodes. Zones, homes, exits and station
snapping use public nodes only. One side effect: a public way is split at a node where an
access-only way joins it (needed to attach the access edge), so a public edge can be two rows.
`turningNodes` and `boundaryNodes` are node indices (boundaryNodes: a way continues outside the
box, so the node is not a dead end).

Exits are SAFE AREAS (since dispatch-area/6): places people go, away from the fire, not the box
edge. Candidates within SHELTER_SEARCH_RADIUS_M of the box centre come from three sources, merged
(listings within SAFE_AREA_DEDUPE_M are one place; the better source wins): officially designated
places curated with citations in dispatch_safe_areas.json (the City of Berkeley "Shelter Sites"
layer; the City publishes no temporary evacuation point list), registered shelters from FEMA's
ESF#6 Shelter System (the former National Shelter System, public ArcGIS service) and OSM
emergency assembly points / evacuation centres / shelters. Every exit carries `destination` (name, kind, source, location, capacity) and a capacity
in people: the source's figure (FEMA evacuation_capacity, OSM capacity=*, curated) or, without one,
ASSUMED_CAPACITY_PEOPLE for its kind (labelled `capacityBasis: "assumption"`).
- `kind: "safe-area"`: the place is inside the box; `node` is the nearest public road node
  (`approachMeters` straight-line from it). At most MAX_INSIDE_SAFE_AREAS, official first.
- `kind: "egress"`: the place is beyond the box; `node` is a motorway/trunk/primary (then
  secondary) crossing of the box edge whose outward heading has the place ahead of it, as in
  dispatch-area/5 (straight-line distance beyond the box: those roads are not routed). At most
  MAX_EGRESS, one per road and direction. `destination.key` names the place, so two egress roads
  leading to one shelter share its capacity.
- `kind: "map-edge"`: when no egress toward a known place exists, deduplicated major-road crossings
  of the box edge, "approximate exit (map edge)", capacity null (leaving the area). They stay a
  last resort beside the safe areas so a board can still evacuate when the fire threatens them all.
Which destinations are open for an incident (not reached by the forecast fire, capacity left) is
decided board-side (app/src/demo/safeDestinations.ts), not here.

Caching: in-process LRU, then MongoDB `dispatch_areas`, then a fresh build. The cache key
is the builder version plus the bbox snapped outward to a 0.01 degree grid. MongoDB being
unavailable only costs the shared cache; the endpoint still works.
"""

import gzip
import hashlib
import json
import logging
import math
import re
import threading
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict
from datetime import UTC, datetime
from http.client import HTTPException
from pathlib import Path

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

BUILDER_VERSION = "dispatch-area/6"
COLLECTION = "dispatch_areas"
SHELTER_COLLECTION = "dispatch_shelters"
SHELTER_CACHE_VERSION = "shelters/2"
CURATED_SAFE_AREAS_PATH = Path(__file__).with_name("dispatch_safe_areas.json")
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
# Access-only classes: drivable by apparatus but not part of the evacuation network.
ACCESS_CLASSES = ("service", "track")
EXCLUDED_SERVICE = ("driveway", "parking_aisle", "drive-through")
TURNING_CLASSES = ("turning_circle", "turning_loop")
TAG_KEYS = (
    "highway", "surface", "tracktype", "smoothness", "width", "maxweight", "maxheight", "bridge",
    "access", "emergency", "motor_vehicle", "lanes", "oneway", "maxspeed", "service", "junction",
    "noexit",
)
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
    "service": 25, "track": 15,  # assumed: no observed speed for these classes
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
# Egress toward real shelters. The 30 km radius and the cap of 6 are product choices (how far an
# evacuee is sent, how many exits a dispatcher can hold in mind), not sourced values.
SHELTER_SEARCH_RADIUS_M = 30_000
MAX_EGRESS = 6
EGRESS_CLASS_RANK = {"motorway": 0, "trunk": 1, "primary": 2, "secondary": 3}
# Assumption: a shelter is "ahead" of an egress road when its bearing from the crossing is within
# 75 degrees of the road's outward heading (measured over up to EGRESS_LOOKAHEAD_M of the way).
EGRESS_AHEAD_MAX_DEG = 75
EGRESS_LOOKAHEAD_M = 3000
# Safe areas inside the box (dispatch-area/6). Product choices, not sourced values: how many inside
# destinations a dispatcher can hold in mind, and how close two listings must be to be one place.
MAX_INSIDE_SAFE_AREAS = 24
SAFE_AREA_DEDUPE_M = 300
SAFE_AREA_SPREAD_CELL_M = 2500  # at most one inside place per cell of this size, so they spread out
# Source preference when listings merge or the inside cap bites: official designation first.
SAFE_AREA_SOURCE_RANK = {"official": 0, "fema-nss": 1, "osm": 2}
# ASSUMPTION (no published per-site figure): people a place can take when its source gives no
# capacity. Planning placeholders per kind, labelled `capacityBasis: "assumption"` on the wire.
ASSUMED_CAPACITY_PEOPLE = {
    "shelter": 300,
    "evacuation centre": 500,
    "temporary evacuation point": 1000,
    "assembly point": 500,
}
ASSUMED_CAPACITY_DEFAULT_PEOPLE = 300
FEMA_NSS_URL = "https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/FeatureServer/5/query"
FEMA_NSS_ATTRIBUTION = (
    "Shelters: FEMA ESF#6 Shelter System (formerly National Shelter System); FEMA, Mass Care, American Red Cross"
)
FEMA_HTTP_TIMEOUT_S = 40
OSM_SHELTER_EXCLUDED_FOR = ("homeless", "abused", "drug_addicted", "migrant", "victim", "juvenile", "child")
US_STATE_CODES = frozenset(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY "
    "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY SR".split()
)
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
    "Service roads and tracks are access-only edges for apparatus routing; they are not "
    "evacuation roads, and their speed (service 25, track 15 km/h) is assumed.",
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


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial great-circle bearing from a to b (lon, lat), degrees clockwise from north."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return math.degrees(math.atan2(y, x)) % 360


def compass(bearing: float) -> str:
    return ("north", "east", "south", "west")[int(((bearing + 45) % 360) // 90)]


def road_label(tags: dict, cls: str) -> str:
    """Readable road name: "I-580", "US 101", "Hwy 24", else the OSM name."""
    ref = str(tags.get("ref") or "").split(";")[0].strip()
    match = re.fullmatch(r"([A-Z]{1,2})[ -]?(\d+[A-Z]?)", ref)
    if match:
        prefix, number = match.groups()
        if prefix == "I":
            return f"I-{number}"
        if prefix == "US":
            return f"US {number}"
        if prefix in US_STATE_CODES:
            return f"Hwy {number}"
    return ref or tags.get("name") or cls


def ahead_point(start: tuple[float, float], onward: list[tuple[float, float]]) -> tuple[float, float] | None:
    """The farthest point of the way beyond the crossing, up to EGRESS_LOOKAHEAD_M away."""
    best = None
    for point in onward:
        if haversine_m(start, point) > EGRESS_LOOKAHEAD_M:
            return point if best is None else best
        best = point
    return best


# --- shelters (destinations) -------------------------------------------------------------


def _fetch_fema_shelters(lon: float, lat: float, radius_m: float) -> list[dict]:
    """Registered shelter facilities from FEMA's ESF#6 Shelter System ("Shelter Locations" layer)."""
    params = urllib.parse.urlencode({
        "where": "1=1", "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "distance": round(radius_m), "units": "esriSRUnit_Meter", "returnGeometry": "true", "outSR": 4326,
        "outFields": "shelter_id,shelter_name,city,evacuation_capacity,shelter_status_code",
        "resultRecordCount": 4000, "f": "json",
    })
    request = urllib.request.Request(f"{FEMA_NSS_URL}?{params}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=FEMA_HTTP_TIMEOUT_S) as response:
        data = json.load(response)
    out = []
    for feature in data.get("features") or []:
        attrs, geom = feature.get("attributes") or {}, feature.get("geometry") or {}
        if not attrs.get("shelter_name") or geom.get("x") is None or geom.get("y") is None:
            continue
        capacity = attrs.get("evacuation_capacity")
        out.append({
            "name": str(attrs["shelter_name"]).strip(),
            "source": "fema-nss",
            "sourceId": str(attrs.get("shelter_id") or ""),
            "city": str(attrs.get("city") or "").strip().title(),
            "location": [round(geom["x"], 6), round(geom["y"], 6)],
            "capacity": int(capacity) if isinstance(capacity, (int, float)) and capacity > 0 else None,
            "status": attrs.get("shelter_status_code"),
            "kind": "shelter",
            "sourceUrl": FEMA_NSS_URL.removesuffix("/query"),
        })
    return out


def _fetch_osm_shelters(lon: float, lat: float, radius_m: float) -> list[dict]:
    """OSM emergency shelters and assembly points (homeless and similar shelters excluded)."""
    around = f"(around:{round(radius_m)},{lat:.6f},{lon:.6f})"
    data = overpass(
        f"[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_S}];"
        f"(nwr[social_facility=shelter]{around};nwr[emergency=assembly_point]{around};"
        f'nwr[emergency~"^(evacuation_centre|shelter)$"]{around};);out center tags;'
    )
    out = []
    for element in data["elements"]:
        tags = element.get("tags", {})
        if any(f in str(tags.get("social_facility:for", "")) for f in OSM_SHELTER_EXCLUDED_FOR):
            continue
        center = element.get("center", {})
        e_lat, e_lon = element.get("lat", center.get("lat")), element.get("lon", center.get("lon"))
        if e_lat is None or e_lon is None or not tags.get("name"):
            continue
        try:
            capacity = int(str(tags.get("capacity", "")).split(";")[0])
        except ValueError:
            capacity = None
        kind = {"assembly_point": "assembly point", "evacuation_centre": "evacuation centre"}.get(
            tags.get("emergency", ""), "shelter"
        )
        out.append({
            "name": tags["name"], "source": "osm", "sourceId": f"{element['type']}/{element['id']}",
            "sourceUrl": f"https://www.openstreetmap.org/{element['type']}/{element['id']}",
            "city": tags.get("addr:city", ""), "location": [round(e_lon, 6), round(e_lat, 6)],
            "capacity": capacity if capacity and capacity > 0 else None, "status": None, "kind": kind,
        })
    return out


def load_shelters(lon: float, lat: float, radius_m: float) -> tuple[list[dict], str | None]:
    """FEMA shelters and OSM assembly points / evacuation centres near (lon, lat), both sources
    (since shelters/2: OSM is no longer only a fallback). Cached in MongoDB when both answered."""
    key = f"{SHELTER_CACHE_VERSION}:{lon:.2f},{lat:.2f},{round(radius_m)}"
    try:
        doc = get_database()[SHELTER_COLLECTION].find_one({"_id": key})
        if doc:
            return doc["shelters"], doc.get("source")
    except _MONGO_ERRORS:
        logger.warning("shelter cache read failed; fetching without it")
    fema: list[dict] | None = None
    osm: list[dict] | None = None
    try:
        fema = _fetch_fema_shelters(lon, lat, radius_m)
    except (OSError, ValueError, HTTPException) as exc:
        logger.warning("FEMA shelter service failed (%s)", type(exc).__name__)
    try:
        osm = _fetch_osm_shelters(lon, lat, radius_m)
    except UpstreamUnavailable:
        logger.warning("OSM safe-area query failed")
    shelters = (fema or []) + (osm or [])
    source = "+".join(name for name, got in (("fema-nss", fema), ("osm", osm)) if got) or None
    if not shelters:
        return [], None  # nothing to cache: a later build may reach the services
    if fema is not None and osm is not None:  # cache only a complete answer
        try:
            get_database()[SHELTER_COLLECTION].replace_one(
                {"_id": key},
                {"_id": key, "source": source, "fetchedAt": datetime.now(UTC), "shelters": shelters},
                upsert=True,
            )
        except _MONGO_ERRORS:
            logger.warning("shelter cache write failed; continuing without it")
    return shelters, source


def _curated_file() -> dict:
    try:
        with open(CURATED_SAFE_AREAS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        logger.warning("curated safe areas unreadable; continuing without them")
        return {}
    return data if isinstance(data, dict) else {}


def curated_exclusions() -> frozenset[str]:
    """`<source>:<sourceId>` of FEMA/OSM listings the curated file drops (e.g. a mislocated record
    whose place the curated list already has), each with a stated reason in the file."""
    return frozenset(
        str(x["key"]) for x in _curated_file().get("excludeListings") or [] if isinstance(x, dict) and x.get("key")
    )


def load_curated_safe_areas() -> list[dict]:
    """Officially designated places curated with citations (dispatch_safe_areas.json), e.g. the City
    of Berkeley's shelter sites. Each keeps its source URL; capacity only when published."""
    data = _curated_file()
    sources = {s.get("id"): s for s in data.get("sources") or [] if isinstance(s, dict)}
    out = []
    for place in data.get("places") or []:
        try:
            lon, lat = float(place["lon"]), float(place["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if not place.get("name"):
            continue
        capacity = place.get("capacity")
        src = sources.get(place.get("sourceId")) or {}
        out.append({
            "name": str(place["name"]).strip(), "source": "official", "sourceId": str(place.get("sourceId") or ""),
            "sourceUrl": place.get("sourceRef") or src.get("url"), "publisher": src.get("publisher"),
            "city": place.get("jurisdiction") or "", "location": [round(lon, 6), round(lat, 6)],
            "capacity": int(capacity) if isinstance(capacity, (int, float)) and capacity > 0 else None,
            "capacitySource": place.get("capacitySource"), "status": None,
            "kind": str(place.get("kind") or "assembly point").replace("_", " "),
        })
    return out


def _safe_area_capacity(place: dict) -> tuple[int, str]:
    """People the place can take and the basis: the source's figure, else the per-kind ASSUMPTION."""
    if isinstance(place.get("capacity"), int) and place["capacity"] > 0:
        return place["capacity"], "source"
    return ASSUMED_CAPACITY_PEOPLE.get(place.get("kind", ""), ASSUMED_CAPACITY_DEFAULT_PEOPLE), "assumption"


def merge_safe_areas(places: list[dict]) -> list[dict]:
    """One entry per place: listings within SAFE_AREA_DEDUPE_M merge, the better-ranked source wins
    (official > FEMA > OSM) and a missing capacity is filled from the other listing."""
    ranked = sorted(places, key=lambda p: (SAFE_AREA_SOURCE_RANK.get(p["source"], 9), p["name"]))
    kept: list[dict] = []
    for place in ranked:
        loc = tuple(place["location"])
        twin = next((k for k in kept if haversine_m(loc, tuple(k["location"])) < SAFE_AREA_DEDUPE_M), None)
        if twin is None:
            kept.append(dict(place))
        elif twin.get("capacity") is None and place.get("capacity"):
            twin["capacity"] = place["capacity"]
            twin["capacitySource"] = f"{place['source']} listing of the same place"
    return kept


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
    excluded = "|".join(EXCLUDED_SERVICE)
    bbox = f"({s},{w},{n},{e})"
    buf_lat = STATION_SEARCH_BUFFER_M / M_PER_DEG_LAT
    buf_lon = STATION_SEARCH_BUFFER_M / m_lon
    # One request: roads with their nodes, then place nodes and fire stations (the latter in
    # a box expanded by STATION_SEARCH_BUFFER_M so stations just outside can still serve it).
    roads = overpass(
        f"[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_S}];"
        f'(way[highway~"^({classes})$"]{bbox};way[highway=track]{bbox};'
        f'way[highway=service][service!~"^({excluded})$"]{bbox};);out body;>;out skel qt;'
        f'(node[place~"^({"|".join(PLACE_KINDS)})$"]{bbox};'
        f'node[highway~"^({"|".join(TURNING_CLASSES)})$"]{bbox};'
        f"nwr[amenity=fire_station]({s - buf_lat:.6f},{w - buf_lon:.6f},{n + buf_lat:.6f},{e + buf_lon:.6f}););"
        "out center;"
    )
    osm_timestamp = roads.get("osm3s", {}).get("timestamp_osm_base")

    coords: dict[int, tuple[float, float]] = {}
    turning_refs: set[int] = set()
    ways = []
    for element in roads["elements"]:
        if element.get("type") == "node":
            coords[element["id"]] = (element["lon"], element["lat"])
            if element.get("tags", {}).get("highway") in TURNING_CLASSES:
                turning_refs.add(element["id"])
        elif element.get("type") == "way" and "highway" in element.get("tags", {}):
            ways.append(element)

    # Split each way into runs of consecutive inside nodes; remember boundary-crossing nodes
    # as exit candidates, with the direction a vehicle would leave.
    runs = []
    exit_candidates = []  # (ref, class, label); public roads only
    boundary_refs: set[int] = set()  # inside nodes where any kept way continues outside the box
    for way in ways:
        tags = way.get("tags", {})
        cls = tags["highway"]
        if cls not in ROAD_CLASSES and cls not in ACCESS_CLASSES:
            continue
        if cls == "service" and tags.get("service") in EXCLUDED_SERVICE:
            continue
        public = cls in ROAD_CLASSES
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
                    boundary_refs.add(ref)
                    if public:
                        onward = refs[i + 1 :] if leaves_forward else refs[i - 1 :: -1]
                        ahead = ahead_point(coords[ref], [coords[r] for r in onward if r in coords])
                        exit_candidates.append(
                            (ref, cls, tags.get("ref") or tags.get("name") or cls, road_label(tags, cls), ahead)
                        )
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
    forced = {c[0] for c in exit_candidates if c[1] in EXIT_CLASSES}

    node_index: dict[int, int] = {}
    nodes: list[list[float]] = []

    def node_id(ref: int) -> int:
        if ref not in node_index:
            node_index[ref] = len(nodes)
            lon, lat = coords[ref]
            nodes.append([round(lon, 6), round(lat, 6)])
        return node_index[ref]

    class_list = [*ROAD_CLASSES, *ACCESS_CLASSES]
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
        bridge = 1 if tags.get("bridge", "no") not in ("no", "") else 0
        tag_key = tuple(sorted((k, str(tags[k])) for k in TAG_KEYS if k in tags))
        access_only = 0 if cls in ROAD_CLASSES else 1
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
                        kph, capacity, 1 if oneway else 0, name_index.get(name, -1), geometry, bridge,
                        tag_key, access_only,
                    ])
                start = i

    if not edges:
        raise NoRoads

    # Keep the largest weakly connected component of the public road edges, exactly as before
    # access-only edges existed. Public nodes keep their relative order and edges stay first.
    public_edges = [ed for ed in edges if not ed[11]]
    access_edges = [ed for ed in edges if ed[11]]
    if not public_edges:
        raise NoRoads
    parent = list(range(len(nodes)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    public_nodes = {i for ed in public_edges for i in (ed[0], ed[1])}
    for edge in public_edges:
        ra, rb = find(edge[0]), find(edge[1])
        if ra != rb:
            parent[ra] = rb
    sizes: dict[int, int] = defaultdict(int)
    for i in sorted(public_nodes):
        sizes[find(i)] += 1
    main = max(sizes, key=sizes.get)
    keep = [i for i in sorted(public_nodes) if find(i) == main]
    remap = {old: new for new, old in enumerate(keep)}
    n_public = len(keep)

    # Access-only edges: keep those reachable from the kept public nodes through access-only
    # edges (breadth-first over the union graph), then index their new nodes after the public ones.
    adjacency: dict[int, list[int]] = defaultdict(list)
    for k, ed in enumerate(access_edges):
        adjacency[ed[0]].append(k)
        adjacency[ed[1]].append(k)
    dropped = public_nodes - set(keep)  # public roads outside the evacuation component
    reached = set(keep)
    kept_access: set[int] = set()
    queue = list(keep)
    while queue:
        node = queue.pop()
        for k in adjacency.get(node, ()):
            if k in kept_access or access_edges[k][0] in dropped or access_edges[k][1] in dropped:
                continue
            kept_access.add(k)
            for other in (access_edges[k][0], access_edges[k][1]):
                if other not in reached:
                    reached.add(other)
                    queue.append(other)
    access_edges = [ed for k, ed in enumerate(access_edges) if k in kept_access]
    for ed in access_edges:
        for i in (ed[0], ed[1]):
            if i not in remap:
                remap[i] = len(remap)
    new_order = sorted(remap, key=remap.get)
    nodes = [nodes[i] for i in new_order]
    edges = [
        [remap[ed[0]], remap[ed[1]], *ed[2:]]
        for ed in public_edges
        if ed[0] in remap and ed[1] in remap and find(ed[0]) == main
    ] + [[remap[ed[0]], remap[ed[1]], *ed[2:]] for ed in access_edges]
    ref_to_node = {ref: remap[idx] for ref, idx in node_index.items() if idx in remap}
    n_public_edges = sum(1 for ed in edges if not ed[11])
    if not n_public_edges:
        raise NoRoads
    tag_sets: list[dict[str, str]] = []
    tag_index: dict[tuple, int] = {}
    for ed in edges:
        key = ed[10]
        if key not in tag_index:
            tag_index[key] = len(tag_sets)
            tag_sets.append(dict(key))
        ed[10] = tag_index[key]
    turning_nodes = sorted({ref_to_node[r] for r in turning_refs if r in ref_to_node})
    boundary_nodes = sorted({ref_to_node[r] for r in boundary_refs if r in ref_to_node})

    # Exits = safe areas (dispatch-area/6): places people go. Inside the box: the place itself,
    # reached at its nearest public road node. Beyond it: the major road leaving toward it.
    half_diagonal = haversine_m((w, s), (e, n)) / 2
    shelter_radius = max(SHELTER_SEARCH_RADIUS_M, half_diagonal + 10_000)
    shelters, shelter_source = load_shelters(round(lon0, 2), round(lat0, 2), shelter_radius)
    curated = [
        p for p in load_curated_safe_areas() if haversine_m((lon0, lat0), tuple(p["location"])) <= shelter_radius
    ]
    dropped = curated_exclusions()
    places = merge_safe_areas(curated + [p for p in shelters if f"{p['source']}:{p.get('sourceId', '')}" not in dropped])
    for place in places:
        place.setdefault("kind", "shelter")
        place["key"] = f"{place['source']}:{place.get('sourceId') or place['name']}"
    within = [p for p in places if inside(*p["location"])]
    beyond = [p for p in places if not inside(*p["location"])]

    def destination(place: dict, metres: float) -> dict:
        capacity, basis = _safe_area_capacity(place)
        if place.get("capacitySource"):
            capacity_source = place["capacitySource"]
        elif basis == "assumption":
            capacity_source = f"ASSUMPTION: dispatch_area.ASSUMED_CAPACITY_PEOPLE[{place['kind']!r}]"
        else:
            capacity_source = {"fema-nss": "FEMA ESF#6 evacuation_capacity", "osm": "OSM capacity=*"}.get(
                place["source"], place["source"]
            )
        return {
            "key": place["key"], "name": place["name"], "kind": place["kind"], "source": place["source"],
            "sourceId": place.get("sourceId", ""), "sourceUrl": place.get("sourceUrl"),
            "city": place.get("city", ""), "location": place["location"], "capacity": capacity,
            "capacityBasis": basis, "capacitySource": capacity_source,
            "status": place.get("status"), "straightLineMeters": round(metres),
        }

    def place_label(place: dict) -> str:
        kind = place["kind"]
        return place["name"] if kind in place["name"].lower() else f"{place['name']} ({kind})"

    node_road: dict[int, str] = {}
    for ed in edges:
        if not ed[11] and ed[7] >= 0:
            node_road.setdefault(ed[0], names[ed[7]])
            node_road.setdefault(ed[1], names[ed[7]])

    def nearest_public_node(loc: tuple[float, float]) -> int:
        x0, y0 = loc
        best, best_d = 0, math.inf
        for j in range(n_public):
            dx = (nodes[j][0] - x0) * m_lon
            dy = (nodes[j][1] - y0) * M_PER_DEG_LAT
            d = dx * dx + dy * dy
            if d < best_d:
                best, best_d = j, d
        return best

    def preference(place: dict) -> tuple:
        # Official designation first, then the largest published capacity, then name (stable).
        return (SAFE_AREA_SOURCE_RANK.get(place["source"], 9), -(place.get("capacity") or 0), place["name"])

    # Spread over the area: every officially designated place, plus the best other place per
    # SAFE_AREA_SPREAD_CELL_M cell without one; then the most preferred, up to the cap.
    def cell_of(place: dict) -> tuple[int, int]:
        lon, lat = place["location"]
        return int((lon - w) * m_lon // SAFE_AREA_SPREAD_CELL_M), int((lat - s) * M_PER_DEG_LAT // SAFE_AREA_SPREAD_CELL_M)

    official = [p for p in within if p["source"] == "official"]
    taken = {cell_of(p) for p in official}
    by_cell: dict[tuple[int, int], dict] = {}
    for place in within:
        cell = cell_of(place)
        if place["source"] == "official" or cell in taken:
            continue
        if cell not in by_cell or preference(place) < preference(by_cell[cell]):
            by_cell[cell] = place
    exits: list[dict] = []
    for place in sorted([*official, *by_cell.values()], key=preference)[:MAX_INSIDE_SAFE_AREAS]:
        loc = tuple(place["location"])
        node = nearest_public_node(loc)
        metres = haversine_m(loc, tuple(nodes[node]))
        exits.append({
            "node": node, "road": node_road.get(node, ""), "side": side_of_box(box, *nodes[node]),
            "kind": "safe-area", "inside": True, "approachMeters": round(metres),
            "label": place_label(place), "destination": destination(place, metres),
        })

    def egress_options() -> list[dict]:
        options = []
        for ref, cls, _label, road, ahead in exit_candidates:
            if cls not in EGRESS_CLASS_RANK or ref not in ref_to_node or ahead is None:
                continue
            node = ref_to_node[ref]
            point = tuple(nodes[node])
            heading = bearing_deg(point, ahead)
            best, best_m = None, math.inf
            for shelter in beyond:
                loc = tuple(shelter["location"])
                off = abs((bearing_deg(point, loc) - heading + 180) % 360 - 180)
                metres = haversine_m(point, loc)
                if off <= EGRESS_AHEAD_MAX_DEG and metres < best_m:
                    best, best_m = shelter, metres
            if best is not None:
                options.append({
                    "node": node, "point": point, "road": road, "cls": cls, "heading": compass(heading),
                    "shelter": best, "metres": best_m,
                })
        return sorted(options, key=lambda o: (EGRESS_CLASS_RANK[o["cls"]], o["metres"]))

    def pick_egress(options: list[dict]) -> list[dict]:
        found: list[dict] = []
        seen_roads: set[str] = set()
        seen: set[tuple[str, str]] = set()
        for one_per_road in (True, False):  # first one exit per road, then other directions
            for opt in options:
                if len(found) >= MAX_EGRESS:
                    return found
                key = (opt["road"], opt["heading"])
                if key in seen or (one_per_road and opt["road"] in seen_roads):
                    continue
                if any(haversine_m(opt["point"], f["point"]) < EXIT_DEDUPE_METERS for f in found):
                    continue
                seen.add(key)
                seen_roads.add(opt["road"])
                found.append(opt)
        return found

    egress = pick_egress(egress_options())
    for opt in egress:
        exits.append({
            "node": opt["node"], "road": opt["road"], "side": side_of_box(box, *opt["point"]),
            "kind": "egress", "inside": False, "approachMeters": round(opt["metres"]),
            "label": f"{opt['road']} {opt['heading']} → {place_label(opt['shelter'])}",
            "destination": destination(opt["shelter"], opt["metres"]),
        })

    # Fallback: deduplicated boundary crossings of major roads (any road class as a last resort).
    def pick_exits(candidates: list[tuple], rank: dict[str, int]) -> list[dict]:
        found: list[dict] = []
        for ref, cls, label, *_ in sorted(candidates, key=lambda c: rank[c[1]]):
            if ref not in ref_to_node or len(found) >= MAX_EGRESS:
                continue
            node = ref_to_node[ref]
            point = tuple(nodes[node])
            if any(haversine_m(point, tuple(nodes[x["node"]])) < EXIT_DEDUPE_METERS for x in found):
                continue
            side = side_of_box(box, *point)
            found.append({
                "node": node, "road": label, "side": side, "kind": "map-edge", "inside": False,
                "label": f"{label} ({side}) · approximate exit (map edge)",
            })
        return found

    # Without an egress toward a known place, keep map-edge crossings as the last resort beside
    # the safe areas: a board needs somewhere to send people when the fire threatens them all.
    if not egress:
        fallback = pick_exits(
            [c for c in exit_candidates if c[1] in EXIT_CLASSES],
            {c: i for i, c in enumerate(("motorway", "trunk", "primary", "secondary"))},
        )
        if not fallback:
            fallback = pick_exits(exit_candidates, {c: i for i, c in enumerate(ROAD_CLASSES)})
        exits.extend(fallback)
    if not exits:
        raise NoExits
    kind_order = {"safe-area": 0, "egress": 1, "map-edge": 2}
    exits.sort(key=lambda x: (kind_order[x["kind"]], x["side"], x["road"], x["label"]))
    for i, item in enumerate(exits, start=1):
        item["id"] = f"X{i:02d}"
        item["name"] = item.pop("label")
        # People the destination takes; null for a map edge (leaving the area, no known place).
        item["capacity"] = item["destination"]["capacity"] if "destination" in item else None

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
        if edge[11] or class_list[edge[3]] not in RESIDENTIAL_CLASSES:
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
        node = min(range(n_public), key=lambda j: haversine_m(loc, tuple(nodes[j])))
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
        "sources": {
            "osm": {"timestamp": osm_timestamp, "attribution": ATTRIBUTION},
            "shelters": {
                "source": shelter_source,
                "attribution": "; ".join(
                    a for key, a in (("fema-nss", FEMA_NSS_ATTRIBUTION), ("osm", ATTRIBUTION)) if key in (shelter_source or "")
                ) or None,
                "searchRadiusMeters": round(shelter_radius),
                "found": len(shelters),
            },
            "safeAreas": {
                "curated": len(curated),
                "curatedFile": CURATED_SAFE_AREAS_PATH.name,
                "candidates": len(places),
                "inside": sum(1 for x in exits if x["kind"] == "safe-area"),
                "egress": sum(1 for x in exits if x["kind"] == "egress"),
                "mapEdge": sum(1 for x in exits if x["kind"] == "map-edge"),
            },
        },
        "assumptions": {
            "homesPerKm": HOMES_PER_KM,
            "homesPerKmApplied": homes_applied,
            "vehiclesPerHome": VEHICLES_PER_HOME,
            "zoneCellMeters": cell_m,
            "homeSetbackMeters": HOME_SETBACK_M,
            "capacityPerLaneVph": {**CAPACITY_PER_LANE_VPH, "other": DEFAULT_CAPACITY_PER_LANE_VPH},
            "speedDefaultKph": SPEED_DEFAULT_KPH,
            "enginesPerStation": ENGINES_PER_STATION,
            "assumedSafeAreaCapacityPeople": {**ASSUMED_CAPACITY_PEOPLE, "other": ASSUMED_CAPACITY_DEFAULT_PEOPLE},
            "notes": NOTES + [
                "Exits are safe areas: officially designated evacuation points, registered shelters (FEMA "
                "ESF#6 Shelter System) and OpenStreetMap assembly points, inside the area (reached at the "
                "nearest road node) or beyond it (reached by the major road leaving toward them, straight-line "
                "beyond the area, not a routed trip). Listed facilities are not necessarily open for this "
                "incident; a capacity without a published figure is an assumption per kind.",
            ] + (
                ["No egress toward a known place: approximate exits where major roads cross the map edge are kept "
                 "as a last resort."]
                if any(x["kind"] == "map-edge" for x in exits) else []
            ),
        },
        "classes": class_list,
        "names": names,
        "nodes": nodes,
        "edges": edges,
        "tagSets": tag_sets,
        "turningNodes": turning_nodes,
        "boundaryNodes": boundary_nodes,
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
