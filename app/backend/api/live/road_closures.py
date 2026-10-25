"""Drill road closures the controller sets on the Live map (contract: docs/live-reports.md "Road closures").

A closure is a drill action: the controller closes one drill road segment (both directions) for
the simulated command board. Every router of the board then avoids it: zone evacuation routes
(``POST /api/demo/routes``) and fire-unit legs (``POST /api/demo/crew_routes``) pass it to
``livecore.routing`` / ``livecore.inbound`` as a blocked segment, the same mechanism the live
planner uses for blocked roads. It does not touch the live drill's road reports or guidance.

- ``GET /api/live/incidents/<id>/road-closures`` (any live principal): the current closures.
- ``GET .../road-closures?near=<lon>,<lat>`` (any live principal): the drill segment nearest the
  point (within ``drillcache.SNAP_MAX_M``), for the controller's confirm panel; nothing stored.
- ``POST .../road-closures`` (controller) ``{"segment_id", "board_minute"?}``: closes it (201; 200
  when it was already closed).
- ``DELETE .../road-closures/<segment_id>`` (controller): reopens it (the document is deleted).
- A new Simulation Studio run published for the incident (``studio_fires.publish``) reopens them
  all: a new scenario is a clean drill (``clear``).

Stored in ``live_road_closures``: one small document per closed segment (incident_id, segment_id,
name, closed_at, board_minute, by), at most ``MAX_PER_INCIDENT`` per incident. The road line is
read from the drill on every GET, never stored. Units: WGS84 [lon, lat]; metres; board minutes.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any

from pymongo import ASCENDING
from pymongo.errors import PyMongoError

from livecore.geo import simplify_line

from .auth import Principal, live_view
from .common import ApiError, col, decision_actor, iso, json_body, ok, parse_coord, wall_now
from .drillcache import get_index, snap_to_segment

log = logging.getLogger(__name__)

COLLECTION = "live_road_closures"
MAX_PER_INCIDENT = 20
CODE = "invalid_road_closure"
LINE_TOLERANCE_M = 8.0
LINE_MAX_POINTS = 80
CACHE_TTL_S = 2.0
"""The routers re-read the store at most this often per process (writes here clear it)."""
_index_ready = False
_cache: dict[str, tuple[float, frozenset[str]]] = {}
_cache_lock = threading.Lock()


def _collection():
    global _index_ready
    closures = col(COLLECTION)
    if not _index_ready:
        # Best effort (as studio_fires): a write-blocked cluster must not take the reads down.
        try:
            closures.create_index([("incident_id", ASCENDING), ("segment_id", ASCENDING)], unique=True)
            _index_ready = True
        except PyMongoError:
            pass
    return closures


def closed_segment_ids(incident_id: str) -> tuple[frozenset[str], bool]:
    """Segment ids closed by the controller on ``incident_id``, and whether the store answered.

    The board's routers pass these as blocked segments. ``(frozenset(), False)`` when MongoDB is
    unavailable: the routing answer then says so (``closures_status``) and the page does not use
    an answer that misses a closure it knows of."""
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(incident_id)
        if hit is not None and hit[0] > now:
            return hit[1], True
    try:
        ids = frozenset(
            d["segment_id"] for d in _collection().find({"incident_id": incident_id}, {"_id": 0, "segment_id": 1})
        )
    except PyMongoError:
        log.warning("road closures: store unavailable for %s", incident_id)
        return frozenset(), False
    with _cache_lock:
        _cache[incident_id] = (now + CACHE_TTL_S, ids)
    return ids, True


def _forget(incident_id: str) -> None:
    with _cache_lock:
        _cache.pop(incident_id, None)


def clear(incident_id: str) -> int:
    """New Studio run (studio_fires.publish): reopen every road of the incident; returns how many."""
    deleted = _collection().delete_many({"incident_id": incident_id}).deleted_count
    _forget(incident_id)
    return deleted


def _line(index, segment_id: str) -> list[list[float]]:
    line = simplify_line(index.segment_lines[segment_id], LINE_TOLERANCE_M, LINE_MAX_POINTS)
    return [[round(x, 6), round(y, 6)] for x, y in line]


def _name(index, segment_id: str) -> str:
    name = index.segment_names.get(segment_id)
    if name:
        return name
    edges = index.drill.roads.segment_edges.get(segment_id, ())
    highway = index.drill.roads.edges[edges[0]].highway if edges else "road"
    return f"Unnamed {highway.replace('_', ' ')}"


def _closure_json(index, doc: dict[str, Any]) -> dict[str, Any] | None:
    seg = doc["segment_id"]
    if seg not in index.segment_lines:
        return None  # a segment of another drill version; not drawn or routed
    return {
        "segment_id": seg,
        "name": doc.get("name") or _name(index, seg),
        "line": _line(index, seg),
        "closed_at": iso(doc["closed_at"]),
        "board_minute": doc.get("board_minute"),
        "by": doc.get("by") or "controller",
        "evidence_class": "drill",
    }


def _board_minute(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 100_000:
        raise ApiError(400, CODE, "`board_minute` must be a board minute (0 to 100000) or null.")
    return int(round(value))


@live_view(["GET", "POST"])
def road_closures(request, incident_id: str, principal: Principal):
    index = get_index(incident_id)
    if request.method == "POST":
        if principal.role != "controller":
            raise ApiError(403, "forbidden", "Only the controller can close roads.")
        body = json_body(request, CODE)
        seg = body.get("segment_id")
        if not isinstance(seg, str) or seg not in index.segment_lines:
            raise ApiError(400, CODE, "`segment_id` must be a road segment of this drill.")
        minute = _board_minute(body.get("board_minute"))
        closures = _collection()
        existing = closures.find_one({"incident_id": incident_id, "segment_id": seg}, {"_id": 0})
        if existing is not None:
            return ok({"closure": _closure_json(index, existing), "created": False})
        if closures.count_documents({"incident_id": incident_id}, limit=MAX_PER_INCIDENT) >= MAX_PER_INCIDENT:
            raise ApiError(409, "too_many_closures", f"At most {MAX_PER_INCIDENT} roads can be closed at once; reopen one first.")
        doc = {
            "incident_id": incident_id,
            "segment_id": seg,
            "name": _name(index, seg),
            "closed_at": wall_now(),
            "board_minute": minute,
            "by": decision_actor("controller"),
        }
        closures.insert_one(dict(doc))
        _forget(incident_id)
        return ok({"closure": _closure_json(index, doc), "created": True}, status=201)

    near = request.query_params.get("near")
    if near:
        try:
            point = parse_coord([float(v) for v in near.split(",")], "near", "invalid_request")
        except ValueError:
            raise ApiError(400, "invalid_request", "`near` must be lon,lat.") from None
        hit = snap_to_segment(index, point)
        if hit is None:
            return ok({"segment": None})
        seg, metres = hit
        closed = _collection().count_documents({"incident_id": incident_id, "segment_id": seg}, limit=1) > 0
        return ok({
            "segment": {"segment_id": seg, "name": _name(index, seg), "line": _line(index, seg),
                        "distance_m": round(metres), "closed": closed},
        })
    docs = list(_collection().find({"incident_id": incident_id}, {"_id": 0}).sort("closed_at", ASCENDING).limit(MAX_PER_INCIDENT))
    items = [c for c in (_closure_json(index, d) for d in docs) if c is not None]
    return ok({"closures": items, "evidence_class": "drill"})


@live_view(["DELETE"], roles=["controller"])
def reopen_road(request, incident_id: str, segment_id: str, principal: Principal):
    deleted = _collection().delete_one({"incident_id": incident_id, "segment_id": segment_id}).deleted_count
    _forget(incident_id)
    if not deleted:
        raise ApiError(404, "not_found", "That road is not closed.")
    return ok({"reopened": segment_id})
