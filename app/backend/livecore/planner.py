"""Deterministic per-zone guidance (ADR 0012). The LLM never touches these values.

Contract: docs/live-reports.md "Zones and guidance" and "Planner rules".
"""

from __future__ import annotations

import dataclasses
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from .drill import Drill
from .fire import FireEstimate
from .geo import LonLat, MultiPolygon, distance_km, haversine_m, polyline_distance_m
from .public import ReportFact, RoadStatus, effective_at
from .routing import (
    DESTINATION_KINDS,
    FIRE_BUFFER_M,
    Exposure,
    Incumbent,
    Route,
    alternative_routes,
    best_routes,
    destination_node,
    weighted_time_s,
)

EVACUATE_NOW_KM = 3.0
"""Zone within this distance of the fire estimate -> ``evacuate_now``."""
BE_READY_KM = 8.0
"""Zone within this distance (and beyond EVACUATE_NOW_KM) -> ``be_ready``."""
PLANNER_VERSION = "planner-v4"
"""Recorded in proposal ``inputs.planner_version``; bump when the rules change."""
THROUGH_FIRE_CAVEAT = "Every route out passes through the fire"
"""``caveat`` when no route to any usable destination avoids the fire estimate itself."""
NEAR_FIRE_CAVEAT = "Every route out passes near the fire"
"""``caveat`` when every route enters the fire estimate's buffer but one stays outside it."""
EXPOSED_REASON = "Least-exposure route; every route out passes through the fire"
"""Reason for a zone whose least-exposure route passes through the fire estimate."""
EXPOSED_NEAR_REASON = "Least-exposure route; every route out passes near the fire"
"""Reason for a zone whose least-exposure route stays outside the fire estimate but within its buffer."""
RESPONDER_FRESH_S = 900
"""Responder positions older than this (wall seconds) are not used to suggest an assignee."""

ALTERNATIVES_MAX = 3
"""Destinations offered per zone besides the recommended one (D1)."""
ALTERNATIVE_MIN_SEPARATION_M = 1500.0
"""An alternative's destination must be at least this far from the recommended one and from every
alternative already offered, so the list is not four exits at the same junction."""
ALTERNATIVE_MAX_EXTRA_FIRE_S = 60.0
"""An alternative may spend at most this many free-flow seconds more inside the fire estimate
than the recommended route (relevant only when every option passes the fire)."""
LOAD_EXIT_WINDOW_H = 1.0
"""An exit's capacity for ``load``: the hourly capacity of the road edges entering its node times
this window. A shelter or refuge uses its bundle ``capacity_veh``; null when unknown."""
PREFERENCE_VEH_PER_CHOICE = 1.0
"""Soft load input: each live civilian destination choice adds this many vehicles to that
destination's load (on top of the ``evacuate_now`` zones the plan sends there)."""
LOAD_RANK_WEIGHT = 1.0
"""Alternatives are ranked by search cost x (1 + LOAD_RANK_WEIGHT x load); unknown load counts as 0.
Load never changes the recommended destination."""

GuidanceLevel = Literal["evacuate_now", "be_ready", "none"]
ReasonCode = Literal["fire_within_evacuate_km", "fire_within_ready_km", "no_open_route", "clear"]
RouteSafety = Literal["clear", "passes_near_fire", "passes_fire"]
SAFETY_BY_EXPOSURE: dict[Exposure, RouteSafety] = {
    "clear": "clear", "near_fire": "passes_near_fire", "through_fire": "passes_fire"}
_SAFETY_RANK: dict[Exposure, int] = {"clear": 0, "near_fire": 1, "through_fire": 2}


def route_safety(route: Route) -> RouteSafety:
    """``clear``, ``passes_near_fire`` (FIRE_BUFFER_M buffer only) or ``passes_fire``."""
    return SAFETY_BY_EXPOSURE[route.exposure]


def line_safety(line: Sequence[LonLat], fire_geometry: MultiPolygon | None) -> RouteSafety:
    """The same classes for a stored route line (published guidance has no edge ids): any point
    inside or a segment crossing the fire -> ``passes_fire``; within FIRE_BUFFER_M -> ``passes_near_fire``."""
    if fire_geometry is None or not line:
        return "clear"
    d = polyline_distance_m(line, fire_geometry, FIRE_BUFFER_M)
    return "passes_fire" if d == 0.0 else "passes_near_fire" if d <= FIRE_BUFFER_M else "clear"


