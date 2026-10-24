"""Crowdsourced task board and information priority (ADR 0041).

``livecore.priority`` computes every number; this module gathers its inputs from the snapshot
(published guidance, the planner's remembered route edges, reports, the twin or the plan), stores
the ranked list (``live_board``), turns the top places into open board questions (``live_tasks``
with ``created_by: "priority"``) and renders the public board and the console list.

Privacy: the board carries questions about places only. It never includes reports, help requests,
check-ins, responder assignments or anyone's location (docs/live-reports.md "Task board").
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Any

from livecore import priority as pr
from livecore.geo import polyline_distance_m
from livecore.planner import LOAD_EXIT_WINDOW_H
from livecore.public import effective_at
from livecore.routing import destination_node
from pymongo import ReturnDocument

from . import controller, twin_service
from .common import col, iso, new_id
from .controllers import PLAN_ROUTES, _via_key
from .state import Snapshot, current_guidance

log = logging.getLogger(__name__)

PASSIVE_RADIUS_M = 1500.0
"""A phone considers board questions within this distance of itself (besides those on its route). ASSUMPTION."""
PASSIVE_TTL_S = 1800
"""A board question expires this long after it was created. ASSUMPTION."""
MAX_PASSIVE_QUESTIONS = 3
"""A phone shows at most this many board questions. ASSUMPTION."""
STALL_S = 120
"""Stopped inside a board segment's buffer this long -> the phone asks one explicit question. ASSUMPTION."""
SLOW_RATIO = 0.5
"""A passive traversal below SLOW_RATIO × free-flow speed adds ``heavy_traffic``. ASSUMPTION."""
BOARD_REFRESH_S = 60
"""Priorities are recomputed at most this often (wall seconds) per incident, on a command or board read."""
BOARD_MAX_OPEN = 8
"""At most this many open board questions per incident (the top N places)."""
BOARD_CREATE_PER_REFRESH = 3
"""Rate limit: at most this many new board questions per refresh."""
BOARD_PLACE_COOLDOWN_S = 600
"""No new question for a place within this long after its last one closed."""
BOARD_MIN_PRIORITY = 0.05
"""Places below this priority never become questions."""
BOARD_FIRE_EXCLUSION_M = 1000.0
"""Places within this distance of the fire estimate never become or stay public questions (>= FIRE_BUFFER_M)."""
BOARD_MIN_SPACING_M = 1500.0
"""Board questions (and console rows) are at least this far apart, so one road does not fill the list."""
BOARD_PLACE_KINDS = ("segment", "destination")
"""Gateways stay console suggestions: responder tasks are never auto-dispatched."""
STALE_CRITICAL_LIMIT = 10
STORED_ITEMS_LIMIT = 40
TWIN_ARRIVALS_MAX_AGE_S = 120.0
"""A twin arrivals read older than this is not used (the plan heading is used instead)."""
TWIN_ARRIVALS_PER_HOUR = 6
"""``arrived_last_10_min_veh × 6``: an exit's simulated arrival rate per hour."""
QUESTION_FOR_KIND = {"segment": "road_status", "destination": "shelter_full"}
ANSWER_KINDS = {"road_status": frozenset({"road_blocked", "road_passable", "heavy_traffic"}),
                "shelter_full": frozenset({"shelter_full"})}
ANSWER_COUNT_KINDS = ("road_passable", "road_blocked", "heavy_traffic", "shelter_full")


# ---- inputs ----


