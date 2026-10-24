"""Simulated residents (sim/gen_residents.py, docs/adr/0036-simulated-residents.md).

python3.12 -m unittest tests.test_gen_residents
The live-API validator test runs only where Django is importable (the backend venv); the Camp test only where
the Camp package artifacts exist (set CRISISTWIN_DATA_ROOT to a checkout that has them).
"""

from __future__ import annotations

import json
import math
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sim.gen_residents import (  # noqa: E402
    CHECKIN_STATUSES, EVIDENCE_CLASS, REPORT_KINDS, SEVERITIES, ResidentGenerator, ResidentParams,
    allocate_vehicles, check_invariants, run_residents, validate_body,
)
from sim.history import format_utc, parse_utc  # noqa: E402
from sim.traffic import DemandZone, Destination, RoadEdge, RoadNetwork, TrafficEvent, TrafficParams  # noqa: E402
from sim.twin import Twin, TwinInputs, inputs_fingerprint  # noqa: E402

START = datetime(2018, 11, 8, 14, 0, tzinfo=timezone.utc)
END = START + timedelta(hours=6)
LAT = 39.75
LON0 = -121.60
STEP_DEG = 0.01  # about 855 m of longitude at this latitude
N_NODES = 8
FIRE_START = START + timedelta(minutes=20)


def _lon(k: int) -> float:
    return LON0 + STEP_DEG * k


def _fire_area_at(at: datetime):
    """Synthetic fire: a box growing east from the west end at 1 node spacing per 30 min, from FIRE_START."""
    if at < FIRE_START:
        return None
    reach = (at - FIRE_START).total_seconds() / 1800 * STEP_DEG
    x0, x1 = LON0 - 0.005, LON0 - 0.005 + min(reach, 3.5 * STEP_DEG)
    return {"type": "Polygon", "coordinates": [[[x0, LAT - 0.01], [x1, LAT - 0.01], [x1, LAT + 0.01],
                                                [x0, LAT + 0.01], [x0, LAT - 0.01]]]}


def synthetic_twin(*, households=(400, 300), vehicles=(600, 250), delay_min=60.0, start_at=None) -> Twin:
    """A two-way corridor of N_NODES nodes, west to an exit in the east; zone W at the west end (in the fire's
    path), zone E further east with fewer vehicles than households (carless households). 1 lane, 300 veh/h,
    so queues form. Main Road closes east of the refuge from 14:40 to 15:10Z."""
    nodes = {f"n{k}": (_lon(k), LAT) for k in range(N_NODES)}
    edges = []
    for k in range(N_NODES - 1):
        a, b = f"n{k}", f"n{k + 1}"
        for fr, to, d in ((a, b, "f"), (b, a, "r")):
            edges.append(RoadEdge(id=f"e{k}{d}", segment_id=f"s{k}", from_node=fr, to_node=to, length_m=855.0,
                                  lanes=1, speed_kph=50.0, capacity_veh_per_hour=300.0, name="Main Road",
                                  highway="secondary", bridge=False, coords=(nodes[fr], nodes[to])))
    net = RoadNetwork(nodes=nodes, edges=tuple(edges))
    zones = (DemandZone("zW", "West", households[0], vehicles[0], ("n0", "n1", "n2"), {}),
             DemandZone("zE", "East", households[1], vehicles[1], ("n3", "n4"), {}))
    dests = (Destination("exit:east", "Exit east", "exit", f"n{N_NODES - 1}", nodes[f"n{N_NODES - 1}"], None),
             Destination("refuge:mid", "Refuge mid", "temporary_refuge", "n5", nodes["n5"], 200))
    events = (TrafficEvent("order-1", START + timedelta(minutes=10), "evacuation_order", "Order (synthetic)",
                           "simulated", "minute", zone_ids=("zW", "zE")),
              TrafficEvent("close-1", START + timedelta(minutes=40), "road_closed", "Closure (synthetic)",
                           "simulated", "minute", edge_ids=("e5f",), closure_drains=True),
              TrafficEvent("reopen-1", START + timedelta(minutes=70), "road_reopened", "Reopen (synthetic)",
                           "simulated", "minute", edge_ids=("e5f",)))
    scenario = {"network": net, "zones": zones, "destinations": dests, "events": events}
    params = TrafficParams(seed=11, response_delay_median_min=delay_min)
    meta = {"model": "synthetic-box", "version": "test"}
    inputs = TwinInputs(scenario=scenario, history_id="synthetic", params=params, start=START, end=END,
                        fire_area_at=_fire_area_at, fire_model_meta=meta,
                        fingerprint=inputs_fingerprint(scenario, params, START, END, meta))
    return Twin.from_inputs(inputs, start_at=start_at or format_utc(START))


