# 0030: Close roads during a dispatcher run

Date: 2026-10-24. Status: accepted for the demo. Amends
[0018-road-closures](0018-road-closures.md) and [0019-live-dispatch-monitor](0019-live-dispatch-monitor.md).

## Context

On `/dispatch` the engine already avoided closed edges, but closures were fixed for the whole run
and the page offered no way to make one: 0019 noted that "closures are not yet fed to the dispatch
engine". For the demo a planner should be able to click a road closed (a crash, a downed line, a
bridge out) while the agent runs, and watch traffic and the agent respond. Roads the fire reaches
were already avoided (`blockedAt`: edges the fire model reaches within `ROUTE_LOOKAHEAD_MINUTES`),
but the agent was never told which roads were cut.

## Decision

- **Engine.** `DispatchEngine.setRoadClosed(edge, closed)` closes or reopens an edge at the current
  minute. The closed set is replaced, never mutated, and `roadClosures` records each closure's
  minute. Ordered zones re-plan at once; vehicles on the road and engines re-route on the next step,
  exactly as around fire. A zone left with no exit holds departures and raises `route_blocked`. An
  urgent `road_closed` / `road_reopened` alert names the road and the zones that were routed over it.
- **Monitor.** The baseline keeps the closed set the agent saw; `detectChanges` reports each road
  closed or reopened since then from that diff (the road alerts are left out of the alert reasons so
  nothing is doubled). A closure made while the agent is thinking, even in the same minute, still
  wakes it after its answer lands. `useDispatchSession.setRoadClosed` also asks for an immediate
  check, bypassing `MIN_DECISION_GAP_MINUTES`: a planner action deserves a prompt response.
- **Observation.** A new `roads` block: `planner_closed` (road, bridge, `since_minute`),
  `fire_cut_segments` and up to 12 `fire_cut_roads` (named roads the fire reaches within the
  routing lookahead, earliest first). The prompt tells the agent to redirect zones whose route is
  blocked or whose exit dropped out of `exit_options`, and to treat closures as lasting.
- **UI.** The console's Road closures panel turns on a road tool; while it is on, the studio hands
  3D ground clicks to the dispatcher (`StudioAsideContext.groundClickRef`), which closes or reopens
  the nearest edge within 120 m (`nearestEdge`). Closures made before the start hold from T+0. The
  panel lists closures with their minute, tagged "Your assumption", and the roads the fire has cut.

## Consequences

- The disrupt → respond loop is live: a closure shows up on the board, in traffic and in the
  agent's next decision within a few simulated minutes.
- Closures still change traffic, not the fire. A session's closures end with the session; they
  are journalled with its decisions ([0031](0031-dispatch-run-memory.md)) but not saved in the draft.
- Not done: closures in the 2D map view, timed (scheduled) closures, and planner-confirmed
  reported closures (`src/intel/closures.ts`) on `/dispatch`.
