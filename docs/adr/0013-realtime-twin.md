# 0013: A resumable traffic engine for the real-time twin

Date: 2026-10-24. Status: accepted (design). Contract: [twin-api.md](../twin-api.md).

## Context

`sim.traffic.simulate_traffic` runs the whole Camp horizon (14:00Z to 08:00Z, 6,481
steps of 10 s) in one call. All state lives in local variables of a ~970-line function
with nested helpers (`apply_event`, `set_fire`, `rebuild_routes`, `decide_departures`,
`run_controllers`, `record`). The batch replay, the bundle, `sim.variants`,
`sim.optimize` and the agent simulation (`simulate` with `sim.responders`) all go
through it.

The live drill replays the Camp Fire on a drill clock. Field reports and an agentic
controller act during the drill. For this the simulator must do five things:

- start at a replay time;
- advance with a clock (`step_to(t)`);
- accept commands mid-run;
- expose a compact snapshot for monitoring;
- run what-if forks from the current state, so a controller picks actions by measured
  outcomes.

Measured on the Camp bundle inputs (fixture demand, roads package `b1b318c16bbd3270`,
seed 7, this laptop, Python 3.12):

| Measurement | Time |
| --- | --- |
| Full `simulate_traffic` run, 18 h | 5.5 s |
| Inputs | 1.2 s |
| Fire front | 1.3 s |
| Run from 14:00Z to 18:00Z | 1.1 s |
| Run from 14:00Z to 19:00Z | 2.6 s (18:00–19:00Z, the busiest hour, costs about 1.5 s) |

En-route vehicles peak at 7,887 around 17:49Z. A profile of the run to 19:00Z shows:

- `point_in_geometry`, which tests which edges and origins the fire covers each
  minute, takes 44% of the time.
- The routing Dijkstra (`search` and `escape`) takes about 15%.
- Building the simulated front's geometry (`burned_mask`, `mask_contour`) takes about 11%.

## Decision

Turn the body of `simulate_traffic` into a resumable class, `sim.traffic.TrafficEngine`,
with explicit state, one `step()` per model step, event injection, and cheap
copy-on-fork. `simulate_traffic` stays as a thin wrapper:
`TrafficEngine(...).run_to_end(); return engine.result()`. Its signature and output do
not change, and neither does `MODEL_VERSION`. A new module, `sim/twin.py`, adds the
domain layer. That layer has the action catalog and validation, the action log, the
snapshot, what-if and the Camp factory. The twin is pure Python with JSON-serializable
inputs and outputs. The Django adapter comes later and only wraps it.

### Options considered

| | (a) Generator plus re-run from start | (b) Class with explicit state and fork (chosen) |
| --- | --- | --- |
| Refactor size | Small. The closure stays and the loop `yield`s. | Large. About 900 lines move into methods. |
| Parity risk | Low | Medium. A byte-identical parity check against `HEAD` mitigates it. |
| Fork | Impossible. Generators cannot be copied, so every what-if re-runs from 14:00Z. | About 10–40 ms (pickle round trip, outputs not copied). |
| What-if at 18:30Z, 60 min, 4 sets plus baseline | 5 × (about 3.5 s prefix plus 1.5 s) ≈ 25 s | 5 × about 0.8 s ≈ 4 s, with the fire cache below |
| Checkpoint, rebuild after restart | Re-run with the log | Re-run with the log (same mechanism), or keep forks |

Option (a) misses the "a few seconds" target late in the drill unless it runs many
processes in parallel. Option (b) meets it on one core. The extra risk of (b) is
mechanical, and an exact parity check catches it. Option (b) also keeps option (a)'s
best property. The action log fully determines a session, so log replay from the
start is the reference semantics. A fork is only a faster way to reach the same state,
and the verification checks that both agree.

### How the engine is shaped

- **Static and state.** Everything that never changes after setup goes in one
  `_EngineStatic` object. That includes the network arrays (`e_from`, `e_to`, `e_fft`,
  `in_edges`, `twin`), midpoint indexes, zone and destination lists, sorted historical
  events, params, `fire_area_at` and the agent attributes that are fixed at creation.
  Everything else is an engine attribute: queues, counters, sets, heaps, RNG,
  `generated`, recorded outputs.
- **One method per helper.** Each nested helper becomes a method with the same body
  and `self.` access. The loop body becomes `step()`, and the post-loop block becomes
  `result()`. Iteration orders (`sorted(active)`, `sorted(waiting)`, event order) and
  floating-point expressions do not change. Hot loops (steps 6 and 7, the Dijkstra
  searches, `record`) bind attributes to locals first. The rule is that a full run
  stays within 10% of today's 5.5 s.
- **Injection.** `inject(events)` schedules `TrafficEvent`s on a separate heap
  ordered by `(at, seq)`. Each step applies the due ones right after the controllers
  (stage 3b), with the same checks and `generated` entry as controller events. They
  are never merged into the historical event list. Merging would also change which
  destinations start closed, because that rule reads the first open or close event in
  the list.