def run(seed=1, until="2018-11-08T19:00:00Z", **kw) -> dict:
    return run_residents(synthetic_twin(), until, ResidentParams(seed=seed, **kw), incident_id="synthetic-drill")


class AllocationTest(unittest.TestCase):
    def test_vehicles_sum_exactly(self):
        for h, v in ((10, 17), (10, 10), (10, 4), (10, 25), (1, 0), (0, 0)):
            alloc = allocate_vehicles(h, v)
            self.assertEqual(len(alloc), h)
            self.assertEqual(sum(alloc), v)
            self.assertTrue(all(a >= 0 for a in alloc))
            if h <= v <= 2 * h:
                self.assertTrue(all(1 <= a <= 2 for a in alloc))
            if v < h:
                self.assertEqual(alloc.count(0), h - v)


class SyntheticRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run(seed=1)
        cls.events = cls.result["events"]

    def test_labels_and_shapes(self):
        self.assertEqual(self.result["evidence_class"], "simulated")
        self.assertTrue(self.events)
        for ev in self.events:
            self.assertEqual(ev["evidence_class"], EVIDENCE_CLASS)
            self.assertTrue(ev["party_key"].startswith("sim_"))
            validate_body(ev)
            json.dumps(ev)
        kinds = {ev["type"] + ":" + (ev["body"].get("kind") or ev["body"].get("status") or "choice")
                 for ev in self.events}
        for expected in ("checkin:out", "checkin:need_help", "checkin:staying", "destination:choice",
                         "report:fire_seen", "report:heavy_traffic", "report:road_blocked"):
            self.assertIn(expected, kinds)

    def test_determinism(self):
        again = run(seed=1)
        self.assertEqual(json.dumps(again["events"]), json.dumps(self.events))
        other = run(seed=2)
        self.assertNotEqual(json.dumps(other["events"]), json.dumps(self.events))

    def test_invariants(self):
        twin = synthetic_twin()
        gen = ResidentGenerator(twin, ResidentParams(seed=1))
        check_invariants(self.events, gen.pops)  # raises on: labels, shape, order, causality, out, help after out
        outs, helps = {}, {}
        for ev in self.events:
            self.assertLessEqual(ev["cause"]["at"], ev["at"])
            if ev["body"].get("status") == "out":
                self.assertNotIn(ev["party_key"], outs)
                outs[ev["party_key"]] = ev["at"]
            if ev["body"].get("status") == "need_help":
                helps.setdefault(ev["party_key"], []).append(ev["at"])
        for party, times in helps.items():
            if party in outs:
                self.assertTrue(all(t < outs[party] for t in times))

    def test_invariant_checker_rejects(self):
        twin = synthetic_twin()
        gen = ResidentGenerator(twin, ResidentParams(seed=1))
        out = next(ev for ev in self.events if ev["body"].get("status") == "out")
        with self.assertRaises(AssertionError):
            check_invariants([out, dict(out)], gen.pops)  # second out
        helped = dict(out, body={"status": "need_help", "zone_id": out["zone_id"]},
                      at=format_utc(parse_utc(out["at"]) + timedelta(minutes=1)))
        with self.assertRaises(AssertionError):
            check_invariants([out, helped], gen.pops)  # help after out
        early = dict(out, cause={"state": "arrived", "at": format_utc(parse_utc(out["at"]) + timedelta(minutes=1))})
        with self.assertRaises(AssertionError):
            check_invariants([early], gen.pops)  # before its cause
        with self.assertRaises(AssertionError):
            check_invariants([dict(out, evidence_class="field_report")], gen.pops)

    def test_conservation_step_by_step(self):
        twin = synthetic_twin()
        gen = ResidentGenerator(twin, ResidentParams(seed=3))
        e = twin.engine
        for z in gen.pops:
            self.assertEqual(sum(h.vehicles for h in z.households), e.s.zone_list[z.zi].vehicles)
            self.assertEqual(len(z.households), e.s.zone_list[z.zi].households)
        self.assertEqual(sum(h.vehicles == 0 for z in gen.pops for h in z.households), 50)  # zone E: 300 HH, 250 veh
        t = START
        while t < parse_utc("2018-11-08T19:00:00Z"):
            t += timedelta(minutes=5)
            twin.step_to(format_utc(t))
            gen.observe()  # asserts en-route households sit on exactly the twin's en-route vehicles
            for z in gen.pops:
                n_dep, n_arr = gen.prev_departed[z.zi], gen.prev_arrived[z.zi]
                dep_veh = sum(h.vehicles for h in z.order[:n_dep])
                arr_veh = sum(h.vehicles for h in z.order[:n_arr])
                self.assertLessEqual(arr_veh, e.z_arrived[z.zi])
                self.assertGreaterEqual(dep_veh, e.z_departed[z.zi])
                self.assertLess(dep_veh - e.z_departed[z.zi], VEHICLE_SLACK)
                self.assertLess(e.z_arrived[z.zi] - arr_veh, VEHICLE_SLACK)
        self.assertGreater(sum(gen.prev_arrived), 0)

    def test_checkins_bounded_by_households(self):
        parties = {ev["party_key"] for ev in self.events if ev["type"] == "checkin"}
        pop = self.result["population"]
        self.assertLessEqual(len(parties), pop["app_households"])
        outs = sum(1 for ev in self.events if ev["body"].get("status") == "out")
        self.assertLessEqual(outs, pop["households"] - pop["carless_households"])

    def test_report_coordinates_on_network(self):
        for ev in self.events:
            c = (ev["body"].get("location") or {}).get("coord") or ev["body"].get("coord")
            if c is None:
                continue
            self.assertTrue(LON0 - 0.01 <= c[0] <= _lon(N_NODES - 1) + 0.01 and abs(c[1] - LAT) < 0.01, c)