def _route_uses(snapshot: Snapshot) -> list[pr.RouteUse]:
    """Published moving zones whose route edges the planner remembered (same destination and via)."""
    drill = snapshot.index.drill
    vehicles = {z.id: z.vehicles for z in drill.zones}
    docs = [d for d in current_guidance(snapshot.incident_id)
            if d.get("level") != "none" and not d.get("no_route") and d.get("destination") and d.get("route")]
    if not docs:
        return []
    plans = {
        (p["zone_id"], p["destination_id"], p["via_key"]): p.get("edge_ids") or []
        for p in col(PLAN_ROUTES).find({"incident_id": snapshot.incident_id},
                                       {"_id": 0, "zone_id": 1, "destination_id": 1, "via_key": 1, "edge_ids": 1})
    }
    edges = drill.roads.edges
    out: list[pr.RouteUse] = []
    for d in docs:
        edge_ids = plans.get((d["zone_id"], d["destination"]["id"], _via_key(d["route"].get("via"))))
        if not edge_ids:
            continue  # no remembered edges for this published route: not a candidate source
        segments = frozenset(edges[e].segment_id for e in edge_ids if e in edges)
        alts = tuple(
            tuple((p[0], p[1]) for p in a["route"]["line"])
            for a in d.get("alternatives") or []
            if not a.get("recommended") and a.get("route") and a["route"].get("line")
        )
        out.append(pr.RouteUse(d["zone_id"], vehicles.get(d["zone_id"], 0), segments, alts))
    return out


def _segment_infos(snapshot: Snapshot) -> dict[str, pr.SegmentInfo]:
    index = snapshot.index
    roads = index.drill.roads
    out = {}
    for seg, edge_ids in roads.segment_edges.items():
        line = index.segment_lines.get(seg)
        if not line or not edge_ids:
            continue
        out[seg] = pr.SegmentInfo(line, index.segment_names.get(seg), roads.edges[edge_ids[0]].length_m)
    return out


def free_flow_kph(snapshot: Snapshot, segment_id: str) -> float | None:
    roads = snapshot.index.drill.roads
    ids = roads.segment_edges.get(segment_id) or ()
    return max((roads.edges[e].speed_kph for e in ids), default=None)


def _last_observed(snapshot: Snapshot) -> tuple[dict[str, datetime], dict[str, datetime], list]:
    """Newest effective time of a non-dismissed, non-withdrawn report per segment (road kinds) and per destination
    (``shelter_full``), and fire points (``fire_seen``/``heavy_smoke``). Passive reports count."""
    segs: dict[str, datetime] = {}
    dests: dict[str, datetime] = {}
    fire_points = []
    for f in snapshot.facts:
        if f.status in ("dismissed", "withdrawn"):
            continue
        at = effective_at(f)
        if f.kind in ("road_blocked", "road_passable", "heavy_traffic") and f.segment_id:
            if f.segment_id not in segs or at > segs[f.segment_id]:
                segs[f.segment_id] = at
        elif f.kind == "shelter_full" and f.destination_id:
            if f.destination_id not in dests or at > dests[f.destination_id]:
                dests[f.destination_id] = at
        elif f.kind in ("fire_seen", "heavy_smoke"):
            fire_points.append((f.coord, at))
    return segs, dests, fire_points


def _destination_infos(snapshot: Snapshot) -> tuple[list[pr.DestinationInfo], dict[str, bool]]:
    """Destinations with a known capacity (as the planner's ``load``) and whether it is per hour (exit)."""
    drill = snapshot.index.drill
    roads = drill.roads
    out, per_hour = [], {}
    for dest in drill.destinations:
        capacity: float | None = float(dest.capacity_veh) if dest.capacity_veh else None
        hourly = False
        if capacity is None and dest.kind == "exit":
            node = destination_node(drill, dest.id)
            if node is not None:
                cap = sum(roads.edges[e].capacity_veh_per_hour for e in roads.in_edges.get(node, ()))
                capacity, hourly = (cap * LOAD_EXIT_WINDOW_H if cap > 0 else None), True
        if capacity:
            out.append(pr.DestinationInfo(dest.id, dest.name, dest.coord, capacity))
            per_hour[dest.id] = hourly
    return out, per_hour


_arrivals: dict[str, tuple[float, dict[str, tuple[int, int]]]] = {}
_arrivals_running: set[str] = set()
_arrivals_lock = threading.Lock()


def _kick_twin_arrivals(snapshot: Snapshot) -> None:
    """Refresh the twin arrivals cache in the background (the twin sync can take seconds)."""
    if twin_service.status().get("status") != "ready":
        return
    with _arrivals_lock:
        if snapshot.incident_id in _arrivals_running:
            return
        _arrivals_running.add(snapshot.incident_id)

    def run() -> None:
        try:
            value = twin_service.destination_arrivals(snapshot, lock_timeout_s=2.0)
            with _arrivals_lock:
                _arrivals[snapshot.incident_id] = (time.monotonic(), value)
        except Exception:  # noqa: BLE001 - optional input; the plan heading stands in
            log.info("live board: twin arrivals unavailable", exc_info=True)
        finally:
            with _arrivals_lock:
                _arrivals_running.discard(snapshot.incident_id)

    threading.Thread(target=run, name="live-board-arrivals", daemon=True).start()


