# 0019: Live dispatch monitor, staged evacuation waves and resident notices

Date: 2026-10-24. Status: accepted for the demo. Amends [0014](0014-dispatch-agent.md) and
[0017](0017-dispatch-anywhere.md).

## Context

The dispatcher called Claude at a fixed cadence (every 10 simulated minutes, sooner on urgent
alerts), whether or not anything had changed, and could only order a zone out immediately. Its
detached modules were not wired into `/dispatch` after the page moved to the Simulation Studio UI.
We want an agent that stays on shift: it watches the simulation, acts only when the situation
changes, and evacuates in waves so neighbourhoods are not all sent onto the same roads at once.

## Decision

- **Reattached on the Studio.** `/dispatch` renders `SimulationStudioPage` with an `aside`
  component, `StudioDispatch`. It takes the current (non-stale) run, loads the OSM area for the box
  the fires threaten, draws the dispatch overlay on the studio's 3D scene (`StudioDiorama` reports
  its scene through `onSceneChange`), and drives the studio's playback clock while a session runs.
  Studio playback is locked meanwhile. Editing or re-running the scenario ends the session.
- **The loop stays the SDK call we already have.** No orchestration framework. The page is the
  scheduler, and `POST /api/dispatch/decide` remains a single streamed Messages call with one
  `issue_orders` tool.
- **Live monitor (`monitor.ts`, pure).** The session checks the engine every `checkInterval`
  simulated minutes (1, 2, 5 or 10; default 5), or sooner after an urgent alert. It compares the
  state against a baseline taken right after the last decision. It wakes the agent only for:
  urgent alerts, `wave_released` and `zone_cleared` alerts; a zone with no order whose order slack
  falls into a worse band (`soon` ≤ 30 min, `urgent` ≤ 10, `late` ≤ 0); a zone newly forecast to
  be reached within the 60-minute lookahead; fire growth of at least 25 % and 5 ha; or 30 minutes
  without a decision. Quiet checks are logged and cost nothing. The reasons go to the agent as
  `observation.monitor.woke_because`.
- **Order slack (engine).** `orderSlackMinutes` = minutes until the fire first reaches the zone,
  minus the larger of the departure spread and the time its remaining vehicles need to enter the
  route at the bottleneck. It is a simulator estimate and ignores road sharing. The agent never
  computes it.
- **Staged waves.** A new order, `stage_evacuation(zone_id, exit_id, after_zone_id)`, holds a zone
  with no order behind a zone that is already ordered or staged. Loops are rejected. The engine
  releases it once every household of the predecessor has left home and the loading queue, or as
  soon as its own slack falls to `STAGE_RELEASE_SLACK_MINUTES` (5). That backstop raises an urgent
  `wave_released` alert, so a slow wave never strands the zone behind it. If the staged exit is
  unreachable at release, the fastest reachable exit is used. `order_evacuation` on a staged zone
  releases it immediately. Waves are numbered: a zone ordered directly is wave 1; a staged zone is
  its predecessor's wave + 1.
- **Resident notices (simulated).** Every order, staging, release, redirect and blocked route adds
  a `ResidentNotice` to the engine: the zone, the households it addresses, and the message they
  would get ("Get ready, stay home: wave 2 after …", "Your turn: leave now via …"). They appear in
  the console's Residents tab, labelled as simulated. Nothing is sent. The resident app's live
  drill feed (ADR 0016) shows staged zones a "stay home, later wave" message.

## Contract changes

`contracts.ts` and `app/backend/api/dispatch.py` change together:

- Zones gain `order_slack_min`, `wave`, `staged_after` and `staged_exit`.
- `clock.next_regular_decision_minute` becomes `clock.next_check_minute`.
- A new `monitor` block: `check_interval_minutes`, `previous_decision_minute`, `woke_because`.
- `WireOrder` adds `stage_evacuation`. The tool schema adds a nullable `after_zone_id` (required,
  strict).
- The server rejects unknown or self `after_zone_id` values and checks `exit_id` against the
  zone's `exit_options`. It allows one zone order per zone per decision.

## Consequences

- Model calls scale with change instead of time, so a long shift mostly costs quiet checks.
- Wave release timing comes from the simulator, not the model, which keeps AGENTS.md's rule that
  computed values come from numerical models.
- Order slack is deliberately simple: it ignores shared roads and downstream congestion. The
  deadline backstop makes that safe in the simulation, not accurate.
- On `/dispatch` the studio's own evacuation-and-closures panel ([0018](0018-road-closures.md))
  is hidden, because the dispatcher owns the 3D overlay there; closures are not yet fed to the
  dispatch engine, although it already supports closed edges.
- Still a planning experiment. There is no real alerting channel, and adding one is out of scope.

## Revisit

- If the monitor needs state that outlives the browser tab (a real 24/7 shift), move the loop
  server-side, for example by running the session in the Python agent package from ADR 0008.
- If we start using real feeds that can diverge from the forecast (FIRMS detections,
  observed perimeters), the "fire grew" check should compare observed against forecast instead of
  frame against frame.