VEHICLE_SLACK = 3  # one household's vehicles at most (allocate_vehicles gives 1-2 here)


class RateSanityTest(unittest.TestCase):
    """Measured rates against the parameters that drive them (Poisson / binomial tolerance, 4 sigma)."""

    @classmethod
    def setUpClass(cls):
        cls.p = ResidentParams(seed=5, app_adoption=1.0, help_at_home_per_h=2.0, out_checkin_share=0.8,
                               destination_choice_share=0.3)
        twin = synthetic_twin(households=(1500, 1200), vehicles=(2200, 1500), delay_min=90.0)
        cls.gen = ResidentGenerator(twin, cls.p)
        cls.events = cls.gen.observe()
        t = START
        while not twin.finished:
            t += timedelta(minutes=1)
            twin.step_to(format_utc(t))
            cls.events += cls.gen.observe()
        cls.twin = twin

    def test_help_hazard(self):
        n = self.gen.latent_help["at_home_fire"]
        exposure_h = self.gen.exposure_h["at_home_fire"]
        self.assertGreater(n, 100)
        rate = n / exposure_h
        # Discrete ticks: E[rate] = (1 - exp(-h dt)) / dt for dt = 1 min.
        dt_h = 1 / 60
        expected = (1 - math.exp(-self.p.help_at_home_per_h * dt_h)) / dt_h
        self.assertLess(abs(rate - expected), 4 * math.sqrt(n) / exposure_h, (rate, expected))
        emitted = sum(1 for ev in self.events if ev["body"].get("status") == "need_help")
        self.assertEqual(emitted, n + self.gen.latent_help["trapped"])  # app_adoption 1: every request is sent

    def test_out_share(self):
        arrived = sum(self.gen.prev_arrived)
        outs = sum(1 for ev in self.events if ev["body"].get("status") == "out")
        pending = len(self.gen.pending)
        share = (outs + pending) / arrived
        sd = math.sqrt(0.8 * 0.2 / arrived)
        self.assertLess(abs(share - 0.8), 4 * sd, share)

    def test_destination_share_and_recommended(self):
        departed = sum(self.gen.prev_departed)
        choices = [ev for ev in self.events if ev["type"] == "destination"]
        share = len(choices) / departed
        self.assertLess(abs(share - 0.3), 4 * math.sqrt(0.3 * 0.7 / departed), share)
        multi = [ev for ev in choices if len(ev["cause"]["offered"]) > 1]
        if multi:
            rec = sum(ev["body"]["destination_id"] == ev["cause"]["offered"][0] for ev in multi) / len(multi)
            self.assertLess(abs(rec - 0.7), 4 * math.sqrt(0.21 / len(multi)), rec)

    def test_app_adoption(self):
        twin = synthetic_twin(households=(1500, 1200), vehicles=(2200, 1500))
        gen = ResidentGenerator(twin, ResidentParams(seed=9, app_adoption=0.25))
        hh = [h for z in gen.pops for h in z.households]
        share = sum(h.has_app for h in hh) / len(hh)
        self.assertLess(abs(share - 0.25), 4 * math.sqrt(0.25 * 0.75 / len(hh)), share)

    def test_reports_only_once_per_encounter(self):
        seen = set()
        for ev in self.events:
            if ev["type"] == "report" and ev["body"]["kind"] == "fire_seen":
                self.assertNotIn(ev["party_key"], seen)
                seen.add(ev["party_key"])


