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
| Units | 6 synthetic strike teams of 5 engines at 5× the Studio engine rate (about 50 m/min each) | Departments built from the CAL FIRE facilities layer (agency, unit code, staffing) with **ASSUMED** counts per facility, aircraft at helitack and air attack bases, and a mutual-aid pool of the off-board stations ([response-model.md](response-model.md)). The fixed roster (6 Type 3, 3 Type 1 engines, 2 crews, 1 dozer) remains only as the fallback without layer metadata. Line from the sourced tables for the fuel and slope: about 2.7, 5.0, 2.2 and 10.7 m/min in SH5 (`studio/apparatus.ts`: PMS 465 p.164, Broyles 2011, PMS 465 p.140). Turnout 80 s (paid) or 120 s (other) for engines, mobilisation 30 min (crews) and 60 min (dozers) | Sourced rates; assumed counts |
| Response | The AI commander or a person sent every unit | Rule-based initial attack on every new fire (run card by dispatch level, closest resource), tactic by flame length, seeded line holding, escalation and resource orders, unit states, work/rest, water, move-up and cover, aircraft: [response-model.md](response-model.md) | Sourced structure, assumed counts |
| Holding | Any line held | Contained only when the tactic's line is complete and holds the head flame: direct attack within the unit's limit (Hauling chart, PMS 465 p.12: 4 ft hand tools, 8 ft engines and dozers), parallel or indirect up to 11 ft, none above; the holding test draws the flame with a seeded **ASSUMED** spread ([response-model.md](response-model.md)) | Sourced limits, assumed spread |
| Bases | 3 synthetic stations | Real CAL FIRE facilities from `GET /api/suppression/bases`: Type 3 engines and the dozer at the nearest CAL FIRE state stations (Paradise, Jarbo Gap, Stirling City, Forest Ranch, Cohasset, Harts Mill), Type 1 engines at the nearest Schedule A stations (Paradise FD 81 and 82, Upper Ridge), crews from Table Mountain Fire Center. Without the local-only bases file: synthetic stations, labelled | Observed locations |
| Travel | Straight line × 1.3 at 50 km/h | `POST /api/demo/crew_routes`: `livecore.inbound.reach_route` over the drill roads, per apparatus class (`tools.suppression_data.road_access`, rules R01-R12, on each road's OSM tags and DEM grade: "Road access" below), avoiding fire. A unit no allowed road brings to its fire stops at the nearest point it can reach. A base off the network gets a straight-line × 1.3 leg at the heavy-apparatus secondary-road cap to the nearest road node. Until a road time arrives: **ASSUMPTION** straight line × 1.3 at 60 km/h, labelled per unit | Model |
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
  `road_offboard`), `offboard_m`, `reason` when there is no route, and the line. Road access
  fields (additive; older clients ignore them):
  - `access_status`: `reached` (drives to the road node nearest `to`), `detour` (gets there, but a
    faster road is closed to the class), `stopped_short` (no allowed road gets there), or null
    when there is no route.
  - `stop_point`: `[lon, lat]` where the vehicle must stop, `stopped_short` only. Then
    `drive_min`, `distance_m` and `line` end there, and `reason` is null.
  - `off_road_m_to_target`: straight-line metres from the end of `line` to `to` (the road snap
    distance when `reached`): the walk in or hose lay a consumer may add.
  - `blocked_rule` (`R01`-`R10`) and `blocked_reason` (plain language, e.g. "Paved road too steep
    (19%) for a Type 1 engine on Apple Lane (R05)"): the first road closed to the class on the
    route an unrestricted vehicle would take. Set for `detour`, `stopped_short`, and a no-route
    leg whose better road is closed; else null.
  - `unrestricted_drive_min`: `detour` only, that unrestricted vehicle's drive minutes.
  - Top level `road_access: {status, basis}`: `ready` (OSM tags and grade), `grade_only` (tags
    still loading), `none` (highway class only); `basis` says what was used.

  A stop short is taken only within 3 km of `to` (`livecore.inbound.STOP_SHORT_MAX_M`,
  **ASSUMPTION**); farther, the leg has no route and keeps its `reason` (`no_access`,
  `target_in_fire`, `no_open_road`, `target_off_network`). A target inside the fire also stops
  short, at the nearest reachable road outside it. Consumers (the response model) should read
  `access_status`, `stop_point`, `off_road_m_to_target` and `blocked_reason`; an older server
  omits them, which means `reached`.
- `GET /api/demo/road_access`: `{status, basis, classes: [{access_class, label, open_km,
  closed_km, top_rules: [{rule, km, example}]}], closed_roads: FeatureCollection, evidence_class:
  "derived"}`. `closed_roads` holds each drill segment closed to at least one class, with
  `closed` (class -> rule), `reason` and `grade_pct`. Cached for an hour once `status` is
  `ready`; the /live map draws it ("Roads trucks can't use" layer, and for a selected unit).

## Road access

The drill bundle keeps only `highway`, `lanes`, `bridge` and speed per edge, so without more
the rules R01-R12 ([suppression-data.md](suppression-data.md)) closed nothing on Camp.
`api/drill_road_attrs.py` adds, per drill segment (`livecore/road_attrs.py`):

- **OSM tags** (observed): surface, tracktype, smoothness, width, maxweight, maxheight, bridge,
  access, emergency, motor_vehicle, 4wd_only, fetched from Overpass by the way id in each edge id
  (`osm-way:<id>:...`), with `dispatch_area.overpass` (same mirrors). Today's tags; 308 of the
  5,291 Camp ways no longer exist and take their tags as of 2018-11-08 (attic query). The drill's
  own highway class and speed are kept. `4wd_only` is carried but no rule reads it. Cached in
  MongoDB `dispatch_areas` (`builder: drill-road-tags/1`); the first fetch (about a minute) runs
  in the background, and until then the rules see grade only (`status: grade_only`).
- **Grade** (derived): the steepest 150 m least-squares slope of each segment's elevation
  profile on the Camp package's USGS 3DEP 1 arc-second DEM, sampled every 10 m and
  median-filtered over ±50 m; bridges unknown. **ASSUMPTION**: window and filter are not
  sourced. Coarse 2018 OSM geometry on canyon rims cuts across slopes, so the estimate runs
  high there (a few roads read above 40%). The endpoint difference over 100 m that Studio uses
  (`studio/roadAccess.ts`) gave about 460 km above 16% on Camp; this gives about 340 km.
  Other incidents get no grade (0% assumed, labelled); a Studio drill package built from now on
  keeps its dispatch-area OSM tags per edge (`livecore/package.py`).

Camp drill roads (3,083 km of segments, one direction each), closed per class with tags and
grade (before: 0 km for every class):

| Class | Open km | Closed km | Top rules |
| --- | --- | --- | --- |
| Type 1/2 engine (`engine_t1_t2`) | 2,672 | 411 (13%) | R05 paved grade > 16%: 299; R04 unpaved: 111; R03 smoothness: 2 |
| Type 3 engine (`engine_t3`; hand crew carriers) | 2,957 | 126 (4%) | R05 paved > 25%: 101; R06 unpaved > 20%: 26 |
| Type 4-7 engine (`engine_t4_t7`) | 2,974 | 109 (4%) | R05: 101; R06 unpaved > 25%: 9 |
| Support tender / dozer transport (`tender_support`) | 2,468 | 615 (20%) | R05 paved > 12%: 502; R04: 111; R03: 2 |
| Tactical tender (`tender_tactical`) | 2,746 | 336 (11%) | R05 > 16%: 299; R06 > 15%: 38; R09: 0.2 |

Most closures are short canyon-side roads: from Paradise, Chico, Magalia or Oroville a Type 1
engine still reaches 96% of the main road nodes, a support tender 90%, a Type 3 engine 99%.
The evacuation planner and `POST /api/demo/routes` are unchanged (the rules are for apparatus,
not cars).

## Travel time

Per edge and per apparatus class, `livecore/apparatus_travel.py`, applied in
`livecore.apparatus.access_profile`. Every consumer of a class profile uses it: `POST
/api/demo/crew_routes`, task routes (`api/live/responder_routing.py`) and the simulated responders
(`livecore/responders_sim.py`). Parameters live in `tools/suppression_resources.json`
(`road_access.travel`, and `engine_hp` and `frontal_area_m2` per vehicle class), each with a source
or an ASSUMPTION flag.

1. **Level speed**: the R11/R12 speed at grade 0. That is the OSM or posted speed, capped by
   `heavy_apparatus_speed_kmh_by_highway` (still an ASSUMPTION) and by the unpaved and single-lane
   factors, then by the NFPA 1901 top speed (68 mph; 60 mph above 50,000 lb GVWR).
   - **Bug fixed**: before this change the backend read `speed_kph` from `road_access`, which
     returns `speed_kmh`. No class cap ever applied, so trucks drove at the OSM speed, e.g. 105 km/h
     on Highway 32.
2. **Curves**: the radius is the three-point circumradius of the OSM vertices, with neighbours at
   least 25 m apart (ASSUMPTION). The speed cap is AASHTO `V² = 127 R (e + f)`.
   - `f` is from Green Book Table 3-7 (via Iowa DOT Table 2B.1).
   - `e` is 6% on highways and 4% on local roads (ASSUMPTION).
   - The truck brakes into each curve at 3.4 m/s² (the AASHTO value, not retrieved here).
3. **Grade**: a point-mass truck model on the signed 3DEP profile, integrated along the edge, so
   momentum carries a truck over short pitches. Constants are from Rakha et al. (2001), as given in
   Lucic (2001): `F = 3600 η P / v`, plus rolling, aerodynamic and grade resistance.
   - Mass is the class's GVWR.
   - Power is 350 hp for the Type 3 (BME CAL FIRE Model 34) and 450 hp for the Type 1 (Pierce
     spec). The other classes are ASSUMED at 350 hp.
   - Acceleration is capped at the NFPA 1901 minimum, 0 to 35 mph in 25 s.
   - Downhill, the truck goes no faster than it climbs the same 150 m grade (CDL gear rule,
     ASSUMPTION as applied).
   - Steady climbing speeds, Type 3 (km/h): 92 at 4%, 74 at 6%, 51 at 10%, 34 at 16%. For the
     support tender: 64, 48, 31 and 20. Both meet NFPA's 20 mph (32 km/h) on 6%.
   - Camp only, where the DEM is wired. Elsewhere the ground is flat, labelled in `basis`.
4. **Junctions**: at the end of an edge, the arriving road is compared with the other roads that
   meet there.
   - A higher OSM class means a complete stop: NFPA 1500 requires stops at stop signs and at
     negative right-of-way junctions. The stop costs 2 s plus the speed-change loss.
   - The same class means a slow-down to 25 km/h (ASSUMPTION).
   - A lower class means no delay.
   - Turns onto a road with priority and traffic signals are not modelled.
5. The twin congestion factor and the R01-R12 access rules still apply on top.

`crew_routes` adds `travel_breakdown` per road leg: `free_flow_min`, `curve_min`, `grade_min`,
`junction_min`, `junction_stops`, and `car_posted_speed_min` (the same roads at the OSM speed).

Measured on Camp (`POST /api/demo/crew_routes`, no fire, Type 3). The car time is at the
OSM/posted speed on the same roads. RAND is `T = 0.65 + 1.7 D`, an urban cross-check (MTAS).

| Route | Before (min, km/h) | After (min, km/h) | Free / curve / grade / junction (min) | Car (min) | RAND (min) |
| --- | --- | --- | --- | --- | --- |
| Chico → Paradise, 22.5 km | 18.5, 73 | 21.8, 62 | 19.8 / 0.0 / 0.0 / 1.9 (5 stops) | 18.5 | 24.4 |
| Paradise → Chico | 18.3, 73 | 21.4, 66 | 19.8 / 0.1 / 0.1 / 1.5 | 18.4 | 25.5 |
| Paradise → Concow, 26 km | 35.8, 44 | 45.7, 34 | 44.7 / 0.0 / 0.3 / 0.7 | 35.8 | 28.2 |
| Oroville → Paradise | 30.9, 64 | 34.7, 57 | 31.2 / 0.1 / 0.2 / 0.3 | 27.9 | 35.6 |
| Paradise → Magalia, 8.3 km | 9.4, 53 | 10.1, 49 | 9.6 / 0.0 / 0.0 / 0.6 | 9.4 | 9.4 |
| Magalia → Stirling City | 21.1, 51 | 21.6, 55 | 21.2 / 0.1 / 0.2 / 0.2 | 21.1 | 21.6 |
| Chico → Forest Ranch (Hwy 32) | 17.1, 89 | 24.6, 62 | 23.0 / 0.0 / 0.1 / 1.4 | 17.1 | 27.5 |

- **No class beats the car time on any route.** The support tender loses 0.8 to 2.1 min to grade
  on the Skyway climbs.
- **Most of the change is the level-speed cap**, now applied (the bug above), plus junction stops.
- **Curves add under 0.1 min**: where roads wind, the level speed is already low (35-45 km/h,
  ×0.6 on single-lane roads).
- **Grade costs little for engines**: about 15-20 kW/t holds 74 km/h on 6%.
- **Paradise → Concow is slower than RAND**: canyon roads on single-lane speed factors. RAND is
  urban, so this is expected.
- **Not modelled**: momentum across edge boundaries (each edge starts at its capped or crawl
  speed), turn slow-downs, and signals. The Studio dispatch engine (`studio/roadAccess.ts`) still
  uses the step grade penalty, and the same model is not yet ported there.

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
- Dead ends (R10) and lane counts are not applied to apparatus routing; road grade is a DEM
  estimate that runs high on canyon-rim roads (see "Road access"). The response model does not
  yet add a walk-in or hose-lay time for `off_road_m_to_target`.
- Aircraft, water, work/rest, move-up and escalation are now modelled ([response-model.md](response-model.md),
  with its own list of gaps); unit counts per base are still assumed.
- Under observed November winds, fires routinely escape initial attack and the board fills to
  its 25-fire cap. That is the model's answer, not a defect to tune away; a labelled
  escaped-fire handoff rule would be the next step for long 24/7 runs.
- Congestion is not modelled. Carless households have no pickup model.
- `fire/rothermel.ts` used to give SH5 half the replay's head rate (85 against 173 m/min) by
  weighting each category's reaction term by its surface-area share. Since `SPREAD_MODEL`
  4.4.0 both codes match Behave (173 m/min, 6,144 Btu/ft²/min), so board fires in SH5 now
  spread about twice as fast and burn about twice as hot as the figures measured before it
  ([fire-simulator.md](fire-simulator.md#surface-model-equations-and-reference-check)).
