"""Read side of the live drill: the drill clock, the current situation snapshot, and JSON rendering.

All rules come from ``livecore``; this module only loads documents, converts them to
livecore values and renders livecore results in the wire shapes of docs/live-reports.md.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from threading import Lock
from datetime import UTC, datetime
from typing import Any

from django.conf import settings
from livecore import drill as drillmod
from livecore import public
from livecore.fire import FireEstimate, estimate_fire
from livecore.geo import simplify_line, to_geojson
from livecore.planner import Alternative, ZoneGuidance, route_safety
from livecore.routing import Route

from .common import col, iso
from .drillcache import DrillIndex, get_index

REPORTS_SNAPSHOT_LIMIT = 5000
"""Newest reports read per snapshot (a drill has far fewer)."""
ROUTE_DISTANCE_ROUND_M = 10
ALTERNATIVE_LINE_TOLERANCE_M = 30.0
ALTERNATIVE_LINE_MAX_POINTS = 80
"""Alternative route lines are Douglas-Peucker simplified (30 m) and capped at 80 points, so
four alternatives per zone keep the situation payload small; the main ``route.line`` is not."""
COORD_DECIMALS = 5
"""Alternative line coordinates are rounded to 5 decimals (about 1 m)."""


# ---- rendering helpers ----


_PLAIN = (float, int, str, bool, type(None))


def _render(value: Any) -> Any:
    kind = type(value)
    if kind in _PLAIN:  # most nodes are coordinates: exact-type checks avoid the slow ABC isinstance calls
        return value
    if kind is dict:
        return {k: _render(v) for k, v in value.items()}
    if kind is list or kind is tuple:
        return [_render(v) for v in value]
    if kind is datetime:
        return iso(value)
    if isinstance(value, Mapping):
        return {k: _render(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_render(v) for v in value]
    if isinstance(value, datetime):
        return iso(value)
    return value


def render(value: Any, drop: Iterable[str] = ("_id",)) -> Any:
    """Documents to JSON: datetimes to ISO ``Z``, tuples to lists, ``drop`` keys removed at the top."""
    if isinstance(value, Mapping):
        drop = set(drop)
        return {k: _render(v) for k, v in value.items() if k not in drop}
    return _render(value)


def report_json(doc: Mapping[str, Any]) -> dict[str, Any]:
    body = render(doc, drop=("_id", "updated_at", "merged_into"))
    body.setdefault("replay_at", None)
    body.setdefault("method", "explicit")
    body.setdefault("speed_class", None)
    return body


def task_json(doc: Mapping[str, Any]) -> dict[str, Any]:
    body = render(doc, drop=("_id", "accepted_at", "answer", "closed_at", "place_id"))
    body.setdefault("assignee", None)
    body.setdefault("note", None)
    return body


def checkin_json(doc: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": doc["id"],
        "status": doc["status"],
        "zone_id": doc.get("zone_id"),
        "coord": doc.get("coord"),
        "at": iso(doc["at"]),
        "replay_at": iso(doc.get("replay_at")),
        "help": help_json(doc),
    }


def help_json(doc: Mapping[str, Any]) -> dict[str, Any] | None:
    """Where a need_help check-in stands with the controller; null for other statuses."""
    if doc["status"] != "need_help":
        return None
    help_ = doc.get("help") or {}
    return {
        "status": help_.get("status", "open"),
        "assignee": help_.get("assignee"),
        "task_id": help_.get("task_id"),
        "updated_at": iso(help_.get("updated_at")),
    }


def guidance_json(doc: Mapping[str, Any]) -> dict[str, Any]:
    body = render(doc, drop=("_id", "incident_id"))
    body.setdefault("caveat", None)
    body.setdefault("alternatives", [])
    return body


def proposal_json(doc: Mapping[str, Any]) -> dict[str, Any]:
    return render(doc, drop=("_id",))


def destination_json(index: DrillIndex, destination_id: str | None) -> dict[str, Any] | None:
    if destination_id is None:
        return None
    dest = index.destinations.get(destination_id)
    if dest is None:
        return None
    return {"id": dest.id, "name": dest.name, "kind": dest.kind, "coord": [dest.coord[0], dest.coord[1]]}


def route_json(route: Route | None, simplified: bool = False) -> dict[str, Any] | None:
    """``GuidanceRoute``; ``simplified`` for an alternative's line (see ALTERNATIVE_LINE_*)."""
    if route is None:
        return None
    if simplified:
        line = [[round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS)]
                for p in simplify_line(route.line, ALTERNATIVE_LINE_TOLERANCE_M, ALTERNATIVE_LINE_MAX_POINTS)]
    else:
        line = [[p[0], p[1]] for p in route.line]
    return {
        "line": line,
        "via": list(route.via),
        "distance_m": int(round(route.distance_m / ROUTE_DISTANCE_ROUND_M) * ROUTE_DISTANCE_ROUND_M),
        "eta_min": int(route.eta_min),
        "safety": route_safety(route),
    }


