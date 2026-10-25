"""Follow a simulated person from a phone (docs/app-integration.md "Follow a simulated person").

- ``GET incidents/<id>/virtual-people/<person_id>/track``: one simulated person's track (position, route, progress,
  trail), any authenticated role. Built by ``virtual_people.build_track`` from the person's stored state after
  the lazy tick that every read of the people does;
- ``POST me/follow {person_id | null}``: a phone (civilian or responder device) says whom it follows; kept on its
  device document as ``follow``;
- ``GET incidents/<id>/followed``: the controller's list of the people being followed, with follower counts and
  each track (what /live and /run draw on the 3D map).

Everything served is ``evidence_class: "simulated"``; positions are estimates, never observations.
"""

from __future__ import annotations

from collections import Counter
from datetime import timedelta

from . import incidents
from . import virtual_people as vp
from .auth import Principal, live_view
from .common import ApiError, col, error, json_body, ok, wall_now

FOLLOW_FRESH_FOR = timedelta(minutes=15)
"""A follow counts while its device was seen this recently. ``auth.LAST_SEEN_WRITE_INTERVAL`` refreshes a device's
``last_seen_at`` at most every 5 min while it calls the API, so 15 min is three of those (ASSUMPTION)."""
MAX_FOLLOWED = 50
"""At most this many followed people (most followers first) are returned by ``GET followed``."""
MAX_ID_LENGTH = 80


@live_view(["GET"])
def track(request, incident_id: str, person_id: str, principal: Principal):
    result = vp.build_track(incident_id, person_id)
    if result is None:
        return error(404, "unknown_person", "No simulated person with this id.")
    return ok(result)


@live_view(["POST"], roles=["civilian", "responder"])
def my_follow(request, principal: Principal):
    body = json_body(request)
    if "person_id" not in body:
        return error(400, "invalid_request", "`person_id` is required (a simulated person's id, or null to stop).")
    person_id = body["person_id"]
    devices = col("live_devices")
    if person_id is None:
        devices.update_one({"party_key": principal.party_key}, {"$unset": {"follow": ""}})
        return ok({"following": None})
    if not isinstance(person_id, str) or not 0 < len(person_id) <= MAX_ID_LENGTH:
        return error(400, "invalid_request", f"`person_id` must be a string of 1-{MAX_ID_LENGTH} characters or null.")
    incident_id = principal.incident_id or incidents.active_incident_id()
    named = body.get("incident_id")
    if named is not None:
        if not isinstance(named, str) or not incidents.is_known(named):
            raise ApiError(404, "not_found", "Unknown incident.")
        if principal.role == "responder" and principal.incident_id not in (None, named):
            raise ApiError(403, "forbidden", "This token belongs to another incident.")
        incident_id = named
    if col(vp.PEOPLE).find_one({"incident_id": incident_id, "id": person_id}, {"_id": 1}) is None:
        return error(404, "unknown_person", "No simulated person with this id.")
    now = wall_now()
    devices.update_one({"party_key": principal.party_key},
                       {"$set": {"follow": {"person_id": person_id, "incident_id": incident_id, "at": now},
                                 "last_seen_at": now}})
    return ok({"following": person_id})


@live_view(["GET"], roles=["controller"])
def followed(request, incident_id: str, principal: Principal):
    now = wall_now()
    counts: Counter[str] = Counter()
    for d in col("live_devices").find({"follow.incident_id": incident_id, "expires_at": {"$gt": now},
                                       "last_seen_at": {"$gte": now - FOLLOW_FRESH_FOR}}, {"follow": 1}):
        counts[d["follow"]["person_id"]] += 1
    ids = sorted(counts, key=lambda i: (-counts[i], i))[:MAX_FOLLOWED]
    tracks = vp.build_tracks(incident_id, ids)
    people = [{"person_id": i, "followers": counts[i], "track": tracks[i]} for i in ids if i in tracks]
    return ok({"incident_id": incident_id, "label": vp.LABEL, "evidence_class": "simulated",
               "total_followers": sum(p["followers"] for p in people), "people": people})
