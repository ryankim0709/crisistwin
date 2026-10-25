"""GET /api/suppression/bases?lon=&lat=&radius_km=: nearby California fire bases.

Serves tools/ca_fire_bases.json (CAL FIRE Facilities for Wildland Fire Protection, built by
`python -m tools.suppression_data --refresh-bases`). The file has no open licence, so it is
local-only: never committed. Without it the endpoint answers 200 with `available: false`.

Observed: base locations, types and agencies from the CAL FIRE layer (retrieved date in the
response). Not observed: apparatus or staffing per base (the layer has none). Distances are
great-circle kilometres from the query point, not driving distance.

Caps (assumed, to keep the payload small): every helitack base (HB) and air attack base (AAB)
in range, the nearest MAX_STATIONS stations (FS*) and the nearest MAX_CAMPS camps/crew centres
(CC, FCFFC). ECC/ICC command centres are skipped.
"""

import json
import logging
import math
import os
import threading
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

from .dispatch_area import _error, haversine_m

logger = logging.getLogger(__name__)

ENV_PATH = "SUPPRESSION_BASES_PATH"
DEFAULT_RADIUS_KM = 250.0
MAX_RADIUS_KM = 600.0
MAX_STATIONS = 40
MAX_CAMPS = 10
STATION_TYPES = {"FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"}
CAMP_TYPES = {"CC", "FCFFC"}
AIR_TYPES = {"HB", "AAB"}
MISSING_DETAIL = (
    "tools/ca_fire_bases.json is local-only (no open licence); "
    "build it with python -m tools.suppression_data --refresh-bases"
)

_cache: dict = {"path": None, "mtime": None, "data": None}
_cache_lock = threading.Lock()


def bases_path() -> Path:
    env = os.environ.get(ENV_PATH)
    if env:
        return Path(env)
    from .live.twin_service import REPO_ROOT  # /repo in Docker, where only app/backend is /app

    return REPO_ROOT / "tools" / "ca_fire_bases.json"


def load_bases() -> dict | None:
    """Parsed file, cached in process and reloaded when its mtime changes; None if unusable."""
    path = bases_path()
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    with _cache_lock:
        if _cache["path"] == str(path) and _cache["mtime"] == mtime:
            return _cache["data"]
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("fire bases file unreadable: %s", path)
            return None
        if not isinstance(data, dict) or not isinstance(data.get("bases"), list):
            return None
        _cache.update(path=str(path), mtime=mtime, data=data)
        return data


def select_bases(bases: list[dict], lon: float, lat: float, radius_km: float) -> list[dict]:
    rows = []
    for base in bases:
        kind = base.get("type")
        if kind not in STATION_TYPES | CAMP_TYPES | AIR_TYPES:
            continue
        try:
            blon, blat = float(base["lon"]), float(base["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        distance = haversine_m((lon, lat), (blon, blat)) / 1000
        if distance > radius_km:
            continue
        rows.append({
            "id": base.get("id"), "name": base.get("name"), "type": kind, "agency": base.get("agency"),
            "unit": base.get("unit"), "lon": blon, "lat": blat, "distanceKm": round(distance, 1),
        })
    rows.sort(key=lambda r: r["distanceKm"])
    out = [r for r in rows if r["type"] in AIR_TYPES]
    out += [r for r in rows if r["type"] in STATION_TYPES][:MAX_STATIONS]
    out += [r for r in rows if r["type"] in CAMP_TYPES][:MAX_CAMPS]
    out.sort(key=lambda r: r["distanceKm"])
    return out


class SuppressionBasesThrottle(AnonRateThrottle):
    scope = "suppression_bases"
    rate = "60/min"


def _number(raw: str | None, low: float, high: float) -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) and low <= value <= high else None


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([SuppressionBasesThrottle])
def suppression_bases(request):
    """Return fire bases near `?lon=&lat=` within `radius_km` (default 250, max 600)."""
    lon = _number(request.query_params.get("lon"), -180, 180)
    lat = _number(request.query_params.get("lat"), -90, 90)
    if lon is None or lat is None:
        return _error(400, "bad_point", "lon and lat are required, WGS84 degrees.")
    radius_raw = request.query_params.get("radius_km")
    radius = DEFAULT_RADIUS_KM if radius_raw is None else _number(radius_raw, 0, MAX_RADIUS_KM)
    if radius is None or radius <= 0:
        return _error(400, "bad_radius", f"radius_km must be a number in (0, {MAX_RADIUS_KM:g}].")
    data = load_bases()
    if data is None:
        return Response({"available": False, "bases": [], "detail": MISSING_DETAIL})
    source = (data.get("meta") or {}).get("source") or {}
    return Response(
        {
            "available": True,
            "attribution": source.get("attribution"),
            "licence": source.get("licence"),
            "retrieved": source.get("retrieved"),
            "bases": select_bases(data["bases"], lon, lat, radius),
        },
        headers={"Cache-Control": "public, max-age=3600"},
    )