def _arrivals_for(snapshot: Snapshot, per_hour: dict[str, bool]) -> tuple[dict[str, float], str]:
    """Arrivals per destination in its capacity unit, and the source (``twin`` or ``plan``)."""
    _kick_twin_arrivals(snapshot)
    with _arrivals_lock:
        cached = _arrivals.get(snapshot.incident_id)
    if cached is not None and time.monotonic() - cached[0] <= TWIN_ARRIVALS_MAX_AGE_S:
        values = cached[1]
        return {
            did: float(last10 * TWIN_ARRIVALS_PER_HOUR if per_hour.get(did) else arrived)
            for did, (arrived, last10) in values.items()
        }, "twin"
    vehicles = {z.id: z.vehicles for z in snapshot.index.drill.zones}
    heading: dict[str, float] = {}
    for d in current_guidance(snapshot.incident_id):
        if d.get("level") == "evacuate_now" and not d.get("no_route") and d.get("destination"):
            did = d["destination"]["id"]
            heading[did] = heading.get(did, 0.0) + vehicles.get(d["zone_id"], 0)
    return heading, "plan"


def compute(snapshot: Snapshot) -> tuple[list[pr.PriorityItem], str]:
    """Every candidate place, ranked; plus the arrivals source for destinations."""
    fire = snapshot.fire.geometry
    segs_seen, dests_seen, fire_points = _last_observed(snapshot)
    items = pr.segment_items(_route_uses(snapshot), _segment_infos(snapshot), segs_seen, fire, snapshot.now)
    dests, per_hour = _destination_infos(snapshot)
    arrivals, source = _arrivals_for(snapshot, per_hour)
    items += pr.destination_items(dests, arrivals, dests_seen, fire, snapshot.now)
    if snapshot.clock.replay_now is not None:
        items += pr.gateway_items(snapshot.index.drill.zones, snapshot.index.drill.fronts, fire,
                                  snapshot.clock.replay_now, fire_points, snapshot.now)
    return pr.rank(items), source


# ---- storage and tasks ----


def item_json(item: pr.PriorityItem, task_id: str | None = None) -> dict[str, Any]:
    return {
        "id": item.id, "kind": item.kind, "name": item.name,
        "coord": [item.coord[0], item.coord[1]],
        "line": [[p[0], p[1]] for p in item.line] if item.line else None,
        "segment_id": item.segment_id, "destination_id": item.destination_id, "zone_id": item.zone_id,
        "priority": item.priority, "impact": item.impact, "p_change": item.p_change, "staleness": item.staleness,
        "vehicles": round(item.vehicles) if item.vehicles is not None and item.kind == "segment" else None,
        "zones": item.zones, "zones_losing_route": item.zones_losing_route, "load": item.load,
        "households": item.households, "spread_ratio": item.spread_ratio,
        "fire_distance_m": item.fire_distance_m, "half_life_s": item.half_life_s,
        "last_observed_at": iso(item.last_observed_at), "reason": item.reason, "task_id": task_id,
    }


def expire_tasks(incident_id: str, now: datetime) -> int:
    """Close expired board questions: ``done`` when answered, else ``cancelled`` (note ``Expired``)."""
    tasks = col("live_tasks")
    expired = list(tasks.find({"incident_id": incident_id, "created_by": "priority", "status": "open",
                               "expires_at": {"$lte": now}}, {"id": 1}))
    if not expired:
        return 0
    ids = [t["id"] for t in expired]
    answered = set(col("live_reports").distinct("task_id", {"incident_id": incident_id, "task_id": {"$in": ids}}))
    for tid in ids:
        status = "done" if tid in answered else "cancelled"
        tasks.update_one({"id": tid, "status": "open"},
                         {"$set": {"status": status, "closed_at": now, "note": "Expired"}})
    return len(ids)


