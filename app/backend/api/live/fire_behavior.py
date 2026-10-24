"""``GET incidents/{id}/fire-behavior``: the inputs the console needs to compute fire behaviour at
the head of the fire, at the drill clock (docs/live-fire-behavior.md).

The fire itself stays the observed perimeter timeline (or the bundle's model fronts); this
endpoint only says what the weather and ground were where the fire was heading:

- ``wind``: the observed hourly wind at the drill clock, ``sim.weather.scenario_wind`` in
  ``historical_replay`` mode over the drill's clock window (the drill clock is real November 2018
  time, so there is no looping), scaled to the open 20 ft wind (``scenario_weather.add_20ft_wind``).
- ``head``: the perimeter vertex of the current fire estimate farthest downwind, and the
  USGS 3DEP slope there (``sim.terrain`` on 200 m cells, from the local Camp incident package).
- ``zones_fire_touches`` and ``households_no_vehicle``: zones the fire estimate overlaps and the
  ACS carless households per zone (the replay bundle's demand table).

The console computes the spread rate and flame length from these (app/src/live/fireBehavior.ts);
no number here comes from an LLM. Camp replay drill only: a Studio package's fire is the model run
it was published with, so the endpoint answers ``available: false`` for it.

Units: WGS84 [lon, lat]; wind m/s, direction FROM in degrees true; slope as rise/run.
"""

from __future__ import annotations

import json
import logging
import math
import os
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from livecore.drill import INCIDENT_ID as CAMP_INCIDENT_ID
from livecore.drill import parse_time
from livecore.geo import MultiPolygon
from livecore.planner import zone_fire_distances

from . import incidents
from .auth import Principal, live_view
from .common import iso, ok, wall_now
from .state import load_snapshot
from .twin_service import CAMP_ROADS_PACKAGE, REPO_ROOT

logger = logging.getLogger(__name__)

WIND_POINT = (-121.60, 39.76)
"""(lon, lat) the station search starts from: Paradise, the middle of the Camp drill zones. The
nearest station covering the window is Jarbo Gap RAWS (JBGC1, about 10 km; docs/scenario-weather.md)."""
WIND_FAILURE_RETRY_S = 600
"""After a failed wind load, wait this long before trying the archive again."""

TERRAIN_ENV = "LIVE_TERRAIN_PACKAGE"
"""Overrides the Camp incident package whose ``normalized/terrain_grid.json`` holds USGS 3DEP 1 arc-second
elevation (default: the twin's Camp roads package; local only, package artifacts come from GridFS)."""
TERRAIN_CELL_M = 200.0
"""The replay's fire grid cell (``fire_simulated.terrain`` in the Camp bundle): block mean of 3DEP."""

_lock = threading.Lock()
_wind_lock = threading.Lock()
"""Held while the wind archive loads (possibly over the network), so it never blocks the other caches."""
_wind: dict[str, Any] = {}
_terrain: dict[str, Any] = {}
_demand: dict[str, Any] = {}


def _repo_on_path() -> None:
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.append(root)


# ---------------------------------------------------------------- wind


def _wind_series(start: datetime, end: datetime) -> tuple[dict | None, str | None]:
    """Observed hourly wind over the drill clock, cached per process; (series, why not)."""
    from ..scenario_weather import add_20ft_wind

    with _wind_lock:
        hit = _wind.get("value")
        if hit is not None:
            return hit, None
        failed_at = _wind.get("failed_at")
        if failed_at is not None and time.monotonic() - failed_at < WIND_FAILURE_RETRY_S:
            return None, _wind.get("detail")
        _repo_on_path()
        from sim import weather  # local: only this endpoint needs the weather client

        t0 = start.replace(minute=0, second=0, microsecond=0)
        hours = max(1, math.ceil((end - t0).total_seconds() / 3600) + 1)
        try:
            series = add_20ft_wind(weather.scenario_wind(WIND_POINT[0], WIND_POINT[1], t0, hours, "historical_replay"))
        except Exception as exc:  # archive cold and offline, gaps, parse errors: all mean "no wind"
            logger.warning("live fire behaviour: wind unavailable: %s", exc)
            _wind.update(failed_at=time.monotonic(), detail="No observed wind could be loaded for the drill window.")
            return None, _wind["detail"]
        _wind["value"] = series
        return series, None


