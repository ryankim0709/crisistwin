"""Known-answer and determinism tests for sim/evaluation.py (docs/strategy-evaluation.md).

Run from the repository root: python3 -m unittest tests.test_evaluation -v
"""

from __future__ import annotations

import json
import math
import random
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sim.evaluation import (  # noqa: E402
    MetricSpec,
    RunManifest,
    bootstrap_ci,
    chi2_ppf,
    cliffs_delta,
    cohens_dz,
    compare_strategies,
    derive_seed,
    design_issues,
    hash_json,
    holm,
    magnitude,
    pair_runs,
    paired_differences,
    paired_dominance,
    paired_power,
    paired_sample_size,
    plan_from_pilot,
    quantile,
    results_table_json,
    results_table_markdown,
    sd_upper_bound,
    seed_panel,
    sign_flip_test,
)


def run(strategy_id: str, seed: int, metrics: dict, *, scenario: str = "camp", version: str = "v1",
        replicate: int = 0, package: str = "pkg-camp") -> RunManifest:
    return RunManifest(
        scenario_id=scenario, package_hash=package, strategy_id=strategy_id, strategy_version=version,
        seed=seed, generator_params_hash="gen-typical", actions_log_hash=f"log-{strategy_id}-{seed}-{replicate}",
        metrics=metrics, replicate=replicate,
    )


class DescriptiveTests(unittest.TestCase):
    def test_paired_differences_are_treatment_minus_baseline(self):
        self.assertEqual(paired_differences([1, 2, 3], [2, 2, 5]), [1.0, 0.0, 2.0])
        with self.assertRaises(ValueError):
            paired_differences([1], [1, 2])

    def test_quantile_type7(self):
        # R: quantile(c(1, 2, 3, 4), c(0, .25, .5, .9, 1)) -> 1, 1.75, 2.5, 3.7, 4
        xs = [1.0, 2.0, 3.0, 4.0]
        for q, want in [(0, 1), (0.25, 1.75), (0.5, 2.5), (0.9, 3.7), (1, 4)]:
            self.assertAlmostEqual(quantile(xs, q), want)


class HolmTests(unittest.TestCase):
    def test_known_adjustment(self):
        # sorted: .005*4=.02, .01*3=.03, .03*2=.06, .04*1=.04 -> running max .06
        res = holm({"a": 0.01, "b": 0.04, "c": 0.03, "d": 0.005})
        self.assertEqual([r.name for r in res], ["a", "b", "c", "d"])
        for r, want in zip(res, [0.03, 0.06, 0.06, 0.02]):
            self.assertAlmostEqual(r.p_adjusted, want)
        self.assertEqual([r.reject for r in res], [True, False, False, True])

    def test_caps_at_one_and_single_test_is_unchanged(self):
        self.assertEqual([r.p_adjusted for r in holm([0.6, 0.9])], [1.0, 1.0])
        self.assertAlmostEqual(holm([0.03])[0].p_adjusted, 0.03)

    def test_rejects_invalid_p(self):
        with self.assertRaises(ValueError):
            holm([1.2])


class PermutationTests(unittest.TestCase):
    def test_exact_known_values(self):
        # +-1 +-2 +-3: |sum| >= 6 only for all + and all - -> 2/8
        self.assertAlmostEqual(sign_flip_test([1, 2, 3]), 0.25)
        self.assertAlmostEqual(sign_flip_test(list(range(1, 9))), 2 / 256)
        self.assertAlmostEqual(sign_flip_test([1, -1]), 1.0)
        self.assertAlmostEqual(sign_flip_test([0, 0, 0]), 1.0)
        # [3, 1, 1]: sums 5, 3, 3, 1, -1, -3, -3, -5; |sum| >= 5 -> 2/8
        self.assertAlmostEqual(sign_flip_test([3, 1, 1]), 0.25)

    def test_monte_carlo_is_seeded(self):
        d = [1.0 + 0.1 * i for i in range(20)]
        p1, p2 = sign_flip_test(d, seed=3), sign_flip_test(d, seed=3)
        self.assertEqual(p1, p2)
        self.assertLess(p1, 0.001)
        self.assertGreater(p1, 0)  # (1 + hits) / (1 + R) is never 0


