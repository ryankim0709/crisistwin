# 0011: Simulation Studio and scheduled ignitions

Date: 2026-10-23. Status: accepted.

Builds on [0004](0004-physics-fire-model.md), [0007](0007-wui-spread-mechanisms.md) and
[0008](0008-crown-fire.md). The `/fire` page and `simulateFireSpread` keep their behaviour.

## Decision

Add a separate page, `/simulation` ("Simulation Studio"), where a user places up to five
fires, schedules each one's start in elapsed simulation minutes, sets constant wind and
moisture, runs the model once, and plays the result on one shared timeline.

Several fires are one run of the solver on one landscape grid, not several single-fire runs
whose polygons are overlaid. Overlap, double counting and "a fire reached another fire's
start point first" only come out right if the fires share one arrival-time field.

## Contracts

- Scenario: `StudioScenario` / `ScheduledIgnition` in `app/src/studio/contracts.ts`,
  `schemaVersion: 1`. Settings are `Omit<FireScenario, "origin">` (`FireSettings`), so wind,
  moisture, spotting and structure options mean exactly what they mean on `/fire`.
- Solver: `simulateScheduledFireSpread(landscape, ScheduledFireInput): ScheduledFireRun` in
  `app/src/fire/spread.ts`, types in `app/src/fire/scheduledTypes.ts`. Bad ignition points
  throw `InvalidIgnitionsError`, listing every bad source. `simulateFireSpread` is a wrapper
  that passes one source at minute 0.
- First-release limits: constant wind and moisture for the whole run; integer start minutes,
  `0 <= startMinute < horizonMinutes`; 1 to `MAX_ENABLED_IGNITIONS` (5) enabled ignitions;
  horizons of 1, 2, 3 or 6 hours.

Example scenario:

```json
{
  "schemaVersion": 1,
  "id": "demo",
  "name": "Three fires",
  "ignitions": [
    { "id": "f1", "name": "F1", "location": { "latitude": 37.885, "longitude": -122.235 }, "startMinute": 0, "enabled": true },
    { "id": "f2", "name": "F2", "location": { "latitude": 37.875, "longitude": -122.22 }, "startMinute": 20, "enabled": true }
  ],
  "settings": { "windSpeedMph": 20, "windFromDegrees": 45, "moisture": { "dead1h": 0.03, "dead10h": 0.04, "dead100h": 0.05, "liveHerb": 0.3, "liveWoody": 0.6 }, "midflameAdjustment": 0.5, "stepMinutes": 5, "horizonMinutes": 180 }
}
```

## Solver semantics

One solver core (`solveSpread` in `spread.ts`) serves both entry points. It runs the
precompute and the minimum-travel-time relaxation of [0004](0004-physics-fire-model.md)
and [0007](0007-wui-spread-mechanisms.md) unchanged; only the seeding and the bookkeeping
are new. `/fire` output is unchanged, so `SPREAD_MODEL.version` stays 4.0.0.

- **Path-dependent crown state (amended after merging crown carry, 1c1e2a9).** At first
  every input to the relaxation was fixed per cell in the precompute, so keeping only the
  earliest arrival per cell was exact. Since [0008](0008-crown-fire.md) let an established
  crown fire carry through continuous canopy, one part is path-dependent. A cell whose
  canopy can sustain an active crown fire runs as active only if the fire that reaches it
  first comes from an actively crowning cell (`arrivedFromActiveCrown`), and that choice
  is made once, when the cell settles. The scheduled solver uses the single-origin rule
  unchanged: a cell takes the crown state of its earliest arrival.
  - A scheduled ignition starts as a surface fire: its seed clears the flag.
  - A fire that reaches another fire's start cell first brings its own crown state with
    it.
  - An ember landing clears the flag, as on `/fire`.

  The consequence is a stated approximation, not an exact result. A slightly later
  arrival from an actively crowning fire could have carried the cell on faster than the
  earlier surface arrival that won, so the combined field is no longer guaranteed to be
  the cell-by-cell minimum of each fire run alone. It can differ wherever two fires meet
  in canopy that sustains crowning. The same approximation already applies inside a
  single `/fire` run, where two paths of one fire compete for a cell. Everything else
  that the relaxation reads is still fixed per cell: rate, heading, eccentricity, backing
  floor, ember reach, and the spotting rules.