def wind_at(series: dict, at: datetime) -> dict | None:
    """The hourly sample nearest ``at`` (sim.weather bins reports to the nearest hour).

    ASSUMPTION: an hour with no report holds the last reported hour before it (sim/weather.py leaves
    gaps as null and never interpolates); ``held_from`` then names that hour. Calm hours have no
    direction and are returned with ``from_deg`` null."""
    samples = series.get("samples") or []
    if not samples:
        return None
    try:
        t0 = parse_time(samples[0]["t_utc"])
    except (KeyError, ValueError):
        return None
    index = round((at - t0).total_seconds() / 3600)
    index = min(max(index, 0), len(samples) - 1)
    for back in range(index + 1):
        s = samples[index - back]
        if s.get("speed_20ft_ms") is None:
            continue
        return {
            "t_utc": samples[index]["t_utc"],
            "held_from": s["t_utc"] if back else None,
            "speed_ms": s.get("speed_ms"),
            "speed_20ft_ms": s["speed_20ft_ms"],
            "from_deg": s.get("from_deg"),
            "gust_ms": s.get("gust_ms"),
            "rh_pct": s.get("rh_pct"),
        }
    return None


def _wind_json(series: dict, at: datetime) -> dict | None:
    now = wind_at(series, at)
    if now is None:
        return None
    station = series.get("station") or {}
    conversion = series.get("height_conversion") or {}
    return {
        **now,
        "evidence_class": series.get("evidence_class"),
        "station": {
            "id": station.get("id"),
            "name": station.get("name"),
            "distance_km": station.get("distance_km"),
            "source": station.get("source"),  # iem_hads = RAWS (20 ft), iem_asos = airport (10 m)
        } if station else None,
        "height": {"from": conversion.get("from_height"), "factor": conversion.get("factor")},
    }


# ---------------------------------------------------------------- terrain


def _terrain_package() -> Path:
    configured = os.environ.get(TERRAIN_ENV, "").strip()
    return Path(configured) if configured else REPO_ROOT / CAMP_ROADS_PACKAGE


def _load_terrain(bbox: list[float]) -> tuple[Any, str | None]:
    """(sim.terrain.Terrain on 200 m cells covering ``bbox``, None) or (None, why not)."""
    _repo_on_path()
    from sim.geo import Grid
    from sim.terrain import load_terrain

    package = _terrain_package()
    if not (package / "manifest.json").exists() or not (package / "normalized" / "terrain_grid.json").exists():
        return None, "Camp terrain package not found (local only); slope assumed flat."
    try:
        return load_terrain(package, Grid.covering(bbox, TERRAIN_CELL_M)), None
    except (OSError, ValueError, KeyError) as exc:
        logger.warning("live fire behaviour: terrain unavailable: %s", exc)
        return None, "Camp terrain package unreadable; slope assumed flat."


def _terrain_for(bundle: dict) -> tuple[Any, str | None]:
    with _lock:
        if "value" not in _terrain:
            _terrain["value"] = _load_terrain(bundle.get("bbox") or [-121.9, 39.55, -121.4, 39.95])
        return _terrain["value"]


def _terrain_label(terrain) -> str:
    src = terrain.source
    return (
        f"USGS 3DEP {src.get('source_resolution') or '1 arc-second'} ({src.get('source_id')}), block mean onto "
        f"{TERRAIN_CELL_M:g} m cells, Horn (1981) slope"
    )


# ---------------------------------------------------------------- bundle demand


def _bundle() -> dict:
    with _lock:
        if "bundle" not in _demand:
            _demand["bundle"] = json.loads(incidents.bundle_path().read_text(encoding="utf-8"))
        return _demand["bundle"]


