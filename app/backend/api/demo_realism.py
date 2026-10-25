"""Inputs that make the /demo board physical (docs/command-demo-realism.md).

- ``GET /api/demo/wind``: an hourly wind series for the Camp drill area from
  ``sim.weather.scenario_wind`` (observed station hours, or real hours chosen statistically).
- ``GET /api/demo/environment``: the Camp USGS 3DEP slope grid (from the local incident
  package, ``sim.terrain``) and carless households per drill zone (the replay bundle's ACS
  demand table).
- ``POST /api/demo/crew_routes``: drive times for firefighting units over the drill roads
  their apparatus class may use (``tools.suppression_data.road_access``, the R01-R12 table),
  routed by ``livecore.inbound.inbound_route``.

Every endpoint takes an optional ``?incident=`` (default Camp; Camp or the active incident, else
404). The terrain package and carless households are Camp-only. Nothing is stored. Units: WGS84 [lon, lat]; metres; minutes; wind m/s, direction FROM in
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
from livecore.routing import CONGESTION_MAX_FACTOR, _index

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

_access_cache: dict[tuple[int, str], tuple[object, tuple[frozenset[str], dict[str, float]]]] = {}
_access_lock = threading.Lock()


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
            "evidence_label": hit.get("evidence_label", hit["evidence_class"]),
            "warnings": hit.get("warnings", []),
            "provenance": {
                k: v
                for k, v in (hit.get("provenance") or {}).items()
                if k in ("analog", "candidates", "terms", "station_selection", "grid")
            },
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


def _class_access(drill, access_class: str) -> tuple[frozenset[str], dict[str, float]]:
    """(blocked segment ids, edge id -> travel-time factor >= 1) for one apparatus class.

    Each drill edge is run through ``tools.suppression_data.road_access`` with the tags the drill
    keeps (``highway``, ``bridge``). ASSUMPTIONS: grade 0 (the drill graph has no per-edge grade),
    ``lanes`` not passed (the drill's lanes are per direction, OSM's are per way), no dead-end
    test (R10). The class speed is capped by the drill's free-flow speed; the factor is drill
    free-flow time over class time, clamped to the router's [1, CONGESTION_MAX_FACTOR].
    """
    key = (id(drill), access_class)
    with _access_lock:
        hit = _access_cache.get(key)
        if hit is not None and hit[0] is drill:  # an evicted package drill's id can be reused
            return hit[1]
    _repo_on_path()
    from tools.suppression_data import load_resources, road_access

    data = load_resources()
    blocked: set[str] = set()
    factors: dict[str, float] = {}
    for eid, edge in drill.roads.edges.items():
        tags = {"highway": edge.highway}
        if edge.highway.endswith("_link"):
            tags["highway"] = edge.highway[: -len("_link")]
        if edge.highway == "living_street":
            tags["highway"] = "residential"
        if getattr(edge, "bridge", False):
            tags["bridge"] = "yes"
        result = road_access(data, tags, 0.0, access_class)
        if not result["passable"]:
            blocked.add(edge.segment_id)
            continue
        speed = min(float(result["speed_kmh"]), edge.speed_kph)
        if speed > 0 and edge.speed_kph > 0:
            factor = edge.speed_kph / speed
            if factor > 1.0:
                factors[eid] = min(CONGESTION_MAX_FACTOR, factor)
    value = (frozenset(blocked), factors)
    with _access_lock:
        _access_cache[key] = (drill, value)
    return value


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


def crew_route(drill, fire, request: dict, offboard_kmh: float) -> dict:
    """One unit's drive: optional off-board leg to the network, then the class's road route."""
    blocked, factors = _class_access(drill, request["access_class"])
    origin, target = request["from"], request["to"]
    result = inbound_route(drill, tuple(origin), tuple(target), blocked, fire, factors)
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
            result = inbound_route(drill, entry, tuple(target), blocked, fire, factors)
    out = {"id": request["id"], "offboard_m": round(offboard_m)}
    if result.route is None or result.travel_time_s is None:
        return {**out, "drive_min": None, "distance_m": None, "basis": None, "reason": result.reason, "line": []}
    line = line_head + [list(p) for p in simplify_line(result.route.line, ROUTE_TOLERANCE_M, ROUTE_MAX_POINTS)]
    return {
        **out,
        "drive_min": round(offboard_min + result.travel_time_s / 60, 1),
        "distance_m": round(offboard_m * OFFBOARD_CIRCUITY + result.route.distance_m),
        "basis": "road_offboard" if offboard_m > 0 else "road",
        "reason": None,
        "line": line,
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
    return Response(
        {
            "routes": [crew_route(drill, fire, r, offboard_kmh) for r in requests],
            "congestion": "not_modelled",
            "evidence_class": "simulated",
        },
        headers={"Cache-Control": "no-store"},
    )
