"""After-action report and drill score (api/live/aar.py), seeded database and a patched twin.

Run with MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_aar_test.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from api.live import aar, schema, twin_service
from api.live.common import col
from api.live.drillcache import get_index
from api.mongodb import get_database
from livecore.geo import centroid

INCIDENT = "camp-2018-drill"
DRILL_URL = f"/api/live/incidents/{INCIDENT}/drill"
BASE = f"/api/live/incidents/{INCIDENT}/aar"
CONTROLLER = "dev-controller"
ZONE_A = "bg:060070024001"  # 2018 order at 14:55Z
ZONE_B = "bg:060070019002"  # 2018 order at 15:46Z
T0 = datetime(2018, 11, 8, 14, 30, tzinfo=UTC)


def twin_monitor(arrived=7500, total=10000, exposed_min=5000.0, trapped=10):
    return {
        "label": "Simulated", "drill_replay_now": "2018-11-08T14:30:00Z", "clock": {"now": "2018-11-08T14:30:00Z"},
        "totals": {"total_veh": total, "not_departed_veh": 0, "en_route_veh": total - arrived, "arrived_veh": arrived,
                   "exposed_veh": 100, "trapped_by_fire_veh": trapped, "trapped_by_closure_veh": 0,
                   "exposed_veh_min_so_far": exposed_min},
        "zones": [{"id": ZONE_A, "vehicles": 300, "arrived_veh": 120, "exposed_veh": 4}],
    }


class ScoreTest(SimpleTestCase):
    twin = {"total_veh": 10000, "arrived_veh": 7500, "exposed_veh_min": 5000.0, "trapped_by_fire_veh": 10}

    def test_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(aar.WEIGHTS.values()), 1.0)

    def test_formula(self):
        s = aar.score_components(self.twin, 6.0, 2, 2, [-15.0, 15.0], 0)
        c = {x["id"]: x for x in s["components"]}
        self.assertEqual(c["arrived_share"]["score"], 0.75)
        # (5000 + 60 * 10) / 10000 = 0.56 veh-min per vehicle -> 1 - 0.56 / 5
        self.assertAlmostEqual(c["exposed_trapped"]["raw"], 0.56)
        self.assertAlmostEqual(c["exposed_trapped"]["score"], 0.888)
        self.assertAlmostEqual(c["help_to_assign"]["score"], 0.8)
        # zones: -15 -> 0.75, +15 -> 0.25 -> mean 0.5
        self.assertAlmostEqual(c["leave_now_vs_2018"]["score"], 0.5)
        expected = 100 * (0.35 * 0.75 + 0.30 * 0.888 + 0.15 * 0.8 + 0.20 * 0.5)
        self.assertAlmostEqual(s["value"], expected, delta=0.2)
        self.assertEqual(s["coverage"], 1.0)

    def test_missing_components_renormalise(self):
        s = aar.score_components(None, None, 0, 0, [], 0)
        self.assertIsNone(s["value"])
        s = aar.score_components(self.twin, None, 0, 0, [], 0)
        c = {x["id"]: x for x in s["components"]}
        self.assertIsNone(c["help_to_assign"]["score"])
        self.assertAlmostEqual(c["arrived_share"]["effective_weight"], 0.35 / 0.65, places=3)
        self.assertAlmostEqual(s["coverage"], 0.65)

    def test_unassigned_help_and_missed_zones_score_zero(self):
        s = aar.score_components(self.twin, None, 3, 0, [], 2)
        c = {x["id"]: x for x in s["components"]}
        self.assertEqual(c["help_to_assign"]["score"], 0.0)
        self.assertEqual(c["leave_now_vs_2018"]["score"], 0.0)

    def test_clamped(self):
        s = aar.score_components(self.twin, 500.0, 1, 1, [-500.0], 0)
        c = {x["id"]: x for x in s["components"]}
        self.assertEqual(c["help_to_assign"]["score"], 0.0)
        self.assertEqual(c["leave_now_vs_2018"]["score"], 1.0)


@override_settings(LIVE_CONTROLLER_TOKEN=CONTROLLER, LIVE_INVITE_CODE="DRILL")
class AarEndpointTest(SimpleTestCase):
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
        self.start_drill("2018-11-08T14:30:00Z")
        self.wall = datetime.now(UTC).replace(microsecond=0)

    def start_drill(self, replay_start):
        r = self.client.post(DRILL_URL, data=json.dumps({"action": "start", "replay_start": replay_start, "speed": 0}),
                             content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")
        self.assertEqual(r.status_code, 200, r.content)

    def get(self, monitor=None, exc=None):
        patch = (mock.patch.object(twin_service, "monitor", side_effect=exc) if exc
                 else mock.patch.object(twin_service, "monitor", return_value=monitor or twin_monitor()))
        with patch, mock.patch.object(twin_service, "warm"):
            return self.client.get(BASE, HTTP_AUTHORIZATION=f"Bearer {CONTROLLER}")

    def report(self, rid, evidence_class, coord, received):
        return {
            "id": rid, "client_id": f"c-{rid}", "incident_id": INCIDENT, "kind": "road_blocked",
            "status": "confirmed", "evidence_class": evidence_class, "reporter": {"role": "civilian", "party_key": "dev_1"},
            "location": {"coord": coord}, "observed_at": received, "received_at": received, "updated_at": received}

    def seed(self):
        w = self.wall
        guidance = [
            (ZONE_A, 1, "be_ready", T0 + timedelta(minutes=5)),
            (ZONE_A, 2, "evacuate_now", T0 + timedelta(minutes=10)),  # 14:40, 15 min before the 2018 order
            (ZONE_B, 1, "evacuate_now", T0 + timedelta(minutes=96)),  # 16:06, 20 min after
        ]
        for zone, version, level, replay_at in guidance:
            col("live_guidance").insert_one({
                "incident_id": INCIDENT, "zone_id": zone, "level": level, "no_route": False, "version": version,
                "published_at": w, "replay_at": replay_at, "approved_by": "controller", "proposal_id": "prp_x"})
        coord = list(centroid(get_index().zones[ZONE_A].geometry))
        for i, (received, triaged) in enumerate([(0, 2), (1, 5)]):
            col("live_reports").insert_one(
                self.report(f"rpt_{i}", "field_report", coord, w + timedelta(minutes=received)))
            col("live_decisions").insert_one({
                "incident_id": INCIDENT, "at": w + timedelta(minutes=triaged), "actor": "controller",
                "action": "confirm", "report_ids": [f"rpt_{i}"]})
        col("live_reports").insert_one(self.report("rpt_hist", "historical_record", coord, w))
        col("live_checkins").insert_one({
            "id": "chk_1", "incident_id": INCIDENT, "party_key": "dev_1", "status": "need_help", "zone_id": ZONE_A,
            "coord": coord, "at": w, "replay_at": T0,
            "help": {"status": "resolved", "assignee": None, "task_id": "tsk_1",
                     "updated_at": w + timedelta(minutes=20)}})
        for action, minutes in (("help_assign", 4), ("help_resolve", 20)):
            col("live_decisions").insert_one({
                "incident_id": INCIDENT, "at": w + timedelta(minutes=minutes), "actor": "controller",
                "action": action, "report_ids": [], "checkin_id": "chk_1"})
        col("live_tasks").insert_one({
            "id": "tsk_1", "incident_id": INCIDENT, "kind": "assist", "target": {"segment_id": None, "coord": None},
            "status": "done", "created_at": w + timedelta(minutes=4),
            "accepted_at": w + timedelta(minutes=7), "closed_at": w + timedelta(minutes=19)})

    def test_requires_controller(self):
        self.assertEqual(self.client.get(BASE).status_code, 401)

    def test_empty_drill(self):
        r = self.get()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["kind"], "crisistwin_live_aar")
        self.assertEqual([t["action"] for t in body["timeline"]], ["drill_start"])
        self.assertTrue(all(z["guidance_changes"] == 0 for z in body["zones"]))
        self.assertEqual(body["help"]["requests"], 0)
        comps = {c["id"]: c for c in body["score"]["components"]}
        self.assertIsNone(comps["help_to_assign"]["score"])
        self.assertEqual(comps["arrived_share"]["evidence_class"], "simulated")
        self.assertEqual(comps["leave_now_vs_2018"]["evidence_class"], "historical")

    def test_seeded_metrics(self):
        self.seed()
        body = self.get().json()
        zones = {z["zone_id"]: z for z in body["zones"]}
        a, b = zones[ZONE_A], zones[ZONE_B]
        self.assertEqual(a["guidance_changes"], 2)
        self.assertEqual(a["first_leave_now_at"], "2018-11-08T14:40:00Z")
        self.assertEqual(a["historical_order_at"], "2018-11-08T14:55:00Z")
        self.assertEqual(a["leave_now_vs_2018_min"], -15.0)
        self.assertEqual(a["leave_now_status"], "earlier")
        self.assertEqual(b["leave_now_vs_2018_min"], 20.0)
        self.assertEqual(b["leave_now_status"], "later")
        self.assertEqual(a["reports"], 2)  # the historical_record entry is not a field report
        self.assertEqual(a["triage_median_min"], 3.0)  # 2 and 4 minutes
        self.assertEqual(a["help_to_assign_median_min"], 4.0)
        self.assertEqual(a["arrived_veh"], 120)
        self.assertEqual(body["triage"]["reports"], 2)
        self.assertEqual(body["help"]["to_assign_median_min"], 4.0)
        self.assertEqual(body["help"]["to_resolve_median_min"], 20.0)
        self.assertEqual(body["help"]["task_to_accept_median_min"], 3.0)
        self.assertEqual(body["help"]["task_accept_to_close_median_min"], 12.0)
        self.assertEqual(body["twin"]["totals"]["arrived_veh"], 7500)
        self.assertEqual(body["twin"]["evidence_class"], "simulated")
        self.assertEqual(body["score"]["coverage"], 1.0)
        self.assertGreater(body["score"]["value"], 0)
        actions = [t["action"] for t in body["timeline"]]
        self.assertEqual(actions.count("confirm"), 2)
        self.assertTrue(all(t["at"] and t["evidence_class"] == "observed" for t in body["timeline"]))

    def test_unordered_zone_past_2018_order_counts_as_missed(self):
        self.start_drill("2018-11-08T16:30:00Z")
        body = self.get().json()
        zones = {z["zone_id"]: z for z in body["zones"]}
        self.assertEqual(zones[ZONE_A]["leave_now_status"], "missed")
        comp = {c["id"]: c for c in body["score"]["components"]}["leave_now_vs_2018"]
        self.assertEqual(comp["score"], 0.0)
        self.assertGreater(comp["zones_missed"], 0)

    def test_twin_unavailable_drops_twin_components(self):
        r = self.get(exc=twin_service.TwinUnavailable("warming", "loading"))
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["twin"]["status"], "warming")
        comps = {c["id"]: c for c in body["score"]["components"]}
        self.assertIsNone(comps["arrived_share"]["score"])
        self.assertIsNone(comps["exposed_trapped"]["score"])
