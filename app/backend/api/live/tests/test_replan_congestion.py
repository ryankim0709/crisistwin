"""Replan with simulated congestion (ADR 0031-congestion-aware-planner): ``inputs.congestion``,
the planned-route memory used for hysteresis, and the free-flow fallback while the twin warms.

Same setup as test_live_api (a *_test MongoDB, frozen drill at 16:30Z); the twin is patched,
so no simulation runs here. The rule controller is used so only the planner is exercised.
"""

from __future__ import annotations

from unittest import mock

from django.test import override_settings

from api.live import controllers, twin_service
from api.live.common import col
from api.live.tests import test_live_api as base

BASE, CONTROLLER, INCIDENT = base.BASE, base.CONTROLLER, base.INCIDENT
TWIN_NOW = "2018-11-08T16:30:00Z"


def _ready(*_):
    return {"status": "ready", "error": None, "build_s": 1.0}


def _warming(*_):
    return {"status": "warming", "error": None, "build_s": None}


@override_settings(LIVE_CONTROLLER="rule")
class ReplanCongestionTest(base.LiveApiTest):
    def setUp(self):
        super().setUp()
        controllers._congestion.clear()
        self.addCleanup(controllers._congestion.clear)

    def replan(self):
        r = self.call("POST", f"{BASE}/replan", {}, CONTROLLER)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["proposal"]

    def test_warming_twin_plans_free_flow_and_says_so(self):
        with mock.patch.object(twin_service, "status", _warming):
            inputs = self.replan()["inputs"]
        self.assertEqual(inputs["congestion"], "unavailable")
        self.assertIsNone(inputs["congestion_evidence_class"])
        self.assertEqual(inputs["congested_edges"], 0)
        self.assertEqual(inputs["hysteresis"], {"min_gain_s": 120.0, "min_gain_fraction": 0.15,
                                                "min_dwell_s": 900.0})

    def test_twin_congestion_is_labelled_and_moves_a_zone(self):
        with mock.patch.object(twin_service, "status", _warming):
            free = self.replan()
        moving = [c for c in free["changes"] if c["to"]["route"]]
        self.assertTrue(moving)
        target = moving[0]
        # Jam every edge of one zone's free-flow route: 10 simulated vehicles at 0 kph (factor 10).
        stored = col(controllers.PLAN_ROUTES).find_one(
            {"incident_id": INCIDENT, "zone_id": target["zone_id"],
             "destination_id": target["to"]["destination"]["id"]})
        self.assertIsNotNone(stored, "the planned route's edges are remembered")
        jam = dict.fromkeys(stored["edge_ids"], (10, 0.0, 50.0))
        jam["not-a-drill-edge"] = (10, 0.0, 50.0)
        controllers._congestion.clear()
        with mock.patch.object(twin_service, "status", _ready), \
                mock.patch.object(twin_service, "edge_speeds_at", lambda snapshot: (TWIN_NOW, jam)):
            jammed = self.replan()
        inputs = jammed["inputs"]
        self.assertEqual(inputs["congestion"], f"twin@{TWIN_NOW}")
        self.assertEqual(inputs["congestion_evidence_class"], "simulated")
        self.assertEqual(inputs["congested_edges"], len(stored["edge_ids"]))
        after = {c["zone_id"]: c for c in jammed["changes"]}[target["zone_id"]]
        self.assertNotEqual(
            ((after["to"]["destination"] or {}).get("id"), after["to"]["route"]["via"]),
            (target["to"]["destination"]["id"], target["to"]["route"]["via"]),
            "a 10x jam on the whole route must change the zone's route",
        )

    def test_published_route_is_the_incumbent(self):
        with mock.patch.object(twin_service, "status", _warming):
            self.publish_initial_guidance()
            r = self.call("POST", f"{BASE}/replan", {}, CONTROLLER)
        # Same inputs, same plan: nothing to change against what was just published.
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["detail"], "no_changes")
        inputs = col("live_drills").find_one({"incident_id": INCIDENT})["plan_state"]["inputs"]
        self.assertGreater(inputs["incumbents"], 0)
        self.assertEqual(inputs["incumbents_with_edges"], inputs["incumbents"])


for _name in dir(base.LiveApiTest):
    if _name.startswith("test_"):
        setattr(ReplanCongestionTest, _name, None)  # run in test_live_api, not twice
