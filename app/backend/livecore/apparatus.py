"""Fire apparatus for live responder routing: road access per vehicle class, station apparatus
and turnout, from the sourced suppression data (docs/suppression-data.md).

Reads ``tools/suppression_resources.json`` and calls ``tools.suppression_data.road_access``
(rules R01-R12, the reference implementation) from the repository root
(``CRISISTWIN_REPO_ROOT``, else four levels above this file; docker-compose mounts ``tools``
at ``/repo/tools``). Without them every function here answers ``None`` and callers fall back
to the drill's own edge speeds, which they label.

What the drill road graph gives the rules: its ``highway`` class (``*_link`` takes its parent
class and ``living_street`` is residential, the same ASSUMPTION as app/src/studio/roadAccess.ts),
the bundle's ``bridge`` flag, the edge speed as ``maxspeed`` (the bundle's OSM maxspeed or its
class default), and any OSM ``tags`` an edge carries. The camp-2018 bundle carries no surface,
tracktype, smoothness, width, maxweight or maxheight tags; a ``livecore.road_attrs.RoadAttrs``
(OSM tags fetched by way id, grade per segment from the 3DEP DEM; ``api.drill_road_attrs``)
fills them in. Without one, roads are judged on the highway class alone with the documented
defaults (paved, default width by class) and grade 0% (ASSUMPTION). The dead-end rule R10 is not
applied (the bundle has no turning-circle nodes). Speeds are km/h, distances metres, coordinates
WGS84 ``(lon, lat)``.
"""

from __future__ import annotations

import logging
import math
import os
import sys
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .drill import Drill
from .geo import LonLat, haversine_m
from .road_attrs import RoadAttrs

log = logging.getLogger(__name__)

ACCESS_CLASSES = ("engine_t1_t2", "engine_t3", "engine_t4_t7", "tender_support", "tender_tactical")
"""Road-access vehicle classes of the decision table (docs/suppression-data.md)."""
DEFAULT_CLASS = "engine_t3"
"""CAL FIRE Type 3 engine, the data's default state engine."""
STATION_TYPES = frozenset({"FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"})
"""CAL FIRE-layer facility types that are fire stations (tools/suppression_data.py)."""

BASIS_HIGHWAY_ONLY = (
    "road access: highway class only (the drill bundle has no surface, width, weight or grade tags; "
    "documented defaults by class), grade 0% assumed, dead-end rule R10 not applied"
)
BASIS_TAGGED = "road access: OSM tags of the drill bundle where present, else defaults by class; grade 0% assumed"

CLASS_SHORT = {
    "engine_t1_t2": "Type 1 engine",
    "engine_t3": "Type 3 engine",
    "engine_t4_t7": "Type 6 engine",
    "tender_support": "support tender or dozer transport",
    "tender_tactical": "tactical water tender",
}
"""Plain names for reasons shown to a commander (the board's dozers ride on a lowboy judged as a
support tender, app/src/studio/apparatus.ts)."""

_lock = threading.Lock()
_loaded: dict[str, Any] = {}


def repo_root() -> Path:
    env = os.environ.get("CRISISTWIN_REPO_ROOT")
    return Path(env) if env else Path(__file__).resolve().parents[3]


def suppression() -> tuple[dict, Callable[..., dict]] | None:
    """(resources data, ``road_access``) from the repository's tools, or None when absent."""
    with _lock:
        if "value" in _loaded:
            return _loaded["value"]
        value = None
        root = str(repo_root())
        try:
            if root not in sys.path:
                sys.path.append(root)
            from tools import suppression_data  # noqa: PLC0415 - optional, outside app/backend

            value = (suppression_data.load_resources(), suppression_data.road_access)
        except (ImportError, OSError, ValueError) as exc:
            log.warning("apparatus: suppression data unavailable under %s (%s); edge speeds used", root, exc)
        _loaded["value"] = value
        return value


