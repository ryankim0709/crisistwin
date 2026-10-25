"""Simulated responder units for the live drill (ADR 0038-simulated-responders).

Pure and seeded: no clock, network or database. A ``Fleet`` of units starts at stations, takes
open tasks, drives ``inbound.inbound_route`` routes and closes the task, and every step it
returns the API calls a real responder phone would make (``join``, ``location``, ``accept``,
``report``, ``done``, ``cancel``) as dicts a driver can POST with responder tokens or apply
in-process. Times are drill seconds (the drill clock, never wall time), distances meters,
coordinates WGS84 ``(lon, lat)``.

Everything here is ``simulated``: the units, their on-scene times are the ASSUMPTION tables
below, and a verify answer is the simulation's ground truth (``World``), not an observation.

Apparatus (``Fleet(apparatus=...)``, ``livecore.apparatus.station_apparatus``): units start at
the real CAL FIRE-layer stations nearest the incident as engines of a road-access class (Type 3
at CAL FIRE stations, Type 1 at local ones; counts from the documented estimate, labelled).
With a scenario resource snapshot (``apparatus.snapshot_apparatus``) the fleet is instead one
unit per engine available at T+0, the snapshot's ``engine_id`` as the unit id; a unit holds at
most one task at a time. Each waits out its turnout (response-time data) before leaving its
station, routes only on roads its class may use (rules R01-R12 via ``inbound_route(access=...)``)
and drives at the class's speed on each edge. Without stations (no bases file) the units start at
``DEFAULT_STATIONS`` (or shelters) with the ``TYPE_ORDER`` table, labelled as a fallback.

Rules:

- Units never enter an edge whose segment is closed (known blocks, blocks a unit discovered,
  the ground-truth blocks, or an edge inside the fire estimate). A block it did not know about
  is discovered on arrival at the edge: the unit stops, remembers it and re-routes.
- A route that becomes blocked or unreachable is replanned from the end of the current edge;
  after ``UNREACHABLE_GIVEUP_S`` without a route the unit cancels the task with a note. A task
  only the unit's class rules keep it from (``no_access``) is cancelled at once, the blocking
  rule in the note: road tags do not change during a drill.
- An idle unit takes the nearest suitable open task by straight-line distance, the same
  rule as the console's "Send nearest".
"""

from __future__ import annotations

import math
import random
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from .apparatus import AccessProfile, Apparatus, access_profile, station_apparatus
from .drill import Drill
from .geo import LonLat, MultiPolygon, haversine_m
from .inbound import INBOUND_SNAP_MAX_M, _end_nodes, inbound_route
from .routing import _INSIDE, _fire_classes, _index, _nearest_node

TaskKind = Literal["verify", "assist"]
Call = dict[str, Any]


@dataclass(frozen=True)
class UnitType:
    """ASSUMPTION row: how fast a unit type drives and what it can take."""

    name: str
    speed_factor: float
    """Multiplier of an edge's speed limit (emergency driving with lights, or a heavy engine)."""
    on_scene_s: Mapping[str, float]
    """Task kind -> mean seconds on scene before the task closes. The keys are the kinds it takes."""

    @property
    def kinds(self) -> frozenset[str]:
        return frozenset(self.on_scene_s)


UNIT_TYPES: dict[str, UnitType] = {
    "engine": UnitType("engine", 0.85, {"verify": 240.0, "assist": 600.0}),
    "patrol": UnitType("patrol", 1.15, {"verify": 120.0, "assist": 300.0}),
    "ambulance": UnitType("ambulance", 1.05, {"assist": 480.0}),
}
"""ASSUMPTION: not measured. ``speed_factor`` times the OSM speed limit; on-scene time varies
by +-ON_SCENE_JITTER per (unit, task), seeded."""
TYPE_ORDER = ("engine", "patrol", "ambulance")
"""Unit i has type ``TYPE_ORDER[i % 3]``."""
ON_SCENE_JITTER = 0.2
UNREACHABLE_GIVEUP_S = 600.0
"""ASSUMPTION: drill seconds a unit waits for a route to open before cancelling its task."""
LOCATION_MOVING_S = 15.0
LOCATION_STATIONARY_S = 60.0
"""Drill seconds between ``me/location`` updates while driving / while parked (server TTL 900 s)."""
LOCATION_ACCURACY_M = 5.0

