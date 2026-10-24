"""Planner inputs that must be trustworthy: report independence by server time, routes that
stay out of the fire estimate, and real (non-zero) routes. Pure functions plus the drill bundle;
no database.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.test import SimpleTestCase

from api.live.drillcache import get_index
from livecore.fire import estimate_fire
from livecore.geo import point_in_multipolygon
from livecore.planner import plan
from livecore.public import ReportFact, independent_counts, public_items, road_state
from livecore.routing import MIN_ROUTE_M

WALL = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
POINT = (-121.57248, 39.73925)
SEGMENT = "seg-test"


def fact(n: int, party: str, received_s: float, observed_shift_s: float = 0, kind: str = "road_blocked",
         role: str = "civilian", status: str = "unverified") -> ReportFact:
    """A report received ``received_s`` after WALL - 1 h whose client clock is shifted by ``observed_shift_s``."""
    received = WALL - timedelta(hours=1) + timedelta(seconds=received_s)
    return ReportFact(
        id=f"r{n:03d}", kind=kind, severity=None if kind == "road_passable" else "full", coord=POINT,
        party_key=party, role=role, observed_at=received + timedelta(seconds=observed_shift_s),  # type: ignore[arg-type]
        received_at=received, status=status, segment_id=SEGMENT, segment_name="Test Road",  # type: ignore[arg-type]
        destination_id=None, replay_at=None,
    )


def blocked_state(reports: list[ReportFact]):
    return next(s for s in road_state(reports, WALL) if s.segment_id == SEGMENT)


class ReportIndependenceTest(SimpleTestCase):
    def test_backdated_tokens_from_one_person_are_one_party(self):
        reports = [fact(i, f"p{i}", received_s=5 * i, observed_shift_s=-130 * i) for i in range(3)]
        self.assertEqual(independent_counts(reports), (1, 0))
        state = blocked_state(reports)
        self.assertEqual(state.status, "blocked")
        self.assertFalse(state.public)
        self.assertEqual(public_items(reports, WALL, {}), [])

    def test_steady_crowd_is_not_chained_into_one_party(self):
        reports = [fact(i, f"p{i}", received_s=100 * i) for i in range(10)]
        civ, _ = independent_counts(reports)
        self.assertGreaterEqual(civ, 4)

    def test_future_dated_passable_does_not_reopen_a_public_block(self):
        block = [fact(i, f"p{i}", received_s=300 * i) for i in range(3)]
        self.assertTrue(blocked_state(block).public)
        liar = fact(9, "liar", received_s=1200, observed_shift_s=6 * 3600, kind="road_passable")
        state = blocked_state([*block, liar])
        self.assertEqual(state.status, "blocked")
        self.assertTrue(state.public)
        self.assertTrue(any(i.kind == "road_blocked" for i in public_items([*block, liar], WALL, {})))

    def test_equally_strong_newer_passable_reopens(self):
        block = [fact(i, f"p{i}", received_s=300 * i) for i in range(3)]
        passable = [fact(10 + i, f"q{i}", received_s=1200 + 300 * i, kind="road_passable") for i in range(3)]
        self.assertEqual(blocked_state([*block, *passable]).status, "open")


class RouteSafetyTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.drill = get_index().drill

    def guidance(self, hhmm: str):
        now = datetime.fromisoformat(f"2018-11-08T{hhmm}:00+00:00")
        fire = estimate_fire(self.drill, now)
        self.assertIsNotNone(fire.geometry)
        return fire, plan(self.drill, now, fire, ())

    def test_normal_routes_never_enter_the_fire(self):
        for hhmm in ("16:00", "16:30"):
            fire, guidance = self.guidance(hhmm)
            for g in guidance:
                if g.route is None or g.exposed:
                    continue
                inside = [p for p in g.route.line if point_in_multipolygon(p, fire.geometry)]
                self.assertEqual(inside, [], f"{hhmm} {g.zone_id}")
            for g in guidance:
                if g.exposed:
                    self.assertIn("Least-exposure route", g.reason)

    def test_no_zero_length_routes(self):
        _, guidance = self.guidance("16:30")
        for g in guidance:
            if g.route is not None:
                self.assertGreaterEqual(g.route.distance_m, MIN_ROUTE_M, g.zone_id)
                self.assertGreater(g.route.eta_min, 0, g.zone_id)
                self.assertNotEqual(g.route.distance_m, 0, g.zone_id)