def alternative_json(index: DrillIndex, a: Alternative) -> dict[str, Any]:
    """``GuidanceAlternative``."""
    return {
        "destination": destination_json(index, a.destination_id),
        "route": route_json(a.route, simplified=True),
        "safety": a.safety,
        "load": a.load,
        "recommended": a.recommended,
    }


def proposed_json(index: DrillIndex, g: ZoneGuidance) -> dict[str, Any]:
    """``ProposedGuidance``: destination, route and caveat are null (alternatives empty) for
    level none and no_route."""
    moving = g.level != "none" and not g.no_route
    return {
        "level": g.level,
        "destination": destination_json(index, g.destination_id) if moving else None,
        "route": route_json(g.route) if moving else None,
        "no_route": bool(g.no_route),
        "reason": g.reason,
        "reason_code": g.reason_code,
        "caveat": g.caveat if moving else None,
        "alternatives": [alternative_json(index, a) for a in g.alternatives] if moving else [],
    }


def offered_destination_ids(doc: Mapping[str, Any]) -> list[str]:
    """Destinations a person in the zone may choose under published guidance ``doc``: its
    alternatives, or just its destination when there are none; [] when it says not to move."""
    if doc.get("level") == "none" or doc.get("no_route") or not doc.get("destination"):
        return []
    alts = doc.get("alternatives") or []
    if alts:
        return [a["destination"]["id"] for a in alts if a.get("destination")]
    return [doc["destination"]["id"]]


def fire_json(fire: FireEstimate) -> dict[str, Any]:
    return {
        "as_of": iso(fire.as_of),
        "method": fire.method,
        "label": fire.label,
        "geometry": to_geojson(fire.geometry) if fire.geometry is not None else None,
        "observations": [
            {"coord": [o.coord[0], o.coord[1]], "at": iso(o.at), "source": o.source} for o in fire.observations
        ],
        "evidence_class": fire.evidence_class,
    }


def road_ref_json(segment_id: str | None, name: str | None, snap_m: float | None = None) -> dict[str, Any] | None:
    if segment_id is None:
        return None
    return {"segment_id": segment_id, "name": name or "Unnamed road", "snap_m": snap_m}


def public_item_json(item: public.PublicItem, controller: bool = False) -> dict[str, Any]:
    body = {
        "id": item.id,
        "kind": item.kind,
        "severity": item.severity,
        "coord": [item.coord[0], item.coord[1]],
        "road_ref": road_ref_json(item.segment_id, item.segment_name),
        "line": [[p[0], p[1]] for p in item.line] if item.line else None,
        "independent_parties": item.independent_parties,
        "responder_reports": item.responder_reports,
        "controller_confirmed": item.controller_confirmed,
        "confidence": round(item.confidence, 2),
        "first_reported_at": iso(item.first_reported_at),
        "last_observed_at": iso(item.last_observed_at),
        "passive_parties": item.passive_parties,
    }
    if controller:
        body["report_ids"] = list(item.report_ids)
        body["destination_id"] = item.destination_id
    return body


def road_status_json(s: public.RoadStatus) -> dict[str, Any]:
    return {
        "segment_id": s.segment_id,
        "name": s.name,
        "status": s.status,
        "confidence": round(s.confidence, 2),
        "independent_parties": s.independent_parties,
        "responder_reports": s.responder_reports,
        "last_observed_at": iso(s.last_observed_at),
        "report_ids": list(s.report_ids),
        "decided_by": s.decided_by,
        "public": s.public,
        "passive_parties": s.passive_parties,
    }


# ---- drill clock ----


@dataclass(frozen=True)
class Clock:
    replay_start: datetime
    started_at: datetime | None
    speed: float
    replay_now: datetime
    running: bool


def drill_doc(incident_id: str) -> dict[str, Any] | None:
    return col("live_drills").find_one({"incident_id": incident_id})


