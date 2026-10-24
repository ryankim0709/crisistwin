"""The MCP tools against a fake backend, over an in-memory MCP session (no network).

Run from orchestrator_mcp/: ``.venv/bin/python -m unittest discover -s tests -t .``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import unittest
from typing import Any

from crisistwin_mcp.client import ACTOR_HEADER, CrisisTwinClient
from crisistwin_mcp.config import Config, ConfigError
from crisistwin_mcp.server import build_server
from mcp.shared.memory import create_connected_server_and_client_session

from tests.fake_backend import FakeBackend

logging.getLogger("mcp").setLevel(logging.WARNING)

TOKEN = "test-token-not-a-secret"
READ_TOOLS = {"get_situation", "get_events", "get_zone", "get_report", "get_task_route", "run_impact",
              "twin_whatif", "get_aar"}
WRITE_TOOLS = {"triage_report", "create_task", "handle_help", "replan", "approve_proposal", "reject_proposal"}


def run(coro):
    return asyncio.run(coro)


class ToolTest(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.config = Config(api_base="http://backend.test", token=TOKEN, agent_name="test-agent")

    def server(self, **overrides: Any):
        config = Config(**{**self.config.__dict__, **overrides})
        return build_server(config, CrisisTwinClient(config, transport=self.backend))

    async def _call(self, server, name: str, args: dict[str, Any]):
        async with create_connected_server_and_client_session(server) as session:
            return await session.call_tool(name, args)

    def call(self, name: str, args: dict[str, Any] | None = None, server=None, expect_error: bool = False):
        result = run(self._call(server or self.server(), name, args or {}))
        self.assertEqual(result.isError, expect_error, result.content)
        text = result.content[0].text
        return json.loads(text) if text.startswith(("{", "[")) else text

    def calls(self, steps: list[tuple[str, dict[str, Any]]]):
        """Several calls on one server instance (state such as the event cursor persists)."""
        server = self.server()

        async def go():
            async with create_connected_server_and_client_session(server) as session:
                return [await session.call_tool(n, a) for n, a in steps]

        return [json.loads(r.content[0].text) for r in run(go())]

    # ---- listing ----

    def test_tool_list_and_schemas(self):
        async def names(server):
            async with create_connected_server_and_client_session(server) as session:
                return {t.name: t for t in (await session.list_tools()).tools}

        tools = run(names(self.server()))
        self.assertEqual(set(tools), READ_TOOLS | WRITE_TOOLS)  # set_drill only with ORCH_ALLOW_CLOCK=1
        for name, tool in tools.items():
            self.assertIn("incident_id", tool.inputSchema["properties"], name)
            self.assertEqual(tool.annotations.readOnlyHint, name in READ_TOOLS, name)
            first = tool.description.split(".")[0]
            self.assertTrue(first.startswith(("Read-only", "Changes")), (name, first))
        self.assertEqual(tools["triage_report"].inputSchema["properties"]["action"]["enum"],
                         ["confirm", "dismiss", "merge", "resolve"])
        with_clock = run(names(self.server(allow_clock=True)))
        self.assertIn("set_drill", with_clock)
        self.assertTrue(with_clock["set_drill"].annotations.destructiveHint)

    # ---- reads ----

    def test_get_situation_is_compact_and_verbatim(self):
        out = self.call("get_situation")
        text = json.dumps(out)
        self.assertNotIn("geometry", text)
        self.assertNotIn('"line"', text)
        self.assertEqual(out["clock"]["replay_now"], "2018-11-08T16:36:00Z")
        self.assertEqual(out["fire"]["method"], "model_nowcast")
        zones = {z["id"]: z for z in out["zones"]}
        self.assertEqual(zones["bg:060070018001"]["eta_min"], 24)  # planner value, copied
        self.assertEqual(zones["bg:060070018001"]["via"], ["Pentz Road", "Highway 99"])
        self.assertEqual(zones["bg:060070018001"]["twin"]["en_route"], 500)
        self.assertEqual(zones["bg:060070018001"]["checkins"], {"out": 12, "need_help": 1, "staying": 3})
        self.assertEqual(zones["bg:060070009011"]["name"], "Tract 9.01 BG 1")
        self.assertEqual(out["twin"]["totals"]["total_veh"], 31638)
        self.assertEqual(out["events_cursor"], "500:")
        items = {i["item"]: i for i in out["queue"]["items"]}
        self.assertEqual(out["queue"]["items"][0]["item"], "help:chk_1")  # people first
        seg = items["seg:osm-way:100:0"]
        self.assertEqual(seg["conflict"], "2 blocked, 1 passable")
        self.assertIn("conflict", seg["flags"])
        self.assertIn("tasked", seg["flags"])
        self.assertEqual(seg["civilian_parties"], 3)
        self.assertIn("record", items["rpt:rpt_rec"]["flags"])
        self.assertNotIn("rpt:rpt_gone", items)  # dismissed
        pending = out["proposals"]["pending"]
        self.assertEqual([p["id"] for p in pending], ["prp_pending1"])
        self.assertEqual(pending[0]["changes"][0]["to"]["eta_min"], 21)
        self.assertEqual(pending[0]["twin"]["baseline"]["cost"], 84949.0)
        # reads send the token but no actor header
        for r in self.backend.requests:
            self.assertEqual(r["headers"]["Authorization"], f"Bearer {TOKEN}")
            self.assertNotIn(ACTOR_HEADER, r["headers"])

    def test_get_situation_while_twin_warms(self):
        self.backend.twin = None
        out = self.call("get_situation")
        self.assertEqual(out["twin"], {"unavailable": "twin_warming"})

    def test_get_events_dedupes_and_follows_the_cursor(self):
        from tests.fake_backend import EVENTS

        self.backend.events_pages = [
            {"events": EVENTS[:2], "next_cursor": "1000:report:rpt_c", "more": False},
            {"events": EVENTS, "next_cursor": "3000:decision:dec_1", "more": False},
        ]
        start, first, second = self.calls([("get_events", {}), ("get_events", {}), ("get_events", {})])
        self.assertEqual(start, {"events": [], "next_cursor": "500:", "more": False})  # first call starts at now
        self.assertEqual([e["id"] for e in first["events"]], ["rpt_c", "prp_pending1"])
        self.assertEqual([e["id"] for e in second["events"]], ["dec_1"])
        self.assertEqual(second["skipped_already_seen"], 2)
        sinces = [r["query"].get("since") for r in self.backend.requests if r["path"].endswith("/events")]
        self.assertEqual(sinces, ["now", "500:", "1000:report:rpt_c"])
        self.assertNotIn("replay_at", second["events"][0])  # null dropped

    def test_get_events_start_reads_from_the_beginning(self):
        self.call("get_events", {"since": "start", "limit": 5})
        r = self.backend.requests[-1]
        self.assertNotIn("since", r["query"])
        self.assertEqual(r["query"]["limit"], "5")

    def test_get_zone_and_report(self):
        zone = self.call("get_zone", {"zone_id": "bg:060070018002"})
        self.assertEqual(zone["guidance"]["route"]["points"], 3)
        self.assertNotIn("line", zone["guidance"]["route"])
        self.assertEqual(zone["pending_changes"][0]["proposal_id"], "prp_pending1")
        self.assertEqual(zone["guidance"]["alternatives"][0]["load"], 0.42)
        with_geo = self.call("get_zone", {"zone_id": "bg:060070018002", "include_geometry": True})
        self.assertIn("line", with_geo["guidance"]["route"])
        self.assertIn("not_found", self.call("get_zone", {"zone_id": "bg:nope"}, expect_error=True))
        report = self.call("get_report", {"report_id": "rpt_a"})
        self.assertEqual(report["road_state"]["status"], "blocked")
        self.assertEqual(report["tasks"][0]["id"], "tsk_1")
        self.assertEqual({r["id"] for r in report["same_segment_reports"]}, {"rpt_b", "rpt_c"})

    def test_task_route_summary_and_no_origin(self):
        out = self.call("get_task_route", {"task_id": "tsk_1"})
        self.assertEqual(out["route"]["eta_min"], 21)
        self.assertNotIn("line", out["route"])
        self.assertEqual(self.call("get_task_route", {"task_id": "tsk_2"})["reason"], "no_origin")
        self.call("get_task_route", {"task_id": "tsk_1", "from_coord": [-121.7, 39.7]})
        self.assertEqual(self.backend.requests[-1]["query"], {"from": "-121.7,39.7"})

    def test_impact_and_whatif_are_trimmed_and_send_no_actor(self):
        impact = self.call("run_impact", {"report_id": "rpt_a", "horizon_min": 30})
        self.assertNotIn("line", json.dumps(impact))
        self.assertEqual(impact["summary"]["eta_delta_min"], 7)
        self.assertEqual(impact["zones"][0]["blocked"], {"dest": "exit:1", "via": ["Skyway"], "eta_min": 31})
        self.assertEqual(self.backend.requests[-1]["body"], {"report_id": "rpt_a", "horizon_min": 30})
        self.assertIn("invalid_request", self.call("run_impact", {}, expect_error=True))
        whatif = self.call("twin_whatif", {"action_sets": [[{"type": "contraflow", "target": {"corridor": "Skyway"}}]],
                                           "labels": ["Skyway contraflow"]})
        self.assertEqual(whatif["ranking"], [1, 0])
        self.assertEqual(whatif["results"][1]["delta_vs_baseline"], {"objective": -7112.0})
        self.assertNotIn("resolved", json.dumps(whatif))
        for r in self.backend.writes():
            self.assertNotIn(ACTOR_HEADER, r["headers"])

    def test_aar_unavailable(self):
        self.assertIn("aar_unavailable", self.call("get_aar", expect_error=True))

    # ---- writes ----

    def test_writes_send_the_actor_header_and_bodies(self):
        triage = self.call("triage_report", {"report_id": "rpt_a", "action": "confirm", "note": "seen by crew"})
        self.assertEqual(triage["report"]["status"], "confirmed")
        self.assertEqual(triage["replan"]["proposal"]["id"], "prp_pending1")
        task = self.call("create_task", {"kind": "verify", "target": {"segment_id": "osm-way:100:0"},
                                         "report_ids": ["rpt_a"]})
        self.assertEqual(task["task"]["id"], "tsk_new")
        self.call("handle_help", {"checkin_id": "chk_1", "action": "acknowledge"})
        self.assertIsNotNone(self.call("replan")["proposal"])
        approved = self.call("approve_proposal", {"proposal_id": "prp_pending1", "zone_ids": ["bg:060070018002"]})
        self.assertEqual(approved["published"][0]["eta_min"], 21)
        self.assertNotIn('"line"', json.dumps(approved))
        self.assertEqual(self.call("reject_proposal", {"proposal_id": "prp_pending1", "note": "no"})["proposal"]["status"],
                         "rejected")
        writes = self.backend.writes()
        self.assertEqual([w["path"] for w in writes], [
            "reports/rpt_a/triage", "incidents/camp-2018-drill/tasks", "checkins/chk_1/help",
            "incidents/camp-2018-drill/replan", "proposals/prp_pending1/approve", "proposals/prp_pending1/reject"])
        for w in writes:
            self.assertEqual(w["headers"][ACTOR_HEADER], "agent:test-agent")
        self.assertEqual(writes[0]["body"], {"action": "confirm", "note": "seen by crew"})
        self.assertEqual(writes[1]["body"], {"kind": "verify", "target": {"segment_id": "osm-way:100:0"},
                                             "report_ids": ["rpt_a"]})
        self.assertEqual(writes[4]["body"], {"zone_ids": ["bg:060070018002"]})

    def test_backend_errors_become_tool_errors(self):
        text = self.call("triage_report", {"report_id": "rpt_zzz", "action": "dismiss"}, expect_error=True)
        self.assertIn('"error":"not_found"', text)
        self.assertIn('"status":404', text)
        self.assertIn("target needs", self.call("create_task", {"kind": "verify", "target": {}}, expect_error=True))

    def test_set_drill_needs_the_flag(self):
        self.assertIn("Unknown tool", self.call("set_drill", {"action": "set_speed", "speed": 2}, expect_error=True))
        self.assertEqual(self.backend.writes(), [])
        out = self.call("set_drill", {"action": "set_speed", "speed": 2}, server=self.server(allow_clock=True))
        self.assertEqual(out["drill"]["speed"], 2)


class ConfigTest(unittest.TestCase):
    def test_from_env(self):
        config = Config.from_env({"CRISISTWIN_API_BASE": "http://localhost:8000/", "CRISISTWIN_CONTROLLER_TOKEN": TOKEN,
                                  "ORCH_AGENT_NAME": "planner-1", "ORCH_ALLOW_CLOCK": "1"})
        self.assertEqual(config.api_base, "http://localhost:8000")
        self.assertEqual(config.actor, "agent:planner-1")
        self.assertTrue(config.allow_clock)
        self.assertEqual(config.incident_id, "camp-2018-drill")
        self.assertNotIn(TOKEN, repr(config))
        self.assertNotIn(TOKEN, repr(CrisisTwinClient(config)))
        self.assertFalse(Config.from_env({}).allow_clock)

    def test_rejects_bad_values(self):
        with self.assertRaises(ConfigError):
            Config.from_env({"ORCH_AGENT_NAME": "bad name"})
        with self.assertRaises(ConfigError):
            Config.from_env({"CRISISTWIN_API_BASE": "localhost:8000"})


if __name__ == "__main__":
    unittest.main()