class EffectSizeTests(unittest.TestCase):
    def test_cohens_dz(self):
        # mean 3, sample sd sqrt(2.5)
        self.assertAlmostEqual(cohens_dz([1, 2, 3, 4, 5]), 3 / math.sqrt(2.5))
        self.assertEqual(cohens_dz([0, 0, 0]), 0.0)
        self.assertEqual(cohens_dz([2, 2]), math.inf)

    def test_cliffs_delta(self):
        self.assertAlmostEqual(cliffs_delta([3, 4, 5], [1, 2, 3]), 8 / 9)
        self.assertAlmostEqual(cliffs_delta([1, 2, 3], [3, 4, 5]), -8 / 9)
        self.assertAlmostEqual(cliffs_delta([1, 2, 3], [2, 2, 2]), 0.0)

    def test_paired_dominance_and_magnitude(self):
        self.assertAlmostEqual(paired_dominance([1, -1, 2, 0]), 0.25)
        self.assertEqual(magnitude(0.1), "negligible")
        self.assertEqual(magnitude(-0.6), "medium")
        self.assertEqual(magnitude(0.4, (0.147, 0.33, 0.474)), "medium")


class BootstrapTests(unittest.TestCase):
    def test_two_point_percentile_matches_exact_distribution(self):
        # Means of resamples of [0, 1]: 0 (1/4), .5 (1/2), 1 (1/4); exact SE = 0.5 / sqrt(2)
        ci = bootstrap_ci([0, 1], method="percentile", n_boot=20_000, seed=1)
        self.assertEqual((ci.low, ci.high), (0.0, 1.0))
        self.assertAlmostEqual(ci.se, 0.5 / math.sqrt(2), delta=0.01)

    def test_standard_error_matches_plug_in(self):
        xs = list(range(1, 11))
        exact = math.sqrt(8.25 / 10)  # population sd / sqrt(n)
        ci = bootstrap_ci(xs, n_boot=20_000, seed=2)
        self.assertAlmostEqual(ci.se, exact, delta=0.03 * exact)
        self.assertLess(ci.low, 5.5)
        self.assertGreater(ci.high, 5.5)

    def test_degenerate_and_stratified(self):
        ci = bootstrap_ci([2, 2, 2])
        self.assertEqual((ci.low, ci.high, ci.se), (2.0, 2.0, 0.0))
        # Within-stratum variance is zero, so stratified resamples always have mean 3.
        ci = bootstrap_ci([1, 1, 1, 5, 5, 5], strata=list("aaabbb"))
        self.assertEqual((ci.low, ci.high), (3.0, 3.0))
        unstrat = bootstrap_ci([1, 1, 1, 5, 5, 5])
        self.assertLess(unstrat.low, 3.0)

    def test_bca_shifts_right_for_right_skewed_mean(self):
        xs = [0, 0, 0, 0, 0, 0, 1, 2, 5, 20]
        bca = bootstrap_ci(xs, method="bca", seed=0)
        pct = bootstrap_ci(xs, method="percentile", seed=0)
        self.assertGreater(bca.high, pct.high)
        self.assertGreater(bca.low, pct.low)

    def test_seeded(self):
        xs = [0.3, -0.1, 0.5, 0.2, 0.0, 0.4, 0.1]
        self.assertEqual(bootstrap_ci(xs, seed=5), bootstrap_ci(xs, seed=5))
        self.assertNotEqual(bootstrap_ci(xs, seed=5).se, bootstrap_ci(xs, seed=6).se)


