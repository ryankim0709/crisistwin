# Twin API: a real-time traffic twin with commands and what-if (v0.1, draft)

`sim/twin.py` is a Python API, standard library only, that runs the Camp traffic replay
step by step on a simulation clock. The design and invariants are in
[ADR 0013](adr/0013-realtime-twin.md). The twin can:

- accept commands mid-run;
- report a compact snapshot for the monitoring page;
- fork what-if branches, so a controller can compare candidate actions by simulated
  outcomes.

Everything at the boundary is JSON-serializable: dicts, lists, strings, numbers and
null. The future HTTP adapter (see "HTTP adapter (later)" below) passes these bodies
through unchanged.

Conventions follow [replay-bundle.md](replay-bundle.md):

- Times are UTC ISO 8601 with `Z`. Inputs may also be `datetime` objects with a timezone.
- Units are part of field names: `_veh`, `_s`, `_min`, `_kph`, `_veh_min`.
- Coordinates are `[lon, lat]`.
- Edges are referred to by **edge index**. The index is the position in the bundle's
  `roads.edges` and `traffic.edge_ids`, which is the network edge order. The page
  already has those arrays.
- Every twin output is `evidence_class: "simulated"`. These are planning experiments,
  not operational instructions.

## Clock model

- The model step is `step_s` (10 s). The engine starts at the scenario start (Camp:
  `2018-11-08T14:00:00Z`) and ends at the scenario end (`2018-11-09T08:00:00Z`).
- `now` is the time of the last completed step. The snapshot describes the state after
  that step.
- A twin created with `start_at` runs every step from the scenario start up to
  `start_at`, with no commands. Historical demand and road events therefore apply
  exactly as in the replay. This takes about 1 s at 18:00Z.
- `step_to(t)` runs every step with time `<= t`. A `t` before `now` raises
  `clock_backwards`. A `t` after `end` is clamped, and `finished` becomes true.
- A command takes effect at the first step after `now` whose time is `>= at`. Without
  `at`, that is `now + step_s`. A command is never applied to a step that has already
  run.
- The twin never reads the wall clock. The drill maps its own clock to a simulation
  time and calls `step_to`.

## Python API

```python
from sim.twin import Twin, ActionError

twin = Twin.for_camp(
    package="data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65",
    roads_package="data/incidents/camp-2018-evacuation/b1b318c16bbd3270",
    demand="auto",                 # as `python3 -m sim bundle --demand`
    seed=7,                        # TrafficParams.seed; bundle default
    start_at="2018-11-08T16:30:00Z",
    keep_frames=False,             # True keeps bundle-style frames (needed for result())
)
twin.step_to("2018-11-08T16:45:00Z")   # -> {"now": "...Z", "step_index": 990, "steps": 90, "finished": false,
                                        #     "clamped": false, "events_cursor": 212}
twin.step(n=1)                          # same reply; runs n steps
twin.catalog()                          # commandable zones, roads, corridors, destinations, limits
twin.apply({...})                       # -> accepted action record; raises ActionError
twin.validate({...})                    # dry run: same checks, no state change
twin.snapshot(detail="full")            # "summary" omits per-edge rows
twin.events(since=212)                  # -> {"cursor": 230, "events": [...]}
twin.action_log()                       # accepted actions in order
twin.whatif([[...], [...]], horizon_min=60, fire_ahead="replay")
twin.fork()                             # independent Twin at the same state
twin.provenance()                       # inputs fingerprint, versions, seed, log hash
twin.result()                           # traffic block, as simulate_traffic returns (keep_frames=True, finished)
Twin.replay(inputs, action_log, until="...Z")   # rebuild a session from its log (or from plain plan-api actions)
```

Static inputs (history, scenario, fire front, fire lookup and the shared
`FireTimeline`) are built once per process for each `(package, roads_package, demand,
seed)` and reused by every session.

- `Twin.for_camp` reads the inputs the same way the `bundle` command does
  (`camp_replay_inputs`, `_simulated_fire`, `_fire_area_lookup`).
- `Twin.from_inputs(TwinInputs(...), start_at=...)` accepts any prepared scenario, for
  example `sim.incidents.package_replay_inputs`. The Camp catalog's corridors are
  Camp-specific.

The registry's `camp-2018` uses the grounded roads package `17e67cfe5669fe50`. That
package has census demand and NIST TRAs as refuges. The bundle command above uses
`b1b318c16bbd3270`, which has fixture demand and exits only, so it offers no refuges.
Parity holds for whichever pair of packages the bundle was built from.

