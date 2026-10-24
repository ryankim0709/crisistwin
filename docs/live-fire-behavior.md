# Live console: fire behaviour at the head

Date: 2026-10-24. Adds a fire-behaviour readout to the `/live` console for the Camp 2018 drill.
The fire on the map stays the observed perimeter timeline (`livecore/fire.py`): observed beats
modelled. The readout says how hard the head of that perimeter is burning at the drill clock,
which resources could hold it, and who in its way has no car. `/demo` is unchanged.

Code: `app/backend/api/live/fire_behavior.py` (inputs), `app/src/live/fireBehavior.ts` (physics,
pure), `app/src/live/FireBehaviorPanel.tsx`, `app/src/live/useFireBehavior.ts`; map labels in
`CommandMap.tsx`, assignee lines in `SelectedItem.tsx`. Wire types: `FireBehaviorResponse` in
`app/src/live/types.ts`.

## What the console shows

- **Fire behaviour** panel (right column): wind (speed, direction, gust, station, distance,
  drill hour; tagged Observed), head rate in m/min and head flame length in feet (tagged
  Model), the Hauling-chart band with what can hold it, and simulated units by apparatus
  with "Can hold" / "Cannot hold".
- **No vehicle** list in the same panel: ACS carless households in zones the fire estimate
  touches ("Fire") or an evacuate-now order covers ("Order"), with the ACS margin of error;
  a row focuses the zone.
- Map: a `HEAD (model) 17 m/min, 10 ft` label at the head point, `N no vehicle` on at-risk
  zone labels, and each responder's tooltip names its apparatus and whether it can hold the head.
- Selected task: the assignee line names its apparatus and whether it holds; its route is
  computed for that apparatus's road-access class (`tasks/{id}/route?class=`).

## Evidence