def normalise_highway(highway: str) -> str:
    """ASSUMPTION (as roadAccess.ts): ``*_link`` takes its parent class, ``living_street`` is residential."""
    if highway.endswith("_link"):
        return highway[: -len("_link")]
    return "residential" if highway == "living_street" else highway


@dataclass(frozen=True)
class EdgeAccess:
    passable: bool
    speed_kph: float | None
    """Apparatus speed on the edge (None when not passable)."""
    rule: str
    """R01-R12 of docs/suppression-data.md."""
    note: str
    """The deciding reason (last note of ``road_access``)."""
    grade_pct: float | None = None
    """Grade the rules used (None: unknown, 0% assumed)."""
    unpaved: bool = False
    """The way's surface (tag or class default) is unpaved."""


@dataclass(frozen=True)
class AccessProfile:
    """One vehicle class's view of a drill's road graph."""

    vehicle: str
    label: str
    edges: Mapping[str, EdgeAccess]
    """Directed edge id -> access."""
    basis: str

    def passable(self, edge_id: str) -> bool:
        acc = self.edges.get(edge_id)
        return acc is not None and acc.passable

    def speed_kph(self, edge_id: str, fallback: float) -> float:
        acc = self.edges.get(edge_id)
        return acc.speed_kph if acc is not None and acc.speed_kph else fallback


_profiles: dict[tuple[int, str, int], tuple[Drill, AccessProfile, RoadAttrs | None]] = {}


def class_label(vehicle: str) -> str:
    loaded = suppression()
    if loaded is None:
        return vehicle
    return str(loaded[0]["road_access"]["vehicle_classes"][vehicle].get("label") or vehicle)


def _surface_unpaved(data: dict, tags: Mapping[str, str]) -> bool:
    ra = data["road_access"]
    surface = tags.get("surface") or ra["default_surface_by_highway"]["value"].get(tags.get("highway", ""), "paved")
    return not (surface in set(ra["paved_surfaces"]["value"]) or surface == "paved")


def access_profile(drill: Drill, vehicle: str = DEFAULT_CLASS, attrs: RoadAttrs | None = None) -> AccessProfile | None:
    """Access of every drill edge for ``vehicle`` (cached per drill, class and ``attrs``); None
    without data. ``attrs`` adds OSM tags and grade per segment (``livecore.road_attrs``).

    Raises ``ValueError`` for an unknown class."""
    if vehicle not in ACCESS_CLASSES:
        raise ValueError(f"unknown apparatus class {vehicle!r}; one of {', '.join(ACCESS_CLASSES)}")
    key = (id(drill), vehicle, id(attrs) if attrs is not None else 0)
    hit = _profiles.get(key)
    if hit is not None and hit[0] is drill and hit[2] is attrs:
        return hit[1]
    loaded = suppression()
    if loaded is None:
        return None
    data, road_access = loaded
    edges: dict[str, EdgeAccess] = {}
    tagged = False
    seg_tags = attrs.tags if attrs is not None else {}
    seg_grade = attrs.grade_pct if attrs is not None else {}
    for eid, edge in drill.roads.edges.items():
        tags = dict(edge.tags)
        extra = seg_tags.get(edge.segment_id)
        if extra:
            for k, v in extra.items():
                tags.setdefault(k, v)
        tagged = tagged or bool(tags)
        tags["highway"] = normalise_highway(tags.get("highway") or edge.highway)
        if edge.bridge and "bridge" not in tags:
            tags["bridge"] = "yes"
        tags.setdefault("maxspeed", str(max(1, round(edge.speed_kph))))
        grade = seg_grade.get(edge.segment_id)
        result = road_access(data, tags, grade or 0.0, vehicle)
        notes = result.get("notes") or []
        edges[eid] = EdgeAccess(bool(result["passable"]), result.get("speed_kph"), str(result["rule"]),
                                str(notes[-1]) if notes else str(result["rule"]), grade,
                                _surface_unpaved(data, tags))
    if attrs is not None and attrs.basis:
        basis = attrs.basis
    else:
        basis = BASIS_TAGGED if tagged else BASIS_HIGHWAY_ONLY
    profile = AccessProfile(vehicle, class_label(vehicle), edges, basis)
    if len(_profiles) > 16:
        _profiles.clear()
    _profiles[key] = (drill, profile, attrs)
    return profile