`Twin.replay` also accepts plain actions without `seq` and `issued_at`, as in plan-api: each
is issued one step before its `at`, so it applies at `at`.

Calls on one `Twin` are not thread-safe. The adapter serializes them per session.
`whatif` takes its forks at the start and never changes the session.

## Actions

The shape follows [plan-api.md](plan-api.md) commands, extended for the drill:

```jsonc
{
  "id": "c7",                         // unique in the session; generated if omitted
  "type": "contraflow",
  "at": "2018-11-08T16:50:00Z",       // optional; default: next step. Must be >= now and <= end
  "target": { "corridor": "Skyway" },
  "params": {},
  "actor": { "kind": "controller", "id": "agentic-controller-v0" },   // controller | operator | field_report; default operator
  "rationale": "Skyway outbound at 22% of free-flow for 12 min"         // free text, stored, never parsed
}
```

### Catalog

| `type` | target | params | becomes `TrafficEvent` | notes |
| --- | --- | --- | --- | --- |
| `order_zone` | `zone_id` or `zone_ids` | | `evacuation_order` | `already_ordered` if every zone is ordered |
| `warn_zone` | `zone_id` or `zone_ids` | | `evacuation_warning` | In replay mode (behaviour off) it releases no demand: accepted with warning `no_effect` |
| `close_road` | road selector | `mode`: `entry` (default) or `hard` | `road_closed` (`closure_drains` = `mode == "entry"`); a `field_report` with `mode: "hard"` becomes `road_blocked` | `hard`: vehicles on the edge stop until it reopens |
| `reopen_road` | road selector | | `road_reopened` | Event closures only. Edges closed only by fire give `fire_closed_not_reopenable` |
| `capacity_changed` | road selector | `capacity_factor` in (0, 1] | `capacity_changed` | Partial block. A factor of 1 restores |
| `contraflow` | `corridor` | | `contraflow_started` on the corridor's outbound edges | The inbound twin edges close (a derived event). Uses a CHP unit |
| `end_contraflow` | `corridor` | | `contraflow_ended` | Frees the unit |
| `hold_inbound` | `corridor` | | `road_closed` (`closure_drains`) on the corridor's outermost inbound edges | Uses a CHP unit. Release with `reopen_road` on `{ "corridor": ..., "hold": true }` |
| `open_refuge` | `destination_id` | | `shelter_opened` | Only a `temporary_refuge` or `shelter` that is closed now. A later historical close still applies |
| `reroute_zone` | `zone_id` | `destination_id` (null clears) | `zone_rerouted` (new engine event type: `zone_ids` plus `destination_id`) | Falls back to the nearest open destination at nodes where the assigned one is full, closed or unreachable |

`end_contraflow` is an addition to the plan-api list. The engine already supports it,
and a controller needs to be able to undo contraflow.

Road selectors are resolved to edge ids when the action is accepted. The log keeps both
the selector and the edge ids.

- `{ "edge_indexes": [123, 124] }` or `{ "edge_ids": ["osm-way:...:f"] }`
- `{ "road_name": "Pentz Road", "near": [-121.588, 39.781], "radius_m": 300, "direction": "both" }`: edges
  whose canonical name matches (`sim.events.canonical_road_name`) and whose midpoint is
  within `radius_m`. `direction` is `both`, `outbound` (toward the nearest exit by
  free-flow time) or `inbound`.
- `{ "road_name": "Pentz Road" }` with no `near` selects every edge of that name and
  returns a `whole_road` warning.
- `{ "corridor": "Skyway" | "Clark Road" | "Pentz Road" }`: the corridors of
  `sim.responders.CAMP_EGRESS_CORRIDORS`, selected as `ChpTrafficControl` does.

Limits are named constants in `sim/twin.py`. The catalog shows them; `apply` enforces
them:

- `contraflow` and `hold_inbound` share `CHP_UNITS = 2` staffed corridors.
- `close_road` is limited to `FIRE_CLOSURE_MAX_ROADS_PER_CHECK = 3` named roads per 5
  simulated minutes for each actor.
- Orders have no rate limit. CodeRED could order many zones at once.

These are planning assumptions taken from `sim.responders`, not agency rules.

### `apply` result