def _django_views():
    """api.live.views when Django is importable (backend venv), else None. Never connects to MongoDB."""
    try:
        import django  # noqa: F401
    except ImportError:
        return None
    sys.path.insert(0, str(ROOT / "app/backend"))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    os.environ.setdefault("MONGODB_URI", "mongodb://127.0.0.1:1/validator_only")  # import-time check only
    import django as dj
    dj.setup()
    from api.live import views
    return views


class LiveApiValidatorTest(unittest.TestCase):
    """Bodies through the server's own `_validate_report`, and our constants against the server's."""

    @classmethod
    def setUpClass(cls):
        cls.views = _django_views()
        if cls.views is None:
            raise unittest.SkipTest("Django not importable; run under app/backend/.venv to include this test")
        cls.events = run(seed=1)["events"]

    def test_constants_match_server(self):
        v = self.views
        self.assertEqual(REPORT_KINDS, v.REPORT_KINDS)
        self.assertEqual(SEVERITIES, v.SEVERITIES)
        self.assertEqual(CHECKIN_STATUSES, v.CHECKIN_STATUSES)

    def test_reports_pass_server_validator(self):
        from unittest import mock

        class _Index:
            destinations: dict = {}

        reports = [ev for ev in self.events if ev["type"] == "report"]
        self.assertTrue(reports)
        with mock.patch.object(self.views, "get_index", lambda: _Index()):
            for ev in reports:
                fields = self.views._validate_report(ev["body"], "synthetic-drill")
                self.assertEqual(fields["kind"], ev["body"]["kind"])
                self.assertEqual(fields["location"]["coord"], ev["body"]["location"]["coord"])

    def test_board_reports_pass_server_validator(self):
        from unittest import mock

        class _Index:
            destinations: dict = {}
            segment_lines = {f"s{k}": ((_lon(k), LAT), (_lon(k + 1), LAT)) for k in range(N_NODES - 1)}

        events = run_board(seed=1, board_answer_share=0.5, passive_setting_share=1.0)["events"]
        passive = [ev for ev in events if ev["body"].get("method") == "passive"]
        self.assertTrue(passive)
        with mock.patch.object(self.views, "get_index", lambda: _Index()):
            for ev in passive:
                fields = self.views._validate_passive(ev["body"], ev["body"]["client_id"], ev["body"]["kind"])
                self.assertEqual(fields["segment_id"], ev["body"]["segment_id"])


