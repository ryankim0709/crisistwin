"""A fake CrisisTwin controller backend for the tool tests: synthetic fixture data, no network.

Shapes follow docs/live-reports.md. Every value here is made up for tests (synthetic fixture),
not drill output; ids imitate the real formats so the digests treat them the same way.
"""

from __future__ import annotations

import copy
import json
import urllib.parse
from typing import Any

INCIDENT = "camp-2018-drill"
LINE = [[-121.601, 39.760], [-121.605, 39.755], [-121.610, 39.750]]
POLYGON = {"type": "MultiPolygon", "coordinates": [[[[-121.62, 39.75], [-121.59, 39.75], [-121.59, 39.77],
                                                     [-121.62, 39.75]]]]}
SEG = "osm-way:100:0"


def _guidance(zone_id: str, level: str, dest: str, via: list[str], eta: int, version: int) -> dict[str, Any]:
    return {
        "zone_id": zone_id, "level": level,
        "destination": {"id": dest, "name": f"Exit {dest[-1]}", "kind": "exit", "coord": [-121.7, 39.7]},
        "route": {"line": LINE, "via": via, "distance_m": 12000, "eta_min": eta, "safety": "clear"},
        "no_route": False, "reason": "Fire estimate within 3 km", "reason_code": "fire_within_evacuate_km",
        "version": version, "published_at": "2026-10-24T18:00:00Z", "replay_at": "2018-11-08T16:30:00Z",
        "approved_by": "controller", "proposal_id": "prp_old", "caveat": None,
        "alternatives": [
            {"destination": {"id": dest, "name": f"Exit {dest[-1]}", "kind": "exit", "coord": [-121.7, 39.7]},
             "route": {"line": LINE, "via": via, "distance_m": 12000, "eta_min": eta, "safety": "clear"},
             "safety": "clear", "load": 0.42, "recommended": True},
        ],
    }


def _report(rid: str, kind: str, party: str, role: str = "civilian", status: str = "unverified",
            observed: str = "2026-10-24T18:04:00Z", segment: str | None = SEG, **extra: Any) -> dict[str, Any]:
    doc = {
        "id": rid, "client_id": rid, "incident_id": INCIDENT, "reporter": {"role": role, "party_key": party},
        "kind": kind, "severity": "full" if kind == "road_blocked" else None,
        "location": {"coord": [-121.6012, 39.7593], "accuracy_m": 12},
        "road_ref": {"segment_id": segment, "name": "Pentz Road", "snap_m": 8} if segment else None,
        "destination_id": None, "task_id": None, "observed_at": observed, "received_at": observed,
        "note": None, "status": status, "evidence_class": "field_report", "replay_at": "2018-11-08T16:34:00Z",
    }
    doc.update(extra)
    return doc


