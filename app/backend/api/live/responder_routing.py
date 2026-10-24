"""``GET /api/live/tasks/{task_id}/route``: a responder's drive to a task target.

Contract: docs/live-reports.md "Tasks (v2 additions)". The route is computed by
``livecore.inbound.inbound_route`` on the drill road network: never over a segment the twin
closes (every public block guidance avoids plus every controller-confirmed block), never
through the fire estimate, and slowed by the simulated traffic twin's per-edge speeds when
the twin is ready (``congestion: "twin"``); otherwise free-flow (``"unavailable"``).
"""

from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime
from typing import Any

from livecore.geo import simplify_line
from livecore.inbound import InboundResult, congestion_factors, inbound_route

from . import twin_service
from .auth import Principal, live_view
from .common import col, error, iso, ok, wall_now
from .state import Snapshot, load_snapshot

log = logging.getLogger(__name__)

ROUTE_STATUSES = ("open", "accepted")
CONGESTION_CACHE_S = 10.0
"""Wall seconds the twin's edge speeds are reused for an incident (tasks poll every ~15 s)."""
LINE_TOLERANCE_M = 5.0
LINE_MAX_POINTS = 300
COORD_DECIMALS = 5
DISTANCE_ROUND_M = 10

DETAIL = {
    "origin_off_network": "start is off the road network",
    "target_off_network": "target is off the road network",
    "origin_in_fire": "start is inside the fire estimate",
    "target_in_fire": "target is inside the fire estimate",
    "no_open_road": "no open road to the target",
}
"""Short phrases; the phone shows "No route: <detail>"."""

_congestion_lock = threading.Lock()
_congestion: dict[str, tuple[float, datetime, dict[str, float]]] = {}


def edge_congestion(snapshot: Snapshot) -> dict[str, float] | None:
    """Directed edge id -> travel-time factor from the simulated twin, or None when the twin is
    warming, busy or failed. Factor: ``congestion_factor(speed_kph, free_flow_kph)`` on edges
    with at least CONGESTION_MIN_VEH (``livecore.inbound``) vehicles; other edges are free-flow."""
    key = snapshot.incident_id
    with _congestion_lock:
        hit = _congestion.get(key)
        if hit is not None and time.monotonic() - hit[0] < CONGESTION_CACHE_S and hit[1] == snapshot.clock.replay_now:
            return hit[2]
    if not twin_service.ensure_ready():
        return None
    try:
        speeds = twin_service.edge_speeds(snapshot)
    except twin_service.TwinUnavailable:
        return None
    except Exception:  # noqa: BLE001 - a twin failure means free-flow routing, never a failed route
        log.exception("responder routing: reading the twin's edge speeds failed")
        return None
    factors = congestion_factors(speeds, snapshot.index.drill.roads.edges)
    with _congestion_lock:
        _congestion[key] = (time.monotonic(), snapshot.clock.replay_now, factors)
    return factors


def _parse_from(raw: str) -> tuple[float, float] | None:
    try:
        lon, lat = (float(v) for v in raw.split(","))
    except ValueError:
        return None
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    return lon, lat


def _latest_location(incident_id: str, party_key: str | None, now: datetime) -> tuple[float, float] | None:
    if not party_key:
        return None
    doc = col("live_responder_locations").find_one(
        {"incident_id": incident_id, "party_key": party_key, "expires_at": {"$gt": now}}
    )
    return (float(doc["coord"][0]), float(doc["coord"][1])) if doc else None


def route_json(result: InboundResult, congestion: str) -> dict[str, Any] | None:
    route = result.route
    if route is None or result.travel_time_s is None:
        return None
    line = simplify_line(route.line, LINE_TOLERANCE_M, LINE_MAX_POINTS) if len(route.line) > 1 else route.line
    return {
        "line": [[round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS)] for p in line],
        "via": list(route.via),
        "distance_m": int(round(route.distance_m / DISTANCE_ROUND_M) * DISTANCE_ROUND_M),
        "eta_min": math.ceil(result.travel_time_s / 60),
        "exposure": route.exposure,
        "congestion": congestion,
        "congested_edges": result.congested_edges,
    }


@live_view(["GET"], roles=["responder", "controller"])
def task_route(request, task_id: str, principal: Principal):
    task = col("live_tasks").find_one({"id": task_id})
    if task is None or (
        principal.role == "responder"
        and (
            principal.incident_id not in (None, task["incident_id"])
            or task.get("assignee") not in (None, principal.party_key)
        )
    ):
        return error(404, "not_found", "Unknown task.")
    if task.get("status") not in ROUTE_STATUSES:
        return error(409, "task_closed", "The task is closed.")
    incident_id = task["incident_id"]
    now = wall_now()
    origin = None
    if principal.role == "controller" and request.query_params.get("from"):
        origin = _parse_from(request.query_params["from"])
        if origin is None:
            return error(400, "invalid_request", "`from` must be lon,lat in WGS84 degrees.")
    if origin is None:
        party = principal.party_key if principal.role == "responder" else task.get("assignee")
        origin = _latest_location(incident_id, party, now)
    snapshot = load_snapshot(incident_id, now)
    body: dict[str, Any] = {
        "task_id": task_id,
        "route": None,
        "reason": None,
        "detail": None,
        "evidence_class": "simulated",
        "as_of": iso(snapshot.clock.replay_now),
    }
    if origin is None:
        detail = ("location not shared" if principal.role == "responder"
                  else "assignee location not shared; pass ?from=lon,lat")
        return ok({**body, "reason": "no_origin", "detail": detail, "error": "no_origin"}, status=409)
    target = (task.get("target") or {}).get("coord")
    if not target:
        return ok({**body, "reason": "unreachable", "detail": "task has no target"})
    factors = edge_congestion(snapshot)
    fire = snapshot.fire.geometry
    result = inbound_route(
        snapshot.index.drill,
        origin,
        (float(target[0]), float(target[1])),
        twin_service.twin_closed_segments(snapshot),
        fire,
        factors,
    )
    if result.route is None:
        return ok({**body, "reason": "unreachable", "detail": DETAIL.get(result.reason or "", result.reason)})
    return ok({**body, "route": route_json(result, "twin" if factors is not None else "unavailable")})