def plain_reason(vehicle: str, acc: EdgeAccess, road: str | None = None) -> str:
    """Why ``acc`` closes a road to ``vehicle``, for a commander, ending with the rule:
    e.g. ``"Unpaved road too steep (22%) for a Type 1 engine on Pentz Road (R06)"``."""
    who = CLASS_SHORT.get(vehicle, vehicle)
    kind = "unpaved road" if acc.unpaved else "paved road"
    grade = f" ({acc.grade_pct:.0f}%)" if acc.grade_pct is not None else ""
    text = {
        "R01": "Not a drivable road",
        "R02": "Closed to motor vehicles",
        "R03": f"Road surface too rough for a {who}",
        "R04": f"Unpaved road too rough for a {who}",
        "R05": f"Paved road too steep{grade} for a {who}",
        "R06": f"Unpaved road too steep{grade} for a {who}",
        "R07": f"Road too narrow for a {who}",
        "R08": f"Clearance too low for a {who}",
        "R09": f"Weight limit too low for a {who}" if "maxweight" in acc.note else f"Unrated bridge on an {kind} too weak for a {who}",
        "R10": f"Dead end with no turnaround for a {who}",
    }.get(acc.rule, f"Closed to a {who}")
    where = f" on {road}" if road else ""
    return f"{text}{where} ({acc.rule})"


# --- station apparatus -------------------------------------------------------------------


@dataclass(frozen=True)
class Apparatus:
    """One engine at a CAL FIRE-layer station."""

    station_id: str
    station: str
    agency: str
    coord: LonLat
    distance_km: float
    """Great-circle km from the incident point."""
    kind: str
    """Studio apparatus kind (app/src/studio/apparatus.ts): ``engine_t3`` or ``engine_t1``."""
    vehicle: str
    """Road-access class."""
    label: str
    turnout_s: float
    basis: str
    """Where its type, count and turnout come from (sourced or ASSUMPTION)."""
    unit_id: str | None = None
    """The engine's own id (a scenario snapshot ``engine_id``); None: the fleet numbers its units."""


def turnout_s(staffing: str | None) -> tuple[float, str]:
    """Turnout seconds by the layer's staffing code (P paid, V volunteer, C combined)."""
    loaded = suppression()
    if loaded is None:
        return 80.0, "turnout 80 s (ASSUMPTION: suppression data unavailable)"
    times = loaded[0]["response_times"]
    if staffing == "P":
        return float(times["turnout_s"]["value"]), "turnout NFPA 1710 80 s (response_times.turnout_s, source unverified)"
    return (float(times["wildland_turnout_s"]["value"]),
            "turnout 120 s (ASSUMPTION response_times.wildland_turnout_s: volunteer, combination or unknown staffing)")


