"""Inputs that make the /demo board physical (docs/command-demo-realism.md).

- ``GET /api/demo/wind``: an hourly wind series for the Camp drill area from
  ``sim.weather.scenario_wind`` (observed station hours, or real hours chosen statistically).
- ``GET /api/demo/environment``: the Camp USGS 3DEP slope grid (from the local incident
  package, ``sim.terrain``) and carless households per drill zone (the replay bundle's ACS
  demand table).
- ``POST /api/demo/crew_routes``: drive times for firefighting units over the drill roads
  their apparatus class may use (``tools.suppression_data.road_access``, the R01-R12 table, on
  OSM tags and DEM grade from ``api.drill_road_attrs``), routed by ``livecore.inbound.reach_route``:
  a unit no allowed road brings to its target stops short at the nearest reachable road point.
- ``GET /api/demo/road_access``: drill road km open and closed per class, and the closed roads.

Every endpoint takes an optional ``?incident=`` (default Camp; Camp or the active incident, else
404). The terrain package and carless households are Camp-only. Nothing is stored here (the OSM
tag cache lives in ``api.drill_road_attrs``). Units: WGS84 [lon, lat]; metres; minutes; wind m/s, direction FROM in
degrees true. Wire contract: app/src/demo/contracts.ts.
"""

from __future__ import annotations

import json
import logging
import math
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from livecore.drill import INCIDENT_ID as CAMP_INCIDENT_ID
from livecore.geo import haversine_m, simplify_line, to_multipolygon
from livecore.inbound import inbound_route
from livecore.routing import _index

from .demo import drill_center, resolve_incident
from .live import incidents
from .live.common import ApiError
from .live.drillcache import get_index

logger = logging.getLogger(__name__)

# ---- wind ----

WIND_MODES = ("historical_replay", "climatology_percentile")
DEFAULT_WIND_START = datetime(2018, 11, 8, 12, 0, tzinfo=timezone.utc)
"""2.5 h before the Camp Fire ignition (14:29Z, docs/scenario-weather.md)."""
MAX_WIND_HOURS = 168
DEFAULT_WIND_HOURS = 72
WIND_POINT = (-121.60, 39.76)
"""(lon, lat) the station search starts from: Paradise, the middle of the drill zones."""
WIND_START_MIN = datetime(2012, 1, 1, tzinfo=timezone.utc)
WIND_START_MAX = datetime(2025, 12, 31, tzinfo=timezone.utc)
"""Historical window the endpoint serves (the climatology analog years, sim/weather.py)."""

_wind_cache: dict[tuple, dict] = {}
_wind_lock = threading.Lock()

# ---- environment ----

TERRAIN_ENV = "DEMO_TERRAIN_PACKAGE"
DEFAULT_TERRAIN_PACKAGE = "data/incidents/camp-2018-evacuation/17e67cfe5669fe50"
"""The Camp incident package whose ``normalized/terrain_grid.json`` holds USGS 3DEP 1 arc-second
elevation (local: package artifacts are pulled from GridFS, not committed)."""
TERRAIN_CELL_M = 200.0
"""The replay's fire grid cell (fire_simulated.terrain in the Camp bundle): block mean of 3DEP."""

_env_cache: dict = {}
_env_lock = threading.Lock()

# ---- crew routes ----

MAX_CREW_ROUTES_BODY_BYTES = 300_000
MAX_CREW_REQUESTS = 40
ACCESS_CLASSES = ("engine_t1_t2", "engine_t3", "engine_t4_t7", "tender_support", "tender_tactical")
OFFBOARD_CIRCUITY = 1.3
"""ASSUMPTION, same as app/src/studio/crewDispatch.ts OFFBOARD_CIRCUITY: road over straight-line
distance for the leg from a base off the drill road network to its nearest drill road node."""
OFFBOARD_HIGHWAY = "secondary"
"""ASSUMPTION, as crewDispatch.ts OFFBOARD_SPEED_KMH: the off-board leg runs at the heavy-apparatus
cap for secondary roads (suppression_resources.json road_access.heavy_apparatus_speed_kmh_by_highway)."""
ROUTE_TOLERANCE_M = 25.0
ROUTE_MAX_POINTS = 120