- **Seeding.** Each source's cell is seeded at its `startMinute`, in input order, before
  relaxation. Fire cannot leave a source earlier than that. Without crown carry, the
  combined field is exactly the cell-by-cell minimum of what each source would produce
  alone, offset by its start time (up to the horizon cut-off). With crown carry this
  holds except where fires compete for canopy that can sustain crowning (see above).
- **Reached before start.** If another fire reaches a source cell strictly before its
  start, that arrival stands and the source's seed is discarded when it comes off the
  heap: no reset, no reburn. The outcome is `reached-before-start`, with that arrival
  time and the source whose fire set it. An arrival exactly at the start minute leaves
  the cell with the scheduled source (`ignited`), because relaxation only replaces an
  arrival that is strictly earlier.
- **Overlap and attribution.** There is one arrival field, so each cell is counted once.
  The index of the source that set a cell's arrival is copied along every step and every
  ember jump. A cell's attribution is final once it settles. Per-source cell counts
  therefore sum exactly to the footprint, and the areas sum to it up to floating-point
  rounding.
- **Where fires meet.** Fronts stop where they meet: each cell keeps the earlier arrival,
  and no cell burns sooner than one of the fires would have burned it alone. No
  fire-atmosphere coupling, indraft, merging acceleration or junction-zone effect is
  modelled.
- **Ties and determinism.** Equal arrivals keep whichever was set first, so the order
  depends on the input source order and the heap's insertion order. There is no
  randomness, so identical input on the identical landscape gives an identical run.
- **Frames and totals.** Frames are exactly `frameMinutes`. Each one counts and contours
  cells with arrival <= its minute. They are built in a single arrival-ordered pass over
  the settled cells, and only the bounding box of reached cells is contoured, which gives
  the same rings as a full-grid scan. `reachedEdgeMinute` is the arrival time of the
  first settled edge cell. Run-level breakdowns are horizon totals over the combined
  footprint. Unlike `/fire`, the T+0 frame is contoured too, so a source starting at
  minute 0 shows its single cell.
- **What would make it worse.** Any further state carried along the arrival path or tied
  to arrival time widens that approximation. Examples are time-varying wind or moisture,
  crown fire that needs a run-up distance, spotting from a burning cell over a period of
  time, or fire-atmosphere coupling. An exact treatment needs a solver whose state
  includes them, for example one label per cell and per crown state.

## Shared landscape

One landscape per run (`loadLandscapeForBox`), covering every enabled ignition plus a
horizon-dependent spread buffer (40 m/min times the horizon, clamped to 3-12 km, shrunk
toward 3 km when needed), capped at `MAX_LANDSCAPE_SPAN_METERS` per side. Ground distances
are converted to Mercator metres with cos(latitude) at the box centre. Points further apart are refused
before any download, with a message asking the user to move them closer. The box is snapped
outward to a 1 km Mercator grid so small edits reuse the cached grid, and changing wind, moisture or start times
never refetches. A run that reaches the grid edge is reported as clipped from the minute it
happened; it is never shown as a complete footprint.

## Computation and playback

The solve runs in a Web Worker. The page keeps the last two landscapes and reuses one whose box contains the new box. Each
run captures a frozen scenario snapshot and a request
id; downloads for an obsolete request are aborted, an obsolete solve is cancelled by
terminating the worker, and any response whose id is not the latest is dropped.

The worker returns frames at T+0, every ignition minute, every 5 minutes, and the horizon.
Playback only moves a simulation clock across those frames; speed changes how fast it is
watched, not how fast fire spreads. No shape is interpolated between frames.

Editing anything that changes the model input pauses playback and marks the result stale;
the stale footprint is shown dimmed as "Previous run" and a new solve starts only on
**Run simulation**. Selecting, panning, zooming and playback speed do not invalidate a run.

The draft is saved to `localStorage` and labelled "Saved on this device". JSON export/import
is validated on import. A scenario file alone does not guarantee identical results later:
LANDFIRE and terrain sources can change, and exact replay needs the same landscape.

## Not in this release

Time-varying wind (it needs the solver to propagate under the conditions in force at each
moment, not a wind arrow that changes during playback), calendar dates, weather schedules,
suppression, and evacuation traffic.
