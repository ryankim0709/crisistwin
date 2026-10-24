# Headless batch runner

Runs **scenario × strategy × seed** at full speed, scores every run with the AAR on the drill
clock, writes one `RunManifest` per run and compares strategies with `compare_strategies`. It is
the runner the [strategy evaluation protocol](strategy-evaluation.md) calls for (ADR 0030 §4).
Decision: [ADR 0049](adr/0049-batch-runner.md). Code: `app/backend/api/live/batch.py`, command
`live_batch`, tests `app/backend/api/live/tests/test_batch.py`.

Every number it produces is a **simulated planning experiment**: generated 911/radio traffic,
simulated residents and responders, an uncalibrated traffic twin. A comparison says strategy B did
better than A in this simulator under its stated assumptions. It is never a claim about real
evacuations, and nothing here sends anything to anyone.

## Run it

From `app/backend`, with the backend venv. No server and no MongoDB writes; `MONGODB_URI` is only
read by Django settings. The Camp twin needs the package artifacts under `data/incidents/` (or
`CRISISTWIN_REPO_ROOT` pointing at a checkout that has them) and the bundle at
`app/public/replays/camp-2018.json` (both git-ignored).

```sh
MONGODB_URI=mongodb://127.0.0.1:27017 \
LIVE_DRILL_BUNDLE=$PWD/../public/replays/camp-2018.json \
python manage.py live_batch --spec api/live/specs/camp-2018-pilot.json \
    --strategies historical_only,rule_auto,record_delay_5 --workers 8 --out /tmp/batch-pilot
```

Outputs in `--out`: `manifests.jsonl` (appended, one run per line), `comparison.md` and
`comparison.json`. `--compare-only <manifests.jsonl>` re-runs only the statistics.
`--seeds`, `--panel`, `--start` and `--end` override the spec. `--workers N` forks one process per
seed block (POSIX only; the manifests are identical to a serial run apart from `meta["run.wall_s"]`).

In Python:

```python
from api.live import batch
spec = batch.load_spec("api/live/specs/camp-2018-pilot.json")
world = batch.build_world(spec)                    # bundle, drill index, twin inputs (about 13 s)
seeds = spec.seed_list(batch._sim()[1])            # evaluation.seed_panel(n, panel, root)
results = batch.run_batch(world, [batch.make_strategy(s) for s in ("historical_only", "rule_auto")], seeds)
markdown, table_json = batch.compare_runs([r.manifest for r in results])
```

## Scenario spec (JSON)

```jsonc
{
  "kind": "crisistwin_batch_scenario",
  "scenario_id": "camp-2018-drill",
  "package": {"kind": "camp_bundle", "path": "app/public/replays/camp-2018.json"},  // or drill_package
  "window": {"start": "2018-11-08T14:30:00Z", "end": "2018-11-08T18:00:00Z"},       // UTC; end = horizon
  "clock": {"mode": "lockstep", "tick_s": 60, "decision_every_min": 1},
  "injects": [{"type": "silent_closure", "at": "2018-11-08T15:10:00Z", "params": {"segment_id": "osm-way:…"}}],
  "record_2018": true,                                   // 2018 record entries enter the queue
  "comms": {"enabled": true, "scale_911": null},         // sim/gen_comms.py CommsOptions
  "residents": {"enabled": true, "app_adoption": 0.25},  // any sim/gen_residents.py ResidentParams field
  "responders": {"enabled": true, "units": 6, "tempo": 1.0},
  "twin": {"enabled": true},
  "auto_policy": true,                                   // the live auto-approval of pure reroutes
  "seeds": {"panel": "dev", "n": 8, "root": 0}           // or {"list": [..]}
}
```