@dataclass(frozen=True)
class Alternative:
    """One destination a person in the zone may choose (D1). The first is the planner's pick."""

    destination_id: str
    route: Route
    load: float | None
    """0..1 share of the destination's capacity already heading there; None when unknown."""
    recommended: bool

    @property
    def safety(self) -> RouteSafety:
        return route_safety(self.route)


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
    caveat: str | None = None
    """Headline warning for clients: THROUGH_FIRE_CAVEAT or NEAR_FIRE_CAVEAT on an exposed
    route, else None. Follows ``route`` (set from it when a route is swapped in)."""
    alternatives: tuple[Alternative, ...] = ()
    """Recommended (this route) first, then up to ALTERNATIVES_MAX others; () when there is no
    choice. Set by ``with_alternatives``; cleared when a different route is swapped in."""

    def __post_init__(self) -> None:
        if self.route is not None and self.route.exposed and not self.exposed:
            object.__setattr__(self, "exposed", True)
        if self.route is not None:
            object.__setattr__(self, "caveat", caveat_for(self.route))
        if self.alternatives and (self.route is None or self.alternatives[0].route != self.route):
            object.__setattr__(self, "alternatives", ())

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


def caveat_for(route: Route | None) -> str | None:
    """THROUGH_FIRE_CAVEAT, NEAR_FIRE_CAVEAT or None for a clear (or no) route."""
    if route is None or not route.exposed:
        return None
    return THROUGH_FIRE_CAVEAT if route.passes_fire else NEAR_FIRE_CAVEAT


def _km(value: float) -> str:
    return f"{value:g}"


