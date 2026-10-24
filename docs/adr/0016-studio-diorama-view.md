# 0016: 3D diorama view in Simulation Studio

Date: 2026-10-24. Status: accepted for the demo.

Simulation Studio (`/simulation`) gets a **Map / 3D diorama** toggle at the bottom of the
stage. The 3D view reuses the fire page's three.js renderer (ADR 0011,
`app/src/fire/diorama/`). The model, its inputs and the 2D map do not change. The choice
is remembered per browser (`localStorage`, `crisistwin.studio.view`).

## What is drawn, and from what

- Board: the `LandscapeGrid` of the latest result. `StudioRunResult.landscape` (new,
  additive) holds the same grid object as the landscape cache, not a copy. Before the
  first run there is no board: the view says so and offers **Load demo** and **Place
  fires on map** (no fires yet) or **Run simulation**. Choosing **+ Add** or **Move**
  without a board switches to the map, since there is nothing in 3D to click.
- Fire: `ScheduledFireRun.arrivalMinutes` (new, additive), the combined arrival field in
  elapsed minutes from scenario T+0, with the same layout and `Infinity` convention as
  `FireRun.arrivalMinutes`. The page passes it to the scene as a `DioramaRun` (horizon
  from the run's scenario, step `DISPLAY_STEP_MINUTES`) and animates the playback clock
  continuously, as on `/fire`.
- Pins: one labelled pin per *enabled* ignition of the current scenario
  (`FireDioramaSceneApi.setIgnitions`). `setIgnition` (single pin, no label) stays for
  `/fire`. The wind glyph sits beside the first pin.
- Overlays: the same warnings and planning disclaimer as the map, and the LANDFIRE and
  terrain credits.

When the scenario has been edited since the run, the board and fire are the previous
run's, and the pins already show the edits. The stale warning says so, as on the map.

In **+ Add** and **Move** modes, clicking the board places or moves a fire, but only
inside the loaded board. A fire placed outside it is placed on the map instead.

## Panel

The scenario panel (shared with `/dispatch`) is narrower (300 px). Each fire is one row:
enabled checkbox, name, start minute, delete. Coordinates show only for the selected fire.
Moisture and horizon share a row. Run, cancel and status sit in a footer that stays
visible while the body scrolls. Demo, export, clear and import are grouped under
**Scenario file**. Props and behaviour are unchanged.
