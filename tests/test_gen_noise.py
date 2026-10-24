"""Tests for sim/gen_noise.py (ADR 0042): determinism, profile rates, rumour structure, truth completeness,
untouched real events, the 2018 calibration, and how livecore/public.py counts correlated parties.

Run from the repository root: python3 -m unittest tests.test_gen_noise
"""

from __future__ import annotations

import copy
import json
import math
import sys
import unittest
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "app" / "backend"))

from sim import gen_noise as gn  # noqa: E402
from sim.evaluation import TRIAGE_METRICS  # noqa: E402
from livecore import public  # noqa: E402

T0 = datetime(2018, 11, 8, 14, 30, tzinfo=timezone.utc)
CENTRE = (-121.6, 39.76)
RECORD = ROOT / "tools" / "camp_ground_record.json"


def honest_reports(n: int, kinds=("road_blocked", "heavy_traffic"), hours: float = 6.0, seed: int = 1) -> list[dict]:
    import random

    rng = random.Random(seed)
    out = []
    for i in range(n):
        at = T0 + timedelta(seconds=rng.uniform(0, hours * 3600))
        coord = [CENTRE[0] + rng.uniform(-0.05, 0.05), CENTRE[1] + rng.uniform(-0.03, 0.03)]
        out.append(gn.report_event(client_id=gn._uuid("honest", seed, i), kind=kinds[i % len(kinds)], coord=coord,
                                   observed=at, upload=at, party_key=f"sim_{i:016x}", incident_id="inc"))
    return out


REAL = {"type": "report", "evidence_class": "field_report", "at": "2018-11-08T15:00:00Z", "party_key": "dev_abc",
        "body": {"client_id": "11111111-1111-4111-8111-111111111111", "kind": "fire_seen",
                 "location": {"coord": [-121.6, 39.76], "accuracy_m": 5.0}, "observed_at": "2018-11-08T15:00:00Z"}}
RECORD_ROW = {"id": "camp-911-0001", "at": "2018-11-08T15:01:00Z", "channel": "911", "category": "fire_seen",
              "coord": [-121.6, 39.76], "evidence_class": "reported"}
CHANGES = (
    gn.TruthChange("c1", "skyway", T0 + timedelta(hours=1), (-121.60, 39.76), "road_passable", "road_blocked"),
    gn.TruthChange("c2", "skyway", T0 + timedelta(hours=3), (-121.60, 39.76), "road_blocked", "road_passable", silent=True),
    gn.TruthChange("c3", "pentz", T0 + timedelta(hours=2), (-121.55, 39.78), None, "fire_seen", label="spot fire"),
)


def binom_ok(count: int, n: int, p: float, z: float = 4.0) -> bool:
    mu, sd = n * p, math.sqrt(max(n * p * (1 - p), 1e-9))
    return abs(count - mu) <= z * sd + 1


class DeterminismTest(unittest.TestCase):
    def test_same_seed_same_output(self):
        evs = honest_reports(500)
        opt = gn.NoiseOptions(changes=CHANGES, incident_id="inc")
        a = gn.apply_noise(evs, "hostile", 7, opt)
        b = gn.apply_noise(evs, "hostile", 7, opt)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        c = gn.apply_noise(evs, "hostile", 8, opt)
        self.assertNotEqual(json.dumps(a[0], sort_keys=True), json.dumps(c[0], sort_keys=True))

    def test_per_event_streams(self):
        """Dropping one honest event does not change the noise drawn for the others."""
        evs = honest_reports(300)
        _, t_all = gn.apply_noise(evs, "typical", 3)
        _, t_less = gn.apply_noise(evs[1:], "typical", 3)
        for e in evs[1:]:
            eid = gn.event_id(e)
            if eid in t_all and eid in t_less:
                self.assertEqual(t_all[eid]["kind_of_noise"], t_less[eid]["kind_of_noise"])


