"""Smoke tests for the real-time twin (sim/twin.py, docs/twin-api.md) on the Camp inputs."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sim.twin import Twin  # noqa: E402

PACKAGE = ROOT / "data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65"
ROADS = ROOT / "data/incidents/camp-2018-evacuation/b1b318c16bbd3270"
START = "2018-11-08T15:30:00Z"
HORIZON_MIN = 30


def new_twin() -> Twin:
    return Twin.for_camp(package=str(PACKAGE), roads_package=str(ROADS), start_at=START)


class TwinSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = new_twin()

    def test_01_starts_at_requested_time(self):
        self.assertEqual(self.twin.now, START)

    def test_02_step_and_conservation(self):
        reply = self.twin.step_to("2018-11-08T15:40:00Z")
        self.assertEqual(reply["now"], "2018-11-08T15:40:00Z")
        snap = self.twin.snapshot(detail="summary")  # raises if population is not conserved
        t = snap["totals"]
        self.assertEqual(t["not_departed_veh"] + t["en_route_veh"] + t["arrived_veh"], t["total_veh"])
        self.assertEqual(snap["evidence_class"], "simulated")
        self.assertEqual(sum(z["vehicles"] for z in snap["zones"]), t["total_veh"])
        json.dumps(snap)

    def test_03_clock_cannot_go_backwards(self):
        with self.assertRaises(Exception) as ctx:
            self.twin.step_to("2018-11-08T15:00:00Z")
        self.assertIn("clock_backwards", str(getattr(ctx.exception, "code", ctx.exception)))

    def test_04_close_road_takes_effect_and_whatif_does_not_mutate(self):
        twin = new_twin()
        twin.step_to("2018-11-08T15:35:00Z")
        before = twin.snapshot(detail="full")
        action = {"type": "close_road", "target": {"corridor": "Skyway"}, "params": {"mode": "hard"}}
        result = twin.whatif([[action]], horizon_min=HORIZON_MIN)
        self.assertEqual(len(result["results"]), 2)  # baseline + one candidate
        self.assertTrue(result["results"][1].get("valid", True))
        after = twin.snapshot(detail="full")
        self.assertEqual(after["clock"]["now"], before["clock"]["now"])
        self.assertEqual(after["totals"], before["totals"])
        self.assertEqual(twin.action_log(), [])

        accepted = twin.apply(action)
        self.assertTrue(accepted["ok"])
        edges = accepted["action"]["resolved"]["edge_indexes"]
        self.assertTrue(edges)
        twin.step(n=3)
        closed = {row[0] for row in twin.snapshot(detail="full")["closed"]["rows"]}
        self.assertTrue(set(edges) & closed, "closed road edges should appear in snapshot.closed")
        self.assertEqual(len(twin.action_log()), 1)


if __name__ == "__main__":
    unittest.main()
