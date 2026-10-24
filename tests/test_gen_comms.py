"""Tests for sim/gen_comms.py: the comms generator on a synthetic 10-zone scenario, plus a Camp
reproduction when the replay bundle is present.

Run from the repository root: python3.12 -m unittest tests.test_gen_comms
"""

from __future__ import annotations

import json
import math
import statistics
import sys
import unittest
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sim import gen_comms as gc  # noqa: E402
from sim import ground_rates as gr  # noqa: E402
from tools.camp_ground_record import CATEGORY_LABELS, summary_for  # noqa: E402

PARAMS_PATH = ROOT / "tests" / "fixtures" / "ground_rates_camp_2018.json"
PARAMS = gc.params_from_dict(json.loads(PARAMS_PATH.read_text()))
HAVE_BUNDLE = gr.RECORD_PATH.exists() and gr.BUNDLE_PATH.exists()

T0 = datetime(2026, 7, 1, 14, 0, tzinfo=timezone.utc)
WINDOW = (T0, T0 + timedelta(hours=6))
LON0, LAT0 = -121.60, 39.75
SIDE_DEG = 0.01  # about 0.86 km (lon) x 1.1 km (lat)


def square(col: int, row: int) -> dict:
    x0, y0 = LON0 + col * SIDE_DEG, LAT0 + row * SIDE_DEG
    ring = [[x0, y0], [x0 + SIDE_DEG, y0], [x0 + SIDE_DEG, y0 + SIDE_DEG], [x0, y0 + SIDE_DEG], [x0, y0]]
    return {"type": "Polygon", "coordinates": [ring]}


def synthetic_zones() -> list[gc.CommsZone]:
    """10 zones in a 5 x 2 grid; the fire crosses columns 30 min apart from T0+60 min; orders
    come 20 min before arrival; column 4 is never reached and never ordered."""
    zones = []
    for col in range(5):
        for row in range(2):
            arrival = T0 + timedelta(minutes=60 + 30 * col) if col < 4 else None
            zones.append(gc.CommsZone(
                id=f"z{col}{row}", households=300 + 100 * (col + row),
                centroid_lonlat=(LON0 + (col + 0.5) * SIDE_DEG, LAT0 + (row + 0.5) * SIDE_DEG),
                geometry=square(col, row), fire_arrival_at=arrival,
                order_at=arrival - timedelta(minutes=20) if arrival else None))
    return zones


def synthetic_roads() -> list[gc.RoadEdge]:
    """Two named east-west roads through the grid and one unnamed one."""
    roads = []
    for i, (name, row) in enumerate((("Ridge Road", 0.5), ("Valley Road", 1.5), (None, 1.0))):
        lat = LAT0 + row * SIDE_DEG
        roads.append(gc.RoadEdge(id=f"e{i}", name=name, coords=((LON0 - 0.01, lat), (LON0 + 0.06, lat))))
    return roads


ZONES = synthetic_zones()
ROADS = synthetic_roads()


def expected_count(zone: gc.CommsZone, channel: str, scale: float) -> float:
    """Independent restatement of the target: GLM rate from the fit's coefficients, integrated at
    1-minute steps over the window, with the lead-time band rule and the order phases."""
    fit = next(f for f in PARAMS.rate_fits if f.channel == channel)
    coef = dict(zip(fit.terms, fit.coef))
    total, t = 0.0, WINDOW[0]
    while t < WINDOW[1]:
        mid = t + timedelta(seconds=30)
        eta = coef["intercept"]
        if zone.fire_arrival_at and mid >= zone.fire_arrival_at:
            eta += coef["band:fire_in_zone"]
        elif zone.fire_arrival_at and zone.fire_arrival_at - mid <= timedelta(minutes=gc.ASSUMED_LT5KM_LEAD_MIN):
            eta += coef["band:lt_5km"]
        if zone.order_at and mid >= zone.order_at:
            eta += coef["phase:order_0_2h"] if mid - zone.order_at < timedelta(hours=2) else coef["phase:order_ge_2h"]
        total += math.exp(eta) * zone.households / 1000 / 60 * scale
        t += timedelta(minutes=1)
    return total


def zone_of(item: dict) -> str:
    return item["source_locator"].rsplit("zone ", 1)[1]


def run(seed: int, **options) -> list[dict]:
    return gc.generate_comms(ZONES, ROADS, WINDOW, PARAMS, seed, gc.CommsOptions(**options))


