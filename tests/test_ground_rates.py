"""Tests for sim/ground_rates.py: the stdlib statistics, then the Camp 2018 fit end to end.

Run from the repository root: python3.12 -m unittest tests.test_ground_rates
"""

from __future__ import annotations

import dataclasses
import math
import random
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sim import ground_rates as gr  # noqa: E402

HAVE_INPUTS = gr.RECORD_PATH.exists() and gr.BUNDLE_PATH.exists()


def poisson_draw(rng: random.Random, lam: float) -> int:
    """Knuth's multiplication method (TAOCP vol. 2, 3.4.1); fine for small lambda."""
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


class StatisticsTests(unittest.TestCase):
    def test_quantile_is_type_7(self):
        # numpy.quantile([1, 2, 3, 4], 0.25) == 1.75 (linear interpolation, type 7)
        self.assertAlmostEqual(gr.quantile([4, 1, 3, 2], 0.25), 1.75)
        self.assertAlmostEqual(gr.quantile([1, 2, 3, 4], 0.5), 2.5)

    def test_poisson_ci_matches_exact_values(self):
        # Exact (Garwood) 95% limits: x=0 -> (0, 3.689); x=10 -> (4.795, 18.390).
        lo, hi = gr.poisson_ci(0)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 3.6889, places=3)
        lo, hi = gr.poisson_ci(10)
        self.assertAlmostEqual(lo, 4.795, delta=0.02)
        self.assertAlmostEqual(hi, 18.390, delta=0.05)

    def test_glm_saturated_one_factor_reproduces_group_rates(self):
        # With one indicator the MLE is closed form: exp(b0) = y0/E0, exp(b0+b1) = y1/E1.
        x = [[1.0, 0.0]] * 3 + [[1.0, 1.0]] * 3
        y = [2.0, 0.0, 4.0, 9.0, 7.0, 8.0]
        exposure = [1.0, 2.0, 3.0, 1.5, 1.5, 1.0]
        fit = gr.fit_poisson_glm(x, y, [math.log(e) for e in exposure])
        self.assertTrue(fit["converged"])
        self.assertAlmostEqual(math.exp(fit["beta"][0]), 6 / 6, places=8)
        self.assertAlmostEqual(math.exp(fit["beta"][0] + fit["beta"][1]), 24 / 4, places=8)
        # Standard error of a log rate with y events is 1/sqrt(y).
        self.assertAlmostEqual(fit["se"][0], 1 / math.sqrt(6), places=6)

    def test_glm_recovers_simulated_coefficients(self):
        rng = random.Random(gr.BOOTSTRAP_SEED)
        true = (-0.7, 1.3, -0.9)
        x, y, off = [], [], []
        for _ in range(3000):
            a, b = float(rng.random() < 0.4), float(rng.random() < 0.5)
            exposure = 0.5 + rng.random()
            lam = exposure * math.exp(true[0] + true[1] * a + true[2] * b)
            x.append([1.0, a, b])
            y.append(float(poisson_draw(rng, lam)))
            off.append(math.log(exposure))
        fit = gr.fit_poisson_glm(x, y, off)
        for est, se, t in zip(fit["beta"], fit["se"], true):
            self.assertLess(abs(est - t), 3.5 * se, (est, se, t))
        self.assertLess(abs(fit["dispersion"] - 1.0), 0.15)  # Poisson data are not overdispersed

    def test_bootstrap_is_seeded(self):
        vals = [float(v) for v in range(50)]
        self.assertEqual(gr.bootstrap_ci(vals), gr.bootstrap_ci(vals))

    def test_parse_utc_rejects_naive_time(self):
        with self.assertRaises(ValueError):
            gr.parse_utc("2018-11-08T07:00:00")


@unittest.skipUnless(HAVE_INPUTS, "record or replay bundle missing")
class CampFitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = gr.load_json(gr.BUNDLE_PATH)
        cls.analysis = gr.analyse(gr.load_json(gr.RECORD_PATH), cls.bundle)
        cls.params = cls.analysis.params

    def test_arrival_grid_projection_matches_bundle(self):
        # Guards the metre conversion used for every distance: our Grid must reproduce the
        # bundle's stored metres per degree.
        grid, minutes, t0 = gr.arrival_grid(self.bundle)
        stored = self.bundle["fire_simulated"]["arrival_grid"]
        self.assertAlmostEqual(grid._m_per_deg_lon / stored["m_per_deg_lon"], 1.0, places=9)
        self.assertAlmostEqual(grid._m_per_deg_lat / stored["m_per_deg_lat"], 1.0, places=9)
        self.assertEqual(len(minutes), grid.ncols * grid.nrows)
        self.assertEqual(gr.format_utc(t0), "2018-11-08T14:20:00Z")

    def test_record_counts(self):
        p = self.params
        self.assertEqual(p.record_911_rows, 93)
        self.assertLessEqual(p.record_911_distinct_calls, p.record_911_rows)
        by_channel = {}
        for r in self.analysis.rows:
            by_channel[r.channel] = by_channel.get(r.channel, 0) + 1
        self.assertEqual(by_channel, {"911": 93, "radio": 263, "rescue": 196, "notification": 35, "evacuation": 18})

    def test_rate_fits_are_sane(self):
        for fit in self.params.rate_fits:
            self.assertTrue(fit.converged, fit.channel)
            self.assertGreater(fit.n_events, 0)
            self.assertLessEqual(fit.deviance, fit.null_deviance)
            self.assertTrue(0.0 <= fit.pseudo_r2 < 1.0)
            # Fitted totals equal observed totals for a Poisson GLM with an intercept.
            units = self.analysis.units[fit.channel]
            self.assertEqual(sum(u["y"] for u in units), fit.n_events)

    def test_empirical_rates_are_non_negative_and_bracketed(self):
        for _, _, _, y, e, rate, lo, hi in self.params.empirical_rates:
            self.assertGreater(e, 0)
            self.assertGreaterEqual(rate, 0)
            self.assertLessEqual(lo, rate + 1e-12)
            self.assertGreaterEqual(hi, rate)

    def test_exposure_equals_households_times_hours(self):
        hh_k = sum(z.households for z in self.analysis.zones) / 1000
        for fit in self.params.rate_fits:
            start, end = (gr.parse_utc(t) for t in fit.window_utc)
            hours = (end - start).total_seconds() / 3600
            self.assertAlmostEqual(fit.exposure_khh_h, hh_k * hours, places=6)

    def test_911_scaling_is_a_lower_bound_above_one(self):
        p = self.params
        self.assertGreater(p.record_911_calls_in_ppd_window, 0)
        self.assertAlmostEqual(p.scale_911_at_least, gr.PPD_911_CALLS_AT_LEAST / p.record_911_calls_in_ppd_window)
        self.assertGreater(p.scale_911_at_least, 1.0)

    def test_params_frozen_and_deterministic(self):
        with self.assertRaises(dataclasses.FrozenInstanceError):
            self.params.radio_to_911_ratio = 0.0  # type: ignore[misc]
        again = gr.analyse(gr.load_json(gr.RECORD_PATH), self.bundle).params
        self.assertEqual(repr(again), repr(self.params))  # repr: NaN-safe equality

    def test_category_shares_sum_to_one(self):
        for _, _, shares, n in self.params.category_mix:
            if n:
                self.assertAlmostEqual(sum(s for _, s in shares), 1.0, places=9)


if __name__ == "__main__":
    unittest.main()
