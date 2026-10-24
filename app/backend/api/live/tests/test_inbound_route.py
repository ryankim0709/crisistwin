"""``livecore.inbound.inbound_route`` on a small synthetic grid: blocked segments, the fire
estimate, congestion factors and the unreachable reasons. Pure functions; no database.
"""

from __future__ import annotations

from datetime import UTC, datetime

from django.test import SimpleTestCase

from livecore.drill import Drill, _road_graph
from livecore.geo import haversine_m
from livecore.inbound import CONGESTION_MAX_FACTOR, congestion_factor, inbound_route
from livecore.routing import edge_travel_time_s

LON0, LAT0, STEP = -121.60, 39.75, 0.005
"""Grid of 5 x 3 nodes, STEP degrees apart (about 430 m east-west, 555 m north-south)."""
COLS, ROWS = 5, 3
SPEED_KPH = 36.0


def node(i: int, j: int) -> str:
    return f"n{i}-{j}"


def coord(i: int, j: int) -> tuple[float, float]:
    return (LON0 + i * STEP, LAT0 + j * STEP)


def seg(a: tuple[int, int], b: tuple[int, int]) -> str:
    return "s:" + "|".join(sorted((node(*a), node(*b))))


def grid_drill() -> Drill:
    raw = []
    for i in range(COLS):
        for j in range(ROWS):
            for di, dj in ((1, 0), (0, 1)):
                a, b = (i, j), (i + di, j + dj)
                if b[0] >= COLS or b[1] >= ROWS:
                    continue
                for x, y in ((a, b), (b, a)):
                    raw.append({
                        "id": f"{node(*x)}>{node(*y)}", "segment_id": seg(a, b),
                        "from_node": node(*x), "to_node": node(*y), "name": f"Road {seg(a, b)}",
                        "speed_kph": SPEED_KPH, "length_m": haversine_m(coord(*x), coord(*y)),
                        "coords": [list(coord(*x)), list(coord(*y))],
                    })
    t = datetime(2018, 11, 8, 14, tzinfo=UTC)
    return Drill(
        incident_id="grid", label="test grid", clock_start=t, clock_end=t.replace(hour=20), zones=(),
        zones_version="zones-test", destinations=(), roads=_road_graph(raw), perimeters=(), fronts=(),
        observations=(), fire_model="none",
    )


def square(center: tuple[float, float], half_deg: float):
    x, y = center
    ring = ((x - half_deg, y - half_deg), (x + half_deg, y - half_deg), (x + half_deg, y + half_deg),
            (x - half_deg, y + half_deg), (x - half_deg, y - half_deg))
    return ((ring,),)


def edge(a: tuple[int, int], b: tuple[int, int]) -> str:
    return f"{node(*a)}>{node(*b)}"


BOTTOM_EAST = [edge((i, 0), (i + 1, 0)) for i in range(COLS - 1)]
BOTTOM_WEST = [edge((i + 1, 0), (i, 0)) for i in range(COLS - 1)]


class InboundRouteTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.drill = grid_drill()
        # 20 m off the network on both ends: snapping is to the nearest node.
        cls.origin = (coord(0, 0)[0] - 0.0002, coord(0, 0)[1])
        cls.target = (coord(4, 0)[0] + 0.0002, coord(4, 0)[1])

    def route(self, blocked=(), fire=None, congestion=None, origin=None, target=None):
        return inbound_route(self.drill, origin or self.origin, target or self.target, frozenset(blocked), fire,
                             congestion)

    def test_straight_route_snaps_both_ends(self):
        r = self.route()
        self.assertIsNone(r.reason)
        self.assertEqual(list(r.route.edge_ids), BOTTOM_EAST)
        self.assertEqual(r.route.line[0], coord(0, 0))
        self.assertEqual(r.route.line[-1], coord(4, 0))
        self.assertEqual(r.route.destination_id, node(4, 0))
        self.assertEqual(r.route.exposure, "clear")
        self.assertAlmostEqual(r.origin_snap_m, 17.1, delta=1.0)
        free_flow = sum(edge_travel_time_s(self.drill.roads.edges[e]) for e in BOTTOM_EAST)
        self.assertAlmostEqual(r.travel_time_s, free_flow)
        self.assertAlmostEqual(r.route.travel_time_s, free_flow)
        self.assertEqual(r.route.eta_min, 3)  # 4 x 428 m at 10 m/s = 171 s

    def test_never_uses_a_blocked_segment(self):
        blocked = {seg((2, 0), (3, 0))}
        r = self.route(blocked)
        self.assertIsNone(r.reason)
        self.assertFalse(blocked & set(r.route.segment_ids))
        self.assertGreater(r.route.distance_m, self.route().route.distance_m)

    def test_cut_network_is_unreachable(self):
        blocked = {seg((1, j), (2, j)) for j in range(ROWS)}
        r = self.route(blocked)
        self.assertIsNone(r.route)
        self.assertEqual(r.reason, "no_open_road")
        self.assertIsNone(r.travel_time_s)

    def test_fire_edges_are_impassable(self):
        fire = square(coord(2, 0), 0.0005)
        r = self.route(fire=fire)
        self.assertIsNone(r.reason)
        self.assertNotIn(node(2, 0), {self.drill.roads.edges[e].to_node for e in r.route.edge_ids})
        self.assertNotEqual(r.route.exposure, "through_fire")
        self.assertEqual(r.route.fire_time_s, 0.0)

    def test_near_fire_edges_cost_more_and_are_labelled(self):
        # A fire between rows 0 and 1 at the middle column: both rows' middle edges are within
        # FIRE_BUFFER_M (x5 cost), so the clear detour over row 2 (394 s) beats row 0 (516 s).
        fire = square((coord(2, 0)[0], coord(2, 0)[1] + 0.0025), 0.0005)
        r = self.route(fire=fire)
        self.assertIsNone(r.reason)
        self.assertEqual(r.route.exposure, "clear")
        self.assertIn(node(2, 2), {self.drill.roads.edges[e].to_node for e in r.route.edge_ids})
        # With row 2 cut, the route has to pass the buffer and is labelled near_fire.
        r = self.route(fire=fire, blocked={seg((1, 2), (2, 2))})
        self.assertEqual(r.route.exposure, "near_fire")
        self.assertEqual(r.route.fire_time_s, 0.0)
        self.assertGreater(r.route.near_fire_time_s, 0.0)

    def test_target_inside_fire(self):
        fire = square(coord(4, 0), 0.0005)
        self.assertEqual(self.route(fire=fire).reason, "target_in_fire")

    def test_origin_inside_fire(self):
        fire = square(coord(0, 0), 0.0005)
        self.assertEqual(self.route(fire=fire).reason, "origin_in_fire")

    def test_congestion_detours_and_scales_drive_time(self):
        jam = {e: CONGESTION_MAX_FACTOR for e in BOTTOM_EAST}
        r = self.route(congestion=jam)
        self.assertIsNone(r.reason)
        self.assertFalse(set(BOTTOM_EAST) & set(r.route.edge_ids))
        self.assertEqual(r.congested_edges, 0)
        self.assertAlmostEqual(r.travel_time_s, r.route.travel_time_s)

    def test_congestion_is_directional(self):
        # Outbound (westbound) traffic does not slow the eastbound responder.
        r = self.route(congestion={e: CONGESTION_MAX_FACTOR for e in BOTTOM_WEST})
        self.assertEqual(list(r.route.edge_ids), BOTTOM_EAST)

    def test_mild_congestion_is_driven_through_with_a_longer_eta(self):
        jam = {BOTTOM_EAST[1]: 1.5}
        r = self.route(congestion=jam)
        self.assertEqual(list(r.route.edge_ids), BOTTOM_EAST)
        self.assertEqual(r.congested_edges, 1)
        extra = 0.5 * edge_travel_time_s(self.drill.roads.edges[BOTTOM_EAST[1]])
        self.assertAlmostEqual(r.travel_time_s, r.route.travel_time_s + extra)

    def test_off_network_ends(self):
        self.assertEqual(self.route(origin=(-71.4, 41.8)).reason, "origin_off_network")
        self.assertEqual(self.route(target=(-71.4, 41.8)).reason, "target_off_network")

    def test_same_node_is_a_zero_length_route(self):
        r = self.route(target=self.origin)
        self.assertIsNone(r.reason)
        self.assertEqual(r.route.edge_ids, ())
        self.assertEqual(r.route.distance_m, 0.0)

    def test_invalid_congestion_factor_raises(self):
        with self.assertRaises(ValueError):
            self.route(congestion={BOTTOM_EAST[0]: 0.5})

    def test_congestion_factor_formula(self):
        self.assertEqual(congestion_factor(60.0, 60.0), 1.0)
        self.assertEqual(congestion_factor(80.0, 60.0), 1.0)
        self.assertEqual(congestion_factor(15.0, 60.0), 4.0)
        self.assertEqual(congestion_factor(0.0, 60.0), CONGESTION_MAX_FACTOR)
        self.assertEqual(congestion_factor(1.0, 60.0), CONGESTION_MAX_FACTOR)
