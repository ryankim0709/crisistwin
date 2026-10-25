# Scenario weather

Historical, climatological and forecast wind and moisture for a scenario anywhere in
California, so a Studio fire (and later a live drill) stops relying on an assumed wind. Code:
`sim/weather.py` (inputs), `sim/weather_forecast_error.py` (forecast-versus-observed error).
Decision record: [ADR 0045](adr/0045-scenario-weather.md). Tests: `tests/test_weather.py`
(no network).

## Sources and terms (all free, no key)

| Source | Used for | Access | Terms |
| --- | --- | --- | --- |
| IEM ASOS/AWOS archive (Iowa State) | Airport hourly METAR: wind speed, direction, gust, RH, temperature | `mesonet.agron.iastate.edu/cgi-bin/request/asos.py`; station list `/geojson/network/CA_ASOS.geojson` | Public domain, free for any lawful purpose, attribution appreciated ([disclaimer](https://mesonet.agron.iastate.edu/disclaimer.php)). Per-IP rate limit and a 1,000 station-year cap per request. |
| IEM DCP/HADS archive | RAWS fire-weather stations relayed through NWS HADS (for example Jarbo Gap, Pike County Lookout, Santa Rosa, Hawkeye): wind, peak wind, RH, temperature | `cgi-bin/request/hads.py?network=CA_DCP&stations=ID`; station list `CA_DCP.geojson` (filtered to names containing "RAWS") | Same IEM terms. Serial per-IP throttle (HTTP 429; the client backs off and retries). English units (mph, deg F). |
| NWS `api.weather.gov` gridpoint forecast | "Now" scenarios | `/points/{lat},{lon}` then `forecastGridData` | Open data, no fee, public domain ([API docs](https://www.weather.gov/documentation/services-web-api)). Identifying `User-Agent` required, undisclosed rate limit. Do not present modified content as official NWS product. |
| IEM NWS text-product archive | Archived Fire Weather Planning Forecasts (`FWFSTO`, `FWFMTR`) for the forecast-error study | `cgi-bin/afos/retrieve.py`, `api/1/nws/afos/list.json` | NWS products are public domain; IEM terms as above. |

Checked and not used:

- **IEM RAWS network.** The `RAWS` and `CA_RAWS` networks exist in IEM metadata but hold no
  stations, so RAWS arrives through HADS instead.
- **WRCC RAWS archive** (`wrcc.dri.edu`, redirected to `wrcc-archive.dri.edu`). It is an
  interactive form, and we found no published terms for programmatic use. Not integrated; do
  not scrape it. If the team wants the official RAWS archive, ask WRCC first.
- **Synoptic/MesoWest.** Needs a token. Excluded.

RAWS through HADS is whatever the stations transmitted over GOES: coverage varies by
station and year (Cohasset RAWS returned nothing for November 2018). `scenario_wind` therefore
checks coverage and falls back to the next-nearest station, and lists every candidate it
tried.

## `sim/weather.py`

```python
from sim import weather as W
W.nearest_stations(lon, lat, k, at=None, sources=None)      # list[Station], nearest first
W.fetch_history(station, start_utc, end_utc)                 # WeatherSeries, evidence "observed"
W.scenario_wind(lon, lat, start, hours, mode)                # dict, see below
```

`mode` is `historical_replay`, `climatology_percentile` or `forecast`.

### Conventions

- Times: timezone-aware UTC in, ISO `...Z` out. Naive datetimes raise. Hourly samples are
  labelled by the centre of their hour: reports within +/-30 min of HH:00 belong to HH:00.
- Speeds m/s, temperature degC, RH percent (0-100), coordinates `(lon, lat)`.
- Direction is meteorological, the bearing the wind blows **from**, degrees true, clockwise from
  north, `[0, 360)`. `None` is calm or not reported; METAR `000` with wind is treated as unknown,
  not guessed. Hourly direction is the speed-weighted vector mean, never an arithmetic mean of
  degrees.
- Gust is the maximum reported in the hour; it is never synthesised from sustained speed.
- Gaps stay as `None` samples (`summary.missing_speed_samples`). Nothing is interpolated.
- No height conversion in the module: ASOS and gridpoint winds are 10 m, RAWS 20 ft, the Rothermel
  input is the open 20 ft wind. `GET /api/weather/scenario` converts (see "Consumed by").

### Evidence classes

| Class | Meaning |
| --- | --- |
| `observed` | Station data, as reported (`historical_replay`). |
| `forecast` | NWS gridpoint forecast (`forecast`). Never cached. |
| `derived` | Real observed hours chosen statistically (`climatology_percentile`). Not a named event. |

### Return shape of `scenario_wind`

```json
{
  "mode": "historical_replay", "evidence_class": "observed",
  "lon": -121.6, "lat": 39.81, "start_utc": "2018-11-08T00:00:00Z", "hours": 36,
  "units": {"speed": "m/s", "direction": "degrees true, wind blows FROM, clockwise from north", "time": "UTC, hourly bin centre"},
  "station": {"id": "JBGC1", "name": "JARBO GAP RAWS", "lon": -121.4889, "lat": 39.7358, "distance_km": 12.579},
  "samples": [{"t_utc": "2018-11-08T00:00:00Z", "speed_ms": 1.8, "from_deg": 236.0,
               "gust_ms": 3.1, "rh_pct": 21.0, "temp_c": 16.7, "n_obs": 1}],
  "provenance": {"terms": {}, "raw": {"url": "...", "bytes": 5657, "sha256": "...", "from_cache": true},
                 "candidates": [{"station": "JBGC1", "distance_km": 12.579, "coverage": 1.0}]},
  "summary": {"max_speed_ms": 14.3, "max_gust_ms": 23.2, "missing_speed_samples": 0}
}
```

`samples` has `hours + 1` entries (both end hours). For `forecast`, `station` is `null` and
`provenance` has the grid URL, `forecast_update_time` and the SHA-256 of the document.

### Modes

- **`historical_replay`**: the nearest of the `k` (default 4) nearest stations whose archive covers
  `start` and which has at least `min_coverage` (0.75) of the window's hours; otherwise the
  best-covered. ASOS and RAWS compete on distance only. For a ridge fire, prefer a RAWS
  explicitly (`sources=["iem_hads"]` via `nearest_stations`): valley ASOS winds under-read ridge
  winds (see Camp below).
- **`climatology_percentile`** (default 95th, offshore sector 315-90 degrees from): for the calendar
  month of `start`, take the nearest long-record ASOS, find offshore-wind episodes in 2012-2025
  (runs of at least 6 h with sustained wind at least 5 m/s from the sector), take the episode whose
  peak is the nearest-rank percentile of all episode peaks, and replay that episode's real hours,
  relabelled to begin at `start`. The source episode is in `provenance.analog`. For Camp's
  November at Chico: 9 episodes, P95 peak 12.9 m/s (25 kt), analog 2013-11-03 22:00Z, 13 h long.
  Not a prediction and not a named event; the tail is thin (9 samples).
- **`forecast`**: NWS gridpoint forecast, `hours + 1` hourly samples from `start` (UTC hour). Hours
  outside the forecast horizon are `None`. Use for "now" scenarios only.

### Cache

Raw responses live outside the repo: `$CRISISTWIN_WEATHER_CACHE` or `~/.cache/crisistwin/weather`,
one file per URL plus `index.json` with `{url, bytes, sha256, retrieved_utc}`. A file whose size or
SHA-256 no longer matches is re-fetched. The first call needs the network (station catalog and
data); after that, historical and climatology runs work offline.

## Camp Fire day, observed (2018-11-08, UTC; PST = UTC-8; ignition 14:29Z)

Hourly sustained wind, from the committed fixtures (`tests/fixtures/weather/`).

| Station (type, km from ignition area) | 00-14Z (night before ignition) | 14Z-00Z (ignition day) |
| --- | --- | --- |
| Jarbo Gap RAWS (HADS, 12.6) | mean 9.2 m/s, peak 14.3 m/s at 12Z from 38 deg, gust 23.2 m/s, RH min 15% | mean 5.9, peak 8.0 at 14Z from 33 deg, gust 17.9, RH min 11% |
| Pike County Lookout RAWS (HADS) | mean 7.1, peak 10.7 from 55 deg, gust 19.2, RH min 17% | mean 6.1, peak 8.0 from 56 deg, gust 15.6, RH min 10% |
| Chico ASOS (22) | mean 2.6, peak 6.7 from 310 deg, gust 11.3, RH min 3% | mean 6.0, peak 11.3 at 00Z from 300 deg, RH min 6% |
| Oroville ASOS (36) | mean 2.6, peak 4.6 from 320 deg, gust 7.7, RH min 18% | mean 4.8, peak 7.7 from 310 deg, gust 12.9, RH min 14% |

The ridge RAWS saw north-northeast wind of 8-14 m/s (18-32 mph) sustained with gusts to 23 m/s
(52 mph) through the night and morning, decaying after the fire started. The valley airports
saw light northwesterly wind that strengthened in the afternoon, a different regime 20-35 km
away. The wind a scenario uses depends heavily on which station is picked: that is why
`provenance` records the station and distance, and why the Studio must show them.

## Forecast versus actual

Archived forecasts are obtainable free: the IEM text archive holds every NWS Fire Weather
Planning Forecast. `sim/weather_forecast_error.py` parses the per-zone 20 ft wind ranges and
compares them with the stations above (`python3 -m sim.weather_forecast_error` rewrites
`sim/evidence/weather_forecast_error_2017_2018.json`, network needed).

Method and limits (read before using the numbers):

- Zone forecast ranges (12 h periods) versus point observations. Our zone and ridge/valley
  assignment per station is an ASSUMPTION (`STATION_ZONES`).
- Periods whose text changes within the period ("decreasing to...", "shifting to...") are excluded
  because only the first phase is parsed. Direction is only compared when the observed mean
  wind is at least 2 m/s. Direction error is `observed - forecast`, positive is clockwise.
- Camp: forecasts issued 2018-11-07 12:31Z, 23:29Z and 2018-11-08 13:56Z, 22:47Z (zones CAZ216 and
  CAZ266); stations CIC, OVE, JBGC1, PKCC1. Tubbs: forecasts issued 2017-10-07 22:09Z to
  2017-10-09 23:19Z (zones CAZ506 and CAZ507); stations STS, RSAC1, APC, O69, HWKC1, ATLC1.
- Samples are tiny and overlapping (one period appears in several products); treat the numbers
  as an order of magnitude, not a statistic.

Findings (forecast issued at most 12 h before the period, periods overlapping the 24 h after
ignition; 12 comparisons usable, 12 more excluded as multi-phase):

| Quantity | Result |
| --- | --- |
| Direction error | mean abs 25 deg, median 17 deg, 90th percentile 53 deg, max 59 deg; mean signed +10 deg |
| Speed: observed mean over forecast midpoint | median 0.58, range 0.34-1.06 (observed below the range midpoint) |
| Hours inside the forecast speed range | 31% on average |
| Gusts: observed maximum over forecast gust | median 1.2 (n = 9) |

Over every period at any lead, direction error is mean abs 22 deg (Camp, median 13, n = 27
usable) and 48 deg (Tubbs, median 38, n = 42; 52 of 104 comparisons excluded as multi-phase).
The Tubbs figure is driven by the valley airports and by weak-wind hours after the event. The
sign is not consistent (mean signed -12 deg at Camp, +8 deg at Tubbs). Per station, forecasts
issued up to 24 h ahead:

- **Ridge RAWS match the forecast direction.** Jarbo Gap mean abs 16 deg, speed ratio 1.18.
  Pike County mean abs 37 deg, ratio 0.88.
- **Valley airports under-read the zone forecast.** Chico and Oroville speed ratio 0.36-0.42 of
  the forecast midpoint; Santa Rosa and Petaluma 0.44-0.69. These stations do not see the
  ridge-top wind the forecast describes.
- **Gusts beat the forecast in the Tubbs wind.** Observed maximum gust over forecast gust: Santa
  Rosa RAWS 2.3, Hawkeye RAWS 2.0 (35 m/s, about 79 mph), Napa 1.4. At Camp the observed gusts
  were about 0.5-1.2 of the forecast gusts (they were already forecast at 20-22 m/s).
- **Direction error is large where wind is weak or turning**, as in the Tubbs valleys on the
  afternoon of 8 October (obs from the north-northeast at 15-60 deg against forecast
  west-then-north), and overnight 9 October.

### Using this for a "wind shift" inject

Use these as defaults, labelled ASSUMPTION (derived from two events, order-of-magnitude):

- Direction: a shift of 25 deg either way is a typical miss, 50-60 deg a bad but real one
  (90th percentile). The sign was not consistent between the two events, so apply it both ways.
- Speed: apply a factor 0.6-1.2 to the forecast midpoint; gusts 1.0-2.0 times the forecast gust.
  The factor depends on exposure, so make it a per-scenario choice, not a global constant.
- Always show "forecast" and "wind shift inject" as separate, labelled layers over the replayed or
  forecast series.

## Consumed by

Wired in the Simulation Studio (`/simulation`) and the fire page (`/fire`). `sim/weather.py` itself
still does no height conversion; the endpoint adds it.

### `GET /api/weather/scenario`

`app/backend/api/scenario_weather.py`, public and throttled (30/min per client).

| Query | Meaning |
| --- | --- |
| `lon`, `lat` | WGS84 degrees, the ignition point |
| `start` | ISO 8601 UTC with `Z`. Required except for `forecast`, which defaults to the current UTC hour |
| `hours` | Integer 1 to 72, default 24. The series has `hours + 1` hourly samples |
| `mode` | `historical_replay` (default), `climatology_percentile`, `forecast` |
| `percentile` | 50 to 99.9, default 95, `climatology_percentile` only |

The body is `scenario_wind` unchanged (m/s, degrees FROM, hourly UTC, `evidence_class`, `station`
with `distance_km`, `provenance`, `summary`) plus per sample `speed_20ft_ms` and `speed_20ft_mph`
(`null` where `speed_ms` is `null`) and a `height_conversion` object
`{from_height, to_height, factor, method, note}`. The raw archive cache is the module's own
(`$CRISISTWIN_WEATHER_CACHE`); `forecast` answers carry `Cache-Control: no-store`. Errors are
`{error, detail}`: 400 bad query, 502 no data or an upstream parse failure, 503 upstream
unreachable.

```sh
curl "http://127.0.0.1:8060/api/weather/scenario?lon=-121.6&lat=39.81&start=2018-11-08T00:00:00Z&hours=36&mode=historical_replay"
```

### Height conversion to the 20 ft open wind

The Rothermel input is the open wind at 20 ft (6.096 m) above the vegetation. Stations do not all
report there:

- ASOS/AWOS airports and the NWS gridpoint forecast are 10 m winds. They are scaled by **0.87**.
  This is the neutral-stability log wind profile, `u(z2)/u(z1) = ln(z2/z0) / ln(z1/z0)`, with an
  open-terrain roughness length `z0 = 0.2 m` (between the Davenport-Wieringa "roughly open" 0.1 m
  and "rough" 0.25 m classes): `ln(6.096/0.2) / ln(10/0.2) = 0.873`. The 0.87 factor is the one
  commonly quoted for 10 m to 20 ft; we did not find a primary table to cite for it, so treat the
  derivation above as the source and the factor as an assumption about terrain.
- RAWS (via HADS) are already 20 ft: factor 1.0, no conversion.

`speed_ms` stays as reported; only `speed_20ft_*` is converted. Gusts are not converted. Station
exposure (a valley airport against a ridge) is not corrected: that error is larger than the height
factor, see the Camp table above.

This is separate from the **midflame adjustment** the solver applies afterwards: the 20 ft open
wind is multiplied by 0.5 (or, with canopy data, a per-cell Albini and Baughman factor) to get the
wind at flame height. The UI labels both steps.

### Studio and `/fire`

A "Wind source" selector (`app/src/fire/ui/WindSourcePicker.tsx`, `app/src/fire/scenarioWeather.ts`):

| Choice | Request |
| --- | --- |
| Assumed | None. The user's own speed and direction, as before |
| Historical | `historical_replay` from a UTC date and time (default 2018-11-08 14:00, the Camp ignition) |
| Worst | `climatology_percentile` for a month and P90/P95/P99 (derived, offshore sector) |
| Forecast | `forecast` from the current hour (NWS) |

The solver takes one wind per run: spread rates are computed once per cell for a fixed wind
(`app/src/fire/spread.ts`), and the run is not stepped through weather. So the hourly series is
**reduced to its peak 20 ft hour with a valid direction inside the run window** (`hours` =
horizon in hours, 6 at most in the Studio, 24 on `/fire`) and that speed and direction drive the
whole run, capped at the 60 mph slider maximum. This overstates the wind in the hours around
it, so a run on a "Historical" series is a worst-hour run, not a replay. The wind panel shows the
evidence class (Observed, Forecast, Derived), the station name and id, its distance in km, the
peak hour, the conversion, and "How this wind is used". Editing the speed or direction by hand
returns the source to Assumed. Fuel moisture is not taken from the series' RH and temperature;
it stays on the preset.

The Studio keeps the record in `StudioScenario.weather` (saved in the draft and the scenario
JSON, dropped on import if the wind no longer equals the applied value). Drill packages carry it
in `assumptions.wind_source`: `{kind: "assumed"}`, or `{kind: "scenario_weather", mode,
evidence_class, station, source, query, analog, height_conversion, applied, units, series,
raw_sha256}` where `series` is every hourly sample (UTC time, `speed_ms`, `speed_20ft_mph`,
`from_deg`, `gust_ms`) and `applied` is the value the solver ran on. `wind_20ft_mph` and
`wind_from_deg` still hold that applied value. The backend package builder ignores the extra key.

Still open: a time-varying solver (step the wind through the series, interpolating direction
through the shortest arc), wiring moisture from the series into the pages (the endpoint exists:
see "Fuel moisture from the date's weather" below), and the wind-shift inject for live drills
(ADR 0030), recorded as `evidence_class: "simulated"`. Keep observed, forecast, derived and
assumed series separate wherever they are stored.

## Fuel moisture from the date's weather

`GET /api/conditions` (`app/backend/api/conditions.py`) answers "what were (or would be) the fire
conditions here on this date": the hourly weather above plus dead and live fuel moisture per hour,
in the `FuelMoisture` fraction shape `app/src/fire/rothermel.ts` takes. It is the `moisture.mode =
"derived"` source of the shared world (`conditions` in `docs/shared-world.md`). The model is
`sim/fuel_moisture.py` (pure, stdlib), region defaults are `sim/conditions_presets.py`, and the
TypeScript client and the apply helper are `app/src/world/conditions.ts`. Not wired into a page yet.

### Model and evidence

| Output | Evidence | Method | Source |
| --- | --- | --- | --- |
| Wind, gust, temperature, RH | as the weather: `observed`, `derived` (climatology), `forecast` | `sim.weather.scenario_wind`, 20 ft conversion as `GET /api/weather/scenario` | above |
| `dead1h` | derived | Fosberg and Deeming tables. Day (0800-1959): Table A reference + Table B (May-Jul), C (Feb-Apr, Aug-Oct) or D (Nov-Jan) correction for exposure, aspect, slope class and elevation band. Night (2000-0759): Table E; Table F only with `night_inversion=1` | Rothermel, R.C. 1983, *How to predict the spread and intensity of forest and range fires*, USDA FS GTR INT-143, Exhibit II-2 (pp. 15-19); same tables as the NWCG IRPG |
| `dead10h`, `dead100h` | derived; forcing and starting state assumed | First-order timelag `dm/dt = (E - m)/tau`, `tau` = 10 h and 100 h, solved exactly each hour. `E` = that hour's 1-h table value (assumed: 1-h fuels reach equilibrium within the hour). Start = mean `E` of the first 24 forcing hours (assumed) | Timelag definition (Byram 1963; Fosberg 1970) |
| `liveHerb`, `liveWoody` | assumed | Stage of development to moisture: fresh 300 %, maturing 200 %, mature 100 %, entering dormancy 50 %, cured 30 % (printed "less than 30, treat as a dead fuel"). The stage on a date comes from an assumed regional calendar (`PHENOLOGY_CALENDARS`), interpolated between mid-month anchors | Rothermel 1983 Table II-2 (p. 13); the calendars are planning assumptions, not data |

Units: tables in deg F and percent (converted from the station's deg C at the boundary,
`F = C * 9/5 + 32`); output fractions of oven-dry weight. The tables' clock bands are read in
**local mean solar time**, `UTC + lon/15 h` (assumption: the bands encode sun position). Temperature
and RH gaps up to 3 h are filled linearly (`met_filled: true`); longer gaps leave the hour's
moisture `null` and hold the lagged state.

Spin-up: for `historical_replay` the server fetches the 48 observed hours before `start` from the
same station; for `climatology_percentile` the 48 hours before the analog's real start. `forecast`
has no earlier hours, so its 10-h/100-h start from the first day's mean (`provenance.spinup.note`).
Climatology analogs are relabelled to the scenario start by `sim.weather`; the moisture tables use
the analog's real clock (`provenance.table_clock.shift_hours`), so a night observation is never read
as an afternoon one.

Not modelled, and therefore biased: **precipitation and dew** (the report's own caution: the
tables "assume that there has not been recent precipitation"; values after rain are too dry), cloud
cover (pass `shading=shaded` for overcast hours), wetting/drying hysteresis, and live moisture from
measurements. The day/night switch at 0800 and 2000 is a step, as in the tables: at the Camp
station on 2018-11-08 the 1-h value goes from 4 % at 07:54 solar (Table E) to 8 % at 08:54 (Table A
3 % + Table D early-morning correction 5 %). That is the published method, not smoothed here.

Check against the report: `sim.fuel_moisture.rothermel_1983_worked_examples()` reproduces the six
answers of the two worked examples on p. 20 (6, 4, 7, 10, 9, 22 %).

### `GET /api/conditions`

Public, throttled 30/min per client, cached in MongoDB `conditions_cache` by the normalized query
and `model_version` (forecast entries expire after 1 h). Same weather limits as
`/api/weather/scenario`: `hours` 1-72, archive coverage per station, California stations only. A
nearest station more than 100 km away (`MAX_STATION_DISTANCE_KM`, assumption) is refused with
`502 no_station_coverage` rather than used (the Marshall Fire, Colorado, gets this answer).

| Query | Meaning |
| --- | --- |
| `lon`, `lat`, `start`, `hours`, `mode`, `percentile` | as `/api/weather/scenario` |
| `sector` | `from,to` degrees, climatology only; default `315,90` (offshore) |
| `aspect` | `N`, `E`, `S`, `W` or a bearing in degrees; default `S` |
| `slope_pct` | default 0 (tables split at 30 %) |
| `shading` | `exposed` (< 50 % shading of surface fuels) or `shaded` (canopy or cloud); default `exposed` |
| `elevation` | `B`, `L`, `A`: projection point 1000-2000 ft below, within 1000 ft, 1000-2000 ft above the station; default `L` |
| `night_inversion`, `station_aspect` | `1` applies Table F at night (strong inversion); default `0` |
| `region` / `phenology` | picks the live calendar; otherwise the nearest preset region within 60 km, else `ca_coastal` |

Answer (`schema: "crisistwin.conditions/1"`): `query`, `units`, `station`, `source`,
`height_conversion`, `site` (with `given: false` when all defaults), `phenology {class, label,
chosen_by}`, `evidence {weather, wind_20ft, dead1h, dead10h_dead100h, live, site}`,
`hours_series[]`, `summary`, `provenance {weather, spinup, lag_initial_pct, table_clock, model}`,
`cache {hit, stored_utc, key}`. One hour:

```jsonc
{
  "t_utc": "2018-11-08T12:00:00Z",
  "wind_speed_20ft_ms": 14.305, "wind_speed_20ft_mph": 32.0,  // open 20 ft wind
  "wind_speed_reported_ms": 14.305, "wind_from_deg": 38.0, "gust_ms": 23.246,
  "temp_c": 9.4, "rh_pct": 22.0, "n_obs": 1,
  "moisture": { "dead1h": 0.05, "dead10h": 0.0566, "dead100h": 0.0538, "liveHerb": 0.3, "liveWoody": 0.5 },
  "fine_fuel": { "moisture_pct": 5.0, "period": "night", "reference_pct": 5, "correction_pct": 0, "table": "E",
                 "reference_is_lower_bound": false, "temp_outside_table": false, "local_solar_time": "2018-11-08T03:54" },
  "dead_lag_pct": { "dead10h": 5.66, "dead100h": 5.38, "held_through_gap": false },
  "live": { "herb_pct": 30.0, "woody_pct": 50.0, "herb_stage": "cured", "woody_stage": "dormancy", ... },
  "met_filled": false
}
```

`summary`: `peak_wind_hour {t_utc, wind_speed_20ft_mph, wind_speed_20ft_ms, wind_from_deg, moisture}`,
`max_gust_ms`, `min_dead1h {t_utc, dead1h, rh_pct, temp_c}`, `min_rh_pct`, `max_temp_c`, and counts
of hours without wind or moisture. Errors are `{error, detail}`: 400 bad query, 502 no data / no
station coverage / upstream parse failure, 503 upstream unreachable.

```sh
curl "http://127.0.0.1:8000/api/conditions?lon=-121.434&lat=39.813&start=2018-11-08T12:00:00Z&hours=24&mode=historical_replay&region=camp-2018"
curl "http://127.0.0.1:8000/api/conditions?lon=-122.23&lat=37.895&start=2025-10-15T20:00:00Z&mode=climatology_percentile&percentile=95&region=berkeley-hills-tilden&aspect=N&slope_pct=35"
```

### `GET /api/conditions/presets[?region=<id>]`

Per catalogue region (`app/src/fire/regions.ts`) and historical fire (`camp-2018`, `kincade-2019`,
`woolsey-2018`, `marshall-2021`): `phenology_class`, `typical_season_date` (assumed `MM-DD`:
Bay Area and Central Coast 10-15, Central Sierra and Kern 09-15, Southern California 11-01, the
three SoCal mountain regions 10-25, Marshall 12-15), `weather_coverage`, and `presets[]` of ready
`/api/conditions` queries: `peak-season-p95` and `peak-season-p50` (climatology at the season
date, label year 2025) and, for the fires, `actual-ignition` (historical replay around the
ignition time, with the time's source). Without `region`: `{regions: [...]}`. 404 for an unknown id.

| Fire | Point (source) | Ignition (source) |
| --- | --- | --- |
| Camp 2018 | -121.434, 39.813 (`sim/firefront.py`, assumed approximate origin) | 2018-11-08T14:20Z (NIST TN 2252 via `sim/ground_rates.py`) |
| Kincade 2019 | -122.85, 38.585 (package bbox centre, not the origin) | 2019-10-24T04:27Z (package, CAL FIRE) |
| Woolsey 2018 | -118.70128, 34.235 (package, CAL FIRE published point) | 2018-11-08T22:24Z first report (package) |
| Marshall 2021 | -105.175, 39.965 (package bbox centre) | 2021-12-30T18:05Z, latest bound (package events table); weather not covered |

### Measured on real dates (2026-10-24 run)

| Query | Station | Peak 20 ft wind | Min 1-h | 10-h range | Live herb / woody |
| --- | --- | --- | --- | --- | --- |
| Camp, 2018-11-08T12Z, 24 h | Jarbo Gap RAWS (JBGC1), 9.8 km | 32 mph from 38 deg at 12Z | 3 % (05Z Nov 9, RH 13 %) | 4.6-5.8 % | 0.30 / 0.50 |
| Woolsey, 2018-11-08T21Z, 36 h | Simi Valley RAWS (OKPC1), 10.8 km | 16.1 mph from 53 deg at 04Z Nov 9 | 1 % (04Z Nov 9, RH 4 %; RH 1-7 % all window) | 15.8 % falling to 3.3 % | 0.30 / 0.50 |
| Kincade, 2019-10-24T03Z, 24 h | Santa Rosa ASOS (STS), 9.7 km | 10 mph from 340 deg | 2 % (21Z, RH 9 %) | 8.6 % falling to 4.0 % | 0.30 / 0.50 |
| Berkeley Hills, climatology P95, Oct 15 | Concord ASOS (CCR), 18.9 km | 25 mph from 0 deg | 4 % | 5.6-8.3 % | 0.30 / 0.50 |

Against an observation: Jarbo Gap RAWS also reports its 10-h fuel stick (SHEF `MMIRGZ`, percent),
4-5 % through the Camp window. The derived `dead10h` over the same 25 hours: mean absolute
difference 0.7 percentage points, bias +0.7 (model wetter). Nothing was tuned to this. The
Kincade row shows the station limit, not the moisture model: a bbox-centre point picks the valley
airport, whose wind is far below the ridge-top winds of that night.

### Applying an hour (`app/src/world/conditions.ts`)

`fetchConditions(query)`, `fetchConditionPresets(region)`, `fetchAllConditionPresets()`;
`conditionsHourAt(conditions, tUtc)` (the hour bin containing a time), `peakWindHour(conditions)`,
and `applyConditionsHour(hour, {maxWindMph?})`, which returns `{ok: true, inputs: {windSpeedMph,
windFromDegrees, moisture}, calm, clampedFromMph}` (the `FireScenario` fields) or `{ok: false,
missing: [...]}`: it never fills a missing wind or moisture. A zero wind is applied with direction 0
and `calm: true`. The solver still takes one wind and one moisture per run, so a page choosing an
hour (start, peak wind, driest hour) must say which.

## Fixtures

`tests/fixtures/weather/`: raw archive responses trimmed to the Camp day (`camp_cic_asos.csv`,
`camp_ove_asos.csv`, `camp_jbgc1_hads.csv`, `camp_pkcc1_hads.csv`), trimmed station catalogs, a
Fire Weather Planning Forecast excerpt (`fwf_sto_20181108_1356_excerpt.txt`) and a gridpoint
document (`nws_gridpoint_STO_47_121.json`, dated 2026-10-24: a fixture, not a current forecast).
The Kincade, Woolsey and Marshall incidents can reuse the same functions.