class PowerTests(unittest.TestCase):
    def test_sample_size_matches_exact_paired_t(self):
        # Exact noncentral-t answers (G*Power, two-sided alpha .05, power .8): d=.8 -> 15, .5 -> 34, .2 -> 199
        self.assertEqual(paired_sample_size(1.0, 0.8), 15)
        self.assertEqual(paired_sample_size(1.0, 0.5), 34)
        self.assertEqual(paired_sample_size(1.0, 0.2), 199)
        # Only the ratio matters
        self.assertEqual(paired_sample_size(0.1, 0.05), 34)

    def test_bonferroni_planning_needs_more_seeds(self):
        self.assertGreater(paired_sample_size(1.0, 0.5, n_comparisons=4), 34)

    def test_power_agrees_with_sample_size(self):
        self.assertGreaterEqual(paired_power(34, 1.0, 0.5), 0.8)
        self.assertLess(paired_power(33, 1.0, 0.5), 0.8)

    def test_chi2_and_sd_bound(self):
        # Tables: chi2_.05(10) = 3.940, chi2_.975(20) = 34.170, chi2_.2(9) = 5.380
        self.assertAlmostEqual(chi2_ppf(0.05, 10), 3.940, delta=0.01 * 3.940)
        self.assertAlmostEqual(chi2_ppf(0.975, 20), 34.170, delta=0.01 * 34.170)
        self.assertAlmostEqual(sd_upper_bound(1.0, 10, 0.8), math.sqrt(9 / 5.380), delta=0.01)

    def test_plan_from_pilot(self):
        pilot = [0.1, -0.05, 0.08, 0.02, 0.12, -0.01, 0.06, 0.04, 0.09, 0.0]
        plan = plan_from_pilot("aar.arrived_share", pilot, 0.05, n_comparisons=4)
        self.assertGreater(plan.planning_sd, plan.pilot_sd_diff)
        self.assertEqual(plan.n_pairs, paired_sample_size(plan.planning_sd, 0.05, n_comparisons=4))
        raw = plan_from_pilot("x", pilot, 0.05, n_comparisons=4, sd_confidence=None)
        self.assertLess(raw.n_pairs, plan.n_pairs)