```json
{
  "ok": true,
  "action": {
    "seq": 4, "id": "c7", "type": "contraflow", "status": "scheduled",
    "issued_at": "2018-11-08T16:45:00Z", "effective_at": "2018-11-08T16:50:00Z",
    "target": {"corridor": "Skyway"},
    "resolved": {"edge_indexes": [5120, 5121, 5188], "zone_ids": [], "destination_id": null,
                 "corridor": "Skyway"},           // corridor actions; road actions add "road_keys" (canonical names)
    "params": {},
    "actor": {"kind": "controller", "id": "agentic-controller-v0"},
    "rationale": "Skyway outbound at 22% of free-flow for 12 min",
    "event_ids": ["twin-c7"],
    "label": "Command (simulated): start contraflow on Skyway",
    "evidence_class": "simulated",
    "warnings": []
  },
  "warnings": []
}
```

`status` changes from `scheduled` to `applied` at the effective step. Labels have
these prefixes:

- `Command (simulated): ` for `controller` and `operator`;
- `Drill field report (simulated): ` for `field_report`.

The `TrafficEvent` has:

- `id`: `twin-{action id}`;
- `source_id`: `twin-command` or `drill-report`;
- `source_locator`: the actor id;
- `time_precision`: `model_step`.

### Validation errors

`apply` raises `ActionError(code, detail, action_id)`. Its `to_dict()` is
`{"error": "invalid_action", "code": "...", "detail": "...", "action_id": "c7"}`.
`ActionError` and `ClockError` subclass `TwinError`, which every other rejected call raises.
Codes:

| Area | Codes |
| --- | --- |
| Shape | `unknown_action_type`, `invalid_shape` (missing or extra fields, wrong types), `duplicate_action_id` |
| Time | `at_in_past`, `after_end`, `session_finished` |
| Targets | `unknown_zone`, `unknown_destination`, `unknown_corridor`, `unknown_road`, `no_edges_selected`, `not_a_refuge` |
| State | `already_ordered`, `already_open`, `not_closed`, `fire_closed_not_reopenable`, `contraflow_active`, `contraflow_not_active`, `no_reverse_edge` |
| Params | `invalid_capacity_factor`, `invalid_mode`, `unknown_destination` |
| Limits | `limit_exceeded` (detail names the limit) |
| Clock (`ClockError`, `"error": "invalid_clock"`) | `clock_backwards`, `start_out_of_range`, `invalid_steps` |
| Other calls (`TwinError`, `"error": "twin_error"`) | `invalid_whatif`, `invalid_detail`, `invalid_cursor`, `session_finished`, `frames_not_kept`, `not_finished` |

`limit_exceeded` counts only corridors staffed by twin commands (contraflow or hold,
scheduled or in effect). Historical contraflow in the replay does not use a unit, but a
corridor already in contraflow gives `contraflow_active`.

Warnings do not block an action: `no_effect`, `whole_road`,
`partially_closed_already`, `destination_full`, `destination_closed`.

## Snapshot

`snapshot(detail="full")` returns the state at `now`. `detail="summary"` leaves out
`edges`, `closed`, `exposed` and `contraflow`. The full Camp snapshot at peak is
roughly 40–80 KB of JSON.

