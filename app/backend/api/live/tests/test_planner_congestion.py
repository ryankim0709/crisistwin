"""Congestion-aware planning and hysteresis (ADR 0031-congestion-aware-planner) on a synthetic
grid: ``livecore.planner.plan`` / ``livecore.routing.best_routes`` with simulated congestion
factors and incumbent routes. Pure functions; no database.

Grid: 7 x 2 nodes, STEP_DEG apart. Row 0 at LAT0, row 1 STEP_DEG north. One zone around node
(2, 0); exit west at (0, 0) and exit east at (6, 0). All edges 36 kph (10 m/s).
"""

from __future__ import annotations

from datetime import UTC, datetime

from django.test import SimpleTestCase

from livecore.drill import Destination, Drill, Zone, _road_graph
from livecore.fire import FireEstimate
from livecore.geo import haversine_m
from livecore.inbound import CONGESTION_MIN_VEH, congestion_factors
from livecore.planner import plan, route_safety
from livecore.routing import (
    SWITCH_MIN_DWELL_S,
    SWITCH_MIN_GAIN_FRACTION,
    SWITCH_MIN_GAIN_S,
    Incumbent,
    best_routes,
    edge_travel_time_s,
    switch_margin_s,
)

LON0, LAT0, STEP_DEG = -121.60, 39.75, 0.02
COLS, ROWS = 7, 2
SPEED_KPH = 36.0
ZONE = "zone:a"
WEST, EAST = "exit:west", "exit:east"
NOW = datetime(2018, 11, 8, 16, tzinfo=UTC)


def node(i: int, j: int) -> str:
    return f"n{i}-{j}"


def coord(i: int, j: int) -> tuple[float, float]:
    return (LON0 + i * STEP_DEG, LAT0 + j * STEP_DEG)


def seg(a: tuple[int, int], b: tuple[int, int]) -> str:
    return "s:" + "|".join(sorted((node(*a), node(*b))))


def edge(a: tuple[int, int], b: tuple[int, int]) -> str:
    return f"{node(*a)}>{node(*b)}"


def square(center: tuple[float, float], half_deg: float):
    x, y = center
    ring = ((x - half_deg, y - half_deg), (x + half_deg, y - half_deg), (x + half_deg, y + half_deg),
            (x - half_deg, y + half_deg), (x - half_deg, y - half_deg))
    return ((ring,),)


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
                        "id": edge(x, y), "segment_id": seg(a, b), "from_node": node(*x), "to_node": node(*y),
                        "name": f"Road {seg(a, b)}", "speed_kph": SPEED_KPH,
                        "length_m": haversine_m(coord(*x), coord(*y)), "coords": [list(coord(*x)), list(coord(*y))],
                    })
    zone = Zone(ZONE, "Zone A", 100, 150, square(coord(2, 0), 0.002))
    dests = (
        Destination(WEST, "Exit west", "exit", coord(0, 0), None),
        Destination(EAST, "Exit east", "exit", coord(6, 0), None),
    )
    return Drill(
        incident_id="grid", label="test grid", clock_start=NOW, clock_end=NOW.replace(hour=20), zones=(zone,),
        zones_version="zones-test", destinations=dests, roads=_road_graph(raw), perimeters=(), fronts=(),
        observations=(), fire_model="none",
    )


WEST_PATH = [edge((2, 0), (1, 0)), edge((1, 0), (0, 0))]
EAST_PATH = [edge((i, 0), (i + 1, 0)) for i in range(2, 6)]


def fire_at(geometry) -> FireEstimate:
    return FireEstimate(NOW, "model_nowcast", "Model estimate, 16:00 drill time", geometry, (), "simulated")


NO_FIRE = FireEstimate(None, "none", "No fire estimate yet", None, (), "none")


class PlannerCongestionTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.drill = grid_drill()
        # A fire about 4.7 km north of the zone: ``be_ready`` (within BE_READY_KM), so the planner
        # routes it, and every grid edge stays farther than FIRE_BUFFER_M from it.
        cls.far_fire = fire_at(square((coord(2, 0)[0], coord(2, 0)[1] + 0.045), 0.003))
        cls.edge_s = {e: edge_travel_time_s(cls.drill.roads.edges[e]) for e in (*WEST_PATH, *EAST_PATH)}

    def guidance(self, fire=None, blocked=(), congestion=None, incumbents=None):
        out = plan(self.drill, NOW, fire or self.far_fire, blocked, (), congestion=congestion, incumbents=incumbents)
        self.assertEqual(len(out), 1)
        g = out[0]
        self.assertNotEqual(g.level, "none", "the test fire must put the zone in a moving level")
        return g

    def cost(self, path, factor=1.0):
        return sum(self.edge_s[e] for e in path) * factor

    def west_factor_for_gain(self, gain_s: float) -> float:
        """Uniform factor on the west path that makes it ``gain_s`` cheaper than the free east path."""
        return (self.cost(EAST_PATH) - gain_s) / self.cost(WEST_PATH)

    # -- congestion changes the choice

    def test_free_flow_takes_the_nearest_exit(self):
        g = self.guidance()
        self.assertEqual(g.destination_id, WEST)
        self.assertEqual(list(g.route.edge_ids), WEST_PATH)

    def test_jammed_nearest_exit_sends_the_zone_to_the_other_exit(self):
        jam = dict.fromkeys(WEST_PATH, 3.0)
        g = self.guidance(congestion=jam)
        self.assertEqual(g.destination_id, EAST)
        self.assertEqual(list(g.route.edge_ids), EAST_PATH)
        # ETA stays free-flow: congestion changes the choice, not the published travel time.
        self.assertAlmostEqual(g.route.travel_time_s, self.cost(EAST_PATH))

    def test_congestion_is_directional(self):
        inbound = {edge((0, 0), (1, 0)): 10.0, edge((1, 0), (2, 0)): 10.0}  # the opposite lane only
        self.assertEqual(self.guidance(congestion=inbound).destination_id, WEST)

    def test_deterministic_and_validated(self):
        jam = dict.fromkeys(WEST_PATH, 2.5)
        a, b = self.guidance(congestion=jam), self.guidance(congestion=jam)
        self.assertEqual(a.route.edge_ids, b.route.edge_ids)
        for bad in (0.5, 11.0, float("nan")):
            with self.assertRaises(ValueError):
                best_routes(self.drill, (), None, (), congestion={WEST_PATH[0]: bad})

    # -- hysteresis

    def test_margin_formula(self):
        self.assertEqual(switch_margin_s(100.0), SWITCH_MIN_GAIN_S)
        self.assertAlmostEqual(switch_margin_s(2000.0), SWITCH_MIN_GAIN_FRACTION * 2000.0)

    def test_small_gain_keeps_the_incumbent_exit(self):
        margin = switch_margin_s(self.cost(EAST_PATH))
        factor = self.west_factor_for_gain(margin / 2)
        jam = dict.fromkeys(WEST_PATH, factor)
        self.assertEqual(self.guidance(congestion=jam).destination_id, WEST, "without an incumbent west is cheaper")
        for inc in (Incumbent(EAST, tuple(EAST_PATH)), Incumbent(EAST)):
            with self.subTest(edges=inc.edge_ids is not None):
                g = self.guidance(congestion=jam, incumbents={ZONE: inc})
                self.assertEqual(g.destination_id, EAST)
                self.assertEqual(list(g.route.edge_ids), EAST_PATH)

    def test_large_gain_switches(self):
        margin = switch_margin_s(self.cost(EAST_PATH))
        factor = self.west_factor_for_gain(margin * 1.5)
        jam = dict.fromkeys(WEST_PATH, factor)
        g = self.guidance(congestion=jam, incumbents={ZONE: Incumbent(EAST, tuple(EAST_PATH))})
        self.assertEqual(g.destination_id, WEST)

    def test_dwell_keeps_a_fresh_incumbent_whatever_the_gain(self):
        margin = switch_margin_s(self.cost(EAST_PATH))
        jam = {e: self.west_factor_for_gain(margin * 1.5) for e in WEST_PATH}
        fresh = Incumbent(EAST, tuple(EAST_PATH), held_s=SWITCH_MIN_DWELL_S - 60)
        self.assertEqual(self.guidance(congestion=jam, incumbents={ZONE: fresh}).destination_id, EAST)
        settled = Incumbent(EAST, tuple(EAST_PATH), held_s=SWITCH_MIN_DWELL_S)
        self.assertEqual(self.guidance(congestion=jam, incumbents={ZONE: settled}).destination_id, WEST)

    def test_dwell_never_keeps_a_blocked_incumbent(self):
        blocked = {seg((4, 0), (5, 0)), seg((4, 1), (5, 1))}  # east exit cut off on both rows
        fresh = Incumbent(EAST, tuple(EAST_PATH), held_s=0.0)
        g = self.guidance(blocked=blocked, congestion=dict.fromkeys(WEST_PATH, 5.0), incumbents={ZONE: fresh})
        self.assertEqual(g.destination_id, WEST)
        self.assertFalse(set(g.route.segment_ids) & blocked)

    def test_congested_incumbent_is_left_when_the_gain_is_large(self):
        jam = dict.fromkeys(EAST_PATH, 4.0)
        g = self.guidance(congestion=jam, incumbents={ZONE: Incumbent(EAST, tuple(EAST_PATH))})
        self.assertEqual(g.destination_id, WEST)

    def test_incumbent_over_a_blocked_segment_is_never_kept(self):
        blocked = {seg((4, 0), (5, 0))}
        factor = self.west_factor_for_gain(10.0)  # west barely better than the old (now blocked) east path
        jam = dict.fromkeys(WEST_PATH, factor)
        g = self.guidance(blocked=blocked, congestion=jam, incumbents={ZONE: Incumbent(EAST, tuple(EAST_PATH))})
        self.assertFalse(set(g.route.segment_ids) & blocked)
        # The east detour over row 1 costs two north-south edges more, so west now wins clearly.
        self.assertEqual(g.destination_id, WEST)

    def test_incumbent_near_the_fire_is_not_kept_over_a_clear_route(self):
        # Fire 150 m south of the n4-n5 edge: that edge is within FIRE_BUFFER_M, row 1 is clear.
        mid = ((coord(4, 0)[0] + coord(5, 0)[0]) / 2, LAT0 - 0.0035)
        fire = fire_at(square(mid, 0.002))
        factor = self.west_factor_for_gain(10.0)
        jam = dict.fromkeys(WEST_PATH, factor)
        g = self.guidance(fire=fire, congestion=jam, incumbents={ZONE: Incumbent(EAST, tuple(EAST_PATH))})
        self.assertEqual(route_safety(g.route), "clear")
        self.assertNotIn(edge((4, 0), (5, 0)), g.route.edge_ids)

    def test_stale_incumbent_edges_fall_back_to_the_destination(self):
        bogus = (edge((2, 1), (3, 1)),)  # does not start at the zone origin
        margin = switch_margin_s(self.cost(EAST_PATH))
        jam = {e: self.west_factor_for_gain(margin / 2) for e in WEST_PATH}
        g = self.guidance(congestion=jam, incumbents={ZONE: Incumbent(EAST, bogus)})
        self.assertEqual(g.destination_id, EAST)
        self.assertEqual(list(g.route.edge_ids), EAST_PATH)

    def test_no_fire_means_no_guidance_whatever_the_congestion(self):
        out = plan(self.drill, NOW, NO_FIRE, (), (), congestion=dict.fromkeys(WEST_PATH, 10.0),
                   incumbents={ZONE: Incumbent(EAST)})
        self.assertEqual(out[0].level, "none")
        self.assertIsNone(out[0].route)


class CongestionFactorsTest(SimpleTestCase):
    def test_min_vehicles_and_known_edges(self):
        speeds = {
            "a": (CONGESTION_MIN_VEH, 15.0, 60.0),      # 4x
            "b": (CONGESTION_MIN_VEH - 1, 5.0, 60.0),   # too few vehicles
            "c": (10, 60.0, 60.0),                      # free-flow
            "d": (10, 0.0, 60.0),                       # stopped -> max
            "zz": (10, 5.0, 60.0),                      # not a drill edge
        }
        self.assertEqual(congestion_factors(speeds, {"a", "b", "c", "d"}), {"a": 4.0, "d": 10.0})
