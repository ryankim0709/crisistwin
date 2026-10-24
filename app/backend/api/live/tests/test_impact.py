"""Impact analysis twin part (docs/live-reports.md "Impact analysis"): which what-if result is
"blocked" and which is "unblocked", without building the twin (``twin_service`` is patched)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase

from api.live import impact, twin_service

SEG = "osm-way:1:0"


def metrics(arrived):
    return {"arrived_in_window_veh": arrived, "total_exposed_veh_min": 0.0, "blocked_at_horizon_veh": 0,
            "trapped_by_fire_at_horizon_veh": 0, "remaining_at_horizon_veh": 1000 - arrived}


def report(baseline_arrived, alt_arrived, valid=True):
    return {"from": "2018-11-08T16:30:00Z", "until": "2018-11-08T17:30:00Z", "horizon_min": 60, "fire_ahead": "frozen",
            "seed": 7, "limitations": ["Single seed."],
            "results": [{"valid": True, "metrics": metrics(baseline_arrived)},
                        {"valid": valid, "metrics": metrics(alt_arrived) if valid else None,
                         "errors": [] if valid else [{"code": "not_closed"}]}]}


class ImpactTwinPartTest(SimpleTestCase):
    def setUp(self):
        self.snapshot = SimpleNamespace(index=SimpleNamespace(drill=SimpleNamespace(
            roads=SimpleNamespace(segment_edges={SEG: ("e1", "e2")}))))
        self.calls = []

    def run_part(self, closed_now, rep):
        def whatif(snapshot, sets, horizon, fire_ahead, labels):
            self.calls.append((sets, labels))
            return rep, {"z1": 40}

        with mock.patch.object(twin_service, "ensure_ready", lambda: True), \
                mock.patch.object(twin_service, "whatif_with_zones", whatif):
            return impact._twin_part(self.snapshot, SEG, closed_now, 60)

    def test_open_road_is_closed_in_the_what_if(self):
        twin, remaining, fallback = self.run_part(False, report(500, 450))
        self.assertIsNone(fallback)
        self.assertEqual(self.calls[0][0][0][0]["type"], "close_road")
        self.assertEqual(self.calls[0][0][0][0]["target"], {"edge_ids": ["e1", "e2"]})
        self.assertEqual(twin["unblocked"]["arrived_in_window_veh"], 500)  # baseline = as it is now (open)
        self.assertEqual(twin["blocked"]["arrived_in_window_veh"], 450)
        self.assertEqual(twin["delta"]["arrived_in_window_veh"], -50)
        self.assertEqual(remaining, {"z1": 40})

    def test_blocked_road_is_reopened_in_the_what_if(self):
        twin, _, fallback = self.run_part(True, report(450, 500))
        self.assertIsNone(fallback)
        self.assertEqual(self.calls[0][0][0][0]["type"], "reopen_road")
        self.assertEqual(twin["blocked"]["arrived_in_window_veh"], 450)  # baseline = as it is now (blocked)
        self.assertEqual(twin["unblocked"]["arrived_in_window_veh"], 500)
        self.assertEqual(twin["delta"]["arrived_in_window_veh"], -50)

    def test_rejected_what_if_is_a_labeled_fallback(self):
        twin, remaining, fallback = self.run_part(True, report(450, 0, valid=False))
        self.assertIsNone(twin)
        self.assertEqual(fallback, "twin_error:not_closed")
        self.assertEqual(remaining, {"z1": 40})

    def test_warming_twin(self):
        with mock.patch.object(twin_service, "ensure_ready", lambda: False):
            self.assertEqual(impact._twin_part(self.snapshot, SEG, False, 60), (None, None, "twin_warming"))