class Many:
    """Items for many seeds, generated once per option set."""

    cache: dict = {}

    @classmethod
    def get(cls, n: int, **options) -> list[list[dict]]:
        key = (n, tuple(sorted(options.items())))
        if key not in cls.cache:
            cls.cache[key] = [run(seed, **options) for seed in range(n)]
        return cls.cache[key]


class TestDeterminism(unittest.TestCase):
    def test_same_seed_same_items(self):
        self.assertEqual(run(7), run(7))

    def test_different_seed_different_items(self):
        self.assertNotEqual(run(7), run(8))

    def test_zone_streams_are_independent_of_other_zones(self):
        """Adding a zone does not change another zone's items (per-zone seeded sub-streams)."""
        def strip(items, zid):
            return [{k: v for k, v in it.items() if k != "id"} for it in items if zone_of(it) == zid]

        both = gc.generate_comms(ZONES, ROADS, WINDOW, PARAMS, 3)
        one = gc.generate_comms([z for z in ZONES if z.id != "z00"], ROADS, WINDOW, PARAMS, 3)
        self.assertEqual(strip(both, "z11"), strip(one, "z11"))


class TestRates(unittest.TestCase):
    N = 600

    def check_recovery(self, options: dict, scale_911: float):
        runs = Many.get(self.N, **options)
        for ch in gr.RATE_CHANNELS:
            counts = [sum(1 for it in items if it["channel"] == ch) for items in runs]
            target = sum(expected_count(z, ch, scale_911 if ch == "911" else 1.0) for z in ZONES)
            mean, se = statistics.fmean(counts), statistics.stdev(counts) / math.sqrt(len(counts))
            with self.subTest(channel=ch, mean=round(mean, 2), target=round(target, 2), se=round(se, 2)):
                self.assertLess(abs(mean - target), 4 * se)
                self.assertLess(abs(mean - target) / target, 0.10)

    def test_rate_recovery_overdispersed(self):
        self.check_recovery({}, PARAMS.scale_911_at_least)

    def test_rate_recovery_poisson_nist_sample_like(self):
        self.check_recovery({"overdispersion": False, "nist_sample_like": True}, 1.0)

    def test_default_scale_is_calibrated_lower_bound(self):
        self.assertAlmostEqual(gc.CommsOptions().resolved_scale_911(PARAMS), 132 / 36)
        self.assertEqual(gc.CommsOptions(nist_sample_like=True).resolved_scale_911(PARAMS), 1.0)

    def test_fire_in_zone_rate_ratio_about_15(self):
        for ch in gr.RATE_CHANNELS:
            rr = gc.rate_per_khh_h(PARAMS, ch, "fire_in_zone", "before_order") / \
                gc.rate_per_khh_h(PARAMS, ch, "ge_5km_or_unreached", "before_order")
            self.assertTrue(14 < rr < 16, (ch, rr))


class TestOverdispersion(unittest.TestCase):
    def zone_counts(self, options: dict, zid: str = "z31", ch: str = "911") -> list[int]:
        return [sum(1 for it in items if it["channel"] == ch and zone_of(it) == zid)
                for items in Many.get(TestRates.N, **options)]

    def test_overdispersion_present(self):
        counts = self.zone_counts({})
        mean, var = statistics.fmean(counts), statistics.variance(counts)
        k = gc.gamma_shape(next(f for f in PARAMS.rate_fits if f.channel == "911"))
        predicted = 1 + mean / k  # NB2 variance-to-mean ratio
        self.assertGreater(var / mean, 3.0)
        self.assertTrue(0.5 * predicted < var / mean < 2.0 * predicted, (var / mean, predicted))

    def test_poisson_without_zone_factor(self):
        counts = self.zone_counts({"overdispersion": False})
        ratio = statistics.variance(counts) / statistics.fmean(counts)
        self.assertTrue(0.8 < ratio < 1.25, ratio)

    def test_gamma_shapes_from_fit(self):
        for fit in PARAMS.rate_fits:
            k = gc.gamma_shape(fit)
            self.assertAlmostEqual(1 + (fit.n_events / fit.n_units) / k, fit.dispersion)
        shared, extra = gc.zone_factor_shapes(PARAMS, gr.RATE_CHANNELS)
        for fit in PARAMS.rate_fits:  # product of the two mean-1 gammas has variance 1/k
            h = extra[fit.channel]
            var = (1 + 1 / shared) * (1 + (0 if math.isinf(h) else 1 / h)) - 1
            self.assertAlmostEqual(var, 1 / gc.gamma_shape(fit))


