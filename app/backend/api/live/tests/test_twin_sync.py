"""The live twin matches what is published (docs/twin-api.md "HTTP adapter").

Pure tests of the twin evidence (``livecore.twinplan``, ``controllers.twin_sentence``) always
run. The sync tests build the Camp twin inputs (about 10 s) and are skipped when the drill
bundle or the twin packages are not available. No test touches the database: published
guidance is supplied by patching ``twin_service.current_guidance``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase

from api.live import controllers, twin_service
from api.live.state import Clock
from livecore import routing, twinplan

EXIT_SOUTH = "exit:osm-node:86546172"
ZONE = "bg:060070019001"
T0 = datetime(2018, 11, 8, 15, 30, tzinfo=UTC)


def result(exposed=0.0, blocked=0, trapped=0, remaining=0, arrived=0, valid=True):
    return {"valid": valid, "metrics": {
        "total_exposed_veh_min": exposed, "blocked_at_horizon_veh": blocked,
        "trapped_by_fire_at_horizon_veh": trapped, "remaining_at_horizon_veh": remaining,
        "arrived_in_window_veh": arrived}}


class TwinEvidenceTest(SimpleTestCase):
    def test_all_sets_tie_is_no_signal(self):
        base = result(remaining=5000)
        c = twinplan.choose([result(remaining=4000), result(remaining=4000)], 0, base)
        self.assertEqual(c.index, 0)
        self.assertTrue(c.no_signal)
        self.assertFalse(c.worse_than_baseline)

    def test_close_to_baseline_is_no_signal(self):
        c = twinplan.choose([result(remaining=4000), result(remaining=3000)], 0, result(remaining=4100))
        self.assertEqual(c.index, 1)  # 1,000 veh-min better than the reference: clear gain
        self.assertFalse(c.no_signal)  # and 1,100 from no new actions
        c = twinplan.choose([result(remaining=4000)], 0, result(remaining=4100))
        self.assertTrue(c.no_signal)

    def test_regression_avoided_when_another_set_is_not_worse(self):
        base = result(remaining=4000)
        # Reference costs 4,100 (> baseline); set 1 costs 3,950: below the margin, but not a regression.
        c = twinplan.choose([result(remaining=4100), result(remaining=3950)], 0, base)
        self.assertEqual(c.index, 1)
        self.assertFalse(c.worse_than_baseline)

    def test_regression_reported_when_every_set_is_worse(self):
        base = result(remaining=4000, trapped=0)
        c = twinplan.choose([result(remaining=3000, trapped=10), result(remaining=3500, trapped=5)], 0, base)
        self.assertIsNotNone(c.index)
        self.assertTrue(c.worse_than_baseline)  # fewer remaining, but more trapped by fire

    def test_no_swap_sets_for_zones_not_ordered(self):
        g = lambda z, level: SimpleNamespace(zone_id=z, level=level)  # noqa: E731
        r = lambda d: SimpleNamespace(destination_id=d)  # noqa: E731
        moving = [g("a", "evacuate_now"), g("b", "be_ready"), g("c", "be_ready")]
        alts = {"a": [r("x"), r("y")], "b": [r("x"), r("y")], "c": [r("x"), r("z")]}
        cands, _ = twinplan.candidates(moving, alts, {"a": 1, "b": 900, "c": 800}, {}, {})
        labels = [c.label for c in cands]
        self.assertEqual(labels, ["Planner routes", "a to second choice"])

    def test_sentence_states_regression(self):
        twin = {
            "fire_ahead": "frozen", "horizon_min": 60, "objective": {"min_gain_veh_min": 250.0},
            "baseline": {"cost": 4000.0, "metrics": {"trapped_by_fire_at_horizon_veh": 0}},
            "candidates": [{"label": "Planner routes", "cost": 3000.0,
                            "metrics": {"trapped_by_fire_at_horizon_veh": 10, "arrived_in_window_veh": 50}}],
            "chosen": 0, "worse_than_baseline": True, "no_signal": False,
        }
        self.assertIn("more vehicles trapped by fire than no new actions", controllers.twin_sentence(twin))
        twin["candidates"][0]["metrics"]["trapped_by_fire_at_horizon_veh"] = 0
        twin["candidates"][0]["cost"] = 4500.0
        self.assertIn("worse than no new actions", controllers.twin_sentence(twin))
        twin.update(worse_than_baseline=False, no_signal=True)
        twin["candidates"][0]["cost"] = 3900.0
        self.assertIn("no measurable difference", controllers.twin_sentence(twin))


class TwinSyncTest(SimpleTestCase):
    """The live session against the real Camp inputs, with a fake drill snapshot."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            from api.live.drillcache import get_index

            cls.index = get_index()
            twinmod = twin_service._import_sim()
            raw = twinmod.camp_inputs(
                twin_service._package("LIVE_TWIN_PACKAGE", twin_service.CAMP_PACKAGE),
                twin_service._package("LIVE_TWIN_ROADS_PACKAGE", twin_service.CAMP_ROADS_PACKAGE),
                twin_service.TWIN_DEMAND, twin_service.TWIN_SEED)
        except Exception as exc:  # noqa: BLE001 - data symlinks absent: nothing to test against
            raise __import__("unittest").SkipTest(f"twin inputs unavailable: {type(exc).__name__}: {exc}")
        cls.twinmod = twinmod
        cls.raw = raw
        cls.inputs, cls.moved = twin_service._planner_destinations(
            raw, twinmod, routing._index(cls.index.drill).destination_nodes)

    def setUp(self):
        self.guidance: list[dict] = []
        patches = [
            mock.patch.object(twin_service, "_ready_inputs", lambda: self.inputs),
            mock.patch.object(twin_service, "current_guidance", lambda *a, **k: list(self.guidance)),
            mock.patch.dict(twin_service._sessions, {}, clear=True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def snapshot(self, started_at, replay_now, replay_start=T0, blocked=frozenset(), speed=0.0):
        clock = Clock(replay_start, started_at, speed, replay_now, speed > 0)
        return SimpleNamespace(incident_id="test-drill", index=self.index, clock=clock, road_state=[],
                               blocked=frozenset(blocked))

    def publish(self, zone, version, published_at, level="evacuate_now", dest=None):
        self.guidance.append({"zone_id": zone, "version": version, "level": level, "published_at": published_at,
                              "destination": {"id": dest} if dest else None, "no_route": False,
                              "proposal_id": f"p{version}", "approved_by": "controller"})

    def commands(self, snap):
        return twin_service._with_twin(snap, lambda s, t, m: (s.built_from, t.action_log()))

    def session_twin(self, snap):
        return twin_service._with_twin(snap, lambda s, t, m: t)

    def test_exit_south_uses_planner_node(self):
        self.assertIn(EXIT_SOUTH, self.moved)
        node = {d.id: d.node_id for d in self.inputs.scenario["destinations"]}[EXIT_SOUTH]
        self.assertEqual(node, routing._index(self.index.drill).destination_nodes[EXIT_SOUTH])
        self.assertNotEqual(self.inputs.fingerprint, self.raw.fingerprint)

    def test_planner_destinations_are_reachable_in_twin(self):
        routes = routing.best_routes(self.index.drill, (), None, ())
        snapped = {z: r.destination_id for z, r in routes.items() if r.destination_id in self.moved}
        if not snapped:
            self.skipTest("no zone routes to a snapped destination at the scenario start")
        twin = self.twinmod.Twin.from_inputs(self.inputs, start_at="2018-11-08T15:30:00Z")
        by_dest: dict[str, list[str]] = {}
        for z, d in snapped.items():
            by_dest.setdefault(d, []).append(z)
        for d, zones in sorted(by_dest.items()):
            twin.apply({"type": "reroute_zone", "target": {"zone_ids": sorted(zones)},
                        "params": {"destination_id": d}, "actor": {"kind": "controller", "id": "t"}})
        statuses = {z["id"]: z["assignment"]["status"] for z in twin.snapshot(detail="full")["zones"]
                    if z["assignment"]}
        unreachable = sorted(z for z in snapped if statuses.get(z) == "fallback_unreachable")
        self.assertEqual(unreachable, [])

    def test_restart_rebuilds_and_replays_guidance(self):
        run1 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
        self.publish(ZONE, 1, run1 + timedelta(seconds=5))
        first = self.session_twin(self.snapshot(run1, T0 + timedelta(minutes=5), speed=60))
        built, log = self.commands(self.snapshot(run1, T0 + timedelta(minutes=5), speed=60))
        self.assertEqual(built, "2018-11-08T15:30:00Z")
        self.assertEqual([a["type"] for a in log], ["order_zone"])
        # Reset + start again an hour later at the same replay_start: versions restart at 1.
        run2 = run1 + timedelta(hours=1)
        self.guidance.clear()
        self.publish(ZONE, 1, run2 + timedelta(seconds=5))
        snap = self.snapshot(run2, T0 + timedelta(minutes=10), speed=60)
        self.assertIsNot(self.session_twin(snap), first)
        built, log = self.commands(snap)
        self.assertEqual(built, "2018-11-08T15:30:00Z")
        self.assertEqual([(a["id"], a["type"]) for a in log], [("live-1", "order_zone")])

    def test_speed_change_keeps_session(self):
        run = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
        first = self.session_twin(self.snapshot(run, T0 + timedelta(minutes=1), speed=60))
        # set_speed one wall second later: replay_start := drill time then, started_at := now.
        later = run + timedelta(seconds=1)
        snap = self.snapshot(later, T0 + timedelta(minutes=2), replay_start=T0 + timedelta(minutes=1), speed=120)
        self.assertIs(self.session_twin(snap), first)

    def test_guidance_reset_rebuilds_even_when_clock_continues(self):
        run = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
        self.publish(ZONE, 2, run + timedelta(seconds=5))
        first = self.session_twin(self.snapshot(run, T0 + timedelta(minutes=1)))
        self.guidance.clear()
        self.publish(ZONE, 1, run + timedelta(seconds=30))
        self.assertIsNot(self.session_twin(self.snapshot(run, T0 + timedelta(minutes=1))), first)

    def test_public_block_closes_and_reopens(self):
        drill = self.index.drill
        seg = next(s for s in sorted(drill.roads.segment_edges) if self.index.segment_names.get(s))
        run = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
        _, log = self.commands(self.snapshot(run, T0 + timedelta(minutes=2), blocked={seg}))
        closes = [a for a in log if a["type"] == "close_road"]
        self.assertEqual(len(closes), 1)
        self.assertTrue(closes[0]["rationale"].startswith("Public road block"))
        _, log = self.commands(self.snapshot(run, T0 + timedelta(minutes=4)))
        self.assertEqual([a["type"] for a in log], ["close_road", "reopen_road"])