def create_tasks(snapshot: Snapshot, items: list[pr.PriorityItem]) -> list[dict[str, Any]]:
    """Top places -> open board questions (deduplicated per place, spaced, rate-limited, capped)."""
    incident_id, now = snapshot.incident_id, snapshot.now
    tasks = col("live_tasks")
    open_docs = list(tasks.find({"incident_id": incident_id, "created_by": "priority", "status": "open"}))
    room = min(BOARD_CREATE_PER_REFRESH, BOARD_MAX_OPEN - len(open_docs))
    if room <= 0:
        return []
    cooldown = now - timedelta(seconds=BOARD_PLACE_COOLDOWN_S)
    blocked = {d.get("place_id") for d in open_docs}
    blocked |= {d.get("place_id") for d in tasks.find(
        {"incident_id": incident_id, "created_by": "priority", "closed_at": {"$gte": cooldown}}, {"place_id": 1})}
    candidates = [
        i for i in items
        if i.kind in BOARD_PLACE_KINDS and i.priority >= BOARD_MIN_PRIORITY and i.id not in blocked
        and (i.fire_distance_m is None or i.fire_distance_m >= BOARD_FIRE_EXCLUSION_M)
    ]
    taken = [tuple(d["target"]["coord"]) for d in open_docs if (d.get("target") or {}).get("coord")]
    chosen = pr.select_diverse(candidates, BOARD_MIN_SPACING_M, room, taken)
    created = []
    for item in chosen:
        doc = {
            "id": new_id("tsk_"), "incident_id": incident_id, "assignee": None, "kind": "verify",
            "checkin_id": None,
            "target": {"segment_id": item.segment_id, "coord": [item.coord[0], item.coord[1]],
                       "destination_id": item.destination_id},
            "report_ids": [], "note": None, "created_at": now, "status": "open", "answer": None,
            "accepted_at": None, "created_by": "priority", "question": QUESTION_FOR_KIND[item.kind],
            "place": {"kind": item.kind, "name": item.name}, "place_id": item.id,
            "expires_at": now + timedelta(seconds=PASSIVE_TTL_S),
            "priority": {"priority": item.priority, "impact": item.impact, "p_change": item.p_change,
                         "staleness": item.staleness},
        }
        tasks.insert_one(doc)
        doc.pop("_id", None)
        created.append(doc)
    if created:
        controller.log_decision(incident_id, "auto_policy", "board_tasks", now,
                                note=", ".join(d["place"]["name"] for d in created))
    return created


def refresh(snapshot: Snapshot) -> list[pr.PriorityItem]:
    """Recompute priorities, expire and create board questions, store the ranked list."""
    items, source = compute(snapshot)
    expire_tasks(snapshot.incident_id, snapshot.now)
    create_tasks(snapshot, items)
    open_by_place = {
        d["place_id"]: d["id"]
        for d in col("live_tasks").find({"incident_id": snapshot.incident_id, "created_by": "priority",
                                         "status": "open"}, {"place_id": 1, "id": 1})
    }
    stored = pr.select_diverse(items, BOARD_MIN_SPACING_M, STORED_ITEMS_LIMIT)
    col("live_board").update_one(
        {"incident_id": snapshot.incident_id},
        {"$set": {"computed_at": snapshot.now, "replay_at": snapshot.clock.replay_now, "arrivals_source": source,
                  "items": [item_json(i, open_by_place.get(i.id)) for i in stored]}},
        upsert=True,
    )
    return items