def clock_from(doc: Mapping[str, Any] | None, index: DrillIndex, now: datetime) -> Clock:
    drill = index.drill
    replay_start = (doc or {}).get("replay_start") or drillmod.default_replay_start(drill)
    started_at = (doc or {}).get("started_at")
    speed = float((doc or {}).get("speed", 1))
    replay_now = drillmod.replay_now(replay_start, started_at, now, speed, drill.clock_end)
    running = started_at is not None and speed > 0 and replay_now < drill.clock_end
    return Clock(replay_start, started_at, speed, replay_now, running)


def drill_state_json(index: DrillIndex, clock: Clock) -> dict[str, Any]:
    drill = index.drill
    return {
        "incident_id": drill.incident_id,
        "label": drill.label,
        "replay_now": iso(clock.replay_now),
        "replay_start": iso(clock.replay_start),
        "started_at": iso(clock.started_at),
        "speed": clock.speed,
        "running": clock.running,
        "clock": {"start": iso(drill.clock_start), "end": iso(drill.clock_end)},
    }


def incident_json(index: DrillIndex) -> dict[str, Any]:
    drill = index.drill
    return {"id": drill.incident_id, "name": drill.name, "mode": drill.mode}


def drill_short_json(index: DrillIndex, clock: Clock) -> dict[str, Any]:
    return {
        "label": index.drill.label,
        "replay_now": iso(clock.replay_now),
        "speed": clock.speed,
        "running": clock.running,
    }


def report_replay_at(incident_id: str, now: datetime) -> datetime | None:
    """Drill time at ``now``, or None when no drill has been started."""
    doc = drill_doc(incident_id)
    if doc is None or doc.get("started_at") is None:
        return None
    return clock_from(doc, get_index(incident_id), now).replay_now


# ---- snapshot ----


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def report_fact(doc: Mapping[str, Any]) -> public.ReportFact:
    road_ref = doc.get("road_ref") or {}
    coord = doc["location"]["coord"]
    return public.ReportFact(
        id=doc["id"],
        kind=doc["kind"],
        severity=doc.get("severity"),
        coord=(float(coord[0]), float(coord[1])),
        party_key=doc["reporter"]["party_key"],
        role=doc["reporter"]["role"],
        observed_at=_aware(doc["observed_at"]),
        received_at=_aware(doc["received_at"]),
        status=doc["status"],
        segment_id=road_ref.get("segment_id"),
        segment_name=road_ref.get("name"),
        destination_id=doc.get("destination_id"),
        replay_at=_aware(doc.get("replay_at")),
        method="passive" if doc.get("method") == "passive" else "explicit",
    )


@dataclass
class Snapshot:
    incident_id: str
    index: DrillIndex
    now: datetime
    drill_doc: dict[str, Any] | None
    clock: Clock
    report_docs: list[dict[str, Any]]
    facts: list[public.ReportFact]
    items: list[public.PublicItem]
    road_state: list[public.RoadStatus]
    blocked: frozenset[str]
    full_destinations: frozenset[str]
    fire: FireEstimate
    injects: list[dict[str, Any]] = field(default_factory=list)
    """Drill injects (``injects.apply_due``), any status; ``twin_service`` applies the due ones."""


def load_public(
    incident_id: str, now: datetime, index: DrillIndex
) -> tuple[list[dict[str, Any]], list[public.ReportFact], list[public.PublicItem], list[public.RoadStatus]]:
    """Reports (newest first), their facts, public items and road state at wall time ``now``."""
    # Source-diversity check (ADR 0042), off unless LIVE_SOURCE_DIVERSITY is true.
    public.SOURCE_DIVERSITY_ENABLED = bool(getattr(settings, "LIVE_SOURCE_DIVERSITY", False))
    report_docs = list(
        col("live_reports").find({"incident_id": incident_id}).sort("received_at", -1).limit(REPORTS_SNAPSHOT_LIMIT)
    )
    # 2018 record entries and generated comms items wait in the controller's queue: they count for nothing
    # until confirmed (groundrecord.queue_only).
    facts = [
        report_fact(d) for d in report_docs
        if not (d.get("evidence_class") == "historical_record" or d.get("comms"))
        or d["status"] in ("confirmed", "resolved")
    ]
    items = public.public_items(facts, now, index.segment_lines)
    state = public.road_state(facts, now)
    return report_docs, facts, items, state


