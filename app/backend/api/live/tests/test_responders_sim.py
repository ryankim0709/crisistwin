"""``livecore.responders_sim`` on the small synthetic grid of test_inbound_route: determinism,
no closed edge ever used, re-routing, verify answers from ground truth, and timing. Pure; no database.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.test import SimpleTestCase

from livecore.geo import haversine_m
from livecore.inbound import inbound_route
from livecore.responders_sim import (
    LOCATION_MOVING_S,
    ON_SCENE_JITTER,
    UNIT_TYPES,
    UNREACHABLE_GIVEUP_S,
    Fleet,
    World,
)

from .test_inbound_route import coord, grid_drill, seg

T0 = datetime(2018, 11, 8, 16, 0, tzinfo=UTC)
STEP_S = 5


def task(tid, kind, target, segment_id=None, status="open", assignee=None):
    return {"id": tid, "kind": kind, "status": status, "assignee": assignee,
            "target": {"coord": list(target), "segment_id": segment_id}}


def parse(at: str) -> datetime:
    return datetime.fromisoformat(at.replace("Z", "+00:00"))


class Sim:
    """A tiny fake server: binds joins, tracks task status, records every call and unit position."""

    def __init__(self, drill, n, stations, tasks, world_at=lambda t: World(), **kw):
        self.fleet = Fleet(drill, n, stations=[coord(*s) for s in stations], **kw)
        self.tasks = {t["id"]: dict(t) for t in tasks}
        self.world_at = world_at
        self.calls = []
        self.on_edge = []  # (t, unit, edge id) for every tick a unit is strictly inside an edge
        self.t = T0

    def run(self, seconds):
        end = self.t + timedelta(seconds=seconds)
        while self.t <= end:
            open_tasks = [t for t in self.tasks.values() if t["status"] in ("open", "accepted")]
            calls = self.fleet.tick(self.t, open_tasks, self.world_at(self.t))
            for c in calls:
                self.apply(c)
            self.calls += calls
            for u in self.fleet.units:
                if u.phase == "enroute" and u.edge_t > 0 and u.edge_i < len(u.route):
                    self.on_edge.append((self.t, u.id, u.route[u.edge_i]))
            self.t += timedelta(seconds=STEP_S)
        return self.calls

    def apply(self, c):
        if c["op"] == "join":
            self.fleet.bind(c["unit"], f"rsp_{c['unit']}")
        elif c["op"] == "accept":
            tid = c["path"].rsplit("/", 1)[1]
            self.tasks[tid].update(status="accepted", assignee=f"rsp_{c['unit']}")
        elif c["op"] in ("done", "cancel", "report"):
            tid = c["body"].get("task_id") or c["path"].rsplit("/", 1)[1]
            self.tasks[tid]["status"] = "cancelled" if c["op"] == "cancel" else "done"

    def ops(self, op):
        return [c for c in self.calls if c["op"] == op]


def rect(lon0, lat0, lon1, lat1):
    return (((lon0, lat0), (lon1, lat0), (lon1, lat1), (lon0, lat1), (lon0, lat0)),),


class RespondersSimTest(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.drill = grid_drill()
        cls.edges = cls.drill.roads.edges

    def segments_used(self, sim):
        return {self.edges[e].segment_id for _, _, e in sim.on_edge}

    def test_deterministic_and_calls_are_labelled(self):
        def run():
            s = Sim(self.drill, 2, [(0, 0), (4, 2)],
                    [task("t1", "verify", coord(3, 0), seg((3, 0), (4, 0))), task("t2", "assist", coord(1, 2))],
                    seed=7)
            return s.run(900)
        a, b = run(), run()
        self.assertEqual(a, b)
        joins = [c for c in a if c["op"] == "join"]
        self.assertEqual(len(joins), 2)
        self.assertTrue(all(c["body"] == {"simulated": True} for c in joins))
        self.assertTrue({"accept", "report", "done", "location"} <= {c["op"] for c in a})
        self.assertTrue(all(c["at"].endswith("Z") and "unit" in c and "path" in c for c in a))

    def test_nearest_suitable_task_and_unit_kinds(self):
        # engine at (0,0), patrol at (4,0), ambulance at (2,2); verify near (4,0), assist near (0,0)
        s = Sim(self.drill, 3, [(0, 0), (4, 0), (2, 2)],
                [task("v", "verify", coord(4, 1), seg((4, 0), (4, 1))), task("a", "assist", coord(0, 1))])
        s.run(30)
        accepts = {c["path"].rsplit("/", 1)[1]: c["unit"] for c in s.ops("accept")}
        self.assertEqual(accepts["v"], "sim-2")  # the patrol is nearest to the verify task
        self.assertEqual(accepts["a"], "sim-1")  # the engine at (0,0) is nearest to the assist task
        self.assertEqual(UNIT_TYPES["ambulance"].kinds, frozenset({"assist"}))

    def test_ambulance_never_takes_verify(self):
        s = Sim(self.drill, 3, [(0, 0), (0, 0), (0, 0)], [task("v", "verify", coord(1, 0))])
        s.run(20)
        self.assertEqual({c["unit"] for c in s.ops("accept")}, {"sim-1"})  # engine; never sim-3 (ambulance)

    def test_unknown_block_is_discovered_then_rerouted_never_entered(self):
        blocked = seg((2, 0), (3, 0))
        s = Sim(self.drill, 1, [(0, 0)], [task("v", "verify", coord(4, 0), seg((3, 0), (4, 0)))],
                world_at=lambda t: World(truth_blocked=frozenset({blocked})))
        s.run(1200)
        self.assertNotIn(blocked, self.segments_used(s))
        self.assertGreaterEqual(s.fleet.units[0].replans, 1)
        (rep,) = s.ops("report")  # still arrived, by the detour
        self.assertEqual(rep["body"]["kind"], "road_passable")

    def test_reroute_when_a_known_block_appears_mid_drive(self):
        ahead = seg((3, 0), (4, 0))
        switch = T0 + timedelta(seconds=60)
        s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", coord(4, 0))],
                world_at=lambda t: World(known_blocked=frozenset({ahead}) if t >= switch else frozenset()))
        s.run(1500)
        self.assertEqual(len(s.ops("done")), 1)
        for t, _, e in s.on_edge:
            if t >= switch:
                self.assertNotEqual(self.edges[e].segment_id, ahead)
        self.assertGreaterEqual(s.fleet.units[0].replans, 1)

    def test_never_enters_an_edge_inside_the_fire(self):
        x, y = coord(1, 0)
        fire = rect(x + 0.001, y - 0.0008, x + 0.0035, y + 0.0008)  # crosses the middle of one bottom-row segment
        s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", coord(4, 0))], world_at=lambda t: World(fire=fire))
        s.run(1500)
        self.assertEqual(len(s.ops("done")), 1)
        self.assertNotIn(seg((1, 0), (2, 0)), self.segments_used(s))

    def test_verify_answers_follow_ground_truth(self):
        target = seg((3, 0), (4, 0))
        for truth, kind, severity in ((frozenset({target}), "road_blocked", "full"),
                                      (frozenset(), "road_passable", None)):
            s = Sim(self.drill, 1, [(0, 0)], [task("v", "verify", coord(3.5, 0), target)],
                    world_at=lambda t, truth=truth: World(truth_blocked=truth))
            s.run(1500)
            (rep,) = s.ops("report")
            self.assertEqual((rep["body"]["kind"], rep["body"]["severity"]), (kind, severity))
            self.assertEqual(rep["body"]["task_id"], "v")
            self.assertNotIn(target, self.segments_used(s))

    def test_verify_answer_is_blocked_when_the_fire_covers_the_segment(self):
        target = seg((3, 0), (4, 0))
        mid = (coord(3, 0)[0] + coord(4, 0)[0]) / 2, coord(3, 0)[1]
        fire = rect(mid[0] - 0.0012, mid[1] - 0.0004, mid[0] + 0.0012, mid[1] + 0.0004)
        s = Sim(self.drill, 1, [(0, 0)], [task("v", "verify", mid, target)], world_at=lambda t: World(fire=fire))
        s.run(1500)
        (rep,) = s.ops("report")
        self.assertEqual(rep["body"]["kind"], "road_blocked")
        self.assertNotIn(target, self.segments_used(s))

    def test_timing_travel_plus_on_scene(self):
        dst = coord(4, 0)
        s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", dst)])
        s.run(1500)
        accept, done = s.ops("accept")[0], s.ops("done")[0]
        elapsed = (parse(done["at"]) - parse(accept["at"])).total_seconds()
        travel = inbound_route(self.drill, coord(0, 0), dst, frozenset(), None).travel_time_s
        travel /= UNIT_TYPES["engine"].speed_factor
        scene = UNIT_TYPES["engine"].on_scene_s["assist"]
        self.assertGreaterEqual(elapsed, travel + scene * (1 - ON_SCENE_JITTER) - 1e-6)
        self.assertLessEqual(elapsed, travel + scene * (1 + ON_SCENE_JITTER) + STEP_S)

    def test_congestion_slows_the_unit(self):
        dst = coord(4, 0)

        def done_at(factor):
            cong = dict.fromkeys(self.edges, factor)  # every road jammed
            s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", dst)], world_at=lambda t: World(congestion=cong))
            s.run(4000)
            return parse(s.ops("done")[0]["at"])
        self.assertGreater(done_at(3.0) - done_at(1.0), timedelta(seconds=300))

    def test_unreachable_target_is_cancelled_after_the_wait(self):
        closed = frozenset({seg((3, 0), (4, 0)), seg((4, 0), (4, 1))})
        s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", coord(4, 0))],
                world_at=lambda t: World(known_blocked=closed))
        s.run(UNREACHABLE_GIVEUP_S + 60)
        (c,) = s.ops("cancel")
        self.assertEqual(c["body"]["status"], "cancelled")
        self.assertEqual(s.ops("done"), [])
        self.assertEqual(s.on_edge, [])  # it never moved

    def test_locations_start_at_the_station_and_follow_the_drive(self):
        s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", coord(4, 0))])
        s.run(600)
        locs = s.ops("location")
        self.assertLess(haversine_m(tuple(locs[0]["body"]["coord"]), coord(0, 0)), 50.0)  # within one 5 s step of the station
        self.assertGreater(len({tuple(c["body"]["coord"]) for c in locs}), 3)
        times = [parse(c["at"]) for c in locs[:6]]
        gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:], strict=False)]
        self.assertTrue(all(g >= LOCATION_MOVING_S - 1e-6 for g in gaps))

    def test_a_task_closed_by_someone_else_is_dropped(self):
        s = Sim(self.drill, 1, [(0, 0)], [task("a", "assist", coord(4, 0))])
        s.run(60)
        self.assertEqual(s.fleet.units[0].phase, "enroute")
        s.tasks["a"]["status"] = "cancelled"
        s.run(10)
        self.assertEqual(s.fleet.units[0].phase, "idle")
        self.assertEqual(s.ops("done"), [])
