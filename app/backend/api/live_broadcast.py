"""Live simulation broadcast for the resident iOS app.

The web fire page (/fire) and the dispatch page (/dispatch) post a snapshot of the run they
are playing: the simulated fire footprint at the current simulation minute and, from the
dispatch agent, per-zone resident guidance derived from the agent's orders and the
simulator's queue figures. The app polls the latest snapshot. Everything in it is simulated;
nothing here is an official alert. Wire contract: app/src/live/contracts.ts and
docs/adr/0016-resident-live-and-family.md.

POST /api/live/broadcast  body: LiveSnapshot           -> 204
GET  /api/live                                         -> {"snapshot", "received_at"} | 404
"""

import json
import math
from datetime import UTC, datetime

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

SNAPSHOT_VERSION = 1
MAX_BODY_BYTES = 600_000
MAX_RINGS = 60
MAX_RING_POINTS = 600
MAX_ZONES = 200
MAX_TEXT_CHARS = 600
SOURCES = {"fire_model", "dispatch_agent"}
PLAYBACK = {"playing", "paused", "finished", "stopped"}
GUIDANCE = {"no_order", "leave_now", "wait", "route_blocked", "cleared", "overrun"}
COLLECTION = "live_broadcast"
DOC_ID = "current"


class BroadcastThrottle(AnonRateThrottle):
    """The pages post about every 2 s while playing."""

    rate = "120/min"


def _error(status: int, code: str, detail: str) -> Response:
    return Response(
        {"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"}
    )


def _number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _lonlat(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and _number(value[0])
        and _number(value[1])
        and -180 <= value[0] <= 180
        and -90 <= value[1] <= 90
    )


def _ring(value: object, min_points: int = 4) -> bool:
    return (
        isinstance(value, list)
        and min_points <= len(value) <= MAX_RING_POINTS
        and all(_lonlat(p) for p in value)
    )


def _text(value: object, allow_empty: bool = True) -> bool:
    return isinstance(value, str) and len(value) <= MAX_TEXT_CHARS and (allow_empty or value != "")


def _optional_minutes(value: object) -> bool:
    return value is None or (_number(value) and value >= 0)


def validate_zone(zone: object) -> str | None:
    if not isinstance(zone, dict):
        return "each zone must be an object"
    if not _text(zone.get("id"), allow_empty=False) or not _text(zone.get("name")):
        return "zone id and name must be strings"
    if not _ring(zone.get("polygon")):
        return f"zone {zone.get('id')} polygon must be a closed [lon, lat] ring"
    if zone.get("guidance") not in GUIDANCE:
        return f"zone {zone.get('id')} guidance must be one of {sorted(GUIDANCE)}"
    if not _text(zone.get("message"), allow_empty=False):
        return f"zone {zone.get('id')} message must be a nonempty string"
    for key in ("fire_eta_min", "fire_core_eta_min", "wait_min", "drive_min"):
        if not _optional_minutes(zone.get(key)):
            return f"zone {zone.get('id')} {key} must be null or nonnegative minutes"
    exit_ = zone.get("exit")
    if exit_ is not None:
        if not isinstance(exit_, dict) or not _text(exit_.get("id"), False) or not _text(exit_.get("name")):
            return f"zone {zone.get('id')} exit must be null or {{id, name, road, location}}"
        if not _text(exit_.get("road")) or not _lonlat(exit_.get("location")):
            return f"zone {zone.get('id')} exit road/location invalid"
    route = zone.get("route")
    if route is not None and not _ring(route, min_points=2):
        return f"zone {zone.get('id')} route must be null or a [lon, lat] line"
    return None


def validate_snapshot(data: object) -> str | None:
    """Return why a snapshot is invalid, or None."""
    if not isinstance(data, dict):
        return "Body must be a JSON object."
    if data.get("version") != SNAPSHOT_VERSION:
        return f"`version` must be {SNAPSHOT_VERSION}."
    if data.get("source") not in SOURCES:
        return f"`source` must be one of {sorted(SOURCES)}."
    if data.get("evidence_class") != "simulated":
        return '`evidence_class` must be "simulated".'
    if not _text(data.get("session_id"), allow_empty=False) or len(data["session_id"]) > 64:
        return "`session_id` must be a short nonempty string."
    if data.get("playback") not in PLAYBACK:
        return f"`playback` must be one of {sorted(PLAYBACK)}."
    if not _text(data.get("area_name")):
        return "`area_name` must be a string."
    for key in ("minute", "horizon_minutes"):
        if not _number(data.get(key)) or data[key] < 0:
            return f"`{key}` must be nonnegative minutes."
    wind = data.get("wind")
    if not isinstance(wind, dict) or not _number(wind.get("from_degrees")) or not _number(wind.get("speed_mph")):
        return "`wind` must be {from_degrees, speed_mph}."
    bbox = data.get("bbox")
    if bbox is not None and not (isinstance(bbox, list) and len(bbox) == 4 and all(_number(v) for v in bbox)):
        return "`bbox` must be null or [west, south, east, north]."
    fire = data.get("fire")
    if not isinstance(fire, dict) or not _number(fire.get("burned_area_ha")) or fire["burned_area_ha"] < 0:
        return "`fire` must be {perimeters, burned_area_ha}."
    rings = fire.get("perimeters")
    if not isinstance(rings, list) or len(rings) > MAX_RINGS or not all(_ring(r) for r in rings):
        return f"`fire.perimeters` must be at most {MAX_RINGS} closed [lon, lat] rings."
    zones = data.get("zones")
    if not isinstance(zones, list) or len(zones) > MAX_ZONES:
        return f"`zones` must be a list of at most {MAX_ZONES} zones."
    for zone in zones:
        problem = validate_zone(zone)
        if problem:
            return f"`zones`: {problem}."
    agent = data.get("agent")
    if agent is not None:
        if not isinstance(agent, dict) or not _text(agent.get("summary")) or not _text(agent.get("model")):
            return "`agent` must be null or {summary, model, minute}."
        if not _number(agent.get("minute")) or agent["minute"] < 0:
            return "`agent.minute` must be nonnegative minutes."
    return None


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def live_snapshot(request):
    """The most recent broadcast, with when the server received it (UTC)."""
    try:
        doc = get_database()[COLLECTION].find_one({"_id": DOC_ID})
    except (PyMongoError, ValueError):
        return _error(503, "database_unavailable", "The live broadcast store is unavailable.")
    if doc is None:
        return _error(404, "no_broadcast", "No simulation is being broadcast.")
    return Response(
        {"snapshot": doc["snapshot"], "received_at": doc["received_at"].isoformat(timespec="milliseconds")},
        headers={"Cache-Control": "no-store"},
    )


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([BroadcastThrottle])
def live_broadcast(request):
    """Replace the current broadcast. Unauthenticated local demo endpoint, like dispatch."""
    if len(request.body) > MAX_BODY_BYTES:
        return _error(413, "too_large", f"Request body exceeds {MAX_BODY_BYTES} bytes.")
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return _error(400, "invalid_request", "Body must be valid JSON.")
    problem = validate_snapshot(data)
    if problem:
        return _error(400, "invalid_request", problem)
    try:
        get_database()[COLLECTION].replace_one(
            {"_id": DOC_ID},
            {"_id": DOC_ID, "snapshot": data, "received_at": datetime.now(UTC)},
            upsert=True,
        )
    except (PyMongoError, ValueError):
        return _error(503, "database_unavailable", "The live broadcast store is unavailable.")
    return Response(status=204, headers={"Cache-Control": "no-store"})