class DemoInputsThrottle(AnonRateThrottle):
    rate = "60/min"


def _repo_on_path() -> None:
    """Put the repository root on sys.path for ``sim`` and ``tools`` (as live/twin_service.py)."""
    from .live.twin_service import REPO_ROOT

    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.append(root)


def _error(status: int, code: str, detail: str) -> Response:
    return Response({"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- wind


def _parse_start(raw: str | None) -> datetime | None:
    if raw is None:
        return DEFAULT_WIND_START
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        return None
    value = value.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return value if WIND_START_MIN <= value <= WIND_START_MAX else None


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([DemoInputsThrottle])
def demo_wind(request):
    """Hourly wind for the drill area: ``?mode=&start=&hours=`` (sim.weather.scenario_wind)."""
    _repo_on_path()
    from sim import weather  # local: the weather client is only needed here

    mode = request.query_params.get("mode", "historical_replay")
    if mode not in WIND_MODES:
        return _error(400, "invalid_request", f"mode must be one of {', '.join(WIND_MODES)}.")
    start = _parse_start(request.query_params.get("start"))
    if start is None:
        return _error(400, "invalid_request", "start must be an ISO time with a zone, 2012 to 2025.")
    try:
        hours = int(request.query_params.get("hours", DEFAULT_WIND_HOURS))
    except ValueError:
        return _error(400, "invalid_request", "hours must be an integer.")
    if not 1 <= hours <= MAX_WIND_HOURS:
        return _error(400, "invalid_request", f"hours must be 1 to {MAX_WIND_HOURS}.")
    incident = resolve_incident(request)
    if isinstance(incident, Response):
        return incident
    if incident == CAMP_INCIDENT_ID:
        point = WIND_POINT
    else:
        try:
            point = tuple(drill_center(get_index(incident).drill))
        except ApiError as exc:
            return _error(exc.status, exc.code, exc.detail)
    key = (mode, start, hours, point)
    with _wind_lock:
        hit = _wind_cache.get(key)
    if hit is None:
        try:
            hit = weather.scenario_wind(point[0], point[1], start, hours, mode)
        except Exception as exc:  # network, archive gaps, parse errors: all mean "no series"
            logger.warning("demo wind unavailable: %s", exc)
            return _error(503, "weather_unavailable", "No wind series could be loaded for the drill area.")
        with _wind_lock:
            _wind_cache[key] = hit
    station = hit.get("station") or None
    return Response(
        {
            "mode": hit["mode"],
            "evidence_class": hit["evidence_class"],
            "start_utc": hit["start_utc"],
            "hours": hit["hours"],
            "station": (
                {
                    "id": station["id"],
                    "name": station["name"],
                    "distance_km": station.get("distance_km"),
                    # iem_hads = RAWS (20-ft wind), iem_asos = airport (10 m wind); sim/weather.py.
                    "source": station.get("source"),
                }
                if station
                else None
            ),
            "samples": [
                {"t_utc": s["t_utc"], "speed_ms": s["speed_ms"], "from_deg": s["from_deg"]} for s in hit["samples"]
            ],
            "provenance": {k: v for k, v in (hit.get("provenance") or {}).items() if k in ("analog", "candidates", "terms")},
            "summary": hit.get("summary"),
        },
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ---------------------------------------------------------------- environment


def _terrain_package() -> Path:
    configured = os.environ.get(TERRAIN_ENV, "").strip()
    if configured:
        return Path(configured)
    from .live.twin_service import REPO_ROOT

    return REPO_ROOT / DEFAULT_TERRAIN_PACKAGE


def _load_terrain(bbox: list[float]) -> tuple[dict | None, str | None]:
    _repo_on_path()
    from sim.geo import Grid
    from sim.terrain import load_terrain

    package = _terrain_package()
    if not (package / "manifest.json").exists() or not (package / "normalized" / "terrain_grid.json").exists():
        return None, f"Camp terrain package not found at {package} (local-only; pull it with the incident package tools)."
    try:
        grid = Grid.covering(bbox, TERRAIN_CELL_M)
        terrain = load_terrain(package, grid)
    except (OSError, ValueError, KeyError) as exc:
        logger.warning("demo terrain unavailable: %s", exc)
        return None, "Camp terrain package unreadable."
    src = terrain.source
    return (
        {
            "origin_lon": grid.origin_lon,
            "origin_lat": grid.origin_lat,
            "cell_m": grid.cell_m,
            "ncols": grid.ncols,
            "nrows": grid.nrows,
            "m_per_deg_lon": grid._m_per_deg_lon,
            "m_per_deg_lat": grid._m_per_deg_lat,
            "slope_milli": [round(s * 1000) for s in terrain.slope_tan],
            "upslope_deg": [round(a) % 360 for a in terrain.upslope_deg],
            "source": (
                f"USGS 3DEP {src.get('source_resolution') or '1 arc-second'} ({src.get('source_id')}), "
                f"block mean onto {TERRAIN_CELL_M:g} m cells, Horn (1981) slope; "
                f"{terrain.missing_cells} cells without data treated as flat"
            ),
        },
        None,
    )


def _carless(bundle: dict) -> tuple[dict[str, int], str | None]:
    demand = bundle.get("demand") or {}
    out: dict[str, int] = {}
    for row in demand.get("zones") or []:
        geoid = row.get("geoid")
        n = row.get("households_no_vehicle_in_extract", row.get("households_no_vehicle"))
        if isinstance(geoid, str) and isinstance(n, (int, float)) and n >= 0:
            out[f"bg:{geoid}"] = int(n)
    if not out:
        return {}, None
    locator = next((r.get("source_locator") for r in demand.get("zones") or [] if r.get("source_locator")), None)
    return out, f"ACS households with no vehicle per block group (replay bundle demand table; {locator or 'ACS 5-year'})"


_PACKAGE_STATIONS_SOURCE = "Fire stations from OpenStreetMap in the drill package"


def _package_stations(incident: str) -> list[dict]:
    """``[{id, name, lon, lat}]`` from the drill package's ``stations`` layer (OSM fire stations).

    The loaded ``Drill`` does not keep that layer, so the stored package file is read; [] when it
    is missing or malformed."""
    source = incidents.source_for(incident)
    if source is None or source.kind != "package":
        return []
    try:
        features = json.loads(source.path.read_text(encoding="utf-8"))["stations"]["features"]
        return [
            {"id": str(f["id"]), "name": str(f.get("name") or "Fire station"),
             "lon": float(f["coord"][0]), "lat": float(f["coord"][1])}
            for f in features
        ]
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return []


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([DemoInputsThrottle])
def demo_environment(request):
    """Terrain grid and carless households per zone (Camp), plus the drill ``center``."""
    incident = resolve_incident(request)
    if isinstance(incident, Response):
        return incident
    if incident != CAMP_INCIDENT_ID:
        try:
            center = drill_center(get_index(incident).drill)
        except ApiError as exc:
            return _error(exc.status, exc.code, exc.detail)
        return Response(
            {
                "terrain": None,
                "terrain_detail": "Camp-only terrain package; the page uses the region's LANDFIRE landscape",
                "households_no_vehicle": {},
                "households_no_vehicle_source": "Carless households unknown for this synthetic drill (counted as 0)",
                "center": center,
                "stations": _package_stations(incident),
                "stations_source": _PACKAGE_STATIONS_SOURCE,
            },
            headers={"Cache-Control": "public, max-age=60"},
        )
    with _env_lock:
        if "value" not in _env_cache:
            try:
                bundle = json.loads(incidents.bundle_path().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return _error(503, "drill_unavailable", "The Camp replay bundle could not be read.")
            bbox = bundle.get("bbox") or [-121.9, 39.55, -121.4, 39.95]
            terrain, detail = _load_terrain(bbox)
            carless, carless_source = _carless(bundle)
            _env_cache["value"] = {
                "terrain": terrain,
                "terrain_detail": detail,
                "households_no_vehicle": carless,
                "households_no_vehicle_source": carless_source,
                "center": list(WIND_POINT),
                "stations": [],
                "stations_source": None,
            }
        value = _env_cache["value"]
    return Response(value, headers={"Cache-Control": "public, max-age=3600"})


# ---------------------------------------------------------------- crew routes


def _profile(incident: str, drill, access_class: str):
    """(class AccessProfile or None, RoadAttrs) with the drill's OSM tags and grade (api.drill_road_attrs)."""
    from livecore.apparatus import access_profile

    from .drill_road_attrs import get_road_attrs

    attrs = get_road_attrs(incident, drill)
    return access_profile(drill, access_class, attrs), attrs


def _offboard_kmh() -> float:
    _repo_on_path()
    from tools.suppression_data import load_resources

    return float(load_resources()["road_access"]["heavy_apparatus_speed_kmh_by_highway"]["value"][OFFBOARD_HIGHWAY])


def _nearest_main_node(drill, point) -> tuple[str | None, float]:
    """Nearest node of the main road component that has an out-edge, by brute force."""
    index = _index(drill)
    roads = drill.roads
    best, best_m = None, math.inf
    for node in index.main_nodes:
        if not roads.out_edges.get(node):
            continue
        d = haversine_m(point, roads.node_coords[node])
        if d < best_m:
            best, best_m = node, d
    return best, best_m


def _point(value) -> list[float] | None:
    if (
        isinstance(value, list)
        and len(value) == 2
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)
        and -180 <= value[0] <= 180
        and -90 <= value[1] <= 90
    ):
        return [float(value[0]), float(value[1])]
    return None


def _blocked_fields(drill, access, edge_id: str | None) -> dict:
    if access is None or edge_id is None:
        return {"blocked_rule": None, "blocked_reason": None}
    from livecore.apparatus import plain_reason

    acc = access.edges.get(edge_id)
    if acc is None or acc.passable:
        return {"blocked_rule": None, "blocked_reason": None}
    edge = drill.roads.edges[edge_id]
    return {"blocked_rule": acc.rule, "blocked_reason": plain_reason(access.vehicle, acc, edge.name)}


def crew_route(drill, fire, request: dict, offboard_kmh: float, access=None) -> dict:
    """One unit's drive: optional off-board leg to the network, then the class's road route.

    With ``access`` (the class's ``AccessProfile``) the leg may stop short of the target at the
    nearest road node the class can reach (``livecore.inbound.reach_route``); without it every
    road is open at its own speed (suppression data missing; labelled by the caller)."""
    from livecore.inbound import reach_route

    origin, target = request["from"], request["to"]

    def drive(start):
        if access is None:
            res = inbound_route(drill, start, tuple(target), frozenset(), fire)
            return res, ("reached" if res.route is not None else None), None, res.target_snap_m if res.route else None, None, None
        r = reach_route(drill, start, tuple(target), frozenset(), fire, access)
        return r.result, r.status, r.stop_node, r.off_road_m, r.blocked_edge, r.unrestricted_s

    result, status, stop_node, off_road_m, blocked_edge, free_s = drive(tuple(origin))
    offboard_m = 0.0
    offboard_min = 0.0
    line_head: list[list[float]] = []
    if result.reason == "origin_off_network":
        node, metres = _nearest_main_node(drill, tuple(origin))
        if node is not None:
            entry = drill.roads.node_coords[node]
            offboard_m = metres
            offboard_min = metres * OFFBOARD_CIRCUITY / (offboard_kmh * 1000 / 60)
            line_head = [list(origin)]
            result, status, stop_node, off_road_m, blocked_edge, free_s = drive(entry)
    out = {"id": request["id"], "offboard_m": round(offboard_m), **_blocked_fields(drill, access, blocked_edge)}
    if result.route is None or result.travel_time_s is None:
        return {**out, "drive_min": None, "distance_m": None, "basis": None, "reason": result.reason, "line": [],
                "access_status": None, "stop_point": None, "off_road_m_to_target": None, "unrestricted_drive_min": None}
    line = line_head + [list(p) for p in simplify_line(result.route.line, ROUTE_TOLERANCE_M, ROUTE_MAX_POINTS)]
    stop = drill.roads.node_coords[stop_node] if stop_node else None
    return {
        **out,
        "drive_min": round(offboard_min + result.travel_time_s / 60, 1),
        "distance_m": round(offboard_m * OFFBOARD_CIRCUITY + result.route.distance_m),
        "basis": "road_offboard" if offboard_m > 0 else "road",
        "reason": None,
        "line": line,
        "access_status": status,
        "stop_point": [round(stop[0], 6), round(stop[1], 6)] if stop else None,
        "off_road_m_to_target": round(off_road_m) if off_road_m is not None else None,
        "unrestricted_drive_min": round(offboard_min + free_s / 60, 1) if free_s is not None and status == "detour" else None,
    }


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([DemoInputsThrottle])
def demo_crew_routes(request):
    """Road drive times for firefighting units. Local demo endpoint; nothing is stored."""
    from .demo import parse_fire_rings

    if len(request.body) > MAX_CREW_ROUTES_BODY_BYTES:
        return _error(413, "too_large", f"Request body exceeds {MAX_CREW_ROUTES_BODY_BYTES} bytes.")
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return _error(400, "invalid_request", "Body must be valid JSON.")
    if not isinstance(data, dict) or set(data) != {"fires", "requests"}:
        return _error(400, "invalid_request", "Body must be a JSON object with exactly `fires` and `requests`.")
    rings = parse_fire_rings({"fires": data["fires"]})
    if isinstance(rings, str):
        return _error(400, "invalid_request", rings)
    raw = data["requests"]
    if not isinstance(raw, list) or len(raw) > MAX_CREW_REQUESTS:
        return _error(400, "invalid_request", f"`requests` must be a list of at most {MAX_CREW_REQUESTS}.")
    requests = []
    for r in raw:
        if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not 0 < len(r["id"]) <= 120:
            return _error(400, "invalid_request", "Each request needs a string `id` (1-120 chars).")
        if r.get("access_class") not in ACCESS_CLASSES:
            return _error(400, "invalid_request", f"access_class must be one of {', '.join(ACCESS_CLASSES)}.")
        origin, target = _point(r.get("from")), _point(r.get("to"))
        if origin is None or target is None:
            return _error(400, "invalid_request", "`from` and `to` must be [lon, lat].")
        requests.append({"id": r["id"], "access_class": r["access_class"], "from": origin, "to": target})
    incident = resolve_incident(request)
    if isinstance(incident, Response):
        return incident
    try:
        drill = get_index(incident).drill
    except ApiError as exc:
        return _error(exc.status, exc.code, exc.detail)
    fire = to_multipolygon({"type": "MultiPolygon", "coordinates": [[r] for r in rings]}) if rings else None
    offboard_kmh = _offboard_kmh()
    profiles: dict[str, object] = {}
    attrs = None
    for cls in sorted({r["access_class"] for r in requests}):
        profiles[cls], attrs = _profile(incident, drill, cls)
    basis = (attrs.basis if attrs is not None and any(profiles.values())
             else "road access rules unavailable (tools/suppression_resources.json missing): every road open at its own speed")
    return Response(
        {
            "routes": [crew_route(drill, fire, r, offboard_kmh, profiles.get(r["access_class"])) for r in requests],
            "congestion": "not_modelled",
            "evidence_class": "simulated",
            "road_access": {"status": attrs.status if attrs is not None else "none", "basis": basis},
        },
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------- road access map

ROAD_ACCESS_TOLERANCE_M = 15.0
ROAD_ACCESS_MAX_POINTS = 60
_road_access_cache: dict[str, tuple[object, object, dict]] = {}


def road_access_summary(incident: str, drill) -> dict:
    """Per class: drill road km open and closed, the top closing rules, and the closed segments as
    GeoJSON (``closed`` maps class -> rule). Cached per drill and RoadAttrs."""
    from livecore.apparatus import ACCESS_CLASSES as CLASSES
    from livecore.apparatus import class_label, plain_reason

    from .drill_road_attrs import get_road_attrs

    attrs = get_road_attrs(incident, drill)
    hit = _road_access_cache.get(incident)
    if hit is not None and hit[0] is drill and hit[1] is attrs:
        return hit[2]
    roads = drill.roads
    seg_edge = {seg: ids[0] for seg, ids in roads.segment_edges.items()}
    closed: dict[str, dict[str, str]] = {}
    reasons: dict[str, str] = {}
    classes = []
    basis = attrs.basis
    for cls in CLASSES:
        profile, _ = _profile(incident, drill, cls)
        if profile is None:
            basis = "road access rules unavailable (tools/suppression_resources.json missing)"
            break
        open_m = closed_m = 0.0
        by_rule: dict[str, list] = {}
        for seg, eid in seg_edge.items():
            edge = roads.edges[eid]
            acc = profile.edges.get(eid)
            if acc is None or acc.passable:
                open_m += edge.length_m
                continue
            closed_m += edge.length_m
            closed.setdefault(seg, {})[cls] = acc.rule
            reasons.setdefault(seg, plain_reason(cls, acc, edge.name))
            row = by_rule.setdefault(acc.rule, [0.0, plain_reason(cls, acc)])
            row[0] += edge.length_m
        top = sorted(by_rule.items(), key=lambda kv: -kv[1][0])[:4]
        classes.append({
            "access_class": cls,
            "label": class_label(cls),
            "open_km": round(open_m / 1000, 1),
            "closed_km": round(closed_m / 1000, 1),
            "top_rules": [{"rule": r, "km": round(v[0] / 1000, 1), "example": v[1]} for r, v in top],
        })
    features = []
    for seg in sorted(closed):
        edge = roads.edges[seg_edge[seg]]
        line = simplify_line(edge.coords, ROAD_ACCESS_TOLERANCE_M, ROAD_ACCESS_MAX_POINTS)
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[round(x, 5), round(y, 5)] for x, y in line]},
            "properties": {
                "segment_id": seg,
                "name": edge.name,
                "closed": closed[seg],
                "reason": reasons[seg],
                "grade_pct": attrs.grade_pct.get(seg),
            },
        })
    value = {
        "status": attrs.status,
        "basis": basis,
        "classes": classes,
        "closed_roads": {"type": "FeatureCollection", "features": features},
        "evidence_class": "derived",
    }
    _road_access_cache[incident] = (drill, attrs, value)
    return value


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([DemoInputsThrottle])
def demo_road_access(request):
    """Drill roads closed to each apparatus class (R01-R12 with OSM tags and DEM grade)."""
    incident = resolve_incident(request)
    if isinstance(incident, Response):
        return incident
    try:
        drill = get_index(incident).drill
    except ApiError as exc:
        return _error(exc.status, exc.code, exc.detail)
    value = road_access_summary(incident, drill)
    cache = "public, max-age=3600" if value["status"] == "ready" else "no-store"
    return Response(value, headers={"Cache-Control": cache})
