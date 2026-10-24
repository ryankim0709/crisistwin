"""Dispatch run journal and agent memory in MongoDB Atlas (`dispatch_runs`).

One document per dispatcher session (the page's random `session_id`): the scenario it ran on,
every decision the agent made (what woke it, the orders, its summary, the planner's road
closures at the time) and, once the session ends, the simulator's outcome. Before the first
decision of a session the agent is shown up to MEMORY_RUNS earlier finished runs on the same
road area as `past_runs`: what was tried and what the simulator counted. They are earlier
simulated runs, possibly with other fires, and are labelled so. See
docs/adr/0031-dispatch-run-memory.md.

GET  /api/dispatch/runs?area_id=<id>          -> {runs: [RunSummary]} newest first
POST /api/dispatch/runs/<session_id>/outcome  {area_id, minute, horizon_minutes, finished,
                                               totals, no_action_exposed}  -> 204

Writes never block or fail a decision: a database error is logged and the agent decides
without memory.
"""

import json
import logging
import re
from collections import OrderedDict
from datetime import UTC, datetime
from threading import Lock

from pymongo import DESCENDING
from pymongo.errors import DuplicateKeyError, PyMongoError
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

COLLECTION = "dispatch_runs"
SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
AREA_ID_MAX_CHARS = 120
MAX_DECISIONS_KEPT = 120
MAX_WOKE_REASONS = 8
MAX_TEXT_CHARS = 300
MAX_FIRES = 10
MAX_CLOSURES = 40
MAX_BODY_BYTES = 4_000
MEMORY_RUNS = 3
MEMORY_SUMMARIES = 3
LIST_LIMIT = 20
# Sessions whose memory was already looked up in this worker (memory is fixed for a session).
RECALL_CACHE_SIZE = 64
TOTAL_KEYS = ("homes", "not_ordered", "waiting", "en_route", "out", "exposed")

_recalled: OrderedDict[str, list[dict]] = OrderedDict()
_recalled_lock = Lock()
_indexed = False


class RunThrottle(AnonRateThrottle):
    rate = "30/min"


def _error(status: int, code: str, detail: str) -> Response:
    return Response({"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"})


def valid_session_id(value: object) -> bool:
    return isinstance(value, str) and SESSION_ID.match(value) is not None


def _collection():
    global _indexed
    collection = get_database()[COLLECTION]
    if not _indexed:
        collection.create_index([("area_id", 1), ("updated_at", DESCENDING)])
        _indexed = True
    return collection


def _text(value: object, limit: int = MAX_TEXT_CHARS) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _area_id(obs: dict) -> str | None:
    area = obs.get("area")
    area_id = area.get("id") if isinstance(area, dict) else None
    return area_id if isinstance(area_id, str) and 0 < len(area_id) <= AREA_ID_MAX_CHARS else None


def _planner_closed(obs: dict) -> list[str]:
    roads = obs.get("roads")
    closed = roads.get("planner_closed") if isinstance(roads, dict) else None
    if not isinstance(closed, list):
        return []
    return [_text(c.get("road"), 120) for c in closed[:MAX_CLOSURES] if isinstance(c, dict)]


def _describe(order: dict) -> str:
    kind = order.get("type")
    if kind == "order_evacuation":
        return f"evacuate {order['zone_id']} via {order['exit_id']}"
    if kind == "stage_evacuation":
        return f"stage {order['zone_id']} after {order['after_zone_id']} via {order['exit_id']}"
    if kind == "dispatch_unit":
        return f"{order['unit_id']} -> {order['zone_id']} ({order['task']})"
    if kind == "attack_fire":
        return f"{order['unit_id']} -> fire {order['fire_id']} ({order['tactic']})"
    return f"recall {order.get('unit_id')}"


def record_decision(session_id: str, obs: dict, orders: list[dict], rejected: int, summary: str, model: str) -> None:
    """Append one decision to the session's journal; never raises."""
    area_id = _area_id(obs)
    if area_id is None:
        return
    clock = obs.get("clock") if isinstance(obs.get("clock"), dict) else {}
    monitor = obs.get("monitor") if isinstance(obs.get("monitor"), dict) else {}
    fire = obs.get("fire") if isinstance(obs.get("fire"), dict) else {}
    woke = monitor.get("woke_because") if isinstance(monitor.get("woke_because"), list) else []
    now = datetime.now(UTC)
    decision = {
        "minute": clock.get("minute"),
        "woke_because": [_text(r) for r in woke[:MAX_WOKE_REASONS]],
        "planner_closed": _planner_closed(obs),
        "totals": {k: obs["totals"].get(k) for k in TOTAL_KEYS},
        "orders": [_describe(o) for o in orders],
        "rejected": rejected,
        "summary": _text(summary, 600),
        "model": _text(model, 80),
        "at": now,
    }
    fires = obs.get("fires") if isinstance(obs.get("fires"), list) else []
    scenario = {
        "fires": [_text(f.get("name"), 80) for f in fires[:MAX_FIRES] if isinstance(f, dict)],
        "wind_from_degrees": fire.get("wind_from_degrees"),
        "wind_speed_mph": fire.get("wind_speed_mph"),
        "horizon_minutes": clock.get("horizon_minutes"),
    }
    area = obs.get("area") if isinstance(obs.get("area"), dict) else {}
    try:
        _collection().update_one(
            {"_id": session_id, "area_id": area_id},
            {
                "$setOnInsert": {
                    "area_name": _text(area.get("name"), 120),
                    "scenario": scenario,
                    "started_at": now,
                    "evidence_class": "simulated",
                },
                "$set": {"updated_at": now},
                "$push": {"decisions": {"$each": [decision], "$slice": -MAX_DECISIONS_KEPT}},
            },
            upsert=True,
        )
    except (PyMongoError, ValueError):
        logger.warning("Could not journal a dispatch decision", exc_info=True)


