# 0049: Headless batch runner for strategy evaluation

Date: 2026-10-24. Status: accepted.

## Context

The strategy evaluation protocol ([strategy-evaluation.md](../strategy-evaluation.md), ADR
`0046-strategy-evaluation.md`) needs runs of scenario × strategy × seed at full speed, scored in
drill time, with common random numbers. The live drill cannot do that: its state lives in MongoDB,
its clock is wall time scaled by a speed, the AAR read help minutes on the wall clock, and the
generators (comms, residents, responders) were drivers around HTTP. `live_compare_record` already
ran the twin and planner headless for one seed and three fixed variants.

## Decision

1. **In-memory run state, one drill clock.** `api/live/batch.py` keeps each run's reports,
   decisions, proposals, guidance versions, check-ins, tasks and responder positions in memory, in
   the shapes of the `live_*` collections, every time on the drill clock. No MongoDB namespace is
   used, so runs are isolated and fast, and nothing can leak into the shared database. Ids are
   counters.
2. **Lockstep only.** The twin and generators step at fixed `tick_s`; the strategy is called every
   `decision_every_min` with the clock paused. `realtime@k` is left for later.
3. **The live rules, reused.** The run calls the pure livecore pieces the backend uses (planner,
   `policy.diff`/`partition`, crowd hold, `public.road_state`/`public_items`, fire estimate with
   inject spots, inject rules, responders' `Fleet`) and mirrors the controller glue
   (`controller.replan`, `maybe_auto_replan`, triage, help, publish, twin sync). Deliberate
   simplifications (rule controller only, no alternatives or task suggestions, no rationales) are
   listed in the doc.
4. **Strategy interface = the MCP surface.** A strategy gets the `get_situation` digest
   (`orchestrator_mcp/crisistwin_mcp/digest.py`, imported in-process; it is stdlib-only) and
   returns MCP write-tool calls. The `mcp_agent` adapter serves the read and write tools in-process
   over a JSON-lines turn protocol (callable or subprocess), so the teammate's orchestrator can be
   evaluated without a server. Confirms within one turn coalesce into one replan at the turn's end.
5. **AAR refactor.** `aar.compute_aar(context, data, time_basis)` is pure; `build_aar` (the
   endpoint) gathers from MongoDB and calls it with `time_basis="wall"`, unchanged. Batch runs use
   `time_basis="drill"`. `planner.plan` takes optional cached zone-to-fire distances (the slow
   part), computed once per fire geometry per world.
6. **Seeds.** `derive_seed(seed, "twin" | "comms" | "residents" | "responders")`. Comms are drawn up
   front; the decision cadence is part of `generator_params_hash`, so different cadences never pair.

## Twin pairing finding

The live twin runs with agents off: departure delays are drawn at build time and the engine draws
nothing afterwards, so the twin adds no chance divergence between strategies. We measured what
agents on would add (3 dev seeds, Camp 14:30–18:00Z, one zone ordered at 14:40 vs no action, sum
over the other 42 zones of |Δ arrived vehicles| at 18:00):

| Twin | Seed 1 | Seed 2 | Seed 3 | Mean |
| --- | --- | --- | --- | --- |
| Agents off (live config): causal only, via shared roads | 586 | 632 | 796 | 671 |
| Agents on (`behavior.enabled`, one shared stream) | 924 | 977 | 1,135 | 1,012 |

Repeated runs were identical in both modes. With agents on, the other zones move about 50% more,
and on one seed the extra order lowered total arrivals (11,105 to 11,066), which the agents-off
twin never shows. That excess is the shared stream reshuffling every zone's draws (an upper
bound: agents also add some causal coupling). We did not split the stream: the runner keeps agents
off, and splitting `brng` per agent changes `sim/traffic.py` results for every agent run. If agent
runs are ever compared, give each agent its own stream (`derive_seed(seed, "behavior", agent)`)
first.

## Consequences

- Batch results are reproducible from (package hash, generator parameters, strategy version,
  seed): the same inputs give identical metrics and action hashes, serial or forked.
- The runner duplicates some controller glue; a change to the live replan or triage rules must be
  mirrored in `RunState` (bump `EVALUATOR_VERSION`).
- Only the Camp bundle has a twin, residents and comms; drill packages run without them.
- The resident generator's single event stream still adds within-block noise once twins differ.
