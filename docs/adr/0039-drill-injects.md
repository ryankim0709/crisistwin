# 0039: Drill injects

Date: 2026-10-24. Status: accepted.

Builds on [0012-controller-guidance](0012-controller-guidance.md) (the labeled live drill),
[0013-realtime-twin](0013-realtime-twin.md) (twin commands) and
[0026-live-dispatch-clock](0026-live-dispatch-clock.md) (the drill clock). The scenario engine's
"injects" idea (ADR 0030, not in this branch) is the source of the types below.

## Context

A plan is only tested when something goes wrong. The drill replays 2018, so the controller never
sees a dead phone network, a 911 centre that stops taking a zone's calls, a road that closed
unreported, a shelter that filled early or a spot fire. An instructor needs to cause these at a
chosen drill time, and a script should be able to do the same.

## Decision

An **inject** is `{type, params, at, status, actor}` in `live_injects`, created, listed and
deleted by the controller through `GET/POST/DELETE incidents/{id}/injects`. `at` is drill time.
Five types ([live-reports.md "Injects"](../live-reports.md#injects)): `psap_reroute`,
`comms_outage`, `silent_closure`, `shelter_full`, `fire_jump`.

- **Effects are read from the documents, not pushed.** Each consumer asks "which injects hold at
  the drill's time?", so applying one twice changes nothing. `injects.apply_due` runs where the
  snapshot is loaded (as `groundrecord.materialize_due` does), moves the stored `status` with
  the clock by compare-and-set, and logs each change once in `live_decisions` as `inject_*`.
- **Rules are pure** (`livecore/injects.py`: validation, status, windows, spot geometry), so the
  generator of simulated comms (`sim/gen_comms.py`) and tests use them without Django. The
  generator reads the documented shape: zone ids and `[at, until)` windows of `psap_reroute`.
- **The field must not learn of a silent inject by itself.** `silent_closure` and `shelter_full`
  go to the twin only, as labeled operator commands (`close_road` hard, and a new
  `fill_destination` that raises the engine's existing `shelter_full` event). No report is
  created and guidance is not told; the plan meets the problem the way it would in life, through
  a report or a responder check. This is why the twin gets a command rather than the drill
  creating a `shelter_full` report.
- **`comms_outage` is a refusal, not a drop.** A civilian report or check-in from a dead zone
  gets `503 no_signal` with `Retry-After`, which is what the phone's offline outbox already
  handles. A zone is the one the report's location falls in, or the check-in's declared zone.
  Responders are exempt: they have radio.
- **`fire_jump` is an overlay** on the fire estimate (`estimate_fire(spots=...)`): a labeled
  circle, `evidence_class: simulated`, visible to the planner's route safety. The twin's fire
  timeline is precomputed and shared, so it does not change; the console says the spot is
  injected. This keeps the change small and honest.
- **Honesty.** Injects are `simulated`, labeled `Injected (simulated)` in lists, logs and on the
  map ("INJECT" tags, a hatched grey "NO SIGNAL" overlay, never colour alone). Nothing is sent
  to real people.

## Consequences

- A drill reset puts injects back to `scheduled` (they are the script); `live_init_db
  --drop-drill-data` drops them.
- Deleting a `silent_closure` reopens the road. A `shelter_full` already applied cannot be
  undone until the drill restarts, because the engine has no "unfill".
- The twin rebuilds when the drill clock moves back, and replays the due injects with its other
  commands.
- The console's instructor panel is in the `/live` header menu ("Injects"); its road picker uses
  the 150 longest named segments (`choices.segments`).
- `fire_jump` does not move the twin's traffic away from the spot; only the planner and the map
  see it.