def _memory_entry(doc: dict) -> dict:
    decisions = doc.get("decisions") or []
    orders = [order for d in decisions for order in d.get("orders", [])]
    closed = sorted({road for d in decisions for road in d.get("planner_closed", [])})
    return {
        "started_at": doc["started_at"].isoformat(timespec="minutes") if doc.get("started_at") else None,
        "scenario": doc.get("scenario", {}),
        "planner_closed_roads": closed[:MAX_CLOSURES],
        "decisions": len(decisions),
        "orders_issued": len(orders),
        "first_orders": orders[:8],
        "last_summaries": [d.get("summary", "") for d in decisions[-MEMORY_SUMMARIES:]],
        "outcome": doc.get("outcome"),
        "evidence_class": "simulated",
    }


def recall(session_id: str, obs: dict) -> list[dict]:
    """Earlier finished runs on the same road area, newest first; [] when none or unavailable."""
    with _recalled_lock:
        if session_id in _recalled:
            return _recalled[session_id]
    area_id = _area_id(obs)
    runs: list[dict] = []
    if area_id is not None:
        try:
            docs = (
                _collection()
                .find({"area_id": area_id, "_id": {"$ne": session_id}, "outcome": {"$exists": True}})
                .sort("updated_at", DESCENDING)
                .limit(MEMORY_RUNS)
            )
            runs = [_memory_entry(doc) for doc in docs]
        except (PyMongoError, ValueError):
            # Cached too: a session does not wait on an unreachable database every decision.
            logger.warning("Could not recall past dispatch runs", exc_info=True)
    with _recalled_lock:
        _recalled[session_id] = runs
        while len(_recalled) > RECALL_CACHE_SIZE:
            _recalled.popitem(last=False)
    return runs


def _count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def validate_outcome(data: object) -> str | None:
    if not isinstance(data, dict):
        return "Body must be a JSON object."
    area_id = data.get("area_id")
    if not isinstance(area_id, str) or not 0 < len(area_id) <= AREA_ID_MAX_CHARS:
        return "`area_id` must be the dispatch area id."
    for key in ("minute", "horizon_minutes"):
        if not _count(data.get(key)):
            return f"`{key}` must be nonnegative whole minutes."
    if not isinstance(data.get("finished"), bool):
        return "`finished` must be true or false."
    totals = data.get("totals")
    if not isinstance(totals, dict) or not all(_count(totals.get(k)) for k in TOTAL_KEYS):
        return f"`totals` must have nonnegative counts {', '.join(TOTAL_KEYS)}."
    no_action = data.get("no_action_exposed")
    if no_action is not None and not _count(no_action):
        return "`no_action_exposed` must be null or a nonnegative count."
    return None


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([RunThrottle])
def run_outcome(request, session_id: str):
    """Record the simulator's outcome when a session finishes or is stopped."""
    if not valid_session_id(session_id):
        return _error(400, "invalid_request", "Unknown session id format.")
    if len(request.body) > MAX_BODY_BYTES:
        return _error(413, "too_large", f"Request body exceeds {MAX_BODY_BYTES} bytes.")
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return _error(400, "invalid_request", "Body must be valid JSON.")
    problem = validate_outcome(data)
    if problem:
        return _error(400, "invalid_request", problem)
    outcome = {
        "minute": data["minute"],
        "horizon_minutes": data["horizon_minutes"],
        "finished": data["finished"],
        "totals": {k: data["totals"][k] for k in TOTAL_KEYS},
        "no_action_exposed": data.get("no_action_exposed"),
    }
    try:
        # Only a session that made a decision has a journal; an upsert would invent one.
        result = _collection().update_one(
            {"_id": session_id, "area_id": data["area_id"]},
            {"$set": {"outcome": outcome, "updated_at": datetime.now(UTC)}},
        )
    except DuplicateKeyError:
        return _error(409, "conflict", "That session belongs to another area.")
    except (PyMongoError, ValueError):
        return _error(503, "database_unavailable", "The dispatch run journal is unavailable.")
    if result.matched_count == 0:
        return _error(404, "not_found", "No journal for that session and area.")
    return Response(status=204, headers={"Cache-Control": "no-store"})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def run_list(request):
    """Recent journalled runs for one road area (or all), newest first."""
    area_id = request.query_params.get("area_id")
    query = {}
    if area_id:
        if len(area_id) > AREA_ID_MAX_CHARS:
            return _error(400, "invalid_request", "`area_id` is too long.")
        query["area_id"] = area_id
    try:
        docs = list(_collection().find(query).sort("updated_at", DESCENDING).limit(LIST_LIMIT))
    except (PyMongoError, ValueError):
        return _error(503, "database_unavailable", "The dispatch run journal is unavailable.")
    runs = [
        {
            "session_id": doc["_id"],
            "area_id": doc["area_id"],
            "area_name": doc.get("area_name", ""),
            **_memory_entry(doc),
        }
        for doc in docs
    ]
    return Response({"runs": runs}, headers={"Cache-Control": "no-store"})
