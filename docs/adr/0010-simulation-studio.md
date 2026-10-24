# 0010: Simulation Studio and scheduled ignitions

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

_Owned by the model change; filled in with it._

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
