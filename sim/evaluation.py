"""Strategy evaluation statistics: paired comparisons across scenarios and seeds.

Protocol: docs/strategy-evaluation.md. Decision: docs/adr/0046-strategy-evaluation.md.

Standard library only, no I/O, no LLM. A *run* is one strategy (a human controller, the
rule planner on auto, an orchestrator agent) playing one scenario with one seed; its
``RunManifest`` records what was played and the metrics the evaluator computed afterwards
(AAR components, triage scores against the truth log, agent cost). Strategies are compared
on **paired** runs: the same scenario, package, generator parameters and seed, so every
strategy faced the same fire, people and noise (common random numbers).

Everything here describes planning experiments in a simulation. A difference between two
strategies is a statement about the simulator and its assumptions, not about real outcomes.

Conventions:
- A paired difference is ``treatment - baseline`` in the metric's own units. Whether that is
  good depends on the metric (``MetricSpec.higher_is_better``).
- Quantiles use linear interpolation between order statistics (Hyndman-Fan type 7, the
  default of R and NumPy).
- Every random draw comes from a ``random.Random`` seeded by the caller; the same inputs and
  seed give the same output on every run.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import random
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from statistics import NormalDist, fmean, stdev
from typing import Any

SCHEMA_VERSION = "0.1.0"
MANIFEST_KIND = "crisistwin_eval_run"
COMPARISON_KIND = "crisistwin_strategy_comparison"
LABEL = ("Planning experiment in a simulation: differences describe the simulator under its stated "
         "assumptions, not real evacuation outcomes.")

DEFAULT_ALPHA = 0.05
DEFAULT_N_BOOT = 10_000
EXACT_PERMUTATION_MAX_N = 16
"""Sign-flip tests enumerate all 2^n sign patterns up to this many pairs, then sample."""
DEFAULT_N_PERMUTATIONS = 20_000
HASH_LENGTH = 16
"""Hex characters kept from a sha256, like the twin's ``inputs_fingerprint``."""

CLIFF_THRESHOLDS = (0.147, 0.33, 0.474)
"""Romano et al. (2006) bounds for negligible / small / medium / large |delta|."""
COHEN_THRESHOLDS = (0.2, 0.5, 0.8)
"""Cohen (1988) bounds for negligible / small / medium / large |d|."""

_N = NormalDist()


# ---- hashing and seeds ----