DEFAULT_STATIONS: tuple[LonLat, ...] = (
    (-121.8370, 39.7285),
    (-121.7700, 39.7350),
    (-121.8000, 39.6450),
    (-121.8350, 39.7800),
)
"""ASSUMPTION: approximate points around Chico on the Camp road network, not surveyed station
sites. Used when the drill has no stations and no shelter destinations."""


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class World:
    """What is true and visible at one drill time. All sets hold segment ids."""

    known_blocked: frozenset[str] = frozenset()
    """Closures the system knows (twin-closed): units route around them from the start."""
    truth_blocked: frozenset[str] = frozenset()
    """Ground truth: really blocked. Units find out only on reaching the edge."""
    fire: MultiPolygon | None = None
    """The fire estimate: edges inside or crossing it are closed, known and true."""
    congestion: Mapping[str, float] = field(default_factory=dict)
    """Directed edge id -> travel-time factor in [1, 10], as in ``inbound_route``."""


@dataclass
class Unit:
    id: str
    type: UnitType
    home: LonLat
    pos: LonLat
    party_key: str | None = None
    join_sent: bool = False
    phase: Literal["idle", "enroute", "onscene"] = "idle"
    task: dict[str, Any] | None = None
    route: tuple[str, ...] = ()
    edge_i: int = 0
    edge_t: float = 0.0
    needs_route: bool = False
    wait_s: float = 0.0
    scene_left: float = 0.0
    replans: int = 0
    goal_segment: str | None = None
    found_blocked: bool = False
    discovered: set[str] = field(default_factory=set)
    refused: set[str] = field(default_factory=set)
    last_loc_at: datetime | None = None
    last_loc_pos: LonLat | None = None
    apparatus: Apparatus | None = None
    """The station engine this unit is (None for the fallback table)."""
    access: AccessProfile | None = None
    """Its class's road access; None drives every edge at the type's speed factor."""
    turnout_left: float = 0.0
    """Drill seconds of turnout still to wait before leaving the station."""

    @property
    def ident(self) -> str:
        """The id tasks and the API know the unit by: its party_key once joined."""
        return self.party_key or self.id


def home_points(drill: Drill, configured: Sequence[LonLat] = DEFAULT_STATIONS) -> tuple[LonLat, ...]:
    """Station points: shelter destinations of the drill (sorted by id) if any, else ``configured``.

    The bundle has no station list yet; a temporary refuge or an exit is not a station."""
    shelters = sorted((d for d in drill.destinations if d.kind == "shelter"), key=lambda d: d.id)
    return tuple(d.coord for d in shelters) or tuple(configured)


def on_network(drill: Drill, point: LonLat) -> bool:
    """A routable road node within INBOUND_SNAP_MAX_M of ``point``."""
    origins, _ = _end_nodes(drill)
    node = _nearest_node(_index(drill).grid, drill.roads.node_coords, point, origins)
    return node is not None and haversine_m(point, drill.roads.node_coords[node]) <= INBOUND_SNAP_MAX_M


def fleet_apparatus(drill: Drill, bases: Sequence[Mapping[str, Any]], incident: LonLat, n_units: int) -> list[Apparatus]:
    """Engines of the CAL FIRE-layer stations nearest ``incident`` that sit on the drill roads."""
    return station_apparatus(bases, incident, n_units, lambda p: on_network(drill, p))


def _snap_home(drill: Drill, point: LonLat) -> LonLat:
    """The nearest routable road node, so a unit starts on the network."""
    origins, _ = _end_nodes(drill)
    coords = drill.roads.node_coords
    best = min(sorted(origins), key=lambda n: haversine_m(point, coords[n]))
    return coords[best]