def command_fixture() -> dict[str, Any]:
    zones = [
        {"id": "bg:060070018001", "name": "Block Group 1, Census Tract 18", "households": 410, "vehicles": 702,
         "geometry": POLYGON},
        {"id": "bg:060070018002", "name": "Block Group 2, Census Tract 18", "households": 300, "vehicles": 515,
         "geometry": POLYGON},
        {"id": "bg:060070009011", "name": "Block Group 1, Census Tract 9.01", "households": 1010, "vehicles": 1729,
         "geometry": POLYGON},
    ]
    proposal = {
        "id": "prp_pending1", "incident_id": INCIDENT, "created_at": "2026-10-24T18:05:00Z",
        "replay_at": "2018-11-08T16:35:00Z", "status": "pending", "policy": "needs_controller",
        "causes": ["fire"], "cause_segment_ids": [],
        "inputs": {"fire_as_of": "2018-11-08T16:30:00Z", "fire_method": "model_nowcast"},
        "controller": {"id": "twin", "version": "twin-controller-v1", "fallback": None},
        "twin": {"evidence_class": "simulated", "horizon_min": 60, "fire_ahead": "frozen",
                 "objective": {"formula": "1*total_exposed_veh_min + ..."},
                 "baseline": {"label": "No new actions", "cost": 84949.0, "metrics": {}},
                 "candidates": [{"label": "Planner routes", "valid": True, "cost": 82444.0,
                                 "metrics": {"arrived_in_window_veh": 900, "total_exposed_veh_min": 5000.0}}],
                 "chosen": 0},
        "changes": [
            {"zone_id": "bg:060070018002", "kind": "level_change",
             "from": {"level": "be_ready", "destination_id": "exit:2", "via": ["Skyway"]},
             "to": {"level": "evacuate_now", "destination": {"id": "exit:2", "name": "Exit 2", "kind": "exit",
                                                              "coord": [-121.7, 39.7]},
                    "route": {"line": LINE, "via": ["Skyway"], "distance_m": 15000, "eta_min": 21},
                    "no_route": False, "reason": "Fire estimate within 3 km", "reason_code": "fire_within_evacuate_km"}},
            {"zone_id": "bg:060070009011", "kind": "new", "from": None,
             "to": {"level": "be_ready", "destination": {"id": "exit:3", "name": "Exit 3", "kind": "exit",
                                                          "coord": [-121.8, 39.7]},
                    "route": {"line": LINE, "via": ["Clark Road"], "distance_m": 9000, "eta_min": 14},
                    "no_route": False, "reason": "Fire estimate within 8 km", "reason_code": "fire_within_ready_km"}},
        ],
        "tasks": [{"target": {"segment_id": SEG, "coord": [-121.6012, 39.7593]},
                   "reason": "One unverified road_blocked report on Pentz Road", "report_ids": ["rpt_a"],
                   "assignee": None}],
        "rationale": {"text": "Fixture rationale.", "generated_by": "template", "evidence_class": "template"},
        "decided_at": None, "decided_by": None, "note": None, "parent_id": None,
    }
    return {
        "incident_id": INCIDENT, "generated_at": "2026-10-24T18:06:00Z",
        "incident": {"id": INCIDENT, "name": "Camp Fire 2018 exercise", "mode": "exercise"},
        "drill": {"incident_id": INCIDENT, "label": "Drill: 2018 Camp Fire replay. Not a real incident.",
                  "replay_now": "2018-11-08T16:36:00Z", "replay_start": "2018-11-08T16:30:00Z",
                  "started_at": "2026-10-24T18:00:00Z", "speed": 1, "running": True,
                  "clock": {"start": "2018-11-08T14:00:00Z", "end": "2018-11-09T08:00:00Z"}},
        "fire": {"as_of": "2018-11-08T16:30:00Z", "method": "model_nowcast",
                 "label": "Model estimate, 16:30 drill time", "geometry": POLYGON,
                 "observations": [{"coord": [-121.43, 39.81], "at": "2018-11-08T16:20:00Z",
                                   "source": "nist_reconstructed"}], "evidence_class": "simulated"},
        "zones_version": "zones-fixture", "zones": zones,
        "destinations": [{"id": "exit:1", "name": "Exit 1", "kind": "exit", "coord": [-121.7, 39.7], "capacity_veh": None}],
        "guidance": [_guidance("bg:060070018001", "evacuate_now", "exit:1", ["Pentz Road", "Highway 99"], 24, 2),
                     _guidance("bg:060070018002", "be_ready", "exit:2", ["Skyway"], 19, 1)],
        "proposals": [proposal, {**copy.deepcopy(proposal), "id": "prp_done", "status": "approved",
                                 "decided_by": "controller", "decided_at": "2026-10-24T18:00:00Z"}],
        "reports": [
            _report("rpt_a", "road_blocked", "dev_1"),
            _report("rpt_b", "road_blocked", "dev_2", observed="2026-10-24T18:03:00Z"),
            _report("rpt_c", "road_passable", "dev_3", observed="2026-10-24T18:05:00Z"),
            _report("rpt_rec", "help_needed", "record_nist_2018", role="responder", segment=None,
                    evidence_class="historical_record", note="2018 record: Radio: help needed"),
            _report("rpt_gone", "fire_seen", "dev_4", status="dismissed", segment=None),
        ],
        "road_state": [{"segment_id": SEG, "name": "Pentz Road", "status": "blocked", "confidence": 0.82,
                        "independent_parties": 2, "responder_reports": 0, "last_observed_at": "2026-10-24T18:05:00Z",
                        "report_ids": ["rpt_a", "rpt_b"], "decided_by": None, "public": False}],
        "public_items": [],
        "checkins": {"by_zone": [{"zone_id": "bg:060070018001", "out": 12, "need_help": 1, "staying": 3}],
                     "need_help": [{"id": "chk_1", "zone_id": "bg:060070018001", "coord": [-121.598, 39.757],
                                    "at": "2026-10-24T18:02:00Z",
                                    "help": {"status": "open", "assignee": None, "task_id": None,
                                             "updated_at": "2026-10-24T18:02:00Z"}}]},
        "destination_preferences": [{"zone_id": "bg:060070018001", "destination_id": "exit:1", "count": 4}],
        "responders": [{"party_key": "rsp_1", "coord": [-121.6, 39.76], "accuracy_m": 15, "at": "2026-10-24T18:05:30Z"}],
        "tasks": [{"id": "tsk_1", "incident_id": INCIDENT, "assignee": None, "kind": "verify", "checkin_id": None,
                   "target": {"segment_id": SEG, "coord": [-121.6012, 39.7593]}, "report_ids": ["rpt_a"],
                   "note": None, "created_at": "2026-10-24T18:04:30Z", "status": "open"}],
        "decisions": [{"at": "2026-10-24T18:04:30Z", "actor": "controller", "action": "task_create",
                       "report_ids": ["rpt_a"], "proposal_id": None, "checkin_id": None, "note": None}],
        "response_record": [],
        "ground_record": {"available": True, "label": "2018 record, de-identified from NIST TN 2252. Not drill reports.",
                          "window_min": 30, "until": "2018-11-08T16:36:00Z",
                          "totals": {"911": 12, "radio": 40}, "window": {"911": 4, "radio": 9},
                          "zones": [{"zone_id": "bg:060070018001", "items": 6, "help": 2, "fire": 1}], "items": []},
    }