def canonical_json(obj: Any) -> str:
    """JSON with sorted keys and no whitespace, so equal objects hash equally."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def hash_json(obj: Any, length: int = HASH_LENGTH) -> str:
    """sha256 of ``canonical_json(obj)``, truncated to ``length`` hex characters."""
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()[:length]


def derive_seed(root_seed: int, *labels: str | int) -> int:
    """A 63-bit seed for one named random stream, e.g. ``derive_seed(seed, "noise")``.

    Give each generator (fire, residents, comms, noise, responders) and, where draws depend on
    what a strategy does, each entity its own stream. A strategy that triggers more draws in one
    stream then cannot shift the draws of another, which keeps runs of different strategies on
    the same seed comparable (common random numbers)."""
    if not isinstance(root_seed, int) or root_seed < 0:
        raise ValueError("root_seed must be a non-negative int")
    text = "\x1f".join([str(root_seed), *(str(x) for x in labels)])
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big") >> 1


def seed_panel(n: int, panel: str = "test", root_seed: int = 0) -> list[int]:
    """``n`` reproducible scenario seeds for a named panel (``"dev"`` or ``"test"``).

    Panels with different names never share seeds in practice, so prompts tuned on ``dev``
    are scored on seeds they were not tuned on. Seeds are kept below 2^31 so any engine accepts them."""
    if n < 0:
        raise ValueError("n must be >= 0")
    return [derive_seed(root_seed, "panel", panel, i) % (2**31 - 1) for i in range(n)]


# ---- run manifest ----


@dataclass(frozen=True)
class RunManifest:
    """One evaluated run. Identity fields say what was played; ``metrics`` what was measured.

    ``replicate`` numbers repeated runs of a non-deterministic strategy (an LLM agent) on the same
    seed; deterministic strategies use 0. ``meta`` holds non-identity facts worth keeping (model id,
    temperature, transcript hash, clock mode, wall seconds); it never enters pairing."""

    scenario_id: str
    package_hash: str
    strategy_id: str
    strategy_version: str
    seed: int
    generator_params_hash: str
    actions_log_hash: str
    metrics: Mapping[str, float | None]
    replicate: int = 0
    meta: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in ("scenario_id", "package_hash", "strategy_id", "strategy_version",
                     "generator_params_hash", "actions_log_hash"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a non-empty string")
        if not isinstance(self.seed, int) or isinstance(self.seed, bool) or self.seed < 0:
            raise ValueError("seed must be a non-negative int")
        if not isinstance(self.replicate, int) or self.replicate < 0:
            raise ValueError("replicate must be a non-negative int")
        for key, value in self.metrics.items():
            if not isinstance(key, str) or not key:
                raise ValueError("metric names must be non-empty strings")
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                      or not math.isfinite(value)):
                raise ValueError(f"metric {key!r} must be a finite number or None")

    @property
    def block(self) -> tuple[str, str, str, int]:
        """The pairing key: runs with equal blocks faced the same inputs and random draws."""
        return (self.scenario_id, self.package_hash, self.generator_params_hash, self.seed)

    @property
    def strategy(self) -> str:
        """``strategy_id@strategy_version``; a changed prompt or tool set is a different strategy."""
        return f"{self.strategy_id}@{self.strategy_version}"

    @property
    def run_id(self) -> str:
        """Hash of the identity fields (metrics and meta excluded)."""
        d = self.to_dict()
        return hash_json({k: d[k] for k in (
            "scenario_id", "package_hash", "strategy_id", "strategy_version", "seed",
            "generator_params_hash", "actions_log_hash", "replicate")})

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": MANIFEST_KIND,
            "schema_version": SCHEMA_VERSION,
            "scenario_id": self.scenario_id,
            "package_hash": self.package_hash,
            "strategy_id": self.strategy_id,
            "strategy_version": self.strategy_version,
            "seed": self.seed,
            "replicate": self.replicate,
            "generator_params_hash": self.generator_params_hash,
            "actions_log_hash": self.actions_log_hash,
            "metrics": dict(sorted(self.metrics.items())),
            "meta": dict(self.meta),
            "evidence_class": "simulated",
        }

    def to_json(self) -> str:
        return canonical_json(self.to_dict())

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> RunManifest:
        if d.get("kind", MANIFEST_KIND) != MANIFEST_KIND:
            raise ValueError(f"not a run manifest: kind={d.get('kind')!r}")
        return cls(
            scenario_id=d["scenario_id"], package_hash=d["package_hash"], strategy_id=d["strategy_id"],
            strategy_version=d["strategy_version"], seed=d["seed"],
            generator_params_hash=d["generator_params_hash"], actions_log_hash=d["actions_log_hash"],
            metrics=dict(d.get("metrics") or {}), replicate=d.get("replicate", 0), meta=dict(d.get("meta") or {}),
        )


def design_issues(runs: Iterable[RunManifest]) -> list[str]:
    """Problems that break the paired design, as readable strings (empty list = balanced).

    Checks: one package hash per scenario; duplicate (block, strategy, replicate); every strategy
    present in every block; equal seeds per scenario."""
    runs = list(runs)
    issues: list[str] = []
    pkgs: dict[str, set[str]] = defaultdict(set)
    seen: dict[tuple, int] = defaultdict(int)
    by_block: dict[tuple, set[str]] = defaultdict(set)
    strategies = sorted({r.strategy for r in runs})
    for r in runs:
        pkgs[r.scenario_id].add(r.package_hash)
        seen[(r.block, r.strategy, r.replicate)] += 1
        by_block[r.block].add(r.strategy)
    for sid, hashes in sorted(pkgs.items()):
        if len(hashes) > 1:
            issues.append(f"scenario {sid} has {len(hashes)} package hashes: {sorted(hashes)}")
    for (block, strat, rep), count in sorted(seen.items(), key=lambda kv: repr(kv[0])):
        if count > 1:
            issues.append(f"duplicate run: {strat} replicate {rep} in block {block} x{count}")
    for block, present in sorted(by_block.items(), key=lambda kv: repr(kv[0])):
        missing = [s for s in strategies if s not in present]
        if missing:
            issues.append(f"block {block} is missing {missing}")
    seeds_per: dict[str, set[int]] = defaultdict(set)
    for block in by_block:
        seeds_per[block[0]].add(block[3])
    counts = {sid: len(s) for sid, s in seeds_per.items()}
    if len(set(counts.values())) > 1:
        issues.append(f"unequal seeds per scenario: {dict(sorted(counts.items()))}")
    return issues


@dataclass(frozen=True)
class PairedSample:
    """Paired values of one metric for two strategies, one entry per block (replicates averaged)."""

    metric: str
    baseline: str
    treatment: str
    blocks: tuple[tuple[str, str, str, int], ...]
    a: tuple[float, ...]
    b: tuple[float, ...]
    dropped_missing: int
    unpaired: int

    @property
    def diffs(self) -> list[float]:
        return paired_differences(self.a, self.b)

    @property
    def strata(self) -> list[str]:
        return [blk[0] for blk in self.blocks]


def pair_runs(runs: Iterable[RunManifest], metric: str, baseline: str, treatment: str) -> PairedSample:
    """Pair two strategies' values of ``metric`` by block.

    ``baseline``/``treatment`` are ``RunManifest.strategy`` strings (``id@version``). Replicates
    are averaged within a block first, so a block counts once however many replicates it has.
    A block where either side's metric is None (e.g. an AAR component without data) is dropped and
    counted in ``dropped_missing``; a block with only one side is counted in ``unpaired``."""
    vals: dict[str, dict[tuple, list[float | None]]] = {baseline: defaultdict(list), treatment: defaultdict(list)}
    for r in runs:
        if r.strategy in vals:
            vals[r.strategy][r.block].append(r.metrics.get(metric))
    blocks_a, blocks_b = set(vals[baseline]), set(vals[treatment])
    blocks, a, b = [], [], []
    dropped = 0
    for blk in sorted(blocks_a & blocks_b):
        va, vb = vals[baseline][blk], vals[treatment][blk]
        if any(v is None for v in va) or any(v is None for v in vb):
            dropped += 1
            continue
        blocks.append(blk)
        a.append(fmean(va))
        b.append(fmean(vb))
    return PairedSample(metric, baseline, treatment, tuple(blocks), tuple(a), tuple(b), dropped,
                        len(blocks_a ^ blocks_b))


# ---- descriptive helpers ----


def paired_differences(a: Sequence[float], b: Sequence[float]) -> list[float]:
    """``b[i] - a[i]`` (treatment minus baseline)."""
    if len(a) != len(b):
        raise ValueError("paired samples must have equal length")
    return [float(y) - float(x) for x, y in zip(a, b, strict=True)]


def quantile(sorted_xs: Sequence[float], q: float) -> float:
    """Type-7 quantile of an already sorted sequence."""
    if not sorted_xs:
        raise ValueError("quantile of an empty sequence")
    if not 0.0 <= q <= 1.0:
        raise ValueError("q must be in [0, 1]")
    h = (len(sorted_xs) - 1) * q
    lo = math.floor(h)
    hi = min(lo + 1, len(sorted_xs) - 1)
    return sorted_xs[lo] + (h - lo) * (sorted_xs[hi] - sorted_xs[lo])


# ---- bootstrap ----


@dataclass(frozen=True)
class BootstrapCI:
    estimate: float
    low: float
    high: float
    level: float
    method: str
    n: int
    n_boot: int
    seed: int
    se: float
    """Standard deviation of the bootstrap distribution."""


def _resample_stats(xs: Sequence[float], stat: Callable[[Sequence[float]], float], n_boot: int,
                    rng: random.Random, strata: Sequence[Any] | None) -> list[float]:
    if strata is None:
        groups = [list(xs)]
    else:
        if len(strata) != len(xs):
            raise ValueError("strata must have the same length as the data")
        by: dict[Any, list[float]] = defaultdict(list)
        for x, s in zip(xs, strata, strict=True):
            by[s].append(x)
        groups = [by[k] for k in sorted(by, key=repr)]
    out = []
    for _ in range(n_boot):
        sample: list[float] = []
        for g in groups:
            sample.extend(rng.choices(g, k=len(g)))
        out.append(stat(sample))
    return out


def bootstrap_ci(
    xs: Sequence[float],
    stat: Callable[[Sequence[float]], float] = fmean,
    *,
    level: float = 0.95,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = 0,
    method: str = "bca",
    strata: Sequence[Any] | None = None,
) -> BootstrapCI:
    """Bootstrap confidence interval for ``stat`` of one sample (pass paired differences).

    ``method``: ``"percentile"`` or ``"bca"`` (bias-corrected and accelerated, Efron 1987; better
    coverage for the small, skewed samples drill runs give). ``strata`` (e.g. scenario ids)
    resamples within each stratum so every bootstrap sample keeps the scenario mix."""
    if method not in ("percentile", "bca"):
        raise ValueError("method must be 'percentile' or 'bca'")
    if not 0 < level < 1:
        raise ValueError("level must be in (0, 1)")
    xs = [float(x) for x in xs]
    n = len(xs)
    if n < 2:
        raise ValueError("bootstrap needs at least 2 observations")
    theta = stat(xs)
    rng = random.Random(seed)
    boots = sorted(_resample_stats(xs, stat, n_boot, rng, strata))
    se = stdev(boots) if n_boot > 1 else 0.0
    alpha = 1 - level
    if boots[0] == boots[-1]:
        return BootstrapCI(theta, boots[0], boots[0], level, method, n, n_boot, seed, 0.0)
    q_lo, q_hi = alpha / 2, 1 - alpha / 2
    if method == "bca":
        below = sum(1 for t in boots if t < theta) + 0.5 * sum(1 for t in boots if t == theta)
        p0 = min(max(below / n_boot, 1 / (n_boot + 1)), n_boot / (n_boot + 1))
        z0 = _N.inv_cdf(p0)
        jack = [stat(xs[:i] + xs[i + 1:]) for i in range(n)]
        jbar = fmean(jack)
        num = sum((jbar - j) ** 3 for j in jack)
        den = 6 * sum((jbar - j) ** 2 for j in jack) ** 1.5
        acc = num / den if den > 0 else 0.0

        def adj(q: float) -> float:
            z = _N.inv_cdf(q)
            return _N.cdf(z0 + (z0 + z) / (1 - acc * (z0 + z)))

        q_lo, q_hi = adj(q_lo), adj(q_hi)
    return BootstrapCI(theta, quantile(boots, q_lo), quantile(boots, q_hi), level, method, n, n_boot, seed, se)


# ---- paired test ----


def sign_flip_test(diffs: Sequence[float], *, n_permutations: int = DEFAULT_N_PERMUTATIONS, seed: int = 0) -> float:
    """Two-sided paired permutation test of mean difference = 0 (randomly flip each pair's sign).

    Exact (all 2^n sign patterns) up to ``EXACT_PERMUTATION_MAX_N`` pairs; above that a seeded
    Monte Carlo estimate ``(1 + hits) / (1 + n_permutations)`` (Phipson and Smyth 2010)."""
    d = [float(x) for x in diffs]
    n = len(d)
    if n == 0:
        raise ValueError("no differences")
    t_obs = abs(sum(d))
    tol = 1e-9 * max(1.0, t_obs)
    if n <= EXACT_PERMUTATION_MAX_N:
        hits = sum(1 for signs in itertools.product((1, -1), repeat=n)
                   if abs(sum(s * x for s, x in zip(signs, d, strict=True))) >= t_obs - tol)
        return hits / 2**n
    rng = random.Random(seed)
    hits = 0
    for _ in range(n_permutations):
        if abs(sum(x if rng.random() < 0.5 else -x for x in d)) >= t_obs - tol:
            hits += 1
    return (1 + hits) / (1 + n_permutations)


# ---- multiple comparisons ----


@dataclass(frozen=True)
class HolmResult:
    name: str
    p: float
    p_adjusted: float
    reject: bool


def holm(pvalues: Mapping[str, float] | Sequence[float], alpha: float = DEFAULT_ALPHA) -> list[HolmResult]:
    """Holm-Bonferroni step-down adjustment; results in input order.

    The adjusted p of the i-th smallest of m p-values is max over j <= i of (m - j + 1) * p_(j),
    capped at 1. It controls the family-wise error rate at ``alpha`` under any dependence."""
    items = list(pvalues.items()) if isinstance(pvalues, Mapping) else [(str(i), p) for i, p in enumerate(pvalues)]
    for _, p in items:
        if not 0.0 <= p <= 1.0:
            raise ValueError(f"p-value out of range: {p}")
    m = len(items)
    order = sorted(range(m), key=lambda i: items[i][1])
    adjusted = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * items[i][1]))
        adjusted[i] = running
    return [HolmResult(name, p, adjusted[i], adjusted[i] <= alpha) for i, (name, p) in enumerate(items)]


# ---- effect sizes ----


def cohens_dz(diffs: Sequence[float]) -> float:
    """Paired standardized mean difference d_z = mean(d) / sd(d) (sample sd, n - 1).

    Returns +-inf when every difference is equal and non-zero, 0.0 when all are zero."""
    d = [float(x) for x in diffs]
    if len(d) < 2:
        raise ValueError("d_z needs at least 2 differences")
    m, s = fmean(d), stdev(d)
    if s == 0:
        return 0.0 if m == 0 else math.copysign(math.inf, m)
    return m / s


def cliffs_delta(xs: Sequence[float], ys: Sequence[float]) -> float:
    """Cliff's delta P(X > Y) - P(X < Y) over all pairs; for two independent samples."""
    if not xs or not ys:
        raise ValueError("cliffs_delta needs two non-empty samples")
    gt = lt = 0
    for x in xs:
        for y in ys:
            if x > y:
                gt += 1
            elif x < y:
                lt += 1
    return (gt - lt) / (len(xs) * len(ys))


def paired_dominance(diffs: Sequence[float]) -> float:
    """Paired analogue of Cliff's delta: (#d > 0 - #d < 0) / n, in [-1, 1].

    The share of seeds where the treatment beat the baseline minus the share where it lost."""
    d = list(diffs)
    if not d:
        raise ValueError("no differences")
    return (sum(1 for x in d if x > 0) - sum(1 for x in d if x < 0)) / len(d)


def magnitude(value: float, thresholds: tuple[float, float, float] = COHEN_THRESHOLDS) -> str:
    """``negligible``/``small``/``medium``/``large`` by |value| (Cohen for d, Romano for delta)."""
    v = abs(value)
    return ("negligible" if v < thresholds[0] else "small" if v < thresholds[1]
            else "medium" if v < thresholds[2] else "large")


# ---- power and sample size ----


def chi2_ppf(p: float, df: int) -> float:
    """Chi-square quantile by the Wilson-Hilferty approximation (within about 1% for df >= 3)."""
    if not 0 < p < 1 or df < 1:
        raise ValueError("need 0 < p < 1 and df >= 1")
    k = float(df)
    c = 2 / (9 * k)
    return k * max(0.0, 1 - c + _N.inv_cdf(p) * math.sqrt(c)) ** 3


def sd_upper_bound(sd: float, n: int, confidence: float = 0.8) -> float:
    """One-sided upper confidence limit of a population sd from a pilot of ``n`` (Browne 1995).

    A pilot of a few seeds underestimates the sd about half the time; planning on this bound
    makes the main study reach its power with probability about ``confidence``."""
    if n < 2:
        raise ValueError("pilot needs at least 2 observations")
    return sd * math.sqrt((n - 1) / chi2_ppf(1 - confidence, n - 1))


def paired_sample_size(sd_diff: float, min_effect: float, *, alpha: float = DEFAULT_ALPHA, power: float = 0.8,
                       n_comparisons: int = 1) -> int:
    """Pairs (seeds per comparison) needed to detect a mean paired difference of ``min_effect``.

    Two-sided paired t-test, normal approximation plus Guenther's (1981) small-sample correction:
    n = ((z_{1-a/2} + z_{power}) * sd / effect)^2 + z_{1-a/2}^2 / 2, rounded up. ``n_comparisons``
    plans for Holm's strictest step (alpha / m), so the count is conservative for a family."""
    if sd_diff < 0 or min_effect == 0:
        raise ValueError("need sd_diff >= 0 and a non-zero min_effect")
    if sd_diff == 0:
        return 2
    a = alpha / max(1, n_comparisons)
    za, zb = _N.inv_cdf(1 - a / 2), _N.inv_cdf(power)
    n = ((za + zb) * sd_diff / abs(min_effect)) ** 2 + za**2 / 2
    return max(2, math.ceil(n - 1e-9))


def paired_power(n: int, sd_diff: float, effect: float, *, alpha: float = DEFAULT_ALPHA, n_comparisons: int = 1) -> float:
    """Approximate power of a two-sided paired test with ``n`` pairs (normal approximation with the
    same correction as ``paired_sample_size``, so the two functions agree)."""
    if n < 2:
        raise ValueError("n must be >= 2")
    if sd_diff <= 0:
        return 1.0 if effect != 0 else 0.0
    a = alpha / max(1, n_comparisons)
    za = _N.inv_cdf(1 - a / 2)
    n_eff = max(n - za**2 / 2, 0.0)
    return _N.cdf(abs(effect) / sd_diff * math.sqrt(n_eff) - za)


@dataclass(frozen=True)
class PowerPlan:
    metric: str
    pilot_n: int
    pilot_mean_diff: float
    pilot_sd_diff: float
    planning_sd: float
    min_effect: float
    alpha: float
    power: float
    n_comparisons: int
    n_pairs: int


def plan_from_pilot(metric: str, pilot_diffs: Sequence[float], min_effect: float, *, alpha: float = DEFAULT_ALPHA,
                    power: float = 0.8, n_comparisons: int = 1, sd_confidence: float | None = 0.8) -> PowerPlan:
    """Seeds per scenario-pooled comparison from pilot paired differences.

    ``min_effect`` is the smallest difference worth acting on, in metric units, chosen before the
    pilot (never the pilot's observed mean). ``sd_confidence`` inflates the pilot sd to its upper
    confidence limit; None uses the pilot sd as is."""
    d = [float(x) for x in pilot_diffs]
    if len(d) < 2:
        raise ValueError("pilot needs at least 2 paired differences")
    s = stdev(d)
    plan_sd = sd_upper_bound(s, len(d), sd_confidence) if sd_confidence else s
    n = paired_sample_size(plan_sd, min_effect, alpha=alpha, power=power, n_comparisons=n_comparisons)
    return PowerPlan(metric, len(d), fmean(d), s, plan_sd, min_effect, alpha, power, n_comparisons, n)


# ---- comparisons and tables ----


@dataclass(frozen=True)
class MetricSpec:
    name: str
    higher_is_better: bool
    family: str = "primary"
    """Holm is applied within a family; report ``secondary`` as exploratory."""
    unit: str = ""


@dataclass(frozen=True)
class Comparison:
    metric: str
    family: str
    unit: str
    higher_is_better: bool
    baseline: str
    treatment: str
    n_pairs: int
    dropped_missing: int
    unpaired: int
    mean_baseline: float | None
    mean_treatment: float | None
    mean_diff: float | None
    ci: BootstrapCI | None
    p: float | None
    p_holm: float | None
    reject: bool
    d_z: float | None
    dominance: float | None
    verdict: str

    def to_dict(self) -> dict[str, Any]:
        def r(x: float | None, k: int = 4) -> float | None:
            return None if x is None or not math.isfinite(x) else round(x, k)

        return {
            "metric": self.metric, "family": self.family, "unit": self.unit,
            "higher_is_better": self.higher_is_better, "baseline": self.baseline, "treatment": self.treatment,
            "n_pairs": self.n_pairs, "dropped_missing": self.dropped_missing, "unpaired": self.unpaired,
            "mean_baseline": r(self.mean_baseline), "mean_treatment": r(self.mean_treatment),
            "mean_diff": r(self.mean_diff),
            "ci": None if self.ci is None else {"low": r(self.ci.low), "high": r(self.ci.high),
                                                "level": self.ci.level, "method": self.ci.method},
            "p": r(self.p, 6), "p_holm": r(self.p_holm, 6), "reject": self.reject,
            "d_z": r(self.d_z, 3) if self.d_z is None or math.isfinite(self.d_z) else
            ("inf" if self.d_z > 0 else "-inf"),
            "dominance": r(self.dominance, 3), "verdict": self.verdict,
        }


MIN_PAIRS = 3
"""Below this many complete pairs a comparison is reported as ``insufficient pairs`` without stats."""


def compare_strategies(
    runs: Iterable[RunManifest],
    baseline: str,
    treatments: Sequence[str],
    metrics: Sequence[MetricSpec],
    *,
    alpha: float = DEFAULT_ALPHA,
    level: float = 0.95,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = 0,
    ci_method: str = "bca",
) -> list[Comparison]:
    """Every treatment against ``baseline`` on every metric, Holm-adjusted within each family.

    The bootstrap is stratified by scenario. Seeds for the bootstrap and permutation draws are
    derived from ``seed`` and the comparison's names, so the result does not depend on the order
    of ``runs``, ``treatments`` or ``metrics``."""
    runs = list(runs)
    rows: list[dict[str, Any]] = []
    for spec in metrics:
        for treat in treatments:
            ps = pair_runs(runs, spec.name, baseline, treat)
            row: dict[str, Any] = {"spec": spec, "treat": treat, "ps": ps, "ci": None, "p": None,
                                   "d_z": None, "dom": None}
            if len(ps.a) >= MIN_PAIRS:
                d = ps.diffs
                s = derive_seed(seed, spec.name, baseline, treat)
                row["ci"] = bootstrap_ci(d, level=level, n_boot=n_boot, seed=s, method=ci_method, strata=ps.strata)
                row["p"] = sign_flip_test(d, seed=s)
                row["d_z"] = cohens_dz(d)
                row["dom"] = paired_dominance(d)
            rows.append(row)
    adjusted: dict[int, HolmResult] = {}
    for fam in sorted({r["spec"].family for r in rows}):
        idx = [i for i, r in enumerate(rows) if r["spec"].family == fam and r["p"] is not None]
        for i, h in zip(idx, holm([rows[i]["p"] for i in idx], alpha), strict=True):
            adjusted[i] = h
    out = []
    for i, r in enumerate(rows):
        spec, ps = r["spec"], r["ps"]
        h = adjusted.get(i)
        if h is None:
            verdict = "insufficient pairs"
        elif not h.reject:
            verdict = "no detectable difference"
        else:
            better = (fmean(ps.diffs) > 0) == spec.higher_is_better
            verdict = "treatment better" if better else "treatment worse"
        out.append(Comparison(
            metric=spec.name, family=spec.family, unit=spec.unit, higher_is_better=spec.higher_is_better,
            baseline=baseline, treatment=r["treat"], n_pairs=len(ps.a), dropped_missing=ps.dropped_missing,
            unpaired=ps.unpaired, mean_baseline=fmean(ps.a) if ps.a else None,
            mean_treatment=fmean(ps.b) if ps.b else None, mean_diff=fmean(ps.diffs) if ps.a else None,
            ci=r["ci"], p=r["p"], p_holm=None if h is None else h.p_adjusted,
            reject=bool(h and h.reject), d_z=r["d_z"], dominance=r["dom"], verdict=verdict,
        ))
    return out


def _fmt(x: float | None, k: int = 3) -> str:
    if x is None:
        return "–"
    if math.isinf(x):
        return "inf" if x > 0 else "-inf"
    return f"{x:.{k}f}"


def _fmt_p(p: float | None) -> str:
    if p is None:
        return "–"
    return "<0.001" if p < 0.001 else f"{p:.3f}"


def results_table_markdown(comparisons: Sequence[Comparison], digits: int = 3) -> str:
    """A markdown table, one row per (metric, treatment), grouped by family as listed."""
    head = ("| Family | Metric | Better | Baseline | Treatment | n | Baseline mean | Treatment mean | "
            "Δ (T − B) | CI | p (Holm) | d_z | Dominance | Verdict |")
    sep = "|" + "---|" * 14
    lines = [head, sep]
    for c in comparisons:
        ci = "–" if c.ci is None else f"[{_fmt(c.ci.low, digits)}, {_fmt(c.ci.high, digits)}] ({c.ci.level:.0%})"
        unit = f" ({c.unit})" if c.unit else ""
        n = f"{c.n_pairs}" + (f" (−{c.dropped_missing} missing)" if c.dropped_missing else "")
        lines.append(" | ".join([
            f"| {c.family}", f"{c.metric}{unit}", "higher" if c.higher_is_better else "lower",
            c.baseline, c.treatment, n, _fmt(c.mean_baseline, digits), _fmt(c.mean_treatment, digits),
            _fmt(c.mean_diff, digits), ci, _fmt_p(c.p_holm), _fmt(c.d_z, 2), _fmt(c.dominance, 2), c.verdict + " |",
        ]))
    return "\n".join(lines) + "\n\n" + LABEL + "\n"


def results_table_json(comparisons: Sequence[Comparison], *, runs: Iterable[RunManifest] = (),
                       settings: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The comparison as a JSON-ready dict, with the run ids it was computed from."""
    run_list = list(runs)
    return {
        "kind": COMPARISON_KIND,
        "schema_version": SCHEMA_VERSION,
        "evidence_class": "simulated",
        "label": LABEL,
        "settings": dict(settings or {}),
        "runs": sorted(r.run_id for r in run_list),
        "design_issues": design_issues(run_list) if run_list else [],
        "rows": [c.to_dict() for c in comparisons],
    }
