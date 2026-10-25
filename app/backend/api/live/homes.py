"""``GET incidents/<id>/homes``: the drill's simulated households as homes with a synthetic street address,
for the phone's "Your address" setting (docs/app-integration.md "Homes").

A home is one simulated person (``virtual_people``, docs/app-integration.md "Simulated people"): its home point,
zone, household (car, vehicles taken, pets, needs assistance), its drawn story (``narrative``) and its status on
the drill clock, exactly as the live console lists it. The phone uses the home point in place of its GPS fix,
so everything else it shows (zone guidance, route, fire) is the live ``situation``, unchanged.

The address is made up and computed on read (nothing is written): the nearest named road of the drill's road
network within ``ADDRESS_MAX_M`` of the home point, with a house number drawn from a hash of the person's id
(even-numbered and deduplicated in person order). With no named road that close it is "Home <n>, <zone>".
Everything here is ``evidence_class: "simulated"``; no real household or address is involved.
"""

from __future__ import annotations

import hashlib
import threading
from typing import Any

from .auth import Principal, live_view
from .common import col, error, ok
from .drillcache import _cell, _point_segment_m, get_index
from .virtual_people import LABEL, PEOPLE, list_participants

ADDRESS_MAX_M = 1000.0
"""A home farther than this from every named road gets the zone fallback instead of a street name."""
SEARCH_RINGS = 3
"""Grid cells (``drillcache.SNAP_CELL_DEG``, about 0.43 x 0.56 km here) searched around the home on each side."""
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
NOTICE = ("Simulated households of the drill. Addresses are made up from the nearest road; "
          "household and story are simulated.")

_cache: dict[tuple[str, int], dict[str, str]] = {}
_cache_lock = threading.Lock()


def _street(index, point: tuple[float, float]) -> str | None:
    """Name of the nearest named road segment within ADDRESS_MAX_M of ``point``, or None."""
    cx, cy = _cell(*point)
    candidates: set[str] = set()
    for dx in range(-SEARCH_RINGS, SEARCH_RINGS + 1):
        for dy in range(-SEARCH_RINGS, SEARCH_RINGS + 1):
            candidates.update(index.grid.get((cx + dx, cy + dy), ()))
    best: tuple[float, str] | None = None
    for segment_id in candidates:
        name = (index.segment_names.get(segment_id) or "").strip()
        if not name:
            continue
        line = index.segment_lines[segment_id]
        d = min(_point_segment_m(point, a, b) for a, b in zip(line, line[1:]))
        if best is None or d < best[0]:
            best = (d, name)
    return best[1] if best is not None and best[0] <= ADDRESS_MAX_M else None


def _number(person_id: str) -> int:
    """Deterministic even house number 100..9998 from the person's id."""
    return 100 + 2 * (int(hashlib.sha256(person_id.encode()).hexdigest()[:8], 16) % 4950)


def _addresses(incident_id: str, persons: list[dict[str, Any]], index) -> dict[str, str]:
    """Synthetic address per person id, unique within the incident, cached until the people change."""
    key = (incident_id, hash(tuple(p["id"] for p in persons)))
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    out: dict[str, str] = {}
    used: set[str] = set()
    for p in persons:
        street = _street(index, (p["home"][0], p["home"][1]))
        if street is None:
            zone = index.zones.get(p["zone_id"])
            address = f"Home {p['n']}, {zone.name if zone is not None else p['zone_id']}"
        else:
            number = _number(p["id"])
            address = f"{number} {street}"
            while address.lower() in used:
                number = 100 + (number - 100 + 2) % 9900
                address = f"{number} {street}"
        used.add(address.lower())
        out[p["id"]] = address
    with _cache_lock:
        _cache.clear()  # one incident's people at a time is all a server serves
        _cache[key] = out
    return out


def _home(p: dict[str, Any], address: str, listed: dict[str, Any] | None, index) -> dict[str, Any]:
    choices = p.get("choices") or {}
    zone = index.zones.get(p["zone_id"])
    return {
        "id": p["id"],
        "address": address,
        "address_basis": "synthetic",
        "coord": [round(p["home"][0], 6), round(p["home"][1], 6)],
        "zone": {"id": p["zone_id"], "name": zone.name if zone is not None else None},
        "household": {
            "has_vehicle": bool(p.get("has_vehicle")),
            "vehicles_taken": choices.get("vehicles_taken"),
            "has_pets": choices.get("has_pets"),
            "needs_assistance": choices.get("needs_assistance"),
        },
        "story": list(p.get("narrative") or []),
        "status": (listed or {}).get("status"),
        "flags": (listed or {}).get("flags", []),
        "evidence_class": "simulated",
    }


@live_view(["GET"])
def homes(request, incident_id: str, principal: Principal):
    params = request.query_params
    q = (params.get("q") or "").strip().lower()
    home_id = (params.get("id") or "").strip()
    try:
        limit = int(params.get("limit") or DEFAULT_LIMIT)
    except ValueError:
        return error(400, "invalid_request", "`limit` must be an integer.")
    if not 1 <= limit <= MAX_LIMIT:
        return error(400, "invalid_request", f"`limit` must be 1..{MAX_LIMIT}.")
    if len(q) > 120:
        return error(400, "invalid_request", "`q` is at most 120 characters.")

    persons = list(col(PEOPLE).find({"incident_id": incident_id},
                                    {"_id": 0, "id": 1, "n": 1, "home": 1, "zone_id": 1, "has_vehicle": 1,
                                     "choices": 1, "narrative": 1}).sort("n", 1))
    index = get_index(incident_id)
    addresses = _addresses(incident_id, persons, index)
    if home_id:
        persons = [p for p in persons if p["id"] == home_id]
        if not persons:
            return error(404, "unknown_home", "No simulated home with this id.")
    elif q:
        persons = [p for p in persons if q in addresses[p["id"]].lower()]
    total = len(persons)
    persons = persons[:limit]
    # Status as the console lists it (this also advances the people to the drill clock).
    listed = {p["id"]: p for p in list_participants(incident_id)} if persons else {}
    return ok({
        "incident_id": incident_id,
        "label": LABEL,
        "notice": NOTICE,
        "evidence_class": "simulated",
        "total": total,
        "homes": [_home(p, addresses[p["id"]], listed.get(p["id"]), index) for p in persons],
    })
