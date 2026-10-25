"""Fires published by Simulation Studio for the Live command page (all simulated).

``POST /api/live/studio-fires`` (controller): Studio publishes the scenario it just ran. The
fire is stamped with the active incident and stored in ``live_studio_fires`` (newest 20 per
incident). ``GET /api/live/incidents/<id>/studio-fires[?after=ISO]`` (any live viewer) lists the
newest 10. Contract: docs/live-reports.md "Studio fires".
"""

from __future__ import annotations

import math
import secrets
from typing import Any

from pymongo import DESCENDING
from pymongo.errors import PyMongoError

from . import incidents
from .auth import Principal, live_view
from .common import ApiError, col, iso, json_body, ok, parse_iso, wall_now
from .drillcache import get_index

COLLECTION = "live_studio_fires"
KEEP_PER_INCIDENT = 20
LIST_LIMIT = 10
MAX_IGNITIONS = 5
OUTSIDE_DRILL_KM = 3.0
CODE = "invalid_studio_fire"
MOISTURE_KEYS = ("dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody")
_index_ready = False


def _num(value: Any, field: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ApiError(400, CODE, f"`{field}` must be a finite number.")
    if not lo <= value <= hi:
        raise ApiError(400, CODE, f"`{field}` must be between {lo:g} and {hi:g}.")
    return float(value)


def _int(value: Any, field: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        if isinstance(value, float) and math.isfinite(value) and value == int(value):
            value = int(value)
        else:
            raise ApiError(400, CODE, f"`{field}` must be an integer.")
    if not lo <= value <= hi:
        raise ApiError(400, CODE, f"`{field}` must be between {lo} and {hi}.")
    return value


def _text(value: Any, field: str, max_len: int, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > max_len:
        raise ApiError(400, CODE, f"`{field}` must be a string of at most {max_len} characters.")
    return value.strip()


def _obj(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ApiError(400, CODE, f"`{field}` must be an object.")
    return value


def validate(body: dict[str, Any]) -> dict[str, Any]:
    horizon = _int(body.get("horizon_minutes"), "horizon_minutes", 1, 1440)
    raw = body.get("ignitions")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_IGNITIONS:
        raise ApiError(400, CODE, f"`ignitions` must be a list of 1 to {MAX_IGNITIONS} items.")
    ignitions, seen = [], set()
    for i, item in enumerate(raw):
        item = _obj(item, f"ignitions[{i}]")
        ign_id = _text(item.get("id"), f"ignitions[{i}].id", 40)
        if ign_id in seen:
            raise ApiError(400, CODE, f"Duplicate ignition id `{ign_id}`.")
        seen.add(ign_id)
        ignitions.append(
            {
                "id": ign_id,
                "name": _text(item.get("name", ign_id), f"ignitions[{i}].name", 80),
                "lon": _num(item.get("lon"), f"ignitions[{i}].lon", -180, 180),
                "lat": _num(item.get("lat"), f"ignitions[{i}].lat", -90, 90),
                "start_minute": _int(item.get("start_minute"), f"ignitions[{i}].start_minute", 0, horizon),
            }
        )
    wind_in = _obj(body.get("wind"), "wind")
    wind = {
        "speed_mph": _num(wind_in.get("speed_mph"), "wind.speed_mph", 0, 60),
        "from_deg": _num(wind_in.get("from_deg"), "wind.from_deg", 0, 360),
        "source": _text(wind_in.get("source"), "wind.source", 40),
        "label": _text(wind_in.get("label"), "wind.label", 120, required=False),
    }
    moist_in = _obj(body.get("moisture"), "moisture")
    values_in = _obj(moist_in.get("values"), "moisture.values")
    values = {k: _num(values_in.get(k), f"moisture.values.{k}", 0.01, 3) for k in MOISTURE_KEYS}
    return {
        "scenario_id": _text(body.get("scenario_id"), "scenario_id", 80),
        "name": _text(body.get("name"), "name", 80),
        "region_id": _text(body.get("region_id"), "region_id", 80),
        "ignitions": ignitions,
        "wind": wind,
        "moisture": {
            "preset": _text(moist_in.get("preset"), "moisture.preset", 40),
            "label": _text(moist_in.get("label"), "moisture.label", 120, required=False),
            "values": values,
        },
        "horizon_minutes": horizon,
    }


def outside_drill(incident_id: str, ignitions: list[dict[str, Any]]) -> list[str]:
    """Ids of ignitions more than 3 km outside the bounding box of the drill's zones."""
    zones = get_index(incident_id).drill.zones
    pts = [pt for z in zones for polygon in z.geometry for ring in polygon for pt in ring]
    if not pts:
        return [i["id"] for i in ignitions]
    west, east = min(p[0] for p in pts), max(p[0] for p in pts)
    south, north = min(p[1] for p in pts), max(p[1] for p in pts)
    far = []
    for ign in ignitions:
        dx = max(west - ign["lon"], 0.0, ign["lon"] - east) * 111_320 * math.cos(math.radians(ign["lat"]))
        dy = max(south - ign["lat"], 0.0, ign["lat"] - north) * 110_574
        if math.hypot(dx, dy) > OUTSIDE_DRILL_KM * 1000:
            far.append(ign["id"])
    return far


def _collection():
    global _index_ready
    fires = col(COLLECTION)
    if not _index_ready:
        fires.create_index([("incident_id", 1), ("published_at", DESCENDING)])
        _index_ready = True
    return fires


@live_view(["POST"], roles={"controller"})
def publish(request, principal: Principal):
    fields = validate(json_body(request, CODE))
    incident_id = incidents.active_incident_id()
    published_at = wall_now()
    doc = {
        "fire_id": "sf_" + secrets.token_hex(6),
        "incident_id": incident_id,
        "published_at": published_at,
        **fields,
        "outside_drill": outside_drill(incident_id, fields["ignitions"]),
        "evidence_class": "simulated",
    }
    fires = _collection()
    fires.insert_one(doc)
    stale = fires.find({"incident_id": incident_id}, {"_id": 1}).sort("published_at", DESCENDING).skip(KEEP_PER_INCIDENT)
    ids = [d["_id"] for d in stale]
    if ids:
        fires.delete_many({"_id": {"$in": ids}})
    return ok(
        {
            "fire_id": doc["fire_id"],
            "incident_id": incident_id,
            "incident_name": incidents.active_json()["name"],
            "published_at": iso(published_at),
            "outside_drill": doc["outside_drill"],
        },
        status=201,
    )


def _fire_json(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "fire_id": doc["fire_id"],
        "published_at": iso(doc["published_at"]),
        "incident_id": doc["incident_id"],
        "name": doc["name"],
        "scenario_id": doc["scenario_id"],
        "region_id": doc["region_id"],
        "ignitions": doc["ignitions"],
        "wind": doc["wind"],
        "moisture": doc["moisture"],
        "horizon_minutes": doc["horizon_minutes"],
        "outside_drill": doc.get("outside_drill", []),
    }


@live_view(["GET", "DELETE"])
def list_fires(request, incident_id: str, principal: Principal):
    if request.method == "DELETE":
        # Controller "Reset board": clear this incident's published Studio fires so no console
        # (or a reload) starts them again.
        if principal.role != "controller":
            raise ApiError(403, "forbidden", "Only the controller can clear Studio fires.")
        try:
            deleted = _collection().delete_many({"incident_id": incident_id}).deleted_count
        except PyMongoError as exc:
            raise ApiError(503, "unavailable", "The fire feed is unavailable.") from exc
        return ok({"deleted": deleted})
    query: dict[str, Any] = {"incident_id": incident_id}
    after = request.query_params.get("after")
    if after:
        query["published_at"] = {"$gt": parse_iso(after, "after", "invalid_request")}
    try:
        docs = list(_collection().find(query, {"_id": 0}).sort("published_at", DESCENDING).limit(LIST_LIMIT))
    except PyMongoError as exc:
        raise ApiError(503, "unavailable", "The fire feed is unavailable.") from exc
    return ok({"fires": [_fire_json(d) for d in docs], "evidence_class": "simulated"})