- **Fork.** `fork()` pickles the dynamic state with a `persistent_id` that shares the
  static object, all callables (`fire_area_at`, responder `fire_lookup` closures) and
  fire geometries by identity. Recorded outputs (`frames`, `metrics`, `edge_peak`) are
  not copied. The fork starts empty buffers. On a 2.5 MB state, a pickle round trip
  took 37 ms; deepcopy took 117 ms and a hand-written copy 9 ms. Pickle copies
  everything not shared, so a new state field cannot be shared between branches by
  mistake.
- **Shared fire timeline.** With the default `fire_area_cumulative`, the fire's effect
  at each fire check depends only on the geometry sequence, never on traffic or
  actions. That effect covers newly exposed edges, newly burned origin nodes and new
  agent fire cues. `FireTimeline` stores those deltas once per check time. It also
  calls `fire_area_at` once per check time. Every engine, fork and session built on
  the same inputs reads from it. The engine still makes its own fire closures,
  generated events and drain-speed changes from the deltas. What-if branches therefore
  skip about half of the busy-hour cost, the point-in-polygon tests and the
  front-geometry building. When `fire_area_cumulative` is off, engines use the current
  per-engine code path.
- **Per-zone destination assignment** (`reroute_zone`). It reaches the engine as a new
  event type, `zone_rerouted` (with `zone_ids` and `destination_id`), so log replay
  goes through events like every other command. No historical event has this type.
  Assigned zones route by a
  per-destination reversed Dijkstra tree, built only for assigned destinations
  whenever the main tree is rebuilt. An assigned packet is admitted only at its
  destination. At any node where that destination is full, closed or unreachable over
  open edges, the packet falls back to the main tree, including the refuge and escape
  tiers, and the snapshot says so. With no assignments, the code takes exactly the old
  path.

## Invariants

These come from AGENTS.md, "Simulation and data integrity". Each one is checked
during implementation.

1. **Parity.** With no actions, `simulate_traffic` and a twin stepped to the end in
   any chunking give byte-identical results to `HEAD`'s `simulate_traffic` on the same
   inputs and seed. The Camp bundle file is byte-identical too.
2. **Population conservation.** The existing per-frame assertions in `record` stay.
   `snapshot()` asserts the same totals, and also checks that per-zone counts add up
   to the totals.
3. **No routing over closed edges.** Per-zone trees use the same `closed[e]` test as
   the main tree. A command cannot reopen a fire closure: `reopen_road` affects event
   closures only, as in the engine today.
4. **Explicit unreachable and full.** Destinations report `status:
   open|full|closed`. Assignments report `following|fallback_*`. Blocked and trapped
   counts are unchanged.
5. **Simulation clock.** The engine and twin never read the wall clock. The drill
   adapter maps its drill clock to a simulation time and calls `step_to`.
   `runtime_ms` in what-if results is measurement metadata only.
6. **Commands are labelled simulated events.** Every command becomes a
   `TrafficEvent` with `evidence_class: "simulated"`, source `twin-command` or
   `drill-report`, and a label prefix such as "Command (simulated)". It is appended to
   `generated` and the action log. Historical events stay in the run unchanged, and a
   later historical event (for example a TRA closing) still applies after a command.
7. **Determinism.** The same inputs fingerprint, seed and action log give the same
   state at every step. A fork plus actions gives the same state as a log replay from
   the start.

## Tradeoffs and limits

- `sim/traffic.py` grows and its structure changes in one large diff. Teammates
  working on `simulate_traffic` internals need to rebase onto the class. The
  `simulate_traffic` API does not change, so callers are unaffected.
- What-if runs sequentially in-process for v1. A spawn-based process pool (workers
  build the static inputs once and receive pickled fork state) is the scaling path.
  `os.fork` is not used, because the Django process has threads and a MongoDB pool
  (see the backend README).
- What-if ahead of `now` uses the replay's own future fire by default (`fire_ahead:
  "replay"`). That is a perfect fire forecast, a hindsight advantage like
  `sim.optimize`'s. `fire_ahead: "frozen"` holds the fire area at `now`
  (information-feasible, but it underestimates exposure). Every result states which
  one it used.
- In replay mode (behaviour off), departures follow pre-drawn delays. `warn_zone` then
  releases no demand: the call is accepted and returns a `no_effect` warning. Branches
  share the same delay draws (common random numbers). With agents on, forks inherit
  the RNG state and branches can diverge by chance. That case uses one seed only.
- Contraflow and hold corridors come from the Camp CHP corridors (Skyway, Clark Road,
  Pentz Road). Other incidents need their own corridor lists.
- There is no rewind. To go back, a session is rebuilt from its action log up to the
  earlier time.
- Model limitations are unchanged: no intersection control, contraflow is a capacity
  transfer, and the model is not calibrated. Twin outputs are planning experiments,
  not operational instructions.

## Consequences

- `docs/plan-api.md` branches become `Twin.replay(inputs, commands)` runs to the end.
  The same action catalog and validation serve the plan API, the drill and the
  controller.
- The monitoring page and the controller consume the [twin API](../twin-api.md). The
  backend adapter (a twin worker process per session behind Django) is a later change.
