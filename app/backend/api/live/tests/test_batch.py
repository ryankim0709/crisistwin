"""Headless batch runner (api/live/batch.py) and the AAR refactor (api/live/aar.py compute_aar).

Run with MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_batch_test
LIVE_DRILL_BUNDLE=<repo>/app/public/replays/camp-2018.json. The mini runs need the Camp twin
packages (data/incidents/.../raw and normalized) and skip without them.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import aar, batch, schema, twin_service
from api.live.common import col
from api.live.drillcache import bundle_path, get_index
from api.live.state import load_snapshot
from api.mongodb import get_database
from livecore.geo import centroid

INCIDENT = "camp-2018-drill"
CONTROLLER = "dev-controller"
ZONE_A = "bg:060070024001"
T0 = datetime(2018, 11, 8, 14, 30, tzinfo=UTC)


def mini_spec(**kw):
    d = {
        "scenario_id": "camp-2018-drill",
        "package": {"kind": "camp_bundle", "path": str(bundle_path())},
        "window": {"start": "2018-11-08T15:00:00Z", "end": "2018-11-08T15:40:00Z"},
        "responders": {"enabled": True, "units": 3},
        "seeds": {"panel": "dev", "n": 2},
    }
    d.update(kw)
    return batch.spec_from_dict(d)


def twin_data_available() -> bool:
    return (twin_service.REPO_ROOT / twin_service.CAMP_PACKAGE / "normalized").exists() and bundle_path().exists()


class SpecTest(SimpleTestCase):
    def test_defaults_and_hash_inputs(self):
        spec = mini_spec()
        self.assertEqual(spec.clock["mode"], "lockstep")
        self.assertEqual(spec.tick_s, 60)
        gp = spec.generator_params()
        self.assertEqual(gp["window"], ["2018-11-08T15:00:00Z", "2018-11-08T15:40:00Z"])
        self.assertIn("clock", gp)  # cadence is part of the block: different cadences never pair

    def test_rejects_bad_specs(self):
        for bad in ({"clock": {"mode": "realtime@2"}}, {"clock": {"tick_s": 15}},
                    {"window": {"start": "2018-11-08T16:00:00Z", "end": "2018-11-08T15:00:00Z"}},
                    {"injects": [{"type": "meteor", "at": "2018-11-08T15:00:00Z"}]},
                    {"package": {"kind": "zip", "path": "x"}}, {"seeds": {"panel": "prod"}}):
            with self.assertRaises(ValueError, msg=bad):
                mini_spec(**bad)


def observation(now="2018-11-08T15:10:00Z"):
    """A get_situation digest with the fields the built-in strategies read."""
    return {
        "clock": {"replay_now": now},
        "proposals": {"pending": [{"id": "prp_000001"}]},
        "queue": {"items": [
            {"item": "seg:a", "kind": "road_blocked", "flags": ["new"], "civilian_parties": 2, "responder_reports": 0,
             "report_ids": ["rpt_2", "rpt_1"], "newest_replay_at": "2018-11-08T15:00:00Z"},
            {"item": "seg:b", "kind": "road_blocked", "flags": ["new"], "civilian_parties": 1, "responder_reports": 0,
             "report_ids": ["rpt_3"], "newest_replay_at": "2018-11-08T15:09:00Z"},
            {"item": "seg:c", "kind": "road_blocked", "flags": ["new", "record"], "civilian_parties": None,
             "responder_reports": None, "report_ids": ["rpt_4"], "newest_replay_at": "2018-11-08T15:04:00Z"},
            {"item": "rpt:5", "kind": "fire_seen", "flags": ["new", "record"], "civilian_parties": None,
             "responder_reports": None, "report_ids": ["rpt_5"], "newest_replay_at": "2018-11-08T15:06:00Z"},
            {"item": "help:chk_1", "kind": "help_needed", "flags": ["help", "new"], "checkin_id": "chk_1"},
        ]},
        "help_requests": [{"checkin_id": "chk_1", "coord": [-121.60, 39.76], "status": "open"},
                          {"checkin_id": "chk_2", "coord": [-121.60, 39.76], "status": "assigned"}],
        "responders": [{"party_key": "rsp_far", "coord": [-121.80, 39.70]},
                       {"party_key": "rsp_near", "coord": [-121.61, 39.76]}],
    }


class StrategyInterfaceTest(SimpleTestCase):
    def test_rule_auto(self):
        acts = batch.RuleAuto().decide(observation())
        self.assertEqual(acts, [
            {"tool": "approve_proposal", "args": {"proposal_id": "prp_000001"}},
            {"tool": "triage_report", "args": {"report_id": "rpt_2", "action": "confirm"}},
            {"tool": "handle_help", "args": {"checkin_id": "chk_1", "action": "assign", "assignee": "rsp_near"}},
        ])

    def test_record_delay(self):
        acts = batch.RecordDelay(5).decide(observation())
        self.assertEqual([a["args"].get("report_id") for a in acts], [None, "rpt_4"])  # rpt_5 is 4 min old
        self.assertEqual(batch.make_strategy("record_delay_5").strategy_id, "record_delay_5")

    def test_historical_only_and_registry(self):
        self.assertEqual(batch.HistoricalOnly().decide(observation()), [])
        self.assertFalse(batch.make_strategy("historical_only").drill_system)
        with self.assertRaises(ValueError):
            batch.make_strategy("mcp_agent")
        with self.assertRaises(ValueError):
            batch.make_strategy("best_strategy")

    def test_versions_differ_by_config(self):
        _, ev, _, _, _ = batch._sim()
        self.assertNotEqual(ev.hash_json(batch.RecordDelay(5).config()), ev.hash_json(batch.RecordDelay(10).config()))


class ScriptedAgent:
    """An orchestrator stand-in: reads the situation, approves the pending proposal, ends the turn."""

    def __init__(self):
        self.calls = []
        self.pending = []

    def __call__(self, msg):
        if msg["type"] == "turn":
            self.pending = [p["id"] for p in json.loads(msg["situation"]).get("proposals", {}).get("pending", [])]
            self.calls.append("get_situation")
            return {"type": "call", "tool": "get_situation", "args": {"max_queue": 3}}
        if self.pending:
            pid = self.pending.pop()
            self.calls.append("approve_proposal")
            return {"type": "call", "tool": "approve_proposal", "args": {"proposal_id": pid}}
        return {"type": "done", "usage": {"tokens_in": 10, "tokens_out": 2}}


class MiniRunTest(SimpleTestCase):
    """A 40-minute window, 2 dev seeds: determinism, pairing, the MCP adapter and the comparison."""

    world = None

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not twin_data_available():
            raise __import__("unittest").SkipTest("Camp twin packages are not available locally")
        cls.spec = mini_spec()
        cls.world = batch.build_world(cls.spec)
        cls.seeds = cls.spec.seed_list(batch._sim()[1])
        cls.results = batch.run_batch(cls.world, [batch.HistoricalOnly(), batch.RuleAuto(), batch.RecordDelay(5)],
                                      cls.seeds)

    def by(self, strategy_id, seed):
        return next(r for r in self.results if r.manifest.strategy_id == strategy_id and r.manifest.seed == seed)

    def test_determinism_same_spec_and_seed(self):
        again = batch.run_one(self.world, batch.RuleAuto(), self.seeds[0])
        first = self.by("rule_auto", self.seeds[0])
        self.assertEqual(again.manifest.metrics, first.manifest.metrics)
        self.assertEqual(again.manifest.actions_log_hash, first.manifest.actions_log_hash)
        self.assertEqual(again.manifest.run_id, first.manifest.run_id)

    def test_determinism_across_worlds(self):
        """A fresh world (new twin inputs, new comms draw) gives the same run."""
        world2 = batch.build_world(self.spec)
        again = batch.run_one(world2, batch.RecordDelay(5), self.seeds[1])
        self.assertEqual(again.manifest.metrics, self.by("record_delay_5", self.seeds[1]).manifest.metrics)

    def test_pairing_blocks_and_common_inputs(self):
        _, ev, _, _, _ = batch._sim()
        manifests = [r.manifest for r in self.results]
        self.assertEqual(ev.design_issues(manifests), [])
        for seed in self.seeds:
            rs = [r for r in self.results if r.manifest.seed == seed]
            self.assertEqual(len({r.manifest.block for r in rs}), 1)
            # Exogenous streams are identical whatever the strategy does (common random numbers).
            self.assertEqual(len({(r.stats["reports_record"], r.stats["reports_comms"]) for r in rs}), 1)
            self.assertEqual(len({r.manifest.meta["twin_seed"] for r in rs}), 1)
        self.assertNotEqual(self.by("rule_auto", self.seeds[0]).manifest.block,
                            self.by("rule_auto", self.seeds[1]).manifest.block)
        # Generated comms are drawn up front from the seed: same items for every strategy.
        items = self.world.comms_items(self.seeds[0])
        self.assertEqual(items, batch.build_world(self.spec).comms_items(self.seeds[0]))

    def test_scores_in_drill_minutes_and_invariants(self):
        for r in self.results:
            m = r.manifest
            self.assertEqual(m.meta["aar_time_basis"], "drill")
            self.assertEqual(m.meta["invariant_failures"], [])
            comps = {c["id"]: c for c in r.aar["score"]["components"]}
            self.assertEqual(comps["help_to_assign"]["unit"], "drill minutes")
            self.assertEqual(r.aar["drill"]["replay_now"], "2018-11-08T15:40:00Z")
            self.assertIsNotNone(m.metrics["aar.arrived_share"])
        hist = self.by("historical_only", self.seeds[0])
        self.assertEqual(hist.stats["tool_calls"], 0)
        self.assertEqual(hist.stats["replans"], 0)
        self.assertGreater(self.by("rule_auto", self.seeds[0]).stats["approvals"], 0)

    def test_compare_tables(self):
        md, js = batch.compare_runs([r.manifest for r in self.results], n_boot=200)
        self.assertIn("| primary | aar.arrived_share (share)", md)
        self.assertIn("insufficient pairs", md)  # 2 seeds < MIN_PAIRS
        self.assertEqual(js["kind"], "crisistwin_strategy_comparison")
        self.assertEqual(len(js["runs"]), len(self.results))

    def test_manifest_roundtrip(self):
        _, ev, _, _, _ = batch._sim()
        m = self.results[0].manifest
        self.assertEqual(ev.RunManifest.from_dict(json.loads(m.to_json())), m)

    def test_mcp_agent_adapter_inprocess(self):
        agent = ScriptedAgent()
        strat = batch.make_strategy("mcp_agent", agent=agent, agent_name="scripted")
        res = batch.run_one(self.world, strat, self.seeds[0])
        self.assertEqual(res.manifest.strategy_id, "orchestrator:scripted")
        self.assertIn("approve_proposal", agent.calls)
        self.assertGreater(res.stats["approvals"], 0)
        self.assertGreater(res.manifest.metrics["agent.tokens_in"], 0)
        again = batch.run_one(self.world, batch.make_strategy("mcp_agent", agent=ScriptedAgent(),
                                                              agent_name="scripted"), self.seeds[0])
        self.assertEqual(again.manifest.metrics, res.manifest.metrics)

    def test_mcp_agent_adapter_subprocess(self):
        code = ("import sys, json\n"
                "for line in sys.stdin:\n"
                "    msg = json.loads(line)\n"
                "    print(json.dumps({'type': 'done'}), flush=True)\n")
        strat = batch.make_strategy("mcp_agent", agent=[sys.executable, "-c", code], agent_name="noop")
        res = batch.run_one(self.world, strat, self.seeds[0])
        self.assertEqual(res.stats["tool_calls"], 0)
        self.assertEqual(res.manifest.metrics["agent.turns"], res.manifest.meta["decision_ticks"])


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL")
class AarParityTest(SimpleTestCase):
    """compute_aar on explicit documents gives the endpoint's numbers on a seeded database."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        db = get_database()
        if not db.name.endswith("_test"):
            raise RuntimeError(f"Refusing to wipe database {db.name!r}; use a *_test database.")
        schema.apply(db, drop_drill_data=True)

    def setUp(self):
        cache.clear()
        db = get_database()
        for name in [n for n in db.list_collection_names() if n.startswith("live_")]:
            db[name].delete_many({})
        r = self.client.post(f"/api/live/incidents/{INCIDENT}/drill",
                             data=json.dumps({"action": "start", "replay_start": "2018-11-08T14:30:00Z", "speed": 0}),
                             content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")
        self.assertEqual(r.status_code, 200, r.content)

    def seed_docs(self):
        w = datetime.now(UTC).replace(microsecond=0)
        coord = list(centroid(get_index().zones[ZONE_A].geometry))
        docs = {
            "live_guidance": [
                {"incident_id": INCIDENT, "zone_id": ZONE_A, "level": "evacuate_now", "no_route": False, "version": 1,
                 "published_at": w, "replay_at": T0 + timedelta(minutes=10), "approved_by": "controller",
                 "proposal_id": "prp_x"}],
            "live_reports": [
                {"id": f"rpt_{i}", "client_id": f"c{i}", "incident_id": INCIDENT, "kind": "road_blocked",
                 "status": "confirmed", "evidence_class": "field_report",
                 "reporter": {"role": "civilian", "party_key": "dev_1"}, "location": {"coord": coord},
                 "observed_at": w + timedelta(minutes=i), "received_at": w + timedelta(minutes=i),
                 "updated_at": w, "replay_at": T0 + timedelta(minutes=i)} for i in range(2)],
            "live_decisions": [
                {"incident_id": INCIDENT, "at": w + timedelta(minutes=3), "actor": "controller", "action": "confirm",
                 "report_ids": ["rpt_0"]},
                {"incident_id": INCIDENT, "at": w + timedelta(minutes=6), "actor": "controller",
                 "action": "help_assign", "report_ids": [], "checkin_id": "chk_1"}],
            "live_checkins": [
                {"id": "chk_1", "incident_id": INCIDENT, "party_key": "dev_1", "status": "need_help",
                 "zone_id": ZONE_A, "coord": coord, "at": w, "replay_at": T0,
                 "help": {"status": "assigned", "assignee": None, "task_id": "tsk_1", "updated_at": w}}],
            "live_tasks": [
                {"id": "tsk_1", "incident_id": INCIDENT, "kind": "assist", "status": "accepted",
                 "target": {"segment_id": None, "coord": coord}, "created_at": w + timedelta(minutes=6),
                 "accepted_at": w + timedelta(minutes=8)}],
        }
        for name, rows in docs.items():
            col(name).insert_many([dict(r) for r in rows])
        return docs

    def test_endpoint_equals_explicit_inputs(self):
        docs = self.seed_docs()
        monitor = {"totals": {"total_veh": 1000, "not_departed_veh": 100, "en_route_veh": 300, "arrived_veh": 600,
                              "exposed_veh": 5, "trapped_by_fire_veh": 2, "trapped_by_closure_veh": 0,
                              "exposed_veh_min_so_far": 400.0},
                   "zones": [{"id": ZONE_A, "vehicles": 300, "arrived_veh": 120, "exposed_veh": 4}]}
        with mock.patch.object(twin_service, "monitor", return_value=monitor), mock.patch.object(twin_service, "warm"):
            body = self.client.get(f"/api/live/incidents/{INCIDENT}/aar", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}").json()
            snapshot = load_snapshot(INCIDENT, datetime.now(UTC))
        # The batch path: no database reads, the same documents as plain lists.
        data = aar.AarData(
            decisions=sorted(col("live_decisions").find({"incident_id": INCIDENT}), key=lambda d: d["at"]),
            proposals=[], checkins=docs["live_checkins"], guidance=docs["live_guidance"],
            reports=docs["live_reports"], tasks=docs["live_tasks"], twin=aar.twin_outcomes(monitor))
        explicit = json.loads(json.dumps(aar.compute_aar(aar.context_from(snapshot), data), default=str))
        self.assertEqual(explicit["score"], body["score"])
        self.assertEqual(explicit["zones"], body["zones"])
        self.assertEqual(explicit["help"], body["help"])
        self.assertEqual(explicit["triage"], body["triage"])
        self.assertEqual(body["score"]["components"][2]["raw"], 6.0)  # wall minutes, as before the refactor
        self.assertEqual(body["score"]["components"][2]["unit"], "wall minutes")

    def test_drill_basis_reads_replay_times(self):
        docs = self.seed_docs()
        snapshot = load_snapshot(INCIDENT, datetime.now(UTC))
        decisions = [dict(d, replay_at=T0 + timedelta(minutes=12)) if d["action"] == "help_assign" else d
                     for d in docs["live_decisions"]]
        data = aar.AarData(decisions=decisions, checkins=docs["live_checkins"], guidance=docs["live_guidance"],
                           reports=docs["live_reports"], tasks=docs["live_tasks"])
        out = aar.compute_aar(aar.context_from(snapshot), data, time_basis="drill")
        comp = {c["id"]: c for c in out["score"]["components"]}["help_to_assign"]
        self.assertEqual(comp["raw"], 12.0)  # T0 -> T0 + 12 min on the drill clock
        self.assertEqual(comp["unit"], "drill minutes")
        self.assertEqual(out["help"]["basis"], "drill minutes")
        with self.assertRaises(ValueError):
            aar.compute_aar(aar.context_from(snapshot), data, time_basis="lunar")