def twin_fixture() -> dict[str, Any]:
    return {
        "kind": "crisistwin_live_twin", "evidence_class": "simulated",
        "clock": {"now": "2018-11-08T16:36:00Z"}, "conserved": True,
        "totals": {"total_veh": 31638, "arrived_veh": 6564, "exposed_veh": 5947, "trapped_by_fire_veh": 235},
        "zones": [{"id": "bg:060070018001", "vehicles": 702, "ordered_at": "2018-11-08T16:31:00Z",
                   "not_departed_veh": 100, "en_route_veh": 500, "arrived_veh": 102, "blocked_veh": 0, "exposed_veh": 40}],
        "traffic": [{"line": LINE, "veh": 265}], "command_errors": [],
    }


EVENTS = [
    {"key": "1000:report:rpt_c", "at": "2026-10-24T18:05:00Z", "replay_at": "2018-11-08T16:35:00Z", "type": "report",
     "id": "rpt_c", "change": "new", "kind": "road_passable", "status": "unverified", "segment_id": SEG},
    {"key": "2000:proposal:prp_pending1", "at": "2026-10-24T18:05:00Z", "replay_at": "2018-11-08T16:35:00Z",
     "type": "proposal", "id": "prp_pending1", "change": "created", "status": "pending", "n_changes": 2},
    {"key": "3000:decision:dec_1", "at": "2026-10-24T18:05:30Z", "replay_at": None, "type": "decision",
     "id": "dec_1", "actor": "controller", "action": "dismiss", "report_ids": ["rpt_gone"]},
]


