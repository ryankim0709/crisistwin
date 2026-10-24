# 0018: Evacuation and road closures in the Studio 3D view

Date: 2026-10-24. Status: accepted for the demo. Builds on
[0016-studio-diorama-view](0016-studio-diorama-view.md) and
[0017-dispatch-anywhere](0017-dispatch-anywhere.md).

## Context

The scope's core loop is simulate → disrupt → measure ([project scope](../project-scope.md),
P0: "manual bridge/road closures", "closing a road causes the traffic model to change"). The
Studio (`/simulation`, also served at `/dispatch`) modelled only fire; its 3D view drew the
board's OpenStreetMap roads and synthetic homes for show. The dispatch engine
(`app/src/dispatch/engine.ts`) could move households over that road graph but was not wired
into any page.

Closing a road does not change how a fire spreads (fuel, wind and slope do), so closures act on
the evacuation, not on the fire run.

## Decision

- **Closures in the engine.** `DispatchEngine` takes an optional set of closed edge indices,
  closed for the whole run. `blockedAt` treats them like edges the fire is about to reach, so
  orders, re-routing, vehicles already on the road and engines all avoid them.
- **Bridges.** `GET /api/dispatch/area` edge rows carry a trailing bridge flag (OSM `bridge=*`
  other than `no`), parsed as `RoadEdge.bridge`. The wire schema stays 2 (the field is an
  optional trailing element); the builder version is now `dispatch-area/3`, so earlier cache
  entries are rebuilt on first request (needs Overpass once per box). A closed bridge is
  modelled exactly like a closed road and labelled "Bridge out".
- **Policy instead of the agent** (`app/src/studio/evacuation.ts`). At a chosen minute (T+0,
  15, 30 or 60) every zone not yet overrun is ordered to its fastest exit reachable avoiding
  closures and fire; a zone with none is counted as cut off and never ordered; an ordered zone
  whose route the fire cuts is re-ordered to its fastest reachable exit. Deterministic, no LLM.
- **Comparison.** The page runs the policy to the horizon twice, with all roads open and with
  the planner's closures, and shows households that reached an exit, were caught, are still
  evacuating, were cut off, household-hours evacuating and when everyone ordered was out. A full
  3 h run on the Berkeley Hills board (54 zones, ~19,800 homes) takes under 0.1 s in the
  browser, so both runs are recomputed on every change.
- **Drawing.** With the evacuation shown, the 3D view attaches the existing `DispatchOverlay`
  (households coloured by state, routes, vehicles, zone labels) plus closed roads as dark bars
  with a text label. An `EvacuationPlayer` positions the engine at the playback clock, replaying
  from T+0 when playback moves back. The streets layer then draws roads only, since the overlay
  draws the homes.
- **Picking.** With "Close roads or bridges" on, a click on the board toggles the nearest road
  edge within 120 m (`nearestEdge`). Closures belong to one road area and are dropped when the
  board's area changes; they are not saved in the draft and do not mark the fire run stale.

## Consequences

- The Studio demonstrates the disrupt → measure loop on any stored board. Closures are labelled
  as the planner's assumption; counts are labelled simulated, and the panel states that homes
  and zones are synthetic and counts are not casualty estimates.
- The traffic model is still the dispatch engine's: capacity at each zone's loading point,
  free-flow driving after release, no downstream queues. A closure that only lengthens a drive
  by seconds changes little; one that forces zones onto a shared bottleneck, or cuts them off,
  shows up clearly.
- Not done: timed closures (closing a road mid-run), saving closures with the scenario, closures
  in the 2D map view, and optimisation over order timing or exit choice.