def load_snapshot(incident_id: str, now: datetime) -> Snapshot:
    index = get_index(incident_id)
    doc = drill_doc(incident_id)
    clock = clock_from(doc, index, now)
    from . import injects as injects_mod  # local: injects reads clock_from and drill_doc from this module

    injects = injects_mod.apply_due(index, incident_id, clock.replay_now, now)
    if clock.replay_now is not None:
        from .groundrecord import materialize_due  # local: groundrecord imports this module's dependencies

        materialize_due(index, incident_id, clock, now, injects)
    report_docs, facts, items, state = load_public(incident_id, now, index)
    fire = estimate_fire(index.drill, clock.replay_now, public.confirmed_fire_points(facts, items),
                         injects_mod.rules.spots_due(injects, clock.replay_now))
    return Snapshot(
        incident_id=incident_id,
        index=index,
        now=now,
        drill_doc=doc,
        clock=clock,
        report_docs=report_docs,
        facts=facts,
        items=items,
        road_state=state,
        blocked=frozenset(public.guidance_blocked_segments(state)),
        full_destinations=frozenset(public.full_destination_ids(items)),
        fire=fire,
        injects=injects,
    )


def current_guidance(incident_id: str, index: DrillIndex | None = None) -> list[dict[str, Any]]:
    """Latest published version per zone, in drill zone order when the index is given."""
    rows = col("live_guidance").aggregate(
        [
            {"$match": {"incident_id": incident_id}},
            {"$sort": {"zone_id": 1, "version": -1}},
            {"$group": {"_id": "$zone_id", "doc": {"$first": "$$ROOT"}}},
        ]
    )
    docs = [row["doc"] for row in rows]
    if index is not None:
        order = {z.id: i for i, z in enumerate(index.drill.zones)}
        docs.sort(key=lambda d: order.get(d["zone_id"], len(order)))
    return docs


_guidance_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_guidance_lock = Lock()


def rendered_guidance(incident_id: str, index: DrillIndex) -> list[dict[str, Any]]:
    """``[guidance_json(g) ...]`` for the current guidance, cached per process for a short TTL.

    Every phone polls the same guidance (about 100 KB of routes) every 3 s, and rebuilding it per
    request was the largest single cost of ``situation`` (docs/live-loadtest.md). Writers in this
    process call ``invalidate_guidance``; other processes see a change within
    ``LIVE_GUIDANCE_CACHE_TTL_S`` (default 1 s; 0 turns the cache off). Callers must not mutate it.
    """
    ttl = float(getattr(settings, "LIVE_GUIDANCE_CACHE_TTL_S", 1.0))
    if ttl <= 0:
        return [guidance_json(g) for g in current_guidance(incident_id, index)]
    now = time.monotonic()
    with _guidance_lock:
        hit = _guidance_cache.get(incident_id)
    if hit is not None and hit[0] > now:
        return hit[1]
    rendered = [guidance_json(g) for g in current_guidance(incident_id, index)]
    with _guidance_lock:
        _guidance_cache[incident_id] = (now + ttl, rendered)
    return rendered


def invalidate_guidance(incident_id: str | None = None) -> None:
    """Drop the cached guidance after a write to ``live_guidance`` (publish, annotate, reset)."""
    with _guidance_lock:
        if incident_id is None:
            _guidance_cache.clear()
        else:
            _guidance_cache.pop(incident_id, None)


def destination_preferences(incident_id: str, now: datetime) -> list[dict[str, Any]]:
    """Live civilian destination choices per zone: ``[{zone_id, destination_id, count}]``, sorted.

    Counts only unexpired choices (the TTL monitor deletes expired ones up to a minute late)."""
    rows = col("live_destination_choices").aggregate(
        [
            {"$match": {"incident_id": incident_id, "expires_at": {"$gt": now}}},
            {"$group": {"_id": {"zone_id": "$zone_id", "destination_id": "$destination_id"}, "count": {"$sum": 1}}},
        ]
    )
    out = [
        {"zone_id": r["_id"]["zone_id"], "destination_id": r["_id"]["destination_id"], "count": int(r["count"])}
        for r in rows
    ]
    out.sort(key=lambda r: (r["zone_id"], -r["count"], r["destination_id"]))
    return out


def responder_tasks(incident_id: str, party_key: str) -> list[dict[str, Any]]:
    """Tasks assigned to the caller (open or accepted) plus open unassigned ones."""
    cursor = col("live_tasks").find(
        {
            "incident_id": incident_id,
            "$or": [
                {"assignee": party_key, "status": {"$in": ["open", "accepted"]}},
                {"assignee": None, "status": "open"},
            ],
            "created_by": {"$ne": "priority"},  # board questions are not dispatched tasks (ADR 0041)
        }
    ).sort("created_at", -1).limit(200)
    return list(cursor)