def carless(bundle: dict) -> tuple[dict[str, dict[str, int]], str | None]:
    """Zone id -> {households, moe} of ACS households with no vehicle, from the bundle's demand table."""
    zones = (bundle.get("demand") or {}).get("zones") or []
    out: dict[str, dict[str, int]] = {}
    for row in zones:
        zone_id = row.get("zone_id") or (f"bg:{row['geoid']}" if isinstance(row.get("geoid"), str) else None)
        n = row.get("households_no_vehicle_in_extract", row.get("households_no_vehicle"))
        if isinstance(zone_id, str) and isinstance(n, (int, float)) and n >= 0:
            moe = row.get("moe_households_no_vehicle")
            out[zone_id] = {"households": int(n), "moe": int(moe) if isinstance(moe, (int, float)) else None}
    if not out:
        return {}, None
    locator = next((r.get("source_locator") for r in zones if r.get("source_locator")), None)
    return out, f"ACS households with no vehicle available, per block group ({locator or 'ACS 5-year'})"


# ---------------------------------------------------------------- head of the fire


def head_point(geometry: MultiPolygon, from_deg: float) -> tuple[float, float] | None:
    """The outer-ring vertex farthest along the direction the wind blows toward.

    A stand-in for the head of a wind-driven fire: the observed perimeter carries no spread
    direction, so the downwind extreme of the current estimate is where the head runs."""
    toward = math.radians((from_deg + 180.0) % 360.0)
    ux, uy = math.sin(toward), math.cos(toward)
    rings = [polygon[0] for polygon in geometry if polygon and polygon[0]]
    if not rings:
        return None
    kx = math.cos(math.radians(rings[0][0][1]))  # local equirectangular metres per degree, up to a constant
    best, best_d = None, -math.inf
    for ring in rings:
        for lon, lat in ring:
            d = lon * kx * ux + lat * uy
            if d > best_d:
                best, best_d = (lon, lat), d
    return best


def _head_json(terrain, point: tuple[float, float]) -> dict[str, Any]:
    body: dict[str, Any] = {"coord": [round(point[0], 6), round(point[1], 6)], "slope_tan": 0.0, "upslope_deg": 0.0,
                            "terrain": "flat"}
    if terrain is None:
        return body
    cell = terrain.grid.cell_of(point[0], point[1])
    if cell is None or terrain.elevation_m[cell] is None:
        return {**body, "terrain": "outside"}
    return {**body, "slope_tan": round(terrain.slope_tan[cell], 4), "upslope_deg": round(terrain.upslope_deg[cell]) % 360,
            "terrain": "observed"}


# ---------------------------------------------------------------- view


@live_view(["GET"], roles=["controller"])
def fire_behavior(request, incident_id: str, principal: Principal):
    snapshot = load_snapshot(incident_id, wall_now())
    drill, fire, at = snapshot.index.drill, snapshot.fire, snapshot.clock.replay_now
    base: dict[str, Any] = {
        "incident_id": incident_id,
        "as_of": iso(at),
        "fire": {"as_of": iso(fire.as_of), "method": fire.method, "evidence_class": fire.evidence_class},
    }
    if incident_id != CAMP_INCIDENT_ID:
        return ok({**base, "available": False,
                   "detail": "Computed for the Camp replay drill; this drill's fire is the model run it was published with."})
    bundle = _bundle()
    series, wind_detail = _wind_series(drill.clock_start, drill.clock_end)
    wind = _wind_json(series, at) if series is not None else None
    if series is not None and wind is None:
        wind_detail = "No wind reported up to this drill hour."
    terrain, terrain_detail = _terrain_for(bundle)
    head = None
    if fire.geometry and wind is not None and wind.get("from_deg") is not None:
        point = head_point(fire.geometry, wind["from_deg"])
        head = _head_json(terrain, point) if point is not None else None
    distances = zone_fire_distances(drill, fire) if fire.geometry else {}
    no_vehicle, no_vehicle_source = carless(bundle)
    return ok({
        **base,
        "available": True,
        "wind": wind,
        "wind_detail": wind_detail,
        "head": head,
        "terrain": {"source": _terrain_label(terrain), "evidence_class": "observed"} if terrain is not None else None,
        "terrain_detail": terrain_detail,
        "zones_fire_touches": sorted(z for z, d in distances.items() if d == 0.0),
        "households_no_vehicle": no_vehicle,
        "households_no_vehicle_source": no_vehicle_source,
    })
