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
tracktype, smoothness, width, maxweight or maxheight tags, so its roads are judged on the
highway class alone with the documented defaults (paved, default width by class). Grade is 0%
(ASSUMPTION: the bundle has no elevation per edge) and the dead-end rule R10 is not applied
(the bundle has no turning-circle nodes). Speeds are km/h, distances metres, coordinates WGS84
``(lon, lat)``.
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

log = logging.getLogger(__name__)

ACCESS_CLASSES = ("engine_t1_t2", "engine_t3", "engine_t4_t7", "tender_support", "tender_tactical")
"""Road-access vehicle classes of the decision table (docs/suppression-data.md)."""
GROUND_KINDS = frozenset({
    "engine_t1", "engine_t3", "engine_t6", "hand_crew_t1", "hand_crew_t2", "dozer_t1", "dozer_t2",
    "tender_support", "tender_tactical", "chief",
})
"""Studio ground apparatus kinds (app/src/studio/apparatus.ts GROUND_KINDS), as a responder may declare on join."""
DEFAULT_CLASS = "engine_t3"
"""CAL FIRE Type 3 engine, the data's default state engine."""
STATION_TYPES = frozenset({"FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"})
"""CAL FIRE-layer facility types that are fire stations (tools/suppression_data.py)."""

BASIS_HIGHWAY_ONLY = (
    "road access: highway class only (the drill bundle has no surface, width, weight or grade tags; "
    "documented defaults by class), grade 0% assumed, dead-end rule R10 not applied"
)
BASIS_TAGGED = "road access: OSM tags of the drill bundle where present, else defaults by class; grade 0% assumed"

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


_profiles: dict[tuple[int, str], tuple[Drill, AccessProfile]] = {}


def class_label(vehicle: str) -> str:
    loaded = suppression()
    if loaded is None:
        return vehicle
    return str(loaded[0]["road_access"]["vehicle_classes"][vehicle].get("label") or vehicle)


def access_profile(drill: Drill, vehicle: str = DEFAULT_CLASS) -> AccessProfile | None:
    """Access of every drill edge for ``vehicle`` (cached per drill and class); None without data.

    Raises ``ValueError`` for an unknown class."""
    if vehicle not in ACCESS_CLASSES:
        raise ValueError(f"unknown apparatus class {vehicle!r}; one of {', '.join(ACCESS_CLASSES)}")
    hit = _profiles.get((id(drill), vehicle))
    if hit is not None and hit[0] is drill:
        return hit[1]
    loaded = suppression()
    if loaded is None:
        return None
    data, road_access = loaded
    edges: dict[str, EdgeAccess] = {}
    tagged = False
    for eid, edge in drill.roads.edges.items():
        tags = dict(edge.tags)
        tagged = tagged or bool(tags)
        tags["highway"] = normalise_highway(tags.get("highway") or edge.highway)
        if edge.bridge and "bridge" not in tags:
            tags["bridge"] = "yes"
        tags.setdefault("maxspeed", str(max(1, round(edge.speed_kph))))
        result = road_access(data, tags, 0.0, vehicle)
        notes = result.get("notes") or []
        edges[eid] = EdgeAccess(bool(result["passable"]), result.get("speed_kph"), str(result["rule"]),
                                str(notes[-1]) if notes else str(result["rule"]))
    profile = AccessProfile(vehicle, class_label(vehicle), edges, BASIS_TAGGED if tagged else BASIS_HIGHWAY_ONLY)
    if len(_profiles) > 16:
        _profiles.clear()
    _profiles[(id(drill), vehicle)] = (drill, profile)
    return profile


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