class FakeBackend:
    """A transport (see ``client.Transport``) that answers like the backend and records requests."""

    def __init__(self) -> None:
        self.command = command_fixture()
        self.twin: dict[str, Any] | None = twin_fixture()
        self.requests: list[dict[str, Any]] = []
        self.events_pages: list[dict[str, Any]] = []
        self.aar_status = 404

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None,
                 timeout: float) -> tuple[int, bytes]:
        parsed = urllib.parse.urlsplit(url)
        path = parsed.path.removeprefix("/api/live/")
        query = dict(urllib.parse.parse_qsl(parsed.query))
        data = json.loads(body) if body else None
        self.requests.append({"method": method, "path": path, "query": query, "headers": dict(headers), "body": data})
        status, payload = self.route(method, path, query, data)
        return status, json.dumps(payload).encode()

    def writes(self) -> list[dict[str, Any]]:
        return [r for r in self.requests if r["method"] == "POST"]

    def route(self, method: str, path: str, query: dict[str, str], data: Any) -> tuple[int, Any]:
        inc = f"incidents/{INCIDENT}/"
        if method == "GET" and path == "active":
            return 200, {"incident_id": INCIDENT, "name": "Camp Fire 2018 exercise", "mode": "drill"}
        if method == "GET" and path == inc + "command":
            return 200, self.command
        if method == "GET" and path == inc + "twin":
            return (200, self.twin) if self.twin else (503, {"error": "twin_warming", "detail": "Building the twin."})
        if method == "GET" and path == inc + "events":
            if query.get("since") == "now":
                return 200, {"events": [], "next_cursor": "500:", "more": False}
            if self.events_pages:
                return 200, self.events_pages.pop(0)
            return 200, {"events": [], "next_cursor": query.get("since", "0:"), "more": False}
        if method == "GET" and path == inc + "aar":
            return self.aar_status, {"error": "not_found"} if self.aar_status == 404 else {}
        if method == "GET" and path == "tasks/tsk_1/route":
            return 200, {"task_id": "tsk_1", "route": {"line": LINE, "via": ["Neal Road"], "distance_m": 27330,
                                                       "eta_min": 21, "exposure": "clear", "congestion": "twin",
                                                       "congested_edges": 0},
                         "reason": None, "detail": None, "evidence_class": "simulated", "as_of": "2018-11-08T16:36:00Z"}
        if method == "GET" and path == "tasks/tsk_2/route":
            return 409, {"task_id": "tsk_2", "route": None, "reason": "no_origin",
                         "detail": "No responder location and no `from`.", "evidence_class": "simulated"}
        if method == "POST" and path == "reports/rpt_a/triage":
            report = {**self.command["reports"][0], "status": data["action"] + "ed"}
            proposal = self.command["proposals"][0]
            return 200, {"report": report, "replan": {"proposal": proposal, "auto_approved": None}}
        if method == "POST" and path.startswith("reports/"):
            return 404, {"error": "not_found", "detail": "Unknown report."}
        if method == "POST" and path == inc + "tasks":
            return 201, {"task": {"id": "tsk_new", "kind": data.get("kind"), "status": "open",
                                  "assignee": data.get("assignee"), "target": data["target"],
                                  "report_ids": data.get("report_ids", []), "note": data.get("note")}}
        if method == "POST" and path == "checkins/chk_1/help":
            return 200, {"checkin": {"id": "chk_1", "status": "need_help", "help": {"status": "acknowledged"}}}
        if method == "POST" and path == inc + "replan":
            return 201, {"proposal": self.command["proposals"][0], "auto_approved": None}
        if method == "POST" and path == "proposals/prp_pending1/approve":
            g = _guidance("bg:060070018002", "evacuate_now", "exit:2", ["Skyway"], 21, 2)
            return 200, {"proposal": {**self.command["proposals"][0], "status": "approved"}, "guidance": [g], "tasks": []}
        if method == "POST" and path == "proposals/prp_pending1/reject":
            return 200, {"proposal": {**self.command["proposals"][0], "status": "rejected", "note": (data or {}).get("note")}}
        if method == "POST" and path == inc + "drill":
            return 200, {"drill": {**self.command["drill"], "speed": data.get("speed", 1)}}
        if method == "POST" and path == inc + "impact":
            return 200, {"replay_at": "2018-11-08T16:36:00Z",
                         "target": {"segment_id": SEG, "name": "Pentz Road", "line": LINE, "coord": LINE[1],
                                    "state": "open", "report_ids": ["rpt_a"]},
                         "planner_version": "planner-v3",
                         "summary": {"affected_zones": 1, "eta_delta_min": 7, "zones_losing_route": 0,
                                     "zones_exposed": 0, "vehicles_at_risk": 600, "vehicles_at_risk_source": "twin"},
                         "zones": [{"zone_id": "bg:060070018001", "level": "evacuate_now", "change": "rerouted",
                                    "eta_delta_min": 7, "vehicles": 702, "vehicles_remaining": 600,
                                    "unblocked": {"destination": {"id": "exit:1"}, "route": {"line": LINE, "via": ["Pentz Road"], "eta_min": 24}, "exposed": False},
                                    "blocked": {"destination": {"id": "exit:1"}, "route": {"line": LINE, "via": ["Skyway"], "eta_min": 31}, "exposed": False}}],
                         "twin": {"evidence_class": "simulated", "horizon_min": 60, "seed": 7,
                                  "delta": {"total_exposed_veh_min": 1200.0}, "limitations": ["Single seed."]},
                         "twin_fallback": None, "runtime_ms": 3100}
        if method == "POST" and path == inc + "twin/whatif":
            return 200, {"evidence_class": "simulated", "from": "2018-11-08T16:36:00Z", "until": "2018-11-08T17:36:00Z",
                         "horizon_min": 60, "fire_ahead": "frozen", "seed": 7, "objective": {"formula": "f"},
                         "results": [{"set_index": 0, "label": "no new actions", "valid": True, "errors": [],
                                      "actions": [], "metrics": {"remaining_at_horizon_veh": 9622}, "objective": 71122.0},
                                     {"set_index": 1, "label": "Skyway contraflow", "valid": True, "errors": [],
                                      "actions": [{"id": "w1-1", "type": "contraflow", "label": "Command (simulated): start contraflow on Skyway",
                                                   "resolved": {"edge_indexes": [1, 2, 3]}}],
                                      "metrics": {"remaining_at_horizon_veh": 9000}, "objective": 64010.0,
                                      "delta_vs_baseline": {"objective": -7112.0}}],
                         "ranking": [1, 0], "limitations": ["Single seed; small differences are not significant."]}
        return 404, {"error": "not_found", "detail": f"No fake route for {method} {path}."}
