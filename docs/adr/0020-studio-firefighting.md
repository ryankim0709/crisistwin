# 0020: Firefighters and control lines in Simulation Studio

Date: 2026-10-24. Status: accepted for the demo. Amends
[0004-physics-fire-model](0004-physics-fire-model.md) (which had no suppression) and builds on
[0011-simulation-studio](0011-simulation-studio.md).

## Context

The fire model had no suppression, so the Studio could show a fire but not ask whether
firefighters could stop it. A planner should be able to say "these crews respond after
30 minutes" and see where they would best build line and how much that saves, with the fire
model, not an LLM, deciding what happens.

## Decision

**Control lines in the solver** (`ControlLines` in `app/src/fire/spread.ts`). A plan gives
each line cell the minute it is built and the longest flame its builder can hold. In the
minimum-travel-time relaxation, a built line cell:

- blocks every multi-cell stencil step that would land on or cross it;
- may be burned into only from an adjacent cell, and only when the flame facing it in that
  direction is longer than its limit. That flame is the cell's Byram head flame length scaled
  by (directional rate / head rate)^0.46, since fireline intensity is proportional to the rate
  of spread for a given fuel consumption. Crown fire (passive or active) breaches any line;
- does not take ember landings, though embers still fly over it.

Blocking depends only on the departure time and only gets stricter as time passes, so the
solver's arrival order stays valid. Judging breaches on adjacent steps only matters: with the
8-cell stencil, a fire running along a line otherwise cut across it at a shallow angle with
head-fire intensity.

**Planning and search** (`app/src/studio/firefighting.ts`). All resources start work
`responseMinutes` after the first ignition. A candidate line follows the outer ring of the
unchecked fire's footprint at a target minute T (an open ring where the fire runs off the
board), split into two flanks from an anchor: the heel (upwind end) or the head. Resources
alternate between the flanks and leapfrog 300 m chunks within a flank, building at an assumed
rate per resource scaled by fuel family; non-burnable ground is free. The search tries both
anchors at T = start + 15, 30, 60, 90, 120, 180 and 240 minutes (up to the horizon), solves
each, and keeps the plan with the least burned area at the horizon (ties: less developed land
burned, then the shorter line). About ten solves, run in the existing Web Worker with a
progress count; about 1–2 s on the Berkeley board.

**Assumptions (named constants):** production in grass of 400 m/h per hand crew, 600 m/h per
engine and 1,200 m/h per dozer, slower in grass-shrub (×0.7), timber litter (×0.8), timber
understory (×0.5), shrub (×0.4) and slash (×0.3). These are of the order of published fireline
production rates, not values from a production-rate table. Holding limits are the Hauling
chart's: hand crews 4 ft, engines and dozers 8 ft (Andrews & Rothermel 1982).

**UI.** The Studio config panel has a Firefighters section with counts and a response time,
saved with the scenario (optional `firefighting` field; scenario schema stays 1). Results
compare burned and developed area with no crews and with the best plan, give the plan, line
length by outcome (held, burned over, outrun by the fire, not finished) and every plan tried. A
toggle switches the map, 3D view, playback and the evacuation between the fire with and
without firefighters. The line is drawn at the playback minute: in 3D as dark strips (built,
holding) and posts (red burned over, orange outrun); on the map as small and large dots.

## Consequences

- On the demo fires at 20 mph and dry fuel, four hand crews, four engines and a dozer
  responding at T+30 hold the burn to 37 ha at T+3:00 against 578 ha unchecked. Under the
  demo's critical moisture the same resources save about 3%: the head is crown fire and
  breaches any line. Both are model outputs, not validated predictions.
- The crown model is path-dependent: a cell keeps the crown state of the neighbour that
  burned it first. Blocking a surface path can let a crowning neighbour arrive first, so a
  line can make a fire bigger. Some plans burn more than no crews at all; the search never
  picks them and the result panel says why.
- A line can be two cells thick where the ring turns, so "burned over" metres can be
  non-zero while the fire is still held.
- Not modelled: travel on the road network, staggered arrivals, shifts and fatigue, water
  supply, aircraft and retardant, burnout or backfire, mop-up, a held line failing later, and
  retreat for crew safety. The search is a small grid, not an optimum.
