"""``GET incidents/<id>/participants/<pid>/phone-view``: what one participant's iOS app shows now.

Controller only. Computed from the same data the phone reads (``situation``: guidance, fire,
check-in, tasks; ``me/destination`` choice; ``me/location``), mirroring the copy of the SwiftUI
views (GuidanceSheet, CheckInButtons, HomeHero, TasksView). Nothing here is written, and nothing
is invented: a number is the server's route, the fire estimate's distance or null.
Contract: docs/app-integration.md "Phone mirror".
"""

from __future__ import annotations

import math
from typing import Any

from livecore.geo import centroid, point_in_multipolygon, polyline_distance_m, simplify_line

from .auth import Principal, live_view
from .common import col, error, iso, ok, wall_now
from .state import incident_json, load_snapshot, rendered_guidance, responder_tasks, task_json

FIRE_DISTANCE_MAX_KM = 500.0
"""Fire distances beyond this are reported as null rather than a meaningless number."""
FIRE_RING_PAD_DEG = 0.12
FIRE_RING_MAX_POINTS = 160
HELP_WORDS = {
    "open": "Help requested",
    "acknowledged": "Request seen",
    "assigned": "Responder assigned",
    "resolved": "Need help",
}
VERDICTS = {"evacuate_now": "Leave now", "be_ready": "Be ready to leave"}


# ---- participants ----


def _virtual_participant(incident_id: str, participant_id: str) -> dict[str, Any] | None:
    """A simulated person (``virtual_people``, docs/app-integration.md "Simulated people").

    Its ``id`` is its device's ``party_key``, and it checks in, chooses destinations and reports through
    the phone endpoints, so its stored check-in and destination choice are read exactly as a phone's are;
    the position is the estimated one from ``list_participants``.
    """
    from . import virtual_people

    person = virtual_people.find_participant(incident_id, participant_id)
    if person is None:
        return None
    checkin = col("live_checkins").find_one({"incident_id": incident_id, "party_key": participant_id})
    return {**person, "role": "civilian", "checkin": checkin}


def _real_participant(incident_id: str, participant_id: str) -> dict[str, Any] | None:
    """A phone: the ``party_key`` of a device token (``dev_`` civilian, ``rsp_`` responder)."""
    device = col("live_devices").find_one({"party_key": participant_id})
    checkin = col("live_checkins").find_one({"incident_id": incident_id, "party_key": participant_id})
    if device is None and checkin is None:
        return None
    if device is not None and device.get("incident_id") not in (None, incident_id):
        return None
    role = (device or checkin or {}).get("role", "civilian")
    location = (device or {}).get("location")  # set by me/location, civilians and responders
    if location is None and role == "responder":
        location = col("live_responder_locations").find_one(
            {"incident_id": incident_id, "party_key": participant_id, "expires_at": {"$gt": wall_now()}}
        )
    simulated = bool((device or {}).get("simulated") or (checkin or {}).get("simulated"))
    return {
        "id": participant_id,
        "kind": "simulated" if simulated else "phone",
        "role": role,
        "name": (device or {}).get("name"),
        "checkin": checkin,
        "position": list(location["coord"]) if location else None,
    }


# ---- geometry and guidance ----


def _zone_containing(index, position) -> str | None:
    if position is None:
        return None
    point = (position[0], position[1])
    for zone in index.drill.zones:
        if point_in_multipolygon(point, zone.geometry):
            return zone.id
    return None


def _fire_distance_km(fire, point) -> float | None:
    if point is None or fire.geometry is None or fire.method == "none":
        return None
    metres = polyline_distance_m([(point[0], point[1])], fire.geometry, FIRE_DISTANCE_MAX_KM * 1000)
    return None if math.isinf(metres) else round(metres / 1000, 2)


def _fire_rings(fire, point, route) -> list[list[list[float]]]:
    """Simplified outer rings of the fire estimate near the person and route, for the map strip."""
    if fire.geometry is None or fire.method == "none":
        return []
    pts = [list(point)] if point else []
    pts += [p for p in (route or {}).get("line", [])]
    if not pts:
        return []
    pad = FIRE_RING_PAD_DEG
    x0, x1 = min(p[0] for p in pts) - pad, max(p[0] for p in pts) + pad
    y0, y1 = min(p[1] for p in pts) - pad, max(p[1] for p in pts) + pad
    rings = []
    for polygon in fire.geometry:
        ring = polygon[0]
        if all(p[0] < x0 or p[0] > x1 for p in ring) or all(p[1] < y0 or p[1] > y1 for p in ring):
            continue
        simple = simplify_line(ring, 100.0, FIRE_RING_MAX_POINTS)
        rings.append([[round(p[0], 5), round(p[1], 5)] for p in simple])
        if len(rings) >= 8:
            break
    return rings