class SeedAndManifestTests(unittest.TestCase):
    def test_derive_seed_is_stable_and_separates_streams(self):
        self.assertEqual(derive_seed(7, "noise"), 4560778080728135546)  # sha256-based; must never change
        self.assertNotEqual(derive_seed(7, "noise"), derive_seed(7, "comms"))
        self.assertNotEqual(derive_seed(7, "a", "b"), derive_seed(7, "b", "a"))
        self.assertLess(derive_seed(7, "noise"), 2**63)
        with self.assertRaises(ValueError):
            derive_seed(-1)

    def test_seed_panels_reproducible_and_disjoint(self):
        self.assertEqual(seed_panel(5, "test"), seed_panel(5, "test"))
        self.assertEqual(seed_panel(3, "test"), seed_panel(5, "test")[:3])
        self.assertFalse(set(seed_panel(1000, "dev")) & set(seed_panel(1000, "test")))

    def test_streams_give_common_random_numbers(self):
        """A strategy that draws more from one stream leaves the other streams' draws unchanged."""
        def play(seed: int, extra_draws: int) -> list[float]:
            actions = random.Random(derive_seed(seed, "responders"))
            for _ in range(extra_draws):
                actions.random()
            fire = random.Random(derive_seed(seed, "fire"))
            return [fire.random() for _ in range(5)]

        self.assertEqual(play(11, 0), play(11, 50))
        self.assertNotEqual(play(11, 0), play(12, 0))

    def test_manifest_round_trip_and_identity(self):
        m = run("rule_planner", 3, {"aar.arrived_share": 0.8, "aar.help_to_assign": None})
        again = RunManifest.from_dict(json.loads(m.to_json()))
        self.assertEqual(again, m)
        self.assertEqual(m.block, ("camp", "pkg-camp", "gen-typical", 3))
        self.assertEqual(m.strategy, "rule_planner@v1")
        other_metrics = RunManifest.from_dict({**m.to_dict(), "metrics": {"aar.arrived_share": 0.1}})
        self.assertEqual(m.run_id, other_metrics.run_id)
        self.assertNotEqual(m.run_id, run("rule_planner", 3, {}, replicate=1).run_id)
        self.assertEqual(hash_json({"b": 1, "a": [1, 2]}), hash_json({"a": [1, 2], "b": 1}))

    def test_manifest_validation(self):
        with self.assertRaises(ValueError):
            run("x", -1, {})
        with self.assertRaises(ValueError):
            run("x", 1, {"m": float("nan")})
        with self.assertRaises(ValueError):
            run("", 1, {})
        with self.assertRaises(ValueError):
            RunManifest.from_dict({"kind": "something_else"})


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        rng = random.Random(42)
        self.runs = []
        for scenario in ("camp", "woolsey"):
            for seed in seed_panel(12, "test"):
                base = rng.uniform(0.5, 0.7)
                noise = rng.gauss(0, 0.01)
                self.runs.append(run("rule_planner", seed, {
                    "aar.arrived_share": base, "aar.exposed_trapped.raw": 2.0 + noise,
                    "agent.tool_calls": 0.0}, scenario=scenario, package=f"pkg-{scenario}"))
                for rep in range(2):  # an LLM agent, two replicates per seed
                    self.runs.append(run("orchestrator", seed, {
                        "aar.arrived_share": base + 0.1 + rng.gauss(0, 0.01),
                        "aar.exposed_trapped.raw": 2.0 + noise + rng.gauss(0, 0.05),
                        "agent.tool_calls": 40.0 + rep}, scenario=scenario, package=f"pkg-{scenario}",
                        replicate=rep))
        self.metrics = [
            MetricSpec("aar.arrived_share", True, "primary", "share"),
            MetricSpec("aar.exposed_trapped.raw", False, "primary", "veh-min/veh"),
            MetricSpec("agent.tool_calls", False, "secondary", "calls"),
        ]

    def test_pairing_averages_replicates(self):
        ps = pair_runs(self.runs, "agent.tool_calls", "rule_planner@v1", "orchestrator@v1")
        self.assertEqual(len(ps.a), 24)
        self.assertTrue(all(b == 40.5 for b in ps.b))
        self.assertEqual((ps.dropped_missing, ps.unpaired), (0, 0))

    def test_missing_and_unpaired_blocks_are_counted(self):
        runs = [run("a", 1, {"m": 1.0}), run("b", 1, {"m": None}), run("a", 2, {"m": 1.0}),
                run("b", 2, {"m": 2.0}), run("a", 3, {"m": 1.0})]
        ps = pair_runs(runs, "m", "a@v1", "b@v1")
        self.assertEqual((len(ps.a), ps.dropped_missing, ps.unpaired), (1, 1, 1))
        self.assertTrue(any("missing" in i for i in design_issues(runs)))

    def test_verdicts_and_order_independence(self):
        res = compare_strategies(self.runs, "rule_planner@v1", ["orchestrator@v1"], self.metrics, n_boot=2000)
        by = {c.metric: c for c in res}
        self.assertEqual(by["aar.arrived_share"].verdict, "treatment better")
        self.assertAlmostEqual(by["aar.arrived_share"].mean_diff, 0.1, delta=0.01)
        self.assertLess(by["aar.arrived_share"].ci.low, 0.1)
        self.assertGreater(by["aar.arrived_share"].ci.high, 0.1)
        self.assertEqual(by["agent.tool_calls"].verdict, "treatment worse")  # lower is better
        self.assertEqual(by["aar.exposed_trapped.raw"].family, "primary")

        shuffled = list(self.runs)
        random.Random(0).shuffle(shuffled)
        again = compare_strategies(shuffled, "rule_planner@v1", ["orchestrator@v1"], list(reversed(self.metrics)),
                                   n_boot=2000)
        self.assertEqual(sorted((c.to_dict() for c in res), key=lambda d: d["metric"]),
                         sorted((c.to_dict() for c in again), key=lambda d: d["metric"]))

    def test_holm_is_within_family(self):
        res = compare_strategies(self.runs, "rule_planner@v1", ["orchestrator@v1"], self.metrics, n_boot=500)
        sec = next(c for c in res if c.family == "secondary")
        self.assertAlmostEqual(sec.p_holm, sec.p)  # alone in its family

    def test_insufficient_pairs(self):
        runs = [run("a", 1, {"m": 1.0}), run("b", 1, {"m": 2.0})]
        (c,) = compare_strategies(runs, "a@v1", ["b@v1"], [MetricSpec("m", True)])
        self.assertEqual(c.verdict, "insufficient pairs")
        self.assertIsNone(c.p_holm)

    def test_tables(self):
        res = compare_strategies(self.runs, "rule_planner@v1", ["orchestrator@v1"], self.metrics, n_boot=500)
        md = results_table_markdown(res)
        self.assertIn("| primary | aar.arrived_share (share) | higher |", md)
        self.assertIn("Planning experiment", md)
        self.assertEqual(md.count("\n| "), len(res))  # header starts the string
        js = results_table_json(res, runs=self.runs, settings={"n_boot": 500})
        self.assertEqual(js["design_issues"], [])
        self.assertEqual(len(js["runs"]), len(self.runs))
        json.dumps(js, allow_nan=False)

    def test_design_issues_detects_package_mismatch(self):
        runs = [run("a", 1, {}), run("b", 1, {}, package="pkg-other")]
        self.assertTrue(any("package hashes" in i for i in design_issues(runs)))


if __name__ == "__main__":
    unittest.main()
