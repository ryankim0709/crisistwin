# 0017: Dispatch agent anywhere, on the 3D diorama, with households

Date: 2026-10-24. Status: accepted for the demo. Amends [0014](0014-dispatch-agent.md).

> **Update (2026-10-24):** the `/dispatch` page now renders the Simulation Studio UI
> (`SimulationStudioPage` with its own draft namespace) instead of the single-fire `/fire`-style
> page described below. The agent modules in `app/src/dispatch/` are kept but not wired into
> the page while the dispatcher is reattached on top of the studio run.
>
> **Update (2026-10-24, later):** the dispatcher is reattached on top of the studio run, with a
> live monitor, staged evacuation waves and simulated resident notices. See
> [0018](0018-live-dispatch-monitor.md).

## Context

The first `/dispatch` page worked only for the Oakland/Berkeley hills: one road fixture built
offline from OpenStreetMap, synthetic grid zones drawn as outlines on a 2D map, and Studio
fires that had to be placed inside it. Judges should be able to pick any area the fire model
supports, watch the dispatch in the fire diorama, and see each household's evacuation.

## Decision

- **Page.** `/dispatch` now uses the `/fire` page's landscape loading (stored California
  regions or any custom US area), one click-placed ignition, and the same Rothermel solver
  (`simulateFireSpread`, spotting and structure spread on). Run length is 2, 3 or 4 hours.
  The 3D diorama (`FireDioramaScene`, ADR 0011) is the only view; the 2D zone outlines and
  exit/station tags are gone.
- **Road network at runtime.** `GET /api/dispatch/area?bbox=w,s,e,n`
  (`app/backend/api/dispatch_area.py`) queries the OpenStreetMap Overpass API (three public
  mirrors in turn), builds the graph with the former offline tool's rules and constants, and
  caches the gzip JSON in process (8 entries) and in MongoDB (`dispatch_areas`, optional: the
  endpoint works without it). Boxes are snapped outward to 0.01° for caching; at most about
  0.22° × 0.28°. Errors: 400 `bad_bbox`, 422 `no_roads` / `no_exits`, 502
  `upstream_unavailable`. Throttled at 20 requests per minute per anonymous client. The
  static fixture and `tools/build_dispatch_area.py` are removed.
- **Which box.** The page asks for the cells the fire reaches by the horizon plus 2.5 km,
  half-width clamped to 3–6 km and clipped to the board (`dispatchBoxFor`, `area.ts`). It is
  requested automatically 0.5 s after the fire changes.
- **Households.** Schema 2 adds `homes`: synthetic homes every ~40 m along both sides of
  residential streets (50 homes per km, as before, capped at 20,000 per box), 16 m off the
  centreline, grouped by zone in a fixed pseudo-random departure order. Zones are 1 km grid
  cells (grown in 200 m steps to keep at most 60); small cells merge into the nearest zone.
  Each home is one household with its zone's average vehicles (1.6 per home).
- **Engine (`engine.ts`).** Moves households, not fractional vehicles: ordered homes leave
  one at a time over the departure spread, queue at the zone's loading node, are released
  in whole households at the route's bottleneck capacity, and end safe or caught. A
  household is caught when the fire reaches its home before it leaves (new), when the fire
  reaches the zone core while it is still in the zone, or when the fire reaches the road it
  is on. Zones record the order rank in which they were told to leave and when they cleared.
  Stations outside the box get a straight-line approach delay at an assumed 40 km/h.
- **Fire exposure (`fireExposure.ts`).** Read from the run's per-cell arrival field
  (`FireRun.arrivalMinutes`) at the landscape cell of each point, instead of frame
  perimeters, so arrival is no longer quantised to 5-minute frames. Edges use every vertex.
- **Observation contract.** Zone counts are households (`homes_total`, `homes_waiting`,
  `homes_en_route`, `homes_out`, `homes_exposed`) plus `vehicles_waiting` and `order_rank`;
  units carry `eta_min`; totals are households; `fire.no_action_homes_exposed` is the
  baseline. Orders and validation are unchanged.
- **3D overlay (`scene/DispatchOverlay.ts`).** Added to the diorama through a new additive
  `BoardOverlay` hook (`setOverlay`, `setCoverHouses`, `focusOn` on the scene API). The
  stylized fuel-class houses are hidden once modelled homes load. Each home's roof shows its
  household state; active routes are draped on the terrain in their exit's colour with a
  moving flow; vehicle groups, engines (with their remaining path), exits in use and
  stations are drawn. Vehicles and engines glide between simulated minutes for display only.
- **Console (`DispatchConsole.tsx`).** Setup checklist, household totals against the
  no-action baseline, the latest orders, and tabs for the evacuation board (zones in order
  of their evacuation order, route, progress and a check when clear), fire crews and the
  agent log. Clicking a zone or a home on the board selects and frames that zone.

## Consequences and limitations

- The first visit to a new box needs Overpass (typically 5–30 s; it can be busy or down).
  Cached boxes load instantly. Run the demo once before presenting to warm the cache.
- Homes are not buildings or Census counts; their spacing is a planning placeholder, and
  areas with sparse residential tagging in OSM get few homes.
- Everything else in ADR 0014 holds: the fire does not respond to orders, congestion past
  the loading node is not modelled, the agent sees the model's future fire up to 60 minutes
  ahead, and results are planning experiments, not operational guidance.