class Fleet:
    def __init__(
        self,
        drill: Drill,
        n_units: int,
        *,
        seed: int = 0,
        stations: Sequence[LonLat] | None = None,
        incident_id: str | None = None,
        tempo: float = 1.0,
        apparatus: Sequence[Apparatus] | None = None,
    ) -> None:
        if n_units < 1 or tempo <= 0:
            raise ValueError("a fleet needs at least one unit and a positive tempo")
        self.drill = drill
        self.seed = seed
        self.tempo = tempo
        """Demo knob: units drive and work ``tempo`` times faster than the table says."""
        self.incident_id = incident_id or drill.incident_id
        self.units: list[Unit] = []
        self.notes: list[str] = []
        """How the fleet was built (sources, assumptions, fallbacks), for the driver to print."""
        if apparatus:
            for i, app in enumerate(list(apparatus)[:n_units]):
                home = _snap_home(drill, app.coord)
                uid = app.unit_id or f"sim-{i + 1}"
                self.units.append(Unit(uid, UNIT_TYPES["engine"], home, home, apparatus=app,
                                       access=access_profile(drill, app.vehicle)))
            self.notes.extend(sorted({u.access.basis for u in self.units if u.access is not None}))
            if any(u.access is None for u in self.units):
                self.notes.append("FALLBACK: suppression data unavailable; units drive at the engine "
                                  "speed factor with no class access rules (ASSUMPTION)")
        else:
            points = tuple(stations) if stations else home_points(drill)
            if not points:
                raise ValueError("no station points")
            homes = [_snap_home(drill, p) for p in points]
            for i in range(n_units):
                home = homes[i % len(homes)]
                self.units.append(Unit(f"sim-{i + 1}", UNIT_TYPES[TYPE_ORDER[i % len(TYPE_ORDER)]], home, home))
            self.notes.append("FALLBACK: no CAL FIRE station data; units start at "
                              + ("the given points" if stations else "the drill's shelters or approximate Chico points")
                              + " with the assumed engine/patrol/ambulance table, no turnout and no class access rules")
        self._clock: datetime | None = None

    # -- driver hooks -------------------------------------------------------------------

    def unit(self, unit_id: str) -> Unit:
        return next(u for u in self.units if u.id == unit_id)

    def bind(self, unit_id: str, party_key: str) -> None:
        """Record the party_key the backend issued at ``join``; the unit acts from the next tick."""
        self.unit(unit_id).party_key = party_key

    def accept_failed(self, unit_id: str, task_id: str) -> None:
        """The accept call was refused (409): drop the task and never try it again."""
        u = self.unit(unit_id)
        u.refused.add(task_id)
        if u.task and u.task["id"] == task_id:
            self._release(u)

    # -- one step -----------------------------------------------------------------------

    def tick(self, at: datetime, tasks: Iterable[Mapping[str, Any]], world: World) -> list[Call]:
        """Advance every unit to drill time ``at`` and return the calls made, in order.

        ``tasks``: task documents as ``GET me/tasks`` returns them (``id``, ``kind``, ``status``,
        ``assignee``, ``target.coord``, ``target.segment_id``), merged over all units. A task a
        unit holds that is absent here was closed by someone else and is dropped."""
        calls: list[Call] = []
        dt = 0.0 if self._clock is None else max(0.0, (at - self._clock).total_seconds())
        self._clock = at if self._clock is None else max(self._clock, at)
        by_id = {str(t["id"]): t for t in tasks}
        fire_class = _fire_classes(self.drill, world.fire)
        claimed = {u.task["id"] for u in self.units if u.task}
        for u in self.units:
            if not u.join_sent:
                u.join_sent = True
                calls.append(self._call(at, u, "join", "POST", f"incidents/{self.incident_id}/join", {"simulated": True}))
                continue
            if u.party_key is None:
                continue
            if u.task and u.task["id"] not in by_id:
                self._release(u)
            if u.phase == "idle":
                self._accept(u, at, by_id, claimed, calls)
            self._advance(u, at, dt, world, fire_class, calls)
            self._locate(u, at, calls)
        return calls

    # -- internals ----------------------------------------------------------------------

    def _call(self, at: datetime, u: Unit, op: str, method: str, path: str, body: dict[str, Any]) -> Call:
        return {"at": iso(at), "unit": u.id, "op": op, "method": method, "path": path, "body": body}

    def _release(self, u: Unit) -> None:
        u.task, u.phase, u.route = None, "idle", ()
        u.edge_i, u.edge_t, u.needs_route, u.wait_s = 0, 0.0, False, 0.0
        u.goal_segment, u.found_blocked = None, False

    def _accept(self, u: Unit, at: datetime, by_id: Mapping[str, Mapping[str, Any]], claimed: set[str],
                calls: list[Call]) -> None:
        best: tuple[float, str] | None = None
        for tid, t in by_id.items():
            target = ((t.get("target") or {}).get("coord"))
            if (
                tid in claimed or tid in u.refused or t.get("status") != "open"
                or t.get("assignee") not in (None, u.ident)
                or t.get("kind", "verify") not in u.type.kinds or not target
            ):
                continue
            key = (haversine_m(u.pos, (float(target[0]), float(target[1]))), tid)
            if best is None or key < best:
                best = key
        if best is None:
            return
        t = by_id[best[1]]
        claimed.add(best[1])
        target = t["target"]
        u.task = {
            "id": best[1],
            "kind": t.get("kind", "verify"),
            "coord": (float(target["coord"][0]), float(target["coord"][1])),
            "segment_id": target.get("segment_id"),
        }
        u.phase, u.needs_route, u.wait_s = "enroute", True, 0.0
        u.route, u.edge_i, u.edge_t, u.goal_segment, u.found_blocked = (), 0, 0.0, u.task["segment_id"], False
        if u.apparatus is not None and u.pos == u.home:
            u.turnout_left = u.apparatus.turnout_s / self.tempo  # leaving the station: crew turns out first
        calls.append(self._call(at, u, "accept", "POST", f"tasks/{best[1]}", {"status": "accepted"}))

    def _closed(self, u: Unit, world: World) -> frozenset[str]:
        return world.known_blocked | u.discovered

    def _plan(self, u: Unit, world: World, fire_class) -> bool | str:
        """Route from the end of the current edge (or the unit's position) to the task target.

        True when routed, False when no route now, or the cancel note when only the unit's
        class rules keep it from the target (``no_access``)."""
        assert u.task is not None
        prefix: tuple[str, ...] = ()
        edges = self.drill.roads.edges
        if u.edge_t > 0 and u.edge_i < len(u.route):
            cur = edges[u.route[u.edge_i]]
            prefix, origin = (cur.id,), self.drill.roads.node_coords[cur.to_node]
        elif u.edge_i < len(u.route):
            origin = self.drill.roads.node_coords[edges[u.route[u.edge_i]].from_node]
        else:
            origin = u.pos
        result = inbound_route(self.drill, origin, u.task["coord"], self._closed(u, world), world.fire, world.congestion,
                               access=u.access)
        if result.route is None:
            if result.reason == "no_access" and u.access is not None:
                return f"no road open to a {u.access.label}: {result.access_rule} {result.access_note}"
            return False
        u.route = prefix + result.route.edge_ids
        u.edge_i = 0
        if u.task["segment_id"] is None and result.route.segment_ids:
            u.goal_segment = result.route.segment_ids[-1]
        u.needs_route = False
        u.wait_s = 0.0
        return True

    def _advance(self, u: Unit, at: datetime, dt: float, world: World, fire_class, calls: list[Call]) -> None:
        remaining = dt
        edges = self.drill.roads.edges
        coords = self.drill.roads.node_coords
        if u.phase == "enroute" and not u.needs_route:
            known = self._closed(u, world)
            ahead = u.route[u.edge_i + (1 if u.edge_t > 0 else 0):]
            if any(edges[e].segment_id in known or fire_class(e) == _INSIDE for e in ahead):
                u.needs_route = True
                u.replans += 1
        # A tick with no time still plans a fresh route, so the first move is not lost.
        for _ in range(100_000):
            if u.phase == "onscene":
                use = min(remaining, u.scene_left)
                u.scene_left -= use
                remaining -= use
                if u.scene_left <= 1e-9:
                    self._finish(u, at, world, fire_class, calls)
                break
            if u.phase != "enroute":
                break
            if u.needs_route:
                planned = self._plan(u, world, fire_class)
                if isinstance(planned, str):
                    self._cancel(u, at, calls, planned)
                    break
                if not planned:
                    u.wait_s += remaining
                    if u.wait_s >= UNREACHABLE_GIVEUP_S:
                        self._cancel(u, at, calls)
                    break
            if u.turnout_left > 0:
                use = min(remaining, u.turnout_left)
                u.turnout_left -= use
                remaining -= use
                if u.turnout_left > 1e-9:
                    break
            if u.edge_i >= len(u.route):
                u.phase, u.scene_left = "onscene", self._scene_time(u)
                continue
            edge = edges[u.route[u.edge_i]]
            if u.edge_t == 0.0:
                truly = edge.segment_id in world.truth_blocked or fire_class(edge.id) == _INSIDE
                if truly or edge.segment_id in self._closed(u, world):
                    if edge.segment_id == u.goal_segment and u.task and u.task["kind"] == "verify" and truly:
                        u.found_blocked = True  # stopped at the block it was sent to check
                        u.phase, u.scene_left = "onscene", self._scene_time(u)
                        continue
                    u.discovered.add(edge.segment_id)
                    u.needs_route = True
                    u.replans += 1
                    u.route, u.edge_i = (), 0
                    continue
            if u.access is not None:
                speed_ms = u.access.speed_kph(edge.id, edge.speed_kph) * self.tempo / 3.6
            else:
                speed_ms = edge.speed_kph * u.type.speed_factor * self.tempo / 3.6
            need = edge.length_m / speed_ms * world.congestion.get(edge.id, 1.0) - u.edge_t
            if remaining >= need:
                remaining -= need
                u.pos = coords[edge.to_node]
                u.edge_i += 1
                u.edge_t = 0.0
            else:
                if remaining <= 0:
                    break
                u.edge_t += remaining
                total = need + u.edge_t - remaining
                u.pos = _along(edge.coords, min(1.0, u.edge_t / total))
                remaining = 0.0
                break

    def _scene_time(self, u: Unit) -> float:
        assert u.task is not None
        rng = random.Random(f"{self.seed}:{u.id}:{u.task['id']}")
        mean = u.type.on_scene_s[u.task["kind"]]
        return mean * rng.uniform(1 - ON_SCENE_JITTER, 1 + ON_SCENE_JITTER) / self.tempo

    def _segment_blocked(self, seg: str | None, world: World, fire_class) -> bool:
        if seg is None:
            return False
        if seg in world.truth_blocked or seg in world.known_blocked:
            return True
        return any(fire_class(e) == _INSIDE for e in self.drill.roads.segment_edges.get(seg, ())[:1])

    def _finish(self, u: Unit, at: datetime, world: World, fire_class, calls: list[Call]) -> None:
        task = u.task
        assert task is not None
        if task["kind"] == "assist":
            calls.append(self._call(at, u, "done", "POST", f"tasks/{task['id']}", {"status": "done"}))
        else:
            blocked = u.found_blocked or self._segment_blocked(u.goal_segment, world, fire_class)
            road = (self.drill.roads.edges[self.drill.roads.segment_edges[u.goal_segment][0]].name
                    if u.goal_segment in self.drill.roads.segment_edges else None) or "the road"
            where = (u.pos if u.goal_segment is None else task["coord"])
            calls.append(self._call(at, u, "report", "POST", f"incidents/{self.incident_id}/reports", {
                "client_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"crisistwin/sim/{self.seed}/{u.id}/{task['id']}")),
                "kind": "road_blocked" if blocked else "road_passable",
                "severity": "full" if blocked else None,
                "location": {"coord": [round(where[0], 6), round(where[1], 6)], "accuracy_m": LOCATION_ACCURACY_M},
                "task_id": task["id"],
                "note": f"Simulated responder {u.id}: {road} {'blocked' if blocked else 'passable'} (simulation ground truth)",
            }))
        self._release(u)

    def describe(self, u: Unit) -> str:
        """``sim-1 (CAL FIRE Type 3 engine, Jarbo Gap FS)``, or the fallback type."""
        if u.apparatus is None:
            return f"{u.id} ({u.type.name})"
        return f"{u.id} ({u.apparatus.label}, {u.apparatus.station})"

    def _cancel(self, u: Unit, at: datetime, calls: list[Call], why: str = "no open road to the target") -> None:
        assert u.task is not None
        calls.append(self._call(at, u, "cancel", "POST", f"tasks/{u.task['id']}", {
            "status": "cancelled", "note": f"Simulated responder {self.describe(u)}: {why}"}))
        u.refused.add(u.task["id"])
        self._release(u)

    def _locate(self, u: Unit, at: datetime, calls: list[Call]) -> None:
        moved = u.last_loc_pos != u.pos
        period = LOCATION_MOVING_S if moved else LOCATION_STATIONARY_S
        if u.last_loc_at is not None and (at - u.last_loc_at).total_seconds() < period:
            return
        u.last_loc_at, u.last_loc_pos = at, u.pos
        calls.append(self._call(at, u, "location", "POST", "me/location", {
            "coord": [round(u.pos[0], 6), round(u.pos[1], 6)], "accuracy_m": LOCATION_ACCURACY_M}))


def _along(coords: Sequence[LonLat], frac: float) -> LonLat:
    """Point at ``frac`` (0..1) of a polyline's length (planar degrees are fine at edge scale)."""
    pts = list(coords)
    seg = [math.dist(a, b) for a, b in zip(pts, pts[1:], strict=False)]
    target = sum(seg) * frac
    for (a, b), s in zip(zip(pts, pts[1:], strict=False), seg, strict=True):
        if target <= s or s == 0:
            f = 0.0 if s == 0 else target / s
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        target -= s
    return pts[-1]
