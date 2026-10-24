"""The drill: replay bundle data (Camp, or a Studio drill package) and the drill clock.

Bundle format: docs/replay-bundle.md. Clock contract: docs/live-reports.md "Drill clock".
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from .geo import LonLat, MultiPolygon, to_geojson, to_multipolygon

INCIDENT_ID = "camp-2018-drill"
DRILL_LABEL = "Drill: 2018 Camp Fire replay. Not a real incident."
INCIDENT_NAME = "Camp Fire 2018 exercise"
IncidentMode = Literal["exercise", "live"]
REPLAY_INCIDENT_MODE: IncidentMode = "exercise"
"""A replay bundle is never a real incident, so a drill's mode is always ``exercise``;
``live`` is reserved for a real incident feed (none exists)."""
DEFAULT_REPLAY_START = datetime(2018, 11, 8, 15, 0, 0, tzinfo=UTC)
"""Drill time the clock starts from unless the controller picks another (bundle start is 14:00Z)."""
MAX_DRILL_SPEED = 60.0
"""Drill seconds per wall second. 0 pauses the clock."""

DestinationKind = Literal["exit", "shelter", "temporary_refuge"]


@dataclass(frozen=True)
class Edge:
    """One directed road edge from ``roads.edges``. Both directions of a road share ``segment_id``."""

    id: str
    segment_id: str
    from_node: str
    to_node: str
    name: str | None
    highway: str
    lanes: int
    speed_kph: float
    capacity_veh_per_hour: float
    length_m: float
    coords: tuple[LonLat, ...]


@dataclass(frozen=True)
class RoadGraph:
    """Directed road graph. Built once per process by ``load_drill``."""

    edges: Mapping[str, Edge]
    """Edge id -> edge."""
    out_edges: Mapping[str, tuple[str, ...]]
    """Node id -> ids of edges leaving it."""
    in_edges: Mapping[str, tuple[str, ...]]
    """Node id -> ids of edges entering it (for the reverse multi-source search)."""
    node_coords: Mapping[str, LonLat]
    """Node id -> position (an edge's first/last coordinate)."""
    segment_edges: Mapping[str, tuple[str, ...]]
    """Segment id -> its one or two directed edge ids."""


@dataclass(frozen=True)
class Zone:
    """An evacuation zone (``zones.features``; census block groups, evidence_class derived)."""

    id: str
    name: str
    households: int
    vehicles: int
    geometry: MultiPolygon


@dataclass(frozen=True)
class Destination:
    """``destinations.features``. ``capacity_veh`` is None when unknown."""

    id: str
    name: str
    kind: DestinationKind
    coord: LonLat
    capacity_veh: int | None


@dataclass(frozen=True)
class FireSnapshot:
    """A fire area at one drill time: an observed perimeter or a simulated front."""

    at: datetime
    geometry: MultiPolygon
    source: Literal["perimeter", "front"]
    """``perimeter`` = ``fire.perimeters`` (observed/reconstructed); ``front`` = ``fire_simulated.fronts``."""
    evidence_class: str
    """As in the bundle: ``reconstructed`` / ``observed`` for perimeters, ``simulated`` for fronts."""


@dataclass(frozen=True)
class FireObservation:
    """A point where fire was present at ``at`` (drill time)."""

    id: str
    at: datetime
    coord: LonLat
    source: Literal["nist_reconstructed", "field_report"]


@dataclass(frozen=True)
class Drill:
    """Everything static about one drill, loaded from a replay bundle."""

    incident_id: str
    label: str
    clock_start: datetime
    clock_end: datetime
    zones: tuple[Zone, ...]
    zones_version: str
    """Opaque; changes when any zone id or geometry changes (e.g. ``"zones-" + sha1[:8]``)."""
    destinations: tuple[Destination, ...]
    roads: RoadGraph
    perimeters: tuple[FireSnapshot, ...]
    """Sorted by ``at`` ascending."""
    fronts: tuple[FireSnapshot, ...]
    """Sorted by ``at`` ascending."""
    observations: tuple[FireObservation, ...]
    """Bundle ``fire_observations`` (source ``nist_reconstructed``), sorted by ``at``."""
    fire_model: str
    """``fire_simulated.model`` identifier, e.g. ``rothermel-mtt``, for labels and proposal inputs."""
    name: str = INCIDENT_NAME
    mode: IncidentMode = REPLAY_INCIDENT_MODE
    """Served to clients as ``incident.mode``; the phone shows an Exercise tag unless ``live``."""


def parse_time(value: Any) -> datetime:
    """Parse an ISO 8601 time (``Z`` or offset) to an aware UTC datetime. Raises ``ValueError``."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError(f"malformed time: {value!r}")
    if dt.tzinfo is None:
        raise ValueError(f"time without timezone: {value!r}")
    return dt.astimezone(UTC)


def _req(mapping: Any, key: str, where: str) -> Any:
    if not isinstance(mapping, Mapping) or key not in mapping:
        raise ValueError(f"bundle: missing {where}.{key}")
    return mapping[key]


def _coord(value: Any, where: str) -> LonLat:
    try:
        return (float(value[0]), float(value[1]))
    except (TypeError, ValueError, IndexError) as exc:
        raise ValueError(f"bundle: malformed coordinate in {where}") from exc


def _features(section: Any, where: str) -> list[Any]:
    feats = section.get("features") if isinstance(section, Mapping) else section
    if not isinstance(feats, list):
        raise ValueError(f"bundle: {where}.features must be a list")
    return feats


def _props(feature: Mapping[str, Any]) -> Mapping[str, Any]:
    """Bundle features are flat; tolerate GeoJSON-style ``properties`` too."""
    props = feature.get("properties")
    if isinstance(props, Mapping):
        return {**props, **{k: v for k, v in feature.items() if k != "properties"}}
    return feature


def _road_graph(raw_edges: Any) -> RoadGraph:
    if not isinstance(raw_edges, list) or not raw_edges:
        raise ValueError("bundle: roads.edges must be a non-empty list")
    edges: dict[str, Edge] = {}
    out_edges: dict[str, list[str]] = {}
    in_edges: dict[str, list[str]] = {}
    node_coords: dict[str, LonLat] = {}
    segment_edges: dict[str, list[str]] = {}
    for raw in raw_edges:
        try:
            coords = tuple((float(c[0]), float(c[1])) for c in raw["coords"])
            if len(coords) < 2:
                raise ValueError("edge needs two coordinates")
            edge = Edge(
                id=str(raw["id"]),
                segment_id=str(raw.get("segment_id") or raw["id"]),
                from_node=str(raw["from_node"]),
                to_node=str(raw["to_node"]),
                name=raw.get("name") or None,
                highway=str(raw.get("highway") or "road"),
                lanes=int(raw.get("lanes") or 1),
                speed_kph=float(raw["speed_kph"]),
                capacity_veh_per_hour=float(raw.get("capacity_veh_per_hour") or 0.0),
                length_m=float(raw["length_m"]),
                coords=coords,
            )
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise ValueError(f"bundle: malformed road edge {raw.get('id') if isinstance(raw, Mapping) else raw!r}") from exc
        if edge.speed_kph <= 0 or edge.length_m < 0:
            raise ValueError(f"bundle: edge {edge.id} has non-positive speed or negative length")
        edges[edge.id] = edge
        out_edges.setdefault(edge.from_node, []).append(edge.id)
        in_edges.setdefault(edge.to_node, []).append(edge.id)
        node_coords.setdefault(edge.from_node, coords[0])
        node_coords.setdefault(edge.to_node, coords[-1])
        segment_edges.setdefault(edge.segment_id, []).append(edge.id)
    return RoadGraph(
        edges=edges,
        out_edges={k: tuple(v) for k, v in out_edges.items()},
        in_edges={k: tuple(v) for k, v in in_edges.items()},
        node_coords=node_coords,
        segment_edges={k: tuple(v) for k, v in segment_edges.items()},
    )


def _snapshots(raw: Any, source: Literal["perimeter", "front"], where: str) -> tuple[FireSnapshot, ...]:
    if not isinstance(raw, list):
        raise ValueError(f"bundle: {where} must be a list")
    out = []
    for item in raw:
        evidence = str(item.get("evidence_class") or ("simulated" if source == "front" else "reconstructed"))
        out.append(FireSnapshot(
            at=parse_time(_req(item, "at", where)),
            geometry=to_multipolygon(_req(item, "geometry", where)),
            source=source,
            evidence_class=evidence,
        ))
    return tuple(sorted(out, key=lambda s: s.at))


def load_drill(bundle_path: str | Path, incident_id: str = INCIDENT_ID) -> Drill:
    """Parse a replay bundle (``app/public/replays/camp-2018.json``) into a ``Drill``.

    Reads ``clock``, ``roads.edges``, ``zones.features``, ``destinations.features``,
    ``fire.perimeters``, ``fire_simulated`` and ``fire_observations``. Raises ``ValueError``
    on a missing key or malformed geometry. Slow (18 MB JSON): callers cache the result.
    """
    with open(bundle_path, encoding="utf-8") as fh:
        bundle = json.load(fh)
    if not isinstance(bundle, Mapping):
        raise ValueError("bundle: top level must be an object")

    clock = _req(bundle, "clock", "bundle")
    clock_start = parse_time(_req(clock, "start", "clock"))
    clock_end = parse_time(_req(clock, "end", "clock"))
    if clock_end <= clock_start:
        raise ValueError("bundle: clock.end must be after clock.start")

    roads = _road_graph(_req(_req(bundle, "roads", "bundle"), "edges", "roads"))

    zones: list[Zone] = []
    for feat in _features(_req(bundle, "zones", "bundle"), "zones"):
        p = _props(feat)
        zones.append(Zone(
            id=str(_req(p, "id", "zones")),
            name=str(p.get("name") or p["id"]),
            households=int(p.get("households") or 0),
            vehicles=int(p.get("vehicles") or 0),
            geometry=to_multipolygon(_req(p, "geometry", "zones")),
        ))
    digest = hashlib.sha1()
    for z in zones:
        digest.update(z.id.encode())
        digest.update(json.dumps(to_geojson(z.geometry)["coordinates"], separators=(",", ":")).encode())
    zones_version = "zones-" + digest.hexdigest()[:8]

    destinations: list[Destination] = []
    for feat in _features(_req(bundle, "destinations", "bundle"), "destinations"):
        p = _props(feat)
        kind = p.get("kind")
        if kind not in ("exit", "shelter", "temporary_refuge"):
            raise ValueError(f"bundle: destination {p.get('id')!r} has unknown kind {kind!r}")
        coord = p.get("coord")
        if coord is None and isinstance(p.get("geometry"), Mapping):
            coord = p["geometry"].get("coordinates")
        cap = p.get("capacity_veh")
        destinations.append(Destination(
            id=str(_req(p, "id", "destinations")),
            name=str(p.get("name") or p["id"]),
            kind=kind,
            coord=_coord(coord, "destinations"),
            capacity_veh=int(cap) if cap is not None else None,
        ))

    perimeters = _snapshots(_req(_req(bundle, "fire", "bundle"), "perimeters", "fire"), "perimeter", "fire.perimeters")
    simulated = _req(bundle, "fire_simulated", "bundle")
    fronts = _snapshots(_req(simulated, "fronts", "fire_simulated"), "front", "fire_simulated.fronts")
    model = simulated.get("model")
    fire_model = str(model.get("id") or "model") if isinstance(model, Mapping) else str(model or "model")

    observations: list[FireObservation] = []
    for feat in _features(_req(bundle, "fire_observations", "bundle"), "fire_observations"):
        p = _props(feat)
        coord = p.get("coord")
        if coord is None and isinstance(p.get("geometry"), Mapping):
            coord = p["geometry"].get("coordinates")
        observations.append(FireObservation(
            id=str(_req(p, "id", "fire_observations")),
            at=parse_time(_req(p, "at", "fire_observations")),
            coord=_coord(coord, "fire_observations"),
            source="nist_reconstructed",
        ))
    observations.sort(key=lambda o: (o.at, o.id))

    return Drill(
        incident_id=incident_id,
        label=DRILL_LABEL,
        clock_start=clock_start,
        clock_end=clock_end,
        zones=tuple(zones),
        zones_version=zones_version,
        destinations=tuple(destinations),
        roads=roads,
        perimeters=perimeters,
        fronts=fronts,
        observations=tuple(observations),
        fire_model=fire_model,
    )


def default_replay_start(drill: Drill) -> datetime:
    """Where the drill clock starts unless the controller picks a time: ``DEFAULT_REPLAY_START``
    for the Camp replay, else the drill's ``clock_start`` (a Studio package starts at T+0)."""
    if drill.clock_start <= DEFAULT_REPLAY_START < drill.clock_end:
        return DEFAULT_REPLAY_START
    return drill.clock_start


def replay_now(
    replay_start: datetime,
    started_at: datetime | None,
    wall_now: datetime,
    speed: float,
    clock_end: datetime | None = None,
) -> datetime:
    """Current drill time: ``replay_start + (wall_now - started_at) * speed``.

    ``started_at`` None (stopped) returns ``replay_start``. The result is clamped to
    ``clock_end`` when given and never earlier than ``replay_start``. All arguments are
    timezone-aware UTC; ``speed`` is drill seconds per wall second (0..MAX_DRILL_SPEED).
    """
    if started_at is None:
        now = replay_start
    else:
        elapsed_s = max((wall_now - started_at).total_seconds(), 0.0)
        speed = min(max(float(speed), 0.0), MAX_DRILL_SPEED)
        now = replay_start + timedelta(seconds=elapsed_s * speed)
    if clock_end is not None and now > clock_end:
        now = clock_end
    return max(now, replay_start)
