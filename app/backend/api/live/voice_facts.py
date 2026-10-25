"""The ``facts`` a voice turn's model call may answer from (docs/live-reports.md "Voice mode").

Built per Claude turn from what the server already computes for ``situation``: the snapshot
(``load_snapshot``: public items, fire estimate, drill clock), the rendered guidance the phone
sees, the guidance version history in ``live_guidance`` and the drill index's zones and
destinations. Nothing here is estimated by a model; every entry is a copy or a direct measure
of server data, and lists are empty rather than padded.

Distances are kilometres, rounded to 0.1, from the nearest edge of the caller's zone polygon
(0.0 when the thing is inside the zone, or for the fire, when the estimate touches or overlaps
it). They use ``livecore.geo``'s area distances, the ones the planner uses for guidance levels:
the equirectangular small-area approximation of the great-circle distance, which differs from
haversine by well under 1 % over an incident (below the 0.1 km rounding at these ranges).
Coordinates are ``(lon, lat)``. Without a zone every ``km_from_zone`` is null.

Clocks: ``as_of``, guidance and fire times are drill time (the replay clock); field reports
are real-time observations, so hazard and shelter-report times are wall time, each with a
server-computed age (``ago``, ``full_ago``, ``age``) on its own clock, in the phone's
wording ("12 min", "2 h 5 min", "just now").
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from livecore.geo import LonLat, MultiPolygon, distance_km, polyline_distance_m
from livecore.public import PublicItem

from .common import col, iso, wall_now
from .state import Snapshot, load_snapshot, rendered_guidance

MAX_HAZARDS = 8
MAX_SHELTERS = 5
MAX_HISTORY = 3
MAX_OPTIONS = 3
MAX_VIA = 4
MAX_FACTS_CHARS = 6000
"""Budget for the serialized facts (about 1.5k tokens); the tails of lists go first."""
NAME_CHARS = 80
TEXT_CHARS = 200
SHELTER_KINDS = ("shelter", "temporary_refuge")
MAX_DISTANCE_M = 500_000.0
"""Farther than this (never, within one incident) reads as an unknown distance."""
ROAD_SUFFIXES = frozenset(
    "road rd drive dr street st avenue ave lane ln way court ct boulevard blvd highway hwy place pl "
    "circle cir trail parkway pkwy terrace".split()
)


def _short(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:limit] if text else None


def _km(meters: float) -> float | None:
    return round(meters / 1000.0, 1) if math.isfinite(meters) else None


def point_km(zone: MultiPolygon | None, point: LonLat) -> float | None:
    """Km from the nearest edge of ``zone`` to ``point`` (0.0 inside); None without a zone."""
    if zone is None:
        return None
    return _km(polyline_distance_m([point], zone, MAX_DISTANCE_M))


def _minutes_between(earlier: datetime | None, later: datetime | None) -> int | None:
    if earlier is None or later is None:
        return None
    return max(0, int((later - earlier).total_seconds() // 60))


def age_text(minutes: int | None) -> str | None:
    """ "just now", "12 min", "2 h", "1 h 5 min" (the phone's ``RelativeAge.short``)."""
    if minutes is None:
        return None
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes} min"
    hours, rest = divmod(minutes, 60)
    return f"{hours} h" if rest == 0 else f"{hours} h {rest} min"


# ---- guidance ----


def headline(doc: Mapping[str, Any]) -> str:
    """What the phone titles a guidance version (Slab.swift ``GuidanceHistoryEntry.title``):
    "Leave now via Pentz Road", "Be ready to leave", "No order"."""
    level = doc.get("level")
    verdict = {"evacuate_now": "Leave now", "be_ready": "Be ready to leave"}.get(level, "No order")
    if level not in ("evacuate_now", "be_ready"):
        return verdict
    if doc.get("no_route"):
        return f"{verdict}, no open route"
    via = (doc.get("route") or {}).get("via") or []
    return f"{verdict} via {via[0]}" if via else verdict


def guidance_source(doc: Mapping[str, Any]) -> str:
    """Who stands behind it, as the phone says (Slab.swift ``sourceText``)."""
    if "official" in (doc.get("reason_code") or ""):
        return "Official order"
    return "Approved by incident command" if doc.get("approved_by") == "controller" else "Model estimate"


def _as_of(doc: Mapping[str, Any]) -> Any:
    """Drill time of the version (``replay_at``), else its publish time; as the phone's ``asOf``."""
    return doc.get("replay_at") or doc.get("published_at")


def _iso_any(value: Any) -> str | None:
    if isinstance(value, datetime):
        return iso(value)
    return value if isinstance(value, str) else None


