"""Drill injects: scripted or instructor-triggered events that stress a plan (docs/live-reports.md "Injects").

Pure rules, no Django or database. An inject is ``{type, params, at, ...}`` where ``at`` is drill
time (UTC). Every inject is simulated and labeled; nothing is sent to real people.

========================  =====================================================  =============================
type                      params                                                 effect
========================  =====================================================  =============================
``psap_reroute``          ``zone_ids`` [str], optional ``until`` (ISO Z),         911 stream of the zones is
                          optional ``to`` (label, e.g. "Chico PSAP")              dropped from ``at`` (to ``until``)
``comms_outage``          ``zone_ids`` [str], ``until`` (ISO Z)                   phone traffic from the zones
                                                                                  is refused from ``at`` to ``until``
``silent_closure``        ``segment_id``                                          closed in the twin from ``at``;
                                                                                  no report exists
``shelter_full``          ``destination_id``                                      full in the twin from ``at``
``fire_jump``             ``coord`` [lon, lat], optional ``radius_m``              a labeled spot fire in the
                                                                                  fire estimate from ``at``
========================  =====================================================  =============================
"""

from __future__ import annotations

import math
from collections.abc import Callable, Collection, Iterable, Mapping
from datetime import datetime
from typing import Any

from .geo import LonLat, MultiPolygon

TYPES = ("psap_reroute", "comms_outage", "silent_closure", "shelter_full", "fire_jump")
STATUSES = ("scheduled", "active", "ended")
SPOT_RADIUS_M = 150.0
MAX_SPOT_RADIUS_M = 1000.0
LABEL_PREFIX = "Injected (simulated)"
SPOT_LABEL = "injected spot fire (simulated)"
SPOT_VERTICES = 16
METERS_PER_DEG_LAT = 111_320.0


class InjectError(ValueError):
    """Invalid inject; ``str(exc)`` is safe to show to the instructor."""


def _zones(value: Any, known: Collection[str]) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(z, str) for z in value):
        raise InjectError("`params.zone_ids` must be a non-empty list of zone ids.")
    unknown = [z for z in value if z not in known]
    if unknown:
        raise InjectError(f"Unknown zone: {unknown[0]}.")
    return list(dict.fromkeys(value))


def normalize_params(
    kind: Any,
    params: Any,
    at: datetime,
    *,
    zones: Collection[str],
    destinations: Mapping[str, str],
    segments: Collection[str],
    parse_time: Callable[[Any, str], datetime],
) -> dict[str, Any]:
    """Validated params of an inject of type ``kind`` (unknown keys dropped).

    ``destinations`` maps id -> kind; ``parse_time(value, field)`` parses an ISO time with Z to
    an aware datetime and raises ``InjectError``."""
    if kind not in TYPES:
        raise InjectError(f"`type` must be one of {', '.join(TYPES)}.")
    if not isinstance(params, dict):
        raise InjectError("`params` must be an object.")
    out: dict[str, Any] = {}

    def until(required: bool) -> None:
        raw = params.get("until")
        if raw is None:
            if required:
                raise InjectError("`params.until` is required.")
            return
        end = parse_time(raw, "params.until")
        if end <= at:
            raise InjectError("`params.until` must be after `at`.")
        out["until"] = end

    if kind in ("psap_reroute", "comms_outage"):
        out["zone_ids"] = _zones(params.get("zone_ids"), zones)
        until(required=kind == "comms_outage")
        if kind == "psap_reroute":
            to = params.get("to")
            if to is not None:
                if not isinstance(to, str) or len(to) > 80:
                    raise InjectError("`params.to` must be a string of at most 80 characters.")
                out["to"] = to.strip() or None
    elif kind == "silent_closure":
        seg = params.get("segment_id")
        if not isinstance(seg, str) or seg not in segments:
            raise InjectError("`params.segment_id` must be a known road segment.")
        out["segment_id"] = seg
    elif kind == "shelter_full":
        dest = params.get("destination_id")
        if not isinstance(dest, str) or dest not in destinations:
            raise InjectError("`params.destination_id` must be a known destination.")
        if destinations[dest] == "exit":
            raise InjectError("An exit cannot fill up; pick a shelter or refuge.")
        out["destination_id"] = dest
    else:  # fire_jump
        coord = params.get("coord")
        if (not isinstance(coord, list) or len(coord) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in coord)
                or not (-180 <= coord[0] <= 180 and -90 <= coord[1] <= 90)):
            raise InjectError("`params.coord` must be [lon, lat].")
        out["coord"] = [float(coord[0]), float(coord[1])]
        radius = params.get("radius_m", SPOT_RADIUS_M)
        if (not isinstance(radius, (int, float)) or isinstance(radius, bool)
                or not 10 <= radius <= MAX_SPOT_RADIUS_M):
            raise InjectError(f"`params.radius_m` must be 10..{MAX_SPOT_RADIUS_M:g} m.")
        out["radius_m"] = float(radius)
    return out