class TestCategories(unittest.TestCase):
    def shares(self, ch: str) -> dict[str, Counter]:
        arrival = {z.id: z.fire_arrival_at for z in ZONES}
        out = defaultdict(Counter)
        for items in Many.get(TestRates.N):
            for it in items:
                if it["channel"] != ch:
                    continue
                at, arr = gr.parse_utc(it["at"]), arrival[zone_of(it)]
                out["after_arrival" if arr and at >= arr else "before_arrival"][it["category"]] += 1
        return out

    def test_category_mix_shift_911(self):
        got = self.shares("911")
        mix = {phase: dict(s) for ch, phase, s, _ in PARAMS.category_mix if ch == "911"}
        for phase in ("before_arrival", "after_arrival"):
            n = sum(got[phase].values())
            self.assertGreater(n, 500)
            for cat, share in mix[phase].items():
                self.assertAlmostEqual(got[phase][cat] / n, share, delta=0.04, msg=(phase, cat))
        before = got["before_arrival"]["trapped"] / sum(got["before_arrival"].values())
        after = got["after_arrival"]["trapped"] / sum(got["after_arrival"].values())
        self.assertGreater(after, before + 0.08)  # 0.04 -> 0.19 in the calibration

    def test_rescue_only_help_or_trapped(self):
        got = self.shares("rescue")
        self.assertLessEqual(set(got["before_arrival"]) | set(got["after_arrival"]), {"help_needed", "trapped"})


class TestWindowAndReroute(unittest.TestCase):
    def test_no_items_outside_window_and_time_ordered(self):
        for items in Many.get(50):
            ats = [gr.parse_utc(it["at"]) for it in items]
            self.assertEqual(ats, sorted(ats))
            self.assertTrue(all(WINDOW[0] <= at < WINDOW[1] for at in ats))

    def test_short_window(self):
        window = (T0 + timedelta(minutes=95), T0 + timedelta(minutes=125))
        items = gc.generate_comms(ZONES, ROADS, window, PARAMS, 1)
        self.assertTrue(items)
        self.assertTrue(all(window[0] <= gr.parse_utc(it["at"]) < window[1] for it in items))

    def test_invalid_windows_rejected(self):
        with self.assertRaises(ValueError):
            gc.generate_comms(ZONES, ROADS, (WINDOW[1], WINDOW[0]), PARAMS, 1)
        with self.assertRaises(ValueError):
            gc.generate_comms(ZONES, ROADS, (T0 + timedelta(seconds=30), WINDOW[1]), PARAMS, 1)
        with self.assertRaises(ValueError):
            gc.generate_comms(ZONES, ROADS, (T0.replace(tzinfo=None), WINDOW[1]), PARAMS, 1)

    def test_psap_reroute(self):
        reroute = T0 + timedelta(minutes=140)
        for seed in range(20):
            base = run(seed)
            cut = run(seed, psap_reroute_at=reroute)

            def key(it):
                return {k: v for k, v in it.items() if k not in ("id", "params_hash", "source_locator")}

            late_911 = [it for it in cut if it["channel"] == "911" and gr.parse_utc(it["at"]) >= reroute]
            self.assertEqual(late_911, [])
            self.assertEqual([key(it) for it in base if it["channel"] != "911" or gr.parse_utc(it["at"]) < reroute],
                             [key(it) for it in cut])
        self.assertTrue(any(it["channel"] == "911" and gr.parse_utc(it["at"]) >= reroute for it in run(0)))


class TestRescueConditioning(unittest.TestCase):
    def test_bound_share(self):
        """A share of rescue entries takes the time and point of a 911 help/trapped call."""
        hit = total = 0
        for items in Many.get(200, nist_sample_like=True):
            calls = {(it["at"], tuple(it["coord"])) for it in items
                     if it["channel"] == "911" and it["category"] in gc.RESCUE_BIND_CATEGORIES}
            for it in items:
                if it["channel"] == "rescue":
                    total += 1
                    hit += (it["at"], tuple(it["coord"])) in calls
        share = hit / total
        self.assertTrue(0.5 * gc.rescue_bind_share(PARAMS) < share <= gc.rescue_bind_share(PARAMS) + 0.03, share)