```jsonc
{
  "kind": "crisistwin_twin_snapshot",
  "schema_version": "0.1.0",
  "evidence_class": "simulated",
  "session": { "id": "camp-2018-paradise-slice:7:9c1e4b0a", "incident": "camp-2018-paradise-slice" },
  "clock": { "now": "2018-11-08T17:00:00Z", "start": "2018-11-08T14:00:00Z",
             "end": "2018-11-09T08:00:00Z", "step_s": 10, "elapsed_s": 10800,
             "step_index": 1080, "finished": false },
  "model": { "id": "meso-link-queue", "version": "0.2.0", "sim_version": "0.1.0", "seed": 7,
             "inputs_fingerprint": "9c1e4b0a77d2f310", "action_log_hash": "e3b0c44298fc1c14",
             "behavior": false },
  "totals": {                              // same keys as bundle traffic.metrics rows
    "total_veh": 15000,
    "not_departed_veh": 6120, "en_route_veh": 6402, "arrived_veh": 2478,
    "blocked_veh": 310, "exposed_veh": 145, "exposed_at_origin_veh": 820,
    "trapped_by_fire_veh": 40, "trapped_by_closure_veh": 0,
    "open_refuges": 0, "active_refuges": 0,
    "exposed_veh_min_so_far": 2140.0,      // integrals since start, at record_every_s
    "exposed_at_origin_veh_min_so_far": 9050.0
  },
  "zones": [                               // every zone, scenario order
    { "id": "fz1", "name": "Fixture zone 1", "vehicles": 142,
      "ordered_at": "2018-11-08T15:13:00Z", "warned_at": null,
      "not_departed_veh": 0, "en_route_veh": 12, "arrived_veh": 130,
      "blocked_veh": 0, "exposed_veh": 0, "exposed_at_origin_veh": 0,
      "assignment": null },
    { "id": "fz14", "name": "Fixture zone 14", "vehicles": 410,
      "ordered_at": "2018-11-08T15:29:00Z", "warned_at": null,
      "not_departed_veh": 95, "en_route_veh": 300, "arrived_veh": 15,
      "blocked_veh": 20, "exposed_veh": 35, "exposed_at_origin_veh": 95,
      "assignment": { "destination_id": "exit:osm-node:86371270", "status": "following",
                      "action_id": "c5" } }   // status: following | fallback_full | fallback_closed | fallback_unreachable
                                              // (unreachable: from none of the zone's origin nodes)
  ],
  "destinations": [                        // every destination
    { "id": "exit:osm-node:86371270", "name": "Exit south via Table Mountain Boulevard", "kind": "exit",
      "status": "open", "arrived_veh": 1210, "capacity_veh": null, "remaining_capacity_veh": null,
      "full_at": null, "arrived_last_10_min_veh": 240 }
  ],
  "edges": {                               // occupied edges only, ascending edge index
    "fields": ["edge_index", "veh", "speed_kph", "queued_veh"],
    "rows": [[5120, 85, 14.2, 60], [5121, 40, 31.0, 5]]
  },                                       // queued_veh: past free-flow time, waiting to leave
  "closed": {                              // every closed edge; cause per closure set
    "fields": ["edge_index", "cause"],     // cause: event | event_drain | fire | contraflow_inbound
    "rows": [[812, "fire"], [5300, "contraflow_inbound"]]
  },
  "exposed": [812, 813, 900],              // edge midpoint inside the fire area in effect
  "contraflow": [[5120, 5300]],            // [outbound edge, borrowed reverse twin]
  "capacity_factors": [[7001, 0.5]],
  "commands_in_effect": [                  // accepted actions whose effect is still in place
    { "action_id": "c7", "type": "contraflow", "since": "2018-11-08T16:50:00Z" }
  ],
  "events_cursor": 230
}
```

In `totals`:

- `blocked_veh` counts vehicles on stopped or dead-end edges and at nodes with no
  route.
- `exposed_veh` counts vehicles on fire-exposed edges.
- `exposed_at_origin_veh` counts vehicles not yet departed whose origin node is inside
  the fire area.

These definitions are the same as in the bundle.

`snapshot()` checks two things, and raises if either fails:

- `not_departed + en_route + arrived == total_veh`, with every term nonnegative;
- the per-zone values add up to the totals.

### Event feed

`events(since=cursor)` returns the entries appended to `generated` since `cursor`, in
bundle event shape (`id`, `at`, `type`, `label`, `evidence_class`, `time_precision`,
`target`, `source`). These include modelled fire closures and reopenings, entrapments,
derived contraflow closures, and command and report events. Historical scenario events
come from the bundle. The page already shows them at their times.

## What-if

```python
twin.whatif(action_sets, horizon_min=60, include_baseline=True, fire_ahead="replay", labels=None)
```

The baseline and each candidate set run on their own fork of the current state:

1. Validate the set's actions in order against the fork. A set with an invalid action
   is reported as `valid: false` with its errors and is not run.
2. Apply the actions. An `at` in the future schedules the action, so sequences such as
   "contraflow now, order zone 30 min later" work.
3. Step to `min(now + horizon_min, end)` and record metrics every `record_every_s`
   (60 s).

The baseline is set index 0, labelled "no new actions": the current action log only.
The session itself never changes.

Request body for the adapter. The Python arguments are the same:

```json
{
  "horizon_min": 60,
  "fire_ahead": "replay",
  "action_sets": [
    [{"type": "contraflow", "target": {"corridor": "Skyway"}}],
    [{"type": "contraflow", "target": {"corridor": "Clark Road"}},
     {"type": "reroute_zone", "target": {"zone_id": "fz14"}, "params": {"destination_id": "exit:osm-node:86371270"}}],
    [{"type": "close_road", "target": {"road_name": "Pentz Road", "near": [-121.588, 39.781], "radius_m": 300}},
     {"type": "order_zone", "target": {"zone_ids": ["fz30", "fz31"]}, "at": "2018-11-08T17:15:00Z"}]
  ],
  "labels": ["Skyway contraflow", "Clark contraflow + fz14 south", "Close Pentz, order 30-31"]
}
```

