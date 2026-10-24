"""Autonomous disaster stress test (agent simulation mode, scope section 9 / 4D).

A Claude agent proposes disruptions to the Camp Fire baseline (close a road or its
bridges, cut road capacity, close an exit, shift the wind, slow the residents'
response, remove contraflow), runs each through the same `sim.variants` path as the
baseline, reads the computed deltas and writes a findings report. The LLM never
computes metrics: every number comes from a tool result, specs are validated against
an allowlist and bounds before execution, and runs are capped by a run budget and a
wall-time cap. `--dry-run` runs a fixed disruption list without the LLM.

Output (agent simulation area only, never the replay bundle):
  app/public/simulations/camp-2018.stress.json, kind "crisistwin_stress_test":
  generated_by {sim_version, command, model, models_served}, mode (agent | dry_run),
  basis and baseline.metrics (as sim.variants), budget, runs[] {run_id, spec, changes,
  result (compare() deltas with pct, zone risk changes, exit shifts), evidence_class
  "simulated"}, rejected[] (specs that failed validation), ranking (server-side),
  findings {evidence_class "ai_explanation", markdown citing [run-NN], checks}, limitations.

Run from the repository root (ANTHROPIC_API_KEY must be set for the agent mode):
  python3 -m sim.stress_agent --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 \
    --roads-package data/incidents/camp-2018-evacuation/b1b318c16bbd3270 [--max-runs 12] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from dataclasses import replace
from pathlib import Path

from tools.build_camp_history import SourceError

from sim import SIM_VERSION
from sim.bundle import _simulated_fire
from sim.fire import FireParams
from sim.history import format_utc, load_history, parse_utc
from sim.traffic import CONTRAFLOW_END_EVENT_TYPES, CONTRAFLOW_START_EVENT_TYPES, TrafficEvent, TrafficParams
from sim.variants import (
    COMMON_LIMITATIONS, Context, RunInputs, _with_events, baseline_inputs, basis, check_population, compare,
    fixed_fire, headline_metrics, run,
)

KIND = "crisistwin_stress_test"
SCHEMA_VERSION = "1.0.0"
MODEL = "claude-opus-5-5"
EFFORT = "high"
MAX_TOKENS = 16000
DEFAULT_OUTPUT = Path("app/public/simulations/camp-2018.stress.json")

DEFAULT_MAX_RUNS = 12
MAX_RUNS_LIMIT = 20  # scope: limit the search to 10-20 candidate failures
DEFAULT_MAX_WALL_S = 1800
MAX_DISRUPTIONS_PER_RUN = 3
WIND_SHIFT_LIMIT_DEG = 60
RESPONSE_FACTOR_RANGE = (0.5, 4.0)
CAPACITY_FACTOR_RANGE = (0.05, 0.9)  # use close_road for zero capacity
MAJOR_HIGHWAYS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
                  "secondary", "secondary_link", "tertiary", "tertiary_link"}
CANDIDATE_ROADS = 30
CANDIDATE_EXITS = 15
ZONE_CHANGES_SHOWN = 12
EXIT_SHIFTS_SHOWN = 6
RANK_METRICS = ("exposed_veh_min", "peak_exposed_veh", "arrived_by_1800z_veh", "arrived_at_end_veh",
                "peak_blocked_veh", "blocked_at_end_veh", "peak_en_route_veh")
# Metrics where a lower variant value is worse (fewer vehicles out); for the rest higher is worse.
LOWER_IS_WORSE = {"arrived_by_1700z_veh", "arrived_by_1800z_veh", "arrived_by_2000z_veh", "arrived_at_end_veh"}

DISRUPTION_TYPES = ("close_road", "reduce_road_capacity", "close_destination", "shift_wind", "slow_response",
                    "remove_contraflow")
FIELDS = ("road_name", "bridges_only", "bbox", "at", "until", "capacity_factor", "destination_id",
          "wind_shift_deg", "response_delay_factor")
USES = {
    "close_road": {"road_name", "bridges_only", "bbox", "at", "until"},
    "reduce_road_capacity": {"road_name", "bridges_only", "bbox", "at", "capacity_factor"},
    "close_destination": {"destination_id", "at"},
    "shift_wind": {"wind_shift_deg"},
    "slow_response": {"response_delay_factor"},
    "remove_contraflow": set(),
}
SINGLETON_TYPES = {"shift_wind", "slow_response", "remove_contraflow"}

STRESS_LIMITATIONS = [
    "Disruptions are proposed by an AI agent and validated against allowlists and bounds; every metric is computed "
    "by the simulator, and the narrative is an AI explanation of those results.",
    "Exits are boundary crossings of the road extract with unlimited capacity; close_destination marks an exit full "
    "(closed) from the given time, it does not model shelter capacity.",
    "Vehicles already on an edge when it closes stop there until it reopens (engine limitation: no turning back).",
]

SYSTEM_PROMPT = """You are a red-team analyst for CrisisTwin, an evacuation planning simulator. Your job is to find \
the disruptions that most damage the simulated Camp Fire (2018) evacuation baseline, and the fragile points they \
reveal.

