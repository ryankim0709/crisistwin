"""The hidden truth log (sim_truth), injected simulated reports, AAR triage quality and the
source-diversity flag (docs/adr/0042-adversarial-ground-data.md).

Run with MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_noise_test.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import schema, simtruth, twin_service
from api.live.common import col
from api.live.drillcache import get_index
from api.mongodb import get_database

INCIDENT = "camp-2018-drill"
DRILL_URL = f"/api/live/incidents/{INCIDENT}/drill"
AAR_URL = f"/api/live/incidents/{INCIDENT}/aar"
CONTROLLER = "dev-controller"
AUTH = {"HTTP_AUTHORIZATION": f"Bearer {CONTROLLER}"}
T0 = datetime(2018, 11, 8, 14, 30, tzinfo=UTC)
MARKER = "TRUTH_MARKER_7f3a"
REPO = Path(__file__).resolve().parents[5]


def twin_monitor():
    return {"label": "Simulated", "drill_replay_now": "2018-11-08T15:30:00Z", "clock": {"now": "2018-11-08T15:30:00Z"},
            "totals": {"total_veh": 100, "not_departed_veh": 0, "en_route_veh": 50, "arrived_veh": 50, "exposed_veh": 0,
                       "trapped_by_fire_veh": 0, "trapped_by_closure_veh": 0, "exposed_veh_min_so_far": 0.0},
            "zones": []}


class StaticIsolationTest(SimpleTestCase):
    """No code path besides the AAR's truth section reads sim_truth; no client asks for it."""

    ALLOWED_READERS = {"app/backend/api/live/simtruth.py", "app/backend/api/live/aar.py"}
    ALLOWED_MENTIONS = ALLOWED_READERS | {
        "app/backend/api/live/schema.py",
        "app/backend/api/live/views.py",  # the AAR endpoint's gate (docstring only; it never reads the log)
        "app/backend/api/management/commands/live_inject_noise.py",
        "app/backend/config/settings.py",
    }

    def files(self, *roots: str, exts=(".py", ".ts", ".tsx", ".swift", ".js")):
        for root in roots:
            base = REPO / root
            if not base.exists():
                continue
            for p in base.rglob("*"):
                rel = p.relative_to(REPO).as_posix()
                if (p.suffix in exts and p.is_file() and "/tests/" not in rel and "/.venv/" not in rel
                        and "node_modules" not in rel and "/build/" not in rel):
                    yield rel, p.read_text(errors="ignore")

    def test_only_the_aar_reads_the_truth_log(self):
        for rel, text in self.files("app/backend", "orchestrator_mcp", "agent", "app/src", "mobile"):
            if "sim_truth" in text or "read_truth" in text:
                self.assertIn(rel, self.ALLOWED_MENTIONS, rel)
            if re.search(r"\bread_truth\(", text):
                self.assertIn(rel, self.ALLOWED_READERS, rel)
            if rel not in self.ALLOWED_MENTIONS:
                self.assertNotRegex(text, r"[?&]truth=", rel)  # no client asks the AAR for truth

    def test_aar_reads_truth_only_in_its_truth_section(self):
        text = (REPO / "app/backend/api/live/aar.py").read_text()
        calls = [m.start() for m in re.finditer(r"\bread_truth\(", text)]
        self.assertEqual(len(calls), 1)
        head = text[:calls[0]]
        self.assertGreater(head.rfind("def triage_quality("), head.rfind("def build_aar("))


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL")
class SimTruthTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        db = get_database()
        if not db.name.endswith("_test"):
            raise RuntimeError(f"Refusing to wipe database {db.name!r}; use a *_test database.")
        schema.apply(db, drop_drill_data=True)
        cls.gn = simtruth._gen_noise()
        index = get_index()
        segs = sorted(sid for sid, line in index.segment_lines.items() if len(line) >= 2)
        cls.seg_a, cls.seg_b = segs[100], segs[400]
        cls.place_a = list(index.segment_lines[cls.seg_a][0])
        cls.place_b = list(index.segment_lines[cls.seg_b][0])

    def setUp(self):
        cache.clear()
        db = get_database()
        for name in [n for n in db.list_collection_names() if n.startswith("live_") or n == "sim_truth"]:
            db[name].delete_many({})
        self.patches = [mock.patch.object(twin_service, "monitor", return_value=twin_monitor()),
                        mock.patch.object(twin_service, "warm")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def drill(self, action, **body):
        r = self.client.post(DRILL_URL, data=json.dumps({"action": action, **body}), content_type="application/json",
                             **AUTH)
        self.assertEqual(r.status_code, 200, r.content)

    def ev(self, name, kind, coord, minutes, party):
        at = T0 + timedelta(minutes=minutes)
        return self.gn.report_event(client_id=self.gn._uuid("t", name), kind=kind, coord=coord, observed=at, upload=at,
                                    party_key=f"sim_{party:016x}", incident_id=INCIDENT)

    def seed_scenario(self):
        """A stopped drill at T0+60 with honest, false and rumour reports, decisions and their truth."""
        self.drill("start", replay_start="2018-11-08T15:30:00Z", speed=0)  # stopped (speed 0) at T0 + 60 min
        a, b = self.place_a, self.place_b
        events = {
            "h1": self.ev("h1", "road_blocked", a, 6, 1),
            "h2": self.ev("h2", "fire_seen", self.gn.offset(a, 2000, 0), 8, 2),
            "f1": self.ev("f1", "fire_seen", self.gn.offset(a, -2000, 0), 9, 3),
            "r1": self.ev("r1", "road_blocked", b, 10, 4),
            "r2": self.ev("r2", "road_blocked", b, 14, 5),
            "r3": self.ev("r3", "road_blocked", b, 18, 6),
            "e1": self.ev("e1", "help_needed", self.gn.offset(b, 3000, 3000), 20, 7),
        }
        ids = {k: e["body"]["client_id"] for k, e in events.items()}
        rumour = {"rumour_id": "R", "rumour_onset_at": "2018-11-08T14:40:00Z", "rumour_place": b, "claim": "road_blocked"}
        truth = {
            ids["h1"]: {"true": True, "kind_of_noise": None, "source_event_id": None, "notes": "honest"},
            ids["h2"]: {"true": True, "kind_of_noise": None, "source_event_id": None, "notes": "honest"},
            ids["f1"]: {"true": False, "kind_of_noise": "wrong_kind", "source_event_id": "x", "notes": MARKER},
            ids["r1"]: {"true": False, "kind_of_noise": "rumour", "source_event_id": None, "notes": MARKER, **rumour},
            ids["r2"]: {"true": False, "kind_of_noise": "rumour", "source_event_id": None, "notes": MARKER, **rumour},
            ids["r3"]: {"true": False, "kind_of_noise": "rumour", "source_event_id": None, "notes": MARKER, **rumour},
            ids["e1"]: {"true": False, "kind_of_noise": "empty_help", "source_event_id": None, "notes": MARKER},
            "truth_change:C": {"true": True, "kind_of_noise": "truth_change", "source_event_id": None, "notes": MARKER,
                               "at": "2018-11-08T14:35:00Z", "coord": a, "before": "road_passable",
                               "after": "road_blocked", "place_id": "A"},
        }
        now = datetime.now(UTC).replace(microsecond=0)
        simtruth.write_truth(INCIDENT, truth, now, profile="test", seed=1)
        counts = simtruth.inject_reports(INCIDENT, list(events.values()), now,
                                         received_at_for=lambda at: now - (T0 + timedelta(hours=1) - at))
        self.assertEqual(counts["inserted"], 7, counts)
        rid = {k: col("live_reports").find_one({"client_id": v})["id"] for k, v in ids.items()}

        def decide(action, key, minutes, wall_s):
            col("live_decisions").insert_one({
                "incident_id": INCIDENT, "at": now + timedelta(seconds=wall_s), "actor": "controller", "action": action,
                "report_ids": [rid[key]], "replay_at": T0 + timedelta(minutes=minutes)})
            status = {"confirm": "confirmed", "dismiss": "dismissed"}[action]
            col("live_reports").update_one({"id": rid[key]}, {"$set": {"status": status}})

        decide("confirm", "h1", 45, 1)
        decide("confirm", "f1", 46, 2)
        decide("dismiss", "h2", 47, 3)
        for i, key in enumerate(("r1", "r2", "r3")):
            decide("dismiss", key, 38 + i, 10 + i)  # last rumour dismissal at T0 + 40
        prop_wall = now + timedelta(seconds=300)
        col("live_proposals").insert_one({
            "id": "prp_t", "incident_id": INCIDENT, "created_at": prop_wall, "replay_at": T0 + timedelta(minutes=30),
            "status": "auto_approved", "policy": "auto_reroute", "causes": ["road_block"],
            "cause_segment_ids": [col("live_reports").find_one({"id": rid["r1"]})["road_ref"]["segment_id"]],
            "changes": [], "tasks": [], "rationale": {"text": "t"}})
        col("live_guidance").insert_one({
            "incident_id": INCIDENT, "zone_id": "bg:060070024001", "level": "evacuate_now", "no_route": False,
            "version": 1, "published_at": prop_wall, "replay_at": T0 + timedelta(minutes=30),
            "approved_by": "auto_policy", "proposal_id": "prp_t"})
        col("live_tasks").insert_one({
            "id": "tsk_t", "incident_id": INCIDENT, "kind": "assist", "target": {"segment_id": None, "coord": None},
            "report_ids": [rid["e1"]], "status": "open", "created_at": now, "replay_at": T0 + timedelta(minutes=25)})
        return ids, rid

    # -- injection --------------------------------------------------------------------------------

    def test_injected_reports_are_simulated_and_carry_no_truth(self):
        ids, rid = self.seed_scenario()
        for doc in col("live_reports").find({"incident_id": INCIDENT}):
            self.assertEqual(doc["evidence_class"], "simulated")
            for key in ("true", "kind_of_noise", "truth", "rumour_id", "notes"):
                self.assertNotIn(key, doc)
        # idempotent on client_id: a retry storm stores one report
        again = simtruth.inject_reports(INCIDENT, [self.ev("h1", "road_blocked", self.place_a, 6, 1)] * 3,
                                        datetime.now(UTC))
        self.assertEqual((again["inserted"], again["existing"]), (0, 3))

    def test_rate_limit_applies_to_a_burst(self):
        burst = [self.ev(f"b{i}", "fire_seen", self.place_a, 1 + i / 60, 99) for i in range(20)]  # 20 in 20 s
        counts = simtruth.inject_reports(INCIDENT, burst, datetime.now(UTC))
        self.assertEqual(counts["inserted"], 6)
        self.assertEqual(counts["rate_limited"], 14)

    # -- isolation --------------------------------------------------------------------------------

    def test_no_endpoint_leaks_the_truth_log(self):
        self.seed_scenario()
        dev = self.client.post("/api/live/devices", data="{}", content_type="application/json").json()
        civ = {"HTTP_AUTHORIZATION": f"Bearer {dev['token']}"}
        base = f"/api/live/incidents/{INCIDENT}"
        gets = [(f"{base}/reports", AUTH), (f"{base}/road-state", AUTH), (f"{base}/public-map", AUTH),
                (f"{base}/prompts?near={self.place_b[0]},{self.place_b[1]}", civ), (f"{base}/situation", AUTH),
                (f"{base}/situation", civ), (f"{base}/command", AUTH), (f"{base}/events", AUTH), (AAR_URL, AUTH),
                (f"{base}/injects", AUTH), ("/api/live/me/reports", civ), ("/api/live/me/tasks", civ),
                ("/api/live/active", civ), ("/api/live", civ)]
        checked = 0
        for url, auth in gets:
            r = self.client.get(url, **auth)
            self.assertLess(r.status_code, 500, (url, r.content[:300]))
            text = r.content.decode()
            for needle in (MARKER, "kind_of_noise", "sim_truth", "triage_quality", "rumour_id"):
                self.assertNotIn(needle, text, url)
            checked += r.status_code == 200
        self.assertGreaterEqual(checked, 10)

    def test_aar_truth_gate(self):
        self.seed_scenario()
        self.assertNotIn("triage_quality", self.client.get(AAR_URL, **AUTH).json())
        r = self.client.get(AAR_URL + "?truth=1", **AUTH)
        self.assertEqual(r.status_code, 403)  # LIVE_TRUTH_SCORING defaults to off
        self.assertNotIn(MARKER, r.content.decode())
        with override_settings(LIVE_TRUTH_SCORING=True):
            self.assertEqual(self.client.get(AAR_URL + "?truth=1").status_code, 401)  # controller only
            self.drill("start", replay_start="2018-11-08T15:30:00Z", speed=1)
            r = self.client.get(AAR_URL + "?truth=1", **AUTH)
            self.assertEqual(r.status_code, 409)  # drill running
            self.assertNotIn(MARKER, r.content.decode())
            self.drill("set_speed", speed=0)
            r = self.client.get(AAR_URL + "?truth=1", **AUTH)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertIn("triage_quality", r.json())

    # -- scoring ----------------------------------------------------------------------------------

    def test_triage_quality_on_a_seeded_scenario(self):
        self.seed_scenario()
        with override_settings(LIVE_TRUTH_SCORING=True):
            body = self.client.get(AAR_URL + "?truth=1", **AUTH).json()
        tq = body["triage_quality"]
        self.assertEqual(tq["status"], "ok")
        self.assertEqual(tq["horizon"], "2018-11-08T15:30:00Z")
        self.assertEqual(tq["reports_scored"], 7)
        self.assertEqual((tq["confirm"]["n"], tq["confirm"]["true"], tq["confirm"]["precision"]), (2, 1, 0.5))
        self.assertEqual((tq["confirm"]["recall_pool"], tq["confirm"]["recall"]), (2, 0.5))  # h1 of h1, h2
        self.assertEqual((tq["dismiss"]["n"], tq["dismiss"]["false"], tq["dismiss"]["precision"]), (4, 3, 0.75))
        self.assertEqual((tq["dismiss"]["recall_pool"], tq["dismiss"]["recall"]), (5, 0.6))  # r1-3 of f1, r1-3, e1
        change = tq["truth_changes"]["items"][0]
        self.assertEqual((change["detected"], change["minutes"]), (True, 40.0))  # 14:35 -> confirm h1 at 15:15
        dof = tq["decisions_on_false"]
        self.assertEqual((dof["guidance_changes"], dof["dispatches_assist"], dof["total"]), (1, 1, 2))
        rumour = tq["rumours"]["items"][0]
        self.assertEqual((rumour["members_received"], rumour["contained"], rumour["minutes"]), (3, True, 30.0))
        m = tq["metrics"]
        self.assertEqual(m["triage.confirm_precision"], 0.5)
        self.assertEqual(m["rumour_containment_min"], 30.0)
        self.assertEqual(m["decisions_on_false_info"], 2.0)
        self.assertEqual(tq["evidence_class"], "simulated")

    # -- corroboration flag -----------------------------------------------------------------------

    def test_source_diversity_flag_on_road_state(self):
        """Three new parties 150 s and 150 m apart on one road: three independent parties (public
        block) today; one with LIVE_SOURCE_DIVERSITY on."""
        self.drill("start", replay_start="2018-11-08T15:30:00Z", speed=0)
        a = self.place_a
        evs = [self.ev(f"s{i}", "road_blocked", a, 1 + 2.5 * i, 50 + i) for i in range(3)]
        now = datetime.now(UTC).replace(microsecond=0)
        simtruth.inject_reports(INCIDENT, evs, now, received_at_for=lambda at: now - (T0 + timedelta(minutes=10) - at))
        seg = col("live_reports").find_one({"client_id": evs[0]["body"]["client_id"]})["road_ref"]["segment_id"]

        def state():
            rows = self.client.get(f"/api/live/incidents/{INCIDENT}/road-state", **AUTH).json()["items"]
            return next(r for r in rows if r["segment_id"] == seg)

        off = state()
        self.assertEqual((off["status"], off["independent_parties"], off["public"]), ("blocked", 3, True))
        with override_settings(LIVE_SOURCE_DIVERSITY=True):
            on = state()
        self.assertEqual((on["status"], on["independent_parties"], on["public"]), ("blocked", 1, False))
        self.assertEqual(state()["independent_parties"], 3)  # back off