| Element | Before on `/live` | Now | Evidence |
| --- | --- | --- | --- |
| Fire | Observed perimeters, model fronts between them | Unchanged | Reconstructed |
| Wind | none on the console | Hourly wind at the drill clock from `sim.weather.scenario_wind` (`historical_replay`) over the drill's clock window, nearest covering station to Paradise: Jarbo Gap RAWS (JBGC1, 9.9 km, 20 ft). The drill clock is real 8-9 Nov 2018 time, so there is no looping. Hour = the bin nearest the drill time (sim.weather bins reports to the nearest hour). An ASOS station's 10 m wind is scaled by 0.87 to 20 ft (`scenario_weather.add_20ft_wind`). An hour with no report holds the last reported hour (**ASSUMPTION**, shown as "held") | Observed |
| Head point | none | The perimeter vertex farthest along the direction the wind blows toward. The perimeter carries no spread direction, so its downwind extreme stands for the head | Derived |
| Terrain | none | USGS 3DEP 1 arc-second, block mean onto 200 m cells, Horn (1981) slope (`sim/terrain.py`, the Camp package's `normalized/terrain_grid.json`, local only; `LIVE_TERRAIN_PACKAGE`). Missing package: flat, labelled | Observed |
| Fuel | none | **ASSUMPTION** SH5 (FBFM40 145) at the head: no LANDFIRE landscape covers Camp; it is the fuel the Camp bundle's own fire model uses | Assumption (labelled) |
| Moisture | none | **ASSUMPTION** Scott & Burgan (2005) "critical" (dead 3/4/5 %, live herb 30 %, woody 60 %), identical to the Camp bundle model's `moisture_fractions`. Not derived from the hourly humidity | Sourced values, assumed choice |
| Head rate, flame | none | Rothermel (1972) via `fire/rothermel.ts` (Andrews 2018 formulation); midflame wind by the Albini & Baughman unsheltered factor (`fire/crownFire.ts`); wind and slope as vectors; Byram flame length. Surface fire only | Model |
| Holding | none | PMS 465 p.12 Hauling chart (`hand_crews.flame_length_limits_ft`): up to 4 ft hand crews, engines and dozers; 4-8 ft engines and dozers; 8-11 ft head attack probably ineffective; above 11 ft aircraft or indirect line only. Per unit: `GROUND_APPARATUS[kind].holdsFlameLengthFeet` (4 ft hand crews, 8 ft engines and dozers, none for tenders and chiefs) | Sourced |
| Unit apparatus | Simulated units had a class only inside the driver | Declared on `join` (`apparatus`), returned in `command.responders[]` ([contract](live-reports.md)); `live_sim_responders` sends each station engine's kind and class | Simulated (labelled "sim") |
| No vehicle | Scenario runner's residents only | ACS households with no vehicle per block group from the replay bundle's demand table (1,172 over 43 zones), with the ACS margin of error | Observed (ACS) |

`/live` already did better than `/demo` on travel and departures, so those were not ported:
responders route the real drill roads per access class with twin congestion
(`livecore/inbound.py`, `livecore/apparatus.py`), simulated units start at real CAL FIRE
stations, and evacuation behaviour comes from the traffic twin and the scenario runner's
sourced generators ([live-scenario-runner.md](live-scenario-runner.md)).

## Endpoint

`GET /api/live/incidents/{id}/fire-behavior` (controller; `Cache-Control: no-store`). The
console polls it every 30 s. The wind series and terrain are loaded once per process; a failed
wind load is retried after 10 minutes.

```jsonc
{ "incident_id": "camp-2018-drill",
  "as_of": "2018-11-08T22:49:01Z",                       // drill time the inputs are for
  "fire": { "as_of": "2018-11-08T20:00:00Z", "method": "satellite_perimeter", "evidence_class": "reconstructed" },
  "available": true,                                     // false (with "detail") for Studio package drills
  "wind": { "t_utc": "2018-11-08T23:00:00Z", "held_from": null,
            "speed_ms": 4.47, "speed_20ft_ms": 4.47,       // m/s as reported; open 20 ft
            "from_deg": 40.0, "gust_ms": 12.5, "rh_pct": 12.0,  // degrees true FROM; null when calm
            "evidence_class": "observed",
            "station": { "id": "JBGC1", "name": "JARBO GAP RAWS", "distance_km": 9.872, "source": "iem_hads" },
            "height": { "from": "20 ft (6.1 m), RAWS standard", "factor": 1.0 } },
  "wind_detail": null,                                   // why wind is null
  "head": { "coord": [-121.64823, 39.706042], "slope_tan": 0.1561, "upslope_deg": 311,
            "terrain": "observed" },                       // observed | flat (no package) | outside (no DEM cell)
  "terrain": { "source": "USGS 3DEP 1 arc-second ...", "evidence_class": "observed" },
  "terrain_detail": null,
  "zones_fire_touches": ["bg:060070016002", "..."],      // fire estimate overlaps the zone
  "households_no_vehicle": { "bg:060070009011": { "households": 6, "moe": 14 } },
  "households_no_vehicle_source": "ACS households with no vehicle available, per block group (ACS 2018 5-year ...)" }
```

Units: WGS84 `[lon, lat]`; wind m/s, direction FROM in degrees true; slope rise/run. Computed
values (rate, flame, bands) are made in the browser by `fireBehavior.ts`; no number comes from
an LLM.

## Measured

- Rothermel at SH5, critical moisture, flat: 6.8 m/min and 6.6 ft at 2 m/s open wind; 23.0 m/min
  and 11.6 ft at 5.9 m/s; 64.7 m/min and 18.7 ft at 14.3 m/s. The same code with the "dry"
  preset gives 4.2, 14.4 and 40.6 m/min, the figures `/demo` reported.
- At 22:49Z drill time (perimeter of 20:00Z), JBGC1 reported 4.5 m/s from 40° (gust 12.5 m/s,
  RH 12 %); the head point sits on a 15.6 % cross-wind slope: 16.7 m/min, 10.0 ft flame, the
  8-11 ft band. A Type 3 engine cannot hold it.

## What is still not realistic

- One head point and one slope cell. The downwind vertex of an observed perimeter is a proxy
  for the head; a perimeter several hours old may have a head elsewhere by now.
- The hourly mean wind, not the gust, drives the model. The Camp bundle's calibrated replay
  model needed an 18 m/s open wind from 67.5° (`fire_simulated.model.params`) to match NIST
  arrival times, far above most hourly RAWS means, because the Camp Fire's run was carried by
  long-range spotting. The readout is an intensity indication at the head, not a spread
  forecast, and it understates the morning run.
- Surface fire only: no crown fire (no canopy rasters for the area), no spotting.
- Fuel is SH5 everywhere and moisture a fixed preset; neither follows the observed humidity.
- Holding is the Hauling chart's flame-length rule only: no line production, no crew counts,
  no water supply or aircraft availability.
- Unit apparatus is what a device declares on join; real phones that declare nothing show no
  holding verdict.
- Carless households are block-group ACS estimates with wide margins (shown), not people; no
  pickup model, and the twin does not carry them.
- Studio package drills get no readout: their fire is the model run they were published with.
- `fire/rothermel.ts` and `sim/fire.py` disagree on SH5 at the replay's inputs (85 against
  173 m/min head, reaction intensity 3,030 against 6,144 Btu/ft²/min): the TypeScript code
  weights each category's reaction term by its surface-area share, the Python code does not.
  The two agree for dead-only fuels; which matches Andrews (2018) for live-fuel models needs
  checking. The console uses the TypeScript model, so its head rates may be about half what
  the replay model would give.
