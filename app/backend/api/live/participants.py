"""Phones that joined the drill: a display name and kind, plus the latest position (docs/live-reports.md),
and the incident-scoped participants list of the App integration tab (docs/app-integration.md)."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from livecore.geo import point_in_multipolygon, polyline_distance_m

from rest_framework.response import Response

from . import incidents
from .auth import Principal, live_view
from .common import col, error, iso, json_body, ok, wall_now
from .state import Snapshot, current_guidance, load_snapshot, report_replay_at

KINDS = ("resident", "firefighter", "observer")
NAME_MAX_CHARS = 24
ACTIVE_WINDOW = timedelta(hours=1)
"""A phone not heard from in this long is left out of the participants list."""
LOCATION_FRESH_S = 900
"""A position older than this is reported with `location_stale: true`."""


@live_view(["POST"], roles=["civilian", "responder"])
def my_profile(request, principal: Principal):
    """The phone's short display name and kind. Both optional; an empty name clears it."""
    code = "invalid_profile"
    body = json_body(request, code)
    update: dict[str, Any] = {}
    if "name" in body:
        name = body["name"]
        if name is not None and (not isinstance(name, str) or len(name.strip()) > NAME_MAX_CHARS):
            return error(400, code, f"`name` must be a string of at most {NAME_MAX_CHARS} characters or null.")
        update["name"] = " ".join(name.split()) if isinstance(name, str) and name.strip() else None
    if "kind" in body:
        if body["kind"] not in KINDS:
            return error(400, code, "`kind` must be resident, firefighter or observer.")
        update["kind"] = body["kind"]
    if update:
        col("live_devices").update_one({"party_key": principal.party_key}, {"$set": update})
    return Response(status=204, headers={"Cache-Control": "no-store"})


@live_view(["GET"], roles=["controller"])
def participants(request, principal: Principal):
    """Every phone seen in the last hour: name, kind, role, last seen and latest position."""
    now = wall_now()
    cursor = col("live_devices").find(
        {"expires_at": {"$gt": now}, "last_seen_at": {"$gt": now - ACTIVE_WINDOW}}
    )
    items = []
    for doc in cursor:
        loc = doc.get("location")
        role = doc["role"]
        item: dict[str, Any] = {
            "party_key": doc["party_key"],
            "role": role,
            "kind": doc.get("kind") or ("firefighter" if role == "responder" else "resident"),
            "name": doc.get("name"),
            "incident_id": doc.get("incident_id"),
            "simulated": bool(doc.get("simulated")),
            "last_seen_at": iso(doc["last_seen_at"]),
            "location": None,
        }
        if loc:
            item["location"] = {
                "coord": loc["coord"],
                "accuracy_m": loc.get("accuracy_m"),
                "at": iso(loc["at"]),
                "stale": (now - loc["at"]).total_seconds() > LOCATION_FRESH_S,
            }
        items.append(item)
    items.sort(key=lambda i: i["last_seen_at"], reverse=True)
    return ok({"participants": items, "as_of": iso(now)})

# ---- GET incidents/{id}/participants: the "App integration" tab (docs/app-integration.md) ----
#
# Two kinds of participant, never mixed up:
# - ``real``: a phone. A responder that joined this incident, or a civilian device that checked in,
#   reported (last 2 h), chose a destination or shared a location here, or was seen in the last
#   ``ACTIVE_WINDOW`` while this incident is the active one. Simulated devices are never ``real``.
# - ``simulated``: the households of ``virtual_people.list_participants`` (empty until that module
#   exists) plus simulated responder units sharing a location (``live_sim_responders``).
# Status lines and flags are deterministic rules on the drill state, in plain words. The response
# also carries ``messages``: what went to phones and what came from participants, newest first.

KIND_TO_ROLE = {"resident": "resident", "firefighter": "responder", "observer": "observer"}

log = logging.getLogger(__name__)

REPORT_POSITION_MAX_AGE = timedelta(minutes=20)
"""A report's location stands in for a phone's position for this long (wall time)."""
REPORTER_WINDOW = timedelta(hours=2)
"""A phone whose only trace here is a report counts as joined for this long after it (reports outlive a
drill reset; check-ins do not)."""
RECENT_REPORT_FOR_STATUS = timedelta(minutes=10)
LATE_AFTER = timedelta(minutes=30)
"""Drill time after a ``evacuate_now`` order with no ``out`` check-in before a resident is ``Late``."""
DANGER_M = 500.0
"""A resident within this distance of the fire estimate (or inside it) is ``In danger``."""
MESSAGES_LIMIT = 60
GUIDANCE_SCAN_LIMIT = 5000

