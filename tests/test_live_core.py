"""Smoke tests for the pure live logic (app/backend/livecore), against docs/live-reports.md v2."""

from __future__ import annotations

import sys
import unittest
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "backend"))

from livecore import estimate_fire, plan, load_drill  # noqa: E402
from livecore.drill import parse_time  # noqa: E402
from livecore.planner import BE_READY_KM, EVACUATE_NOW_KM  # noqa: E402
from livecore.policy import AUTO_APPROVE_CAUSES, diff, is_auto_approvable, summarize  # noqa: E402
from livecore.public import (  # noqa: E402
    PUBLIC_MIN_CIVILIAN_PARTIES,
    ReportFact,
    independent_counts,
    public_items,
    same_party,
)

BUNDLE = ROOT / "app" / "public" / "replays" / "camp-2018.json"
LINES = {"seg": [(-121.601, 39.76), (-121.599, 39.76)]}
T0 = parse_time("2018-11-08T16:30:00Z")


def fact(i, party, role="civilian", lon=-121.60, lat=39.76, at_s=0, status="unverified"):
    t = T0 + timedelta(seconds=at_s)
    return ReportFact(id=f"r{i}", kind="road_blocked", severity="full", coord=(lon, lat), party_key=party,
                      role=role, observed_at=t, received_at=t, status=status, segment_id="seg", segment_name="X",
                      destination_id=None, replay_at=None)


class DrillPlanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.drill = load_drill(BUNDLE)
        cls.fire = estimate_fire(cls.drill, T0)
        cls.base = plan(cls.drill, T0, cls.fire, [])

    def test_bundle_loads(self):
        self.assertEqual(len(self.drill.zones), 43)
        self.assertEqual(self.fire.method, "model_nowcast")
        self.assertIsNotNone(self.fire.geometry)

    def test_no_fire_before_ignition_means_no_guidance(self):
        early = estimate_fire(self.drill, self.drill.clock_start)
        if early.geometry is None:
            self.assertTrue(all(g.level == "none" for g in plan(self.drill, self.drill.clock_start, early, [])))

    def test_levels_follow_distance_thresholds(self):
        levels = {g.level for g in self.base}
        self.assertIn("evacuate_now", levels)
        for g in self.base:
            d = g.fire_distance_km
            if d is None:
                continue
            want = "evacuate_now" if d <= EVACUATE_NOW_KM else "be_ready" if d <= BE_READY_KM else "none"
            self.assertEqual(g.level, want, g.zone_id)

    def test_routes_exist_with_eta_and_via(self):
        moving = [g for g in self.base if g.level != "none"]
        self.assertTrue(moving)
        routed = [g for g in moving if g.route]
        self.assertTrue(routed)
        long = [g for g in routed if g.route.edge_ids]
        self.assertGreater(len(long), len(routed) // 2)
        for g in long:
            self.assertGreaterEqual(g.route.eta_min, 1)
            self.assertTrue(g.route.via)
            self.assertFalse(g.no_route)

    def test_routes_avoid_blocked_segments(self):
        g0 = next(g for g in self.base if g.level == "evacuate_now" and g.route)
        blocked = set(g0.route.segment_ids[:2])
        again = plan(self.drill, T0, self.fire, blocked)
        for g in again:
            if g.route:
                self.assertFalse(blocked & set(g.route.segment_ids), g.zone_id)

    def test_unreachable_is_explicit(self):
        everything = {e.segment_id for e in self.drill.roads.edges.values()}
        out = plan(self.drill, T0, self.fire, everything)
        stuck = [g for g in out if g.level != "none"]
        self.assertTrue(stuck)
        no_route = [g for g in stuck if g.no_route]
        self.assertTrue(no_route)
        for g in no_route:
            self.assertIsNone(g.route)
            self.assertIsNone(g.destination_id)
        for g in stuck:  # a zone already at its destination may keep a zero-length route; never a road
            if not g.no_route:
                self.assertEqual(g.route.edge_ids, ())


class PublicRulesTest(unittest.TestCase):
    def test_same_key_is_same_party(self):
        self.assertTrue(same_party(fact(1, "a"), fact(2, "a", at_s=3600, lon=-121.5)))

    def test_nearby_simultaneous_reports_are_one_party(self):
        self.assertTrue(same_party(fact(1, "a"), fact(2, "b", at_s=30)))
        self.assertEqual(independent_counts([fact(1, "a"), fact(2, "b", at_s=30)])[0], 1)

    def test_three_independent_parties_are_public(self):
        reports = [fact(i, f"p{i}", at_s=i * 600) for i in range(3)]
        self.assertEqual(independent_counts(reports), (PUBLIC_MIN_CIVILIAN_PARTIES, 0))
        self.assertEqual(len(public_items(reports, T0 + timedelta(minutes=30), LINES)), 1)

    def test_two_civilians_alone_are_not_public_but_confirm_is(self):
        reports = [fact(i, f"p{i}", at_s=i * 600) for i in range(2)]
        now = T0 + timedelta(minutes=30)
        self.assertEqual(public_items(reports, now, LINES), [])
        confirmed = [fact(0, "p0", status="confirmed")]
        self.assertEqual(len(public_items(confirmed, now, LINES)), 1)

    def test_responder_plus_independent_civilian_is_public(self):
        reports = [fact(1, "c", at_s=0), fact(2, "rsp", role="responder", at_s=900)]
        self.assertEqual(independent_counts(reports), (1, 1))
        self.assertEqual(len(public_items(reports, T0 + timedelta(minutes=30), LINES)), 1)

    def test_help_needed_is_never_public(self):
        reports = [replace(fact(i, f"p{i}", at_s=i * 600, status="confirmed"), kind="help_needed", segment_id=None)
                   for i in range(4)]
        self.assertEqual(public_items(reports, T0 + timedelta(minutes=30), LINES), [])


class PolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        drill = load_drill(BUNDLE)
        fire = estimate_fire(drill, T0)
        cls.base = plan(drill, T0, fire, [])
        cls.published = {g.zone_id: summarize(g) for g in cls.base}
        # Block the start of an evacuating zone's route that still has an alternate, so the
        # diff is pure reroutes; a block that strands a zone is a ``route_lost`` change instead.
        for g0 in (g for g in cls.base if g.level == "evacuate_now" and g.route):
            blocked = set(g0.route.segment_ids[:2])
            rerouted = plan(drill, T0, fire, blocked)
            changes = diff(cls.published, rerouted)
            if changes and all(c.kind == "reroute" for c in changes):
                break
            if any(c.kind == "route_lost" for c in changes):
                cls.stranded = changes
        cls.blocked, cls.rerouted = blocked, rerouted

    def test_first_plan_is_new_not_auto(self):
        changes = diff({}, self.base)
        self.assertTrue(changes)
        self.assertTrue(all(c.kind == "new" for c in changes))
        self.assertFalse(is_auto_approvable(changes, ["road_block"]))

    def test_unchanged_plan_has_no_changes(self):
        self.assertEqual(diff(self.published, self.base), [])

    def test_block_reroute_auto_approves_but_manual_never(self):
        changes = diff(self.published, self.rerouted)
        self.assertTrue(changes)
        self.assertTrue(all(c.kind == "reroute" for c in changes))
        self.assertTrue(is_auto_approvable(changes, ["road_block"]))
        self.assertTrue(is_auto_approvable(changes, ["fire", "road_block"]))
        self.assertFalse(is_auto_approvable(changes, ["manual"]))
        self.assertNotIn("manual", AUTO_APPROVE_CAUSES)

    def test_route_lost_never_auto_approves(self):
        stranded = getattr(self, "stranded", None)
        if not stranded:
            self.skipTest("no block in this bundle strands a zone")
        self.assertFalse(is_auto_approvable(stranded, ["road_block"]))


if __name__ == "__main__":
    unittest.main()