def maybe_refresh(snapshot: Snapshot) -> bool:
    """Refresh at most once per BOARD_REFRESH_S per incident while a drill runs (atomic claim)."""
    doc = snapshot.drill_doc
    if doc is None or doc.get("started_at") is None:
        return False
    cutoff = snapshot.now - timedelta(seconds=BOARD_REFRESH_S)
    claimed = col("live_drills").find_one_and_update(
        {"incident_id": snapshot.incident_id, "started_at": {"$ne": None},
         "$or": [{"board_refreshed_at": None}, {"board_refreshed_at": {"$lte": cutoff}}]},
        {"$set": {"board_refreshed_at": snapshot.now}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        return False
    try:
        refresh(snapshot)
    except Exception:  # noqa: BLE001 - the board is an aid; the poll that triggered it must still answer
        log.exception("live board: refresh failed")
        return False
    return True


# ---- rendering ----


def _near_fire(snapshot: Snapshot, task: dict[str, Any]) -> bool:
    fire = snapshot.fire.geometry
    if fire is None:
        return False
    seg = (task.get("target") or {}).get("segment_id")
    line = snapshot.index.segment_lines.get(seg) if seg else None
    where = list(line) if line else [tuple(task["target"]["coord"])]
    return polyline_distance_m(where, fire, BOARD_FIRE_EXCLUSION_M) < BOARD_FIRE_EXCLUSION_M  # exact, not the ranking approximation


def board_json(snapshot: Snapshot) -> dict[str, Any]:
    """``GET board``: questions only (place, kind, expiry). No reports, people, help or assignments."""
    docs = list(col("live_tasks").find({
        "incident_id": snapshot.incident_id, "created_by": "priority", "status": "open",
        "expires_at": {"$gt": snapshot.now},
    }))
    docs.sort(key=lambda d: (-((d.get("priority") or {}).get("priority") or 0.0), d["created_at"], d["id"]))
    items = []
    for d in docs:
        if _near_fire(snapshot, d):
            continue
        target = d["target"]
        seg = target.get("segment_id")
        line = snapshot.index.segment_lines.get(seg) if seg else None
        kph = free_flow_kph(snapshot, seg) if seg else None
        items.append({
            "task_id": d["id"],
            "rank": len(items) + 1,
            "question": d["question"],
            "place": {
                "kind": d["place"]["kind"], "segment_id": seg, "destination_id": target.get("destination_id"),
                "name": d["place"]["name"], "coord": [target["coord"][0], target["coord"][1]],
                "line": [[p[0], p[1]] for p in line] if line else None,
                "free_flow_kph": round(kph) if kph else None,
            },
            "expires_at": iso(d["expires_at"]),
        })
    return {
        "incident_id": snapshot.incident_id,
        "generated_at": iso(snapshot.now),
        "limits": {"radius_m": PASSIVE_RADIUS_M, "max_questions": MAX_PASSIVE_QUESTIONS, "stall_s": STALL_S,
                   "slow_ratio": SLOW_RATIO},
        "items": items,
    }


def stale_critical_json(incident_id: str) -> tuple[list[dict[str, Any]], str | None]:
    """The stored ranked list (top STALE_CRITICAL_LIMIT) and when it was computed."""
    doc = col("live_board").find_one({"incident_id": incident_id})
    if doc is None:
        return [], None
    return list(doc.get("items") or [])[:STALE_CRITICAL_LIMIT], iso(doc.get("computed_at"))


def task_answers(incident_id: str, task_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Per task: answer counts by kind, passive count, total and the newest answer time."""
    if not task_ids:
        return {}
    rows = col("live_reports").aggregate([
        {"$match": {"incident_id": incident_id, "task_id": {"$in": task_ids},
                    "status": {"$nin": ["dismissed", "withdrawn"]}}},
        {"$group": {"_id": {"task_id": "$task_id", "kind": "$kind", "method": "$method"},
                    "n": {"$sum": 1}, "last": {"$max": "$received_at"}}},
    ])
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        tid = r["_id"]["task_id"]
        a = out.setdefault(tid, {**{k: 0 for k in ANSWER_COUNT_KINDS}, "passive": 0, "total": 0, "last_at": None})
        kind = r["_id"]["kind"]
        if kind in a:
            a[kind] += r["n"]
        if r["_id"].get("method") == "passive":
            a["passive"] += r["n"]
        a["total"] += r["n"]
        if a["last_at"] is None or r["last"] > a["last_at"]:
            a["last_at"] = r["last"]
    for a in out.values():
        a["last_at"] = iso(a["last_at"])
    return out


def empty_answers() -> dict[str, Any]:
    return {**{k: 0 for k in ANSWER_COUNT_KINDS}, "passive": 0, "total": 0, "last_at": None}
