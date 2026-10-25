# Command demo: realism

Date: 2026-10-24. Extends the `/demo` board of `docs/adr/0047-command-demo.md` (the ADR is not
changed). The board keeps its 24/7 clock, its speeds (1× to 120×) and its Claude commander;
the fire, units, travel and households are now driven by sourced models and data. Every input
the board uses is listed under "Model inputs" on the page and in `observation.inputs` for the
commander, with its evidence class.

## Fires come from Simulation Studio

The board (now run inside Live command, `/live`) starts no fires itself: no scheduled ignitions,
no activity levels, no "Add fire", and a `fire_seen` field report no longer creates a fire (it
only joins a fire already there, so closing that fire resolves the report). Fires arrive when
Simulation Studio runs a simulation and publishes it (`POST /api/live/studio-fires`); the page
polls `GET /api/live/incidents/<id>/studio-fires` every 5 s (`app/src/demo/useStudioFires.ts`) and
`model.ts` `ingestStudioFire` takes each publish once per board (by `fire_id`):

- Each enabled Studio ignition starts at the ingest board minute + its Studio `start_minute`, as
  fire `S<n>-<ignition name>` (n counts the board's publishes, e.g. `S1-F1`), source `studio`.
  The clock lands exactly on each scheduled start.
- Ignitions in `outside_drill` (more than 3 km outside the drill zones' box) or off the board's
  landscape are skipped, with a board event saying why. Every ingest is logged
  ("Studio fire 'X' received as S1: 2 ignitions, wind 25 mph from 45° (assumed), Dry fuel
  moisture.") and shows in the audit log as source "Simulation Studio".
- Which publishes a board takes: every publish that appears after the board first read the
  feed, plus, at that first read, those published in the last 10 minutes (server time), the
  newest per Studio scenario only. This covers a run published while Live command was closed or
  while the board was still loading after Studio switched the drill. "Restart board" takes none
  of the publishes already listed.
- With no fire on the board the stage shows "No fires. Run a simulation in Simulation Studio to
  start one here." and the AI commander's monitor has nothing to wake it.

Code: `app/src/demo/realism.ts` (inputs and data), `app/src/demo/model.ts` (board),
`app/src/demo/fireField.ts` (fire solve and what the board reads from it),
`app/src/demo/fireSolver.worker.ts` + `useFireSolver.ts` (solves off the main thread),
`app/src/demo/fireFootprint.ts` (map polygons), `app/src/demo/useDemoEnvironment.ts`,
`app/src/demo/useCrewRoutes.ts`, `app/backend/api/demo_realism.py`. Contract:
`app/src/demo/contracts.ts`.

## Realism

| Element | Before | Now | Evidence |
| --- | --- | --- | --- |
| Fire spread | Constant head rate 8-32 m/min drawn at random per fire; fixed L:B 2.5; wind fixed from 45°, later one Rothermel ellipse per fire | The simulator's cell solver, the same as `/fire` and Simulation Studio (`fire/spread.ts` `simulateScheduledFireSpread`): Rothermel (1972) per cell with per-cell midflame wind from canopy (Albini & Baughman 1979), crown fire (Van Wagner, Cruz, Scott & Reinhardt), ember spotting and structure-to-structure spread at their defaults (`DEFAULT_SPOTTING`, `DEFAULT_STRUCTURE_SPREAD`). Every board fire is a solver source; spot fires belong to the fire that threw them (the board's own random spot rule is gone). No ellipse fallback | Model |
| Fuel and terrain | SH5 assumed everywhere; Camp 3DEP slope at 200 m | LANDFIRE FBFM40 fuel, canopy and terrain of the prebuilt region covering the drill (`GET /api/landscapes`, e.g. Berkeley Hills & Tilden, Pacific Palisades). With no covering region (Camp) or the store down, the same layers are loaded live from LANDFIRE for a square around the drill zones (half-width + 1.5 km ignition ring + 3 km margin, cell size as `/fire` picks for that radius), as Simulation Studio does when its stored board is unavailable. The board waits while it loads and shows an error, not a fallback, if it fails | Observed (mapped product) |
| Moisture | none | The Studio run's fuel moisture values (a Scott & Burgan 2005 scenario or custom), labelled "Assumed in Simulation Studio". Earlier: one scenario per activity level (removed with the activity levels) | Assumption (Studio scenario) |
| Wind (Studio fire on the board) | none | The Studio run's wind (speed mph, direction FROM), held constant as Studio runs it, labelled "Assumed in Simulation Studio" with Studio's own source (assumed, historical, worst case, forecast). A newer publish's wind and moisture apply to every fire on the board (the solver runs one wind) | Assumption (Studio scenario) |
| Station wind (no Studio fire yet) | none | Hourly series from `sim/weather.py` via `GET /api/demo/wind`, changing every simulated hour and looping. Three choices: 1-8 Nov 2018 observed (default), Camp Fire day observed, November 95th-percentile offshore episode (derived). Jarbo Gap RAWS (JBGC1, 10 km) for the observed modes; Chico ASOS for the derived one. Endpoint down: **ASSUMPTION** constant 5.9 m/s from 45° | Observed / derived |
| Wind in the solver | n/a | The solver takes one wind per run. With a Studio fire that is the Studio wind, constant. Without one (no fires, so nothing is solved) each solve would use the current hour's sample for its whole 6 h lookahead. When the sample (or the moisture) changes, the board re-solves from that minute, continuing from the burned ground with the solver's progress-preserving resume (`ResumeFrom` in `fire/spread.ts`): burned cells keep their times, and a step in progress keeps the share it covered at the old rate and finishes at the new one. So the footprint follows the hourly wind; **forecasts (zone ETAs, containment estimates) assume the current hour's wind persists** | Model (stated approximation) |
| Re-solves | n/a | On a new fire, a contained or closed fire (it stops spreading from that minute), a wind or moisture change (a newer Studio publish with other conditions), and when fewer than 120 min of lookahead remain. The board clock holds while a required solve runs, so results do not depend on machine speed; with unchanged weather a resumed solve reproduces an uninterrupted one exactly | Model |
| Fire shape and numbers | Analytic ellipse | The fire's own footprint in the arrival field. Area = its cells. Perimeter = its cell edges facing ground that can still burn (not rock, water, other fires' burned ground) x cell size x π/4 (mean staircase-to-smooth ratio, Cauchy-Crofton). Head figures = the solver's Rothermel rate, flame, heading and L:B at the leading front cell (the burned cell farthest from the ignition that still faces unburned fuel); a crowning or torching leading cell holds against no line (as `studio/initialAttack.ts`). Zone contact and overrun read the field over each zone's cells and at its core cell | Model |
| Units | 6 synthetic strike teams of 5 engines at 5× the Studio engine rate (about 50 m/min each) | One unit per engine the drill's resource snapshot lists as available at T+0 (Camp 8, Berkeley Hills 25, Palisades 12; synthetic engines, see "Resource snapshot" below), plus 2 Type 1 hand crews and 1 Type 2 dozer labelled "assumed (not in the snapshot)". Without a snapshot: 6 Type 3 engines, 3 Type 1 engines, 2 Type 1 hand crews, 1 Type 2 dozer (**ASSUMPTION** roster, labelled "No resource snapshot for this drill — using assumed roster"). Line from the sourced tables for the fuel and slope: about 2.7, 5.0, 2.2 and 10.7 m/min in SH5 (`studio/apparatus.ts`: PMS 465 p.164, Broyles 2011, PMS 465 p.140). Turnout 1.3 min (engines), mobilisation 30 min (crews) and 60 min (dozers) | Sourced rates; assumed counts |
| Holding | Any line held | Contained only when line reaches the perimeter and the head flame is within the unit's limit (Hauling chart, PMS 465 p.12: 4 ft hand tools, 8 ft engines and dozers) | Sourced |
| Bases | 3 synthetic stations | With a snapshot: its stations (OSM / NIST locations, observed; Camp's four Chico points synthetic), all of them, also those with no available engine. Without one: real CAL FIRE facilities from `GET /api/suppression/bases`: Type 3 engines and the dozer at the nearest CAL FIRE state stations (Paradise, Jarbo Gap, Stirling City, Forest Ranch, Cohasset, Harts Mill), Type 1 engines at the nearest Schedule A stations (Paradise FD 81 and 82, Upper Ridge), crews from Table Mountain Fire Center. Without the local-only bases file: synthetic stations, labelled | Observed locations |
| Travel | Straight line × 1.3 at 50 km/h | `POST /api/demo/crew_routes`: `livecore.inbound.inbound_route` over the drill roads, per apparatus class (`tools.suppression_data.road_access`, rules R01-R12), avoiding fire. A base (or a target, such as an attack position in the wildland) off the network gets a straight-line × 1.3 leg at the heavy-apparatus secondary-road cap to (from) the nearest road node. Units only move along that road line: a unit dispatched before its road time is known waits at its base (travel `pending`) and sets off, timed from its dispatch, when the leg arrives; a trip with no road route releases the unit with the router's reason. **ASSUMPTION** straight line × 1.3 at 60 km/h only for options and ETAs shown before a road time is known | Model |
| Departure | Uniform over 45 min after an order, everyone leaves | Exponential delay, mean 93 min (Camp awareness-to-departure, Grajdura 2022; the exponential shape is an **ASSUMPTION**). 92% of households with a vehicle leave on an order (**ASSUMPTION** inside the sourced 0.87-0.97) | Sourced mean and range |
| Shadow evacuation | none | With no order, 30% of households with a vehicle leave once fire touches the zone (**ASSUMPTION** inside the sourced 0.29-0.75), on the zone's best route | Sourced range |
| No vehicle | none | The snapshot's `needs_transport_households` per zone (Camp: ACS, 1,172 over 43 zones, the replay bundle's demand table; packages: synthetic, 1,586 Berkeley, 672 Palisades); without a snapshot the environment's ACS count (Camp) or none. They stay home and are shown as "No vehicle, at risk" when a fire touches or is forecast to reach their zone | Observed (ACS) |
| Congestion | not modelled | Evacuating vehicles load their route's road segments each minute; BPR volume-delay on the flow that passes plus a point queue where demand exceeds capacity, on the drill roads' assumed capacities (see "Evacuation traffic" below). Fire units still drive free-flow times | Model on assumed capacities |

## Resource snapshot

The board starts from the drill's scenario resource snapshot (`GET
/api/live/incidents/<id>/snapshot`, [scenario-snapshots.md](scenario-snapshots.md)), read once
per incident by `useCommandBoard.ts` and again on **Reset board**. The board is built only when the
command data and the snapshot answer of the same `incident_id` have both arrived; an incident
switch or Reset board rebuilds it (units free at their stations, every household home). A
snapshot re-seeded while a board runs is picked up at the next Reset board.

- **Households** (`model.ts` `createBoard` / `zoneState`, matched by `zone_id`): `households`,
  `occupants` (persons), `evacuating_vehicles` (what the households drive out with, the traffic
  model's demand), `needs_transport_households` and `_occupants` (carless: stay home, need
  transport), `vehicles` (owned, shown only). A board zone the snapshot does not list keeps the
  drill file's households and vehicles with persons unknown.
- **Persons** (`zonePeople`): carless households' persons stay home; the other persons follow
  their households, `floor(households x vehicle persons / households with a vehicle)` for those
  left and those out (**ASSUMPTION**: equal persons per vehicle household within a zone; the
  snapshot gives zone sums). Caught persons are frozen at the overrun. Unknown occupants (`null`,
  or `unknown_households > 0`) stay `null` (shown as unknown), never 0, with `known_occupants`
  and the unknown households alongside.
- **Units** (`snapshotTeams`): one per engine with `status_at_start: "available"`, id = its
  `engine_id` (`S04-E2`, `ST81-E1`), at its station; `type3_engine` runs as `engine_t3`,
  `type1_engine` as `engine_t1` (`realism.ts` `SNAPSHOT_ENGINE_KIND`, sourced rates in
  `studio/apparatus.ts`). Committed and out-of-service engines are on the station records
  (`board.stations[].engines`, `stationRecords`) but never units, so a station with no available
  engine has no unit. The snapshot has no hand crews or dozers, so `realism.ts`
  `ASSUMED_EXTRA_UNITS` keeps the fallback roster's 2 Type 1 hand crews (C1, C2) and Type 2
  dozer (D1), labelled "assumed (not in the snapshot)", at the nearest CAL FIRE crew camp /
  state station when the CAL FIRE bases layer loaded, else at the snapshot station nearest the
  drill centre (Camp ST81, Berkeley S03, Palisades S09).
- **No snapshot** (404 `no_snapshot`, network error, timeout): the board still runs, on the
  assumed roster and the drill file's counts, with `board.resources.label` "No resource snapshot
  for this drill — using assumed roster" and the reason (`board.resources.problem`,
  `useCommandBoard().resourceNotice`, also put in the page notice).
- **One assignment per unit.** A unit is on at most one fire and one line. `send_crew` on a unit
  en route or on scene reassigns it: it is released from its fire or line first (logged "released
  from ... to be reassigned"), then sent; a trip with no road route changes nothing. Sending it
  where it already is is refused. `checkBoardInvariants` (run after every step in dev builds,
  `console.error` once per message) checks that no unit is in two fires' crew lists, a line's
  units are on its fire, engine units are available snapshot engines, and households and
  persons balance (home + on the road + out + caught = total, nothing negative).
- **Commander** (`observation.ts`): crews carry `engine_id`, `station_id`, `assumed`; zones
  `occupants`, `known_occupants`, `unknown_occupant_households`, `people_home` / `_en_route` /
  `_out` / `_caught`, `needs_transport_households`, `needs_transport_occupants(_home)`,
  `demand_source`; totals `people`, `people_known`, `people_caught_total`,
  `needs_transport_people_at_risk`; `inputs.stations` and `inputs.demand` say where they come
  from.

Measured (2026-10-25, scratch script on the stored snapshots, synthetic flat SH5 ground, half the
zones ordered at T+0 and two 20 mph Studio ignitions, 480 min): units = available engines + 3
(Camp 8 + 3, Berkeley 25 + 3, Palisades 12 + 3); stations with no available engine (Camp SYN1,
Berkeley S02, Palisades S02 and S08) have no engine unit; households and persons balanced at every
minute (e.g. Berkeley T+483: 19,882 = 14,388 home + 24 on the road + 1,787 out + 3,683 caught;
49,112 persons = 35,540 + 61 + 4,405 + 9,106); a second send of a dispatched engine reassigned it
(on one fire's list only), a third was refused.

## Evacuation traffic

The board's own traffic model (`app/src/demo/traffic.ts` maths, `model.ts` "evacuation traffic"
glue). It is not the traffic twin (`sim/traffic.py`): the board's households are not in the
twin, so the board runs this small deterministic model on the same drill roads instead.

- **Roads.** `POST /api/demo/routes` now gives each option `segment_ids` and the answer a
  `segments` table (`{name, length_m, lanes, capacity_veh_h, free_flow_min}` by id;
  `app/backend/api/demo.py` `route_segments`). A segment is a maximal run of a route's directed
  drill edges that every route of the answer uses all of or none of, with one capacity, lane
  count and name, so two zones on the same stretch list the same id. Ids are per answer; on each
  new answer the board moves every leaving zone onto the newest route to its destination
  (`setRoutes`), so loads keep matching. Option `destination_capacity_veh` is the bundle's
  destination capacity (null for exits, unknown).
- **Capacity** (veh/h, one direction, all lanes) is the bundle edge's `capacity_veh_per_hour`:
  lanes x an assumed per-lane capacity by OSM class. Camp: `sim/traffic.py` `_HIGHWAY_DEFAULTS`
  (motorway 2,000, trunk 1,800, primary 1,600, secondary 1,200, tertiary 1,000, unclassified
  700, residential 600, service 400 veh/h/lane; "rough HCM-style planning values"). Studio drill
  packages: `app/backend/api/dispatch_area.py` `CAPACITY_PER_LANE_VPH` (motorway 1,900, trunk
  1,600, primary 1,200, secondary 1,000, tertiary 800, other 600; lower than textbook values for
  narrow hill roads). An edge with no capacity gets lanes x 600 (`DEFAULT_CAPACITY_PER_LANE_VPH`,
  as `sim/twin.py`). These are **assumptions**, not observed counts.
- **Vehicles.** A departing household takes the snapshot zone's `evacuating_vehicles` /
  households with a vehicle (1-2: the snapshot caps a household at 2 cars taken); without a
  snapshot the drill file's zone vehicles / households with a vehicle (at least 1,
  **ASSUMPTION**). Carless households still stay home.
- **Loading.** Every whole simulation minute the vehicles that left each zone in that minute
  (from the analytic departure curves) load every segment of the zone's current route at once
  (static loading: a vehicle counts on its whole route from departure, not where it is).
- **Moving time** per segment is the BPR function (Bureau of Public Roads, *Traffic Assignment
  Manual*, 1964): t = t0 (1 + 0.15 (v/c)^4), on the flow that passes (v at most c, so at most
  +15 %), capped at `CONGESTION_MAX_FACTOR` = 10 (`livecore/routing.py`) as a guard.
- **Queues.** Demand above capacity waits in a deterministic point queue per segment (Vickrey
  1969 bottleneck model): q(t) = max(0, q(t-1) + inflow(t) - capacity), per minute over the
  departure curves of the zones currently routed over it. The wait is the largest queue delay
  (queue / capacity) on the route; queues in series are not summed because static loading gives
  every segment the full inflow. BPR alone could not show a jam: it scales a segment's free-flow
  time, and bottleneck links are often a few hundred metres long.
- **Arrival.** A cohort's arrival is fixed when it departs: departure minute + moving time +
  wait then, first in first out per zone. Households home when fire reaches the zone core are
  still caught; vehicles on the road are not caught (as before). Counts are conserved: home +
  on the road + out + caught = households.
- **What the commander sees** (`observation.zones[].options[]`): `free_flow_min`,
  `congested_eta_min` (current loads and queues plus this zone's own departure rate, as if
  ordered now when not ordered), `vehicles_on_route_now`, `bottleneck` (the option's segment
  slowest to pass everything committed to it: other zones' vehicles on the road or still to
  leave on routes through it, plus this zone's), `clearance_min` (that load / capacity),
  `margin_min` = `fire_core_eta_min` - (`departure_mean_min` + `clearance_min` +
  `congested_eta_min`), `destination_load_vehicles` and `destination_capacity_veh`. Per zone:
  `vehicles`, `vehicles_en_route`, `margin_min` (current destination when ordered, else best
  option). Board: `traffic.vehicles_on_road` and `traffic.worst_segment`. The margin is
  conservative (it adds the mean departure delay to the clearance of the whole zone); it is for
  ranking zones, not a clock. The commander still only picks a destination per zone and the
  order sequence; no new order field.
- **On screen.** Routes in use are drawn on the 2D board map coloured and labelled by their
  delay (Slow at 1.25x free-flow, Jammed at 2x) and widened by the zone's vehicles on the road;
  evacuating vehicles are dots (2D) and small blue cars (3D) placed along the road line of their
  route at the share of their trip time elapsed, one per at least 10 vehicles, at most 400.
  The zone panel shows time in traffic, margin and bottleneck per option.

Measured (2026-10-24, scratch script on the Camp routes with no fire, two 1,000-household zones of
1,700 vehicles each, ordered at T+0, `bg:060070009011` and `bg:060070022004`, whose best routes to
Exit west share a 1,200 veh/h motorway link): alone, the first zone's mean drive is 9.8 min (free
flow 9.8). Both on the shared route: 16.8 and 24.9 min mean, 25.0 and 33.1 min worst, a 287-vehicle
queue at T+60, clearance 112-116 min. Sending the second zone to its other destination (Paradise
Police Department refuge): 9.8 and 14.1 min mean (the second zone still queues on its own 600 veh/h
Almond Street). Mean arrival T+109 / T+117 shared against T+102 / T+107 split.

## Predictive attack and control lines

Code: `app/src/demo/attack.ts` (positions, line raster), `app/src/demo/model.ts` (`AttackLine`,
`attackPositions`, `positionOptions`, line building, `heldByLine`), `app/src/demo/fireField.ts`
(`controlLines` in the solve). Units are not only sent to the fire: the commander (and the
selected-fire panel) can send them to build line where the fire is forecast to go.

- **Positions** come from the fire solver's lookahead field for each burning fire, re-planned on
  every solve and every 10 board minutes (`POSITION_REPLAN_MINUTES`): `head_30` and `head_60`, the
  fire's leading front cell 30 and 60 min from now (`fireGeometry` at that minute); `flank_left`
  and `flank_right`, the front cells farthest either side of the spread axis 30 min from now;
  `zone_<id>`, the cell where the fire first reaches each of the (at most 2) zones it reaches
  first within 120 min. Positions the fire reaches within 5 min are not offered. Each lists
  `fire_eta_min` (the field's arrival there), the fuel, the solver's directional spread rate and
  Byram flame facing the line (`spread.ts` breach rule), crowning, and `protects_zone_ids` (zones
  this fire first reaches later, ahead of the line and within its span: a geometric reading of the
  forecast, not a re-solve).
- **Line geometry**: across the forecast spread direction (at a head, the solver's direction of
  maximum spread; elsewhere the arrival-field gradient), through the position, out each side as
  far as the forecast burns across that line within 60 min of reaching the position
  (`LINE_SIZING_MINUTES`), stopping at ground that carries no fire (a natural anchor), plus one
  cell, at most 750 m a side. Rasterised as a 4-connected chain of cells so no solver step slips
  between cells.
- **Orders**: `send_crew` takes an optional `position_id` (validated on the server against that
  fire's listed ids, and again by the page). The unit drives the road route to the position's
  anchor point, then builds line outward both ways at its sourced rate (`lineMetersPerMinute` at
  the anchor's fuel and slope); several units on one line add up. Without `position_id`, the
  unit attacks the fire's edge as before (perimeter race). When a line is finished its units are
  free; the line stays. Options per position give `arrive_min` and `line_done_min` for the
  nearest free units that can reach it by road.
- **Reachability per apparatus class**: road access differs by class (`access_class`, rules
  R01-R12 of [suppression-data.md](suppression-data.md); in the Berkeley hills a Type 1 engine,
  `engine_t1_t2`, can get `no_open_road` where a Type 3, `engine_t3`, drives in 23 min).
  `useCrewRoutes.ts` asks `POST /api/demo/crew_routes` (at most 40 legs a request, one request
  at a time) for each burning fire's crew target and each attack position (re-planned positions
  are new targets) from the 2 nearest free units of each access class (`PROBES_PER_CLASS`),
  then the nearest units overall; units already known unable to reach a target are skipped.
  Each leg's answer is cached on the board (`board.travel` / `board.noRoute` by travelKey) and
  noted per class (`board.classReach`, key `access_class|destination id|target lon,lat` at 3
  decimals). A class cannot reach a target when its legs there failed for a reason at the
  target's end (`no_open_road`, `no_access`, `target_in_fire`, `target_off_network`) from 2
  distinct origins, or from every origin its free units stand at, and none succeeded
  (`model.ts` `classBlocked`; two origins guard against one station in a pocket of roads the
  class cannot leave). Fire and position `options` list only crews that can reach the target,
  with `route: "road"` (turnout + road leg for every crew) or `"estimate"` (some crew's road
  leg not known yet: straight line x 1.3 at 60 km/h, **ASSUMPTION**); `unreachable_classes:
  [{access_class, kinds, reason}]` says which apparatus cannot use the roads there, and
  `crews[].access_class` names each crew's class. An order for a crew whose class cannot
  reach the target (or whose own leg failed) is refused at once with the reason; no dispatch
  waits on it.
- **Line in the spread model**: every built cell becomes a solver control line
  (`spread.ts ControlLines`) from the minute it was finished, holding flames up to the builder's
  Hauling-chart limit (crown fire breaches any line; embers still fly over). The board re-solves,
  resuming from the burned ground, each time a line passes another 100 m (`LINE_RESOLVE_CHUNK_M`)
  or is finished; the clock lands exactly on those moments and on units' arrival at a line, so a
  run is the same at any tick size. Forecasts (zone ETAs, positions) then include the line. A fire
  with line is **contained** when the solver, with its line, forecasts no further spread to its
  horizon (at least 2 h ahead).
- **Measured** (2026-10-24, scratch script, Berkeley Hills & Tilden 507 x 507 cells of 23.7 m, one
  Studio ignition in GR2 grass at -122.2241, 37.92762, Dry moisture, wind from 45°, positions at
  T+30, all positions ahead of the fire):
  - 10 mph: head_30 / head_60 lines 237 / 260 m, fire there in 29 / 58 min, head flame 1.7 ft.
    A head_60 line built at T+30 (solver only) cuts the forecast area at T+150 from 13.4 to
    5.8 ha and at T+390 from 60.2 to 44.6 ha. On the board, E1, E2 and D1 sent to head_60 at
    T+30 finish its 260 m at T+53.5 (three re-solves for line), and the fire is 35.5 ha at T+360
    against 55.0 ha with no units; head, both flanks and head_30 together (eight units) leave it at 10.1 ha, still
    backing slowly at the heel (not contained). Direct attack with the same units contains this
    small fire at 1.6 ha (T+65). Tick 0.2 and 0.73 min give identical areas and line times.
  - 25 mph: head_60 falls in timber litter that crowns (`crowning: true`); a line there changes
    the T+390 area by 0.2 ha (51.4 to 51.2 ha), which is the model's answer for a crowning head.
    A zone_Z24 line cuts T+150 from 27.1 to 12.6 ha.
  - Solves on the board with line: about one per 100 m of line (16 for the four lines above),
    about 50 ms each with one fire.

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
  non-Camp incident `terrain` is null (Camp-only package; the board no longer reads `terrain`, its
  slope comes from the LANDFIRE landscape) and carless households are `{}`, labelled unknown (counted as 0). `stations`
  (`[{id, name, lon, lat}]`) and `stations_source` carry the drill package's OpenStreetMap fire
  stations (observed; Camp: `[]` and null). The board uses them only when the CAL FIRE bases
  file is unavailable: the nearest stations fill all three base pools and the two nearest double as
  crew camps; unit types and counts per station stay assumed, and `basesLabel` says so. Terrain needs the Camp incident package locally
  (`DEMO_TERRAIN_PACKAGE`, default `data/incidents/camp-2018-evacuation/17e67cfe5669fe50`);
  slope is sent as rise/run × 1000 integers, aspect as whole degrees.
- `POST /api/demo/crew_routes`, body `{fires: rings, requests: [{id, access_class, from, to}]}`
  (at most 40): per request `drive_min` (no turnout), `distance_m`, `basis` (`road`,
  `road_offboard`), `offboard_m` (off-network legs at the start and the end, summed), `reason`
  when there is no route, and the line (ending at `to` when `to` is off the network).

## Measured

- Earlier ellipse model (removed), kept for comparison. Rothermel at SH5, flat, dry moisture: 4.2 m/min at 2 m/s open wind, 14.4 m/min at 5.9 m/s,
  40.6 m/min at 14.3 m/s; head flame 4.9, 8.6 and 13.9 ft. Engines hold the head only below
  about 5 m/s of wind in dry fuel.
- Crew routes, Paradise FS to central Paradise: 7.0 min by road (5.75 km) against 6.1 min by
  the old straight-line rule; Table Mountain Fire Center: 65.7 min (3.9 km off-board, then
  40 km of road).
- Earlier ellipse model (removed): 24 simulated hours on the 43 drill zones with a greedy
  commander (3 nearest units to every new fire, no evacuation orders): with 1-8 Nov wind, 4 to 7
  of about 30 fires contained; with the Camp-day or P95 wind, none.
- Fire solver on the board (2026-10-24, node, scratch check): Berkeley Hills & Tilden, 507 x 507
  cells of 23.7 m, canopy present. A 24 h Active board with 1-8 Nov wind and a greedy commander:
  178 solves (89 new fires, 72 containments, 17 wind changes), median 82 ms, p95 0.6 s, max 0.7 s;
  at most 18 sources. Camp loaded live from LANDFIRE for an 11 km radius: 954 x 954 cells of 23.1 m,
  11 s to load, 0.3-1.1 s per solve with 8 fires at 2-9.4 m/s.
- Solver resume: with unchanged weather, resuming at any minute (or 17 times in a row) matches the
  uninterrupted run to 1e-4 min (float32 storage) with identical cells and attribution; after a
  135° wind shift and speed-up no burned cell changes and nothing burns before the resume minute.
  The default solver path (no extension) is bit-identical to before for `/fire` and Studio.
- Determinism: the same seed stepped at 0.2 and 0.73 min ticks gives identical fires, areas,
  statuses and zone contact times over 6 h (the clock lands exactly on ignitions and wind hours).

## What is still not realistic

- Forecasts hold the current hour's wind for the whole lookahead; the footprint itself follows the
  hourly series only as it is reached. Wind is uniform over the landscape.
- At a wind change, a cell that was crowning carries an active crown fire on only into canopy
  that sustains it at the new wind; the arrival breakdown counts resumed cells as surface spread.
- Perimeter is a lattice estimate (π/4 is exact only for orientations spread evenly; an elongated
  fire aligned with the grid reads up to 21% low, one diagonal to it up to 11% high). Direct-attack
  line is counted against the open perimeter, not built along a path. Line at attack positions is
  built along its path and blocks every fire, but its production rate is the anchor cell's
  (fuel and slope along the line are not varied), the last stretch from a road node within 1 km
  (the router's snap distance) is walked at no time cost, and the line's length is fixed when it is started.
- The containment check uses the head flame at the leading front cell and takes it to persist in
  the forecast; a fire whose head has stalled at a barrier is judged at its farthest still-open
  cell, often a flank.
- A fire started where another fire will arrive first contributes nothing (the solver's
  "reached before start"); one started on burned ground, non-burnable ground or off the
  landscape is labelled and does not spread.
- Road grade, dead ends (R10) and lane counts are not applied to apparatus routing; on the
  drill's paved roads every class gets the same heavy-apparatus speeds.
- No aircraft, no water supply, no fatigue or shift changes; engine counts and availability
  per station are the snapshot's assumptions (synthetic), and the hand crews and dozer are not
  in the snapshot at all. Committed engines never become available during a run.
- Persons are spread evenly over a zone's vehicle households (the snapshot's per-household
  occupants are not used household by household).
- Under strong Studio winds, fires routinely escape initial attack. That is the model's answer,
  not a defect to tune away. The Studio run's `horizon_minutes` is not applied: board fires burn
  until contained or closed.
- Ingest timing is a wall-clock input (when the poll sees the publish); given the same publishes
  ingested at the same board minutes, a run replays exactly.
- Evacuation traffic uses static loading (a vehicle loads its whole route at departure), point
  queues without spillback into upstream links, no intersections or signals, and assumed
  capacities; a zone redirected mid-evacuation moves its past departures to the new route in the
  queue history. Fire units drive free-flow times and are not slowed by evacuees. Destination
  capacity is reported, not enforced (exits have none). Carless households have no pickup model.
- Fires that leave the board keep their burned ground in the field (no reburn) until restart.
- `fire/rothermel.ts` and `sim/fire.py` disagree on SH5 at the replay's inputs (85 against
  173 m/min head, reaction intensity 3,030 against 6,144 Btu/ft²/min): the TypeScript code
  weights each category's reaction term by its surface-area share, the Python code does not.
  The two agree for dead-only fuels; which matches Andrews (2018) for live-fuel models needs
  checking. The board uses the TypeScript model (through the solver).