Tools:
- list_candidate_disruptions: major roads, bridges, exits used in the baseline, contraflow, wind and clock bounds.
- get_baseline_metrics: the baseline headline metrics.
- run_disruption: runs one disruption spec (1-3 disruptions combined) through the simulator and returns deltas \
against the baseline. Each call costs one run from a fixed budget.
- rank_runs: ranks completed runs by a metric, computed by the server.

Method: start with the candidates and the baseline. Test single disruptions on the most used roads, bridges and \
exits first, then combine the most damaging ones to look for compound failures, and include at least one \
non-road stressor (wind, response time or contraflow). Use the budget deliberately; when it runs out, write the \
report.

Rules:
- Never compute, estimate or round metrics yourself, and do not derive new ratios or sums. Quote numbers exactly \
as tool results give them (including the server's pct values), and cite the run that produced each claim as \
[run-NN]. Cite [baseline] for baseline values.
- Results are simulated planning experiments on fixture demand with one seed; small differences are not \
significant. Do not present findings as operational instructions or real-world safety claims.

Final report: markdown with sections "Most damaging disruptions", "Fragile points", "Affected zones", \
"Low-impact disruptions" and "Limitations". Every bullet that states a finding cites at least one run ID."""


def _null(kind: str) -> dict:
    return {"anyOf": [{"type": kind}, {"type": "null"}]}


DISRUPTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type", *FIELDS],
    "properties": {
        "type": {"type": "string", "enum": list(DISRUPTION_TYPES)},
        "road_name": {**_null("string"), "description": "close_road / reduce_road_capacity: exact road name from "
                      "list_candidate_disruptions (any named road in the network is accepted)."},
        "bridges_only": {**_null("boolean"), "description": "Only the road's bridge edges (null = false)."},
        "bbox": {"anyOf": [{"type": "array", "items": {"type": "number"}}, {"type": "null"}],
                 "description": "Optional [west, south, east, north] lon/lat; restricts to edges whose midpoint is "
                 "inside. Must lie within the scenario bbox."},
        "at": {**_null("string"), "description": "UTC ISO time, e.g. 2018-11-08T16:00:00Z, inside the clock window "
               "(null = clock start). Not used by shift_wind, slow_response, remove_contraflow."},
        "until": {**_null("string"), "description": "close_road only: reopening time after `at` (null = never)."},
        "capacity_factor": {**_null("number"), "description": "reduce_road_capacity: multiplier 0.05-0.9."},
        "destination_id": {**_null("string"), "description": "close_destination: exit id from candidates."},
        "wind_shift_deg": {**_null("integer"), "description": "shift_wind: degrees added to wind_from, -60..60, "
                           "non-zero."},
        "response_delay_factor": {**_null("number"), "description": "slow_response: multiplier on the median "
                                  "order-to-departure delay, 0.5-4."},
    },
}

TOOLS = [
    {
        "name": "list_candidate_disruptions",
        "description": "List what can be disrupted, all derived from the road network and baseline run: major "
                       "named roads (edge counts, bridge edges, baseline peak vehicles on the road), exits that "
                       "received baseline traffic, contraflow events, wind range, response-delay range and the "
                       "clock window.",
        "strict": True,
        "input_schema": {"type": "object", "additionalProperties": False, "properties": {}, "required": []},
    },
    {
        "name": "get_baseline_metrics",
        "description": "Baseline headline metrics (simulated) that every run is compared against.",
        "strict": True,
        "input_schema": {"type": "object", "additionalProperties": False, "properties": {}, "required": []},
    },
    {
        "name": "run_disruption",
        "description": "Validate and run one stress scenario (1-3 disruptions applied together) through the "
                       "simulator. Returns its run_id, the applied changes and deltas against the baseline. "
                       "Consumes one run of the budget; invalid specs return an error and consume nothing. Set "
                       "every field not used by a disruption type to null.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["label", "rationale", "disruptions"],
            "properties": {
                "label": {"type": "string", "description": "Short name for this scenario."},
                "rationale": {"type": "string", "description": "Why this could be damaging (one sentence)."},
                "disruptions": {"type": "array", "items": DISRUPTION_SCHEMA,
                                "description": f"1-{MAX_DISRUPTIONS_PER_RUN} disruptions."},
            },
        },
    },
    {
        "name": "rank_runs",
        "description": "Rank completed runs from worst to least bad by one metric's delta against the baseline.",
        "strict": True,
        "input_schema": {
            "type": "object", "additionalProperties": False, "required": ["metric"],
            "properties": {"metric": {"type": "string", "enum": list(RANK_METRICS)}},
        },
    },
]


class SpecError(ValueError):
    """A proposed spec failed validation; returned to the agent, nothing runs."""


class Budget:
    def __init__(self, max_runs: int, max_wall_s: float) -> None:
        self.max_runs, self.max_wall_s = max_runs, max_wall_s
        self.started = time.monotonic()

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def wall_left(self) -> bool:
        return self.elapsed() < self.max_wall_s


class StressLab:
    """Baseline, fire calibration and network catalog loaded once; runs validated specs."""

    def __init__(self, package: Path, roads_package: Path, command: str, budget: Budget) -> None:
        self.command, self.budget = command, budget
        history = load_history(package)
        scenario, start, end = baseline_inputs(roads_package)
        self.ctx = Context(history, start, end)
        self.base = RunInputs(scenario, TrafficParams(), _simulated_fire(history, end))
        self.base_basis = basis(self.base, self.ctx)
        self.baseline = run(self.base, self.ctx, command)
        check_population(self.baseline)
        self.base_metrics = headline_metrics(self.baseline)
        self.network = scenario["network"]
        self.dest_ids = {d.id: d for d in scenario["destinations"]}
        self.scenario_bbox = scenario["bbox"]
        self.by_name: dict[str, list] = defaultdict(list)
        for e in self.network.edges:
            if not e.name.startswith("unnamed "):
                self.by_name[e.name].append(e)
        self.fires = {0: self.base.fire}
        self.runs: list[dict] = []
        self.rejected: list[dict] = []
        self._by_key: dict[str, dict] = {}
        self._catalog = self._build_catalog()

    # --- catalog

    def _build_catalog(self) -> dict:
        index = {e.id: i for i, e in enumerate(self.network.edges)}
        road_of = {}
        for name, edges in self.by_name.items():
            for e in edges:
                road_of[index[e.id]] = name
        peak: dict[str, int] = defaultdict(int)
        for frame in self.baseline["traffic"]["frames"]:
            per: dict[str, int] = defaultdict(int)
            for i, occ, _speed in frame["edges"]:
                if i in road_of:
                    per[road_of[i]] += occ
            for name, n in per.items():
                peak[name] = max(peak[name], n)
        roads = []
        for name, edges in self.by_name.items():
            if not any(e.highway in MAJOR_HIGHWAYS for e in edges):
                continue
            roads.append({
                "road_name": name, "edges": len(edges), "bridge_edges": sum(1 for e in edges if e.bridge),
                "length_km": round(sum(e.length_m for e in edges) / 1000, 1),
                "highways": sorted({e.highway for e in edges}), "baseline_peak_veh_on_road": peak.get(name, 0),
            })
        roads.sort(key=lambda r: (-r["baseline_peak_veh_on_road"], r["road_name"]))
        bridges = sorted(({"road_name": r["road_name"], "bridge_edges": r["bridge_edges"],
                           "baseline_peak_veh_on_road": r["baseline_peak_veh_on_road"]}
                          for r in roads if r["bridge_edges"]), key=lambda r: -r["baseline_peak_veh_on_road"])
        arrived = self.baseline["traffic"]["summary"]["arrived_by_destination_veh"]
        exits = sorted(({"destination_id": d, "name": self.dest_ids[d].name, "baseline_arrived_veh": n}
                        for d, n in arrived.items() if n > 0), key=lambda x: -x["baseline_arrived_veh"])
        contraflow = [{"event_id": ev.id, "at": format_utc(ev.at), "edges": len(ev.edge_ids), "label": ev.label}
                      for ev in self.base.scenario["events"] if ev.type in CONTRAFLOW_START_EVENT_TYPES]
        wind = self.base.fire[0]["model"]["params"]["wind_from_deg"]
        return {
            "evidence_class": "simulated",
            "clock": {"start": format_utc(self.ctx.start), "end": format_utc(self.ctx.end),
                      "first_order_at": self.baseline["traffic"]["summary"]["first_order_at"]},
            "scenario_bbox": self.scenario_bbox,
            "roads": roads[:CANDIDATE_ROADS],
            "roads_note": f"Top {CANDIDATE_ROADS} of {len(roads)} major named roads by baseline peak vehicles on "
                          "the road; any named road in the network is accepted.",
            "bridges": bridges,
            "exits": exits[:CANDIDATE_EXITS],
            "exits_note": f"{len(exits)} of {len(self.dest_ids)} exits received baseline traffic; top "
                          f"{CANDIDATE_EXITS} shown.",
            "contraflow": contraflow,
            "wind": {"baseline_wind_from_deg": wind, "shift_range_deg": [-WIND_SHIFT_LIMIT_DEG, WIND_SHIFT_LIMIT_DEG],
                     "note": "Shifts the simulated fire front before the first satellite perimeter only."},
            "response": {"baseline_median_delay_min": self.base.params.response_delay_median_min,
                         "factor_range": list(RESPONSE_FACTOR_RANGE)},
            "capacity_factor_range": list(CAPACITY_FACTOR_RANGE),
            "budget": self.budget_status(),
        }

    def budget_status(self) -> dict:
        return {"runs_used": len(self.runs), "max_runs": self.budget.max_runs,
                "wall_s_used": round(self.budget.elapsed()), "max_wall_s": self.budget.max_wall_s}

    def exhausted(self) -> bool:
        return len(self.runs) >= self.budget.max_runs or not self.budget.wall_left()

    # --- validation

    def _time(self, value, field: str):
        if value is None:
            return None
        if not isinstance(value, str):
            raise SpecError(f"{field} must be a UTC ISO time string or null")
        try:
            at = parse_utc(value)
        except ValueError as exc:
            raise SpecError(f"{field}: {exc}") from exc
        if not self.ctx.start <= at < self.ctx.end:
            raise SpecError(f"{field} {value} is outside the clock window {format_utc(self.ctx.start)} to "
                            f"{format_utc(self.ctx.end)}")
        return at

    def _edges(self, d: dict) -> list:
        name = d["road_name"]
        if not isinstance(name, str) or name not in self.by_name:
            raise SpecError(f"road_name {name!r} is not a named road in the network; use list_candidate_disruptions")
        edges = self.by_name[name]
        if d["bridges_only"]:
            edges = [e for e in edges if e.bridge]
        bbox = d["bbox"]
        if bbox is not None:
            w0, s0, e0, n0 = self.scenario_bbox
            if (not isinstance(bbox, list) or len(bbox) != 4
                    or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in bbox)):
                raise SpecError("bbox must be [west, south, east, north] numbers or null")
            w, s, e, n = bbox
            if not (w < e and s < n and w0 <= w and e <= e0 and s0 <= s and n <= n0):
                raise SpecError(f"bbox must be ordered west<east, south<north and lie within {self.scenario_bbox}")

            def inside(x) -> bool:
                (x0, y0), (x1, y1) = self.network.nodes[x.from_node], self.network.nodes[x.to_node]
                return w <= (x0 + x1) / 2 <= e and s <= (y0 + y1) / 2 <= n
            edges = [x for x in edges if inside(x)]
        if not edges:
            raise SpecError(f"no edges of {name!r} match bridges_only={bool(d['bridges_only'])} and bbox={bbox}")
        return edges

    def normalize(self, spec: dict) -> dict:
        """Check a raw tool input against the allowlist and bounds; return the canonical spec."""
        if not isinstance(spec, dict) or not isinstance(spec.get("disruptions"), list):
            raise SpecError("spec must be an object with a disruptions list")
        items = spec["disruptions"]
        if not 1 <= len(items) <= MAX_DISRUPTIONS_PER_RUN:
            raise SpecError(f"give 1-{MAX_DISRUPTIONS_PER_RUN} disruptions")
        out = []
        for k, d in enumerate(items):
            if not isinstance(d, dict) or d.get("type") not in DISRUPTION_TYPES:
                raise SpecError(f"disruption {k}: type must be one of {list(DISRUPTION_TYPES)}")
            d = {f: d.get(f) for f in FIELDS} | {"type": d["type"]}
            kind = d["type"]
            unused = [f for f in FIELDS if f not in USES[kind] and d[f] is not None]
            if unused:
                raise SpecError(f"disruption {k} ({kind}): set {unused} to null; they are not used by this type")
            norm = {"type": kind}
            if kind in ("close_road", "reduce_road_capacity"):
                edges = self._edges(d)
                norm |= {"road_name": d["road_name"], "bridges_only": bool(d["bridges_only"]), "bbox": d["bbox"],
                         "edge_ids": sorted(e.id for e in edges)}
            if "at" in USES[kind]:
                norm["at"] = format_utc(self._time(d["at"], "at") or self.ctx.start)
            if kind == "close_road":
                until = self._time(d["until"], "until")
                if until is not None and until <= parse_utc(norm["at"]):
                    raise SpecError(f"disruption {k}: until must be after at")
                norm["until"] = format_utc(until) if until else None
            elif kind == "reduce_road_capacity":
                f = d["capacity_factor"]
                lo, hi = CAPACITY_FACTOR_RANGE
                if not isinstance(f, (int, float)) or not lo <= f <= hi:
                    raise SpecError(f"disruption {k}: capacity_factor must be within {lo}-{hi}")
                norm["capacity_factor"] = float(f)
            elif kind == "close_destination":
                if d["destination_id"] not in self.dest_ids:
                    raise SpecError(f"disruption {k}: unknown destination_id {d['destination_id']!r}")
                norm["destination_id"] = d["destination_id"]
            elif kind == "shift_wind":
                s = d["wind_shift_deg"]
                if not isinstance(s, int) or isinstance(s, bool) or s == 0 or abs(s) > WIND_SHIFT_LIMIT_DEG:
                    raise SpecError(f"disruption {k}: wind_shift_deg must be a non-zero integer within "
                                    f"±{WIND_SHIFT_LIMIT_DEG}")
                norm["wind_shift_deg"] = s
            elif kind == "slow_response":
                f = d["response_delay_factor"]
                lo, hi = RESPONSE_FACTOR_RANGE
                if not isinstance(f, (int, float)) or not lo <= f <= hi or f == 1:
                    raise SpecError(f"disruption {k}: response_delay_factor must be within {lo}-{hi} and not 1")
                norm["response_delay_factor"] = float(f)
            elif kind == "remove_contraflow":
                if not any(ev.type in CONTRAFLOW_START_EVENT_TYPES for ev in self.base.scenario["events"]):
                    raise SpecError("the baseline has no contraflow to remove")
            out.append(norm)
        kinds = [d["type"] for d in out]
        dup = sorted({t for t in kinds if t in SINGLETON_TYPES and kinds.count(t) > 1})
        if dup:
            raise SpecError(f"at most one disruption of type {dup} per run")
        return {"label": str(spec.get("label", ""))[:120], "rationale": str(spec.get("rationale", ""))[:400],
                "disruptions": out}

    # --- execution

    def _fire(self, shift: int) -> tuple:
        if shift not in self.fires:
            p = self.base.fire[0]["model"]["params"]
            params = FireParams(p["base_spread_m_per_min"], (p["wind_from_deg"] + shift) % 360, p["wind_speed_m_s"],
                                p["wind_coef_per_m_s"])
            self.fires[shift] = fixed_fire(self.ctx.history, params, self.ctx.end)
        return self.fires[shift]

    def _apply(self, spec: dict, run_id: str) -> tuple[RunInputs, list[str]]:
        inputs, changes = self.base, []
        events = list(self.base.scenario["events"])
        base_closed = {x for ev in events if ev.type in ("road_closed", "road_blocked") for x in ev.edge_ids}
        for k, d in enumerate(spec["disruptions"]):
            eid = f"stress-{run_id}-{k + 1}"
            kind = d["type"]
            where = d.get("road_name", "") + (" bridges" if d.get("bridges_only") else "") + (
                f" within bbox {d['bbox']}" if d.get("bbox") else "")
            common = {"evidence_class": "simulated", "time_precision": "minute", "source_id": "stress_agent"}
            if kind == "close_road":
                at = parse_utc(d["at"])
                events.append(TrafficEvent(id=f"{eid}-closed", at=at, type="road_closed",
                                           label=f"Stress test: {where} closed", edge_ids=tuple(d["edge_ids"]),
                                           **common))
                text = f"Closed {where} ({len(d['edge_ids'])} directed edges) at {d['at']}"
                if d["until"]:
                    # A reopening would also lift baseline closures on the same edges; keep those closed.
                    reopen = tuple(x for x in d["edge_ids"] if x not in base_closed)
                    if reopen:
                        events.append(TrafficEvent(id=f"{eid}-reopened", at=parse_utc(d["until"]),
                                                   type="road_reopened", label=f"Stress test: {where} reopened",
                                                   edge_ids=reopen, **common))
                    text += f", reopened at {d['until']}"
                    if len(reopen) < len(d["edge_ids"]):
                        text += f" ({len(d['edge_ids']) - len(reopen)} edges stay closed by baseline events)"
                changes.append(text + ("." if d["until"] else ", never reopened."))
            elif kind == "reduce_road_capacity":
                events.append(TrafficEvent(id=f"{eid}-capacity", at=parse_utc(d["at"]), type="capacity_changed",
                                           label=f"Stress test: {where} capacity x{d['capacity_factor']:g}",
                                           edge_ids=tuple(d["edge_ids"]), capacity_factor=d["capacity_factor"],
                                           **common))
                changes.append(f"Capacity of {where} ({len(d['edge_ids'])} directed edges) x{d['capacity_factor']:g} "
                               f"from {d['at']}; overrides earlier capacity events on those edges.")
            elif kind == "close_destination":
                events.append(TrafficEvent(id=f"{eid}-full", at=parse_utc(d["at"]), type="shelter_full",
                                           label=f"Stress test: {self.dest_ids[d['destination_id']].name} closed",
                                           destination_id=d["destination_id"], **common))
                changes.append(f"{self.dest_ids[d['destination_id']].name} ({d['destination_id']}) closed to "
                               f"arrivals from {d['at']}.")
            elif kind == "remove_contraflow":
                types = CONTRAFLOW_START_EVENT_TYPES + CONTRAFLOW_END_EVENT_TYPES
                removed = [ev.id for ev in events if ev.type in types]
                events = [ev for ev in events if ev.type not in types]
                changes.append(f"Removed {len(removed)} contraflow events ({', '.join(removed)}).")
            elif kind == "slow_response":
                old = inputs.params.response_delay_median_min
                inputs = replace(inputs, params=replace(inputs.params,
                                                        response_delay_median_min=old * d["response_delay_factor"]))
                changes.append(f"Median order-to-departure delay {old:g} -> "
                               f"{inputs.params.response_delay_median_min:g} min (same seed, sigma and cap). "
                               "Vehicles still waiting at an origin are not counted as exposed (engine limitation), "
                               "so later departures can lower exposed_veh while raising blocked_veh.")
            elif kind == "shift_wind":
                fire = self._fire(d["wind_shift_deg"])
                old = self.base.fire[0]["model"]["params"]["wind_from_deg"]
                inputs = replace(inputs, fire=fire)
                changes.append(f"Simulated front wind_from_deg {old:g} -> {(old + d['wind_shift_deg']) % 360:g}; "
                               f"fit to first perimeter IoU {fire[0]['calibration']['iou']} (baseline "
                               f"{self.base.fire[0]['calibration']['iou']}).")
        return _with_events(inputs, events), changes

    def run_spec(self, raw: dict) -> dict:
        try:
            spec = self.normalize(raw)
        except SpecError as exc:
            self.rejected.append({"spec": raw, "error": str(exc)})
            raise
        key = json.dumps(spec["disruptions"], sort_keys=True)
        if key in self._by_key:
            return {**self._result_view(self._by_key[key]), "note": "identical spec already ran; no budget used"}
        if self.exhausted():
            raise SpecError(f"budget exhausted ({self.budget_status()}); write the final report now")
        run_id = f"run-{len(self.runs) + 1:02d}"
        clock = time.perf_counter()
        inputs, changes = self._apply(spec, run_id)
        if basis(inputs, self.ctx) != self.base_basis:
            raise AssertionError(f"{run_id}: seed, clock, network, demand or models differ from baseline")
        changed_params = sorted(k for k, v in inputs.params.to_dict().items() if self.base.params.to_dict()[k] != v)
        if changed_params not in ([], ["response_delay_median_min"]):
            raise AssertionError(f"{run_id}: undeclared traffic param changes {changed_params}")
        bundle = run(inputs, self.ctx, self.command)
        check_population(bundle)
        record = {"run_id": run_id, "evidence_class": "simulated", "spec": spec, "requested_spec": raw,
                  "changes": changes, "result": self._summarize(bundle),
                  "runtime_s": round(time.perf_counter() - clock, 1)}
        self.runs.append(record)
        self._by_key[key] = record
        return self._result_view(record)

    def _summarize(self, bundle: dict) -> dict:
        cmp = compare(self.baseline, bundle)
        metrics = {}
        for k, m in cmp["metrics"].items():
            pct = (round(100 * m["delta"] / m["baseline"], 1) if m["delta"] is not None and m["baseline"]
                   else None)
            metrics[k] = {**m, "pct": pct}
        base_arr = self.baseline["traffic"]["summary"]["arrived_by_destination_veh"]
        var_arr = bundle["traffic"]["summary"]["arrived_by_destination_veh"]
        shifts = sorted(({"destination_id": d, "name": self.dest_ids[d].name, "baseline": base_arr.get(d, 0),
                          "variant": var_arr.get(d, 0), "delta": var_arr.get(d, 0) - base_arr.get(d, 0)}
                         for d in set(base_arr) | set(var_arr) if var_arr.get(d, 0) != base_arr.get(d, 0)),
                        key=lambda x: (-abs(x["delta"]), x["destination_id"]))
        return {
            "evidence_class": "simulated",
            "metrics": metrics,
            "clearance_note": cmp["clearance_note"],
            "zone_risk_counts": cmp["zone_risk_counts"],
            "zone_risk_changed_count": len(cmp["zone_risk_changed"]),
            "zone_risk_changed": cmp["zone_risk_changed"],
            "exit_shifts": shifts[:EXIT_SHIFTS_SHOWN],
        }

    def _result_view(self, record: dict) -> dict:
        r = record["result"]
        return {"run_id": record["run_id"], "evidence_class": "simulated", "label": record["spec"]["label"],
                "changes": record["changes"], "metrics": r["metrics"], "clearance_note": r["clearance_note"],
                "zone_risk_counts": r["zone_risk_counts"], "zone_risk_changed_count": r["zone_risk_changed_count"],
                "zone_risk_changed": r["zone_risk_changed"][:ZONE_CHANGES_SHOWN], "exit_shifts": r["exit_shifts"],
                "budget": self.budget_status()}

    def rank(self, metric: str) -> dict:
        if metric not in RANK_METRICS:
            raise SpecError(f"metric must be one of {list(RANK_METRICS)}")
        sign = -1 if metric in LOWER_IS_WORSE else 1
        rows = [{"run_id": r["run_id"], "label": r["spec"]["label"], **r["result"]["metrics"][metric]}
                for r in self.runs]
        rows.sort(key=lambda x: (-(sign * x["delta"]) if x["delta"] is not None else math.inf, x["run_id"]))
        return {"evidence_class": "simulated", "metric": metric,
                "worse_direction": "lower" if sign < 0 else "higher", "runs": rows}

    def call(self, name: str, args: dict) -> dict:
        if name == "list_candidate_disruptions":
            return {**self._catalog, "budget": self.budget_status()}
        if name == "get_baseline_metrics":
            return {"evidence_class": "simulated", "metrics": self.base_metrics,
                    "zone_risk_counts": compare(self.baseline, self.baseline)["zone_risk_counts"]["baseline"]}
        if name == "run_disruption":
            return self.run_spec(args)
        if name == "rank_runs":
            return self.rank(args.get("metric"))
        raise SpecError(f"unknown tool {name!r}")


# --- findings checks


def _numbers_in(value, out: set[float]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        out.update({float(value), abs(float(value))})
    elif isinstance(value, str):
        for m in re.findall(r"-?\d[\d,]*\.?\d*", value):
            try:
                out.add(abs(float(m.replace(",", ""))))
            except ValueError:
                pass
    elif isinstance(value, dict):
        for v in value.values():
            _numbers_in(v, out)
    elif isinstance(value, list):
        for v in value:
            _numbers_in(v, out)


def check_findings(markdown: str, lab: StressLab) -> dict:
    """Cited run IDs exist, and every number in the narrative appears in some tool result."""
    run_ids = {r["run_id"] for r in lab.runs}
    cited = sorted(set(re.findall(r"run-\d{2}", markdown)))
    known: set[float] = set()
    _numbers_in([lab.base_metrics, lab._catalog, [r["result"] for r in lab.runs],
                 [r["spec"] for r in lab.runs], [r["changes"] for r in lab.runs]], known)
    text = re.sub(r"run-\d{2}|\d{4}-\d{2}-\d{2}T[\d:]+Z?|\b\d{1,2}:\d{2}(Z| ?PST| ?UTC)?", " ", markdown)
    unverified = []
    for m in re.findall(r"(?<![\w.])-?\d[\d,]*\.?\d*", text):
        value = abs(float(m.replace(",", "").rstrip(".")))
        if value not in known and m not in unverified:
            unverified.append(m)
    bullets = [ln for ln in markdown.splitlines() if ln.lstrip().startswith(("-", "*")) and ln.strip(" -*")]
    return {
        "cited_run_ids": cited,
        "unknown_run_ids": [r for r in cited if r not in run_ids],
        "uncited_runs": sorted(run_ids - set(cited)),
        "bullets_without_citation": sum(1 for ln in bullets if not re.search(r"run-\d{2}|baseline", ln)),
        "unverified_numbers": unverified,
        "rule": "unverified_numbers lists figures in the narrative that do not appear in any tool result",
    }


# --- agent loop


def run_agent(lab: StressLab, client, model: str) -> dict:
    """Manual tool-use loop; returns the findings block and stop reason."""
    import anthropic

    messages: list[dict] = [{"role": "user", "content": (
        f"Stress-test the Camp Fire evacuation baseline. Budget: {lab.budget.max_runs} runs and "
        f"{lab.budget.max_wall_s} s of wall time. Start with list_candidate_disruptions and get_baseline_metrics, "
        "then search for the most damaging and fragile points and finish with the report.")}]
    served: list[str] = []
    max_turns = lab.budget.max_runs * 3 + 8
    wrap_up = False
    for _turn in range(max_turns):
        try:
            response = client.beta.messages.create(
                model=model, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT, tools=TOOLS, messages=messages,
                thinking={"type": "adaptive"}, output_config={"effort": EFFORT},
                tool_choice={"type": "none"} if wrap_up else {"type": "auto"},
                cache_control={"type": "ephemeral"},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            )
        except anthropic.AuthenticationError:
            return {"markdown": None, "stopped": "authentication failed (check ANTHROPIC_API_KEY)", "served": served}
        except anthropic.RateLimitError:
            return {"markdown": None, "stopped": "rate limited after SDK retries", "served": served}
        except anthropic.APIStatusError as exc:
            return {"markdown": None, "stopped": f"API error {exc.status_code}", "served": served}
        except anthropic.APIConnectionError:
            return {"markdown": None, "stopped": "API connection error", "served": served}
        if response.model not in served:
            served.append(response.model)
        print(f"turn {_turn + 1}: {response.stop_reason}, runs {len(lab.runs)}/{lab.budget.max_runs}", flush=True)
        if response.stop_reason == "refusal":
            return {"markdown": None, "stopped": "refusal", "served": served}
        content = list(response.content)
        # After a mid-output fallback, drop model-internal blocks before the last switch point.
        last_fb = max((i for i, b in enumerate(content) if b.type == "fallback"), default=-1)
        if last_fb >= 0:
            content = [b for i, b in enumerate(content)
                       if i > last_fb or b.type not in ("thinking", "redacted_thinking", "tool_use")]
        messages.append({"role": "assistant", "content": content})
        calls = [b for b in content if b.type == "tool_use"]
        if response.stop_reason == "max_tokens":
            return {"markdown": None, "stopped": "max_tokens reached", "served": served}
        if not calls:
            text = "\n".join(b.text for b in content if b.type == "text").strip()
            return {"markdown": text or None, "stopped": "end_turn" if text else "empty final message",
                    "served": served}
        results = []
        for block in calls:
            try:
                payload = lab.call(block.name, block.input if isinstance(block.input, dict) else {})
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(payload)})
            except SpecError as exc:
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": f"error: {exc}",
                                "is_error": True})
        if lab.exhausted() and not wrap_up:
            wrap_up = True
            results.append({"type": "text", "text": f"Budget reached ({lab.budget_status()}). Write the final "
                            "report now from the results above; no more tool calls."})
        messages.append({"role": "user", "content": results})
    return {"markdown": None, "stopped": f"turn cap {max_turns} reached", "served": served}


# --- dry run

DRY_RUN_SPECS = (
    {"label": "Skyway Road closed at 08:00 PST", "rationale": "Main Paradise-Chico corridor.",
     "disruptions": [{"type": "close_road", "road_name": "Skyway Road", "at": "2018-11-08T16:00:00Z"}]},
    {"label": "Slower response x2", "rationale": "Residents leave later after orders.",
     "disruptions": [{"type": "slow_response", "response_delay_factor": 2.0}]},
    {"label": "Wind 30 deg more northerly", "rationale": "Front moves toward a different part of town.",
     "disruptions": [{"type": "shift_wind", "wind_shift_deg": -30}]},
    {"label": "No contraflow", "rationale": "Contraflow added outbound capacity.",
     "disruptions": [{"type": "remove_contraflow"}]},
    {"label": "Clark Road capacity halved from 07:30 PST", "rationale": "Second ridge corridor degraded.",
     "disruptions": [{"type": "reduce_road_capacity", "road_name": "Clark Road", "at": "2018-11-08T15:30:00Z",
                      "capacity_factor": 0.5}]},
)


def run_dry(lab: StressLab) -> None:
    for spec in DRY_RUN_SPECS[:lab.budget.max_runs]:
        full = {**spec, "disruptions": [{f: None for f in FIELDS} | d for d in spec["disruptions"]]}
        result = lab.run_spec(full)
        m = result["metrics"]
        print(f"{result['run_id']} {spec['label']}: exposed_veh_min delta {m['exposed_veh_min']['delta']}, "
              f"arrived_by_1800z delta {m['arrived_by_1800z_veh']['delta']}", flush=True)


# --- output


def document(lab: StressLab, mode: str, model: str | None, findings: dict | None, stopped: str) -> dict:
    return {
        "kind": KIND,
        "schema_version": SCHEMA_VERSION,
        "mode": mode,
        "generated_by": {"sim_version": SIM_VERSION, "command": lab.command, "model": model,
                         "models_served": findings.get("served", []) if findings else []},
        "evidence_class": {"metrics": "simulated", "findings": "ai_explanation"},
        "basis": lab.base_basis,
        "baseline": {"evidence_class": "simulated", "metrics": lab.base_metrics},
        "budget": {**lab.budget_status(), "stopped": stopped},
        "runs": lab.runs,
        "rejected": lab.rejected,
        "ranking": {m: lab.rank(m)["runs"] for m in ("exposed_veh_min", "arrived_by_1800z_veh", "peak_blocked_veh")},
        "findings": None if findings is None else {
            "evidence_class": "ai_explanation", "model": model, "markdown": findings["markdown"],
            "checks": check_findings(findings["markdown"], lab) if findings["markdown"] else None,
        },
        "limitations": [*COMMON_LIMITATIONS, *STRESS_LIMITATIONS],
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="python3 -m sim.stress_agent", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", type=Path, required=True, help="verified incident package directory")
    parser.add_argument("--roads-package", type=Path, required=True, help="verified road package")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-runs", type=int, default=DEFAULT_MAX_RUNS, help=f"1-{MAX_RUNS_LIMIT}")
    parser.add_argument("--max-wall-s", type=int, default=DEFAULT_MAX_WALL_S)
    parser.add_argument("--dry-run", action="store_true", help="fixed disruption list, no LLM")
    args = parser.parse_args()
    if not 1 <= args.max_runs <= MAX_RUNS_LIMIT or args.max_wall_s <= 0:
        parser.error(f"--max-runs must be 1-{MAX_RUNS_LIMIT} and --max-wall-s positive")
    if "simulations" not in args.output.parts:
        parser.error("--output must be in the agent simulation area (app/public/simulations/), not the replay bundle")
    client = None
    if not args.dry_run:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            parser.exit(2, "error: ANTHROPIC_API_KEY is not set; set it or use --dry-run\n")
        try:
            import anthropic
        except ImportError:
            parser.exit(2, "error: the anthropic package is not installed; run "
                           "`python3 -m pip install 'anthropic>=1.17,<2'` (see app/backend/requirements.in)\n")
        client = anthropic.Anthropic()
    command = " ".join(["python3 -m sim.stress_agent", *sys.argv[1:]])

    try:
        clock = time.perf_counter()
        lab = StressLab(args.package, args.roads_package, command, Budget(args.max_runs, args.max_wall_s))
        print(f"baseline: {time.perf_counter() - clock:.1f} s", flush=True)
        if args.dry_run:
            run_dry(lab)
            doc = document(lab, "dry_run", None, None, "dry run complete")
        else:
            findings = run_agent(lab, client, MODEL)
            doc = document(lab, "agent", MODEL, findings, findings["stopped"])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(doc, sort_keys=True, indent=1, allow_nan=False) + "\n"
        args.output.write_text(text)
    except (OSError, SourceError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(f"{args.output}: {len(lab.runs)} runs, {len(lab.rejected)} rejected, {len(text.encode())} bytes, "
          f"stopped: {doc['budget']['stopped']}")


if __name__ == "__main__":
    main()