Result:

```jsonc
{
  "kind": "crisistwin_twin_whatif",
  "schema_version": "0.1.0",
  "evidence_class": "simulated",
  "from": "2018-11-08T17:00:00Z", "until": "2018-11-08T18:00:00Z",
  "horizon_min": 60, "horizon_clamped": false,
  "fire_ahead": "replay",                  // "replay": the replay's future fire (perfect forecast, hindsight);
                                           // "frozen": fire area held at `from` (information-feasible, underestimates exposure)
  "seed": 7, "rng_coupling": "common_delay_draws",   // agents on: "shared_state_at_fork"
  "inputs_fingerprint": "9c1e4b0a77d2f310", "action_log_hash": "e3b0c44298fc1c14",
  "objective": {
    "name": "window_cost_veh_min", "sense": "minimize",
    "formula": "1.0*total_exposed_veh_min + 60.0*blocked_at_horizon_veh + 1.0*remaining_at_horizon_veh",
    "weights": { "total_exposed_veh_min": 1.0, "blocked_at_horizon_veh": 60.0, "remaining_at_horizon_veh": 1.0 }
  },
  "results": [
    { "set_index": 0, "label": "no new actions", "valid": true, "errors": [], "actions": [],
      "metrics": {
        "exposed_veh_min": 6100.0, "exposed_at_origin_veh_min": 30200.0, "total_exposed_veh_min": 36300.0,
        "en_route_veh_min": 390000.0,
        "arrived_in_window_veh": 2900, "arrived_at_horizon_veh": 5378,
        "not_departed_at_horizon_veh": 2100, "en_route_at_horizon_veh": 7522,
        "remaining_at_horizon_veh": 9622,
        "blocked_at_horizon_veh": 420, "peak_blocked_veh": 510, "peak_exposed_veh": 160,
        "trapped_by_fire_at_horizon_veh": 55, "new_fire_entrapment_events": 2,
        "all_arrived_at": null,
        "destinations_full_at_horizon": [],
        "arrived_in_window_by_destination_veh": { "exit:osm-node:86371270": 900 }
      },
      "objective": 71122.0, "runtime_ms": 820 },
    { "set_index": 1, "label": "Skyway contraflow", "valid": true, "errors": [],
      "actions": [ { "id": "w1-1", "type": "contraflow", "effective_at": "2018-11-08T17:00:10Z",
                     "resolved": { "edge_indexes": [5120, 5121, 5188], "corridor": "Skyway" },
                     "label": "Command (simulated): start contraflow on Skyway" } ],
      "metrics": { "...": "same keys" },
      "objective": 64010.0,
      "delta_vs_baseline": { "objective": -7112.0, "arrived_in_window_veh": 640, "total_exposed_veh_min": -900.0,
                             "blocked_at_horizon_veh": -20 },
      "runtime_ms": 870 },
    { "set_index": 3, "label": "Close Pentz, order 30-31", "valid": false,
      "errors": [ { "code": "already_ordered", "detail": "fz30 ordered at 2018-11-08T16:05:00Z", "action_id": "w3-2" } ] }
  ],
  "ranking": [1, 2, 0],                     // valid sets by objective, ties by set_index
  "limitations": [
    "Single seed; small differences are not significant.",
    "fire_ahead=replay uses the replay's future fire as a perfect forecast (hindsight).",
    "Planning experiment from a simulation; not operational instructions."
  ]
}
```

How the metrics are computed over the window `(from, until]`, on frames every
`record_every_s`:

- `*_veh_min` are sums of each count over the frames × frame minutes, as in
  `sim.variants.headline_metrics`.
- `*_at_horizon_*` are taken at `until`.
- `remaining_at_horizon_veh` is `total_veh - arrived_at_horizon_veh`.
- `all_arrived_at` is the first frame with every vehicle arrived, or null.

The objective is a planning heuristic in vehicle-minutes. The weights are named
constants (`WHATIF_WEIGHT_*`), not calibrated. A controller may rank the sets on the
metrics with its own weights, but it must state those weights.

Performance target, Camp on this laptop (measured 2026-10-24 on the bundle inputs; "cold" is the
first engine in a process, which also builds the `FireTimeline`):