class IntegrityTest(unittest.TestCase):
    def test_inputs_and_real_events_never_altered(self):
        evs = honest_reports(400) + [copy.deepcopy(REAL), copy.deepcopy(RECORD_ROW)]
        before = copy.deepcopy(evs)
        out, truth = gn.apply_noise(evs, "hostile", 5, gn.NoiseOptions(changes=CHANGES))
        self.assertEqual(evs, before)  # inputs untouched
        self.assertEqual(sum(1 for e in out if e == REAL), 1)
        self.assertEqual(sum(1 for e in out if e == RECORD_ROW), 1)
        self.assertNotIn(REAL["body"]["client_id"], truth)  # real reports are not scored
        self.assertNotIn(RECORD_ROW["id"], truth)
        self.assertFalse(any(e.get("party_key") == REAL["party_key"] for e in out if e is not None and e != REAL))

    def test_truth_completeness(self):
        evs = honest_reports(400) + [copy.deepcopy(REAL)]
        out, truth = gn.apply_noise(evs, "hostile", 11, gn.NoiseOptions(changes=CHANGES, incident_id="inc"))
        sim_ids = {gn.event_id(e) for e in out if gn.source_of(e) != "real"}
        event_keys = {k for k in truth if not k.startswith(gn.TRUTH_CHANGE_PREFIX)}
        self.assertEqual(sim_ids, event_keys)
        self.assertEqual({k for k in truth if k.startswith(gn.TRUTH_CHANGE_PREFIX)},
                         {gn.TRUTH_CHANGE_PREFIX + c.id for c in CHANGES})
        for k, e in truth.items():
            self.assertIsInstance(e["true"], bool, k)
            self.assertIn("notes", e)
            self.assertIn(e["kind_of_noise"], (None, "truth_change", *gn.NOISE_KINDS), k)
            if e["kind_of_noise"] in ("wrong_road", "gps_offset", "wrong_kind", "duplicate_resubmit", "duplicate_crowd"):
                self.assertIsNotNone(e["source_event_id"], k)
        for e in out:
            if gn.source_of(e) != "real":
                self.assertEqual(e["evidence_class"], "simulated")
        json.dumps(truth)  # storable

    def test_clean_profile_is_identity(self):
        evs = honest_reports(300)
        out, truth = gn.apply_noise(evs, "clean", 1)
        self.assertEqual(sorted(json.dumps(e, sort_keys=True) for e in out),
                         sorted(json.dumps(e, sort_keys=True) for e in evs))
        self.assertTrue(all(e["true"] and e["kind_of_noise"] is None for e in truth.values()))

    def test_injected_events_look_like_honest_ones(self):
        """Party keys and notes do not reveal noise to a console reading live data."""
        out, truth = gn.apply_noise(honest_reports(200), "hostile", 2)
        for e in out:
            self.assertRegex(e["party_key"], r"^sim_[0-9a-f]{16}$")
            self.assertEqual(e["body"]["note"], gn.REPORT_NOTE)


