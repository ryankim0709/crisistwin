"""Headless batch runner: scenario x strategy x seed at full speed, scored and compared.

Protocol: docs/strategy-evaluation.md. Usage and formats: docs/batch-runner.md. Decision:
docs/adr/0049-batch-runner.md. Command: ``python manage.py live_batch``.

A run plays one strategy on one scenario with one seed, in **lockstep** on one drill clock (no
wall time, no HTTP, no MongoDB): every ``tick_s`` drill seconds the traffic twin steps, the
injects and generators (2018 record, generated 911/radio, simulated residents, simulated
responders) feed the in-memory state (``RunState``), the drill system replans like the live
controller (planner, proposal diff, auto-approval policy), and every ``decision_every_min`` the
strategy reads the same digest the MCP ``get_situation`` returns and answers with controller
actions (the MCP write tools). At the horizon the clock stops and the run is scored with the AAR
(``aar.compute_aar``, help minutes on the drill clock) and written as a ``RunManifest``.

Every number is a simulated planning experiment (AGENTS.md): generated people, comms and
responders, an uncalibrated traffic twin. A comparison says strategy B did better than A in this
simulator under its stated assumptions, never anything about real evacuations.

Determinism: the same spec, strategy and seed give identical metrics. Random streams are named
per generator with ``evaluation.derive_seed(seed, <generator>)``; ids are counters, never wall
time. Times are UTC; distances metres; coordinates ``[lon, lat]``.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import re
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from livecore import injects as inject_rules
from livecore import public
from livecore.drill import load_drill
from livecore.fire import estimate_fire
from livecore.geo import haversine_m, point_in_multipolygon
from livecore.inbound import congestion_factors
from livecore.planner import PLANNER_VERSION, ZoneGuidance, plan, zone_fire_distances
from livecore.policy import (
    AUTO_REPLAN_MIN_INTERVAL_S,
    GuidanceSummary,
    crowd_driven_zones,
    crowd_only_segments,
    diff,
    partition,
    road_cause,
    summarize,
)
from livecore.responders_sim import Fleet, World
from livecore.routing import Incumbent

from . import aar, twin_service
from .common import iso
from .drillcache import DrillIndex, _build, _response_record, snap_to_segment
from .groundrecord import PARTY_KEY as RECORD_PARTY_KEY
from .groundrecord import REPORT_KIND, get_record
from .state import proposed_json, road_status_json

log = logging.getLogger(__name__)

SPEC_KIND = "crisistwin_batch_scenario"
SPEC_VERSION = "0.1.0"
EVALUATOR_VERSION = "batch-0.1.0"
"""Bump when the runner's scoring, generators' wiring or drill-system rules change (re-score old runs)."""
LABEL = ("Simulated planning experiment (headless batch run): generated fire response, people, comms and "
         "responders on an uncalibrated traffic twin. Not a claim about real evacuations.")
CLOCK_MODES = ("lockstep",)
DEFAULT_TICK_S = 60
DEFAULT_DECISION_EVERY_MIN = 1.0
DEFAULT_RESPONDER_UNITS = 6
TRIAGE_STATUS = {"confirm": "confirmed", "dismiss": "dismissed", "resolve": "resolved", "merge": "dismissed"}
"""``views.TRIAGE_ACTIONS``."""
REPLAN_CAUSE_ON_CONFIRM = {"road_blocked": "road_block", "fire_seen": "fire"}
"""``views.REPLAN_CAUSE_ON_CONFIRM``."""
HELP_STATUS = {"acknowledge": "acknowledged", "assign": "assigned", "resolve": "resolved"}
"""``views.HELP_ACTIONS``."""
CHANNEL_SOURCES = ("record", "comms")
"""Report sources that, like the 2018 record in the live drill, count for nothing (road state, public map,
fire) until a controller confirms them: the record itself and generated 911/radio/rescue items."""
COMMS_PARAMS = "tests/fixtures/ground_rates_camp_2018.json"
"""Camp 2018 calibration of the comms generator (relative to the repository root)."""
SNAP_KINDS = ("road_blocked", "road_passable", "heavy_traffic")
MAX_TOOL_CALLS_PER_TURN = 40
SUMMARY_KEYS = ("exposed_veh_min_so_far", "trapped_by_fire_veh", "arrived_veh", "total_veh")


def _t(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(UTC)
    out = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if out.tzinfo is None:
        raise ValueError(f"time {value!r} needs a zone (Z)")
    return out.astimezone(UTC)


def _sim():
    """Import ``sim`` (twin, generators, evaluation) and the MCP digest from the repository root."""
    twinmod = twin_service._import_sim()
    mcp_root = str(twin_service.REPO_ROOT / "orchestrator_mcp")
    if mcp_root not in sys.path:
        sys.path.append(mcp_root)
    from crisistwin_mcp import digest  # stdlib-only module; no MCP server, no network
    from sim import evaluation, gen_comms, gen_residents

    return twinmod, evaluation, gen_comms, gen_residents, digest


# =====================================================================================
# Scenario spec
# =====================================================================================


@dataclass(frozen=True)
class ScenarioSpec:
    """One scenario of a batch (JSON: docs/batch-runner.md "Scenario spec")."""

    scenario_id: str
    package: Mapping[str, Any]
    """``{"kind": "camp_bundle", "path": ...}`` (twin + all generators) or ``{"kind": "drill_package",
    "path": ...}`` (a Studio drill package: planner, record-free comms off, no twin; see the doc)."""
    start: datetime
    end: datetime
    injects: tuple[Mapping[str, Any], ...] = ()
    comms: Mapping[str, Any] = field(default_factory=lambda: {"enabled": True})
    residents: Mapping[str, Any] = field(default_factory=lambda: {"enabled": True})
    responders: Mapping[str, Any] = field(default_factory=lambda: {"enabled": True, "units": DEFAULT_RESPONDER_UNITS})
    record_2018: bool = True
    seeds: Mapping[str, Any] = field(default_factory=lambda: {"panel": "dev", "n": 8, "root": 0})
    clock: Mapping[str, Any] = field(default_factory=lambda: {
        "mode": "lockstep", "tick_s": DEFAULT_TICK_S, "decision_every_min": DEFAULT_DECISION_EVERY_MIN})
    auto_policy: bool = True
    twin: Mapping[str, Any] = field(default_factory=lambda: {"enabled": True})

    @property
    def tick_s(self) -> int:
        return int(self.clock.get("tick_s", DEFAULT_TICK_S))

    @property
    def decision_every_min(self) -> float:
        return float(self.clock.get("decision_every_min", DEFAULT_DECISION_EVERY_MIN))

    def seed_list(self, evaluation) -> list[int]:
        if "list" in self.seeds:
            return [int(s) for s in self.seeds["list"]]
        return evaluation.seed_panel(int(self.seeds.get("n", 8)), str(self.seeds.get("panel", "dev")),
                                     int(self.seeds.get("root", 0)))

    def generator_params(self) -> dict[str, Any]:
        """Everything that defines the world a block faces; hashed into ``generator_params_hash``.
        The decision cadence is included so runs with different cadences never pair."""
        return {
            "spec_version": SPEC_VERSION, "window": [iso(self.start), iso(self.end)],
            "injects": [dict(i) for i in self.injects], "comms": dict(self.comms), "residents": dict(self.residents),
            "responders": dict(self.responders), "record_2018": self.record_2018, "twin": dict(self.twin),
            "auto_policy": self.auto_policy, "clock": dict(self.clock),
        }

    def to_dict(self) -> dict[str, Any]:
        return {"kind": SPEC_KIND, "scenario_id": self.scenario_id, "package": dict(self.package),
                "window": {"start": iso(self.start), "end": iso(self.end)}, "seeds": dict(self.seeds),
                **{k: v for k, v in self.generator_params().items() if k not in ("window", "spec_version")}}


def spec_from_dict(d: Mapping[str, Any]) -> ScenarioSpec:
    """Validate and build a spec; ``ValueError`` with a readable message otherwise."""
    if d.get("kind", SPEC_KIND) != SPEC_KIND:
        raise ValueError(f"not a batch scenario spec: kind={d.get('kind')!r}")
    sid = d.get("scenario_id")
    if not isinstance(sid, str) or not sid:
        raise ValueError("scenario_id must be a non-empty string")
    pkg = d.get("package") or {}
    if pkg.get("kind") not in ("camp_bundle", "drill_package") or not isinstance(pkg.get("path"), str):
        raise ValueError("package must be {kind: camp_bundle | drill_package, path: str}")
    window = d.get("window") or {}
    start, end = _t(window["start"]), _t(window["end"])
    if not start < end:
        raise ValueError("window.start must be before window.end")
    clock = {"mode": "lockstep", "tick_s": DEFAULT_TICK_S, "decision_every_min": DEFAULT_DECISION_EVERY_MIN,
             **(d.get("clock") or {})}
    if clock["mode"] not in CLOCK_MODES:
        raise ValueError(f"clock.mode must be one of {CLOCK_MODES} (realtime@k is not built)")
    if int(clock["tick_s"]) < 10 or int(clock["tick_s"]) % 10:
        raise ValueError("clock.tick_s must be a multiple of the twin step (10 s)")
    if float(clock["decision_every_min"]) * 60 < int(clock["tick_s"]):
        raise ValueError("clock.decision_every_min must be at least one tick")
    injects = tuple(d.get("injects") or ())
    for inj in injects:
        if inj.get("type") not in inject_rules.TYPES or "at" not in inj:
            raise ValueError(f"inject needs type in {inject_rules.TYPES} and at: {inj!r}")
        _t(inj["at"])
    seeds = {"panel": "dev", "n": 8, "root": 0, **(d.get("seeds") or {})}
    if seeds.get("panel") not in ("dev", "test") and "list" not in seeds:
        raise ValueError("seeds.panel must be dev or test (or give seeds.list)")
    responders = {"enabled": True, "units": DEFAULT_RESPONDER_UNITS, **(d.get("responders") or {})}
    if responders["enabled"] and int(responders["units"]) < 1:
        raise ValueError("responders.units must be >= 1")
    return ScenarioSpec(
        scenario_id=sid, package=dict(pkg), start=start, end=end, injects=injects,
        comms={"enabled": True, **(d.get("comms") or {})},
        residents={"enabled": True, **(d.get("residents") or {})},
        responders=responders, record_2018=bool(d.get("record_2018", True)), seeds=seeds, clock=clock,
        auto_policy=bool(d.get("auto_policy", True)), twin={"enabled": True, **(d.get("twin") or {})},
    )


def load_spec(path: str | Path) -> ScenarioSpec:
    return spec_from_dict(json.loads(Path(path).read_text()))


# =====================================================================================
# The world a spec plays in (built once per process)
# =====================================================================================


@dataclass
class ScenarioWorld:
    spec: ScenarioSpec
    index: DrillIndex
    package_hash: str
    bundle: dict[str, Any] | None
    base_inputs: Any | None
    """Twin inputs at the live seed; per-seed inputs share its fire timeline (``twin_inputs``)."""
    record: Any | None
    comms_params: Any | None
    _inputs: dict[int, Any] = field(default_factory=dict)
    _comms: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    _distances: dict[tuple, dict[str, float | None]] = field(default_factory=dict)

    def zone_distances(self, fire: Any, spots_key: tuple) -> dict[str, float | None]:
        """Zone-to-fire distances per fire geometry (source, time and injected spots), shared by all runs."""
        key = (fire.method, fire.as_of, spots_key)
        if key not in self._distances:
            self._distances[key] = zone_fire_distances(self.index.drill, fire)
        return self._distances[key]

    def twin_inputs(self, twin_seed: int):
        """Inputs with ``TrafficParams.seed = twin_seed`` (fresh engine template, shared fire timeline)."""
        if self.base_inputs is None:
            return None
        if twin_seed not in self._inputs:
            twinmod = _sim()[0]
            base = self.base_inputs
            twinmod._template(base)
            params = dataclasses.replace(base.params, seed=twin_seed)
            fingerprint = twinmod.inputs_fingerprint(base.scenario, params, base.start, base.end, base.fire_model_meta)
            self._inputs = {twin_seed: dataclasses.replace(base, params=params, fingerprint=fingerprint,
                                                           cache={"timeline": base.cache["timeline"]})}
        return self._inputs[twin_seed]

    def comms_items(self, seed: int) -> list[dict[str, Any]]:
        """Generated 911/radio/rescue items for the block (exogenous: drawn up front from the seed)."""
        if not self.spec.comms.get("enabled") or self.bundle is None:
            return []
        if seed not in self._comms:
            _, evaluation, gen_comms, _, _ = _sim()
            opts = gen_comms.CommsOptions(
                scale_911=self.spec.comms.get("scale_911"),
                nist_sample_like=bool(self.spec.comms.get("nist_sample_like", False)),
                psap_reroute_at=_t(self.spec.comms["psap_reroute_at"]) if self.spec.comms.get("psap_reroute_at") else None,
            )
            items = gen_comms.generate_comms(
                gen_comms.zones_from_bundle(self.bundle), gen_comms.roads_from_bundle(self.bundle),
                (self.spec.start, self.spec.end), self.comms_params, evaluation.derive_seed(seed, "comms"), opts)
            self._comms = {seed: items}
        return self._comms[seed]


def build_world(spec: ScenarioSpec, progress: Callable[[str], None] = lambda s: None) -> ScenarioWorld:
    t0 = time.perf_counter()
    twinmod, _, gen_comms, _, _ = _sim()
    path = Path(spec.package["path"])
    if not path.is_absolute():
        path = twin_service.REPO_ROOT / path
    raw = path.read_bytes()
    package_hash = hashlib.sha256(raw).hexdigest()[:16]
    if spec.package["kind"] == "camp_bundle":
        drill = load_drill(path)
        built = _build(drill)
        index = dataclasses.replace(built, response_record=_response_record(built.drill, path))
        bundle = json.loads(raw)
    else:
        from livecore.package import load_package

        drill = load_package(path)
        index = _build(drill)
        bundle = None
    base_inputs = None
    if spec.twin.get("enabled") and spec.package["kind"] == "camp_bundle":
        base_inputs = twin_service.build_camp_inputs()
    record = None
    if spec.record_2018 and spec.package["kind"] == "camp_bundle":
        record = get_record(index)
        if not record.available:
            raise ValueError("record_2018 is on but tools/camp_ground_record.json is not available")
    comms_params = None
    if spec.comms.get("enabled") and bundle is not None:
        comms_params = gen_comms.params_from_dict(json.loads((twin_service.REPO_ROOT / COMMS_PARAMS).read_text()))
    progress(f"world {spec.scenario_id} ({package_hash}) built in {time.perf_counter() - t0:.1f} s")
    return ScenarioWorld(spec, index, package_hash, bundle, base_inputs, record, comms_params)


# =====================================================================================
# In-memory drill state (the live_* collections of one run)
# =====================================================================================


def _jsonable(v: Any) -> Any:
    if isinstance(v, datetime):
        return iso(v)
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items() if not k.startswith("_")}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


class ActionRejected(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code, self.detail = code, detail


class RunState:
    """Documents shaped like the live collections, every time on the drill clock (``at == replay_at``).

    ``apply(action)`` is the controller surface: the MCP write tools' names and arguments
    (``triage_report``, ``approve_proposal``, ``reject_proposal``, ``replan``, ``create_task``,
    ``handle_help``). The drill system (planner + auto policy) runs inside, as in the live backend."""

    def __init__(self, world: ScenarioWorld, seed: int, twin: Any, drill_system: bool, actor: str) -> None:
        self.world, self.index, self.spec = world, world.index, world.spec
        self.seed = seed
        self.twin = twin
        self.twinmod = _sim()[0]
        self.drill_system = drill_system
        self.actor = actor
        self.incident_id = self.index.drill.incident_id
        self.now: datetime = self.spec.start
        self.reports: dict[str, dict[str, Any]] = {}
        self.decisions: list[dict[str, Any]] = []
        self.proposals: dict[str, dict[str, Any]] = {}
        self.guidance_docs: list[dict[str, Any]] = []
        self.current: dict[str, dict[str, Any]] = {}
        self.published: dict[str, ZoneGuidance] = {}
        self.published_at: dict[str, datetime] = {}
        self.checkins: dict[str, dict[str, Any]] = {}
        self.checkin_of: dict[str, str] = {}
        self.tasks: dict[str, dict[str, Any]] = {}
        self.responders: dict[str, dict[str, Any]] = {}
        self.preferences: dict[tuple[str, str], int] = {}
        self.injects_done: set[int] = set()
        self.silent_closed: set[str] = set()
        self.twin_closed: set[str] = set()
        self.zone_dest: dict[str, str | None] = {}
        self.last_plan: dict[str, Any] | None = None
        self.turn_causes: list[str] | None = None
        """Inside a strategy turn: replan causes from confirms, run once at the turn's end (``end_turn``)."""
        self.last_replan_at: datetime | None = None
        self.counters: dict[str, int] = {}
        self.stats: dict[str, int] = {k: 0 for k in (
            "replans", "auto_publishes", "approvals", "rejections", "confirms", "dismissals", "tasks_created",
            "help_assigned", "tool_calls", "tool_errors", "twin_commands", "twin_errors", "reports_record",
            "reports_comms", "reports_residents", "reports_responders", "dropped_psap", "dropped_outage")}
        self.action_log: list[dict[str, Any]] = []
        self.twin_errors: list[dict[str, Any]] = []
        self._road_cache: tuple[int, datetime, list, list, list] | None = None
        self._report_rev = 0
        self._spots_key: tuple = ()
        self._json_cache: dict[str, dict[str, Any]] = {}

    # -- ids and time

    def _id(self, prefix: str) -> str:
        n = self.counters[prefix] = self.counters.get(prefix, 0) + 1
        return f"{prefix}{n:06d}"

    def _decision(self, actor: str, action: str, **kw: Any) -> None:
        self.decisions.append({"incident_id": self.incident_id, "at": self.now, "replay_at": self.now, "actor": actor,
                               "action": action, "report_ids": kw.get("report_ids") or [],
                               "proposal_id": kw.get("proposal_id"), "checkin_id": kw.get("checkin_id"),
                               "note": kw.get("note")})

    # -- twin commands

    def _twin_apply(self, action: dict[str, Any], key: str) -> bool:
        if self.twin is None:
            return False
        self.stats["twin_commands"] += 1
        try:
            self.twin.apply({**action, "id": f"batch-{self.stats['twin_commands']}"})
            return True
        except self.twinmod.ActionError as exc:
            if exc.code not in ("already_ordered", "not_closed"):
                self.stats["twin_errors"] += 1
                self.twin_errors.append({"key": key, "at": self.twin.now, **exc.to_dict()})
            return False

    # -- reports

    def add_report(self, *, kind: str, coord: Sequence[float], at: datetime, role: str, party_key: str, source: str,
                   evidence_class: str, severity: str | None = None, note: str | None = None,
                   task_id: str | None = None, destination_id: str | None = None,
                   extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
        road_ref = None
        if kind in SNAP_KINDS:
            snapped = snap_to_segment(self.index, (float(coord[0]), float(coord[1])))
            if snapped:
                road_ref = {"segment_id": snapped[0], "name": self.index.segment_names.get(snapped[0]),
                            "snap_m": round(snapped[1], 1)}
        rid = self._id("rpt_")
        doc = {
            "id": rid, "incident_id": self.incident_id, "kind": kind, "severity": severity,
            "reporter": {"role": role, "party_key": party_key},
            "location": {"coord": [float(coord[0]), float(coord[1])]}, "road_ref": road_ref,
            "destination_id": destination_id, "task_id": task_id, "observed_at": at, "received_at": at,
            "replay_at": at, "updated_at": at, "note": note, "status": "unverified",
            "evidence_class": evidence_class, "source": source, **(extra or {}),
        }
        self.reports[rid] = doc
        self._report_rev += 1
        self.stats[f"reports_{source}"] = self.stats.get(f"reports_{source}", 0) + 1
        return doc

    def _counts(self, doc: Mapping[str, Any]) -> bool:
        return doc.get("source") not in CHANNEL_SOURCES or doc["status"] in ("confirmed", "resolved")

    def public_view(self) -> tuple[list[public.ReportFact], list[public.PublicItem], list[public.RoadStatus]]:
        """Facts, public items and road state at ``now`` (``state.load_public`` on the drill clock)."""
        key = (self._report_rev, self.now)
        if self._road_cache is None or self._road_cache[:2] != key:
            facts = [_fact(d) for d in self.reports.values() if self._counts(d)]
            items = public.public_items(facts, self.now, self.index.segment_lines)
            state = public.road_state(facts, self.now)
            self._road_cache = (*key, facts, items, state)
        return self._road_cache[2], self._road_cache[3], self._road_cache[4]

    def fire(self):
        facts, items, _ = self.public_view()
        spots = inject_rules.spots_due(self._due_injects(), self.now)
        fire = estimate_fire(self.index.drill, self.now, public.confirmed_fire_points(facts, items), spots)
        self._spots_key = tuple((iso(a), tuple(c), r) for a, c, r in spots)
        return fire

    def _due_injects(self) -> list[dict[str, Any]]:
        return [{"id": f"inj_{i}", "type": d["type"], "at": _t(d["at"]), "params": dict(d.get("params") or {})}
                for i, d in enumerate(self.spec.injects)]

    # -- twin sync of road closures and injects

    def sync_twin(self) -> None:
        if self.twin is None:
            return
        _, _, state = self.public_view()
        want = set(public.guidance_blocked_segments(state)) | set(public.controller_blocked_segments(state))
        edges = self.index.drill.roads.segment_edges
        for seg in sorted(want - self.twin_closed):
            if edges.get(seg):
                self._twin_apply({"type": "close_road", "target": {"edge_ids": list(edges[seg])}, "params": {"mode": "hard"},
                                  "actor": {"kind": "field_report", "id": "batch-road-state"},
                                  "rationale": "batch: blocked in road state"}, f"block:{seg}")
            self.twin_closed.add(seg)
        for seg in sorted(self.twin_closed - want - self.silent_closed):
            if edges.get(seg):
                self._twin_apply({"type": "reopen_road", "target": {"edge_ids": list(edges[seg])}, "params": {},
                                  "actor": {"kind": "field_report", "id": "batch-road-state"},
                                  "rationale": "batch: block no longer in effect"}, f"reopen:{seg}")
            self.twin_closed.discard(seg)

    def apply_injects(self) -> None:
        for i, inj in enumerate(self.spec.injects):
            if i in self.injects_done or _t(inj["at"]) > self.now:
                continue
            self.injects_done.add(i)
            params = inj.get("params") or {}
            actor = {"kind": "operator", "id": f"inject:{i}"}
            if inj["type"] == "silent_closure":
                seg = params["segment_id"]
                self.silent_closed.add(seg)
                edge_ids = list(self.index.drill.roads.segment_edges.get(seg, ()))
                if edge_ids:
                    self._twin_apply({"type": "close_road", "target": {"edge_ids": edge_ids}, "params": {"mode": "hard"},
                                      "actor": actor, "rationale": "Injected (simulated): closed, no report"}, f"inject:{i}")
            elif inj["type"] == "shelter_full":
                self._twin_apply({"type": "fill_destination", "target": {"destination_id": params["destination_id"]},
                                  "params": {}, "actor": actor, "rationale": "Injected (simulated): full"}, f"inject:{i}")

    def zone_blocked_by(self, kind: str, zone_id: str | None, at: datetime) -> bool:
        """True when a ``psap_reroute`` (911) or ``comms_outage`` (app traffic) inject covers the zone at ``at``."""
        if zone_id is None:
            return False
        windows = inject_rules.zone_windows(self._due_injects(), kind)
        return inject_rules.in_window(windows.get(zone_id, ()), at)

    # -- planner and proposals (controller.replan on the drill clock)

    def plan_inputs(self) -> dict[str, Any]:
        _, items, state = self.public_view()
        fire = self.fire()
        return {"fire": fire, "fire_as_of": iso(fire.as_of) if fire.as_of else None, "fire_method": fire.method,
                "blocked": sorted(public.guidance_blocked_segments(state)),
                "full": sorted(public.full_destination_ids(items)), "state": state}

    def maybe_auto_replan(self) -> None:
        """``controller.maybe_auto_replan``: replan when the fire estimate, the blocked set or the full
        shelters changed, at most once per AUTO_REPLAN_MIN_INTERVAL_S drill seconds."""
        if not self.drill_system:
            return
        cur = self.plan_inputs()
        last = self.last_plan
        causes: list[str] = []
        if last is None or (last["fire_as_of"], last["fire_method"]) != (cur["fire_as_of"], cur["fire_method"]):
            causes.append("fire")
        road = road_cause(last["blocked"] if last else [], cur["blocked"], cur["state"])
        if road is not None:
            causes.append(road)
        if (last["full"] if last else []) != cur["full"]:
            causes.append("shelter_full")
        if not causes:
            return
        if self.last_replan_at and (self.now - self.last_replan_at).total_seconds() < AUTO_REPLAN_MIN_INTERVAL_S:
            return
        self.replan(causes, cur)

    def replan(self, causes: list[str], cur: dict[str, Any] | None = None) -> dict[str, Any] | None:
        cur = cur or self.plan_inputs()
        self.last_plan, self.last_replan_at = cur, self.now
        self.stats["replans"] += 1
        drill, fire = self.index.drill, cur["fire"]
        blocked = frozenset(cur["blocked"])
        congestion = incumbents = None
        if self.twin is not None:
            congestion = congestion_factors(twin_service.edge_speed_rows(self.twin), drill.roads.edges)
            incumbents = {
                z: Incumbent(g.destination_id, tuple(g.route.edge_ids), (self.now - self.published_at[z]).total_seconds())
                for z, g in self.published.items()
                if g.level != "none" and not g.no_route and g.destination_id is not None and g.route is not None
            }
        dist = self.world.zone_distances(fire, self._spots_key)
        guidance = plan(drill, self.now, fire, blocked, cur["full"], congestion=congestion, incumbents=incumbents,
                        zone_distances_km=dist)
        changes = diff(self._summaries(), guidance)
        held: set[str] = set()
        crowd = crowd_only_segments(blocked, cur["state"])
        if crowd and changes:
            without = plan(drill, self.now, fire, blocked - crowd, cur["full"], congestion=congestion,
                           incumbents=incumbents, zone_distances_km=dist)
            held = crowd_driven_zones(guidance, without)
        if "manual" in causes or not self.spec.auto_policy:
            auto, rest = [], list(changes)
        else:
            auto, rest = partition(changes, causes, held=held)
        if auto:
            doc = self._proposal("auto_approved", "auto_reroute", auto, causes)
            doc.update(decided_at=self.now, decided_by="auto_policy", decided_replay_at=self.now)
            self._publish(doc, auto, "auto_policy")
            self._decision("auto_policy", "auto_approve", proposal_id=doc["id"])
            self.stats["auto_publishes"] += 1
        pending = None
        if rest:
            key = [(c.zone_id, c.kind, summarize(c.after)) for c in rest]
            latest = self._pending()
            if latest is not None and latest["_key"] == key:
                pending = latest
            else:
                for p in self.proposals.values():
                    if p["status"] == "pending":
                        p.update(status="superseded", decided_at=self.now)
                pending = self._proposal("pending", "needs_controller", rest,
                                         sorted({*causes, *(["road_report"] if held & {c.zone_id for c in rest} else [])}))
                pending["_key"] = key
        return pending

    def _summaries(self) -> dict[str, GuidanceSummary]:
        return {z: summarize(g) for z, g in self.published.items()}

    def _pending(self) -> dict[str, Any] | None:
        pend = [p for p in self.proposals.values() if p["status"] == "pending"]
        return pend[-1] if pend else None

    def _proposal(self, status: str, policy: str, changes: list[Any], causes: list[str]) -> dict[str, Any]:
        doc = {
            "id": self._id("prp_"), "incident_id": self.incident_id, "created_at": self.now, "replay_at": self.now,
            "status": status, "policy": policy, "causes": list(causes), "cause_segment_ids": [],
            "changes": [_change_json(self.index, c) for c in changes], "_changes": list(changes), "tasks": [],
            "controller": {"id": "rule", "planner_version": PLANNER_VERSION},
            "decided_at": None, "decided_by": None, "decided_replay_at": None, "parent_id": None, "note": None,
        }
        self.proposals[doc["id"]] = doc
        return doc

    def _publish(self, doc: dict[str, Any], changes: Sequence[Any], approved_by: str) -> None:
        """``controller.publish`` plus the twin commands ``twin_service`` would send."""
        for c in changes:
            g: ZoneGuidance = c.after
            zid = c.zone_id
            version = (self.current[zid]["version"] if zid in self.current else 0) + 1
            gdoc = {"incident_id": self.incident_id, "zone_id": zid, **_proposed(self.index, g), "version": version,
                    "published_at": self.now, "replay_at": self.now, "approved_by": approved_by,
                    "proposal_id": doc["id"]}
            self.guidance_docs.append(gdoc)
            self.current[zid] = gdoc
            self.published[zid] = g
            self.published_at[zid] = self.now
            actor = {"kind": "controller", "id": f"live-guidance:{approved_by}"}
            if g.level == "evacuate_now":
                self._twin_apply({"type": "order_zone", "target": {"zone_id": zid}, "params": {}, "actor": actor,
                                  "rationale": f"Published guidance v{version}"}, f"order:{zid}")
            dest = g.destination_id if g.level != "none" and not g.no_route else None
            if dest != self.zone_dest.get(zid) and (dest is not None or zid in self.zone_dest):
                if self._twin_apply({"type": "reroute_zone", "target": {"zone_id": zid},
                                     "params": {"destination_id": dest}, "actor": actor,
                                     "rationale": f"Published guidance v{version}"}, f"route:{zid}"):
                    self.zone_dest[zid] = dest

    # -- the controller surface (MCP write tools)

    def apply(self, action: Mapping[str, Any]) -> dict[str, Any]:
        """Apply one ``{"tool": name, "args": {...}}``; returns ``{"ok": true, ...}`` or the rejection."""
        tool, args = action.get("tool"), dict(action.get("args") or {})
        self.stats["tool_calls"] += 1
        entry = {"at": iso(self.now), "tool": tool, "args": args}
        try:
            fn = getattr(self, f"_tool_{tool}", None) if isinstance(tool, str) else None
            if fn is None:
                raise ActionRejected("unknown_tool", f"Unknown tool {tool!r}.")
            result = {"ok": True, **(fn(**args) or {})}
        except ActionRejected as exc:
            self.stats["tool_errors"] += 1
            result = {"ok": False, "error": exc.code, "detail": exc.detail}
        except TypeError as exc:
            self.stats["tool_errors"] += 1
            result = {"ok": False, "error": "invalid_request", "detail": str(exc)}
        entry["ok"] = result["ok"]
        self.action_log.append(entry)
        return result

    def _tool_triage_report(self, report_id: str, action: str, note: str | None = None, into: str | None = None):
        r = self.reports.get(report_id)
        if r is None:
            raise ActionRejected("not_found", "Unknown report.")
        if action not in TRIAGE_STATUS:
            raise ActionRejected("invalid_request", "`action` must be confirm, dismiss, merge or resolve.")
        ids = [report_id]
        if action == "merge":
            if not into or into == report_id or into not in self.reports:
                raise ActionRejected("invalid_request", "`merge` needs `into`, another report id.")
            r["merged_into"] = into
            ids.append(into)
        r.update(status=TRIAGE_STATUS[action], updated_at=self.now)
        self._report_rev += 1
        self.stats["confirms" if action == "confirm" else "dismissals"] += 1
        self._decision(self.actor, action, report_ids=ids, note=note)
        cause = REPLAN_CAUSE_ON_CONFIRM.get(r["kind"]) if action == "confirm" else None
        out: dict[str, Any] = {"report": {"id": report_id, "status": r["status"]}}
        if cause and self.drill_system:
            if self.turn_causes is not None:
                self.turn_causes.append(cause)
                out["replan"] = {"deferred": "end of turn"}
            else:
                pending = self.replan([cause])
                out["replan"] = {"proposal": pending["id"] if pending else None}
        if self.turn_causes is None:
            self.sync_twin()
        return out

    def begin_turn(self) -> None:
        self.turn_causes = []

    def end_turn(self) -> None:
        """One replan for every confirm of the turn (same drill time), as the live lazy replan coalesces."""
        causes, self.turn_causes = self.turn_causes, None
        if causes and self.drill_system:
            self.replan(sorted(set(causes)))
        self.sync_twin()

    def _decide(self, proposal_id: str, zone_ids: Sequence[str] | None, note: str | None, approve: bool):
        p = self.proposals.get(proposal_id)
        if p is None or p["status"] != "pending":
            raise ActionRejected("conflict", "This proposal is no longer pending.")
        changes = p["_changes"]
        if approve and zone_ids:
            chosen = set(zone_ids)
            unknown = chosen - {c.zone_id for c in changes}
            if unknown:
                raise ActionRejected("invalid_request", f"Zones not in the proposal: {sorted(unknown)}")
            take = [c for c in changes if c.zone_id in chosen]
            rest = [c for c in changes if c.zone_id not in chosen]
        else:
            take, rest = (list(changes), []) if approve else ([], [])
        p.update(status="approved" if approve else "rejected", decided_at=self.now, decided_by=self.actor,
                 decided_replay_at=self.now, note=note)
        if take:
            self._publish(p, take, self.actor)
        self._decision(self.actor, "approve" if approve else "reject", proposal_id=proposal_id, note=note)
        self.stats["approvals" if approve else "rejections"] += 1
        child = None
        if rest:
            child = self._proposal("pending", "needs_controller", rest, p["causes"])
            child.update(parent_id=p["id"], _key=[(c.zone_id, c.kind, summarize(c.after)) for c in rest])
        return {"proposal": {"id": proposal_id, "status": p["status"]}, "published": [c.zone_id for c in take],
                "remaining_proposal": child["id"] if child else None}

    def _tool_approve_proposal(self, proposal_id: str, zone_ids: Sequence[str] | None = None, note: str | None = None):
        return self._decide(proposal_id, zone_ids, note, True)

    def _tool_reject_proposal(self, proposal_id: str, note: str | None = None):
        return self._decide(proposal_id, None, note, False)

    def _tool_replan(self):
        if not self.drill_system:
            raise ActionRejected("unavailable", "The drill system is off in this run (historical only).")
        pending = self.replan(["manual"])
        return {"proposal": pending["id"] if pending else None}

    def _tool_create_task(self, kind: str = "verify", target: Mapping[str, Any] | None = None,
                          report_ids: Sequence[str] | None = None, assignee: str | None = None,
                          note: str | None = None, checkin_id: str | None = None):
        if kind not in ("verify", "assist"):
            raise ActionRejected("invalid_request", "`kind` must be verify or assist.")
        target = dict(target or {})
        seg, coord = target.get("segment_id"), target.get("coord")
        if seg is not None and seg not in self.index.segment_lines:
            raise ActionRejected("invalid_request", "Unknown `target.segment_id`.")
        if coord is None and seg is not None:
            line = self.index.segment_lines[seg]
            coord = list(line[len(line) // 2])
        if coord is None:
            raise ActionRejected("invalid_request", "`target` needs `segment_id` or `coord`.")
        if assignee is not None and assignee not in self.responders:
            raise ActionRejected("invalid_request", "`assignee` must be a known responder party_key or null.")
        task = {"id": self._id("tsk_"), "incident_id": self.incident_id, "assignee": assignee, "kind": kind,
                "checkin_id": checkin_id, "target": {"segment_id": seg, "coord": [float(coord[0]), float(coord[1])]},
                "report_ids": list(report_ids or []), "note": note, "created_at": self.now,
                "created_replay_at": self.now, "status": "open", "accepted_at": None, "closed_at": None}
        self.tasks[task["id"]] = task
        self.stats["tasks_created"] += 1
        return {"task": {"id": task["id"], "status": "open"}}

    def _tool_handle_help(self, checkin_id: str, action: str, assignee: str | None = None, note: str | None = None):
        c = self.checkins.get(checkin_id)
        if c is None:
            raise ActionRejected("not_found", "Unknown check-in.")
        if action not in HELP_STATUS:
            raise ActionRejected("invalid_request", "`action` must be acknowledge, assign or resolve.")
        help_ = c.get("help") or {}
        if c["status"] != "need_help" or help_.get("status") == "resolved":
            raise ActionRejected("conflict", "This help request is closed.")
        if action == "assign":
            if c.get("coord") is None:
                raise ActionRejected("invalid_request", "The resident did not share a location.")
            if help_.get("task_id") and self.tasks[help_["task_id"]]["status"] in ("open", "accepted"):
                self.tasks[help_["task_id"]].update(status="cancelled", closed_at=self.now, closed_replay_at=self.now)
            task = self._tool_create_task("assist", {"coord": c["coord"]}, [], assignee, note, checkin_id)["task"]
            help_.update(assignee=assignee, task_id=task["id"])
            self.stats["help_assigned"] += 1
        elif action == "resolve" and help_.get("task_id"):
            t = self.tasks[help_["task_id"]]
            if t["status"] in ("open", "accepted"):
                t.update(status="done", closed_at=self.now, closed_replay_at=self.now)
        help_.update(status=HELP_STATUS[action], updated_at=self.now, replay_at=self.now)
        c["help"] = help_
        self._decision(self.actor, f"help_{action}", checkin_id=checkin_id, note=note)
        return {"checkin": {"id": checkin_id, "help": _jsonable(help_)}}

    # -- read surface: the controller command and the twin monitor, as the MCP digest reads them

    def command(self, max_reports: int = 5000) -> dict[str, Any]:
        _, _, state = self.public_view()
        fire = self.fire()
        reports = sorted(self.reports.values(), key=lambda r: (r["received_at"], r["id"]), reverse=True)[:max_reports]
        by_zone: dict[str, dict[str, Any]] = {}
        need_help = []
        for c in self.checkins.values():
            row = by_zone.setdefault(c.get("zone_id") or "", {"zone_id": c.get("zone_id"), "out": 0, "need_help": 0,
                                                              "staying": 0})
            row[c["status"]] += 1
            if c["status"] == "need_help":
                need_help.append({"id": c["id"], "zone_id": c.get("zone_id"), "coord": c.get("coord"),
                                  "at": iso(c["at"]), "help": _jsonable(c.get("help"))})
        prefs = [{"zone_id": z, "destination_id": d, "count": n} for (z, d), n in sorted(self.preferences.items())]
        return {
            "incident_id": self.incident_id, "generated_at": iso(self.now),
            "drill": {"label": LABEL, "replay_now": iso(self.now), "speed": 0, "running": True,
                      "started_at": iso(self.spec.start)},
            "fire": {"method": fire.method, "as_of": iso(fire.as_of) if fire.as_of else None, "label": fire.label,
                     "evidence_class": fire.evidence_class, "observations": [None] * len(fire.observations)},
            "zones": [{k: v for k, v in z.items() if k != "geometry"} for z in self.index.command_zones_json],
            "guidance": [_jsonable(g) for g in self.current.values()],
            "checkins": {"by_zone": [r for r in by_zone.values() if r["zone_id"]], "need_help": need_help},
            "reports": [self._report_json(r) for r in reports],
            "tasks": [_jsonable(t) for t in self.tasks.values()],
            "proposals": [_jsonable(p) for p in sorted(self.proposals.values(), key=lambda p: p["id"], reverse=True)
                          if p["status"] == "pending"][:1]
            + [_jsonable(p) for p in sorted(self.proposals.values(), key=lambda p: p["id"], reverse=True)
               if p["status"] != "pending"][:20],
            "responders": [{"party_key": k, "coord": v["coord"], "at": iso(v["at"])} for k, v in sorted(self.responders.items())],
            "road_state": [_jsonable(road_status_json(s)) for s in state],
            "destination_preferences": prefs,
            "decisions": [_jsonable(d) for d in self.decisions[-5:][::-1]],
        }

    def _report_json(self, r: dict[str, Any]) -> dict[str, Any]:
        key = r["id"]
        cached = self._json_cache.get(key)
        if cached is None or cached["status"] != r["status"]:
            cached = self._json_cache[key] = _jsonable(r)
        return cached

    def twin_monitor(self) -> dict[str, Any] | None:
        if self.twin is None:
            return None
        snap = self.twin.snapshot(detail="summary")
        totals = snap["totals"]
        return {
            "label": "Simulated traffic twin (batch run).", "clock": {"now": self.twin.now},
            "totals": totals,
            "conserved": totals["not_departed_veh"] + totals["en_route_veh"] + totals["arrived_veh"] == totals["total_veh"],
            "zones": [{k: z.get(k) for k in ("id", "vehicles", "ordered_at", "not_departed_veh", "en_route_veh",
                                              "arrived_veh", "blocked_veh", "exposed_veh")} for z in snap["zones"]],
            "command_errors": self.twin_errors,
        }

    # -- AAR inputs

    def aar_data(self) -> aar.AarData:
        mon = self.twin_monitor()
        twin = aar.twin_outcomes(mon) if mon else aar.AarData().twin
        return aar.AarData(
            decisions=list(self.decisions), proposals=list(self.proposals.values()),
            checkins=list(self.checkins.values()), guidance=list(self.guidance_docs),
            reports=[r for r in self.reports.values() if r["evidence_class"] != "historical_record"],
            tasks=list(self.tasks.values()), twin=twin,
        )


def _fact(doc: Mapping[str, Any]) -> public.ReportFact:
    road = doc.get("road_ref") or {}
    c = doc["location"]["coord"]
    return public.ReportFact(
        id=doc["id"], kind=doc["kind"], severity=doc.get("severity"), coord=(float(c[0]), float(c[1])),
        party_key=doc["reporter"]["party_key"], role=doc["reporter"]["role"], observed_at=doc["observed_at"],
        received_at=doc["received_at"], status=doc["status"], segment_id=road.get("segment_id"),
        segment_name=road.get("name"), destination_id=doc.get("destination_id"), replay_at=doc.get("replay_at"))


def _proposed(index: DrillIndex, g: ZoneGuidance) -> dict[str, Any]:
    out = proposed_json(index, g)
    if out.get("route"):
        out["route"] = {k: v for k, v in out["route"].items() if k != "line"}
    out["alternatives"] = []
    return out


def _change_json(index: DrillIndex, c: Any) -> dict[str, Any]:
    b = c.before
    return {"zone_id": c.zone_id, "kind": c.kind,
            "from": None if b is None else {"level": b.level, "destination_id": b.destination_id, "via": list(b.via)},
            "to": _proposed(index, c.after)}


# =====================================================================================
# Strategies
# =====================================================================================


class Strategy(Protocol):
    """A response strategy. ``decide`` gets the ``get_situation`` digest (``crisistwin_mcp.digest``)
    and returns controller actions ``{"tool": <MCP write tool>, "args": {...}}`` applied in order.

    ``drill_system``: False only for the historical baseline (no planner, no proposals, no
    guidance). ``config()`` is hashed into ``strategy_version`` (docs/strategy-evaluation.md §7).
    Optional: ``bind(tools)`` gives an interactive strategy a ``ToolSurface`` (reads and writes
    applied immediately); its ``decide`` may then return []. Optional: ``agent_meta()`` adds
    non-identity facts (model, tokens) to the manifest's meta and metrics."""

    strategy_id: str
    drill_system: bool
    max_queue: int

    def config(self) -> dict[str, Any]: ...

    def decide(self, observation: dict[str, Any]) -> list[dict[str, Any]]: ...


class HistoricalOnly:
    """Baseline: only the bundle's historical actions (2018 orders, closures); no drill guidance."""

    strategy_id = "historical_only"
    drill_system = False
    max_queue = 0

    def config(self) -> dict[str, Any]:
        return {"id": self.strategy_id, "v": 1}

    def decide(self, observation: dict[str, Any]) -> list[dict[str, Any]]:
        return []


def _due(item_time: str | None, now: datetime, delay_min: float) -> bool:
    return item_time is not None and _t(item_time) + timedelta(minutes=delay_min) <= now


class RuleAuto:
    """Approve every pending proposal at once; confirm every unreviewed queue item backed by 2 or more
    independent parties (civilian parties + responder reports, as the digest counts them; 2018-record
    items have no party counts and are left alone); send the nearest responder to every open help
    request (straight-line distance to the responder's last location; any responder when none is known)."""

    strategy_id = "rule_auto"
    drill_system = True
    max_queue = 100_000
    MIN_PARTIES = 2

    def config(self) -> dict[str, Any]:
        return {"id": self.strategy_id, "v": 1, "min_parties": self.MIN_PARTIES}

    def decide(self, obs: dict[str, Any]) -> list[dict[str, Any]]:
        acts: list[dict[str, Any]] = []
        for p in obs["proposals"]["pending"]:
            acts.append({"tool": "approve_proposal", "args": {"proposal_id": p["id"]}})
        for item in obs["queue"]["items"]:
            if item["kind"] == "help_needed" or "help" in item["flags"]:
                continue
            if "confirmed" in item["flags"] or "record" in item["flags"]:
                continue
            parties = (item.get("civilian_parties") or 0) + (item.get("responder_reports") or 0)
            if parties >= self.MIN_PARTIES and item.get("report_ids"):
                acts.append({"tool": "triage_report", "args": {"report_id": item["report_ids"][0], "action": "confirm"}})
        responders = [(r["party_key"], r["coord"]) for r in obs.get("responders") or [] if r.get("coord")]
        for h in obs.get("help_requests") or []:
            if h.get("status", "open") not in ("open", "acknowledged") or not h.get("coord"):
                continue
            nearest = min(responders, key=lambda r: (haversine_m(tuple(r[1]), tuple(h["coord"])), r[0]))[0] \
                if responders else None
            acts.append({"tool": "handle_help", "args": {"checkin_id": h["checkin_id"], "action": "assign",
                                                         **({"assignee": nearest} if nearest else {})}})
        return acts


class RecordDelay:
    """As ``live_compare_record`` variant B: confirm each 2018-record queue item of kind road_blocked or
    fire_seen ``delay_min`` drill minutes after its (newest) record time, and approve every pending proposal."""

    drill_system = True
    max_queue = 100_000
    KINDS = ("road_blocked", "fire_seen")

    def __init__(self, delay_min: float) -> None:
        if delay_min < 0:
            raise ValueError("delay must be >= 0")
        self.delay_min = float(delay_min)
        self.strategy_id = f"record_delay_{delay_min:g}"

    def config(self) -> dict[str, Any]:
        return {"id": "record_delay", "v": 1, "delay_min": self.delay_min, "kinds": list(self.KINDS)}

    def decide(self, obs: dict[str, Any]) -> list[dict[str, Any]]:
        now = _t(obs["clock"]["replay_now"])
        acts = [{"tool": "approve_proposal", "args": {"proposal_id": p["id"]}} for p in obs["proposals"]["pending"]]
        for item in obs["queue"]["items"]:
            if (item["kind"] in self.KINDS and "record" in item["flags"] and "confirmed" not in item["flags"]
                    and item.get("report_ids") and _due(item.get("newest_replay_at"), now, self.delay_min)):
                acts.append({"tool": "triage_report", "args": {"report_id": item["report_ids"][0], "action": "confirm"}})
        return acts


class ToolSurface:
    """The MCP tool set of ``orchestrator_mcp`` served in-process for one run: read tools answer from
    the run's state (the same digests), write tools go through ``RunState.apply``. Results are the
    JSON strings the MCP server returns; errors are ``{"error", "detail"}``."""

    READ_TOOLS = ("get_situation", "get_zone", "get_report", "get_aar")
    WRITE_TOOLS = ("triage_report", "approve_proposal", "reject_proposal", "replan", "create_task", "handle_help")

    def __init__(self, runner: Run) -> None:
        self.runner = runner

    def call(self, tool: str, args: Mapping[str, Any] | None = None) -> tuple[bool, str]:
        args = dict(args or {})
        args.pop("incident_id", None)
        digest = _sim()[4]
        st = self.runner.state
        if tool == "get_situation":
            return True, _dump(digest, self.runner.observe(int(args.get("max_queue", 20))))
        if tool == "get_zone":
            detail = digest.zone_detail(st.command(), st.twin_monitor(), str(args.get("zone_id")),
                                        bool(args.get("include_geometry")))
            return (True, _dump(digest, detail)) if detail else (False, _dump(digest, {"error": "not_found"}))
        if tool == "get_report":
            detail = digest.report_detail(st.command(), str(args.get("report_id")))
            return (True, _dump(digest, detail)) if detail else (False, _dump(digest, {"error": "not_found"}))
        if tool == "get_aar":
            return False, _dump(digest, {"error": "aar_unavailable",
                                         "detail": "The score is computed after the run, never by the strategy."})
        if tool in self.WRITE_TOOLS:
            res = st.apply({"tool": tool, "args": args})
            return res["ok"], json.dumps(_jsonable(res), separators=(",", ":"), default=str)
        return False, json.dumps({"error": "unknown_tool", "detail": tool})


def _dump(digest, value: Any) -> str:
    return json.dumps(digest.prune(value), separators=(",", ":"), ensure_ascii=False, default=str)


class McpAgent:
    """Adapter stub for an orchestrator agent driving a run through the MCP tool surface (lockstep).

    Each decision tick is one **turn**. The adapter sends the agent
    ``{"type": "turn", "now": <drill ISO>, "situation": <get_situation JSON string>, "tools": [...]}``;
    the agent answers ``{"type": "call", "tool": <name>, "args": {...}}`` (the adapter replies
    ``{"type": "result", "ok": bool, "content": <tool JSON string>}``) any number of times, then
    ``{"type": "done"}`` (optionally with ``"usage": {"tokens_in", "tokens_out"}``). Tool names and
    arguments are those of ``orchestrator_mcp`` (README "Tools"). The drill clock is paused for the
    whole turn (lockstep).

    ``agent`` is either a Python callable ``agent(message: dict) -> dict`` (in-process; tests use a
    scripted one) or a command (list of strings) run as a subprocess speaking one JSON object per line
    on stdin/stdout. No network or LLM is touched by the runner itself."""

    drill_system = True
    max_queue = 20

    def __init__(self, agent: Callable[[dict[str, Any]], dict[str, Any]] | Sequence[str], name: str = "agent",
                 config: Mapping[str, Any] | None = None, max_calls: int = MAX_TOOL_CALLS_PER_TURN) -> None:
        self.name = name
        self.strategy_id = f"orchestrator:{name}"
        self._config = dict(config or {})
        self.max_calls = max_calls
        self._proc: subprocess.Popen | None = None
        if callable(agent):
            self._send = agent
        else:
            self._cmd = list(agent)
            self._send = self._subprocess_send
        self.tools: ToolSurface | None = None
        self.usage = {"tokens_in": 0, "tokens_out": 0, "turns": 0}

    def config(self) -> dict[str, Any]:
        return {"id": self.strategy_id, "max_calls_per_turn": self.max_calls, **self._config}

    def bind(self, tools: ToolSurface) -> None:
        self.tools = tools
        self.usage = {"tokens_in": 0, "tokens_out": 0, "turns": 0}

    def _subprocess_send(self, message: dict[str, Any]) -> dict[str, Any]:
        if self._proc is None:
            self._proc = subprocess.Popen(self._cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(message, default=str) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("agent process closed its output")
        return json.loads(line)

    def close(self) -> None:
        if self._proc is not None:
            self._proc.stdin.close()  # type: ignore[union-attr]
            self._proc.wait(timeout=10)
            self._proc = None

    def decide(self, obs: dict[str, Any]) -> list[dict[str, Any]]:
        if self.tools is None:
            raise RuntimeError("McpAgent needs bind(tools) before decide")
        digest = _sim()[4]
        reply = self._send({"type": "turn", "now": obs["clock"]["replay_now"], "situation": _dump(digest, obs),
                            "tools": list(ToolSurface.READ_TOOLS + ToolSurface.WRITE_TOOLS)})
        self.usage["turns"] += 1
        for _ in range(self.max_calls):
            if reply.get("type") != "call":
                break
            ok, content = self.tools.call(str(reply.get("tool")), reply.get("args"))
            reply = self._send({"type": "result", "ok": ok, "content": content})
        for k in ("tokens_in", "tokens_out"):
            self.usage[k] += int((reply.get("usage") or {}).get(k, 0))
        return []

    def agent_metrics(self) -> dict[str, float]:
        return {"agent.tokens_in": self.usage["tokens_in"], "agent.tokens_out": self.usage["tokens_out"],
                "agent.turns": self.usage["turns"]}


def make_strategy(name: str, **kw: Any) -> Strategy:
    """``historical_only``, ``rule_auto``, ``record_delay_<N>`` (N drill minutes), or ``mcp_agent``
    (needs ``agent=`` callable or command, optional ``agent_name=``)."""
    if name == "historical_only":
        return HistoricalOnly()
    if name == "rule_auto":
        return RuleAuto()
    m = re.fullmatch(r"record_delay_(\d+(?:\.\d+)?)", name)
    if m:
        return RecordDelay(float(m.group(1)))
    if name == "mcp_agent":
        if "agent" not in kw:
            raise ValueError("mcp_agent needs an agent (a callable or a command)")
        return McpAgent(kw["agent"], kw.get("agent_name", "agent"), kw.get("agent_config"))
    raise ValueError(f"unknown strategy {name!r}")


# =====================================================================================
# One run
# =====================================================================================


@dataclass
class RunResult:
    manifest: Any
    aar: dict[str, Any]
    wall_s: float
    stats: dict[str, int]


class Run:
    def __init__(self, world: ScenarioWorld, strategy: Strategy, seed: int, replicate: int = 0) -> None:
        twinmod, evaluation, _, gen_residents, _ = _sim()
        self.world, self.spec, self.strategy, self.seed, self.replicate = world, world.spec, strategy, seed, replicate
        self.evaluation = evaluation
        self.twin_seed = evaluation.derive_seed(seed, "twin") % (2**31 - 1)
        inputs = world.twin_inputs(self.twin_seed)
        twin = (twinmod.Twin.from_inputs(inputs, start_at=iso(self.spec.start), session_id=f"batch:{seed}")
                if inputs is not None else None)
        self.state = RunState(world, seed, twin, strategy.drill_system,
                              actor=strategy.strategy_id if strategy.drill_system else "none")
        self.residents = None
        if twin is not None and self.spec.residents.get("enabled"):
            overrides = {k: v for k, v in self.spec.residents.items() if k != "enabled"}
            params = gen_residents.ResidentParams(seed=evaluation.derive_seed(seed, "residents"), **overrides)
            self.residents = gen_residents.ResidentGenerator(twin, params, incident_id=self.state.incident_id)
            default = self.residents._default_offered
            self.residents.offered = lambda zone_id, at: self._offered(zone_id) or default(zone_id, at)
        self.fleet = None
        if self.spec.responders.get("enabled"):
            self.fleet = Fleet(world.index.drill, int(self.spec.responders.get("units", DEFAULT_RESPONDER_UNITS)),
                               seed=evaluation.derive_seed(seed, "responders"), incident_id=self.state.incident_id,
                               tempo=float(self.spec.responders.get("tempo", 1.0)))
        self.record_items = list(world.record.items) if world.record is not None else []
        self.record_points = world.record.points if world.record is not None else {}
        self.comms_items = world.comms_items(seed)
        self._ri = self._ci = 0
        self.decision_ticks = 0
        if hasattr(strategy, "bind"):
            strategy.bind(ToolSurface(self))

    def _offered(self, zone_id: str) -> list[str]:
        g = self.state.current.get(zone_id)
        if not g or g["level"] == "none" or g.get("no_route") or not g.get("destination"):
            return []
        return [g["destination"]["id"]]

    # -- generators

    def _zone_of(self, coord: Sequence[float]) -> str | None:
        p = (float(coord[0]), float(coord[1]))
        return next((z.id for z in self.world.index.drill.zones if point_in_multipolygon(p, z.geometry)), None)

    def ingest_record(self, t: datetime) -> None:
        st = self.state
        while self._ri < len(self.record_items) and self.record_items[self._ri][0] <= t:
            at, item = self.record_items[self._ri]
            self._ri += 1
            if at < self.spec.start:
                continue
            kind = REPORT_KIND.get(item["category"])
            point = self.record_points.get(item["id"])
            if kind is None or point is None:
                continue
            if item["channel"] == "911" and st.zone_blocked_by("psap_reroute", item.get("zone_id"), at):
                st.stats["dropped_psap"] += 1
                continue
            st.add_report(kind=kind, coord=point, at=at, role="responder" if item["channel"] == "radio" else "civilian",
                          party_key=RECORD_PARTY_KEY, source="record", evidence_class="historical_record",
                          severity="full" if kind == "road_blocked" else None, note=f"2018 record: {item['summary']}",
                          extra={"record": {"id": item["id"], "channel": item["channel"]}})

    def ingest_comms(self, t: datetime) -> None:
        st = self.state
        while self._ci < len(self.comms_items) and _t(self.comms_items[self._ci]["at"]) <= t:
            item = self.comms_items[self._ci]
            self._ci += 1
            kind = REPORT_KIND.get(item["category"])
            if kind is None or not item.get("coord"):
                continue
            at = _t(item["at"])
            if item["channel"] == "911" and st.zone_blocked_by("psap_reroute", self._zone_of(item["coord"]), at):
                st.stats["dropped_psap"] += 1
                continue
            st.add_report(kind=kind, coord=item["coord"], at=at,
                          role="responder" if item["channel"] == "radio" else "civilian",
                          party_key=f"sim_comms_{item['id']}", source="comms", evidence_class="simulated",
                          severity="full" if kind == "road_blocked" else None,
                          note=f"Simulated {item['channel']}: {item['summary']}", extra={"comms": {"id": item["id"]}})

    def ingest_residents(self) -> None:
        if self.residents is None:
            return
        st = self.state
        for ev in self.residents.observe():
            at = _t(ev["at"])
            body = ev["body"]
            if st.zone_blocked_by("comms_outage", ev.get("zone_id"), at):
                st.stats["dropped_outage"] += 1
                continue
            if ev["type"] == "report":
                st.add_report(kind=body["kind"], coord=body["location"]["coord"], at=at, role="civilian",
                              party_key=ev["party_key"], source="residents", evidence_class="simulated",
                              severity=body.get("severity"), note=body.get("note"),
                              destination_id=body.get("destination_id"))
            elif ev["type"] == "checkin":
                cid = st.checkin_of.get(ev["party_key"])
                prev = st.checkins.get(cid) if cid else None
                if prev is None:
                    cid = st._id("chk_")
                    st.checkin_of[ev["party_key"]] = cid
                doc = {"id": cid, "incident_id": st.incident_id, "party_key": ev["party_key"], "status": body["status"],
                       "zone_id": body.get("zone_id"), "coord": body.get("coord"), "at": at, "replay_at": at}
                prev_help = (prev or {}).get("help") or {}
                if body["status"] == "need_help" and (not prev_help or prev_help.get("status") == "resolved"):
                    doc["help"] = {"status": "open", "assignee": None, "task_id": None, "updated_at": at, "replay_at": at}
                elif body["status"] == "need_help":
                    doc["help"] = prev_help
                elif prev_help:
                    doc["help"] = {**prev_help, "status": "resolved", "updated_at": at, "replay_at": at}
                st.checkins[cid] = doc
            elif ev["type"] == "destination":
                key = (body["zone_id"], body["destination_id"])
                st.preferences[key] = st.preferences.get(key, 0) + 1

    def tick_responders(self, t: datetime) -> None:
        if self.fleet is None:
            return
        st = self.state
        tasks = [{"id": k, "kind": v["kind"], "status": v["status"], "assignee": v["assignee"], "target": v["target"]}
                 for k, v in st.tasks.items() if v["status"] in ("open", "accepted")]
        world = World(known_blocked=frozenset(st.twin_closed - st.silent_closed),
                      truth_blocked=frozenset(st.silent_closed), fire=st.fire().geometry)
        for call in self.fleet.tick(t, tasks, world):
            unit = call["unit"]
            pk = f"rsp_sim_{unit}"
            op, body = call["op"], call["body"]
            if op == "join":
                self.fleet.bind(unit, pk)
            elif op == "location":
                st.responders[pk] = {"coord": body["coord"], "at": t, "unit": unit}
            elif op == "accept":
                task = st.tasks.get(call["path"].split("/")[-1])
                if task is None or task["status"] != "open" or task["assignee"] not in (None, pk):
                    self.fleet.accept_failed(unit, call["path"].split("/")[-1])
                    continue
                task.update(status="accepted", assignee=pk, accepted_at=t, accepted_replay_at=t)
            elif op in ("done", "cancel"):
                task = st.tasks.get(call["path"].split("/")[-1])
                if task is None:
                    continue
                task.update(status="done" if op == "done" else "cancelled", closed_at=t, closed_replay_at=t)
                c = st.checkins.get(task.get("checkin_id") or "")
                if op == "done" and c and c.get("help") and c["help"].get("task_id") == task["id"]:
                    c["help"].update(status="resolved", updated_at=t, replay_at=t)
            elif op == "report":
                task = st.tasks.get(body.get("task_id") or "")
                st.add_report(kind=body["kind"], coord=body["location"]["coord"], at=t, role="responder",
                              party_key=pk, source="responders", evidence_class="simulated",
                              severity=body.get("severity"), note=body.get("note"), task_id=body.get("task_id"))
                if task is not None:
                    task.update(status="done", closed_at=t, closed_replay_at=t)

    # -- observation

    def observe(self, max_queue: int | None = None) -> dict[str, Any]:
        digest = _sim()[4]
        st = self.state
        mq = self.strategy.max_queue if max_queue is None else max_queue
        return digest.situation_digest(st.command(), st.twin_monitor(), None if st.twin else "unavailable", mq, None)

    # -- the loop

    def run(self) -> RunResult:
        t0 = time.perf_counter()
        st, spec = self.state, self.spec
        step = timedelta(seconds=spec.tick_s)
        every = timedelta(minutes=spec.decision_every_min)
        next_decision = spec.start
        t = spec.start
        while t <= spec.end:
            st.now = t
            if st.twin is not None:
                st.twin.step_to(iso(t))
            st.apply_injects()
            self.ingest_record(t)
            self.ingest_comms(t)
            self.ingest_residents()
            self.tick_responders(t)
            st.sync_twin()
            st.maybe_auto_replan()
            if t >= next_decision and t < spec.end:
                self.decision_ticks += 1
                if self.strategy.drill_system:
                    st.begin_turn()
                    for action in self.strategy.decide(self.observe()):
                        st.apply(action)
                    st.end_turn()
                next_decision = t + every
            t += step
        st.now = spec.end  # the clock stops at the horizon; the twin is at the horizon too
        wall_s = time.perf_counter() - t0
        if hasattr(self.strategy, "close"):
            self.strategy.close()
        return self._score(wall_s)

    def _score(self, wall_s: float) -> RunResult:
        st, spec, ev = self.state, self.spec, self.evaluation
        ctx = aar.AarContext(incident_id=st.incident_id, index=self.world.index, now=spec.end,
                             replay_start=spec.start, replay_now=spec.end, started_at=spec.start, speed=0.0,
                             running=False, drill_at=lambda wall: wall)
        report = aar.compute_aar(ctx, st.aar_data(), time_basis="drill")
        metrics = metrics_from_aar(report)
        metrics.update({f"run.{k}": float(v) for k, v in sorted(st.stats.items())})
        if hasattr(self.strategy, "agent_metrics"):
            metrics.update(self.strategy.agent_metrics())
        mon = st.twin_monitor()
        invariants = []
        if mon is not None:
            tot = mon["totals"]
            if not mon["conserved"]:
                invariants.append("vehicle conservation")
            if any((tot.get(k) or 0) < 0 for k in ("not_departed_veh", "en_route_veh", "arrived_veh")):
                invariants.append("non-negative counts")
        twin_hash = st.twin.action_log_hash() if st.twin is not None else None
        actions_hash = ev.hash_json({"decisions": _jsonable(st.decisions), "actions": st.action_log, "twin": twin_hash})
        manifest = ev.RunManifest(
            scenario_id=spec.scenario_id, package_hash=self.world.package_hash,
            strategy_id=self.strategy.strategy_id, strategy_version=ev.hash_json(self.strategy.config()),
            seed=self.seed, generator_params_hash=ev.hash_json(spec.generator_params()),
            actions_log_hash=actions_hash, metrics=metrics, replicate=self.replicate,
            meta={"clock_mode": spec.clock.get("mode", "lockstep"), "tick_s": spec.tick_s,
                  "decision_every_min": spec.decision_every_min, "horizon": iso(spec.end), "start": iso(spec.start),
                  "twin_seed": self.twin_seed, "twin_inputs_fingerprint": getattr(st.twin, "inputs", None)
                  and st.twin.inputs.fingerprint, "evaluator_version": EVALUATOR_VERSION,
                  "planner_version": PLANNER_VERSION, "aar_time_basis": "drill", "run.wall_s": round(wall_s, 2),
                  "decision_ticks": self.decision_ticks, "invariant_failures": invariants,
                  "strategy_config": self.strategy.config(), "label": LABEL},
        )
        return RunResult(manifest, report, wall_s, dict(st.stats))


AAR_KEYS = ("arrived_share", "exposed_trapped", "help_to_assign", "leave_now_vs_2018")


def metrics_from_aar(report: Mapping[str, Any]) -> dict[str, float | None]:
    """Manifest keys of docs/strategy-evaluation.md §3: ``aar.<component>.raw`` and ``.score``, plus
    ``aar.arrived_share`` (the share), ``aar.total`` and ``aar.coverage``."""
    out: dict[str, float | None] = {}
    comps = {c["id"]: c for c in report["score"]["components"]}
    for k in AAR_KEYS:
        out[f"aar.{k}.raw"] = comps[k]["raw"]
        out[f"aar.{k}.score"] = comps[k]["score"]
    out["aar.arrived_share"] = comps["arrived_share"]["raw"]
    out["aar.total"] = report["score"]["value"]
    out["aar.coverage"] = report["score"]["coverage"]
    out["help.requests"] = float(report["help"]["requests"])
    out["help.to_resolve_median_min"] = report["help"]["to_resolve_median_min"]
    out["triage.median_min"] = report["triage"]["median_min"]
    out["leave_now.zones_missed"] = float(comps["leave_now_vs_2018"]["zones_missed"])
    return out


def run_one(world: ScenarioWorld, strategy: Strategy, seed: int, replicate: int = 0) -> RunResult:
    return Run(world, strategy, seed, replicate).run()


# =====================================================================================
# Batch and comparison
# =====================================================================================


_FORK_STATE: dict[str, Any] = {}


def _run_block(seed: int) -> list[RunResult]:
    world, strategies = _FORK_STATE["world"], _FORK_STATE["strategies"]
    return [run_one(world, s, seed) for s in strategies]


def run_batch(world: ScenarioWorld, strategies: Sequence[Strategy], seeds: Sequence[int], *,
              manifest_path: str | Path | None = None, workers: int = 1,
              progress: Callable[[str], None] = lambda s: None) -> list[RunResult]:
    """Every strategy on every seed (seed-major, so a block's twin inputs and comms are built once).
    Appends one manifest line per run to ``manifest_path`` (JSONL), in seed then strategy order.

    ``workers > 1`` runs blocks in forked processes (POSIX ``fork``: the world is shared copy-on-write).
    Runs are independent and deterministic, so the manifests are identical to ``workers=1`` apart
    from ``meta["run.wall_s"]``. Interactive strategies (``mcp_agent``) need ``workers=1``."""
    results: list[RunResult] = []
    fh = open(manifest_path, "a", encoding="utf-8") if manifest_path else None
    if workers <= 1:
        return _collect((run_one(world, s, seed) for seed in seeds for s in strategies), results, fh, progress)
    import multiprocessing

    _FORK_STATE.update(world=world, strategies=list(strategies))
    with multiprocessing.get_context("fork").Pool(workers) as pool:
        blocks = pool.imap(_run_block, list(seeds))
        return _collect((res for block in blocks for res in block), results, fh, progress)


def _collect(it, results: list[RunResult], fh, progress: Callable[[str], None]) -> list[RunResult]:
    try:
        for res in it:
            results.append(res)
            if fh:
                fh.write(res.manifest.to_json() + "\n")
                fh.flush()
            m = res.manifest.metrics
            progress(f"seed {res.manifest.seed} {res.manifest.strategy_id}: {res.wall_s:.1f} s, arrived "
                     f"{m.get('aar.arrived_share')}, exposed {m.get('aar.exposed_trapped.raw')}, help "
                     f"{m.get('aar.help_to_assign.raw')}, leave-now {m.get('aar.leave_now_vs_2018.score')}")
    finally:
        if fh:
            fh.close()
    return results


def metric_specs(evaluation) -> list[Any]:
    MS = evaluation.MetricSpec
    return [
        MS("aar.arrived_share", True, "primary", "share"),
        MS("aar.exposed_trapped.raw", False, "primary", "veh-min/veh"),
        MS("aar.help_to_assign.raw", False, "primary", "drill min"),
        MS("aar.leave_now_vs_2018.score", True, "primary", "0-1"),
        MS("aar.total", True, "secondary", "0-100"),
        MS("help.to_resolve_median_min", False, "secondary", "drill min"),
        MS("run.confirms", True, "secondary", "count"),
    ]


def compare_runs(manifests: Sequence[Any], baseline: str | None = None, *, n_boot: int = 10_000,
                 title: str = "Strategy comparison") -> tuple[str, dict[str, Any]]:
    """``compare_strategies`` over the manifests: (markdown, JSON). ``baseline`` is a strategy id (the
    first ``historical_only`` run's strategy by default); every other strategy is a treatment. Runs
    with invariant failures are excluded and listed."""
    _, evaluation, _, _, _ = _sim()
    excluded = [m for m in manifests if (m.meta or {}).get("invariant_failures")]
    runs = [m for m in manifests if m not in excluded]
    strategies = sorted({m.strategy for m in runs})
    base = next((s for s in strategies if s.split("@")[0] == (baseline or "historical_only")), None)
    if base is None:
        raise ValueError(f"no runs of baseline {baseline or 'historical_only'}")
    treatments = [s for s in strategies if s != base]
    comps = evaluation.compare_strategies(runs, base, treatments, metric_specs(evaluation), n_boot=n_boot)
    issues = evaluation.design_issues(runs)
    table = evaluation.results_table_markdown(comps)
    walls = [float(m.meta.get("run.wall_s", 0)) for m in runs]
    md = [f"# {title}", "", f"> {LABEL}", "",
          f"Scenarios: {', '.join(sorted({m.scenario_id + ' (' + m.package_hash + ')' for m in runs}))}. "
          f"Seeds: {len({m.seed for m in runs})}. Runs: {len(runs)} (excluded for invariant failures: {len(excluded)}). "
          f"Clock: {sorted({m.meta.get('clock_mode') for m in runs})}, decision every "
          f"{sorted({m.meta.get('decision_every_min') for m in runs})} drill min, horizon "
          f"{sorted({m.meta.get('horizon') for m in runs})}. Help minutes on the drill clock.",
          "", f"Wall time per run: mean {sum(walls) / len(walls):.1f} s, max {max(walls):.1f} s." if walls else "",
          "", "Design issues: " + ("; ".join(issues) if issues else "none"), "", table, "",
          "## Means per strategy", "", "| Strategy | n | " + " | ".join(s.name for s in metric_specs(evaluation)) + " |",
          "|---|---|" + "---|" * len(metric_specs(evaluation))]
    for s in strategies:
        rs = [m for m in runs if m.strategy == s]
        cells = []
        for spec in metric_specs(evaluation):
            vals = [m.metrics.get(spec.name) for m in rs if m.metrics.get(spec.name) is not None]
            cells.append(f"{sum(vals) / len(vals):.3f} (n={len(vals)})" if vals else "–")
        md.append(f"| {s} | {len(rs)} | " + " | ".join(cells) + " |")
    js = evaluation.results_table_json(comps, runs=runs, settings={"n_boot": n_boot, "baseline": base,
                                                                   "excluded_runs": [m.run_id for m in excluded]})
    return "\n".join(md) + "\n", js


def read_manifests(path: str | Path) -> list[Any]:
    _, evaluation, _, _, _ = _sim()
    return [evaluation.RunManifest.from_dict(json.loads(line))
            for line in Path(path).read_text().splitlines() if line.strip()]