| What-if, 4 sets plus the baseline, 60 min | Cold | Warm |
| --- | --- | --- |
| from 15:30Z | 0.9 s | 0.7 s (about 120 ms per branch) |
| from 17:30Z | 2.5 s | 1.4 s (about 250 ms per branch) |
| from 18:00Z | 2.7 s | 1.3 s |

Targets:

- one 60-minute branch in the busiest hour (17:30–18:30Z): at most about 1 s;
- four sets plus the baseline: at most about 5 s, run one after another;
- off-peak hours: under 1 s in total.

How the twin gets there:

- forks cost about 40 ms;
- branches skip the fire geometry work through the shared `FireTimeline`;
- branches record metrics only (no frames, no edge statistics);
- a branch stops early once every vehicle has arrived.

Results are deterministic for a given state, sets, horizon and `fire_ahead`. The
twin caches the baseline branch on `(step_index, action_log_hash, horizon_min,
fire_ahead)`.

## Provenance, determinism and seeds

- `provenance()` returns:
  - `inputs_fingerprint`: sha256 over the network, demand, destinations, historical
    events, params, start, end, fire model id and version, and ignition, as in
    `sim.variants.basis`;
  - `sim_version`, `model.version`, `seed`;
  - `start_at`;
  - `action_log_hash`: sha256 of the canonical JSON action log.
- The same fingerprint, seed and action log give the same snapshot at every step.
  `Twin.replay(inputs, log, until)` rebuilds a session after a restart, or rewinds it
  by truncating the log. A fork followed by `apply` is required to equal a log replay.
- In replay mode, every packet's departure delay is drawn from `seed` when the engine
  is built, independent of commands. What-if branches therefore share their draws.
- With agents on (`behavior.enabled`), decisions consume a seeded RNG stream. A fork
  copies that stream, and commands change how much of it is consumed. Results from one
  seed then carry chance divergence.
- The action log is the session's record:
  - it is append-only;
  - each entry carries the actor, rationale, issued and effective times, the selector
    and the resolved targets;
  - commands never edit or remove historical events.

## How a controller uses it

```python
snap = twin.snapshot(detail="full")
candidates = controller.propose(snap, twin.catalog())      # rules or an LLM: proposes actions only
report = twin.whatif(candidates, horizon_min=60)
best = report["ranking"][0]
if best != 0:                                               # 0 = no new actions
    for action in report["results"][best]["actions"]:
        twin.apply({**action, "actor": {"kind": "controller", "id": controller.id},
                    "rationale": f"whatif {report['from']}: objective {report['results'][best]['objective']}"})
```

An LLM may propose candidate actions and explain the results. Every number it uses must
come from `whatif` or `snapshot` (AGENTS.md). The controller logs which report and
weights justified each action.

## HTTP adapter (later, `app/backend`)

The Django adapter wraps this API without changing the bodies. Each session gets its own
twin worker process (`multiprocessing`, spawn), so the CPU-bound stepping runs outside
the web threads and never shares the MongoDB client pool. Django talks to the worker
over a `multiprocessing.connection` pipe. Sessions expire after a TTL.

| Method and path | Python | Notes |
| --- | --- | --- |
| `POST /api/twin/sessions` `{incident, start_at, seed?, demand?}` | `Twin.for_camp` | `201 {session_id, clock, provenance}` |
| `GET /api/twin/sessions/{id}/catalog` | `catalog()` | Same shape as `GET /api/sim/catalog` |
| `POST /api/twin/sessions/{id}/clock` `{to}` | `step_to` | Driven by the drill clock. `409 clock_backwards` |
| `GET /api/twin/sessions/{id}/snapshot?detail=summary\|full` | `snapshot` | `Cache-Control: no-store` |
| `GET /api/twin/sessions/{id}/events?since=` | `events` | |
| `POST /api/twin/sessions/{id}/actions` | `apply` | `201` action record. `400 {"error":"invalid_action","code",...}` |
| `GET /api/twin/sessions/{id}/actions` | `action_log` | |
| `POST /api/twin/sessions/{id}/whatif` | `whatif` | `202 {job_id}`, then poll as in plan-api. `429` when a what-if is already running for the session |

- Clients poll with an `AbortController` and drop stale responses by `clock.step_index`.
- Server-sent events for snapshots can come later.
- DRF's default `IsAuthenticated` stays for these routes. A demo exception needs its
  own decision and throttling.
- `POST /api/sim/plans` from plan-api becomes `Twin.replay(inputs, commands)` run to
  the end with `keep_frames=True`.