| Field | Meaning |
| --- | --- |
| `package` | `camp_bundle`: a replay bundle; the twin, residents and comms all run. `drill_package`: a Studio drill package (ADR 0037); planner, responders and injects run, but the twin is Camp-only today, so there are no residents, no comms and no twin metrics (the AAR drops those components) |
| `window` | Drill time of the start and the horizon. The clock stops at `end` and the run is scored there |
| `clock` | `lockstep` only (`realtime@k` is not built). `tick_s` (multiple of the 10 s twin step) is the stepping and generator cadence; the strategy is called every `decision_every_min` |
| `injects` | Drill injects (`livecore/injects.py` types). `silent_closure` closes the road in the twin and is the responders' ground truth; `shelter_full` fills the destination in the twin; `fire_jump` adds a spot to the fire estimate; `psap_reroute` drops 911 entries (record and generated) of its zones; `comms_outage` drops resident app traffic of its zones |
| `comms` | Generated 911/radio/rescue items, drawn **up front** from the seed with the Camp calibration (`tests/fixtures/ground_rates_camp_2018.json`) |
| `residents` | Simulated residents from the twin (reports, check-ins, help requests, destination choices) |
| `responders` | Simulated units (`livecore/responders_sim.py`) that accept tasks, drive and close them |
| `seeds` | `evaluation.seed_panel(n, panel, root)` |

Everything except `scenario_id`, `package` and `seeds` is hashed into `generator_params_hash`
(including the clock, so runs with different cadences never pair).

## Strategy interface

```python
class Strategy(Protocol):
    strategy_id: str        # manifest strategy_id
    drill_system: bool      # False only for the historical baseline
    max_queue: int          # review-queue items in the observation
    def config(self) -> dict: ...                 # hashed into strategy_version
    def decide(self, observation: dict) -> list[dict]: ...
```

**Observation**: exactly the digest the MCP `get_situation` tool returns
(`orchestrator_mcp/crisistwin_mcp/digest.py`, `situation_digest`), built from the run's in-memory
state instead of the HTTP command endpoint: clock, fire estimate, zones with guidance and twin
counts, the review queue with flags and party counts, help requests, responders, tasks, pending
proposals with changes, road state and twin totals. Times are drill times.

**Actions**: `{"tool": <MCP write tool>, "args": {...}}`, the names and arguments of the MCP
server's write tools, applied in order:

| Tool | Args |
| --- | --- |
| `triage_report` | `report_id`, `action` (confirm, dismiss, merge, resolve), `into`, `note` |
| `approve_proposal` | `proposal_id`, `zone_ids` (subset: the rest becomes a child pending proposal), `note` |
| `reject_proposal` | `proposal_id`, `note` |
| `replan` | none |
| `create_task` | `kind` (verify, assist), `target` {`segment_id`, `coord`}, `report_ids`, `assignee`, `note` |
| `handle_help` | `checkin_id`, `action` (acknowledge, assign, resolve), `assignee`, `note` |

A rejected action (unknown id, closed request) returns `{"ok": false, "error", "detail"}` and is
counted in `run.tool_errors`. The strategy never sees the score, the truth or the generator
parameters (`get_aar` answers `aar_unavailable`).

Built-in strategies (`make_strategy(name)`):

| Name | Behaviour |
| --- | --- |
| `historical_only` | Baseline: only the bundle's historical actions (2018 orders and closures). The drill system is off: no planner, no proposals, no guidance |
| `rule_auto` | Every decision: approve every pending proposal; confirm every unreviewed, non-record queue item backed by 2 or more parties (`civilian_parties + responder_reports` as the digest counts them); assign the nearest responder (straight line to its last location; any responder if none is known) to every open help request |
| `record_delay_<N>` | As `live_compare_record` variant B: confirm each 2018-record queue item of kind `road_blocked` or `fire_seen` N drill minutes after its newest record time, and approve every pending proposal |
| `mcp_agent` | Adapter for the teammate's orchestrator (below) |

### Plugging in an orchestrator agent (`mcp_agent`)

The adapter runs one **turn** per decision tick with the drill clock paused (lockstep). It sends:

```json
{"type": "turn", "now": "2018-11-08T15:05:00Z", "situation": "<get_situation JSON>", "tools": ["get_situation", "…"]}
```

The agent answers with any number of tool calls and then ends the turn:

```json
{"type": "call", "tool": "approve_proposal", "args": {"proposal_id": "prp_000003"}}
{"type": "result", "ok": true, "content": "{…tool JSON…}"}          // runner -> agent
{"type": "done", "usage": {"tokens_in": 1234, "tokens_out": 210}}
```

Tools: the read tools `get_situation`, `get_zone`, `get_report` (digests as the MCP server returns
them) and the six write tools above, with the MCP server's names and arguments; writes apply
immediately, so the agent sees their effect in later reads of the same turn. At most 40 calls per
turn. The agent is either a Python callable `agent(message) -> reply` or a command speaking one
JSON object per line on stdin/stdout:

