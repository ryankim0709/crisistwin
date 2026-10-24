"""Deterministic per-zone guidance (ADR 0012). The LLM never touches these values.

Contract: docs/live-reports.md "Zones and guidance" and "Planner rules".
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from .drill import Drill
from .fire import FireEstimate
from .geo import LonLat, distance_km, haversine_m
from .public import ReportFact, RoadStatus, effective_at
from .routing import Route, best_routes

EVACUATE_NOW_KM = 3.0
"""Zone within this distance of the fire estimate -> ``evacuate_now``."""
BE_READY_KM = 8.0
"""Zone within this distance (and beyond EVACUATE_NOW_KM) -> ``be_ready``."""
PLANNER_VERSION = "planner-v2"
"""Recorded in proposal ``inputs.planner_version``; bump when the rules change."""
EXPOSED_REASON = "Least-exposure route; passes the fire estimate"
"""Reason for a zone whose only route has a road inside or crossing the fire estimate."""
EXPOSED_NEAR_REASON = "Least-exposure route; passes near the fire estimate"
"""Reason for a zone whose only route stays outside the fire estimate but within its buffer."""
RESPONDER_FRESH_S = 900
"""Responder positions older than this (wall seconds) are not used to suggest an assignee."""

GuidanceLevel = Literal["evacuate_now", "be_ready", "none"]
ReasonCode = Literal["fire_within_evacuate_km", "fire_within_ready_km", "no_open_route", "clear"]


@dataclass(frozen=True)
class ZoneGuidance:
    """Planner output for one zone. Published guidance adds version/published_at/approved_by."""

    zone_id: str
    level: GuidanceLevel
    destination_id: str | None
    """None when level is ``none`` or ``no_route``."""
    route: Route | None
    no_route: bool
    """True when the level needs a move but no open route exists."""
    reason: str
    """Short deterministic text, e.g. ``"Fire estimate within 3 km"``."""
    reason_code: ReasonCode
    fire_distance_km: float | None
    """Zone-to-fire distance used for the level; None without a fire estimate."""
    exposed: bool = False
    """The route is a least-exposure route through the fire estimate or its buffer; a
    controller must approve it. Never cleared by swapping in another route."""

    def __post_init__(self) -> None:
        if self.route is not None and self.route.exposed and not self.exposed:
            object.__setattr__(self, "exposed", True)

    @property
    def via(self) -> tuple[str, ...]:
        return self.route.via if self.route else ()


@dataclass(frozen=True)
class ResponderPosition:
    party_key: str
    coord: LonLat
    at: datetime
    """Wall time of the fix."""


@dataclass(frozen=True)
class TaskSuggestion:
    """A verify task the controller may approve with a proposal."""

    segment_id: str | None
    coord: LonLat
    reason: str
    report_ids: tuple[str, ...]
    assignee: str | None
    """Nearest fresh responder ``party_key``, or None for any responder."""


def level_for_distance(distance_km: float | None) -> GuidanceLevel:
    """``evacuate_now`` <= EVACUATE_NOW_KM < ``be_ready`` <= BE_READY_KM < ``none``; None -> ``none``."""
    if distance_km is None:
        return "none"
    if distance_km <= EVACUATE_NOW_KM:
        return "evacuate_now"
    if distance_km <= BE_READY_KM:
        return "be_ready"
    return "none"


def _km(value: float) -> str:
    return f"{value:g}"


def plan(
    drill: Drill,
    replay_now: datetime,
    fire: FireEstimate,
    blocked_segment_ids: Collection[str],
    full_destination_ids: Collection[str] = (),
) -> list[ZoneGuidance]:
    """Guidance for every zone, in ``drill.zones`` order.

    Level from ``level_for_distance(distance_km(zone, fire.geometry))``; routes from
    ``best_routes(drill, blocked_segment_ids, fire.geometry, full_destination_ids)`` for
    zones whose level is not ``none``. A least-exposure route sets ``exposed`` and the reason
    EXPOSED_REASON (EXPOSED_NEAR_REASON when it only enters the buffer); ``no_route`` only
    when even that pass finds nothing. ``replay_now`` is recorded by callers; the plan uses
    only ``fire`` for time-dependent input.
    """
    geometry = fire.geometry
    distances: dict[str, float | None] = {
        z.id: (distance_km(z.geometry, geometry) if geometry is not None else None) for z in drill.zones
    }
    levels = {zid: level_for_distance(d) for zid, d in distances.items()}
    routes = (
        best_routes(drill, blocked_segment_ids, geometry, full_destination_ids)
        if any(level != "none" for level in levels.values()) else {}
    )
    out: list[ZoneGuidance] = []
    for zone in drill.zones:
        dist = distances[zone.id]
        level = levels[zone.id]
        if level == "none":
            reason = "No fire estimate" if dist is None else f"Fire estimate more than {_km(BE_READY_KM)} km away"
            out.append(ZoneGuidance(zone.id, "none", None, None, False, reason, "clear", dist))
            continue
        route = routes.get(zone.id)
        if route is None:
            out.append(ZoneGuidance(zone.id, level, None, None, True, "No open route out", "no_open_route", dist))
            continue
        if level == "evacuate_now":
            reason, code = f"Fire estimate within {_km(EVACUATE_NOW_KM)} km", "fire_within_evacuate_km"
        else:
            reason, code = f"Fire estimate within {_km(BE_READY_KM)} km", "fire_within_ready_km"
        if route.exposed:
            reason = EXPOSED_REASON if route.passes_fire else EXPOSED_NEAR_REASON
        out.append(ZoneGuidance(zone.id, level, route.destination_id, route, False, reason, code, dist,
                                exposed=route.exposed))
    return out


def suggest_tasks(
    guidance: Sequence[ZoneGuidance],
    reports: Sequence[ReportFact],
    road_state: Sequence[RoadStatus],
    responders: Sequence[ResponderPosition],
    wall_now: datetime,
) -> list[TaskSuggestion]:
    """Verify tasks for not-yet-public ``road_blocked`` reports on segments used by a route.

    One suggestion per segment; ``assignee`` is the nearest responder seen within
    ``RESPONDER_FRESH_S`` of ``wall_now``.
    """
    used: dict[str, None] = {}
    for g in guidance:
        if g.route is not None:
            for seg in g.route.segment_ids:
                used.setdefault(seg, None)
    public_blocked = {r.segment_id for r in road_state if r.status == "blocked" and r.public}
    by_segment: dict[str, list[ReportFact]] = {}
    for r in reports:
        if (r.kind == "road_blocked" and r.segment_id in used and r.segment_id not in public_blocked
                and r.status not in ("dismissed", "resolved", "confirmed")):
            by_segment.setdefault(r.segment_id, []).append(r)
    fresh = [
        p for p in responders
        if 0 <= (wall_now - p.at).total_seconds() <= RESPONDER_FRESH_S
    ]
    out: list[TaskSuggestion] = []
    for seg in used:  # route order, deterministic
        group = by_segment.get(seg)
        if not group:
            continue
        group.sort(key=lambda r: (effective_at(r), r.id))
        coord = group[-1].coord
        name = next((r.segment_name for r in group if r.segment_name), None) or "an unnamed road"
        n = len(group)
        reason = f"{'One' if n == 1 else n} unverified road_blocked report{'s' if n != 1 else ''} on {name}"
        assignee = None
        if fresh:
            assignee = min(fresh, key=lambda p: (haversine_m(p.coord, coord), p.party_key)).party_key
        out.append(TaskSuggestion(seg, coord, reason, tuple(r.id for r in group), assignee))
    return out