def board_items(at: str) -> list[dict]:
    """Open board questions for every corridor segment (the GET board `items` shape), all day."""
    return [{"task_id": f"tsk_s{k}", "rank": k + 1, "question": "road_status",
             "place": {"kind": "segment", "segment_id": f"s{k}", "destination_id": None, "name": "Main Road",
                       "coord": [_lon(k) + STEP_DEG / 2, LAT], "line": [[_lon(k), LAT], [_lon(k + 1), LAT]],
                       "free_flow_kph": 50},
             "expires_at": "2018-11-09T00:00:00Z"} for k in range(N_NODES - 1)]


def run_board(seed=1, until="2018-11-08T19:00:00Z", **kw) -> dict:
    return run_residents(synthetic_twin(), until, ResidentParams(seed=seed, **kw), incident_id="synthetic-drill",
                         board=board_items)


class BoardTest(unittest.TestCase):
    """ADR 0041: simulated residents answer board questions on the road they drive, and send passive
    observations only when their (seeded) setting is on."""

    @classmethod
    def setUpClass(cls):
        cls.result = run_board(seed=1)
        cls.events = cls.result["events"]

    def test_answers_and_passive_observations(self):
        answers = [ev for ev in self.events if ev["type"] == "report" and ev["body"].get("task_id")]
        explicit = [ev for ev in answers if ev["body"].get("method") != "passive"]
        passive = [ev for ev in answers if ev["body"].get("method") == "passive"]
        self.assertTrue(explicit)
        self.assertTrue(passive)
        for ev in explicit:
            self.assertIn(ev["body"]["kind"], ("road_passable", "heavy_traffic", "road_blocked"))
            self.assertEqual(ev["cause"]["state"], "board_question")
        for ev in passive:
            body = ev["body"]
            self.assertNotIn("location", body)
            self.assertIn(body["kind"], ("road_passable", "heavy_traffic"))
            self.assertIn(body["speed_class"], ("free", "slow"))
            validate_body(ev)
        gen = ResidentGenerator(synthetic_twin(), ResidentParams(seed=1))
        sharing = {ev["party_key"] for ev in passive}
        self.assertTrue(all(gen.shares_road_observations(pk) for pk in sharing))

    def test_once_per_question_and_household(self):
        seen = set()
        for ev in self.events:
            tid = ev["body"].get("task_id")
            if not tid or ev["body"]["kind"] == "heavy_traffic" and ev["body"].get("method") == "passive":
                continue
            key = (ev["party_key"], tid)
            self.assertNotIn(key, seen)
            seen.add(key)

    def test_setting_off_and_no_answers_leaves_the_stream_unchanged(self):
        quiet = run_board(seed=1, board_answer_share=0.0, passive_setting_share=0.0)["events"]
        self.assertEqual(json.dumps(quiet), json.dumps(run(seed=1, board_answer_share=0.0,
                                                               passive_setting_share=0.0)["events"]))
        self.assertFalse([ev for ev in quiet if ev["body"].get("task_id")])

    def test_deterministic(self):
        self.assertEqual(json.dumps(run_board(seed=1)["events"]), json.dumps(self.events))


class CampTest(unittest.TestCase):
    """The Camp twin as the live drill builds it, 15:30-16:00Z."""

    def test_camp_window(self):
        from sim.gen_residents import camp_twin
        root = os.environ.get("CRISISTWIN_DATA_ROOT", str(ROOT))
        try:
            twin = camp_twin("2018-11-08T15:30:00Z", root)
        except Exception as exc:  # artifacts not pulled (sim.store SourceError) or absent
            self.skipTest(f"Camp packages unavailable: {exc}")
        result = run_residents(twin, "2018-11-08T16:00:00Z", ResidentParams(seed=20181108),
                               incident_id="camp-2018-drill")
        self.assertEqual(result["population"]["households"], 19913)
        self.assertEqual(result["population"]["vehicles"], 31638)
        self.assertTrue(result["events"])
        for ev in result["events"]:
            validate_body(ev)


if __name__ == "__main__":
    unittest.main()