def guidance_facts(doc: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The zone's published guidance from its rendered (``guidance_json``) form."""
    if doc is None:
        return None
    route = doc.get("route") or {}
    moving = doc.get("level") in ("evacuate_now", "be_ready") and not doc.get("no_route")
    options = []
    if moving:
        for alt in (doc.get("alternatives") or [])[:MAX_OPTIONS]:
            alt_route = alt.get("route") or {}
            options.append(
                {
                    "destination": _short((alt.get("destination") or {}).get("name"), NAME_CHARS),
                    "via": [_short(v, NAME_CHARS) for v in (alt_route.get("via") or [])[:MAX_VIA]],
                    "eta_min": alt_route.get("eta_min"),
                    "recommended": bool(alt.get("recommended")),
                }
            )
    distance_m = route.get("distance_m")
    return {
        "level": doc.get("level"),
        "headline": headline(doc),
        "destination": _short((doc.get("destination") or {}).get("name"), NAME_CHARS) if moving else None,
        "route_via": [_short(v, NAME_CHARS) for v in (route.get("via") or [])[:MAX_VIA]] if moving else [],
        "eta_min": route.get("eta_min") if moving else None,
        "route_km": round(distance_m / 1000.0, 1) if moving and isinstance(distance_m, (int, float)) else None,
        "no_route": bool(doc.get("no_route")),
        "reason": _short(doc.get("reason"), TEXT_CHARS),
        "caveat": _short(doc.get("caveat"), TEXT_CHARS),
        "options": options,
        "source": guidance_source(doc),
        "version": doc.get("version"),
        "as_of": _iso_any(_as_of(doc)),
    }


def guidance_history(incident_id: str, zone_id: str, before_version: int | None) -> list[dict[str, Any]]:
    """Up to MAX_HISTORY earlier published versions of the zone's guidance, newest first.
    ``live_guidance`` is append-only (one document per version) until a drill reset."""
    if not isinstance(before_version, int):
        return []
    docs = (
        col("live_guidance")
        .find(
            {"incident_id": incident_id, "zone_id": zone_id, "version": {"$lt": before_version}},
            {
                "_id": 0,
                "level": 1,
                "no_route": 1,
                "route.via": 1,
                "reason": 1,
                "version": 1,
                "replay_at": 1,
                "published_at": 1,
            },
        )
        .sort("version", -1)
        .limit(MAX_HISTORY)
    )
    return [
        {
            "version": d.get("version"),
            "level": d.get("level"),
            "headline": headline(d),
            "reason": _short(d.get("reason"), 120),
            "as_of": _iso_any(_as_of(d)),
        }
        for d in docs
    ]


# ---- hazards, shelters, fire ----


def _road_keys(name: str) -> set[str]:
    """Spoken forms of a road name to look for in a transcript: "pentz road" and "pentz"."""
    full = " ".join(re.findall(r"[a-z0-9]+", name.lower()))
    keys = {full} if full else set()
    words = full.split()
    if len(words) > 1 and words[-1] in ROAD_SUFFIXES:
        core = " ".join(words[:-1])
        if len(core) >= 4:
            keys.add(core)
    return keys


def _mentioned(name: str | None, said: str) -> bool:
    if not name or not said:
        return False
    return any(re.search(rf"\b{re.escape(k)}\b", said) for k in _road_keys(name))


def hazard_status(item: PublicItem) -> str:
    """Why the item is public (livecore.public ``is_public``): ``confirmed`` by incident
    command, ``responder_corroborated`` (a responder and a civilian), else ``corroborated``
    (three or more independent people)."""
    if item.controller_confirmed:
        return "confirmed"
    return "responder_corroborated" if item.responder_reports >= 1 else "corroborated"


def hazard_facts(snapshot: Snapshot, zone: MultiPolygon | None, transcript: str) -> tuple[list[dict[str, Any]], int]:
    """(nearest MAX_HAZARDS public items, how many public items there are). Items on a road named
    in ``transcript`` come first, then by distance, then newest."""
    index = snapshot.index
    said = " ".join(re.findall(r"[a-z0-9]+", (transcript or "").lower()))
    rows = []
    for item in snapshot.items:
        road = (item.segment_name or "Unnamed road") if item.segment_id else None
        km = point_km(zone, item.coord)
        dest = index.destinations.get(item.destination_id) if item.destination_id else None
        rows.append(
            (
                0 if _mentioned(item.segment_name if item.segment_id else None, said) else 1,
                km if km is not None else math.inf,
                -item.last_observed_at.timestamp(),
                item.id,
                {
                    "kind": item.kind,
                    "severity": item.severity,
                    "road": _short(road, NAME_CHARS),
                    "place": _short(dest.name, NAME_CHARS) if dest else None,
                    "status": hazard_status(item),
                    "reports": len(item.report_ids),
                    "people": item.independent_parties + item.responder_reports,
                    "last_reported_at": iso(item.last_observed_at),
                    "ago": age_text(_minutes_between(item.last_observed_at, snapshot.now)),
                    "km_from_zone": km,
                },
            )
        )
    rows.sort(key=lambda r: r[:4])
    return [r[4] for r in rows[:MAX_HAZARDS]], len(rows)


def shelter_facts(snapshot: Snapshot, zone: MultiPolygon | None) -> list[dict[str, Any]]:
    """The nearest MAX_SHELTERS shelter / temporary-refuge destinations and whether a public
    ``shelter_full`` item names them (since its first report)."""
    full: dict[str, PublicItem] = {}
    for item in snapshot.items:
        if item.kind == "shelter_full" and item.destination_id:
            prev = full.get(item.destination_id)
            if prev is None or item.first_reported_at < prev.first_reported_at:
                full[item.destination_id] = item
    rows = []
    for order, dest in enumerate(snapshot.index.drill.destinations):
        if dest.kind not in SHELTER_KINDS:
            continue
        km = point_km(zone, dest.coord)
        report = full.get(dest.id)
        rows.append(
            (
                km if km is not None else math.inf,
                order,
                {
                    "name": _short(dest.name, NAME_CHARS),
                    "kind": dest.kind,
                    "km_from_zone": km,
                    "reported_full": report is not None,
                    "full_reported_at": iso(report.first_reported_at) if report else None,
                    "full_ago": age_text(_minutes_between(report.first_reported_at, snapshot.now)) if report else None,
                },
            )
        )
    rows.sort(key=lambda r: r[:2])
    return [r[2] for r in rows[:MAX_SHELTERS]]


def fire_facts(snapshot: Snapshot, zone: MultiPolygon | None) -> dict[str, Any] | None:
    """The current fire estimate (its own method, label and drill time), or None without one."""
    fire = snapshot.fire
    if fire.method == "none" or fire.as_of is None:
        return None
    age_min = _minutes_between(fire.as_of, snapshot.clock.replay_now)
    km = None
    if zone is not None and fire.geometry is not None:
        km = round(distance_km(zone, fire.geometry), 1)
    return {
        "method": fire.method,
        "label": fire.label,
        "evidence_class": fire.evidence_class,
        "as_of": iso(fire.as_of),
        "age": age_text(age_min),
        "age_min": age_min,
        "km_from_zone": km,
        "zone_inside": (km == 0.0) if km is not None else None,
    }


# ---- assembly ----


def _bounded(facts: dict[str, Any]) -> dict[str, Any]:
    """Drop list tails until the JSON fits MAX_FACTS_CHARS (hazards, then shelters, history, options)."""
    trims: Sequence[tuple[str, ...]] = (("hazards",), ("shelters",), ("guidance_history",), ("guidance", "options"))
    for path in trims:
        while len(json.dumps(facts, ensure_ascii=False)) > MAX_FACTS_CHARS:
            parent: Any = facts
            for key in path[:-1]:
                parent = parent.get(key) if isinstance(parent, dict) else None
            items = parent.get(path[-1]) if isinstance(parent, dict) else None
            if not items:
                break
            items.pop()
            facts["truncated"] = True
    return facts


def build_facts(incident_id: str, zone_id: str | None, transcript: str, now: datetime | None = None) -> dict[str, Any]:
    """Facts for one voice turn. ``zone_id`` must already be a zone of the incident (or None).
    Raises on a data error; the caller decides what a failure means for the turn."""
    snapshot = load_snapshot(incident_id, now or wall_now())
    index = snapshot.index
    zone = index.zones.get(zone_id) if zone_id else None
    geometry = zone.geometry if zone else None
    published = None
    if zone is not None:
        published = next((g for g in rendered_guidance(incident_id, index) if g.get("zone_id") == zone.id), None)
    hazards, hazards_total = hazard_facts(snapshot, geometry, transcript)
    facts = {
        "as_of": iso(snapshot.clock.replay_now),
        "drill": _short(index.drill.label, TEXT_CHARS),
        "zone": {"id": zone.id, "name": _short(zone.name, NAME_CHARS)} if zone else None,
        "guidance": guidance_facts(published),
        "guidance_history": guidance_history(incident_id, zone.id, (published or {}).get("version")) if zone else [],
        "hazards": hazards,
        "hazards_total": hazards_total,
        "shelters": shelter_facts(snapshot, geometry),
        "fire": fire_facts(snapshot, geometry),
    }
    return _bounded(facts)