```sh
python manage.py live_batch --spec … --strategies historical_only,mcp_agent \
    --agent-cmd "python my_agent_bridge.py" --agent-name teammate-v1 --out /tmp/agent-ab
```

A bridge for an MCP-speaking agent forwards each `call` to its tool loop instead of the MCP
client, and puts the model's token counts in `done.usage` (they become `agent.tokens_in/out`).
Confirms within a turn trigger **one** replan at the end of the turn (the next turn sees its
proposal). For an LLM agent, run R ≥ 3 replicates per seed and record the model, temperature and
prompt hashes in `agent_config` (they enter `strategy_version`). The runner itself never calls a
network service or an LLM; the tests use a scripted callable and a trivial subprocess.

## The run (lockstep)

Every `tick_s` drill seconds, in this order:

1. the twin steps to `t` (commands issued at the previous tick apply now);
2. due injects apply;
3. generators feed the state: 2018 record entries (`historical_record`, as
   `groundrecord.materialize_due`), generated comms items (`simulated`; 911 and rescue as
   civilian callers, one party per call; radio as responders), resident events (reports,
   check-ins and help requests, destination choices), responder calls (join, location, accept,
   report, done, cancel);
4. road closures sync to the twin (public blocks and controller-confirmed blocks, as
   `twin_service`);
5. the drill system replans when the fire estimate, the blocked set or the full shelters
   changed (`controller.maybe_auto_replan`): planner, proposal diff, auto-publish of pure
   unexposed reroutes, the rest as one pending proposal;
6. on a decision tick, the strategy decides and its actions apply; published guidance becomes
   `order_zone` and `reroute_zone` twin commands.

At the horizon the clock stops (the twin is at the horizon) and the run is scored.

What mirrors the live backend: triage statuses, replan causes (`road_block`, `fire`,
`road_report`, `shelter_full`, `manual`), the crowd-hold rule, the auto policy, proposal
superseding, guidance versions, help request flow (assign creates an assist task; a done task
resolves the request), responders' accept rules. Record and generated-comms entries count for
nothing (road state, public map, fire) until confirmed, like the 2018 record in the live drill.

Simplified on purpose: no twin-scored controller (`rule` controller only), no planner
alternatives or task suggestions in proposals, no LLM rationales, no events stream, and the
destination preferences are counted but not fed to the planner's load term.

## Scoring and manifests

`aar.compute_aar(context, data, time_basis="drill")` on the run's in-memory documents. All
minutes are drill minutes; the twin numbers are read at the horizon. Manifest metrics:

| Key | |
| --- | --- |
| `aar.arrived_share`, `aar.exposed_trapped.raw`, `aar.help_to_assign.raw`, `aar.leave_now_vs_2018.score` | Primary (protocol §3) |
| `aar.<component>.raw`, `aar.<component>.score`, `aar.total`, `aar.coverage` | All four components |
| `help.requests`, `help.to_resolve_median_min`, `triage.median_min`, `leave_now.zones_missed` | AAR details |
| `run.*` | Counts: replans, auto_publishes, approvals, confirms, tasks_created, help_assigned, tool_calls, tool_errors, twin_commands, twin_errors, reports per source, dropped_psap, dropped_outage |
| `agent.tokens_in`, `agent.tokens_out`, `agent.turns` | `mcp_agent` only |

`meta` holds the clock mode, tick, cadence, horizon, twin seed and inputs fingerprint, planner and
evaluator versions, the strategy config, invariant failures (vehicle conservation, non-negative
counts) and `run.wall_s` (cost only, kept out of `metrics` so metrics stay deterministic).
`actions_log_hash` hashes the decision log, the tool calls and the twin's action-log hash. Runs
with invariant failures are excluded from the comparison and listed in it.

`compare_runs` compares every strategy against `historical_only` (or `--baseline`) on the four
primary metrics and a secondary family (`aar.help_to_assign.score`, `aar.total`,
`help.to_resolve_median_min`, `run.confirms`), and appends per-strategy means.

## Determinism and common random numbers

- Every stream is named from the panel seed with `derive_seed`: `twin` (TrafficParams.seed),
  `comms`, `residents`, `responders`. Ids are counters; no wall time enters the state.
- The same spec, strategy and seed give identical metrics, `actions_log_hash` and `run_id`
  (tests: same world, fresh world, forked worker vs serial).
