"""Impact analysis of one road segment: blocked vs unblocked (docs/live-reports.md "Impact analysis").

Two deterministic planner runs (``livecore.planner.plan``) differ only in whether the segment
is blocked. For each zone the side that holds now is the published route (what people follow),
the other side is the planner's route in the toggled state; zones whose route uses the segment
or changes are the affected zones, with their free-flow ETA delta.
One twin what-if (``twin_service``) toggles the same segment in the synced traffic twin and
reports simulated window metrics for both states, plus the vehicles of the affected zones that
have not arrived yet. Nothing is stored or published; the controller decides what to do with it.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

from livecore.geo import haversine_m
from livecore.planner import PLANNER_VERSION, ZoneGuidance, plan
from livecore.twinplan import metrics_summary

from . import twin_service
from .common import ApiError, iso
from .state import Snapshot, current_guidance, destination_json, route_json

log = logging.getLogger(__name__)

IMPACT_HORIZON_MIN = 60
"""Default twin what-if horizon (simulated minutes)."""
IMPACT_FIRE_AHEAD = "frozen"
"""The fire is held at the decision time, as in the twin controller's what-ifs."""
IMPACT_ACTOR = {"kind": "controller", "id": "impact-analysis"}
EXPOSED_PREFIX = "Least-exposure route"
"""Planner reasons for a route through or near the fire estimate start with this."""


ON_ROUTE_M = 30.0
"""A published route uses the segment when two of its quarter points lie this close to the route line."""
M_PER_DEG_LAT = 111_320.0


def _exposed_reason(reason: str | None) -> bool:
    return bool(reason) and reason.startswith(EXPOSED_PREFIX)


def _planner_option(snapshot: Snapshot, g: ZoneGuidance) -> dict[str, Any] | None:
    """The planner's route for a zone in one state; None when it has no route (or no order)."""
    if g.level == "none" or g.no_route or g.route is None:
        return None
    return {
        "destination": destination_json(snapshot.index, g.destination_id),
        "route": route_json(g.route),
        "exposed": bool(getattr(g, "exposed", False)) or _exposed_reason(g.reason),
        "_segments": frozenset(g.route.segment_ids),
    }


def _published_option(doc: dict[str, Any]) -> dict[str, Any] | None:
    """The route people follow now (published guidance), in the same shape."""
    if doc.get("level") == "none" or doc.get("no_route") or not doc.get("route") or not doc.get("destination"):
        return None
    return {"destination": doc["destination"], "route": doc["route"], "exposed": _exposed_reason(doc.get("reason"))}


def _distance_to_line_m(p: tuple[float, float], line: list) -> float:
    k = math.cos(math.radians(p[1])) * M_PER_DEG_LAT
    best = math.inf
    for a, b in zip(line, line[1:]):
        ax, ay = (a[0] - p[0]) * k, (a[1] - p[1]) * M_PER_DEG_LAT
        bx, by = (b[0] - p[0]) * k, (b[1] - p[1]) * M_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        t = 0.0 if len2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / len2))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def _along(line: tuple, fraction: float) -> tuple[float, float]:
    lengths = [haversine_m(a, b) for a, b in zip(line, line[1:])]
    target = sum(lengths) * fraction
    for (a, b), length in zip(zip(line, line[1:]), lengths):
        if target <= length:
            t = 0.0 if length == 0 else target / length
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        target -= length
    return line[-1]


def _uses(option: dict[str, Any] | None, segment_id: str, segment_line: tuple) -> bool:
    if option is None:
        return False
    if "_segments" in option:
        return segment_id in option["_segments"]
    line = option["route"]["line"]
    if len(line) < 2 or len(segment_line) < 2:
        return False
    near = sum(1 for f in (0.25, 0.5, 0.75) if _distance_to_line_m(_along(segment_line, f), line) <= ON_ROUTE_M)
    return near >= 2


