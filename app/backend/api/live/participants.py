"""Phones that joined the drill: a display name and kind, plus the latest position (docs/live-reports.md)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from rest_framework.response import Response

from .auth import Principal, live_view
from .common import col, error, iso, json_body, ok, wall_now

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