- Comms items are drawn up front from the seed: identical for every strategy in a block. The
  2018 record is fixed. Responders key their draws per (unit, task).
- **Twin**: the live twin runs with `behavior.enabled = false`. Departure delays are drawn when
  the engine is built (`rng_coupling: common_delay_draws`) and the engine draws nothing after
  that, so the twin itself adds no chance divergence between strategies: every difference in
  twin outcomes is caused by the strategies' commands (directly or through shared roads).
- With agents on (`behavior.enabled`), the engine draws decisions, preparation times and turn
  backs from one shared stream (`sim/traffic.py`, `brng`), so one strategy's order reshuffles
  every other zone's draws. Measured on 3 seeds (one zone ordered at 14:40 vs nothing): the other
  42 zones' arrivals at 18:00 moved by 671 vehicles in sum on average with agents off (caused by
  shared roads) and 1,012 with agents on, about 50% more ([ADR 0049](adr/0049-batch-runner.md)).
  The batch runner keeps agents off; per-agent streams are the fix if agent runs are compared.
- The resident generator uses one event stream per run (`sim/gen_residents.py`), so once two
  strategies' twins differ, which household reports what also differs by chance. This adds
  within-block noise to resident-driven metrics (help requests, reports); it does not touch the
  exogenous streams.

## Pilot (Camp 14:30–18:00Z, 3 strategies × 8 dev seeds)

**Pilot, dev panel, not a result.** Spec `api/live/specs/camp-2018-pilot.json` (lockstep, 1-min
ticks and decisions, all generators on, 6 responder units), bundle hash `bd70838d61a72980`.
8 forked workers on a 12-core laptop: 177 s wall for all 24 runs; per run about 16 s
(`historical_only`), 52–58 s (`record_delay_5`) and 72–84 s (`rule_auto`) under that contention;
serial re-runs took 65 s (`rule_auto`) and 39 s (`record_delay_5`) and reproduced the forked
runs' metrics, action hashes and run ids exactly. Building the world takes 13 s.

| Metric | historical_only | record_delay_5 | rule_auto | Δ rule_auto − baseline, 95% BCa CI, Holm p |
| --- | --- | --- | --- | --- |
| `aar.arrived_share` (higher better) | 0.292 | 0.298 | 0.325 | +0.033 [0.024, 0.044], p 0.047 (better) |
| `aar.exposed_trapped.raw` veh-min/veh (lower better) | 15.83 | 19.26 | 18.01 | +2.18 [0.70, 3.83], p 0.078 (no detectable difference) |
| `aar.help_to_assign.raw` drill min | – (never assigns) | – | 0.0 | no pairs (baseline has none) |
| `aar.leave_now_vs_2018.score` | 0.000 | 0.803 | 0.803 | +0.803, p 0.047 (better) |
| `aar.total` (secondary) | 10.2 | 26.5 | 42.5 | +32.3 |

`record_delay_5` vs baseline: arrived +0.007 [−0.002, 0.020] (no detectable difference), exposure
+3.43 [1.51, 4.59] veh-min/veh (worse, p 0.047). Reading the pilot:

- With 8 pairs the exact sign-flip test's smallest p is 2/256 ≈ 0.008, and Holm over 8 primary
  comparisons lifts it to about 0.047: 8 seeds are only just enough to reject when a strategy wins
  on every seed. Use `plan_from_pilot` on these differences before a test-panel run.
- `help_to_assign.raw` is 0 for `rule_auto` because in lockstep a help request that arrives in a
  tick is answered in the same tick; the baseline never assigns, so its raw value is missing and
  every block drops. The 0–1 `aar.help_to_assign.score` (secondary) carries the comparison:
  1.0 for `rule_auto` and 0.0 for the other two on every seed.
- Drill guidance moves more vehicles earlier and also raises exposure in this simulator (orders
  put vehicles on roads the fire reaches). That is a finding about the model, not about Camp.

## Limitations

- Lockstep measures decisions without latency; `realtime@k` is not built.
- One scenario family: the twin, residents and comms run only on the Camp bundle.
- No truth-log scorer (ADR 0042) and no staleness metric (ADR 0041) yet, so triage precision and
  recall are not in the manifests.
- Generated comms and the 2018 record are both on in the pilot spec; they describe the same
  channels, so the queue carries more calls than either alone. Turn one off for a cleaner scenario.