FLAGS = ("Stuck", "Needs help", "Late", "Different road", "Went back", "Not leaving", "In danger", "Toward fire", "Slowed")
ROLES = ("resident", "responder", "observer")

REPORT_WORDS = {
    "road_blocked": "road blocked",
    "road_passable": "road is open",
    "heavy_traffic": "heavy traffic",
    "fire_seen": "I see fire",
    "heavy_smoke": "heavy smoke",
    "hazard_down": "something is down on the road",
    "shelter_full": "the shelter is full",
    "help_needed": "someone needs help",
}
CHECKIN_WORDS = {"out": "I'm out", "need_help": "I need help", "staying": "I'm staying home"}
LEVEL_WORDS = {"evacuate_now": "leave now", "be_ready": "get ready to leave", "none": "no order now"}


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _short(key: str) -> str:
    return key.split("_", 1)[-1][-4:].upper()


def _default_name(role: str, party_key: str) -> str:
    return f"{'Responder' if role == 'responder' else 'Phone'} {_short(party_key)}"


def _zone_name(name: str) -> str:
    """"Block Group 1, Census Tract 9.01" -> "Tract 9.01, BG 1" (same rule as the web's shortZoneName)."""
    if name.startswith("Block Group ") and ", Census Tract " in name:
        bg, tract = name[len("Block Group "):].split(", Census Tract ", 1)
        return f"Tract {tract}, BG {bg}"
    return name


