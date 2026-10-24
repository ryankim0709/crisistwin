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
- No height conversion: ASOS and gridpoint winds are 10 m, RAWS 20 ft, the Rothermel input is the
  open 20 ft wind. Same simplification as `app/src/fire/weather.ts`; label it.

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

## How the Studio and the fire model should consume `scenario_wind`

Not wired yet (`app/src` was not touched); the follow-up should:

1. **Serve it from the backend**, not the browser: add `GET /api/scenario-weather?lon&lat&start&hours&mode`
   to `app/backend` calling `sim.weather.scenario_wind` (the cache directory and `User-Agent`
   stay server-side). Return the dict above unchanged, so provenance and evidence class reach the UI.
2. **Replace the single wind in the fire model with a series.** `FireScenario` today holds one
   `windSpeedMph` and `windFromDegrees` (`app/src/fire/spread.ts`, `weather.ts`). Convert each
   sample once at the boundary: `mph = speed_ms / 0.44704`, `windFromDegrees = from_deg` (same
   "from" contract, no flip). Step the simulation clock through the series (hold each hourly
   value for its hour; interpolate direction through the shortest arc, never through 180).
   A `None` sample must stop the run or fall back visibly to the user's assumed wind, never to a
   silent default. Feed `rh_pct` and `temp_c` into the dead-fuel-moisture preset the same way
   (replacing the "critical / Red Flag" demo preset only when the data exists).
3. **Label it.** The wind panel shows evidence class (observed / forecast / derived / assumption),
   the station, its distance, and the 10 m versus 20 ft note. `historical_replay` for 2018-11-08
   at the Camp ignition is the validation case: the fire runs on the observed Jarbo Gap wind, not
   an assumed one.
4. **Wind-shift inject** (live drills, ADR 0030): a controller event that adds a direction offset
   and speed/gust factors from the table above to the series from a chosen simulation time,
   recorded as `evidence_class: "simulated"`.
5. Keep observed, forecast, derived and assumed series separate in the stored scenario
   (ADR 0030 drill package). Never merge them into one unlabelled array.

## Fixtures

`tests/fixtures/weather/`: raw archive responses trimmed to the Camp day (`camp_cic_asos.csv`,
`camp_ove_asos.csv`, `camp_jbgc1_hads.csv`, `camp_pkcc1_hads.csv`), trimmed station catalogs, a
Fire Weather Planning Forecast excerpt (`fwf_sto_20181108_1356_excerpt.txt`) and a gridpoint
document (`nws_gridpoint_STO_47_121.json`, dated 2026-10-24: a fixture, not a current forecast).
The Kincade, Woolsey and Marshall incidents can reuse the same functions.