def end_of(kind: str, params: Mapping[str, Any]) -> datetime | None:
    return params.get("until") if kind in ("psap_reroute", "comms_outage") else None


def status_at(kind: str, at: datetime, params: Mapping[str, Any], replay_now: datetime) -> str:
    """``scheduled`` before ``at``; ``active`` from ``at`` until the end (never ends without one);
    ``ended`` once ``until`` has passed."""
    if replay_now < at:
        return "scheduled"
    end = end_of(kind, params)
    return "ended" if end is not None and replay_now >= end else "active"


def label(kind: str, params: Mapping[str, Any], names: Mapping[str, str] | None = None) -> str:
    """One labeled line for lists and logs. ``names`` maps zone/destination/segment id -> name."""
    names = names or {}

    def zone_names() -> str:
        ids = params.get("zone_ids") or []
        shown = ", ".join(names.get(z, z) for z in ids[:3])
        return shown + (f" (+{len(ids) - 3})" if len(ids) > 3 else "")

    if kind == "psap_reroute":
        return f"{LABEL_PREFIX}: 911 for {zone_names()} rerouted" + (f" to {params['to']}" if params.get("to") else "")
    if kind == "comms_outage":
        return f"{LABEL_PREFIX}: no phone signal in {zone_names()}"
    if kind == "silent_closure":
        return f"{LABEL_PREFIX}: {names.get(params.get('segment_id'), 'road')} closed, no report"
    if kind == "shelter_full":
        return f"{LABEL_PREFIX}: {names.get(params.get('destination_id'), 'destination')} full"
    return f"{LABEL_PREFIX}: spot fire"


Window = tuple[datetime, datetime | None]


def zone_windows(injects: Iterable[Mapping[str, Any]], kind: str) -> dict[str, list[Window]]:
    """Zone id -> ``[(from, until or None)]`` of the injects of ``kind``, whatever their status."""
    out: dict[str, list[Window]] = {}
    for inj in injects:
        if inj["type"] != kind:
            continue
        window = (inj["at"], end_of(kind, inj["params"]))
        for zone in inj["params"].get("zone_ids", ()):
            out.setdefault(zone, []).append(window)
    return out


def in_window(windows: Iterable[Window], t: datetime) -> bool:
    return any(start <= t and (end is None or t < end) for start, end in windows)


def circle(coord: LonLat, radius_m: float, vertices: int = SPOT_VERTICES) -> MultiPolygon:
    """A small closed polygon around ``coord`` (equirectangular, fine at 1 km)."""
    lon0, lat0 = coord
    dlat = radius_m / METERS_PER_DEG_LAT
    dlon = dlat / max(math.cos(math.radians(lat0)), 1e-6)
    ring = [
        (lon0 + dlon * math.cos(2 * math.pi * i / vertices), lat0 + dlat * math.sin(2 * math.pi * i / vertices))
        for i in range(vertices)
    ]
    ring.append(ring[0])
    return ((tuple(ring),),)


def spots_due(injects: Iterable[Mapping[str, Any]], replay_now: datetime) -> list[tuple[datetime, LonLat, float]]:
    """``(at, coord, radius_m)`` of fire jumps with ``at <= replay_now``, oldest first."""
    out = [
        (i["at"], (i["params"]["coord"][0], i["params"]["coord"][1]), float(i["params"]["radius_m"]))
        for i in injects
        if i["type"] == "fire_jump" and i["at"] <= replay_now
    ]
    out.sort()
    return out
