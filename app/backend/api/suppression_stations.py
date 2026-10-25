"""GET /api/suppression/stations?lon=&lat=&radius_km=: CAL FIRE bases merged with OSM fire stations.

The CAL FIRE facilities layer covers state-responsibility land, so city and county departments
(Oakland, Berkeley, Alameda County, ...) are missing from it. OpenStreetMap maps them
(amenity=fire_station, nodes and ways reduced to a centroid) and is merged in here.

Observed: OSM name, operator, ref and location; CAL FIRE rows as in suppression_bases.py.
Assumed: an OSM station within SAME_STATION_M (500 m) of an earlier row is the same station
(the rule of withOsmStations in src/response/fleet.ts); CAL FIRE rows win. OSM results are cached
in MongoDB `osm_fire_stations`, keyed by a 0.1 degree cell and radius; a failed Overpass call
degrades to CAL FIRE rows only. Distances are great-circle kilometres.
"""

import logging
from datetime import UTC, datetime

from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from .dispatch_area import OVERPASS_QUERY_TIMEOUT_S, UpstreamUnavailable, _error, haversine_m, overpass
from .mongodb import get_database
from .suppression_bases import MAX_RADIUS_KM, _number, load_bases, select_bases

logger = logging.getLogger(__name__)

DEFAULT_RADIUS_KM = 60.0
MAX_OSM_RADIUS_KM = 80.0
SAME_STATION_M = 500
COLLECTION = "osm_fire_stations"
CACHE_VERSION = "v1"


def _agency_short(agency: str | None) -> str:
    a = (agency or "").strip()
    if not a:
        return ""
    low = a.lower()
    if "cal fire" in low or "calfire" in low or "forestry" in low or low == "cdf":
        return "CAL FIRE"
    return a


def _label(name: str, agency: str | None, air: bool = False, kind: str = "") -> str:
    if air:
        name = f"{name} ({'helitack' if kind == 'HB' else 'air attack'} base)"
    short = _agency_short(agency)
    return f"{name} · {short}" if short and short not in name else name


def fetch_osm_stations(lon: float, lat: float, radius_km: float) -> list[dict]:
    around = f"(around:{round(radius_km * 1000)},{lat:.6f},{lon:.6f})"
    data = overpass(f"[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_S}];nwr[amenity=fire_station]{around};out center tags;")
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        c = el.get("center", {})
        e_lat, e_lon = el.get("lat", c.get("lat")), el.get("lon", c.get("lon"))
        if e_lat is None or e_lon is None:
            continue
        operator = tags.get("operator") or tags.get("operator:short") or ""
        name = tags.get("name") or (f"Fire Station {tags['ref']}" if tags.get("ref") else "Fire station")
        out.append({
            "id": f"osm/{el['type']}/{el['id']}", "name": name, "operator": operator, "ref": tags.get("ref", ""),
            "lon": round(e_lon, 6), "lat": round(e_lat, 6),
        })
    return out


def load_osm_stations(lon: float, lat: float, radius_km: float) -> list[dict]:
    key = f"{CACHE_VERSION}:{lon:.1f},{lat:.1f},{round(radius_km)}"
    try:
        doc = get_database()[COLLECTION].find_one({"_id": key})
        if doc:
            return doc["stations"]
    except Exception:
        logger.warning("fire station cache read failed")
    try:
        # Query the cell centre (padded) so every request sharing a key gets the same answer.
        stations = fetch_osm_stations(round(lon, 1), round(lat, 1), radius_km + 8)
    except UpstreamUnavailable:
        return []
    if not stations:
        return []
    try:
        get_database()[COLLECTION].replace_one(
            {"_id": key}, {"_id": key, "fetchedAt": datetime.now(UTC), "stations": stations}, upsert=True
        )
    except Exception:
        logger.warning("fire station cache write failed")
    return stations


def merge_stations(bases: list[dict], osm: list[dict], lon: float, lat: float, radius_km: float) -> list[dict]:
    rows = []
    for b in bases:
        air = b["type"] in ("HB", "AAB")
        rows.append({
            "id": str(b["id"]), "name": b["name"], "label": _label(b["name"], b.get("agency"), air, b["type"]),
            "lon": b["lon"], "lat": b["lat"], "air": air, "source": "calfire", "agency": b.get("agency") or "",
            "distanceKm": b["distanceKm"],
        })
    for s in osm:
        dist = haversine_m((lon, lat), (s["lon"], s["lat"])) / 1000
        if dist > radius_km:
            continue
        if any(haversine_m((r["lon"], r["lat"]), (s["lon"], s["lat"])) < SAME_STATION_M for r in rows):
            continue
        rows.append({
            "id": s["id"], "name": s["name"], "label": _label(s["name"], s["operator"]),
            "lon": s["lon"], "lat": s["lat"], "air": False, "source": "osm", "agency": s["operator"],
            "distanceKm": round(dist, 1),
        })
    rows.sort(key=lambda r: r["distanceKm"])
    return rows


class SuppressionStationsThrottle(AnonRateThrottle):
    scope = "suppression_stations"
    rate = "60/min"


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SuppressionStationsThrottle])
def suppression_stations(request):
    """Return stations near `?lon=&lat=` within `radius_km` (default 60; OSM capped at 80)."""
    lon = _number(request.query_params.get("lon"), -180, 180)
    lat = _number(request.query_params.get("lat"), -90, 90)
    if lon is None or lat is None:
        return _error(400, "bad_point", "lon and lat are required, WGS84 degrees.")
    raw = request.query_params.get("radius_km")
    radius = DEFAULT_RADIUS_KM if raw is None else _number(raw, 0, MAX_RADIUS_KM)
    if radius is None or radius <= 0:
        return _error(400, "bad_radius", f"radius_km must be a number in (0, {MAX_RADIUS_KM:g}].")
    data = load_bases()
    bases = select_bases(data["bases"], lon, lat, radius) if data else []
    bases = [b for b in bases if b["type"] in ("HB", "AAB", "FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO")]
    osm = load_osm_stations(lon, lat, min(radius, MAX_OSM_RADIUS_KM))
    stations = merge_stations(bases, osm, lon, lat, radius)
    return Response(
        {"available": bool(stations), "stations": stations,
         "attribution": "CAL FIRE facilities layer; (c) OpenStreetMap contributors (ODbL)"},
        headers={"Cache-Control": "public, max-age=3600"},
    )
