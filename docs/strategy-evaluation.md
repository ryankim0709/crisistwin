# Strategy evaluation protocol (v0.1, draft)

How CrisisTwin compares **response strategies** across scenarios and seeds. A strategy might be a
human controller, the rule planner on auto (`auto_policy`), or an orchestrator agent driving the
controller surface over MCP with a given model, prompt and tool set. Decision:
[ADR 0046](adr/0046-strategy-evaluation.md). Statistics: `sim/evaluation.py`, tested in
`tests/test_evaluation.py`.

Every number here comes from a simulation (generated fire, people, comms and noise; the traffic
twin; the AAR drill score). A result says that **strategy B did better than strategy A in this
simulator, under its stated assumptions**. It is a planning experiment, never a claim about real
evacuation outcomes, and it must not be reported as one.

Status: the statistics, the run manifest and the headless runner (ADR 0030 §4;
[batch-runner.md](batch-runner.md), ADR `0049-batch-runner.md`) are built. The batch AAR scores
help in drill minutes and stops the clock at the horizon. The truth-log scorer (ADR 0042) and the
staleness metric (ADR 0041) are not built yet. This document is their contract.

## 1. Experimental design

### Factors

| Factor | Levels | Notes |
| --- | --- | --- |
| Scenario | Drill packages, e.g. `camp-2018-drill` and Studio scenarios | Each has a `package_hash` and a noise profile (`clean`, `typical`, `hostile`; ADR 0042) whose parameters are hashed into `generator_params_hash` |
| Strategy | `strategy_id@strategy_version` | Any change to the prompt, tools, model, temperature or decision cadence gives a new `strategy_version` (§7) |
| Seed | A fixed **seed panel** per scenario | The root seed for every generator stream |
| Replicate | 0..R-1 | Repeated runs of a non-deterministic strategy (an LLM agent) on the same seed. Deterministic strategies use R = 1 |

The design is a full cross **scenario × strategy × seed** (× replicate), run headless with the
drill clock. The **block** is `(scenario_id, package_hash, generator_params_hash, seed)`: runs in
one block faced the same inputs and the same random draws.

### Common random numbers (paired design)

Every strategy plays every seed, and runs are compared **within a block**. The fire, the
residents, the 911 and radio traffic, responder availability and the noise (wrong roads, rumours,
late uploads) are then identical up to the point where the strategy's actions change them. The
paired difference cancels seed-to-seed variation ("this seed had a fast fire"), which is usually
most of the variance:

`Var(B − A) = σ_A² + σ_B² − 2ρ σ_A σ_B`

With equal variances and ρ = 0.8, `Var(B − A)` is 0.4σ² instead of the 2σ² of an unpaired
design, so pairing needs a fifth of the seeds. The pilot (§2) measures the actual ρ.

Common random numbers hold only if a strategy's actions cannot shift the draws that other parts of
the world consume. Rules for the generators (ADR 0030 §2, ADR 0042):

- Give each generator its own stream: `random.Random(derive_seed(seed, "fire"))`,
  `derive_seed(seed, "residents")`, `derive_seed(seed, "comms")`, `derive_seed(seed, "noise")`,
  `derive_seed(seed, "responders")`.
- Where the number of draws depends on what a strategy does (a resident decides whether to obey
  guidance, a unit finds what it finds at a task), key the stream per entity:
  `derive_seed(seed, "residents", household_id)`. One resident drawing more numbers then cannot
  change another resident's draws.
- Draw exogenous events (ignitions, spotting, rumour onsets, tower outages, a road's true state
  over time) **up front** from the seed, independent of the strategy. The truth log is then the
  same for every strategy on a seed, apart from the parts strategies cause (who got out).