def _change(open_o: dict[str, Any] | None, blocked_o: dict[str, Any] | None) -> str:
    """unchanged | slower | rerouted | route_lost | exposed (blocked state relative to unblocked)."""
    if open_o is None:
        return "unchanged" if blocked_o is None else "rerouted"
    if blocked_o is None:
        return "route_lost"
    if blocked_o["exposed"] and not open_o["exposed"]:
        return "exposed"
    if (blocked_o["destination"] or {}).get("id") != (open_o["destination"] or {}).get("id") or \
            blocked_o["route"]["via"] != open_o["route"]["via"]:
        return "rerouted"
    if blocked_o["route"]["eta_min"] > open_o["route"]["eta_min"]:
        return "slower"
    if blocked_o["route"]["eta_min"] != open_o["route"]["eta_min"] or blocked_o["route"]["line"] != open_o["route"]["line"]:
        return "rerouted"
    return "unchanged"


def _public(option: dict[str, Any] | None) -> dict[str, Any] | None:
    return None if option is None else {k: v for k, v in option.items() if not k.startswith("_")}


def _twin_part(snapshot: Snapshot, segment_id: str, closed_now: bool,
               horizon_min: float) -> tuple[dict[str, Any] | None, dict[str, int] | None, str | None]:
    """(twin evidence, zone remaining vehicles, fallback reason)."""
    if not twin_service.ensure_ready():
        return None, None, "twin_warming"
    edge_ids = list(snapshot.index.drill.roads.segment_edges.get(segment_id, ()))
    if not edge_ids:
        return None, None, "twin_no_edges"
    if closed_now:
        action = {"type": "reopen_road", "target": {"edge_ids": edge_ids}, "params": {},
                  "actor": dict(IMPACT_ACTOR), "rationale": "Impact analysis: unblocked"}
        label = "Unblocked"
    else:
        action = {"type": "close_road", "target": {"edge_ids": edge_ids}, "params": {"mode": "hard"},
                  "actor": dict(IMPACT_ACTOR), "rationale": "Impact analysis: blocked"}
        label = "Blocked"
    try:
        report, remaining = twin_service.whatif_with_zones(snapshot, [[action]], horizon_min, IMPACT_FIRE_AHEAD,
                                                           [label])
    except twin_service.TwinUnavailable as exc:
        return None, None, f"twin_{exc.code}"
    except Exception as exc:  # noqa: BLE001 - the planner part stands without the twin; logged and labeled
        if twin_service.is_twin_error(exc):
            return None, None, f"twin_error:{getattr(exc, 'code', 'unknown')}"
        log.exception("live impact: twin what-if failed")
        return None, None, "twin_failed"
    baseline, alt = report["results"][0], report["results"][1]
    if not alt["valid"]:
        code = (alt.get("errors") or [{}])[0].get("code") or "invalid"
        return None, remaining, f"twin_error:{code}"
    blocked_m, open_m = (baseline["metrics"], alt["metrics"]) if closed_now else (alt["metrics"], baseline["metrics"])
    blocked_s, open_s = metrics_summary(blocked_m), metrics_summary(open_m)
    twin = {
        "evidence_class": "simulated",
        "from": report["from"],
        "until": report["until"],
        "horizon_min": report["horizon_min"],
        "fire_ahead": report["fire_ahead"],
        "seed": report["seed"],
        "blocked": blocked_s,
        "unblocked": open_s,
        "delta": {k: round(blocked_s[k] - open_s[k], 1) for k in blocked_s},
        "limitations": report["limitations"],
    }
    return twin, remaining, None


