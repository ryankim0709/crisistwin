# Command demo: realism

Date: 2026-10-24. Extends the `/demo` board of `docs/adr/0047-command-demo.md` (the ADR is not
changed). The board keeps its 24/7 clock, its speeds (1× to 120×) and its Claude commander;
the fire, units, travel and households are now driven by sourced models and data. Every input
the board uses is listed under "Model inputs" on the page and in `observation.inputs` for the
commander, with its evidence class.

Code: `app/src/demo/realism.ts` (physics and data), `app/src/demo/model.ts` (board),
`app/src/demo/useDemoEnvironment.ts`, `app/src/demo/useCrewRoutes.ts`,
`app/backend/api/demo_realism.py`. Contract: `app/src/demo/contracts.ts`.

## Realism

| Element | Before | Now | Evidence |
| --- | --- | --- | --- |
| Fire spread | Constant head rate 8-32 m/min drawn at random per fire; fixed L:B 2.5; wind fixed from 45° | Rothermel (1972) head rate from fuel, slope and wind at the fire's head (`fire/rothermel.ts`, reused); midflame wind by the Albini & Baughman unsheltered factor (`fire/crownFire.ts`); L:B from effective wind, Anderson (1983) capped at 8; backing rate by Alexander (1985), floored at the no-wind rate (BehavePlus) | Model |
| Fuel | none | LANDFIRE FBFM40 from a prebuilt landscape when one covers the drill area (`GET /api/landscapes`). None does today, so: **ASSUMPTION** SH5 (FBFM40 145) everywhere, the fuel `sim/fire.py` uses for the Camp replay | Assumption (labelled) |
| Moisture | none | Scott & Burgan (2005) Table 1 scenarios (`fire/spread.ts` presets): Quiet = moderate, Active = dry, Severe = critical. The mapping is an **ASSUMPTION** | Sourced values, assumed mapping |
| Terrain | none | USGS 3DEP 1 arc-second, block mean onto 200 m cells, Horn slope (`sim/terrain.py`, the Camp package's `normalized/terrain_grid.json`). Missing package: flat ground, labelled | Observed |
| Wind | none | Hourly series from `sim/weather.py` via `GET /api/demo/wind`, changing every simulated hour and looping. Three choices: 1-8 Nov 2018 observed (default), Camp Fire day observed, November 95th-percentile offshore episode (derived). Jarbo Gap RAWS (JBGC1, 10 km) for the observed modes; Chico ASOS for the derived one. Endpoint down: **ASSUMPTION** constant 5.9 m/s from 45° | Observed / derived |
| Fire shape | Analytic ellipse | One ellipse whose head, back and flank grow by the current rates; its axis is the spread-weighted mean heading. A lumped stand-in for FARSITE's per-vertex wavelets | Model (simplified) |
| Units | 6 synthetic strike teams of 5 engines at 5× the Studio engine rate (about 50 m/min each) | 6 Type 3 engines, 3 Type 1 engines, 2 Type 1 hand crews, 1 Type 2 dozer (**ASSUMPTION** roster). Line from the sourced tables for the fuel and slope: about 2.7, 5.0, 2.2 and 10.7 m/min in SH5 (`studio/apparatus.ts`: PMS 465 p.164, Broyles 2011, PMS 465 p.140). Turnout 1.3 min (engines), mobilisation 30 min (crews) and 60 min (dozers) | Sourced rates; assumed counts |
| Holding | Any line held | Contained only when line reaches the perimeter and the head flame is within the unit's limit (Hauling chart, PMS 465 p.12: 4 ft hand tools, 8 ft engines and dozers) | Sourced |
| Bases | 3 synthetic stations | Real CAL FIRE facilities from `GET /api/suppression/bases`: Type 3 engines and the dozer at the nearest CAL FIRE state stations (Paradise, Jarbo Gap, Stirling City, Forest Ranch, Cohasset, Harts Mill), Type 1 engines at the nearest Schedule A stations (Paradise FD 81 and 82, Upper Ridge), crews from Table Mountain Fire Center. Without the local-only bases file: synthetic stations, labelled | Observed locations |
| Travel | Straight line × 1.3 at 50 km/h | `POST /api/demo/crew_routes`: `livecore.inbound.inbound_route` over the drill roads, per apparatus class (`tools.suppression_data.road_access`, rules R01-R12), avoiding fire. A base off the network gets a straight-line × 1.3 leg at the heavy-apparatus secondary-road cap to the nearest road node. Until a road time arrives: **ASSUMPTION** straight line × 1.3 at 60 km/h, labelled per unit | Model |
| Departure | Uniform over 45 min after an order, everyone leaves | Exponential delay, mean 93 min (Camp awareness-to-departure, Grajdura 2022; the exponential shape is an **ASSUMPTION**). 92% of households with a vehicle leave on an order (**ASSUMPTION** inside the sourced 0.87-0.97) | Sourced mean and range |
| Shadow evacuation | none | With no order, 30% of households with a vehicle leave once fire touches the zone (**ASSUMPTION** inside the sourced 0.29-0.75), on the zone's best route | Sourced range |
| No vehicle | none | ACS carless households per zone (the replay bundle's demand table, 1,172 over 43 zones). They stay home and are shown as "No vehicle, at risk" when a fire touches or is forecast to reach their zone | Observed (ACS) |
| Congestion | not modelled | **Not modelled**, labelled. The demo's households are not in the traffic twin, so twin congestion would describe a different world | Gap |

## Endpoints

All anonymous local-demo endpoints, 60 requests per minute per client, `Cache-Control` set,
errors `{"error", "detail"}`. Each takes an optional `?incident=<id>`: absent is Camp
(`camp-2018-drill`); Camp or the active incident (the live API's rule, a Studio drill package
anywhere in California) are served, anything else is 404 `not_found`. The board follows the
active incident, not only the Camp map.

- `GET /api/demo/wind?mode=historical_replay|climatology_percentile&start=<ISO>&hours=<1-168>`:
  `sim.weather.scenario_wind`, cached per process and point. The station search starts at Paradise (-121.60, 39.76) for Camp, else at the mean of the incident's zone centroids. 503
  `weather_unavailable` when no series loads (the IEM archive cache is cold and offline).
- `GET /api/demo/environment`: `{terrain, terrain_detail, households_no_vehicle,
  households_no_vehicle_source, center}`; `center` is `[lon, lat]` (the wind point). For a
  non-Camp incident `terrain` is null (Camp-only package; the page uses the region's LANDFIRE
  landscape) and carless households are `{}`, labelled unknown (counted as 0). `stations`
  (`[{id, name, lon, lat}]`) and `stations_source` carry the drill package's OpenStreetMap fire
  stations (observed; Camp: `[]` and null). The board uses them only when the CAL FIRE bases
  file is unavailable: the nearest stations fill all three base pools and the two nearest double as
  crew camps; unit types and counts per station stay assumed, and `basesLabel` says so. Terrain needs the Camp incident package locally
  (`DEMO_TERRAIN_PACKAGE`, default `data/incidents/camp-2018-evacuation/17e67cfe5669fe50`);
  slope is sent as rise/run × 1000 integers, aspect as whole degrees.
- `POST /api/demo/crew_routes`, body `{fires: rings, requests: [{id, access_class, from, to}]}`
  (at most 40): per request `drive_min` (no turnout), `distance_m`, `basis` (`road`,
  `road_offboard`), `offboard_m`, `reason` when there is no route, and the line.

## Measured

- Rothermel at SH5, flat, dry moisture: 4.2 m/min at 2 m/s open wind, 14.4 m/min at 5.9 m/s,
  40.6 m/min at 14.3 m/s; head flame 4.9, 8.6 and 13.9 ft. Engines hold the head only below
  about 5 m/s of wind in dry fuel.
- Crew routes, Paradise FS to central Paradise: 7.0 min by road (5.75 km) against 6.1 min by
  the old straight-line rule; Table Mountain Fire Center: 65.7 min (3.9 km off-board, then
  40 km of road).
- 24 simulated hours on the 43 drill zones with a greedy commander (3 nearest units to every
  new fire, no evacuation orders): with 1-8 Nov wind, 4 to 7 of about 30 fires contained; with
  the Camp-day or P95 wind, none. Each 24 h board ran in under 1.1 s of CPU.

## What is still not realistic

- One ellipse per fire with rates sampled at its head: no per-vertex fuel or slope, a wind
  shift turns the ellipse rather than growing a new head, and overlapping fires are summed in
  the burned total.
- Forecasts (zone ETAs, containment estimates) assume the current rates persist.
- Surface fire only: no crown fire (no canopy rasters for the area), and spotting is the
  board's earlier random rule gated by the spotting intensity threshold.
- Road grade, dead ends (R10) and lane counts are not applied to apparatus routing; on the
  drill's paved roads every class gets the same heavy-apparatus speeds.
- No aircraft, no water supply, no fatigue or shift changes; unit counts per base are assumed.
- Under observed November winds, fires routinely escape initial attack and the board fills to
  its 25-fire cap. That is the model's answer, not a defect to tune away; a labelled
  escaped-fire handoff rule would be the next step for long 24/7 runs.
- Congestion is not modelled. Carless households have no pickup model.
- `fire/rothermel.ts` and `sim/fire.py` disagree on SH5 at the replay's inputs (85 against
  173 m/min head, reaction intensity 3,030 against 6,144 Btu/ft²/min): the TypeScript code
  weights each category's reaction term by its surface-area share, the Python code does not.
  The two agree for dead-only fuels; which matches Andrews (2018) for live-fuel models needs
  checking. The board uses the TypeScript model.