def station_apparatus(bases: Iterable[Mapping[str, Any]], incident: LonLat, n_units: int,
                      on_network: Callable[[LonLat], bool]) -> list[Apparatus]:
    """The first ``n_units`` engines of the stations nearest ``incident`` that are on the network.

    Stations are CAL FIRE-layer fire stations (types FSA, FSB, FSAB, FSL, FSCC, FSO), nearest
    first by great-circle distance. A state-owned (CAL FIRE) station holds Type 3 engines (the
    data's default state engine), as many as the documented estimate of 1.6 engines per CAL
    FIRE-owned station gives: the k-th such station holds floor(1.6 k) - floor(1.6 (k - 1)),
    so 1, 2, 1, 2, 2, ... (ASSUMPTION, derived; the layer has no apparatus counts). Every other
    station holds one Type 1 structure engine (ASSUMPTION: no apparatus data for local
    stations). Turnout by staffing (``turnout_s``)."""
    loaded = suppression()
    per_state = 1.6
    if loaded is not None:
        per_state = float(loaded[0]["deployment"]["engines_per_station_estimate"]["value"])
    rows = []
    for base in bases:
        if base.get("type") not in STATION_TYPES:
            continue
        try:
            coord = (float(base["lon"]), float(base["lat"]))
        except (KeyError, TypeError, ValueError):
            continue
        rows.append((haversine_m(incident, coord), str(base.get("id")), coord, base))
    rows.sort(key=lambda r: (r[0], r[1]))
    out: list[Apparatus] = []
    state_k = 0
    for meters, sid, coord, base in rows:
        if len(out) >= n_units:
            break
        if not on_network(coord):
            continue
        state = base.get("owner") == "STATE" or str(base.get("agency", "")).startswith("CAL FIRE")
        turnout, turnout_basis = turnout_s(base.get("staffing"))
        if state:
            state_k += 1
            count = math.floor(per_state * state_k) - math.floor(per_state * (state_k - 1))
            kind, vehicle, label = "engine_t3", "engine_t3", "CAL FIRE Type 3 engine"
            basis = (f"type: CAL FIRE Type 3, the data's default state engine (WHEG 2013 Models 14/24/34); "
                     f"count: {per_state} engines per CAL FIRE-owned station (ASSUMPTION, derived); {turnout_basis}")
        else:
            count = 1
            kind, vehicle, label = "engine_t1", "engine_t1_t2", "Type 1 structure engine"
            basis = ("type and count: ASSUMPTION, one Type 1 structure engine (the CAL FIRE layer has no "
                     f"apparatus for local stations); {turnout_basis}")
        for _ in range(count):
            if len(out) >= n_units:
                break
            out.append(Apparatus(sid, str(base.get("name") or sid), str(base.get("agency") or ""), coord,
                                 round(meters / 1000, 1), kind, vehicle, label, turnout, basis))
    return out


SNAPSHOT_KINDS: dict[str, tuple[str, str, str]] = {
    "type3_engine": ("engine_t3", "engine_t3", "Type 3 engine"),
    "type1_engine": ("engine_t1", "engine_t1_t2", "Type 1 structure engine"),
}
"""Scenario snapshot engine kind -> (Studio apparatus kind, road-access class, label)."""


def snapshot_apparatus(stations: Iterable[Mapping[str, Any]], incident: LonLat | None) -> list[Apparatus]:
    """One unit per engine that is ``available`` at T+0 in a scenario resource snapshot
    (docs/scenario-snapshots.md): ``engine_id`` is the unit id, the station point its home.

    Committed and out-of-service engines never become units, so an engine can hold only the one
    task its unit holds. Ordered by distance from ``incident`` (station id when None), then
    engine id. Counts and availability are the snapshot's (synthetic); turnout is the
    unknown-staffing value (``turnout_s(None)``)."""
    turnout, turnout_basis = turnout_s(None)
    out: list[tuple[float, str, Apparatus]] = []
    for st in stations:
        lon, lat = (float(v) for v in st["location"]["coordinates"])
        meters = haversine_m(incident, (lon, lat)) if incident is not None else 0.0
        for engine in st.get("engines") or []:
            if engine.get("status_at_start") != "available":
                continue
            kind, vehicle, label = SNAPSHOT_KINDS.get(str(engine.get("kind")), SNAPSHOT_KINDS["type3_engine"])
            basis = (f"scenario snapshot engine {engine['engine_id']} ({engine.get('basis', 'synthetic')}: count, kind "
                     f"and availability are snapshot assumptions); station location {st.get('basis')}; {turnout_basis}")
            app = Apparatus(str(st["station_id"]), str(st.get("name") or st["station_id"]), "scenario snapshot",
                            (lon, lat), round(meters / 1000, 1), kind, vehicle, label, turnout, basis,
                            unit_id=str(engine["engine_id"]))
            out.append((meters, app.unit_id or "", app))
    out.sort(key=lambda r: (r[0], r[1]))
    return [a for _, _, a in out]