def _apply_choice(incident_id: str, participant_id: str, guidance: dict[str, Any]) -> dict[str, Any]:
    """The destination the person picked (``me/destination``) replaces the recommended one."""
    choice = col("live_destination_choices").find_one(
        {"incident_id": incident_id, "party_key": participant_id, "zone_id": guidance["zone_id"],
         "expires_at": {"$gt": wall_now()}}
    )
    if choice is None:
        return guidance
    for alt in guidance.get("alternatives") or []:
        if alt["destination"]["id"] == choice["destination_id"]:
            return {**guidance, "destination": alt["destination"], "route": alt["route"]}
    return guidance


def _short_name(name: str | None) -> str:
    """GuidanceDestination.shortName: the name up to " via "."""
    if not name:
        return "Destination"
    return name.split(" via ")[0].strip() or name


def _eta_text(minutes: int | None) -> str | None:
    if minutes is None:
        return None
    return "<1 min" if minutes < 1 else f"{minutes} min"


# ---- screens ----


def _check_in_buttons(checkin: dict[str, Any] | None) -> list[dict[str, str]]:
    """CheckInButtons: "I'm out" (becomes "You're marked out") and the help button's label."""
    status = (checkin or {}).get("status")
    help_status = ((checkin or {}).get("help") or {}).get("status", "open")
    if status == "out":
        first = {"label": "You're marked out", "kind": "secondary"}
    else:
        first = {"label": "I'm out", "kind": "primary"}
    help_label = HELP_WORDS.get(help_status, "Help requested") if status == "need_help" else "Need help"
    return [first, {"label": help_label, "kind": "danger"}]


def _responder_screen(person: dict[str, Any], index, incident_id: str) -> dict[str, Any]:
    """TasksView: accepted task first, then assigned to this phone, then oldest."""
    tasks = [task_json(t) for t in responder_tasks(incident_id, person["id"])]

    def rank(t: dict[str, Any]) -> tuple[int, str]:
        mine = t.get("assignee") == person["id"]
        return (0 if t["status"] == "accepted" else 1 if mine else 2, t["created_at"])

    tasks.sort(key=rank)
    if not tasks:
        return {"screen": "responder", "headline": "No tasks", "sub": "Nothing is waiting for you.",
                "lines": [], "buttons": [], "assignment": None}
    task = tasks[0]
    target = task.get("target") or {}
    assist = task.get("kind") == "assist"
    place = (task.get("place") or {}).get("name") or index.segment_names.get(target.get("segment_id")) \
        or "the marked place"
    accepted = task["status"] == "accepted"
    primary = "Done" if accepted and assist else "Answer" if accepted else "Accept"
    buttons = [
        {"label": primary, "kind": "primary"},
        {"label": "Show on map", "kind": "secondary"},
        {"label": "Can't reach", "kind": "secondary"},
    ]
    lines = [task["note"]] if task.get("note") else []
    lines.append("Accepted" if accepted else "Waiting for you to accept")
    if len(tasks) > 1:
        lines.append(f"{len(tasks) - 1} more open")
    return {
        "screen": "responder",
        "headline": "Help a resident" if assist else f"Check {place}",
        "sub": "Task from incident command",
        "lines": lines,
        "buttons": buttons,
        "assignment": {
            "task_id": task["id"], "kind": task["kind"], "status": task["status"], "place": place,
            "target": target.get("coord"), "note": task.get("note"), "open_tasks": len(tasks),
        },
    }


def _attach_route(body: dict[str, Any], guidance: dict[str, Any] | None) -> None:
    route = (guidance or {}).get("route")
    if not guidance or not route or guidance.get("no_route"):
        return
    destination = guidance.get("destination") or {}
    body["route"] = {
        "line": route["line"],
        "destination_name": _short_name(destination.get("name")),
        "eta_min": route.get("eta_min"),
    }
    body["destination_coord"] = destination.get("coord")


def build_phone_view(incident_id: str, person: dict[str, Any]) -> dict[str, Any]:
    body = _build(incident_id, person)
    fire = body.pop("_fire")
    body["fire"] = {"rings": _fire_rings(fire, body.get("position"), body.get("route"))}
    return body