def plan(
    drill: Drill,
    replay_now: datetime,
    fire: FireEstimate,
    blocked_segment_ids: Collection[str],
    full_destination_ids: Collection[str] = (),
    congestion: Mapping[str, float] | None = None,
    incumbents: Mapping[str, Incumbent] | None = None,
) -> list[ZoneGuidance]:
    """Guidance for every zone, in ``drill.zones`` order.

    Level from ``level_for_distance(distance_km(zone, fire.geometry))``; routes from
    ``best_routes(drill, blocked_segment_ids, fire.geometry, full_destination_ids)`` for
    zones whose level is not ``none``. A least-exposure route sets ``exposed``, the reason
    EXPOSED_REASON and the caveat THROUGH_FIRE_CAVEAT (EXPOSED_NEAR_REASON and NEAR_FIRE_CAVEAT
    when it only enters the buffer); ``no_route`` only when even that pass finds nothing.
    ``replay_now`` is recorded by callers; the plan uses only ``fire`` for time-dependent input.

    ``congestion`` (directed edge id -> simulated travel-time factor) and ``incumbents`` (zone
    id -> the route it follows now) go to ``best_routes``: route search costs include simulated
    queues, and a zone keeps its incumbent unless the new route saves ``routing.switch_margin_s``.
    Deterministic for given arguments.
    """
    geometry = fire.geometry
    distances: dict[str, float | None] = {
        z.id: (distance_km(z.geometry, geometry) if geometry is not None else None) for z in drill.zones
    }
    levels = {zid: level_for_distance(d) for zid, d in distances.items()}
    routes = (
        best_routes(drill, blocked_segment_ids, geometry, full_destination_ids,
                    congestion=congestion, incumbents=incumbents)
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


def destination_loads(
    drill: Drill,
    guidance: Sequence[ZoneGuidance],
    preferences: Mapping[str, int] = {},
) -> dict[str, float | None]:
    """Destination id -> 0..1 load, None when its capacity is unknown.

    Heading there: the vehicles of every ``evacuate_now`` zone the plan sends there, plus
    PREFERENCE_VEH_PER_CHOICE per live civilian choice (``preferences``: destination id -> count).
    Capacity: ``capacity_veh`` when the bundle has it; for an exit without it, the hourly capacity
    of the road edges entering its node times LOAD_EXIT_WINDOW_H. Clamped to 1.
    """
    vehicles = {z.id: z.vehicles for z in drill.zones}
    heading: dict[str, float] = {}
    for g in guidance:
        if g.level == "evacuate_now" and not g.no_route and g.destination_id is not None:
            heading[g.destination_id] = heading.get(g.destination_id, 0.0) + vehicles.get(g.zone_id, 0)
    for did, n in preferences.items():
        heading[did] = heading.get(did, 0.0) + PREFERENCE_VEH_PER_CHOICE * max(0, n)
    roads = drill.roads
    out: dict[str, float | None] = {}
    for dest in drill.destinations:
        capacity: float | None = float(dest.capacity_veh) if dest.capacity_veh else None
        if capacity is None and dest.kind == "exit":
            node = destination_node(drill, dest.id)
            if node is not None:
                hourly = sum(roads.edges[e].capacity_veh_per_hour for e in roads.in_edges.get(node, ()))
                capacity = hourly * LOAD_EXIT_WINDOW_H if hourly > 0 else None
        out[dest.id] = None if capacity is None else round(min(1.0, heading.get(dest.id, 0.0) / capacity), 2)
    return out


def with_alternatives(
    drill: Drill,
    guidance: Sequence[ZoneGuidance],
    blocked_segment_ids: Collection[str],
    fire_geometry: MultiPolygon | None,
    full_destination_ids: Collection[str] = (),
    preferences: Mapping[tuple[str, str], int] = {},
    congestion: Mapping[str, float] | None = None,
) -> list[ZoneGuidance]:
    """``guidance`` with ``alternatives`` set on every zone that moves along a route.

    The recommended entry is the zone's route as chosen (by the planner or a controller). The
    others come from ``routing.alternative_routes`` (same router, blocked edges and usable
    destinations; never inside the fire estimate, refuges outside it plus REFUGE_FIRE_BUFFER_M;
    never a worse exposure class than the recommended route), ranked by exposure class, then
    exits and shelters before refuges, then search cost x (1 + LOAD_RANK_WEIGHT x load); each at
    least ALTERNATIVE_MIN_SEPARATION_M from those already offered and at most
    ALTERNATIVE_MAX_EXTRA_FIRE_S more inside the fire than the recommended route. An alternative
    whose named roads (``via``) match one already offered is skipped: to the person it is the
    same way out.
    ``preferences`` ((zone id, destination id) -> live choices) only feeds ``load``.
    ``congestion`` (simulated factors, as in ``plan``) weights the alternatives' search.
    """
    picks = {g.zone_id: g.route for g in guidance if g.level != "none" and not g.no_route and g.route is not None}
    if not picks:
        return list(guidance)
    per_destination: dict[str, int] = {}
    for (_, did), n in preferences.items():
        per_destination[did] = per_destination.get(did, 0) + n
    loads = destination_loads(drill, guidance, per_destination)
    candidates = alternative_routes(drill, picks, blocked_segment_ids, fire_geometry, full_destination_ids,
                                    congestion=congestion)
    dests = {d.id: d for d in drill.destinations}

    def rank(r: Route) -> tuple[int, int, float, str]:
        kind_rank = 0 if dests[r.destination_id].kind in DESTINATION_KINDS else 1
        return (_SAFETY_RANK[r.exposure], kind_rank,
                weighted_time_s(r) * (1.0 + LOAD_RANK_WEIGHT * (loads.get(r.destination_id) or 0.0)), r.destination_id)

    out: list[ZoneGuidance] = []
    for g in guidance:
        pick = picks.get(g.zone_id)
        if pick is None:
            out.append(g)
            continue
        chosen = [Alternative(pick.destination_id, pick, loads.get(pick.destination_id), True)]
        for r in sorted(candidates.get(g.zone_id, ()), key=rank):
            if len(chosen) > ALTERNATIVES_MAX:
                break
            if (_SAFETY_RANK[r.exposure] > _SAFETY_RANK[pick.exposure]
                    or r.fire_time_s > pick.fire_time_s + ALTERNATIVE_MAX_EXTRA_FIRE_S
                    or any(haversine_m(dests[r.destination_id].coord, dests[c.destination_id].coord)
                           < ALTERNATIVE_MIN_SEPARATION_M for c in chosen)
                    or any(r.via == c.route.via for c in chosen)):
                continue
            chosen.append(Alternative(r.destination_id, r, loads.get(r.destination_id), False))
        out.append(dataclasses.replace(g, alternatives=tuple(chosen) if len(chosen) > 1 else ()))
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
