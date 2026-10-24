# 0023: Firefighters drive in from fire stations

Date: 2026-10-24. Status: accepted for the demo. Amends
[0020-studio-firefighting](0020-studio-firefighting.md). Superseded in part by
[0048-suppression-engine](0048-suppression-engine.md) (bases, road access, speeds).

## Context

Firefighting in the Studio assumed every resource was on site a fixed time after the first
ignition (30 minutes by default), and nothing on the board showed them arriving. The board
already loads OpenStreetMap roads and fire stations with a router (`/api/dispatch/area`,
`dispatch/routing.ts`), so arrival can come from road travel instead of a guess.

## Decision

- **Dispatch** (`app/src/studio/crewDispatch.ts`). The fire is reported when the first enabled
  fire ignites (T+0 for the usual single fire). Each resource leaves an OSM fire station after
  an 80 s turnout (NFPA 1710), drives the board's road graph at free-flow speed (avoiding the
  Studio's closed roads, covering a station's off-graph approach at 40 km/h) to the road node
  nearest the fire, then walks to the ignition point at an assumed 50 m/min (about 3 km/h). The
  twelve nearest stations by straight line are routed; engines take the nearest stations first,
  then hand crews, then dozers, one resource per station in turn.
- **Model input.** Each resource starts work at its own arrival minute: the line planner gives
  every crew its own clock, and the direct-attack estimate sums line built per resource from
  its arrival. "Crews start work" offers "When they drive in from the nearest fire stations"
  (the default) or the fixed delays as before. Without roads, stations, a reachable station or
  a road within 1.5 km of the fire, the run falls back to the fixed delay and says why.
- **Display.** In 3D, engines (long red), hand-crew buggies (tall green) and dozers (low wide
  yellow) drive their routes on the playback clock, with each route drawn while someone is on
  it, park around the road point, and a label at the fire counts resources at the fire and
  walking in. The 2D map shows routes and moving dots. The results panel lists each resource's
  station, drive and arrival.

## Consequences

- With the demo fires, nine resources come from nine East Bay stations; F1 is 0.7 km from the
  nearest road, so crews reach it from T+0:17 to T+0:27 rather than T+0:30, and the
  direct-attack estimate puts it out at T+0:29.
- All resource types are taken to be housed at OSM fire stations; in reality hand crews and
  dozers usually come from farther away (crew bases, contractors), so their arrivals are
  optimistic. Stations' real apparatus, staffing and availability are unknown. Free-flow speed
  ignores emergency driving and traffic, including evacuation traffic.
- Dispatch is computed when Run is pressed; changing road closures afterwards does not re-route
  crews until the next run.