def _build(incident_id: str, person: dict[str, Any]) -> dict[str, Any]:
    snapshot = load_snapshot(incident_id, wall_now())
    index = snapshot.index
    simulated = person.get("kind") == "simulated"
    role = person.get("role") or "civilian"
    checkin = person.get("checkin")
    position = person.get("position") or (checkin or {}).get("coord")
    zone_id = person.get("zone_id") or (checkin or {}).get("zone_id") or _zone_containing(index, position)
    zone = index.zones.get(zone_id) if zone_id else None
    point = tuple(position) if position else (centroid(zone.geometry) if zone is not None else None)

    body: dict[str, Any] = {
        "participant_id": person["id"],
        "role": role,
        "kind": person.get("kind", "phone"),
        "name": person.get("name"),
        "screen": "not_joined",
        "headline": "",
        "sub": "",
        "lines": [],
        "buttons": [],
        "zone": {"id": zone.id, "name": zone.name} if zone is not None else None,
        "fire_distance_km": None,
        "position": list(point) if point else None,
        "position_is": "device" if position else ("zone_centre" if point else None),
        "route": None,
        "assignment": None,
        "incident": incident_json(index),
        "_fire": snapshot.fire,
        "fire_label": snapshot.fire.label,
        "as_of": iso(snapshot.now),
        "evidence_class": "simulated" if simulated else snapshot.fire.evidence_class,
    }

    if role == "responder":
        screen = _responder_screen(person, index, incident_id)
        body.update(screen)
        target = (screen.get("assignment") or {}).get("target")
        if position is None and target:
            point = tuple(target)
            body["position"], body["position_is"] = None, None
        body["fire_distance_km"] = _fire_distance_km(snapshot.fire, point)
        return body

    body["fire_distance_km"] = _fire_distance_km(snapshot.fire, point)
    buttons = _check_in_buttons(checkin)
    status = (checkin or {}).get("status")
    if status == "out":
        body.update(screen="checked_out", headline="You're marked out",
                    sub="Incident command can see you are safe.", buttons=buttons)
        return body
    if zone is None:
        body.update(screen="not_joined", headline="Finding your location",
                    sub="This phone has not reported a place yet.")
        return body

    guidance = next((g for g in rendered_guidance(incident_id, index) if g["zone_id"] == zone.id), None)
    if guidance is not None:
        guidance = _apply_choice(incident_id, person["id"], guidance)
    level = (guidance or {}).get("level", "none")
    if status == "need_help":
        help_status = ((checkin or {}).get("help") or {}).get("status", "open")
        body.update(screen="help_requested", headline=HELP_WORDS.get(help_status, "Help requested"),
                    sub="Your location was sent to responders.", buttons=buttons,
                    lines=[VERDICTS[level]] if level in VERDICTS else [])
        _attach_route(body, guidance)
        return body
    if guidance is None or level == "none":
        body.update(screen="no_order", headline=f"No order for {zone.name}",
                    sub="No emergency order applies to your area.", buttons=buttons)
        return body

    route = guidance.get("route")
    lines: list[str] = []
    if route and not guidance.get("no_route"):
        via = (route.get("via") or [None])[0]
        destination = _short_name((guidance.get("destination") or {}).get("name"))
        headline = f"Via {via}" if via else destination
        caveat = (guidance.get("caveat") or "").strip()
        if not caveat and route.get("safety") == "passes_fire":
            caveat = "Every way out passes the fire"
        if caveat:
            lines.append(caveat)
        eta = _eta_text(route.get("eta_min"))
        lines.append(f"{destination}, {eta}" if eta else destination)
    else:
        headline = "No open route. Shelter in place and tap Need help."
    if guidance.get("reason"):
        lines.append(guidance["reason"])
    body.update(screen="guidance", headline=headline, sub=VERDICTS.get(level, "Leave now"), lines=lines,
                buttons=buttons)
    _attach_route(body, guidance)
    return body


@live_view(["GET"], roles=["controller"])
def phone_view(request, incident_id: str, participant_id: str, principal: Principal):
    person = _virtual_participant(incident_id, participant_id) or _real_participant(incident_id, participant_id)
    if person is None:
        return error(404, "not_found", "Unknown participant.")
    body = build_phone_view(incident_id, person)
    if person.get("position_source") == "estimated" and body.get("position_is") == "device":
        body["position_is"] = "estimated"  # a simulated person's position is the model's estimate, not a GPS fix
    return ok(body)