def analyze(snapshot: Snapshot, segment_id: str, report_ids: list[str], horizon_min: float) -> dict[str, Any]:
    """The impact of ``segment_id`` being blocked vs unblocked, at the snapshot's drill time."""
    index = snapshot.index
    if segment_id not in index.segment_lines:
        raise ApiError(400, "invalid_impact", "Unknown `segment_id`.")
    t0 = time.perf_counter()
    drill = index.drill
    closed_now = segment_id in twin_service.twin_closed_segments(snapshot)
    blocked_set = snapshot.blocked | {segment_id}
    open_set = snapshot.blocked - {segment_id}
    replay_now = snapshot.clock.replay_now
    blocked_plan = {g.zone_id: g for g in plan(drill, replay_now, snapshot.fire, blocked_set,
                                                 snapshot.full_destinations)}
    open_plan = {g.zone_id: g for g in plan(drill, replay_now, snapshot.fire, open_set,
                                              snapshot.full_destinations)}
    twin, remaining, fallback = _twin_part(snapshot, segment_id, closed_now, horizon_min)

    published = {d["zone_id"]: d for d in current_guidance(snapshot.incident_id, index)}
    segment_line = index.segment_lines[segment_id]
    zones = []
    for zone in drill.zones:
        o_plan, b_plan = open_plan[zone.id], blocked_plan[zone.id]
        doc = published.get(zone.id)
        level = doc["level"] if doc else o_plan.level
        if level == "none" and o_plan.level == "none":
            continue
        open_o, blocked_o = _planner_option(snapshot, o_plan), _planner_option(snapshot, b_plan)
        # The side that holds now is the route people follow: the published one. When the
        # segment is closed but the published route still crosses it (a reroute waiting for
        # approval), that route is what reopening restores, so it is the unblocked side.
        current = _published_option(doc) if doc else None
        if current is not None:
            if not closed_now or _uses(current, segment_id, segment_line):
                open_o = current
            else:
                blocked_o = current
        uses = _uses(open_o, segment_id, segment_line)
        change = _change(open_o, blocked_o)
        if not uses and change == "unchanged":
            continue
        delta = (blocked_o["route"]["eta_min"] - open_o["route"]["eta_min"]) if open_o and blocked_o else None
        zones.append({
            "zone_id": zone.id,
            "name": zone.name,
            "level": level if level != "none" else o_plan.level,
            "households": zone.households,
            "vehicles": zone.vehicles,
            "vehicles_remaining": remaining.get(zone.id) if remaining is not None else None,
            "change": change,
            "eta_delta_min": delta,
            "unblocked": _public(open_o),
            "blocked": _public(blocked_o),
        })
    zones.sort(key=lambda z: (z["change"] != "route_lost", -(z["eta_delta_min"] or 0), -z["vehicles"], z["zone_id"]))
    deltas = [z["eta_delta_min"] for z in zones if z["eta_delta_min"] is not None]
    if remaining is not None:
        at_risk, source = sum(z["vehicles_remaining"] or 0 for z in zones), "twin"
    else:
        at_risk, source = sum(z["vehicles"] for z in zones), "bundle"
    line = segment_line
    return {
        "incident_id": snapshot.incident_id,
        "generated_at": iso(snapshot.now),
        "replay_at": iso(replay_now),
        "target": {
            "segment_id": segment_id,
            "name": index.segment_names.get(segment_id) or "Unnamed road",
            "line": [[p[0], p[1]] for p in line],
            "coord": [line[len(line) // 2][0], line[len(line) // 2][1]],
            "state": "blocked" if closed_now else "open",
            "report_ids": report_ids,
        },
        "planner_version": PLANNER_VERSION,
        "summary": {
            "affected_zones": len(zones),
            "eta_delta_min": max(deltas) if deltas else None,
            "zones_losing_route": sum(1 for z in zones if z["change"] == "route_lost"),
            "zones_exposed": sum(1 for z in zones if z["change"] == "exposed"),
            "vehicles_at_risk": at_risk,
            "vehicles_at_risk_source": source,
        },
        "zones": zones,
        "twin": twin,
        "twin_fallback": fallback,
        "runtime_ms": round((time.perf_counter() - t0) * 1000),
    }