- The twin's replay mode already draws departure delays at build time (`rng_coupling:
  common_delay_draws`, [twin-api.md](twin-api.md#provenance-determinism-and-seeds)). With agents
  on (`behavior.enabled`) the twin consumes one shared stream, so strategies on one seed carry
  chance divergence. Use per-entity streams there before relying on pairing, or measure the
  divergence (§6).

A test checks the property: `tests/test_evaluation.py::test_streams_give_common_random_numbers`.

### Seed panels

`seed_panel(n, "dev")` and `seed_panel(n, "test")` give reproducible, disjoint seed lists.

- **dev**: prompt and tool iteration, debugging, pilots. Look as often as you like.
- **test**: confirmatory comparisons only. A strategy is frozen (version hash) before it touches
  test seeds. Record every test-panel evaluation of every candidate, not just the winner.
- Hold out at least one **scenario** as well as seeds. An agent tuned on Camp is then also scored
  on a fire it was not tuned on.

### Clock and horizon

- Batch runs use the **drill clock**, never wall time (AGENTS.md). Every metric is measured at the
  same drill horizon for every strategy in a block (the scenario's end time, or a fixed
  `T + 6 h`). The AAR reads the twin "at the current twin clock", so the runner must stop the clock
  at the horizon before scoring.
- **Clock mode** is a named part of the design, recorded in `meta.clock_mode`:
  - `lockstep`: the clock pauses while the strategy decides, and the strategy is called every
    `Δ` drill minutes and on events. This measures decision quality without latency, and is the
    default for agent comparisons.
  - `realtime@k`: the clock runs at `k`× while the strategy thinks. This measures quality under
    time pressure and is the only fair mode for comparing a human with an agent.
  - Never compare runs across clock modes, and never compare different `Δ`s or `k`s.

### Human controllers

People cannot play 30 seeds, and a person who replays a seed remembers its fire. For human
strategies:

- each person plays each seed **at most once**; the automated strategies play the same seeds, so
  the human run is still paired with them;
- to compare two human conditions (two console layouts, say), use a crossover: each person plays
  both on different seeds, with the order counterbalanced, and pair on person instead of seed;
- report human results with their n, the participants' experience and the clock mode, and treat
  them as descriptive unless the power calculation (§2) is met.

## 2. How many seeds: power from pilot variance

1. **Choose the minimum effect worth acting on (`δ`) per primary metric before the pilot**, in the
   metric's units. For example: 0.05 on `aar.arrived_share` (five percentage points of vehicles),
   or 0.25 veh-min per vehicle on exposure. Never use the pilot's observed difference as `δ`.
2. **Pilot**: run the baseline and the candidate on 8–12 **dev** seeds per scenario. Compute the
   paired differences per metric.
3. **Plan**: `plan_from_pilot(metric, pilot_diffs, δ, n_comparisons=m)` returns the number of
   paired blocks. It:
   - inflates the pilot SD to its 80% upper confidence limit (`sd_upper_bound`, Browne 1995),
     because a small pilot underestimates the SD half the time;
   - plans at `α / m`, Holm's strictest step, where `m` is the number of primary comparisons
     (primary metrics × treatments);
   - uses the paired-t sample size with Guenther's correction:
     `n = ((z₁₋α/2 + z_power) σ_d / δ)² + z₁₋α/2² / 2`. This reproduces exact noncentral-t
     answers: 15, 34 and 199 pairs for `δ/σ_d` = 0.8, 0.5 and 0.2.
4. Take the **largest n over the primary metrics**. Spread it evenly over scenarios
   (`ceil(n / S)` seeds each) for a pooled claim. A per-scenario claim needs the full n in each
   scenario.
5. Replicates do not replace seeds. They shrink only the agent's own noise inside a block (§6).

Pairs needed for 80% power at two-sided α = 0.05 with Holm over `m` comparisons, by `δ / σ_d`:

| m \ δ/σ_d | 1.0 | 0.8 | 0.5 | 0.3 |
| --- | --- | --- | --- | --- |
| 1 | 10 | 15 | 34 | 90 |
| 4 | 15 | 21 | 48 | 128 |
| 8 | 17 | 24 | 55 | 146 |
| 12 | 18 | 26 | 60 | 157 |

Worked example (**illustrative numbers, not measured**). A pilot of 10 dev seeds gives paired
differences on `aar.arrived_share` with SD 0.055. The 80% upper limit is 0.071. With δ = 0.05 and
four primary components against one baseline (m = 4), `plan_from_pilot` asks for **26 pairs**: 13
seeds in each of two scenarios.

## 3. Metrics

Each run's metrics are computed **after** the run, by models and the evaluator, from the audit
data, the twin and the truth log. No LLM computes or grades a metric (AGENTS.md, Firm). Manifest
keys are flat strings; `None` means the metric has no data in that run.

### Primary: AAR drill score components, separately

The AAR score (`app/backend/api/live/aar.py` on `feat/drill-aar`) is a weighted mean of four
components clamped to [0, 1]. It drops components without data and renormalises the rest. So two
runs' totals can average different things, and the clamp hides differences beyond the bounds.
Analyse the components, and their raw values, as separate primary endpoints:

| Key | Component (weight) | Better | Unit | Notes |
| --- | --- | --- | --- | --- |
| `aar.arrived_share` | Vehicles arrived (0.35) | higher | share of vehicles | twin, simulated |
| `aar.exposed_trapped.raw` | Exposed or trapped vehicle-minutes (0.30) | lower | veh-min per vehicle | use the raw value; the 0–1 score floors at 5 veh-min/veh |
| `aar.help_to_assign.raw` | Median help to responder assigned (0.15) | lower | **drill** minutes | today's AAR uses wall minutes, which are meaningless at batch speed; the batch scorer must use drill time |
| `aar.leave_now_vs_2018.score` | Leave-now vs 2018 (0.20) | higher | 0–1 | only scenarios with a historical order record; `None` elsewhere, and those blocks are dropped and counted |

Also record `aar.<component>.score` for each component, `aar.total` and `aar.coverage`. Report
`aar.total` for context, but do not test it. If you must compare totals, compare only blocks where
both runs have `coverage == 1`.

### Secondary (exploratory, their own Holm family)

| Key | Definition | Better | Unit |
| --- | --- | --- | --- |
| `first_order_min.median` (and `first_order_min.<zone_id>`) | Per zone: from the **trigger** (the truth-log time the simulated fire first comes within the planner's `EVACUATE_NOW_KM` of the zone) to the first `evacuate_now`. Zones never threatened are excluded. A zone never ordered before the horizon is censored at the horizon and counted in `first_order.missed_zones` | lower | drill minutes |
| `triage.confirm_precision`, `triage.confirm_recall` | Against the truth log (ADR 0042): of the reports confirmed (or merged into a confirmed one), the share true at decision time; of the true reports received at least `TRIAGE_GRACE_MIN` before the horizon, the share confirmed | higher | share |
| `triage.dismiss_precision`, `triage.dismiss_recall` | The same for dismissals of false reports | higher | share |
| `stale_critical_min` | Over the run at a 1-minute drill cadence: the sum over the top-N information-priority places (ADR 0041, computed by the evaluator with the model code and a fixed N per scenario) of the minutes each was staler than its half-life | lower | place-minutes |
| `decisions_on_false_info` | Consequential decisions (guidance change, reroute, closure, dispatch, task assignment) whose cited reports were all false at decision time | lower | count |
| `rumour_containment_min` | From a rumour's onset to its dismissal or to a public correction | lower | drill minutes |
| `agent.tokens_in`, `agent.tokens_out` | Summed over the run's model calls | lower | tokens |
| `agent.tool_calls`, `agent.tool_errors` | MCP tool calls, and calls rejected by validation | lower | count |
| `run.wall_s` | Wall seconds for the run. Cost only, never a quality metric | lower | s |

Also run the invariant checks (non-negative counts, population conservation, no routing over closed
edges). A run that fails one is **excluded and reported**, never silently dropped.

## 4. Statistics

`compare_strategies(runs, baseline, treatments, metric_specs)` runs this whole section.

- **Unit of analysis**: the block. Replicates are averaged within a block first (`pair_runs`).
  Blocks where either side's metric is `None` are dropped, and the table reports how many.
- **Estimate**: the mean paired difference `Δ = treatment − baseline`, in the metric's units.
  This raw-unit difference is the headline effect size. With equal seeds per scenario, the
  pooled mean weights scenarios equally.
- **Confidence interval**: 95% BCa bootstrap (Efron 1987), 10,000 resamples,
  **stratified by scenario**, so each resample keeps the scenario mix. The seed is derived from the
  comparison's names, so results do not depend on input order. Percentile intervals are available
  (`method="percentile"`).
- **Test**: a two-sided paired sign-flip permutation test of mean Δ = 0. It is exact (all 2ⁿ
  sign patterns) for n ≤ 16, and otherwise uses 20,000 seeded resamples with p = (1 + hits) /
  (1 + R). It needs no normality assumption, which matters for clamped and skewed drill scores.
- **Multiplicity**: Holm–Bonferroni within each family. The primary family is every primary
  metric × every treatment against the one baseline. Secondary metrics form their own family and
  are labelled exploratory. Compare candidates against a single reference strategy (the rule
  planner on auto). All-pairs comparisons multiply the family size, and the power plan must use
  that larger `m`.
- **Effect sizes**: `d_z = mean(Δ) / sd(Δ)` (paired), and **paired dominance**
  `(#Δ>0 − #Δ<0)/n`: the share of seeds the treatment won minus the share it lost (the paired
  analogue of Cliff's delta; `cliffs_delta` exists for unpaired samples). Pairing shrinks `sd(Δ)`,
  so a paired d_z is larger than a between-groups d and is not comparable to Cohen's benchmarks.
  Report it, but judge practical importance by Δ against the pre-set δ.
- **Verdict** per row: `treatment better` or `treatment worse` when Holm rejects (the direction
  comes from `MetricSpec.higher_is_better`); otherwise `no detectable difference`, or
  `insufficient pairs` below 3. The CI is a per-comparison 95% interval. It can exclude 0 while the
  Holm-adjusted test does not reject. In that case the verdict stands, and the text says so.
- **Heterogeneity**: report per-scenario Δ descriptively (filter the runs, then call
  `compare_strategies` per scenario). If the scenarios disagree in sign, say so before any pooled
  claim.
- **Trade-offs**: when a candidate is better on quality but costs more tokens, state both. Do not
  fold cost into a single score.

## 5. Reporting templates

### Run manifest (one JSON line per run)

```jsonc
{
  "kind": "crisistwin_eval_run", "schema_version": "0.1.0", "evidence_class": "simulated",
  "scenario_id": "camp-2018-drill",
  "package_hash": "17e67cfe5669fe50",          // drill package content hash
  "strategy_id": "orchestrator:teammate-agent",// human:<id> | rule_planner:auto | orchestrator:<name>
  "strategy_version": "a41c09e2b7d3f018",      // hash_json(strategy config), section 7
  "seed": 464402050, "replicate": 0,
  "generator_params_hash": "c03b5d1e9a7f4420", // hash_json(generator + noise profile params)
  "actions_log_hash": "826d386c86a663a3",      // twin provenance action_log_hash, or hash_json(decision log)
  "metrics": { "aar.arrived_share": 0.71, "aar.exposed_trapped.raw": 1.8, "aar.help_to_assign.raw": null,
               "triage.confirm_precision": 0.83, "agent.tool_calls": 41 },
  "meta": { "clock_mode": "lockstep", "decision_every_min": 5, "horizon": "2018-11-08T22:00:00Z",
            "model": "<model id>", "temperature": 0.0, "transcript_sha256": "…", "evaluator_version": "…" }
}
```

`RunManifest` validates the fields (non-empty hashes, a non-negative int seed, finite numeric
metrics or `None`). `run_id` hashes the identity fields; `block` is the pairing key.
`design_issues(runs)` flags a scenario with two package hashes, duplicate runs, blocks missing a
strategy, and unequal seeds per scenario. Fix these before you compare anything.

### Comparison table

`results_table_markdown(comparisons)` produces this (the numbers are from the synthetic unit-test
fixture, not a real comparison):

| Family | Metric | Better | Baseline | Treatment | n | Baseline mean | Treatment mean | Δ (T − B) | CI | p (Holm) | d_z | Dominance | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| primary | aar.arrived_share (share) | higher | rule_planner@v1 | orchestrator@v1 | 24 | 0.613 | 0.714 | 0.101 | [0.097, 0.104] (95%) | <0.001 | 11.72 | 1.00 | treatment better |
| primary | aar.exposed_trapped.raw (veh-min/veh) | lower | rule_planner@v1 | orchestrator@v1 | 24 | 1.996 | 2.001 | 0.004 | [-0.009, 0.019] (95%) | 0.540 | 0.13 | 0.00 | no detectable difference |
| secondary | agent.tool_calls (calls) | lower | rule_planner@v1 | orchestrator@v1 | 24 | 0.000 | 40.500 | 40.500 | [40.500, 40.500] (95%) | <0.001 | inf | 1.00 | treatment worse |

`results_table_json(comparisons, runs=…, settings=…)` returns the same rows. It adds the run ids,
the design issues and the settings (n_boot, seed, α, CI method). Archive it with the manifests.

### Methods paragraph

> Planning experiment in a simulation. We compared *{treatments}* against *{baseline}* on
> *{S}* scenarios (*{scenario ids, package hashes}*) under the *{noise profile}* noise profile,
> *{n}* test-panel seeds per scenario, *{R}* replicates per seed for LLM strategies, clock mode
> *{lockstep, Δ = 5 drill min}*, horizon *{…}*. Seeds were fixed before the runs and shared by all
> strategies (common random numbers). Primary metrics (pre-specified, minimum effects δ): *{…}*.
> Paired differences were averaged over replicates per seed. We report mean differences with 95%
> stratified BCa bootstrap intervals (10,000 resamples) and sign-flip permutation p-values,
> Holm-adjusted over *{m}* primary comparisons. *{k}* runs were excluded for invariant failures
> and *{j}* blocks dropped for missing metrics. Agent settings: *{model, temperature, prompt and
> tool-manifest hashes}*. These are simulated outcomes under stated assumptions, not predictions
> of real evacuations.

### Per-scenario table

The same columns as the comparison table with a Scenario column, from one `compare_strategies`
call per scenario. Label it "descriptive, not multiplicity-adjusted across scenarios".

## 6. Pitfalls

- **Overfitting prompts to one scenario.** Iterate on dev seeds only, and score frozen versions on
  test seeds and a held-out scenario. Count how often you looked at the test panel and report it.
  Watch for prompts that name places, roads or times from a dev scenario.
- **Leakage of the truth log.** The truth log (`sim_truth`) must be unreadable by the console,
  phones and MCP tools during a run (ADR 0042), and the evaluator reads it only after the horizon.
  Leaks also come from people. Do not write prompts after reading test-seed truth logs or
  transcripts. Do not expose the noise profile name or generator parameters through a tool. Do not
  let an agent read the historical 2018 order times when `leave_now_vs_2018` is scored: an agent
  that can see the answer will time its orders to it.
- **Hindsight in tools.** What-if with `fire_ahead: "replay"` uses the future fire as a perfect
  forecast. Give agents `fire_ahead: "frozen"` in scored runs, or record the setting in the
  strategy config and never compare across it.
- **Wall clock vs drill clock.** Score in drill minutes at a fixed drill horizon. Today's AAR
  `help_to_assign` is in wall minutes. That is fine for a watched drill and wrong for a batch run.
  Keep clock mode and cadence fixed within a comparison (§1).
- **Non-determinism of LLM agents.** The same seed and prompt can give different actions. Record
  the model id, temperature, top_p, max tokens, the prompt and tool-manifest hashes, and the
  provider's seed if it has one. Run R ≥ 3 replicates per seed for agents. Report the
  within-block spread across replicates next to the between-seed SD of Δ. If replicate spread
  dominates, raise R before raising seeds. Temperature 0 does not make agents deterministic, so
  still replicate.
- **Twin chance divergence.** With twin agents on, a shared RNG stream means two strategies can
  diverge by chance after their first different action (§1). Measure it by running one strategy
  twice on the same seed with a no-op change. Δ should then be 0.
- **Clamped and missing components.** Scores clamp at 0 and 1, and components without data drop
  out and renormalise the total. Analyse raw values and report dropped blocks.
- **Optional stopping.** Fix n from the power plan. Adding seeds until p < 0.05 invalidates the
  test. If you must look early, pre-register the looks.
- **Censoring.** A zone never ordered has no time to first order. Censor it at the horizon and
  count it. Never drop it, because dropping makes a strategy that orders nothing look fast.
- **Version drift.** The manifest pins the package, generator parameters and strategy. Also pin
  the evaluator (`meta.evaluator_version`: the AAR constants, scorer code hash). Re-score old runs
  rather than mixing evaluator versions in one table.

## 7. Prompt and tool A/B protocol for the orchestrator agent

This is for the teammate's orchestrator agent, which drives the controller surface over MCP
(ADR 0030 §3). An A/B compares two **versions** of one agent.

1. **Freeze the bench**: the scenario list with package hashes, the noise profile, the seed panels
   (`seed_panel(n, "dev")`, `seed_panel(n, "test")`), the horizon, the clock mode and cadence, and
   the evaluator version. Write them to a bench file and hash it. Every run in the A/B cites this
   hash in `meta.bench`.
2. **Define the strategy version**: `strategy_version = hash_json(config)`, where `config` is
   `{model, temperature, top_p, max_tokens, provider_seed, system_prompt_sha256,
   tool_manifest_sha256, decision_every_min, max_tool_calls_per_turn, memory_policy}`. A and B
   differ in **exactly one** of these fields. Write the field and the diff in the change record.
   For tool A/Bs, change one tool at a time (add, remove or re-describe it), and keep the tool
   results' format unchanged unless that format is the thing under test.
3. **Log the transcripts**: for every model call, store the request (system and messages), the
   response, the tool calls with arguments and results, token counts, latency, and the drill time
   of the call. Store one file per run, named by `run_id`, and put its sha256 in
   `meta.transcript_sha256`. Transcripts are evaluation data. They stay out of prompts for later
   versions on the test panel, and they contain no secrets.
4. **Iterate on dev**: run A and B on the dev panel with R replicates and use the transcripts to
   find failure modes. Nothing measured on dev is a result.
5. **Confirm on test**: freeze B. Run A and B on the test panel and the held-out scenario, using
   the n from the power plan and the same R. Call `compare_strategies(runs, A, [B], specs)`.
6. **Decide by a rule written before the test run.** For example: adopt B if at least one primary
   metric is `treatment better` and no primary metric's CI lies wholly beyond the
   non-inferiority margin `−δ/2`. Report token and tool-call cost alongside.
7. **Record the result** in a change record: the bench hash, A and B configs, the changed field,
   the table JSON, and the decision with its reason. A losing B is recorded too.

The agent never computes its own score. It can propose actions and explain them, but every
metric comes from the twin, the AAR and the truth-log scorer after the run.

## API summary (`sim/evaluation.py`)

| Function or class | Purpose |
| --- | --- |
| `derive_seed(root, *labels)`, `seed_panel(n, panel, root)` | Named random streams; reproducible dev and test seed panels |
| `canonical_json`, `hash_json(obj, length=16)` | Canonical JSON and its truncated sha256 |
| `RunManifest` (`to_dict`, `to_json`, `from_dict`, `block`, `strategy`, `run_id`) | The run record |
| `design_issues(runs)` | Balance and consistency checks |
| `pair_runs(runs, metric, baseline, treatment)` → `PairedSample` | Block pairing with replicate averaging |
| `paired_differences`, `quantile` | Basic helpers (type-7 quantile) |
| `bootstrap_ci(xs, stat, level, n_boot, seed, method, strata)` → `BootstrapCI` | Percentile or BCa, optionally stratified |
| `sign_flip_test(diffs, n_permutations, seed)` | Paired permutation p-value |
| `holm(pvalues, alpha)` → `[HolmResult]` | Holm–Bonferroni adjustment |
| `cohens_dz`, `paired_dominance`, `cliffs_delta`, `magnitude` | Effect sizes |
| `paired_sample_size`, `paired_power`, `sd_upper_bound`, `chi2_ppf`, `plan_from_pilot` → `PowerPlan` | Power and sample size |
| `MetricSpec`, `compare_strategies` → `[Comparison]` | The full comparison |
| `results_table_markdown`, `results_table_json` | Report tables |

Run the tests from the repository root: `python3 -m unittest tests.test_evaluation -v`.
