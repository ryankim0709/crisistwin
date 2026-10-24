"""Real-time traffic twin: the Camp replay on a simulation clock, with commands, snapshots and what-if.

A `Twin` wraps one `sim.traffic.TrafficEngine`. It starts at a replay time, advances with `step_to`,
accepts commands (`apply`) that become labelled simulated `TrafficEvent`s, reports a compact snapshot
for monitoring, and forks what-if branches so a controller can compare candidate actions by
simulated outcomes. Pure Python with JSON-serializable inputs and outputs; it never reads the wall
clock except to report `runtime_ms` of a what-if (measurement metadata only).

Contract: docs/twin-api.md. Design and invariants: docs/adr/0013-realtime-twin.md.
Outputs are planning experiments from an uncalibrated model, not operational instructions.
"""

from __future__ import annotations

import bisect
import dataclasses
import functools
import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from sim import SIM_VERSION
from sim.bundle import _fire_area_lookup, _simulated_fire
from sim.events import _exit_time_s, _Geo, canonical_road_name
from sim.history import format_utc, load_history, parse_utc
from sim.responders import CAMP_EGRESS_CORRIDORS, CHP_UNITS, FIRE_CLOSURE_CHECK_EVERY_S
from sim.responders import FIRE_CLOSURE_MAX_ROADS_PER_CHECK, egress_corridors
from sim.scenario import camp_replay_inputs
from sim.traffic import MODEL_ID, MODEL_VERSION, REFUGE_KIND, FireTimeline, TrafficEngine, TrafficEvent
from sim.traffic import DemandZone, Destination, RoadEdge, RoadNetwork, TrafficParams, _points_inside

SNAPSHOT_SCHEMA_VERSION = "0.1.0"
COMMAND_SOURCE_ID = "twin-command"
REPORT_SOURCE_ID = "drill-report"
COMMAND_LABEL_PREFIX = "Command (simulated)"
REPORT_LABEL_PREFIX = "Drill field report (simulated)"
COMMAND_TIME_PRECISION = "model_step"

# What-if objective (vehicle-minutes); planning heuristic weights, not calibrated.
WHATIF_WEIGHT_EXPOSED_VEH_MIN = 1.0
WHATIF_WEIGHT_BLOCKED_AT_HORIZON_VEH = 60.0
WHATIF_WEIGHT_REMAINING_AT_HORIZON_VEH = 1.0
WHATIF_MAX_SETS = 8
WHATIF_MAX_HORIZON_MIN = 360

# Limits (planning assumptions taken from sim.responders, not agency rules).
CLOSE_ROAD_WINDOW_S = FIRE_CLOSURE_CHECK_EVERY_S  # close_road: at most FIRE_CLOSURE_MAX_ROADS_PER_CHECK named roads
DEFAULT_RADIUS_M = 300.0
MAX_RADIUS_M = 5000.0
RECENT_ARRIVALS_S = 600  # destinations: arrived_last_10_min_veh

ACTION_TYPES = ("order_zone", "warn_zone", "close_road", "reopen_road", "capacity_changed", "contraflow",
                "end_contraflow", "hold_inbound", "open_refuge", "fill_destination", "reroute_zone")
ACTOR_KINDS = ("controller", "operator", "field_report")
ACTION_KEYS = {"id", "type", "at", "target", "params", "actor", "rationale"}
DIRECTIONS = ("both", "outbound", "inbound")
CATALOG_HIGHWAYS = ("motorway", "trunk", "primary", "secondary", "tertiary")
WHATIF_LIMITATIONS = [
    "Single seed; small differences are not significant.",
    "Planning experiment from an uncalibrated simulation; not operational instructions.",
]
FIRE_AHEAD_LIMITATIONS = {
    "replay": "fire_ahead=replay uses the replay's future fire as a perfect forecast (hindsight).",
    "frozen": "fire_ahead=frozen holds the fire area at the start of the window, so exposure is underestimated.",
}


class TwinError(Exception):
    """A rejected twin call; `to_dict()` is the JSON error body."""

    error = "twin_error"

    def __init__(self, code: str, detail: str, action_id: str | None = None):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail, self.action_id = code, detail, action_id

    def to_dict(self) -> dict:
        return {"error": self.error, "code": self.code, "detail": self.detail, "action_id": self.action_id}


class ActionError(TwinError):
    error = "invalid_action"


class ClockError(TwinError):
    error = "invalid_clock"


@dataclass(frozen=True)
class TwinInputs:
    """Everything a session is built from; `fingerprint` identifies it. `cache` holds shared derived state
    (FireTimeline, an engine template at the scenario start, corridors); it never affects results."""

    scenario: dict
    history_id: str
    params: TrafficParams
    start: datetime
    end: datetime
    fire_area_at: object
    fire_model_meta: dict
    fingerprint: str
    roads_package: str = ""
    cache: dict = field(default_factory=dict, compare=False, repr=False)


