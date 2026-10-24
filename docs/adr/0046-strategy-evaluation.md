# 0046: Strategy evaluation: paired seeds, component metrics, Holm, run manifests

Date: 2026-10-24. Status: proposed. Builds on [0030](0030-scenario-engine.md) §4 (evaluation),
[0041](0041-crowdsourced-task-board.md) (information priority, staleness) and
[0042](0042-adversarial-ground-data.md) (noise profiles, truth log). Protocol:
[docs/strategy-evaluation.md](../strategy-evaluation.md).

## Context

ADR 0030 says that a headless runner scores scenario × strategy × seed with the AAR drill score
and prints a comparison table. It does not say how to make that comparison fair. The strategies are
a human controller, the rule planner on auto, and a teammate's orchestrator agent whose prompts and
tools will change often. Drill outcomes vary a lot from seed to seed. The AAR total renormalises over
whichever components have data. LLM agents are not deterministic. Without a fixed design, the team
would read noise as progress.

## Decision

1. **Paired design with common random numbers.** Every strategy plays every seed of a fixed panel.
   Runs are compared within a block `(scenario_id, package_hash, generator_params_hash, seed)`.
   Generators draw from named per-generator, and where needed per-entity, streams
   (`derive_seed(seed, label, …)`), and draw exogenous events up front. So one strategy's actions
   cannot shift the draws another strategy sees.
2. **Disjoint dev and test seed panels**, plus a held-out scenario. Prompt and tool iteration
   happens on dev. Frozen versions are scored once on test.
3. **Metrics**: the four AAR components (and their raw values) are separate primary endpoints;
   the total is context only. Secondary: time to first order per zone, triage precision and recall
   against the truth log, stale-critical place-minutes, decisions on false information, rumour
   containment, and agent token and tool-call cost. All are computed after the run by models and
   the evaluator, in drill minutes at a fixed drill horizon. No LLM scores anything.
4. **Statistics**: the mean paired difference in metric units, a stratified BCa bootstrap CI, a
   sign-flip permutation test, Holm within the primary family (and separately within the
   secondary family), and d_z plus paired dominance as standardised effect sizes. The seed count
   comes from a pilot's paired-difference SD, inflated to its 80% upper limit and planned at α/m.
5. **Run manifest** `{scenario_id, package_hash, strategy_id, strategy_version, seed,
   generator_params_hash, actions_log_hash, metrics}`, plus `replicate` and a non-identity `meta`
   (clock mode, model, temperature, transcript hash, evaluator version). One JSON line per run.
   `strategy_version` is the hash of the full strategy config, so a changed prompt or tool is a
   new strategy.
6. **Prompt and tool A/B**: freeze the bench, change one config field, run R ≥ 3 replicates per
   seed, log full transcripts by `run_id`, and decide by a rule written before the test run.
7. The statistics live in `sim/evaluation.py` (standard library only, no I/O). The runner and the
   scorers will produce manifests and call it.

## Consequences

- Comparisons can be reproduced from the manifests and the bench hash, and the order of the inputs
  does not change a result.
- The generators of ADR 0030/0042 must use named streams. With agents on, the twin's single
  shared RNG stream breaks pairing until it is split per entity. The protocol measures that
  divergence meanwhile.
- The batch scorer needs `help_to_assign` in drill minutes (the AAR on `feat/drill-aar` uses wall
  minutes) and must stop the clock at the horizon before scoring.
- Agent comparisons cost R× more runs, and a single-seed what-if or drill is never evidence that one
  strategy beats another.
- Results remain planning experiments in a simulator, labelled `simulated`. They say nothing
  about real evacuation outcomes.