class TestSchema(unittest.TestCase):
    def test_items_match_ground_record_schema(self):
        record = json.loads(gr.RECORD_PATH.read_text())["items"]
        ref = record[0]
        record_keys = set(ref)
        record_cats = defaultdict(set)
        for row in record:
            record_cats[row["channel"]].add(row["category"])
        geometry = {z.id: z.geometry for z in ZONES}
        road_names = {r.name for r in ROADS if r.name}
        items = run(11)
        self.assertGreater(len(items), 50)
        for it in items:
            self.assertEqual(set(it), record_keys | {"generator", "params_hash", "seed"})
            for k in record_keys - {"text_sha12", "road_name", "coord"}:
                self.assertIsInstance(it[k], type(ref[k]), k)
            self.assertIsNone(it["text_sha12"])
            self.assertRegex(it["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$")
            self.assertEqual(it["time_precision"], "minute")
            self.assertEqual(it["evidence_class"], "simulated")
            self.assertIn(it["category"], record_cats[it["channel"]])
            self.assertIn(it["category"], CATEGORY_LABELS)
            self.assertEqual(it["summary"], summary_for(it["channel"], it["category"], it["road_name"]))
            self.assertEqual(it["seed"], 11)
            self.assertRegex(it["params_hash"], r"^[0-9a-f]{12}$")
            lon, lat = it["coord"]  # every item has a point (the review queue needs one)
            self.assertEqual([round(lon, 3), round(lat, 3)], it["coord"])
            if it["category"] in gc.ROAD_CATEGORIES:
                self.assertIn(it["road_name"], road_names)
            else:
                self.assertIsNone(it["road_name"])
                self.assertTrue(gr.point_in_geometry(lon, lat, geometry[zone_of(it)]))
        self.assertEqual(len({it["id"] for it in items}), len(items))

    def test_road_items_on_a_named_road(self):
        lats = {round(LAT0 + 0.5 * SIDE_DEG, 3), round(LAT0 + 1.5 * SIDE_DEG, 3)}
        road_items = [it for items in Many.get(50) for it in items if it["category"] in gc.ROAD_CATEGORIES]
        self.assertTrue(road_items)
        self.assertTrue(all(it["coord"][1] in lats for it in road_items))

    def test_write_items_json(self):
        import tempfile
        items = run(2)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "comms.json"
            gc.write_items_json(path, items, seed=2, params_hash_hex=items[0]["params_hash"])
            doc = json.loads(path.read_text())
        self.assertEqual(doc["items"], items)
        self.assertEqual(doc["evidence_class"], "simulated")


class TestDistanceFunction(unittest.TestCase):
    def test_band_from_distance_and_derived_arrival(self):
        hit = T0 + timedelta(minutes=90)

        def dist(at):  # front 9 km out at T0, closing at 100 m/min, in the zone from T0+90
            return max(0.0, 9_000 - 100 * (at - T0).total_seconds() / 60)

        zone = gc.CommsZone(id="d", households=500, centroid_lonlat=(LON0, LAT0), geometry=square(0, 0),
                            fire_distance_m=dist)
        arrival = gc._arrival(zone, WINDOW)
        self.assertEqual(arrival, hit)
        self.assertEqual(gc.distance_band(zone, arrival, T0 + timedelta(minutes=30)), "ge_5km_or_unreached")
        self.assertEqual(gc.distance_band(zone, arrival, T0 + timedelta(minutes=50)), "lt_5km")
        self.assertEqual(gc.distance_band(zone, arrival, hit), "fire_in_zone")


@unittest.skipUnless(HAVE_BUNDLE, "record or replay bundle missing")
class TestCamp(unittest.TestCase):
    def test_fixture_matches_fit(self):
        self.assertEqual(PARAMS, gr.fit_camp_2018())

    def test_expected_counts_reproduce_record(self):
        """On the Camp bundle zones at scale 1, the generator's expected count in each channel's
        coverage window equals the record's count within 2% (GLM sum property)."""
        bundle = gr.load_json(gr.BUNDLE_PATH)
        zones = gc.zones_from_bundle(bundle)
        for fit in PARAMS.rate_fits:
            w0, w1 = gr.parse_utc(fit.window_utc[0]), gr.parse_utc(fit.window_utc[1])
            total = 0.0
            for z in zones:
                arrival = gc._arrival(z, (w0, w1))
                t = w0
                while t < w1:
                    total += gc.zone_rate_per_h(PARAMS, z, arrival, fit.channel, t + timedelta(minutes=5)) / 6
                    t += timedelta(minutes=10)
            with self.subTest(channel=fit.channel, expected=round(total, 1), record=fit.n_events):
                self.assertLess(abs(total - fit.n_events) / fit.n_events, 0.02)


if __name__ == "__main__":
    unittest.main()