def _sha(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def inputs_fingerprint(scenario: dict, params: TrafficParams, start: datetime, end: datetime, fire_meta: dict) -> str:
    """sha256 over network, demand, destinations, historical events, params, clock and fire model (cf.
    sim.variants.basis)."""
    net = scenario["network"]
    return _sha({
        "network": [(e.id, e.from_node, e.to_node, e.length_m, e.lanes, e.speed_kph, e.capacity_veh_per_hour)
                    for e in net.edges],
        "demand": [(z.id, z.vehicles, z.origin_nodes) for z in scenario["zones"]],
        "destinations": [(d.id, d.node_id, d.kind, d.capacity_veh) for d in scenario["destinations"]],
        "events": [(ev.id, format_utc(ev.at), ev.type, ev.edge_ids, ev.zone_ids, ev.destination_id,
                    ev.capacity_factor, ev.closure_drains) for ev in scenario["events"]],
        "params": params.to_dict(), "start": format_utc(start), "end": format_utc(end),
        "models": {"sim": SIM_VERSION, "traffic": f"{MODEL_ID}@{MODEL_VERSION}"},
        "fire": fire_meta,
    })[:16]


@functools.lru_cache(maxsize=4)
def _camp_inputs(package: str, roads_package: str, demand: str, seed: int) -> TwinInputs:
    history = load_history(Path(package))
    scenario, start, end, _ = camp_replay_inputs(Path(roads_package), demand)
    fire_block, fire_model = _simulated_fire(history, end, Path(roads_package))
    hazard_until = fire_block.get("hazard_until")
    fire_area_at = _fire_area_lookup(history, fire_model[3], parse_utc(hazard_until) if hazard_until else None)
    params = TrafficParams(seed=seed)
    fire_meta = {"model": fire_block["model"].get("id"), "version": fire_block["model"].get("version"),
                 "ignition": fire_block.get("ignition"), "hazard_until": hazard_until}
    return TwinInputs(scenario=scenario, history_id=history.incident_id, params=params, start=start, end=end,
                      fire_area_at=fire_area_at, fire_model_meta=fire_meta,
                      fingerprint=inputs_fingerprint(scenario, params, start, end, fire_meta),
                      roads_package=Path(roads_package).name)


def camp_inputs(package, roads_package, demand: str = "auto", seed: int = TrafficParams.seed) -> TwinInputs:
    """Camp inputs as the `bundle` command builds them; cached per process."""
    return _camp_inputs(str(Path(package).resolve()), str(Path(roads_package).resolve()), demand, int(seed))


# Drill packages (Studio scenarios, docs/adr/0037-studio-drill-packages.md). Planning assumptions:
PACKAGE_MIN_EDGE_M = 1.0
"""An OSM edge shorter than this (or zero) is given this length; the engine needs positive lengths."""
PACKAGE_LANE_CAPACITY_VPH = 600.0
"""Per-lane capacity for an edge whose package capacity is zero (the dispatch area's `other` class)."""
PACKAGE_ASSUMPTIONS = [
    "Demand is synthetic: the package's homes per zone (homes per km of residential street) times its "
    "vehicles per home; every vehicle evacuates once its zone is ordered.",
    "Vehicles start at the road nodes inside each zone's hull (the nearest node when none is inside).",
    "No historical orders, closures or events: zones depart only when drill guidance orders them.",
    "Fire is the package's simulated Studio fronts (latest front at or before each time; none before the first).",
    f"Edges shorter than {PACKAGE_MIN_EDGE_M:g} m are lengthened to it; zero-capacity edges get "
    f"{PACKAGE_LANE_CAPACITY_VPH:g} veh/h per lane.",
]


def _nearest_node(nodes: dict[str, tuple[float, float]], ids: list[str], lon: float, lat: float) -> str:
    kx = math.cos(math.radians(lat))
    return min(ids, key=lambda n: ((nodes[n][0] - lon) * kx) ** 2 + (nodes[n][1] - lat) ** 2)


def _ring_centroid(geometry: dict) -> tuple[float, float]:
    ring = (geometry["coordinates"] if geometry["type"] == "Polygon" else geometry["coordinates"][0])[0]
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


@functools.lru_cache(maxsize=4)
def _package_inputs(path: str, seed: int) -> TwinInputs:
    with open(path, encoding="utf-8") as fh:
        bundle = json.load(fh)
    meta = bundle.get("drill_package") or {}
    nodes: dict[str, tuple[float, float]] = {}
    edges = []
    for raw in bundle["roads"]["edges"]:
        coords = tuple((float(c[0]), float(c[1])) for c in raw["coords"])
        nodes.setdefault(str(raw["from_node"]), coords[0])
        nodes.setdefault(str(raw["to_node"]), coords[-1])
        lanes = max(1, int(raw.get("lanes") or 1))
        capacity = float(raw.get("capacity_veh_per_hour") or 0.0) or lanes * PACKAGE_LANE_CAPACITY_VPH
        edges.append(RoadEdge(
            id=str(raw["id"]), segment_id=str(raw.get("segment_id") or raw["id"]),
            from_node=str(raw["from_node"]), to_node=str(raw["to_node"]),
            length_m=max(float(raw["length_m"]), PACKAGE_MIN_EDGE_M), lanes=lanes,
            speed_kph=float(raw["speed_kph"]), capacity_veh_per_hour=capacity, name=str(raw.get("name") or ""),
            highway=str(raw.get("highway") or "road"), bridge=bool(raw.get("bridge")), coords=coords))
    network = RoadNetwork(nodes=nodes, edges=tuple(edges))
    departing = sorted({e.from_node for e in edges})
    points = [nodes[n] for n in departing]
    zones = []
    for feat in bundle["zones"]["features"]:
        geometry = feat["geometry"]
        inside = sorted(departing[i] for i in _points_inside(geometry, points, range(len(points))))
        origins = tuple(inside) or (_nearest_node(nodes, departing, *_ring_centroid(geometry)),)
        zones.append(DemandZone(id=str(feat["id"]), name=str(feat.get("name") or feat["id"]),
                                households=int(feat.get("households") or 0), vehicles=int(feat.get("vehicles") or 0),
                                origin_nodes=origins, geometry=geometry))
    destinations = []
    for feat in bundle["destinations"]["features"]:
        lon, lat = (float(v) for v in feat["coord"])
        node = str(feat.get("node_id") or "")
        if node not in nodes:
            node = _nearest_node(nodes, list(nodes), lon, lat)
        cap = feat.get("capacity_veh")
        destinations.append(Destination(id=str(feat["id"]), name=str(feat.get("name") or feat["id"]),
                                        kind=str(feat.get("kind") or "exit"), node_id=node, coord=(lon, lat),
                                        capacity_veh=int(cap) if cap is not None else None))
    simulated = bundle.get("fire_simulated") or {}
    fronts = sorted(((parse_utc(f["at"]), f["geometry"]) for f in simulated.get("fronts") or []), key=lambda f: f[0])
    times = [t for t, _ in fronts]

    def fire_area_at(at: datetime) -> dict | None:
        i = bisect.bisect_right(times, at) - 1
        return fronts[i][1] if i >= 0 else None

    start, end = parse_utc(bundle["clock"]["start"]), parse_utc(bundle["clock"]["end"])
    scenario = {
        "network": network, "zones": tuple(zones), "destinations": tuple(destinations), "events": (),
        "evidence_class": "fixture", "roads_evidence_class": "derived", "destinations_evidence_class": "derived",
        "notes": list(PACKAGE_ASSUMPTIONS),
    }
    params = TrafficParams(seed=seed)
    model = simulated.get("model") or {}
    fire_meta = {"model": model.get("id"), "version": model.get("version"), "ignition": simulated.get("ignition"),
                 "hazard_until": None}
    incident = str((bundle.get("incident") or {}).get("id") or meta.get("package_id") or "package")
    return TwinInputs(scenario=scenario, history_id=incident, params=params, start=start, end=end,
                      fire_area_at=fire_area_at if fronts else None, fire_model_meta=fire_meta,
                      fingerprint=inputs_fingerprint(scenario, params, start, end, fire_meta),
                      roads_package=str(meta.get("package_id") or Path(path).name))


def package_inputs(path, seed: int = TrafficParams.seed) -> TwinInputs:
    """Twin inputs from a Studio drill package (a replay bundle with `drill_package`): its roads, synthetic
    zones, exits and simulated fire fronts; assumptions in `PACKAGE_ASSUMPTIONS`. Cached per process."""
    return _package_inputs(str(Path(path).resolve()), int(seed))


def with_people_behavior(inputs: TwinInputs, people) -> TwinInputs:
    """Inputs with sourced people behaviour (sim.behavior.PeopleBehavior) on the fixed-delay engine: demand
    vehicles x order compliance (sim.demand.with_participation), shadow evacuation on the fire cue
    (TrafficParams.shadow_evacuation_share) and the departure delay. Default behaviour returns `inputs` itself,
    so historical replays (and their fingerprints) are unchanged. The fire timeline is rebuilt: fewer vehicles
    can leave some origin nodes empty, and the timeline is keyed on the occupied origins."""
    from sim.demand import with_participation

    if people.is_default:
        return inputs
    scenario = dict(inputs.scenario)
    scenario["zones"] = with_participation(scenario["zones"], people.order_compliance)
    scenario["people_behavior"] = dataclasses.asdict(people)
    changes = {"shadow_evacuation_share": people.shadow_evacuation_share}
    if people.departure_delay_median_min is not None:
        changes["response_delay_median_min"] = people.departure_delay_median_min
    if people.departure_delay_sigma is not None:
        changes["response_delay_sigma"] = people.departure_delay_sigma
    params = dataclasses.replace(inputs.params, **changes)
    fingerprint = inputs_fingerprint(scenario, params, inputs.start, inputs.end, inputs.fire_model_meta)
    return dataclasses.replace(inputs, scenario=scenario, params=params, fingerprint=fingerprint, cache={})


def _template(inputs: TwinInputs) -> TrafficEngine:
    """Engine at the scenario start (no step run), shared FireTimeline; sessions fork from it."""
    if "template" not in inputs.cache:
        s = inputs.scenario
        engine = TrafficEngine(s["network"], s["zones"], s["destinations"], s["events"], inputs.params,
                               start=inputs.start, end=inputs.end, fire_area_at=inputs.fire_area_at,
                               fire_timeline=inputs.cache.get("timeline"))
        inputs.cache["timeline"] = engine.timeline
        inputs.cache["template"] = engine
    return inputs.cache["template"]


def _derived(inputs: TwinInputs) -> dict:
    """Corridors, exit times and road-name index, computed once per inputs."""
    if "derived" not in inputs.cache:
        s = inputs.scenario
        net = s["network"]
        exits = [d for d in s["destinations"] if d.kind == "exit"]
        names: dict[str, list[int]] = {}
        for i, e in enumerate(net.edges):
            names.setdefault(canonical_road_name(e.name), []).append(i)
        inputs.cache["derived"] = {
            "corridors": {c.name: c for c in egress_corridors(net, exits, CAMP_EGRESS_CORRIDORS)},
            "exit_time": _exit_time_s(net, tuple(exits)),
            "geo": _Geo(net),
            "names": names,
        }
    return inputs.cache["derived"]


def _iso(dt: datetime) -> str:
    return format_utc(dt)


def _parse_time(value, what: str, action_id=None) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ActionError("invalid_shape", f"{what} must include a timezone", action_id)
        return value
    if not isinstance(value, str):
        raise ActionError("invalid_shape", f"{what} must be an ISO 8601 string", action_id)
    try:
        return parse_utc(value)
    except Exception as exc:  # SourceError or ValueError
        raise ActionError("invalid_shape", f"{what}: {exc}", action_id) from None


class Twin:
    """One real-time twin session. Calls are not thread-safe; the adapter serializes them per session."""

    def __init__(self, inputs: TwinInputs, engine: TrafficEngine, *, keep_frames: bool, start_at: str,
                 session_id: str | None = None):
        self.inputs = inputs
        self.engine = engine
        self.keep_frames = keep_frames
        self.start_at = start_at
        self.session_id = session_id or f"{inputs.history_id}:{inputs.params.seed}:{inputs.fingerprint[:8]}"
        self._log: list[dict] = []
        self._whatif_cache: dict = {}

    # --- construction

    @classmethod
    def for_camp(cls, package, roads_package, *, demand: str = "auto", seed: int = TrafficParams.seed,
                 start_at=None, keep_frames: bool = False, session_id: str | None = None) -> "Twin":
        return cls.from_inputs(camp_inputs(package, roads_package, demand, seed), start_at=start_at,
                               keep_frames=keep_frames, session_id=session_id)

    @classmethod
    def from_inputs(cls, inputs: TwinInputs, start_at=None, *, keep_frames: bool = False,
                    session_id: str | None = None) -> "Twin":
        start_dt = inputs.start if start_at is None else _parse_time(start_at, "start_at")
        if not inputs.start <= start_dt <= inputs.end:
            raise ClockError("start_out_of_range", f"start_at must be within {_iso(inputs.start)}..{_iso(inputs.end)}")
        engine = _template(inputs).fork(keep_outputs=keep_frames)
        twin = cls(inputs, engine, keep_frames=keep_frames, start_at=_iso(start_dt), session_id=session_id)
        engine.run_to((start_dt - inputs.start).total_seconds())
        return twin

    @classmethod
    def replay(cls, inputs: TwinInputs, log: list[dict], until=None, *, start_at=None,
               keep_frames: bool = False) -> "Twin":
        """Rebuild a session from its action log: step to each action's issue time, apply it, then step to
        `until` (default: the last action's issue time). The reference semantics for forks.

        Entries are action-log records (`seq`, `issued_at`, `effective_at`) or plain actions as in
        plan-api (`at`, issued at that time; without `at`, at the scenario start)."""
        if all("seq" in a for a in log):
            ordered = sorted(log, key=lambda a: a["seq"])
        else:
            ordered = [a for _, a in sorted(enumerate(log), key=lambda p: (
                _parse_time(p[1]["at"], "at", p[1].get("id")) if p[1].get("at") else inputs.start, p[0]))]
        step = timedelta(seconds=inputs.params.step_s)

        def issue_time(a: dict) -> str:  # plain actions are issued one step before `at`, so they apply at `at`
            if a.get("issued_at"):
                return a["issued_at"]
            if a.get("at"):
                return _iso(max(inputs.start, _parse_time(a["at"], "at", a.get("id")) - step))
            return _iso(inputs.start)
        issued = [issue_time(a) for a in ordered]
        twin = cls.from_inputs(inputs, start_at or (issued[0] if issued else until), keep_frames=keep_frames)
        for a, at in zip(ordered, issued):
            twin.step_to(at)
            action = {k: a[k] for k in ("id", "type", "target", "params", "actor", "rationale") if k in a}
            when = a.get("effective_at") or a.get("at")
            twin.apply(action | ({"at": when} if when else {}))
        if until is not None:
            twin.step_to(until)
        return twin

    def fork(self) -> "Twin":
        """Independent twin at the same state and log (recorded frames copied when keep_frames)."""
        new = Twin(self.inputs, self.engine.fork(keep_outputs=self.keep_frames), keep_frames=self.keep_frames,
                   start_at=self.start_at, session_id=self.session_id)
        new._log = json.loads(json.dumps(self._log))
        return new

    # --- clock

    @property
    def now(self) -> str:
        return _iso(self._now_dt())

    def _now_dt(self) -> datetime:
        return self.inputs.start + timedelta(seconds=self.engine.now_s or 0)

    @property
    def finished(self) -> bool:
        return self.engine.finished

    def _clock_reply(self, steps: int, clamped: bool = False) -> dict:
        return {"now": self.now, "step_index": self.engine.k - 1, "steps": steps, "finished": self.finished,
                "clamped": clamped, "events_cursor": len(self.engine.generated)}

    def step_to(self, at) -> dict:
        """Run every step with time <= at. Earlier than now: clock_backwards. After end: clamped."""
        at_dt = _parse_time(at, "to")
        t_s = (at_dt - self.inputs.start).total_seconds()
        if t_s < self.engine.now_s:
            raise ClockError("clock_backwards", f"{_iso(at_dt)} is before now ({self.now}); rebuild from the log")
        clamped = at_dt > self.inputs.end
        k0 = self.engine.k
        self.engine.run_to(t_s)
        return self._clock_reply(self.engine.k - k0, clamped)

    def step(self, n: int = 1) -> dict:
        if not isinstance(n, int) or n < 1:
            raise ClockError("invalid_steps", "n must be a positive integer")
        k0 = self.engine.k
        for _ in range(n):
            if self.engine.finished:
                break
            self.engine.step()
        return self._clock_reply(self.engine.k - k0, self.engine.k - k0 < n)

    # --- actions

    def catalog(self) -> dict:
        """Commandable zones, roads, corridors and destinations, with action types and limits."""
        e, s = self.engine, self.engine.s
        der = _derived(self.inputs)
        roads = {}
        for i, edge in enumerate(s.edges):
            if edge.highway in CATALOG_HIGHWAYS:
                key = canonical_road_name(edge.name)
                r = roads.setdefault(key, {"name": edge.name, "key": key, "edges": 0, "highways": set()})
                r["edges"] += 1
                r["highways"].add(edge.highway)
        return {
            "kind": "crisistwin_twin_catalog",
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "now": self.now,
            "action_types": {
                "order_zone": {"target": ["zone_id", "zone_ids"], "params": {}},
                "warn_zone": {"target": ["zone_id", "zone_ids"], "params": {},
                              "note": None if e.s.agents_on or s.params.warning_releases_demand
                              else "replay mode: releases no demand (no_effect)"},
                "close_road": {"target": "road selector", "params": {"mode": ["entry", "hard"]}},
                "reopen_road": {"target": "road selector, or {corridor, hold: true}", "params": {}},
                "capacity_changed": {"target": "road selector", "params": {"capacity_factor": "(0, 1]"}},
                "contraflow": {"target": ["corridor"], "params": {}},
                "end_contraflow": {"target": ["corridor"], "params": {}},
                "hold_inbound": {"target": ["corridor"], "params": {}},
                "open_refuge": {"target": ["destination_id"], "params": {}},
                "fill_destination": {"target": ["destination_id"], "params": {},
                                     "note": "marks the destination full from now (drill injects); not undoable"},
                "reroute_zone": {"target": ["zone_id", "zone_ids"], "params": {"destination_id": "id or null"}},
            },
            "road_selectors": ["edge_indexes", "edge_ids", "road_name (+ near [lon, lat], radius_m, direction)",
                               "corridor (+ hold)"],
            "actor_kinds": list(ACTOR_KINDS),
            "limits": {"chp_units": CHP_UNITS, "close_road_named_roads_per_window": FIRE_CLOSURE_MAX_ROADS_PER_CHECK,
                       "close_road_window_s": CLOSE_ROAD_WINDOW_S, "default_radius_m": DEFAULT_RADIUS_M,
                       "max_radius_m": MAX_RADIUS_M,
                       "basis": "planning assumptions from sim.responders, not agency rules"},
            "zones": [{"id": z.id, "name": z.name, "vehicles": z.vehicles, "ordered": self._zone_ordered(zi)}
                      for zi, z in enumerate(s.zone_list)],
            "destinations": [{"id": d.id, "name": d.name, "kind": d.kind, "status": self._dest_status(k),
                              "capacity_veh": d.capacity_veh} for k, d in enumerate(s.dest_list)],
            "corridors": [{"name": c.name, "outbound_edge_indexes": sorted(s.edge_index[x] for x in c.outbound),
                           "hold_edge_indexes": sorted(s.edge_index[x] for x in c.inbound_entry),
                           "state": self._corridor_state(c.name)} for c in der["corridors"].values()],
            "roads": sorted(({**r, "highways": sorted(r["highways"])} for r in roads.values()),
                            key=lambda r: (-r["edges"], r["key"])),
        }

    def validate(self, action: dict) -> dict:
        """Dry run of apply: the same checks and resolution, no state change."""
        record, _, warnings = self._prepare(action)
        return {"ok": True, "action": record, "warnings": warnings}

    def apply(self, action: dict) -> dict:
        """Validate, log and schedule an action; returns the accepted action record. Raises ActionError."""
        record, events, warnings = self._prepare(action)
        try:
            self.engine.inject(events)
        except ValueError as exc:  # should not happen after _prepare; keep the engine message
            raise ActionError("invalid_shape", str(exc), record["id"]) from None
        record["warnings"] = warnings
        self._log.append(record)
        self._whatif_cache.clear()
        return {"ok": True, "action": self._public(record), "warnings": warnings}

    def action_log(self) -> list[dict]:
        return [self._public(r) for r in self._log]

    def _public(self, record: dict) -> dict:
        eff_s = (parse_utc(record["effective_at"]) - self.inputs.start).total_seconds()
        status = "applied" if self.engine.now_s is not None and eff_s <= self.engine.now_s else "scheduled"
        return {**json.loads(json.dumps(record)), "status": status}

    def _prepare(self, action: dict) -> tuple[dict, list[TrafficEvent], list[dict]]:
        if self.engine.finished:
            raise ActionError("session_finished", "the session has reached its end time",
                              action.get("id") if isinstance(action, dict) else None)
        a = self._normalize(action)
        aid = a["id"]
        s = self.engine.s
        next_s = self.engine.next_step_s
        if a["at"] is None:
            eff_s = next_s
        else:
            at_dt = _parse_time(a["at"], "at", aid)
            at_s = (at_dt - self.inputs.start).total_seconds()
            if self.engine.now_s is not None and at_s < self.engine.now_s:
                raise ActionError("at_in_past", f"at {_iso(at_dt)} is before now ({self.now})", aid)
            if at_dt > self.inputs.end:
                raise ActionError("after_end", f"at {_iso(at_dt)} is after the session end {_iso(self.inputs.end)}",
                                  aid)
            eff_s = max(next_s, math.ceil(at_s / s.step) * s.step)
            if eff_s > s.n_steps * s.step:
                raise ActionError("after_end", "no model step remains at or after at", aid)
        eff_dt = self.inputs.start + timedelta(seconds=eff_s)
        resolved, warnings = self._resolve_target(a)
        warnings += self._check_state(a, resolved, eff_s)
        events, label = self._to_events(a, resolved, eff_dt)
        record = {
            "seq": len(self._log) + 1, "id": aid, "type": a["type"],
            "issued_at": self.now, "effective_at": _iso(eff_dt),
            "target": a["target"], "params": a["params"],
            "resolved": {"edge_indexes": resolved.get("edge_indexes", []), "zone_ids": resolved.get("zone_ids", []),
                         "destination_id": resolved.get("destination_id"),
                         **({"corridor": resolved["corridor"]} if "corridor" in resolved else {}),
                         **({"road_keys": resolved["road_keys"]} if "road_keys" in resolved else {})},
            "actor": a["actor"], "rationale": a["rationale"],
            "event_ids": [ev.id for ev in events], "label": label, "evidence_class": "simulated",
        }
        return record, events, warnings

    def _normalize(self, action) -> dict:
        if not isinstance(action, dict):
            raise ActionError("invalid_shape", "an action must be an object")
        aid = action.get("id")
        extra = set(action) - ACTION_KEYS
        if extra:
            raise ActionError("invalid_shape", f"unknown fields: {sorted(extra)}", aid)
        if aid is None:
            n = len(self._log) + 1
            taken = {r["id"] for r in self._log}
            while f"a{n}" in taken:
                n += 1
            aid = f"a{n}"
        elif not isinstance(aid, str) or not aid or len(aid) > 64 or not all(c.isalnum() or c in "-_." for c in aid):
            raise ActionError("invalid_shape", "id must be 1-64 characters of letters, digits, - _ .", None)
        if any(r["id"] == aid for r in self._log) or f"twin-{aid}" in self.engine.used_event_ids:
            raise ActionError("duplicate_action_id", f"action id {aid} is already used in this session", aid)
        if action.get("type") not in ACTION_TYPES:
            raise ActionError("unknown_action_type", f"type must be one of {list(ACTION_TYPES)}", aid)
        target = action.get("target", {})
        params = action.get("params") or {}
        actor = action.get("actor") or {"kind": "operator", "id": "operator"}
        rationale = action.get("rationale")
        if not isinstance(target, dict) or not isinstance(params, dict):
            raise ActionError("invalid_shape", "target and params must be objects", aid)
        if (not isinstance(actor, dict) or set(actor) - {"kind", "id"} or actor.get("kind") not in ACTOR_KINDS
                or not isinstance(actor.get("id", ""), str)):
            raise ActionError("invalid_shape", f"actor must be {{kind: {list(ACTOR_KINDS)}, id: str}}", aid)
        if rationale is not None and not isinstance(rationale, str):
            raise ActionError("invalid_shape", "rationale must be a string", aid)
        return {"id": aid, "type": action["type"], "at": action.get("at"), "target": target, "params": params,
                "actor": {"kind": actor["kind"], "id": actor.get("id") or actor["kind"]}, "rationale": rationale}

    # target resolution

    def _resolve_target(self, a: dict) -> tuple[dict, list[dict]]:
        t, p, aid, typ = a["target"], a["params"], a["id"], a["type"]
        s = self.engine.s
        warnings: list[dict] = []

        def allow(target_keys: set, param_keys: set):
            if set(t) - target_keys:
                raise ActionError("invalid_shape", f"{typ} target accepts {sorted(target_keys)}", aid)
            if set(p) - param_keys:
                raise ActionError("invalid_shape", f"{typ} params accept {sorted(param_keys)}", aid)

        def zones() -> list[str]:
            if ("zone_id" in t) == ("zone_ids" in t):
                raise ActionError("invalid_shape", "target needs exactly one of zone_id, zone_ids", aid)
            ids = [t["zone_id"]] if "zone_id" in t else t["zone_ids"]
            if not isinstance(ids, list) or not ids or not all(isinstance(z, str) for z in ids):
                raise ActionError("invalid_shape", "zone ids must be a non-empty list of strings", aid)
            unknown = [z for z in ids if z not in s.zone_ix]
            if unknown:
                raise ActionError("unknown_zone", f"unknown zones: {unknown}", aid)
            return list(dict.fromkeys(ids))

        def destination(value) -> str:
            if not isinstance(value, str) or value not in s.dest_ix:
                raise ActionError("unknown_destination", f"unknown destination {value!r}", aid)
            return value

        def corridor(hold_ok: bool = False):
            der = _derived(self.inputs)
            name = t.get("corridor")
            if name not in der["corridors"]:
                raise ActionError("unknown_corridor", f"corridor must be one of {sorted(der['corridors'])}", aid)
            return der["corridors"][name]

        if typ in ("order_zone", "warn_zone"):
            allow({"zone_id", "zone_ids"}, set())
            return {"zone_ids": zones()}, warnings
        if typ == "reroute_zone":
            allow({"zone_id", "zone_ids"}, {"destination_id"})
            if "destination_id" not in p:
                raise ActionError("invalid_shape", "params.destination_id is required (null clears)", aid)
            dest = p["destination_id"]
            return {"zone_ids": zones(), "destination_id": None if dest is None else destination(dest)}, warnings
        if typ == "open_refuge":
            allow({"destination_id"}, set())
            dest = destination(t.get("destination_id"))
            if s.dest_list[s.dest_ix[dest]].kind not in (REFUGE_KIND, "shelter"):
                raise ActionError("not_a_refuge", f"{dest} is an exit, not a refuge or shelter", aid)
            return {"destination_id": dest}, warnings
        if typ == "fill_destination":
            allow({"destination_id"}, set())
            return {"destination_id": destination(t.get("destination_id"))}, warnings
        if typ in ("contraflow", "end_contraflow", "hold_inbound"):
            allow({"corridor"}, set())
            c = corridor()
            ids = c.inbound_entry if typ == "hold_inbound" else c.outbound
            if not ids:
                raise ActionError("no_edges_selected", f"{c.name} has no {'hold' if typ == 'hold_inbound' else 'outbound'} "
                                  "edges", aid)
            return {"corridor": c.name, "edge_indexes": sorted(s.edge_index[x] for x in ids)}, warnings
        # road actions
        param_keys = {"mode"} if typ == "close_road" else {"capacity_factor"} if typ == "capacity_changed" else set()
        allow({"edge_indexes", "edge_ids", "road_name", "near", "radius_m", "direction", "corridor", "hold"},
              param_keys)
        edges = self._select_edges(a, warnings)
        keys = sorted({canonical_road_name(s.edges[i].name) for i in edges})
        return {"edge_indexes": edges, "road_keys": keys}, warnings

    def _select_edges(self, a: dict, warnings: list[dict]) -> list[int]:
        t, aid = a["target"], a["id"]
        s = self.engine.s
        kinds = [k for k in ("edge_indexes", "edge_ids", "road_name", "corridor") if k in t]
        if len(kinds) != 1:
            raise ActionError("invalid_shape", "road selector needs exactly one of edge_indexes, edge_ids, road_name, "
                              "corridor", aid)
        kind = kinds[0]
        if kind != "road_name" and set(t) & {"near", "radius_m", "direction"}:
            raise ActionError("invalid_shape", "near, radius_m and direction go with road_name", aid)
        if kind != "corridor" and "hold" in t:
            raise ActionError("invalid_shape", "hold goes with corridor", aid)
        if kind == "edge_indexes":
            ix = t["edge_indexes"]
            if (not isinstance(ix, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ix)
                    or any(not 0 <= i < s.n_edges for i in ix)):
                raise ActionError("invalid_shape", f"edge_indexes must be integers in [0, {s.n_edges})", aid)
            edges = sorted(set(ix))
        elif kind == "edge_ids":
            ids = t["edge_ids"]
            if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
                raise ActionError("invalid_shape", "edge_ids must be a list of strings", aid)
            unknown = [x for x in ids if x not in s.edge_index]
            if unknown:
                raise ActionError("unknown_road", f"unknown edge ids: {unknown[:5]}", aid)
            edges = sorted({s.edge_index[x] for x in ids})
        elif kind == "corridor":
            der = _derived(self.inputs)
            c = der["corridors"].get(t["corridor"])
            if c is None:
                raise ActionError("unknown_corridor", f"corridor must be one of {sorted(der['corridors'])}", aid)
            hold = t.get("hold", False)
            if not isinstance(hold, bool):
                raise ActionError("invalid_shape", "hold must be a boolean", aid)
            edges = sorted(s.edge_index[x] for x in (c.inbound_entry if hold else c.outbound))
        else:
            der = _derived(self.inputs)
            name = t["road_name"]
            if not isinstance(name, str):
                raise ActionError("invalid_shape", "road_name must be a string", aid)
            key = canonical_road_name(name)
            edges = list(der["names"].get(key, ()))
            if not edges:
                raise ActionError("unknown_road", f"no road named {name!r} (canonical {key!r})", aid)
            direction = t.get("direction", "both")
            if direction not in DIRECTIONS:
                raise ActionError("invalid_shape", f"direction must be one of {list(DIRECTIONS)}", aid)
            if "near" in t:
                near = t["near"]
                if (not isinstance(near, list) or len(near) != 2
                        or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in near)):
                    raise ActionError("invalid_shape", "near must be [lon, lat]", aid)
                radius = t.get("radius_m", DEFAULT_RADIUS_M)
                if not isinstance(radius, (int, float)) or not 0 < radius <= MAX_RADIUS_M:
                    raise ActionError("invalid_shape", f"radius_m must be in (0, {MAX_RADIUS_M:g}]", aid)
                geo = der["geo"]
                edges = [i for i in edges if geo.dist(s.e_mid[i], (near[0], near[1])) <= radius]
            else:
                if "radius_m" in t:
                    raise ActionError("invalid_shape", "radius_m needs near", aid)
                warnings.append({"code": "whole_road", "detail": f"every edge named {key!r} ({len(edges)} edges)"})
            if direction != "both":
                ext = der["exit_time"]
                net_e = s.edges

                def outbound(i: int) -> bool:
                    return ext.get(net_e[i].to_node, math.inf) < ext.get(net_e[i].from_node, math.inf)
                edges = [i for i in edges if outbound(i) == (direction == "outbound")]
            edges = sorted(edges)
        if not edges:
            raise ActionError("no_edges_selected", "the selector matched no edges", aid)
        return edges

    # state checks

    def _pending(self, typ: str | None = None) -> list[dict]:
        """Logged actions not yet applied by the engine."""
        now_s = self.engine.now_s
        out = []
        for r in self._log:
            eff_s = (parse_utc(r["effective_at"]) - self.inputs.start).total_seconds()
            if (now_s is None or eff_s > now_s) and (typ is None or r["type"] == typ):
                out.append(r)
        return out

    def _zone_ordered(self, zi: int) -> bool:
        e = self.engine
        z = e.s.zone_list[zi]
        if e.s.agents_on:
            return e.z_ordered_s[zi] is not None
        return z.id in e.released_zones

    def _dest_status(self, d: int) -> str:
        e = self.engine
        return "closed" if not e.dest_open[d] else "full" if e.dest_full[d] else "open"

    def _corridor_state(self, name: str) -> str:
        """contraflow | hold | none, for the corridor's current engine state."""
        e, s = self.engine, self.engine.s
        c = _derived(self.inputs)["corridors"][name]
        if any(s.edge_index[x] in e.contraflow_out for x in c.outbound):
            return "contraflow"
        if c.inbound_entry and all(s.edge_index[x] in e.event_closed_drain or s.edge_index[x] in e.event_closed
                                   for x in c.inbound_entry):
            return "hold"
        return "none"

    def _twin_staffed(self) -> set[str]:
        """Corridors staffed by twin commands (contraflow or hold), including scheduled ones."""
        staffed: set[str] = set()
        for r in self._log:  # in order: later actions override
            c = r["resolved"].get("corridor") or (r["target"].get("corridor") if r["target"].get("hold") else None)
            if r["type"] in ("contraflow", "hold_inbound") and c:
                staffed.add(c)
            elif r["type"] == "end_contraflow" and c:
                staffed.discard(c)
            elif r["type"] == "reopen_road" and r["target"].get("hold") and c:
                staffed.discard(c)
        # A corridor whose effect has ended otherwise (e.g. a later historical event) frees its unit.
        pending = {r["resolved"].get("corridor") for r in self._pending()}
        return {c for c in staffed if c in pending or self._corridor_state(c) != "none"}

    def _check_state(self, a: dict, resolved: dict, eff_s: float) -> list[dict]:
        e, s = self.engine, self.engine.s
        typ, aid, p = a["type"], a["id"], a["params"]
        warnings: list[dict] = []
        edges = resolved.get("edge_indexes", [])
        if typ == "order_zone":
            pending = {z for r in self._pending("order_zone") for z in r["resolved"]["zone_ids"]}
            if all(self._zone_ordered(s.zone_ix[z]) or z in pending for z in resolved["zone_ids"]):
                raise ActionError("already_ordered", f"every zone is already ordered: {resolved['zone_ids']}", aid)
        elif typ == "warn_zone":
            if not s.agents_on and not s.params.warning_releases_demand:
                warnings.append({"code": "no_effect", "detail": "replay mode: warnings release no demand"})
        elif typ == "close_road":
            mode = p.get("mode", "entry")
            if mode not in ("entry", "hard"):
                raise ActionError("invalid_mode", "mode must be entry or hard", aid)
            closed = [i for i in edges if e.closed[i]]
            if closed:
                warnings.append({"code": "partially_closed_already",
                                 "detail": f"{len(closed)} of {len(edges)} edges are already closed"})
            actor = a["actor"]
            recent = [r for r in self._log if r["type"] == "close_road" and r["actor"] == actor
                      and eff_s - CLOSE_ROAD_WINDOW_S < (parse_utc(r["effective_at"]) - self.inputs.start
                                                         ).total_seconds() <= eff_s]
            names = {k for r in recent for k in r["resolved"].get("road_keys", [])} | set(resolved["road_keys"])
            if len(names) > FIRE_CLOSURE_MAX_ROADS_PER_CHECK:
                raise ActionError("limit_exceeded", f"close_road: at most {FIRE_CLOSURE_MAX_ROADS_PER_CHECK} named "
                                  f"roads per {CLOSE_ROAD_WINDOW_S // 60} simulated min per actor "
                                  f"(FIRE_CLOSURE_MAX_ROADS_PER_CHECK); would be {len(names)}", aid)
        elif typ == "reopen_road":
            pending_closed = {i for r in self._pending("close_road") for i in r["resolved"]["edge_indexes"]}
            event = [i for i in edges if i in e.event_closed or i in e.event_closed_drain or i in pending_closed]
            fire_only = [i for i in edges if i in e.fire_closed and i not in event]
            if not event:
                if fire_only:
                    raise ActionError("fire_closed_not_reopenable",
                                      f"{len(fire_only)} selected edges are closed by fire only; fire closures cannot "
                                      "be reopened", aid)
                raise ActionError("not_closed", "no selected edge is closed by an event", aid)
            if fire_only:
                warnings.append({"code": "partially_closed_already",
                                 "detail": f"{len(fire_only)} edges stay closed by fire"})
        elif typ == "capacity_changed":
            f = p.get("capacity_factor")
            if not isinstance(f, (int, float)) or isinstance(f, bool) or not (math.isfinite(f) and 0 < f <= 1):
                raise ActionError("invalid_capacity_factor", "capacity_factor must be in (0, 1]", aid)
        elif typ in ("contraflow", "hold_inbound"):
            c = resolved["corridor"]
            pending_cf = {r["resolved"].get("corridor") for r in self._pending("contraflow")}
            if typ == "contraflow":
                if self._corridor_state(c) == "contraflow" or c in pending_cf:
                    raise ActionError("contraflow_active", f"{c} is already in contraflow", aid)
                if all(s.twin[i] is None for i in edges):
                    raise ActionError("no_reverse_edge", f"{c} has no two-way edges to borrow lanes from", aid)
            elif all(e.closed[i] for i in edges):
                warnings.append({"code": "partially_closed_already", "detail": f"{c} hold edges are already closed"})
            staffed = self._twin_staffed()
            if c not in staffed and len(staffed) >= CHP_UNITS:
                raise ActionError("limit_exceeded", f"CHP_UNITS={CHP_UNITS} corridors already staffed by commands: "
                                  f"{sorted(staffed)}", aid)
        elif typ == "end_contraflow":
            c = resolved["corridor"]
            pending_cf = {r["resolved"].get("corridor") for r in self._pending("contraflow")}
            if self._corridor_state(c) != "contraflow" and c not in pending_cf:
                raise ActionError("contraflow_not_active", f"{c} is not in contraflow", aid)
        elif typ == "open_refuge":
            d = s.dest_ix[resolved["destination_id"]]
            pending = {r["resolved"]["destination_id"] for r in self._pending("open_refuge")}
            if e.dest_open[d] or resolved["destination_id"] in pending:
                raise ActionError("already_open", f"{resolved['destination_id']} is already open", aid)
        elif typ == "fill_destination":
            if e.dest_full[s.dest_ix[resolved["destination_id"]]]:
                raise ActionError("already_full", f"{resolved['destination_id']} is already full", aid)
        elif typ == "reroute_zone" and resolved["destination_id"] is not None:
            d = s.dest_ix[resolved["destination_id"]]
            if e.dest_full[d]:
                warnings.append({"code": "destination_full", "detail": "assigned destination is full; zone falls back"})
            elif not e.dest_open[d]:
                warnings.append({"code": "destination_closed",
                                 "detail": "assigned destination is closed; zone falls back until it opens"})
        return warnings

    def _to_events(self, a: dict, resolved: dict, eff_dt: datetime) -> tuple[list[TrafficEvent], str]:
        s = self.engine.s
        typ, actor = a["type"], a["actor"]
        report = actor["kind"] == "field_report"
        prefix = REPORT_LABEL_PREFIX if report else COMMAND_LABEL_PREFIX
        edges = resolved.get("edge_indexes", [])
        edge_ids = tuple(s.edges[i].id for i in edges)
        zone_ids = tuple(resolved.get("zone_ids", []))
        dest = resolved.get("destination_id")
        road = ", ".join(sorted({s.edges[i].name for i in edges})[:3]) + ("..." if len({s.edges[i].name for i in edges})
                                                                         > 3 else "")
        zones_txt = ", ".join(s.zone_list[s.zone_ix[z]].name for z in zone_ids[:3]) + (
            f" (+{len(zone_ids) - 3})" if len(zone_ids) > 3 else "")
        kw: dict = {}
        if typ == "order_zone":
            ev_type, text = "evacuation_order", f"evacuation order for {zones_txt}"
        elif typ == "warn_zone":
            ev_type, text = "evacuation_warning", f"evacuation warning for {zones_txt}"
        elif typ == "close_road":
            hard = a["params"].get("mode", "entry") == "hard"
            ev_type = "road_blocked" if report and hard else "road_closed"
            kw["closure_drains"] = not hard
            text = f"{'road blocked' if ev_type == 'road_blocked' else 'close'} {road} ({len(edges)} edges, " \
                   f"{'hard stop' if hard else 'entry only'})"
        elif typ == "reopen_road":
            ev_type, text = "road_reopened", f"reopen {road} ({len(edges)} edges)"
        elif typ == "capacity_changed":
            f = float(a["params"]["capacity_factor"])
            ev_type, text = "capacity_changed", f"capacity of {road} set to {f:.0%} ({len(edges)} edges)"
            kw["capacity_factor"] = f
        elif typ == "contraflow":
            ev_type, text = "contraflow_started", f"start contraflow on {resolved['corridor']}"
        elif typ == "end_contraflow":
            ev_type, text = "contraflow_ended", f"end contraflow on {resolved['corridor']}"
        elif typ == "hold_inbound":
            ev_type, text = "road_closed", f"hold inbound traffic on {resolved['corridor']}"
            kw["closure_drains"] = True
        elif typ == "open_refuge":
            ev_type, text = "shelter_opened", f"open {s.dest_list[s.dest_ix[dest]].name}"
        elif typ == "fill_destination":
            ev_type, text = "shelter_full", f"{s.dest_list[s.dest_ix[dest]].name} full"
        else:  # reroute_zone
            ev_type = "zone_rerouted"
            text = (f"route {zones_txt} to {s.dest_list[s.dest_ix[dest]].name}" if dest
                    else f"clear the destination assignment of {zones_txt}")
        label = f"{prefix}: {text}"
        ev = TrafficEvent(
            id=f"twin-{a['id']}", at=eff_dt, type=ev_type, label=label, evidence_class="simulated",
            time_precision=COMMAND_TIME_PRECISION, edge_ids=edge_ids, zone_ids=zone_ids, destination_id=dest,
            source_id=REPORT_SOURCE_ID if report else COMMAND_SOURCE_ID, source_locator=actor["id"], **kw)
        return [ev], label

    # --- reading state

    def events(self, since: int = 0) -> dict:
        gen = self.engine.generated
        if not isinstance(since, int) or since < 0:
            raise TwinError("invalid_cursor", "since must be a nonnegative integer")
        return {"cursor": len(gen), "events": gen[since:]}

    def action_log_hash(self) -> str:
        return _sha([{k: r[k] for k in r if k != "warnings"} for r in self._log])[:16]

    def provenance(self) -> dict:
        i = self.inputs
        return {
            "inputs_fingerprint": i.fingerprint, "sim_version": SIM_VERSION,
            "model": {"id": MODEL_ID, "version": MODEL_VERSION}, "seed": i.params.seed,
            "incident": i.history_id, "roads_package": i.roads_package, "fire_model": i.fire_model_meta,
            "start_at": self.start_at, "action_log_hash": self.action_log_hash(), "actions": len(self._log),
            "evidence_class": "simulated",
        }

    def result(self) -> dict:
        if not self.keep_frames:
            raise TwinError("frames_not_kept", "result() needs a twin created with keep_frames=True")
        if not self.engine.finished:
            raise TwinError("not_finished", "result() needs the session stepped to its end")
        return self.engine.result()

    def _zone_counts(self, rows) -> list[dict]:
        """Per-zone not_departed / en_route / arrived / blocked / exposed / exposed_at_origin."""
        e, s = self.engine, self.engine.s
        nz = s.n_zones
        en_route, blocked, exposed, at_origin = [0] * nz, [0] * nz, [0] * nz, [0] * nz
        stuck_edge = {i for i, _, _, stopped in rows
                      if stopped or (e.next_edge[s.e_to[i]] == -1 and e.open_dest_at(s.e_to[i]) is None)}
        for i in e.active:
            ex, bl = i in e.exposed_edges, i in stuck_edge
            for count, _, zone, _ in e.queue[i]:
                en_route[zone] += count
                if ex:
                    exposed[zone] += count
                if bl:
                    blocked[zone] += count
        for node, q in e.waiting.items():
            stuck = bool(q) and e.next_edge[node] == -1 and e.open_dest_at(node) is None
            for count, zone, _ in q:
                en_route[zone] += count
                if stuck:
                    blocked[zone] += count
        for r in e.returning:
            en_route[r[4]] += r[3]
        burned = e.origin_burned
        if burned:
            if s.agents_on:
                for zi, agents in enumerate(e.zone_waiting_agents):
                    at_origin[zi] += sum(s.ag_count[a] for a in agents if s.ag_node[a] in burned)
                for _, a in e.preparing:
                    if s.ag_node[a] in burned:
                        at_origin[s.ag_zone[a]] += s.ag_count[a]
            else:
                for zi, z in enumerate(s.zone_list):
                    if z.id not in e.released_zones:
                        gone = s.shadow_packets.get(z.id, ()) if z.id in e.shadow_released else ()
                        at_origin[zi] += sum(c for k, (_, n, c) in enumerate(s.zone_packets[z.id])
                                             if n in burned and k not in gone)
                for _, _, node, count, zi in e.pending:
                    if node in burned:
                        at_origin[zi] += count
        out = []
        for zi in range(nz):
            nd = e.z_waiting[zi] + e.z_preparing[zi]
            out.append({"not_departed_veh": nd, "en_route_veh": en_route[zi], "arrived_veh": e.z_arrived[zi],
                        "blocked_veh": blocked[zi], "exposed_veh": exposed[zi], "exposed_at_origin_veh": at_origin[zi]})
            if nd + en_route[zi] + e.z_arrived[zi] != s.zone_list[zi].vehicles:
                raise AssertionError(f"zone {s.zone_list[zi].id}: population not conserved")
        return out

    def _assignment(self, zi: int) -> dict | None:
        e, s = self.engine, self.engine.s
        d = e.zone_dest.get(zi)
        if d is None:
            return None
        if not e.dest_open[d]:
            status = "fallback_closed"
        elif e.dest_full[d]:
            status = "fallback_full"
        else:
            dd = e.dest_dist.get(d)
            nodes = {s.node_ix[n] for n in s.zone_list[zi].origin_nodes}
            status = "following" if dd is not None and any(not math.isinf(dd[n]) for n in nodes) \
                else "fallback_unreachable"
        zone_id = s.zone_list[zi].id
        action_id = next((r["id"] for r in reversed(self._log)
                          if r["type"] == "reroute_zone" and zone_id in r["resolved"]["zone_ids"]), None)
        return {"destination_id": s.dest_list[d].id, "status": status, "action_id": action_id}

    def _in_effect(self, r: dict) -> bool:
        e, s = self.engine, self.engine.s
        typ, res = r["type"], r["resolved"]
        edges = res.get("edge_indexes", [])
        if typ in ("order_zone", "warn_zone"):
            return True
        if typ in ("close_road", "hold_inbound"):
            return any(i in e.event_closed or i in e.event_closed_drain for i in edges)
        if typ == "capacity_changed":
            f = r["params"]["capacity_factor"]
            return f != 1 and any(e.cap_factor.get(i) == f for i in edges)
        if typ == "contraflow":
            return any(i in e.contraflow_out for i in edges)
        if typ == "open_refuge":
            return e.dest_open[s.dest_ix[res["destination_id"]]]
        if typ == "fill_destination":
            return e.dest_full[s.dest_ix[res["destination_id"]]]
        if typ == "reroute_zone":
            d = None if res["destination_id"] is None else s.dest_ix[res["destination_id"]]
            return d is not None and all(e.zone_dest.get(s.zone_ix[z]) == d for z in res["zone_ids"])
        return False  # reopen_road, end_contraflow: one-off

    def snapshot(self, detail: str = "full") -> dict:
        """State after the last completed step (docs/twin-api.md#snapshot). Raises if counts do not add up."""
        if detail not in ("full", "summary"):
            raise TwinError("invalid_detail", "detail must be full or summary")
        e, s = self.engine, self.engine.s
        now_s = e.now_s or 0
        rows = e.edge_rows(now_s)
        counts = e.state_counts(rows)
        nd, er, ar = counts["not_departed_veh"], counts["en_route_veh"], counts["arrived_veh"]
        if not (min(nd, er, ar) >= 0 and nd + er + ar == s.total_veh):
            raise AssertionError(f"population not conserved at {self.now}")
        zone_counts = self._zone_counts(rows)
        for key in ("not_departed_veh", "en_route_veh", "arrived_veh", "blocked_veh", "exposed_veh",
                    "exposed_at_origin_veh"):
            if sum(z[key] for z in zone_counts) != counts[key]:
                raise AssertionError(f"per-zone {key} does not add up to the total at {self.now}")

        def when(sec):
            return None if sec is None else _iso(self.inputs.start + timedelta(seconds=sec))

        zones = []
        for zi, z in enumerate(s.zone_list):
            ordered = e.z_ordered_s[zi] if s.agents_on else e.first_release_s.get(z.id)
            zones.append({"id": z.id, "name": z.name, "vehicles": z.vehicles, "ordered_at": when(ordered),
                          "warned_at": when(e.z_warned_s[zi]), **zone_counts[zi], "assignment": self._assignment(zi)})
        destinations = []
        for k, d in enumerate(s.dest_list):
            recent = sum(n for t, n in reversed(e.dest_series[k][-200:]) if t > now_s - RECENT_ARRIVALS_S)
            destinations.append({
                "id": d.id, "name": d.name, "kind": d.kind, "status": self._dest_status(k),
                "arrived_veh": e.dest_arrived[k], "capacity_veh": d.capacity_veh,
                "remaining_capacity_veh": None if d.capacity_veh is None else max(0, d.capacity_veh - e.dest_arrived[k]),
                "full_at": when(e.dest_full_s[k]), "arrived_last_10_min_veh": recent,
            })
        snap = {
            "kind": "crisistwin_twin_snapshot",
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "evidence_class": "simulated",
            "session": {"id": self.session_id, "incident": self.inputs.history_id},
            "clock": {"now": self.now, "start": _iso(self.inputs.start), "end": _iso(self.inputs.end),
                      "step_s": s.step, "elapsed_s": now_s, "step_index": e.k - 1, "finished": e.finished},
            "model": {"id": MODEL_ID, "version": MODEL_VERSION, "sim_version": SIM_VERSION, "seed": s.params.seed,
                      "inputs_fingerprint": self.inputs.fingerprint, "action_log_hash": self.action_log_hash(),
                      "behavior": s.agents_on},
            "totals": {"total_veh": s.total_veh, **counts,
                       "exposed_veh_min_so_far": round(e.exposed_veh_min, 1),
                       "exposed_at_origin_veh_min_so_far": round(e.exposed_at_origin_veh_min, 1)},
            "zones": zones,
            "destinations": destinations,
            "capacity_factors": [[i, f] for i, f in sorted(e.cap_factor.items()) if f != 1],
            "commands_in_effect": [{"action_id": r["id"], "type": r["type"], "since": r["effective_at"]}
                                   for r in self._log if self._public(r)["status"] == "applied" and self._in_effect(r)],
            "events_cursor": len(e.generated),
        }
        if detail == "full":
            queue = e.queue
            snap["edges"] = {
                "fields": ["edge_index", "veh", "speed_kph", "queued_veh"],
                "rows": [[i, n, round(speed, 1), sum(p[0] for p in queue[i] if p[1] <= now_s)]
                         for i, n, speed, _ in rows],
            }
            closed_rows = []
            for i in e.closed_list:
                cause = ("event" if i in e.event_closed else "event_drain" if i in e.event_closed_drain
                         else "contraflow_inbound" if i in e.contraflow_in else "fire")
                closed_rows.append([i, cause])
            snap["closed"] = {"fields": ["edge_index", "cause"], "rows": closed_rows}
            snap["exposed"] = sorted(e.exposed_edges)
            snap["contraflow"] = sorted([i, j] for i, j in e.contraflow_out.items())
        return snap

    # --- what-if

    def whatif(self, action_sets: list, horizon_min: float = 60, include_baseline: bool = True,
               fire_ahead: str = "replay", labels: list | None = None) -> dict:
        """Fork the current state once per action set (plus the no-new-actions baseline), apply the set,
        run `horizon_min` simulated minutes and compare window metrics. The session never changes."""
        if not isinstance(action_sets, list) or not all(isinstance(x, list) for x in action_sets):
            raise TwinError("invalid_whatif", "action_sets must be a list of lists of actions")
        if len(action_sets) > WHATIF_MAX_SETS:
            raise TwinError("invalid_whatif", f"at most {WHATIF_MAX_SETS} action sets")
        if not isinstance(horizon_min, (int, float)) or not 0 < horizon_min <= WHATIF_MAX_HORIZON_MIN:
            raise TwinError("invalid_whatif", f"horizon_min must be in (0, {WHATIF_MAX_HORIZON_MIN}]")
        if fire_ahead not in FIRE_AHEAD_LIMITATIONS:
            raise TwinError("invalid_whatif", "fire_ahead must be replay or frozen")
        if labels is not None and (not isinstance(labels, list) or len(labels) != len(action_sets)):
            raise TwinError("invalid_whatif", "labels must match action_sets")
        if self.engine.finished:
            raise TwinError("session_finished", "the session has reached its end time")
        s = self.engine.s
        from_s = self.engine.now_s
        until_s = min(from_s + horizon_min * 60, s.n_steps * s.step)
        until_s = int(until_s // s.step * s.step)
        log_hash = self.action_log_hash()
        results = []
        if include_baseline:
            key = (self.engine.k, log_hash, horizon_min, fire_ahead)
            if key not in self._whatif_cache:
                self._whatif_cache[key] = self._whatif_branch([], from_s, until_s, fire_ahead, "b")
            results.append({"set_index": 0, "label": "no new actions", **self._whatif_cache[key]})
        for n, actions in enumerate(action_sets, start=1):
            label = labels[n - 1] if labels else f"set {n}"
            results.append({"set_index": n, "label": label,
                            **self._whatif_branch(actions, from_s, until_s, fire_ahead, f"w{n}")})
        base = results[0] if include_baseline else None
        for r in results:
            if base is not None and r is not base and r["valid"]:
                r["delta_vs_baseline"] = {
                    "objective": round(r["objective"] - base["objective"], 1),
                    "arrived_in_window_veh": r["metrics"]["arrived_in_window_veh"]
                    - base["metrics"]["arrived_in_window_veh"],
                    "total_exposed_veh_min": round(r["metrics"]["total_exposed_veh_min"]
                                                   - base["metrics"]["total_exposed_veh_min"], 1),
                    "blocked_at_horizon_veh": r["metrics"]["blocked_at_horizon_veh"]
                    - base["metrics"]["blocked_at_horizon_veh"],
                }
        valid = [r for r in results if r["valid"]]
        weights = {"total_exposed_veh_min": WHATIF_WEIGHT_EXPOSED_VEH_MIN,
                   "blocked_at_horizon_veh": WHATIF_WEIGHT_BLOCKED_AT_HORIZON_VEH,
                   "remaining_at_horizon_veh": WHATIF_WEIGHT_REMAINING_AT_HORIZON_VEH}
        return {
            "kind": "crisistwin_twin_whatif",
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "evidence_class": "simulated",
            "from": self.now, "until": _iso(self.inputs.start + timedelta(seconds=until_s)),
            "horizon_min": horizon_min, "horizon_clamped": until_s < from_s + horizon_min * 60,
            "fire_ahead": fire_ahead, "seed": s.params.seed,
            "rng_coupling": "shared_state_at_fork" if s.agents_on else "common_delay_draws",
            "inputs_fingerprint": self.inputs.fingerprint, "action_log_hash": log_hash,
            "objective": {"name": "window_cost_veh_min", "sense": "minimize",
                          "formula": " + ".join(f"{w}*{k}" for k, w in weights.items()), "weights": weights},
            "results": results,
            "ranking": [r["set_index"] for r in sorted(valid, key=lambda r: (r["objective"], r["set_index"]))],
            "limitations": [WHATIF_LIMITATIONS[0], FIRE_AHEAD_LIMITATIONS[fire_ahead], WHATIF_LIMITATIONS[1]],
        }

    def _whatif_branch(self, actions: list, from_s: int, until_s: int, fire_ahead: str, id_prefix: str) -> dict:
        t0 = time.perf_counter()  # runtime_ms only (measurement metadata, never model time)
        e0, s = self.engine, self.engine.s
        series = {"exposed": 0.0, "at_origin": 0.0, "en_route": 0.0, "peak_blocked": 0, "peak_exposed": 0,
                  "all_arrived_at": None}
        minutes = s.params.record_every_s / 60

        def hook(t: int, counts: dict) -> None:
            if t <= from_s:
                return
            series["exposed"] += counts["exposed_veh"] * minutes
            series["at_origin"] += counts["exposed_at_origin_veh"] * minutes
            series["en_route"] += counts["en_route_veh"] * minutes
            series["peak_blocked"] = max(series["peak_blocked"], counts["blocked_veh"])
            series["peak_exposed"] = max(series["peak_exposed"], counts["exposed_veh"])
            if series["all_arrived_at"] is None and counts["arrived_veh"] == s.total_veh:
                series["all_arrived_at"] = t

        branch = Twin(self.inputs, e0.fork(keep_outputs=False, metrics_hook=hook), keep_frames=False,
                      start_at=self.start_at, session_id=self.session_id)
        branch._log = json.loads(json.dumps(self._log))
        if fire_ahead == "frozen":
            branch.engine.freeze_fire()
        errors, accepted = [], []
        for j, action in enumerate(actions, start=1):
            if isinstance(action, dict) and "id" not in action:
                action = {**action, "id": f"{id_prefix}-{j}"}
            try:
                accepted.append(branch.apply(action)["action"])
            except ActionError as exc:
                errors.append(exc.to_dict())
        if errors:
            return {"valid": False, "errors": errors, "actions": accepted}
        arrived0 = e0.arrived
        dest0 = list(e0.dest_arrived)
        traps0 = sum(1 for ev in e0.generated if ev["type"] == "vehicles_trapped")
        be = branch.engine
        step_s = s.step
        while not be.finished and be.k * step_s <= until_s:
            be.step()
            if be.arrived == s.total_veh:
                break  # nothing changes once everyone has arrived
        counts = be.state_counts(be.edge_rows(be.now_s))
        arrived = counts["arrived_veh"]
        metrics = {
            "exposed_veh_min": round(series["exposed"], 1),
            "exposed_at_origin_veh_min": round(series["at_origin"], 1),
            "total_exposed_veh_min": round(series["exposed"] + series["at_origin"], 1),
            "en_route_veh_min": round(series["en_route"], 1),
            "arrived_in_window_veh": arrived - arrived0,
            "arrived_at_horizon_veh": arrived,
            "not_departed_at_horizon_veh": counts["not_departed_veh"],
            "en_route_at_horizon_veh": counts["en_route_veh"],
            "remaining_at_horizon_veh": s.total_veh - arrived,
            "blocked_at_horizon_veh": counts["blocked_veh"],
            "peak_blocked_veh": series["peak_blocked"],
            "peak_exposed_veh": series["peak_exposed"],
            "trapped_by_fire_at_horizon_veh": counts["trapped_by_fire_veh"],
            "new_fire_entrapment_events": sum(1 for ev in be.generated if ev["type"] == "vehicles_trapped") - traps0,
            "all_arrived_at": None if series["all_arrived_at"] is None and arrived < s.total_veh else _iso(
                self.inputs.start + timedelta(seconds=series["all_arrived_at"] if series["all_arrived_at"] is not None
                                              else be.now_s)),
            "destinations_full_at_horizon": [d.id for k, d in enumerate(s.dest_list) if be.dest_full[k]],
            "arrived_in_window_by_destination_veh": {d.id: be.dest_arrived[k] - dest0[k]
                                                     for k, d in enumerate(s.dest_list)
                                                     if be.dest_arrived[k] != dest0[k]},
        }
        objective = (WHATIF_WEIGHT_EXPOSED_VEH_MIN * metrics["total_exposed_veh_min"]
                     + WHATIF_WEIGHT_BLOCKED_AT_HORIZON_VEH * metrics["blocked_at_horizon_veh"]
                     + WHATIF_WEIGHT_REMAINING_AT_HORIZON_VEH * metrics["remaining_at_horizon_veh"])
        return {"valid": True, "errors": [], "actions": [
                    {k: a[k] for k in ("id", "type", "effective_at", "resolved", "label")} for a in accepted],
                "metrics": metrics, "objective": round(objective, 1),
                "runtime_ms": round((time.perf_counter() - t0) * 1000)}


# --- demo (python3 -m sim twin-demo)


def demo(package, roads_package, *, start_at: str = "2018-11-08T15:30:00Z", step_min: int = 30,
         horizon_min: int = 60, demand: str = "auto", seed: int = TrafficParams.seed, emit=print) -> dict:
    """Build the Camp twin, step, apply a road closure and a zone reroute, and compare them by what-if."""
    timings = {}
    t = time.perf_counter()
    inputs = camp_inputs(package, roads_package, demand, seed)
    timings["inputs_s"] = round(time.perf_counter() - t, 2)
    t = time.perf_counter()
    twin = Twin.from_inputs(inputs, start_at)
    timings["create_s"] = round(time.perf_counter() - t, 2)
    t = time.perf_counter()
    clock = twin.step_to(_iso(parse_utc(start_at) + timedelta(minutes=step_min)))
    timings["step_s"] = round(time.perf_counter() - t, 2)
    snap = twin.snapshot("full")
    emit(json.dumps({"stage": "snapshot", "clock": clock, "totals": snap["totals"],
                     "busiest_zones": sorted(({"id": z["id"], "not_departed_veh": z["not_departed_veh"],
                                               "en_route_veh": z["en_route_veh"]} for z in snap["zones"]),
                                             key=lambda z: -(z["not_departed_veh"] + z["en_route_veh"]))[:3],
                     "occupied_edges": len(snap["edges"]["rows"]), "closed_edges": len(snap["closed"]["rows"]),
                     "snapshot_bytes": len(json.dumps(snap, separators=(",", ":")))}))
    # The busiest zone is sent to the open exit with the second most arrivals so far (an alternative exit).
    zone = max(snap["zones"], key=lambda z: (z["not_departed_veh"] + z["en_route_veh"], z["id"]))
    exits = sorted((d for d in snap["destinations"] if d["status"] == "open" and d["kind"] == "exit"),
                   key=lambda d: (-d["arrived_veh"], d["id"]))
    target = exits[1] if len(exits) > 1 else exits[0]
    actions = [
        {"type": "close_road", "target": {"road_name": "Skyway", "near": [-121.6132, 39.7679], "radius_m": 300},
         "actor": {"kind": "field_report", "id": "demo-unit-1"},
         "rationale": "demo: field report of a blocked road on Skyway in Paradise"},
        {"type": "reroute_zone", "target": {"zone_id": zone["id"]}, "params": {"destination_id": target["id"]},
         "actor": {"kind": "controller", "id": "demo"}, "rationale": "demo: send the busiest zone to another exit"},
    ]
    t = time.perf_counter()
    report = twin.whatif([actions], horizon_min=horizon_min)
    timings["whatif_s"] = round(time.perf_counter() - t, 2)
    t = time.perf_counter()
    twin.whatif([actions], horizon_min=horizon_min)
    timings["whatif_cached_baseline_s"] = round(time.perf_counter() - t, 2)
    keys = ("total_exposed_veh_min", "exposed_veh_min", "arrived_in_window_veh", "remaining_at_horizon_veh",
            "blocked_at_horizon_veh", "peak_blocked_veh", "trapped_by_fire_at_horizon_veh")
    comparison = [{"set_index": r["set_index"], "label": r["label"], "valid": r["valid"],
                   "objective": r.get("objective"), "runtime_ms": r.get("runtime_ms"), "errors": r["errors"],
                   "actions": [a["label"] for a in r.get("actions", [])],
                   **({k: r["metrics"][k] for k in keys} if r["valid"] else {})} for r in report["results"]]
    emit(json.dumps({"stage": "whatif", "from": report["from"], "until": report["until"],
                     "fire_ahead": report["fire_ahead"], "ranking": report["ranking"], "results": comparison}))
    applied = [twin.apply({**a, "id": f"demo-{n}"}) for n, a in enumerate(actions, start=1)]
    twin.step(6)
    after = twin.snapshot("summary")
    emit(json.dumps({"stage": "applied", "actions": [a["action"]["label"] for a in applied],
                     "warnings": [w for a in applied for w in a["warnings"]],
                     "now": after["clock"]["now"], "commands_in_effect": after["commands_in_effect"],
                     "assignment": next(z["assignment"] for z in after["zones"] if z["id"] == zone["id"]),
                     "timings": timings}))
    return {"report": report, "timings": timings}