def _zones_phrase(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return f"{names[0]} and {len(names) - 1} more zones"


def _zone_of(snapshot: Snapshot, coord: list[float] | None) -> str | None:
    if not coord:
        return None
    p = (float(coord[0]), float(coord[1]))
    for zone in snapshot.index.drill.zones:
        if point_in_multipolygon(p, zone.geometry):
            return zone.id
    return None


def _fire_m(snapshot: Snapshot, coord: list[float] | None) -> float | None:
    """Metres from the fire estimate (0 inside), None when unknown or farther than 20 km."""
    if not coord or snapshot.fire.geometry is None:
        return None
    p = (float(coord[0]), float(coord[1]))
    d = polyline_distance_m([p], snapshot.fire.geometry, 20_000.0)
    return None if d == float("inf") else d


def _ordered_since(incident_id: str, zone_ids: Iterable[str]) -> dict[str, datetime]:
    """Drill time each zone's current run of ``evacuate_now`` started (only zones now ordered)."""
    out: dict[str, datetime] = {}
    zone_ids = list(set(z for z in zone_ids if z))
    if not zone_ids:
        return out
    docs = col("live_guidance").find(
        {"incident_id": incident_id, "zone_id": {"$in": zone_ids}},
        {"zone_id": 1, "version": 1, "level": 1, "replay_at": 1},
    ).sort([("zone_id", 1), ("version", 1)])
    for d in docs:
        if d.get("level") == "evacuate_now":
            if d["zone_id"] not in out and d.get("replay_at") is not None:
                out[d["zone_id"]] = _aware(d["replay_at"])
        else:
            out.pop(d["zone_id"], None)
    return out


# ---- real phones ----


def _real_party_keys(incident_id: str, now: datetime) -> set[str]:
    keys: set[str] = set()
    keys.update(col("live_checkins").distinct("party_key", {"incident_id": incident_id}))
    keys.update(
        col("live_reports").distinct(
            "reporter.party_key",
            {"incident_id": incident_id, "evidence_class": "field_report", "reporter.role": {"$in": ["civilian", "responder"]},
             "received_at": {"$gt": now - REPORTER_WINDOW}},
        )
    )
    keys.update(col("live_destination_choices").distinct("party_key", {"incident_id": incident_id}))
    keys.update(
        col("live_responder_locations").distinct("party_key", {"incident_id": incident_id, "expires_at": {"$gt": now}})
    )
    recent = {"last_seen_at": {"$gt": now - ACTIVE_WINDOW}, "expires_at": {"$gt": now}}
    keys.update(col("live_devices").distinct("party_key", {**recent, "incident_id": incident_id}))
    if incident_id == incidents.active_incident_id():
        # Civilian tokens are not bound to an incident; one in use now follows the active incident.
        keys.update(col("live_devices").distinct("party_key", {**recent, "incident_id": None, "role": "civilian"}))
    return keys


def _resident_status(
    checkin: dict[str, Any] | None,
    level: str,
    ordered_at: datetime | None,
    replay_now: datetime | None,
    report: dict[str, Any] | None,
    fire_m: float | None,
    inside_ordered_zone: bool | None,
) -> tuple[str, list[str]]:
    flags: list[str] = []
    status_kind = (checkin or {}).get("status")
    if status_kind == "out":
        return "Safely out", flags
    if status_kind == "need_help":
        help_status = ((checkin or {}).get("help") or {}).get("status", "open")
        if help_status == "resolved":
            text = "Was helped"
        else:
            flags.append("Needs help")
            text = {
                "acknowledged": "Asked for help, request seen",
                "assigned": "Asked for help, a responder is on the way",
            }.get(help_status, "Asked for help")
    elif status_kind == "staying":
        text = "Staying home"
        if level == "evacuate_now":
            text = "Staying home, told to leave"
            flags.append("Not leaving")
    elif report is not None and report.get("kind") in ("heavy_traffic", "road_blocked"):
        road = ((report.get("road_ref") or {}).get("name")) or "the road"
        text = f"Reported {REPORT_WORDS[report['kind']]} on {road}"
        flags.append("Slowed" if report["kind"] == "heavy_traffic" else "Stuck")
    else:
        text = {"evacuate_now": "Told to leave now", "be_ready": "Told to get ready"}.get(level, "No order yet")
    if (
        status_kind != "need_help"
        and level == "evacuate_now"
        and ordered_at is not None
        and replay_now is not None
        and replay_now - ordered_at >= LATE_AFTER
        and inside_ordered_zone is not False
    ):
        flags.append("Late")
    if fire_m is not None and fire_m <= DANGER_M:
        flags.append("In danger")
        text = f"{text}, fire is close"
    return text, flags


def _responder_status(tasks: list[dict[str, Any]], segment_names: dict[str, str | None]) -> str:
    if not tasks:
        return "Available"
    t = tasks[0]
    if t.get("kind") == "assist":
        return "Going to help a resident" if t["status"] == "accepted" else "Asked to help a resident"
    road = segment_names.get(((t.get("target") or {}).get("segment_id")) or "") or None
    what = f"Checking {road}" if road else "Checking a road"
    return what if t["status"] == "accepted" else f"Asked to: {what[0].lower()}{what[1:]}"


def _real_participants(snapshot: Snapshot, exclude: set[str]) -> list[dict[str, Any]]:
    incident_id, now = snapshot.incident_id, snapshot.now
    keys = _real_party_keys(incident_id, now) - exclude
    if not keys:
        return []
    devices = {
        d["party_key"]: d
        for d in col("live_devices").find(
            {"party_key": {"$in": list(keys)}, "simulated": {"$ne": True}, "expires_at": {"$gt": now}},
            {"token_hash": 0},
        )
        # A responder token is bound to one incident; civilians are not.
        if d.get("incident_id") in (None, incident_id)
    }
    if not devices:
        return []
    pkeys = list(devices)
    checkins = {d["party_key"]: d for d in col("live_checkins").find({"incident_id": incident_id, "party_key": {"$in": pkeys}})}
    locations = {
        d["party_key"]: d
        for d in col("live_responder_locations").find(
            {"incident_id": incident_id, "party_key": {"$in": pkeys}, "expires_at": {"$gt": now}}
        )
    }
    reports: dict[str, dict[str, Any]] = {}
    for r in col("live_reports").find(
        {"incident_id": incident_id, "reporter.party_key": {"$in": pkeys}, "status": {"$ne": "withdrawn"}}
    ).sort("received_at", -1):
        reports.setdefault(r["reporter"]["party_key"], r)
    choices: dict[str, dict[str, Any]] = {}
    for c in col("live_destination_choices").find({"incident_id": incident_id, "party_key": {"$in": pkeys}}).sort("at", -1):
        choices.setdefault(c["party_key"], c)
    tasks: dict[str, list[dict[str, Any]]] = {}
    for t in col("live_tasks").find(
        {"incident_id": incident_id, "assignee": {"$in": pkeys}, "status": {"$in": ["open", "accepted"]}}
    ).sort("created_at", -1):
        tasks.setdefault(t["assignee"], []).append(t)

    guidance = {g["zone_id"]: g for g in current_guidance(incident_id)}
    replay_now = _aware(snapshot.clock.replay_now)
    out: list[dict[str, Any]] = []
    staged: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for key, dev in devices.items():
        role = KIND_TO_ROLE.get(dev.get("kind") or "", "responder" if dev["role"] == "responder" else "resident")
        checkin = checkins.get(key)
        report = reports.get(key)
        position, source = None, None
        loc = dev.get("location") or locations.get(key)  # me/location (any phone), else the responder table
        if loc is not None:
            position, source = loc["coord"], "gps"  # a stale fix is still shown; last_seen says how old
        elif checkin is not None and checkin.get("coord"):
            position, source = checkin["coord"], "gps"
        elif report is not None and now - _aware(report["received_at"]) <= REPORT_POSITION_MAX_AGE:
            position, source = report["location"]["coord"], "gps"
        zone_id = (checkin or {}).get("zone_id") or (choices.get(key) or {}).get("zone_id") or _zone_of(snapshot, position)
        seen = [_aware(dev.get("last_seen_at"))]
        seen += [_aware(x) for x in ((checkin or {}).get("at"), (report or {}).get("received_at"), (loc or {}).get("at"))]
        last_seen = max((s for s in seen if s is not None), default=None)
        p = {
            "id": key,
            "kind": "real",
            "role": role,
            "name": (dev.get("name") or "").strip()[:NAME_MAX_CHARS] or _default_name(role, key),
            "zone_id": zone_id,
            "position": [position[0], position[1]] if position else None,
            "position_source": source,
            "status": "",
            "flags": [],
            "last_seen": iso(last_seen),
            "behaviour": None,
            "evidence_class": "field_report",
        }
        staged.append((p, {"checkin": checkin, "report": report, "tasks": tasks.get(key, [])}))

    ordered = _ordered_since(incident_id, (p["zone_id"] for p, _ in staged))
    for p, ctx in staged:
        if p["role"] == "responder":
            p["status"] = _responder_status(ctx["tasks"], snapshot.index.segment_names)
        elif p["role"] == "observer":
            p["status"] = "Watching"
        else:
            zone_id = p["zone_id"]
            level = (guidance.get(zone_id) or {}).get("level", "none") if zone_id else "none"
            zone = snapshot.index.zones.get(zone_id) if zone_id else None
            inside = None
            if p["position"] and zone is not None:
                inside = point_in_multipolygon((p["position"][0], p["position"][1]), zone.geometry)
            report = ctx["report"]
            if report is not None and snapshot.now - _aware(report["received_at"]) > RECENT_REPORT_FOR_STATUS:
                report = None
            p["status"], p["flags"] = _resident_status(
                ctx["checkin"], level, ordered.get(zone_id or ""), replay_now, report, _fire_m(snapshot, p["position"]), inside
            )
        out.append(p)
    out.sort(key=lambda p: p["name"])
    out.sort(key=lambda p: p["last_seen"] or "", reverse=True)  # phones heard from most recently first
    return out


# ---- simulated people ----


def _virtual_participants(incident_id: str) -> list[dict[str, Any]]:
    """Simulated households from ``virtual_people`` (another module; empty until it exists)."""
    try:
        from . import virtual_people  # type: ignore[attr-defined]
    except ImportError:
        return []
    reader = getattr(virtual_people, "list_participants", None)
    if reader is None:
        return []
    try:
        rows = list(reader(incident_id) or [])
    except Exception:  # noqa: BLE001 - a broken driver must not take the tab down
        log.exception("virtual_people.list_participants failed")
        return []
    out = []
    for r in rows:
        if not isinstance(r, dict) or not r.get("id"):
            continue
        out.append(
            {
                "id": str(r["id"]),
                "kind": "simulated",
                "role": r.get("role") if r.get("role") in ROLES else "resident",
                "name": str(r.get("name") or f"Simulated {_short(str(r['id']))}"),
                "zone_id": r.get("zone_id"),
                "position": r.get("position"),
                "position_source": r.get("position_source") or ("estimated" if r.get("position") else None),
                "status": str(r.get("status") or ""),
                "flags": [f for f in (r.get("flags") or []) if f in FLAGS],
                "last_seen": r.get("last_seen"),
                "behaviour": r.get("behaviour"),
                "evidence_class": "simulated",
            }
        )
    return out


def _sim_responders(snapshot: Snapshot, exclude: set[str]) -> list[dict[str, Any]]:
    """Simulated responder units (``live_sim_responders``) that share a location."""
    incident_id, now = snapshot.incident_id, snapshot.now
    locs = {
        d["party_key"]: d
        for d in col("live_responder_locations").find({"incident_id": incident_id, "expires_at": {"$gt": now}})
        if d["party_key"] not in exclude
    }
    if not locs:
        return []
    sims = [
        d["party_key"]
        for d in col("live_devices").find(
            {"party_key": {"$in": list(locs)}, "simulated": True, "role": "responder"}, {"party_key": 1}
        )
    ]
    tasks: dict[str, list[dict[str, Any]]] = {}
    for t in col("live_tasks").find(
        {"incident_id": incident_id, "assignee": {"$in": sims}, "status": {"$in": ["open", "accepted"]}}
    ).sort("created_at", -1):
        tasks.setdefault(t["assignee"], []).append(t)
    out = []
    for i, key in enumerate(sorted(sims)):
        loc = locs[key]
        out.append(
            {
                "id": key,
                "kind": "simulated",
                "role": "responder",
                "name": f"Simulated unit {i + 1}",
                "zone_id": _zone_of(snapshot, loc["coord"]),
                "position": loc["coord"],
                "position_source": "estimated",
                "status": _responder_status(tasks.get(key, []), snapshot.index.segment_names),
                "flags": [],
                "last_seen": iso(_aware(loc.get("at"))),
                "behaviour": None,
                "evidence_class": "simulated",
            }
        )
    return out


# ---- messages ----


def _message(at: datetime | None, replay_at: datetime | None, direction: str, text: str,
             participant: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "at": iso(_aware(at)),
        "replay_at": iso(_aware(replay_at)),
        "direction": direction,
        "text": text,
        "participant_id": participant["id"] if participant else None,
        "kind": participant["kind"] if participant else None,
    }


def _messages(snapshot: Snapshot, participants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    incident_id, index = snapshot.incident_id, snapshot.index
    by_id = {p["id"]: p for p in participants}
    ids = list(by_id)
    msgs: list[dict[str, Any]] = []

    # To phones: guidance as published, grouped by publish (same second, what changed). A new version at
    # the same level is a new way out, not a repeat of the order.
    docs = list(col("live_guidance").find(
        {"incident_id": incident_id},
        {"zone_id": 1, "version": 1, "level": 1, "published_at": 1, "replay_at": 1, "route.via": 1, "destination.name": 1, "no_route": 1},
    ).sort([("zone_id", 1), ("version", 1)]).limit(GUIDANCE_SCAN_LIMIT))
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    previous: dict[str, str] = {}
    for g in docs:
        level = g.get("level", "none")
        change = "reroute" if previous.get(g["zone_id"]) == level and level != "none" else level
        previous[g["zone_id"]] = level
        at = _aware(g.get("published_at"))
        if at is None:
            continue
        key = (at.replace(microsecond=0).isoformat(), change)
        grp = groups.setdefault(key, {"at": at, "replay_at": g.get("replay_at"), "change": change, "zones": [], "g": g})
        zone = index.zones.get(g["zone_id"])
        grp["zones"].append(_zone_name(zone.name) if zone else g["zone_id"])
    for grp in groups.values():
        g = grp["g"]
        words = "new way out" if grp["change"] == "reroute" else LEVEL_WORDS.get(grp["change"], grp["change"])
        text = f"To {_zones_phrase(grp['zones'])}: {words}"
        if grp["change"] in ("evacuate_now", "reroute") and len(grp["zones"]) == 1:
            via = ((g.get("route") or {}).get("via") or [])[:1]
            dest = (g.get("destination") or {}).get("name")
            if g.get("no_route"):
                text += ", no open route"
            else:
                text += f" via {via[0]}" if via else ""
                text += f" to {dest}" if dest else ""
        msgs.append(_message(grp["at"], grp["replay_at"], "to", text))

    # To phones: what the controller decided not to send.
    for prp in col("live_proposals").find(
        {"incident_id": incident_id, "status": "rejected", "decided_by": {"$ne": "auto_policy"}},
        {"changes.zone_id": 1, "changes.to.level": 1, "decided_at": 1, "decided_replay_at": 1},
    ).sort("decided_at", -1).limit(10):
        changes = prp.get("changes") or []
        names = [_zone_name(index.zones[c["zone_id"]].name) if c["zone_id"] in index.zones else c["zone_id"] for c in changes]
        level = ((changes[0].get("to") or {}).get("level") if changes else None) or "none"
        if names:
            msgs.append(_message(prp.get("decided_at"), prp.get("decided_replay_at"), "to",
                                 f"Not sent: {_zones_phrase(names)}, {LEVEL_WORDS.get(level, level)}"))

    if ids:
        # To responders: assignments.
        for t in col("live_tasks").find({"incident_id": incident_id, "assignee": {"$in": ids}}).sort("created_at", -1).limit(30):
            p = by_id[t["assignee"]]
            if t.get("kind") == "assist":
                what = "go help a resident"
            else:
                road = index.segment_names.get(((t.get("target") or {}).get("segment_id")) or "")
                what = f"check {road}" if road else "check a road"
            msgs.append(_message(t.get("created_at"), t.get("replay_at"), "to", f"To {p['name']}: {what}", p))
        # From phones: check-ins (latest per phone) and the controller's answer to a help request.
        for c in col("live_checkins").find({"incident_id": incident_id, "party_key": {"$in": ids}}):
            p = by_id[c["party_key"]]
            msgs.append(_message(c.get("at"), c.get("replay_at"), "from", f"From {p['name']}: {CHECKIN_WORDS.get(c['status'], c['status'])}", p))
            help_ = c.get("help") or {}
            if c["status"] == "need_help" and help_.get("status") in ("acknowledged", "assigned"):
                reply = "we got your request" if help_["status"] == "acknowledged" else "help is on the way"
                at = help_.get("updated_at")
                msgs.append(_message(at, report_replay_at(incident_id, at) if at else None, "to", f"To {p['name']}: {reply}", p))
        # From phones: reports.
        for r in col("live_reports").find(
            {"incident_id": incident_id, "reporter.party_key": {"$in": ids}, "status": {"$ne": "withdrawn"}, "method": {"$ne": "passive"}}
        ).sort("received_at", -1).limit(40):
            p = by_id[r["reporter"]["party_key"]]
            road = (r.get("road_ref") or {}).get("name")
            words = REPORT_WORDS.get(r["kind"], r["kind"].replace("_", " "))
            text = f"From {p['name']}: {words}" + (f" on {road}" if road and r["kind"] in ("road_blocked", "road_passable", "heavy_traffic") else "")
            msgs.append(_message(r.get("received_at"), r.get("replay_at"), "from", text, p))

    msgs.sort(key=lambda m: m["at"] or "", reverse=True)
    return msgs[:MESSAGES_LIMIT]


def participants_payload(incident_id: str) -> dict[str, Any]:
    snapshot = load_snapshot(incident_id, wall_now())
    virtual = _virtual_participants(incident_id)
    exclude = {p["id"] for p in virtual}
    real = _real_participants(snapshot, exclude)
    units = _sim_responders(snapshot, exclude | {p["id"] for p in real})
    participants = real + virtual + units
    by_role = {r: 0 for r in ROLES}
    for p in participants:
        by_role[p["role"]] = by_role.get(p["role"], 0) + 1
    return {
        "incident_id": incident_id,
        "now": iso(snapshot.now),
        "replay_now": iso(_aware(snapshot.clock.replay_now)),
        "participants": participants,
        "counts": {
            "real": sum(1 for p in participants if p["kind"] == "real"),
            "simulated": sum(1 for p in participants if p["kind"] == "simulated"),
            "by_role": by_role,
        },
        "messages": _messages(snapshot, participants),
    }


@live_view(["GET"], roles=["controller"])
def incident_participants(request, incident_id: str, principal: Principal):
    """Everyone on the app in this drill, real and simulated, with plain status lines and flags."""
    return ok(participants_payload(incident_id))