class RatesTest(unittest.TestCase):
    N = 6000

    def check_profile(self, name: str):
        prof = gn.PROFILES[name]
        evs = honest_reports(self.N)
        out, truth = gn.apply_noise(evs, name, 13)
        kinds = defaultdict(int)
        crowd_sources = set()
        for e in truth.values():
            kinds[e["kind_of_noise"]] += 1
            if e["kind_of_noise"] == "duplicate_crowd":
                crowd_sources.add(e["source_event_id"])
        n = self.N
        self.assertTrue(binom_ok(kinds["wrong_road"], n, prof.wrong_road_share), (name, kinds))
        self.assertTrue(binom_ok(kinds["gps_offset"], n, prof.gps_offset_share), (name, kinds))
        self.assertTrue(binom_ok(kinds["wrong_kind"], n, prof.wrong_kind_share), (name, kinds))
        self.assertTrue(binom_ok(kinds["late_upload"], n, prof.late_upload_share), (name, kinds))
        self.assertTrue(binom_ok(kinds["duplicate_resubmit"], n, prof.resubmit_share), (name, kinds))
        self.assertTrue(binom_ok(len(crowd_sources), n, prof.crowd_echo_share), (name, len(crowd_sources)))
        late = [e for e in truth.values() if "late_min" in e]
        if late:
            mins = sorted(e["late_min"] for e in late)
            self.assertLessEqual(mins[-1], gn.LATE_UPLOAD_MAX_MIN + 0.1)
            med = mins[len(mins) // 2]
            self.assertLess(abs(math.log(med / gn.LATE_UPLOAD_MEDIAN_MIN)), 0.35)
        hours = 6.0
        rumours = {e["rumour_id"] for e in truth.values() if e.get("rumour_id")}
        lam = prof.rumours_per_h * hours
        self.assertLessEqual(abs(len(rumours) - lam), 4 * math.sqrt(lam) + 1)
        return kinds

    def test_typical(self):
        k = self.check_profile("typical")
        self.assertEqual(k["malicious_burst"] + k["sybil"] + k["empty_help"], 0)

    def test_hostile(self):
        k = self.check_profile("hostile")
        self.assertGreater(k["wrong_road"], 0)

    def test_retry_storm_keeps_client_id(self):
        out, truth = gn.apply_noise(honest_reports(2000), "hostile", 4)
        counts = defaultdict(int)
        for e in out:
            counts[gn.event_id(e)] += 1
        storms = [k for k, e in truth.items() if e.get("retry_copies")]
        self.assertTrue(storms)
        for k in storms:
            self.assertEqual(counts[k], 1 + truth[k]["retry_copies"])
            self.assertEqual(truth[k]["kind_of_noise"] in ("late_upload", "wrong_road", "gps_offset", "wrong_kind"), True)


class StructureTest(unittest.TestCase):
    def test_rumour_correlation_structure(self):
        prof = replace(gn.PROFILES["hostile"], rumours_per_h=2.0)
        out, truth = gn.apply_noise(honest_reports(300), prof, 21)
        by_id = {gn.event_id(e): e for e in out}
        rumours = defaultdict(list)
        for k, e in truth.items():
            if e["kind_of_noise"] == "rumour":
                rumours[e["rumour_id"]].append((k, e))
        self.assertGreaterEqual(len(rumours), 5)
        for rid, members in rumours.items():
            self.assertGreaterEqual(len(members), gn.RUMOUR_MIN_PARTIES)
            self.assertTrue(all(not e["true"] for _, e in members))
            self.assertEqual(len({e["claim"] for _, e in members}), 1)
            self.assertEqual(len({by_id[k]["party_key"] for k, _ in members}), len(members))  # distinct parties
            self.assertEqual(sum(1 for _, e in members if e["rumour_seed"]), 1)
            onset = gn.parse_utc(members[0][1]["rumour_onset_at"])
            times = sorted(gn.upload_at(by_id[k]) for k, _ in members)
            self.assertEqual(times[0], onset)
            place = members[0][1]["rumour_place"]
            for k, _ in members:  # correlated: all pins near one claimed place
                self.assertLess(gn.distance_m(gn.coord_of(by_id[k]), place), 6 * gn.RUMOUR_COORD_SIGMA_M)

    def test_timeline_truth(self):
        evs = [gn.report_event(client_id=gn._uuid("t", i), kind=k, coord=(-121.60, 39.76), observed=at, upload=at,
                               party_key=f"sim_{i:016x}", incident_id="inc")
               for i, (k, at) in enumerate([("road_passable", T0 + timedelta(minutes=30)),
                                            ("road_blocked", T0 + timedelta(minutes=30)),
                                            ("road_blocked", T0 + timedelta(hours=2)),
                                            ("road_blocked", T0 + timedelta(hours=4))])]
        prof = replace(gn.PROFILES["clean"], outdated_per_change=5.0, change_signals_per_change=5.0)
        out, truth = gn.apply_noise(evs, prof, 1, gn.NoiseOptions(changes=CHANGES))
        t = [truth[gn.event_id(e)] for e in evs]
        self.assertTrue(t[0]["true"])
        self.assertEqual(t[0]["true_until"], "2018-11-08T15:30:00Z")  # skyway closes at 15:30
        self.assertFalse(t[1]["true"])  # blocked before it was
        self.assertTrue(t[2]["true"])
        self.assertEqual(t[2]["true_until"], "2018-11-08T17:30:00Z")  # reopens (silently) at 17:30
        self.assertFalse(t[3]["true"])  # stale: after the silent reopening
        kinds = defaultdict(list)
        for e in truth.values():
            kinds[e["kind_of_noise"]].append(e)
        self.assertTrue(all(not e["true"] for e in kinds["outdated"]))
        self.assertTrue(kinds["change_signal"] and all(e["true"] for e in kinds["change_signal"]))
        self.assertNotIn("c2", {e["change_id"] for e in kinds["change_signal"]})  # silent change: no signal

    def test_wrong_road_uses_road_list(self):
        roads = (gn.RoadRef("a", "Skyway", ((-121.61, 39.76), (-121.59, 39.76))),
                 gn.RoadRef("b", "Clark Rd", ((-121.61, 39.763), (-121.59, 39.763))))
        evs = [gn.report_event(client_id=gn._uuid("w", i), kind="road_blocked", coord=(-121.60, 39.76),
                               observed=T0, upload=T0, party_key=f"sim_{i:016x}", incident_id="inc") for i in range(300)]
        prof = replace(gn.PROFILES["clean"], wrong_road_share=1.0)
        out, truth = gn.apply_noise(evs, prof, 3, gn.NoiseOptions(roads=roads))
        for e in out:
            self.assertAlmostEqual(gn.coord_of(e)[1], 39.763, places=5)  # moved onto the parallel road
            self.assertEqual(truth[gn.event_id(e)]["kind_of_noise"], "wrong_road")

    def test_malicious_and_out_of_area(self):
        evs = honest_reports(300)
        prof = replace(gn.PROFILES["hostile"], bursts_per_h=1.0, sybil_sets_per_h=1.0, empty_help_per_h=3.0)
        out, truth = gn.apply_noise(evs, prof, 9)
        by_id = {gn.event_id(e): e for e in out}
        attacks = defaultdict(list)
        for k, e in truth.items():
            if e["kind_of_noise"] in ("malicious_burst", "sybil"):
                attacks[(e["kind_of_noise"], e["attack_id"])].append(by_id[k])
            if e["kind_of_noise"] == "out_of_area":
                self.assertGreaterEqual(e["distance_from_centre_km"], gn.OUT_OF_AREA_KM[0] - 1)
            if e["kind_of_noise"] in ("malicious_burst", "sybil", "empty_help", "out_of_area", "rumour"):
                self.assertFalse(e["true"])
        honest_pts = [gn.coord_of(e) for e in evs]
        for k, e in truth.items():
            if e["kind_of_noise"] == "empty_help":
                self.assertGreaterEqual(min(gn.distance_m(e["coord"], p) for p in honest_pts), gn.EMPTY_HELP_MIN_DIST_M)
        bursts = [v for (kind, _), v in attacks.items() if kind == "malicious_burst"]
        sybils = [v for (kind, _), v in attacks.items() if kind == "sybil"]
        self.assertTrue(bursts and sybils)
        for b in bursts:
            self.assertEqual(len({e["party_key"] for e in b}), 1)
            span = max(gn.upload_at(e) for e in b) - min(gn.upload_at(e) for e in b)
            self.assertLessEqual(span.total_seconds(), gn.BURST_SPAN_S)
            self.assertGreater(len(b), 6)  # above the server's 6 reports per minute
        for s in sybils:
            s = sorted(s, key=gn.upload_at)
            self.assertEqual(len({e["party_key"] for e in s}), prof.sybil_devices)
            for a, b in zip(s, s[1:]):  # each pair outside the server's same-party rule
                self.assertGreater((gn.upload_at(b) - gn.upload_at(a)).total_seconds(), public.SAME_PARTY_WINDOW_S)

    def test_outage_delays_uploads(self):
        evs = honest_reports(400, hours=2.0)
        start, end = T0 + timedelta(minutes=30), T0 + timedelta(minutes=60)
        out, truth = gn.apply_noise(evs, "clean", 1, gn.NoiseOptions(outages=((start, end, None, 0.0),)))
        for e in out:
            obs = gn.observed_at(e)
            if start <= obs < end:
                self.assertGreaterEqual(gn.upload_at(e), end)
                self.assertLessEqual((gn.upload_at(e) - end).total_seconds(), gn.OUTAGE_RETRY_JITTER_S)
                self.assertEqual(truth[gn.event_id(e)]["kind_of_noise"], "late_upload")


@unittest.skipUnless(RECORD.exists(), "tools/camp_ground_record.json not present")
class CalibrationTest(unittest.TestCase):
    def test_duplicate_rates_from_2018_record(self):
        rec = json.loads(RECORD.read_text())
        a2 = rec["extraction"]["Table A-2 (911 and Radio Log rows)"]
        self.assertEqual(a2["rows_dropped"]["duplicate_quote_merged"], gn.CAMP_A2_DUPLICATE_QUOTES_MERGED)
        rows = [i for i in rec["items"] if i["channel"] in ("911", "radio") and i.get("coord")]
        self.assertEqual(len(rows), gn.CAMP_ROWS_WITH_POINT)
        self.assertEqual(sum(1 for i in rec["items"] if i["channel"] in ("911", "radio")), gn.CAMP_A2_ROWS_KEPT)

        def t(i):
            return gn.parse_utc(i["at"])

        groups: list[list[dict]] = []
        for i in sorted(rows, key=lambda i: (t(i), i["id"])):
            for g in groups:
                if (g[0]["category"] == i["category"] and g[0]["coord"] == i["coord"]
                        and (t(i) - t(g[0])).total_seconds() <= gn.CROWD_ECHO_WINDOW_MIN * 60):
                    g.append(i)
                    break
            else:
                groups.append([i])
        self.assertEqual(len(groups), gn.CAMP_SAME_EVENT_GROUPS)
        repeated = [len(g) - 1 for g in groups if len(g) > 1]
        self.assertEqual(len(repeated), gn.CAMP_REPEATED_GROUPS)
        dist = defaultdict(int)
        for x in repeated:
            dist[x] += 1
        self.assertEqual(tuple(sorted(dist.items())), gn.CROWD_ECHO_EXTRA_DIST_CAMP)


def facts(events):
    out = []
    for i, ev in enumerate(events):
        b, at = ev["body"], gn.upload_at(ev)
        out.append(public.ReportFact(id=f"r{i}", kind=b["kind"], severity=b.get("severity"),
                                     coord=tuple(b["location"]["coord"]), party_key=ev["party_key"], role="civilian",
                                     observed_at=gn.parse_utc(b["observed_at"]), received_at=at, status="unverified",
                                     segment_id="seg", segment_name=None, destination_id=None, replay_at=at))
    return out


class CorroborationTest(unittest.TestCase):
    """Today's independent_counts treats correlated rumour and Sybil parties as independent; the
    source-diversity flag (off by default) folds them, and also folds a true crowd (ADR 0042)."""

    def groups(self, seeds=range(12)):
        prof = replace(gn.PROFILES["hostile"], rumours_per_h=1.0, change_signals_per_change=6.0)
        out_groups = defaultdict(list)
        for seed in seeds:
            changes = tuple(gn.TruthChange(f"c{seed}-{k}", f"p{seed}-{k}", T0 + timedelta(hours=1 + k),
                                           (CENTRE[0] + 0.02 * k, CENTRE[1]), "road_passable", "road_blocked")
                            for k in range(3))
            out, truth = gn.apply_noise(honest_reports(50, seed=seed), prof, seed, gn.NoiseOptions(changes=changes))
            for ev in out:
                e = truth[gn.event_id(ev)]
                key = {"rumour": e.get("rumour_id"), "sybil": e.get("attack_id"),
                       "change_signal": e.get("change_id")}.get(e["kind_of_noise"])
                if key:
                    out_groups[(e["kind_of_noise"], key)].append(ev)
        return out_groups

    def test_default_off(self):
        self.assertFalse(public.SOURCE_DIVERSITY_ENABLED)

    def test_correlated_parties_counted_as_independent(self):
        counted = defaultdict(lambda: [0, 0, 0])  # parties, counted off, counted on
        for (kind, _), evs in self.groups().items():
            if len(evs) < 2:
                continue
            f = facts(evs)
            c = counted[kind]
            c[0] += len({x.party_key for x in f})
            c[1] += public.independent_counts(f, source_diversity=False)[0]
            c[2] += public.independent_counts(f, source_diversity=True)[0]
        rumour, sybil, crowd = counted["rumour"], counted["sybil"], counted["change_signal"]
        self.assertGreater(rumour[0], 20)
        self.assertGreaterEqual(rumour[1] / rumour[0], 0.9)  # flag off: rumour parties count as independent
        self.assertEqual(sybil[1], sybil[0])  # every Sybil device counts
        self.assertLess(rumour[2] / rumour[0], 0.5)  # flag on: folded ...
        self.assertLess(sybil[2] / sybil[0], 0.5)
        self.assertLess(crowd[2] / crowd[0], 0.6)  # ... and so is a true crowd: the cost of the check

    def test_flag_folds_a_sybil_set_on_road_state(self):
        evs = [gn.report_event(client_id=gn._uuid("s", i), kind="road_blocked",
                               coord=gn.offset(CENTRE, 150.0 * i, 0.0), observed=T0 + timedelta(seconds=150 * i),
                               upload=T0 + timedelta(seconds=150 * i), party_key=f"sim_{i:016x}", incident_id="inc")
               for i in range(3)]
        f = facts(evs)
        wall = T0 + timedelta(minutes=10)
        off = public.road_state(f, wall)[0]
        self.assertEqual((off.status, off.independent_parties, off.public), ("blocked", 3, True))
        public.SOURCE_DIVERSITY_ENABLED = True
        try:
            on = public.road_state(f, wall)[0]
        finally:
            public.SOURCE_DIVERSITY_ENABLED = False
        self.assertEqual((on.status, on.independent_parties, on.public), ("blocked", 1, False))


class EvaluationMetricsTest(unittest.TestCase):
    def test_triage_metrics_are_secondary_and_match_the_scorer(self):
        from sim import triage_quality as tq

        self.assertTrue(all(m.family == "secondary" for m in TRIAGE_METRICS))
        score = tq.score_triage({}, [], [], T0)
        self.assertEqual(set(tq.manifest_metrics(score)), {m.name for m in TRIAGE_METRICS})


if __name__ == "__main__":
    unittest.main()
