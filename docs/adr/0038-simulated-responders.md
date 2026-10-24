# 0038: Simulated responder units for the live drill

Date: 2026-10-24. Status: accepted.

Implements the "responders" generator of [0030-scenario-engine](0030-scenario-engine.md).
Builds on `livecore/inbound.py` and [live-reports.md](../live-reports.md) "Tasks (v2 additions)".

## Context

The drill needs responders that act without a person holding a phone: they take tasks,
drive the real inbound routes and close tasks with something found on the road, so the
console queue, task routes and report loop can be exercised alone or next to real phones.

## Decision

- `app/backend/livecore/responders_sim.py` is pure and seeded: no clock, network or
  database. `Fleet(drill, n, seed, stations, tempo)` has one method that matters,
  `tick(at, tasks, world) -> calls`. `at` is drill time. Units, speeds and on-scene times
  are **assumptions** (table below), and everything they do is `simulated`.
- A unit is idle, enroute or on scene. An idle unit takes the nearest suitable open task by
  straight-line distance (the console's "Send nearest" rule) and accepts it, then follows an
  `inbound_route` edge by edge at `speed_kph x type factor / congestion factor`.
- Closed roads. A unit never enters an edge whose segment is known blocked, discovered
  blocked, truly blocked or inside the fire estimate. `World.known_blocked` is what the system
  knows (units route around it and re-route when a block appears ahead); `World.truth_blocked`
  is ground truth, found only on reaching the edge: the unit stops, remembers the segment and
  re-routes. With no route it waits, and after 600 s cancels the task with a note.
- On scene, after the on-scene time: a **verify** task is answered with a report carrying
  `task_id` whose kind is `road_blocked` (severity `full`) if the target segment is truly
  blocked, known blocked or inside the fire, else `road_passable`. An **assist** task is
  closed with `done`. The report note says it is a simulated responder.
- Output is a list of API call dicts `{at, unit, op, method, path, body}` with `op` in
  `join, location, accept, report, done, cancel`. The driver adds the invite code to `join`,
  `observed_at` to a report, and uses each unit's token. `location` goes out every 15 s
  while driving and every 60 s while parked.
- Driver: `manage.py live_sim_responders --units N --speed-up K --base URL [--invite --interval
  --duration --seed]`. It joins with `simulated: true`, then each tick reads the drill clock
  (`situation`), each unit's `me/tasks` and `road-state`, steps the fleet and POSTs the calls.
  `--speed-up` is `tempo`: units drive and work K times faster than the table (a demo
  knob, default 1). On exit it deletes the units' locations.
- Backend: `join` takes an optional boolean `simulated`; the device stores it, the join
  response echoes it, and `command.responders[]` has `simulated`. The console shows "(sim)"
  next to a simulated responder (map popup, nearest-responder button).

### Assumptions (not measured)

| Type | Speed vs limit | Takes | On scene (verify / assist) |
| --- | --- | --- | --- |
| engine | 0.85x | verify, assist | 240 s / 600 s |
| patrol | 1.15x | verify, assist | 120 s / 300 s |
| ambulance | 1.05x | assist | n/a / 480 s |

Unit `i` has type engine, patrol, ambulance in rotation. On-scene time varies by +-20%
per (unit, task), seeded. Give-up wait 600 s. Stations: the drill's shelter destinations
if any, else four approximate points around Chico (`DEFAULT_STATIONS`, not surveyed; the
Camp bundle has no stations and only exits and temporary refuges, which are not stations).
Each home snaps to the nearest routable road node.

## Consequences

- Same inputs and seed give the same calls (tested). Tests use a small synthetic grid.
- The driver's `known_blocked` is the road-state `blocked` set and its `truth_blocked` is the
  same set, so against the live API a verify answer matches what the system already shows
  (plus the fire). A hidden-closure inject (truth the system does not know) is supported by
  `World` but not wired to a flag yet. The driver passes no congestion (the twin is not
  readable over HTTP by a responder token), so travel is free-flow x type factor; the
  engine supports congestion.
- Units stay where they finish (no return to station). A cancelled task is closed for
  everyone; a real dispatcher would reissue it.
- The fire used by the driver is the bundle estimate at the drill time, without confirmed
  field fire points.
