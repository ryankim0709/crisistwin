"""ADR 0041 pure maths: information priority (livecore.priority) and passive evidence weighting
(livecore.public). No database, no bundle."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from django.test import SimpleTestCase

from livecore import priority as pr
from livecore.drill import FireSnapshot, Zone
from livecore.public import (
    PASSIVE_PARTY_WEIGHT,
    PUBLIC_MIN_CIVILIAN_PARTIES,
    ReportFact,
    party_counts,
    public_items,
    road_state,
)

WALL = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
LINE = ((-121.600, 39.760), (-121.590, 39.760))  # about 855 m east-west
SEG = "seg-a"


def square(lon: float, lat: float, half_deg: float):
    ring = ((lon - half_deg, lat - half_deg), (lon + half_deg, lat - half_deg), (lon + half_deg, lat + half_deg),
            (lon - half_deg, lat + half_deg), (lon - half_deg, lat - half_deg))
    return ((ring,),)


class FactorTest(SimpleTestCase):
    def test_impact_is_saturating_in_vehicles(self):
        self.assertEqual(pr.impact_from_vehicles(0), 0.0)
        self.assertAlmostEqual(pr.impact_from_vehicles(pr.IMPACT_SCALE_VEH), 1 - math.exp(-1))
        self.assertLess(pr.impact_from_vehicles(500), pr.impact_from_vehicles(1500))
        self.assertLess(pr.impact_from_vehicles(1e9), 1.0 + 1e-12)

    def test_p_change_from_half_life_and_fire_distance(self):
        hl = 7200.0
        base = 1 - 0.5 ** (pr.PRIORITY_HORIZON_S / hl)
        self.assertAlmostEqual(pr.p_change(hl, None), base)
        self.assertAlmostEqual(pr.p_change(hl, math.inf), base)
        self.assertAlmostEqual(pr.p_change(hl, 0.0), 1.0)
        near, far = pr.p_change(hl, 500), pr.p_change(hl, 5000)
        self.assertGreater(near, far)
        self.assertAlmostEqual(far, 1 - (1 - base) * (1 - math.exp(-5000 / pr.FIRE_DECAY_M)))
        # a shorter half-life changes more readily
        self.assertGreater(pr.p_change(900, None), pr.p_change(7200, None))

    def test_staleness_from_last_independent_observation(self):
        self.assertEqual(pr.staleness(3600, None, WALL), 1.0)
        self.assertAlmostEqual(pr.staleness(3600, WALL, WALL), 0.0)
        self.assertAlmostEqual(pr.staleness(3600, WALL - timedelta(hours=1), WALL), 0.5)
        self.assertAlmostEqual(pr.staleness(3600, WALL - timedelta(hours=2), WALL), 0.75)


class SegmentPriorityTest(SimpleTestCase):
    def segments(self):
        return {SEG: pr.SegmentInfo(LINE, "Pentz Road", 855.0),
                "seg-short": pr.SegmentInfo(((-121.6, 39.77), (-121.5995, 39.77)), "Stub", 40.0)}

    def test_vehicles_weighted_by_lost_routes(self):
        # Zone a has an alternative that avoids the segment (it would lengthen); zone b's only
        # alternative runs along it (it would lose its way out): b counts LOSE_ROUTE_WEIGHT times.
        avoid = ((-121.600, 39.770), (-121.590, 39.770))  # 1.1 km north
        along = ((-121.601, 39.760), (-121.589, 39.760))
        routes = [pr.RouteUse("a", 100, frozenset({SEG, "seg-short"}), (avoid,)),
                  pr.RouteUse("b", 200, frozenset({SEG}), (along,))]
        [item] = pr.segment_items(routes, self.segments(), {}, None, WALL)  # the 40 m stub is not a candidate
        self.assertEqual(item.kind, "segment")
        self.assertEqual(item.vehicles, 100 + pr.LOSE_ROUTE_WEIGHT * 200)
        self.assertEqual((item.zones, item.zones_losing_route), (2, 1))
        self.assertEqual(item.staleness, 1.0)
        self.assertAlmostEqual(item.priority, round(item.impact * item.p_change * item.staleness, 4), places=3)
        self.assertIsNone(item.fire_distance_m)

    def test_recent_observation_and_fire_change_the_order(self):
        routes = [pr.RouteUse("a", 500, frozenset({SEG}), ())]
        fresh = pr.segment_items(routes, self.segments(), {SEG: WALL - timedelta(minutes=5)}, None, WALL)[0]
        stale = pr.segment_items(routes, self.segments(), {}, None, WALL)[0]
        self.assertLess(fresh.priority, stale.priority)
        fire = square(-121.595, 39.790, 0.01)  # about 2.2 km north of the segment
        near = pr.segment_items(routes, self.segments(), {}, fire, WALL)[0]
        self.assertGreater(near.p_change, stale.p_change)
        self.assertTrue(1500 < near.fire_distance_m < 2600, near.fire_distance_m)

    def test_segment_on_line(self):
        self.assertTrue(pr.segment_on_line(LINE, ((-121.61, 39.7601), (-121.58, 39.7601))))
        self.assertFalse(pr.segment_on_line(LINE, ((-121.61, 39.761), (-121.58, 39.761))))  # ~110 m away


class DestinationAndGatewayTest(SimpleTestCase):
    def test_destination_near_capacity_ranks_above_empty(self):
        dests = [pr.DestinationInfo("d1", "Full-ish", (-121.8, 39.7), 1000.0),
                 pr.DestinationInfo("d2", "Quiet", (-121.9, 39.7), 1000.0),
                 pr.DestinationInfo("d3", "Unknown", (-121.9, 39.8), None)]
        items = pr.rank(pr.destination_items(dests, {"d1": 900, "d2": 100, "d3": 5000}, {}, None, WALL))
        self.assertEqual([i.destination_id for i in items], ["d1", "d2"])  # unknown capacity is skipped
        self.assertEqual(items[0].load, 0.9)
        self.assertEqual(items[0].vehicles, 810.0)

    def fronts(self, areas_deg):
        t0 = datetime(2018, 11, 8, 15, 0, tzinfo=UTC)
        return tuple(FireSnapshot(t0 + timedelta(minutes=10 * i), square(-121.5, 39.8, h), "front", "simulated")
                     for i, h in enumerate(areas_deg))

    def test_spread_ratio_from_model_fronts(self):
        # half-widths grow 0.01 -> 0.02 -> 0.04 deg every 30 min: the area growth accelerates.
        fronts = self.fronts([0.01, 0.0133, 0.0166, 0.02, 0.0266, 0.0333, 0.04])
        now = fronts[3].at
        current, ahead, ratio = pr.spread_ratio(fronts, now)
        self.assertEqual(current, fronts[3])
        self.assertEqual(ahead, fronts[6])
        self.assertAlmostEqual(ratio, min(pr.GATEWAY_MAX_SPREAD_RATIO, (16 - 4) / (4 - 1)), places=1)
        _, none_ahead, one = pr.spread_ratio(fronts, fronts[-1].at)
        self.assertIsNone(none_ahead)
        self.assertEqual(one, 1.0)

    def test_gateway_is_a_zone_the_model_reaches_within_the_horizon(self):
        fronts = self.fronts([0.01, 0.0133, 0.0166, 0.02, 0.0266, 0.0333, 0.04])
        now = fronts[3].at
        reached = Zone("z-reached", "Reached", 800, 1200, square(-121.5 + 0.035, 39.8, 0.01))
        far = Zone("z-far", "Far", 800, 1200, square(-121.3, 39.8, 0.01))
        burning = Zone("z-burning", "Burning", 800, 1200, square(-121.5, 39.8, 0.005))
        empty = Zone("z-empty", "Empty", 0, 0, square(-121.5 + 0.035, 39.8, 0.01))
        items = pr.gateway_items([reached, far, burning, empty], fronts, fronts[3].geometry, now, [], WALL)
        self.assertEqual([i.zone_id for i in items], ["z-reached"])
        g = items[0]
        self.assertEqual(g.kind, "gateway")
        self.assertGreater(g.spread_ratio, 1.0)
        self.assertEqual(g.vehicles, round(1200 * g.spread_ratio, 1))
        self.assertGreater(g.fire_distance_m, 0)
        seen = pr.gateway_items([reached], fronts, fronts[3].geometry, now, [(g.coord, WALL)], WALL)[0]
        self.assertEqual(seen.staleness, 0.0)

    def test_select_diverse_spaces_places(self):
        def item(i, lon):
            return pr.PriorityItem(f"seg:{i}", "segment", str(i), (lon, 39.76), None, str(i), None, None,
                                   1.0 - i / 10, 1, 1, 1, 1, 1, 0, None, None, None, None, 7200, None, "")
        items = [item(0, -121.600), item(1, -121.599), item(2, -121.570), item(3, -121.540)]
        chosen = pr.select_diverse(items, 1500, 3)
        self.assertEqual([c.id for c in chosen], ["seg:0", "seg:2", "seg:3"])
        self.assertEqual([c.id for c in pr.select_diverse(items, 1500, 3, taken=[(-121.57, 39.76)])],
                         ["seg:0", "seg:3"])


def fact(n, party, kind="road_passable", method="explicit", received_s=0, role="civilian", lon=-121.6):
    received = WALL - timedelta(minutes=30) + timedelta(seconds=received_s)
    return ReportFact(
        id=f"r{n:03d}", kind=kind, severity="full" if kind == "road_blocked" else None, coord=(lon, 39.76),
        party_key=party, role=role, observed_at=received, received_at=received, status="unverified",
        segment_id=SEG, segment_name="Pentz Road", destination_id=None, replay_at=None, method=method,
    )


class PassiveEvidenceTest(SimpleTestCase):
    """Parties far apart in time so same_party never folds them; only party keys separate them."""

    def test_passive_parties_count_less(self):
        passive = [fact(i, f"p{i}", method="passive", received_s=300 * i) for i in range(3)]
        weighted, resp, civ, only_passive = party_counts(passive)
        self.assertEqual((civ, only_passive, resp), (3, 3, 0))
        self.assertAlmostEqual(weighted, 3 * PASSIVE_PARTY_WEIGHT)
        self.assertLess(weighted, PUBLIC_MIN_CIVILIAN_PARTIES)
        self.assertEqual(public_items(passive, WALL, {SEG: LINE}), [])

    def test_passive_corroborates_explicit_passable(self):
        reports = [fact(0, "e0", received_s=0), fact(1, "e1", received_s=300),
                   fact(2, "p2", method="passive", received_s=600), fact(3, "p3", method="passive", received_s=900)]
        [item] = public_items(reports, WALL, {SEG: LINE})
        self.assertEqual((item.independent_parties, item.passive_parties), (4, 2))
        self.assertEqual(public_items(reports[:3], WALL, {SEG: LINE}), [])  # 2 + 0.5 < 3

    def test_passive_never_opens_a_block_alone(self):
        block = [fact(0, "b0", kind="road_blocked", received_s=0)]
        passive = [fact(i, f"p{i}", method="passive", received_s=300 * i) for i in range(1, 6)]
        [state] = road_state(block + passive, WALL)
        self.assertEqual(state.status, "blocked")
        explicit = [fact(9, "e9", received_s=2000)]
        [opened] = road_state(block + passive + explicit, WALL)
        self.assertEqual(opened.status, "open")

    def test_passive_alone_supports_passable_and_slow_states(self):
        [open_state] = road_state([fact(0, "p0", method="passive")], WALL)
        self.assertEqual((open_state.status, open_state.passive_parties), ("open", 1))
        slow = [fact(0, "p0", method="passive"), fact(1, "p1", kind="heavy_traffic", method="passive", received_s=60)]
        [slow_state] = road_state(slow, WALL)
        self.assertEqual(slow_state.status, "slow")

    def test_responder_passive_is_not_a_responder_report(self):
        reports = [fact(0, "rsp_1", method="passive", role="responder"), fact(1, "c1", received_s=600)]
        weighted, resp, _, _ = party_counts(reports)
        self.assertEqual((weighted, resp), (1.0, 0))
        self.assertEqual(public_items(reports, WALL, {SEG: LINE}), [])
